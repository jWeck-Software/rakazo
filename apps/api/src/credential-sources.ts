import { ORPCError } from "@orpc/server";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type {
  BotSecretScope,
  RemoteTransportDependencies,
  VaultwardenCollection,
  VaultwardenSourceSettings,
  VaultwardenTransport,
} from "@rakazo/adapters";
import {
  assertVaultInUse,
  createVaultwardenClient,
  deriveVaultwardenCredentials,
  lockVault,
  parseVaultwardenCredentials,
  parseVaultwardenSourceSettings,
  SPACE_VAULT_NOT_IN_USE,
  VaultwardenArgon2UnsupportedError,
  VaultwardenAuthError,
  VaultwardenUnavailableError,
  vaultFields,
  vaultwardenRefPrefix,
  vaultwardenTransport,
} from "@rakazo/adapters";
import type {
  CredentialSourceCollection,
  CredentialSourceStatus,
  VaultwardenConnectInput,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, recordSecurityEvent } from "@rakazo/db";
import { withSerializableRetry } from "./serializable-retry.js";

export interface CredentialSourceDeps {
  prisma: PrismaClient;
  secrets: Pick<SecretStore, "put" | "load">;
  /** The instance flag (`MCP_ALLOW_PRIVATE_ENDPOINT`). */
  env?: { mcpAllowPrivateEndpoint?: boolean };
  remoteConnectors?: RemoteTransportDependencies;
  /** Called after a connect or a collection change commits. */
  onCredentialSourceChanged?: (sourceId: string) => void | Promise<void>;
}

const PROVIDER = "vaultwarden";
const SECRET_KIND = "credential-source";
const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable };

type SourceRow = {
  id: string;
  spaceId: string | null;
  settings: unknown;
  secretId: string;
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
};

const rejected = (message: string) => new ORPCError("BAD_REQUEST", { message });

/** Library-authored messages only; a server's response text never reaches the caller. */
function vaultwardenError(error: unknown): unknown {
  if (error instanceof VaultwardenAuthError)
    return rejected("Vaultwarden rejected these credentials");
  if (error instanceof VaultwardenUnavailableError) return rejected("Vaultwarden is not reachable");
  if (error instanceof VaultwardenArgon2UnsupportedError) return rejected(error.message);
  if (
    error instanceof Error &&
    (error.message.startsWith("Vaultwarden URL") ||
      error.message === "Vaultwarden account uses an unsupported key derivation" ||
      error.message === SPACE_VAULT_NOT_IN_USE)
  )
    return rejected(error.message);
  return error;
}

function transport(deps: CredentialSourceDeps): VaultwardenTransport {
  return vaultwardenTransport(deps.env?.mcpAllowPrivateEndpoint === true, deps.remoteConnectors);
}

function secretContext(scope: BotSecretScope, signal?: AbortSignal): AdapterContext {
  return {
    operationId: "credential-source",
    traceId: "credential-source",
    spaceId: scope.spaceId,
    userId: scope.userId,
    signal: signal ?? new AbortController().signal,
  };
}

function toStatus(row: SourceRow | null): CredentialSourceStatus {
  if (!row) return { connected: false };
  const settings = parseVaultwardenSourceSettings(row.settings);
  return {
    connected: true,
    provider: PROVIDER,
    origin: settings.origin,
    email: settings.email,
    collectionIds: settings.collectionIds,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    lastSyncError: row.lastSyncError,
  };
}

function toCollection(collection: VaultwardenCollection): CredentialSourceCollection {
  return {
    id: collection.id,
    name: collection.name,
    ...(collection.organizationName ? { organizationName: collection.organizationName } : {}),
    hidePasswords: collection.hidePasswords,
    readOnly: collection.readOnly,
  };
}

async function sourceEvent(
  type: "credential_source.connected" | "credential_source.disconnected",
  scope: BotSecretScope,
  row: SourceRow,
) {
  await recordSecurityEvent({
    type,
    userId: scope.userId,
    spaceId: scope.spaceId,
    metadata: {
      provider: PROVIDER,
      origin: parseVaultwardenSourceSettings(row.settings).origin,
      scope: row.spaceId ? "space" : "account",
    },
  });
}

export async function credentialSourceStatus(
  deps: CredentialSourceDeps,
  scope: BotSecretScope,
): Promise<CredentialSourceStatus> {
  const vault = await vaultFields(deps.prisma, scope);
  return toStatus(await deps.prisma.credentialSource.findFirst({ where: vault }));
}

export async function connectVaultwarden(
  deps: CredentialSourceDeps,
  scope: BotSecretScope,
  input: Omit<VaultwardenConnectInput, "scope">,
  signal?: AbortSignal,
) {
  let derived: Awaited<ReturnType<typeof deriveVaultwardenCredentials>>;
  try {
    await assertVaultInUse(deps.prisma, scope);
    derived = await deriveVaultwardenCredentials({
      ...transport(deps),
      baseUrl: input.baseUrl,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      masterPassword: input.masterPassword,
      signal,
    });
  } catch (error) {
    throw vaultwardenError(error);
  }
  const liveIds = new Set(derived.collections.map((collection) => collection.id));
  const stored = await deps.secrets.put(
    JSON.stringify(derived.credentials),
    secretContext(scope, signal),
  );
  const row = await withSerializableRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      await lockVault(tx, scope);
      await assertVaultInUse(tx, scope).catch((error) => {
        throw vaultwardenError(error);
      });
      const vault = await vaultFields(tx, scope);
      const secret = await tx.secret.create({
        data: {
          id: stored.id,
          userId: scope.userId,
          spaceId: vault.spaceId,
          kind: SECRET_KIND,
          ciphertext: stored.ciphertext,
        },
      });
      const existing = await tx.credentialSource.findFirst({ where: vault });
      const previous = existing ? parseVaultwardenSourceSettings(existing.settings) : undefined;
      const settings: VaultwardenSourceSettings = {
        origin: new URL(derived.credentials.baseUrl).origin,
        email: derived.email,
        // Reconnecting keeps the chosen collections this account still has.
        collectionIds: (previous?.collectionIds ?? []).filter((id) => liveIds.has(id)),
      };
      const data = {
        provider: PROVIDER,
        settings,
        secretId: secret.id,
        lastSyncedAt: null,
        lastSyncError: null,
      };
      if (!existing) return tx.credentialSource.create({ data: { ...vault, ...data } });
      const updated = await tx.credentialSource.update({ where: { id: existing.id }, data });
      await tx.secret.deleteMany({ where: { id: existing.secretId } });
      return updated;
    }, serializable),
  );
  await sourceEvent("credential_source.connected", scope, row);
  await deps.onCredentialSourceChanged?.(row.id);
  return { status: toStatus(row), collections: derived.collections.map(toCollection) };
}

async function openSource(deps: CredentialSourceDeps, scope: BotSecretScope) {
  const vault = await vaultFields(deps.prisma, scope);
  const row = await deps.prisma.credentialSource.findFirst({ where: vault });
  const secret =
    row && (await deps.prisma.secret.findFirst({ where: { id: row.secretId, ...vault } }));
  if (!row || !secret)
    throw new ORPCError("NOT_FOUND", { message: "Vaultwarden is not connected" });
  const credentials = parseVaultwardenCredentials(
    await deps.secrets.load(secret.ciphertext, secret.id),
  );
  return { row, client: createVaultwardenClient(credentials, transport(deps)) };
}

export async function credentialSourceCollections(
  deps: CredentialSourceDeps,
  scope: BotSecretScope,
  signal?: AbortSignal,
): Promise<CredentialSourceCollection[]> {
  const { client } = await openSource(deps, scope);
  const collections = await client.collections(signal).catch((error) => {
    throw vaultwardenError(error);
  });
  return collections.map(toCollection);
}

export async function setCredentialSourceCollections(
  deps: CredentialSourceDeps,
  scope: BotSecretScope,
  collectionIds: string[],
  signal?: AbortSignal,
): Promise<CredentialSourceStatus> {
  const { row, client } = await openSource(deps, scope);
  const live = await client.collections(signal).catch((error) => {
    throw vaultwardenError(error);
  });
  const liveIds = new Set(live.map((collection) => collection.id));
  if (!collectionIds.every((id) => liveIds.has(id)))
    throw rejected("Choose collections from this Vaultwarden");
  const updated = await withSerializableRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      const current = await tx.credentialSource.findFirst({
        where: { id: row.id, secretId: row.secretId },
      });
      if (!current)
        throw new ORPCError("CONFLICT", { message: "The Vaultwarden connection changed" });
      const settings: VaultwardenSourceSettings = {
        ...parseVaultwardenSourceSettings(current.settings),
        collectionIds: [...new Set(collectionIds)],
      };
      return tx.credentialSource.update({ where: { id: row.id }, data: { settings } });
    }, serializable),
  );
  await deps.onCredentialSourceChanged?.(updated.id);
  return toStatus(updated);
}

/** Removes the source, its secret, and the logins it put in the vault. */
export async function disconnectCredentialSource(
  deps: CredentialSourceDeps,
  scope: BotSecretScope,
): Promise<void> {
  const removed = await withSerializableRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      await lockVault(tx, scope);
      const vault = await vaultFields(tx, scope);
      const row = await tx.credentialSource.findFirst({ where: vault });
      if (!row) return null;
      await tx.vaultCredential.deleteMany({
        where: { ...vault, ciphertext: { startsWith: vaultwardenRefPrefix(row.id) } },
      });
      await tx.credentialSource.delete({ where: { id: row.id } });
      await tx.secret.deleteMany({ where: { id: row.secretId } });
      return row;
    }, serializable),
  );
  if (removed) await sourceEvent("credential_source.disconnected", scope, removed);
}
