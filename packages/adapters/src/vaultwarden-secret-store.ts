import type { SecretContext, SecretStore } from "@rakazo/adapter-kit";
import { SecretNotFoundError, SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { DEFAULT_LOGIN_FIELD_LABELS, encodeLoginSecret } from "@rakazo/contracts";
import { withAbort } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { createSafeRemoteFetch } from "./remote-mcp.js";
import type {
  VaultwardenClient,
  VaultwardenLogin,
  VaultwardenTransport,
} from "./vaultwarden-client.js";
import {
  createVaultwardenClient,
  parseVaultwardenCredentials,
  parseVaultwardenSourceSettings,
  VaultwardenAuthError,
  VaultwardenUnavailableError,
} from "./vaultwarden-client.js";

export const VAULTWARDEN_REF_PREFIX = "vaultwarden:v1:";

/** Logins fetched for one run start are shared by every load in it: one sync, not one per row. */
const SNAPSHOT_TTL_MS = 30_000;

/** The same endpoint policy as MCP servers: HTTPS on public addresses unless the instance allows private ones. */
export function vaultwardenTransport(
  allowPrivateEndpoint: boolean,
  network: RemoteTransportDependencies = {},
): VaultwardenTransport {
  return {
    fetch: createSafeRemoteFetch(network.fetch, network.resolveHostname, { allowPrivateEndpoint }),
    allowPrivateEndpoint,
  };
}

export interface VaultwardenStoreOptions {
  /** Reads only: the source, its secret, and the vault row a ref is loaded for. */
  prisma: Pick<PrismaClient, "credentialSource" | "secret" | "vaultCredential">;
  transport: VaultwardenTransport;
}

function parseRef(ref: string): { sourceId: string; cipherId: string } | undefined {
  const [sourceId, cipherId, ...rest] = ref.slice(VAULTWARDEN_REF_PREFIX.length).split(":");
  return sourceId && cipherId && rest.length === 0 ? { sourceId, cipherId } : undefined;
}

/** A Vaultwarden login in the shape every saved website login has, so fills read it unchanged. */
function encodeLogin(login: VaultwardenLogin): string {
  const [usernameLabel, passwordLabel] = DEFAULT_LOGIN_FIELD_LABELS;
  try {
    return encodeLoginSecret({
      fields: [
        ...(login.username?.trim()
          ? [{ label: usernameLabel, value: login.username, hidden: false }]
          : []),
        ...(login.password ? [{ label: passwordLabel, value: login.password, hidden: true }] : []),
      ],
    });
  } catch {
    throw new SecretNotFoundError();
  }
}

function storeError(error: unknown): unknown {
  if (error instanceof VaultwardenUnavailableError)
    return new SecretStoreUnavailableError(error.status, "Vaultwarden is not reachable");
  if (error instanceof VaultwardenAuthError)
    return new SecretStoreUnavailableError(
      undefined,
      "Vaultwarden rejected the stored credentials",
    );
  return error;
}

/**
 * Resolves the pointer rows a Vaultwarden sync writes into a vault. Read-only: values live in
 * Vaultwarden and are fetched when a login is filled. One client per source per process, keyed
 * by the stored connection so a reconnect starts a new one.
 */
export class VaultwardenSecretStore {
  private readonly clients = new Map<string, { key: string; client: Promise<VaultwardenClient> }>();
  private readonly snapshots = new Map<
    string,
    { key: string; logins: Promise<VaultwardenLogin[]> }
  >();

  constructor(
    private readonly options: VaultwardenStoreOptions,
    /** Opens the source's own stored connection, wherever the secret store put it. */
    private readonly secrets: Pick<SecretStore, "load">,
  ) {}

  async load(ref: string, context: SecretContext): Promise<string> {
    const recordId = typeof context === "string" ? context : context.recordId;
    const signal = typeof context === "string" ? undefined : context.signal;
    const parsed = parseRef(ref);
    if (!parsed) throw new SecretNotFoundError();
    const { prisma } = this.options;
    const source = await prisma.credentialSource.findFirst({ where: { id: parsed.sourceId } });
    if (!source) throw new SecretNotFoundError();
    // The ref is only honored for the row the sync wrote it into, in the source's own vault.
    const row = await prisma.vaultCredential.findFirst({
      where: { id: recordId, userId: source.userId, spaceId: source.spaceId, ciphertext: ref },
      select: { origin: true },
    });
    const secret = await prisma.secret.findFirst({
      where: { id: source.secretId, userId: source.userId },
      select: { id: true, ciphertext: true },
    });
    if (!row || !secret) throw new SecretNotFoundError();
    const { collectionIds } = parseVaultwardenSourceSettings(source.settings);
    const logins = await this.logins(source.id, secret, collectionIds, signal).catch((error) => {
      throw storeError(error);
    });
    // An item moved to another site since the last sync must not be typed into the old one.
    const login = logins.find(
      (entry) => entry.cipherId === parsed.cipherId && entry.origins.includes(row.origin),
    );
    if (!login) throw new SecretNotFoundError();
    return encodeLogin(login);
  }

  close(): void {
    this.clients.clear();
    this.snapshots.clear();
  }

  private client(sourceId: string, secret: { id: string; ciphertext: string }) {
    const cached = this.clients.get(sourceId);
    if (cached?.key === secret.ciphertext) return cached.client;
    const client = this.secrets
      .load(secret.ciphertext, secret.id)
      .then((plaintext) =>
        createVaultwardenClient(parseVaultwardenCredentials(plaintext), this.options.transport),
      );
    const entry = { key: secret.ciphertext, client };
    this.clients.set(sourceId, entry);
    client.catch(() => {
      if (this.clients.get(sourceId) === entry) this.clients.delete(sourceId);
    });
    return client;
  }

  private logins(
    sourceId: string,
    secret: { id: string; ciphertext: string },
    collectionIds: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<VaultwardenLogin[]> {
    const key = `${secret.ciphertext}\u0000${[...collectionIds].sort().join(",")}`;
    let entry = this.snapshots.get(sourceId);
    if (entry?.key !== key) {
      // Fetched without any one caller's signal: an aborted run must not fail the others.
      const logins = this.client(sourceId, secret).then((client) =>
        client.logins({ collectionIds }),
      );
      const created = { key, logins };
      entry = created;
      this.snapshots.set(sourceId, created);
      const expire = () => {
        if (this.snapshots.get(sourceId) === created) this.snapshots.delete(sourceId);
      };
      logins.then(() => setTimeout(expire, SNAPSHOT_TTL_MS).unref(), expire);
    }
    return signal ? withAbort(entry.logins, signal) : entry.logins;
  }
}
