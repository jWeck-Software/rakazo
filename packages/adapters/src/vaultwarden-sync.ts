import { randomBytes } from "node:crypto";
import type { JobPublisher, SecretStore } from "@rakazo/adapter-kit";
import { credentialSourceSyncJob } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { settingsTarget, withTransactionRetry } from "@rakazo/db";
import { lockVault } from "./bot-secrets.js";
import type { VaultwardenLogin, VaultwardenTransport } from "./vaultwarden-client.js";
import {
  createVaultwardenClient,
  parseVaultwardenCredentials,
  parseVaultwardenSourceSettings,
  VaultwardenAuthError,
  VaultwardenUnavailableError,
  vaultwardenRefPrefix,
} from "./vaultwarden-client.js";

const VAULT_LIMIT = 100;
const NAME_MAX = 64;
const SYNC_INTERVAL_MS = 15 * 60_000;

type VaultRow = { id: string; name: string; origin: string; ciphertext: string };

export interface CredentialSyncPlan {
  remove: string[];
  update: Array<{ id: string; origin: string }>;
  create: Array<{ name: string; origin: string; cipherId: string }>;
}

function slug(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, NAME_MAX);
  return base || "login";
}

function freeName(name: string, taken: ReadonlySet<string>): string {
  const base = slug(name);
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) {
    const suffix = `-${n}`;
    candidate = `${base.slice(0, NAME_MAX - suffix.length)}${suffix}`;
  }
  return candidate;
}

/**
 * Reconciles a vault's rows with the eligible logins of one source. Rows are matched by cipher,
 * so a login keeps the name the bot already uses across syncs; rows of other kinds are never
 * touched and count toward the vault limit. New logins past the limit are skipped by name.
 */
export function planCredentialSync(
  rows: readonly VaultRow[],
  logins: readonly VaultwardenLogin[],
  prefix: string,
): CredentialSyncPlan {
  const eligible = new Map(
    logins
      .filter((login) => login.password && login.origins.length > 0)
      .map((login) => [login.cipherId, login]),
  );
  const plan: CredentialSyncPlan = { remove: [], update: [], create: [] };
  const linked = new Set<string>();
  for (const row of rows) {
    if (!row.ciphertext.startsWith(prefix)) continue;
    const cipherId = row.ciphertext.slice(prefix.length);
    const login = eligible.get(cipherId);
    if (!login || linked.has(cipherId)) {
      plan.remove.push(row.id);
      continue;
    }
    linked.add(cipherId);
    if (row.origin !== login.origins[0])
      plan.update.push({ id: row.id, origin: login.origins[0]! });
  }
  const removed = new Set(plan.remove);
  const kept = rows.filter((row) => !removed.has(row.id));
  const taken = new Set(kept.map((row) => row.name));
  const added = [...eligible.values()]
    .filter((login) => !linked.has(login.cipherId))
    .sort(
      (a, b) => a.name.localeCompare(b.name, "en") || a.cipherId.localeCompare(b.cipherId, "en"),
    )
    .slice(0, Math.max(0, VAULT_LIMIT - kept.length));
  for (const login of added) {
    const name = freeName(login.name, taken);
    taken.add(name);
    plan.create.push({ name, origin: login.origins[0]!, cipherId: login.cipherId });
  }
  return plan;
}

/** Fixed messages: a server's response text never reaches the person or the logs. */
function syncError(error: unknown): string | undefined {
  if (error instanceof VaultwardenAuthError) return "Vaultwarden rejected the stored credentials";
  if (error instanceof VaultwardenUnavailableError) return "Vaultwarden is not reachable";
  if (error instanceof Error && error.message === "The saved Vaultwarden connection is unreadable")
    return error.message;
  return undefined;
}

type Source = { id: string; userId: string; spaceId: string | null; secretId: string };

/** Every vault write takes the member's user row; a Space's own vault also takes its settings lock. */
async function lockSourceVault(tx: Prisma.TransactionClient, source: Source): Promise<boolean> {
  if (!source.spaceId) {
    await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${source.userId} FOR UPDATE`;
    return true;
  }
  const scope = { userId: source.userId, spaceId: source.spaceId };
  await lockVault(tx, scope);
  // A Space that stopped using its own vault has deleted it; nothing would read new rows.
  return (await settingsTarget(tx, scope, "credentials")) === "space";
}

export interface CredentialSourceSyncDeps {
  prisma: PrismaClient;
  secrets: Pick<SecretStore, "load">;
  transport: VaultwardenTransport;
  now?: () => Date;
}

/**
 * Writes one pointer row per eligible Vaultwarden login into the source's vault. Values stay in
 * Vaultwarden; the secret store fetches them when a login is filled. A failed fetch keeps the
 * existing rows and records a fixed message on the source.
 */
export async function syncCredentialSource(
  deps: CredentialSourceSyncDeps,
  sourceId: string,
): Promise<void> {
  const { prisma } = deps;
  const source = await prisma.credentialSource.findFirst({ where: { id: sourceId } });
  const secret =
    source &&
    (await prisma.secret.findFirst({
      where: { id: source.secretId, userId: source.userId },
      select: { id: true, ciphertext: true },
    }));
  if (!source || !secret) return;
  const { collectionIds } = parseVaultwardenSourceSettings(source.settings);
  const current = { id: source.id, secretId: source.secretId };
  let logins: VaultwardenLogin[];
  try {
    const credentials = parseVaultwardenCredentials(
      await deps.secrets.load(secret.ciphertext, secret.id),
    );
    logins = await createVaultwardenClient(credentials, deps.transport).logins({ collectionIds });
  } catch (error) {
    const message = syncError(error);
    if (!message) throw error;
    await prisma.credentialSource.updateMany({
      where: current,
      data: { lastSyncError: message },
    });
    return;
  }
  const prefix = vaultwardenRefPrefix(source.id);
  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      if (!(await lockSourceVault(tx, source))) return;
      // A disconnect, reconnect, or collection change since the fetch wins; its own sync follows.
      const locked = await tx.credentialSource.findFirst({ where: current });
      if (
        !locked ||
        JSON.stringify(parseVaultwardenSourceSettings(locked.settings).collectionIds) !==
          JSON.stringify(collectionIds)
      )
        return;
      const vault = { userId: source.userId, spaceId: source.spaceId };
      const rows = await tx.vaultCredential.findMany({
        where: vault,
        select: { id: true, name: true, origin: true, ciphertext: true },
      });
      const plan = planCredentialSync(rows, logins, prefix);
      if (plan.remove.length)
        await tx.vaultCredential.deleteMany({ where: { ...vault, id: { in: plan.remove } } });
      for (const { id, origin } of plan.update)
        await tx.vaultCredential.update({ where: { id }, data: { origin } });
      if (plan.create.length)
        await tx.vaultCredential.createMany({
          data: plan.create.map(({ name, origin, cipherId }) => ({
            id: randomBytes(12).toString("hex"),
            ...vault,
            name,
            origin,
            auth: { type: "login" },
            ciphertext: `${prefix}${cipherId}`,
          })),
        });
      await tx.credentialSource.update({
        where: { id: source.id },
        data: { lastSyncedAt: deps.now?.() ?? new Date(), lastSyncError: null },
      });
    }),
  );
}

/**
 * Queues a sync of every connected source about every fifteen minutes on the reconciler's tick,
 * leaving one already queued alone.
 */
export function createCredentialSourceSweeper(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  options: { intervalMs?: number } = {},
): () => Promise<void> {
  const intervalMs = options.intervalMs ?? SYNC_INTERVAL_MS;
  let lastRun: number | undefined;
  return async () => {
    const now = Date.now();
    if (lastRun !== undefined && now - lastRun < intervalMs) return;
    lastRun = now;
    const sources = await deps.prisma.credentialSource.findMany({ select: { id: true } });
    await Promise.all(
      sources.map((source) =>
        deps.jobs.enqueue({
          ...credentialSourceSyncJob(source.id),
          keepExisting: true,
          // A job locked this long belongs to a worker that died with the claim.
          replaceLockedBefore: new Date(now - intervalMs),
        }),
      ),
    );
  };
}
