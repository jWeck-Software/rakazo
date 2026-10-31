import { SecretNotFoundError, SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { decodeLoginSecret } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { ComposedSecretStore } from "./secret-store-factory.js";
import { EncryptedSecretStore } from "./secrets.js";
import { vaultwardenFake } from "./vaultwarden-fake.js";
import { planCredentialSync, syncCredentialSource } from "./vaultwarden-sync.js";

// Offline: a fake Prisma client, the real composed secret store and sync, and the real
// Vaultwarden client against recorded responses.

type Row = Record<string, any>;

const WEBSITES = "142b8424-8057-483c-94b6-29ff8d70705a";
const ORG_SHARED = "5915e24d-8b10-4d25-a04a-6c7a44426950";
const XCHECK_ORG = "f4f1d20d-d721-4ea2-a29e-1a2325080b40";
const PREFIX = "vaultwarden:v1:source-1:";

function matches(row: Row, where: Row = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && "in" in value) return value.in.includes(row[key]);
    return (row[key] ?? null) === value;
  });
}

function table(rows: Row[]) {
  return {
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      const row = rows.find((entry) => matches(entry, where));
      return row ? { ...row } : null;
    }),
    findMany: vi.fn(async ({ where }: { where?: Row } = {}) =>
      rows.filter((entry) => matches(entry, where)).map((row) => ({ ...row })),
    ),
    createMany: vi.fn(async ({ data }: { data: Row[] }) => {
      rows.push(...data.map((row) => ({ ...row })));
      return { count: data.length };
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows.find((entry) => matches(entry, where))!;
      return Object.assign(row, data);
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const found = rows.filter((entry) => matches(entry, where));
      for (const row of found) Object.assign(row, data);
      return { count: found.length };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Row }) => {
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1)
        if (matches(rows[index]!, where)) rows.splice(index, 1);
      return { count: before - rows.length };
    }),
  };
}

async function setup(options: { clientSecret?: string } = {}) {
  const fake = vaultwardenFake("pbkdf2");
  const db = { sources: [] as Row[], secrets: [] as Row[], vault: [] as Row[] };
  const prisma = {
    credentialSource: table(db.sources),
    secret: table(db.secrets),
    vaultCredential: table(db.vault),
    spaceSettingOverride: { findUnique: vi.fn(async () => ({ setting: "credentials" })) },
    $queryRaw: vi.fn(async () => [{ locked: 1 }]),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  const transport = { fetch: fake.fetcher };
  const secrets = new ComposedSecretStore(
    new EncryptedSecretStore("fake-key"),
    undefined,
    undefined,
    {
      prisma: prisma as unknown as PrismaClient,
      transport,
    },
  );
  const stored = await secrets.put(
    JSON.stringify({
      ...fake.credentials,
      clientSecret: options.clientSecret ?? fake.credentials.clientSecret,
    }),
    {
      operationId: "test",
      traceId: "test",
      userId: "user-1",
      spaceId: "space-1",
      signal: new AbortController().signal,
    },
    { recordId: "secret-1" },
  );
  db.secrets.push({
    id: "secret-1",
    userId: "user-1",
    spaceId: null,
    ciphertext: stored.ciphertext,
  });
  db.sources.push({
    id: "source-1",
    userId: "user-1",
    spaceId: null,
    provider: "vaultwarden",
    settings: {
      origin: fake.credentials.baseUrl,
      email: "spike@example.test",
      collectionIds: [WEBSITES],
    },
    secretId: "secret-1",
    lastSyncedAt: null,
    lastSyncError: null,
  });
  const native = (name: string, extra: Row = {}) =>
    db.vault.push({
      id: `native-${name}`,
      userId: "user-1",
      spaceId: null,
      name,
      origin: "https://native.example.test",
      auth: { type: "login" },
      ciphertext: `v2:native-${name}`,
      ...extra,
    });
  const sync = () =>
    syncCredentialSource(
      { prisma: prisma as unknown as PrismaClient, secrets, transport, now: () => new Date(0) },
      "source-1",
    );
  const pointers = () =>
    db.vault
      .filter((row) => row.ciphertext.startsWith(PREFIX))
      .map((row) => ({
        name: row.name,
        origin: row.origin,
        cipherId: row.ciphertext.slice(PREFIX.length),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  const syncs = () =>
    fake.fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === "/api/sync").length;
  return { fake, db, secrets, native, sync, pointers, syncs };
}

describe("syncCredentialSource", () => {
  it("adds one login row per eligible item, named from the item and clear of every taken name", async () => {
    const { db, native, sync, pointers } = await setup();
    native("org-shared");
    await sync();
    expect(pointers()).toEqual([
      { name: "org-cipherkey", origin: "https://ock.example.test", cipherId: expect.any(String) },
      { name: "org-shared-2", origin: "https://org.example.test", cipherId: ORG_SHARED },
      { name: "xcheck-org", origin: "https://org.xcheck.example.test", cipherId: XCHECK_ORG },
    ]);
    expect(db.vault.find((row) => row.name === "org-shared")).toMatchObject({
      ciphertext: "v2:native-org-shared",
    });
    for (const row of db.vault) expect(row.auth).toEqual({ type: "login" });
    expect(db.sources[0]).toMatchObject({ lastSyncedAt: new Date(0), lastSyncError: null });
  });

  it("keeps a row's name across syncs and removes rows whose item is gone", async () => {
    const { fake, db, native, sync, pointers } = await setup();
    native("bank");
    await sync();
    db.vault.find((row) => row.ciphertext === `${PREFIX}${ORG_SHARED}`)!.name = "shared";
    await sync();
    expect(pointers().map((row) => row.name)).toEqual(["org-cipherkey", "shared", "xcheck-org"]);
    fake.sync.ciphers = fake.sync.ciphers.filter((cipher: Row) => cipher.id !== XCHECK_ORG);
    await sync();
    expect(pointers().map((row) => row.name)).toEqual(["org-cipherkey", "shared"]);
    expect(db.vault.map((row) => row.name)).toContain("bank");
  });

  it("stops at the vault limit, skipping the rest by name", async () => {
    const { db, native, sync, pointers } = await setup();
    for (let index = 0; index < 98; index++) native(`native-${index}`);
    await sync();
    expect(pointers().map((row) => row.name)).toEqual(["org-cipherkey", "org-shared"]);
    expect(db.vault).toHaveLength(100);
  });

  it("keeps the rows and records a fixed message when Vaultwarden rejects the stored key", async () => {
    const { db, sync, pointers } = await setup();
    await sync();
    const { db: rejectedDb, sync: rejectedSync } = await setup({ clientSecret: "revoked-secret" });
    rejectedDb.vault.push(...db.vault.map((row) => ({ ...row })));
    await rejectedSync();
    expect(rejectedDb.vault).toHaveLength(pointers().length);
    expect(rejectedDb.sources[0]).toMatchObject({
      lastSyncedAt: null,
      lastSyncError: "Vaultwarden rejected the stored credentials",
    });
  });
});

describe("planCredentialSync", () => {
  const login = (name: string, cipherId = name) => ({
    cipherId,
    name,
    origins: ["https://example.test"],
    password: "fake-password",
    viewPassword: true,
    collectionIds: [],
  });

  it("folds names to the credential name pattern and skips logins with no password or HTTPS site", () => {
    const plan = planCredentialSync(
      [],
      [
        login("Ünïcode Bank!"),
        login("123"),
        login("x".repeat(70), "long-1"),
        login("x".repeat(70), "long-2"),
        { ...login("No password"), password: undefined },
        { ...login("No site"), origins: [] },
      ],
      PREFIX,
    );
    expect(plan.create.map((entry) => entry.name)).toEqual([
      "login",
      "unicode-bank",
      "x".repeat(64),
      `${"x".repeat(62)}-2`,
    ]);
  });
});

describe("Vaultwarden secret refs", () => {
  it("load the current login in the shape every website login has", async () => {
    const { db, secrets, sync } = await setup();
    await sync();
    const row = db.vault.find((entry) => entry.ciphertext === `${PREFIX}${ORG_SHARED}`)!;
    const { fields } = decodeLoginSecret(await secrets.load(row.ciphertext, row.id));
    expect(fields).toEqual([
      { label: "Username", value: "shared-user", hidden: false },
      { label: "Password", value: "pw-ORG-789", hidden: true },
    ]);
  });

  it("share one token and one sync between the loads of a run start", async () => {
    const { fake, db, secrets, sync, syncs } = await setup();
    await sync();
    const before = syncs();
    const loads = [...db.vault, ...db.vault].slice(0, 5);
    await Promise.all(loads.map((row) => secrets.load(row.ciphertext, { recordId: row.id })));
    expect(syncs() - before).toBe(1);
    // One token for the sync job's client and one for the store's.
    expect(fake.logins).toBe(2);
  });

  it("resolve only for the row the sync wrote them into, on the site it was saved for", async () => {
    const { db, secrets, sync } = await setup();
    await sync();
    const row = db.vault.find((entry) => entry.ciphertext === `${PREFIX}${ORG_SHARED}`)!;
    const other = db.vault.find((entry) => entry !== row)!;
    await expect(secrets.load(row.ciphertext, other.id)).rejects.toBeInstanceOf(
      SecretNotFoundError,
    );
    row.userId = "user-2";
    await expect(secrets.load(row.ciphertext, row.id)).rejects.toBeInstanceOf(SecretNotFoundError);
    row.userId = "user-1";
    row.spaceId = "space-1";
    await expect(secrets.load(row.ciphertext, row.id)).rejects.toBeInstanceOf(SecretNotFoundError);
    row.spaceId = null;
    row.origin = "https://elsewhere.example.test";
    await expect(secrets.load(row.ciphertext, row.id)).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("report an unreachable Vaultwarden as unavailable without its response text", async () => {
    const { fake, db, secrets, sync } = await setup();
    await sync();
    fake.offline = true;
    const row = db.vault[0]!;
    const error = await secrets.load(row.ciphertext, row.id).catch((caught) => caught);
    expect(error).toBeInstanceOf(SecretStoreUnavailableError);
    expect(`${error.message} ${error.stack}`).not.toContain("private response value");
  });

  it("are never deleted from Vaultwarden when their row goes", async () => {
    const { fake, secrets } = await setup();
    const calls = fake.fetcher.mock.calls.length;
    await expect(secrets.delete(`${PREFIX}${ORG_SHARED}`, "row-1")).resolves.toBeUndefined();
    expect(fake.fetcher.mock.calls.length).toBe(calls);
  });
});
