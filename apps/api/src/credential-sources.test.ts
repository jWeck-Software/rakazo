import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { vaultwardenFake } from "../../../packages/adapters/src/vaultwarden-fake.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const events = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  recordSecurityEvent: events.record,
}));

// Offline boundary: a fake Prisma client and secret store drive the real router handlers,
// the real Vaultwarden client against recorded responses, and the real safe fetch.

type Row = Record<string, unknown>;

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
} satisfies Actor;

const WEBSITES = "142b8424-8057-483c-94b6-29ff8d70705a";

function matches(row: Row, where: Row = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && "startsWith" in value)
      return String(row[key]).startsWith(String(value.startsWith));
    return (row[key] ?? null) === value;
  });
}

function table(rows: Row[]) {
  let next = 0;
  return {
    findFirst: vi.fn(async (args: { where: Row }) => {
      const row = rows.find((entry) => matches(entry, args.where));
      return row ? { ...row } : null;
    }),
    create: vi.fn(async (args: { data: Row }) => {
      const row = { id: `row-${++next}`, lastSyncedAt: null, lastSyncError: null, ...args.data };
      rows.push(row);
      return { ...row };
    }),
    update: vi.fn(async (args: { where: Row; data: Row }) => {
      const row = rows.find((entry) => matches(entry, args.where))!;
      Object.assign(row, args.data);
      return { ...row };
    }),
    delete: vi.fn(async (args: { where: Row }) => {
      const index = rows.findIndex((entry) => matches(entry, args.where));
      return rows.splice(index, 1)[0];
    }),
    deleteMany: vi.fn(async (args: { where: Row }) => {
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1)
        if (matches(rows[index]!, args.where)) rows.splice(index, 1);
      return { count: before - rows.length };
    }),
  };
}

function setup(options: { allowPrivate?: boolean; spaceOverride?: boolean } = {}) {
  const fake = vaultwardenFake("pbkdf2");
  const db = { sources: [] as Row[], secrets: [] as Row[], vault: [] as Row[] };
  const prisma = {
    credentialSource: table(db.sources),
    secret: table(db.secrets),
    vaultCredential: table(db.vault),
    spaceSettingOverride: {
      findUnique: vi.fn(async () => (options.spaceOverride ? { setting: "credentials" } : null)),
    },
    $queryRaw: vi.fn(async () => [{ locked: 1 }]),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  const saved = new Map<string, string>();
  let ids = 0;
  const secrets = {
    put: vi.fn(async (plaintext: string) => {
      const id = `secret-${++ids}`;
      saved.set(`enc:${id}`, plaintext);
      return { id, ref: `enc:${id}`, ciphertext: `enc:${id}` };
    }),
    load: vi.fn(async (ciphertext: string) => saved.get(ciphertext) ?? ""),
  };
  const changed = vi.fn();
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => fake.fetcher(input, init));
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    secrets,
    remoteConnectors: {
      fetch,
      resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
    },
    onCredentialSourceChanged: changed,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
      mcpAllowPrivateEndpoint: options.allowPrivate,
    },
    dataDir: "/tmp/rakazo-router-test",
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  async function call(path: string, input?: unknown) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/vault/source/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor, sessionId: "session-1" } },
    );
    if (!response) throw new Error("Procedure did not match");
    const text = await response.text();
    return { status: response.status, text, json: (JSON.parse(text) as { json: any }).json };
  }
  const connectInput = (overrides: Row = {}) => ({
    baseUrl: fake.credentials.baseUrl,
    clientId: fake.credentials.clientId,
    clientSecret: fake.credentials.clientSecret,
    masterPassword: fake.masterPassword,
    ...overrides,
  });
  return { fake, db, saved, secrets, fetch, changed, call, connectInput };
}

describe("vault.source", () => {
  it("stores the derived connection encrypted and never keeps or returns the master password", async () => {
    const { fake, db, saved, changed, call, connectInput } = setup();
    events.record.mockClear();
    const connected = await call("connect", connectInput());
    expect(connected.status).toBe(200);
    expect(connected.json.status).toEqual({
      connected: true,
      provider: "vaultwarden",
      origin: "https://vault.example.test",
      email: "spike@example.test",
      collectionIds: [],
      lastSyncedAt: null,
      lastSyncError: null,
    });
    expect(connected.json.collections.map((c: Row) => c.name)).toEqual(["Websites", "Hidden-PW"]);
    expect(db.secrets).toEqual([
      expect.objectContaining({
        kind: "credential-source",
        spaceId: null,
        ciphertext: "enc:secret-1",
      }),
    ]);
    expect(JSON.parse(saved.get("enc:secret-1")!)).toEqual(fake.credentials);
    expect(db.sources).toEqual([
      expect.objectContaining({ userId: "user-1", spaceId: null, secretId: "secret-1" }),
    ]);
    expect(changed).toHaveBeenCalledWith(db.sources[0]!.id);
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "credential_source.connected",
        metadata: {
          provider: "vaultwarden",
          origin: "https://vault.example.test",
          scope: "account",
        },
      }),
    );
    const everything = JSON.stringify([connected.text, db, [...saved], events.record.mock.calls]);
    expect(everything).not.toContain(fake.masterPassword);
    expect((await call("status", {})).json).toEqual(connected.json.status);
  });

  it("turns down bad credentials and an unreachable server without forwarding server text", async () => {
    const { fake, db, call, connectInput } = setup();
    const rejected = await call("connect", connectInput({ clientSecret: "wrong-secret" }));
    expect(rejected.status).toBe(400);
    expect(rejected.json.message).toBe("Vaultwarden rejected these credentials");
    expect(rejected.text).not.toContain("client_secret");
    fake.offline = true;
    const offline = await call("connect", connectInput());
    expect(offline.status).toBe(400);
    expect(offline.json.message).toBe("Vaultwarden is not reachable");
    expect(offline.text).not.toContain("private response value");
    expect(db.sources).toEqual([]);
  });

  it("reaches a plain-HTTP private endpoint only when the instance allows private endpoints", async () => {
    const refused = setup();
    const denied = await refused.call(
      "connect",
      refused.connectInput({ baseUrl: "http://10.0.0.5:8080" }),
    );
    expect(denied.status).toBe(400);
    expect(denied.json.message).toBe("Vaultwarden URL must use HTTPS");
    expect(refused.fetch).not.toHaveBeenCalled();

    const allowed = setup({ allowPrivate: true });
    allowed.fetch.mockImplementation(async () => new Response("{}", { status: 400 }));
    const reached = await allowed.call(
      "connect",
      allowed.connectInput({ baseUrl: "http://10.0.0.5:8080" }),
    );
    expect(String(allowed.fetch.mock.calls[0]?.[0])).toBe(
      "http://10.0.0.5:8080/identity/connect/token",
    );
    expect(reached.json.message).toBe("Vaultwarden rejected these credentials");
  });

  it("selects only collections the connected account has", async () => {
    const { db, changed, call, connectInput } = setup();
    await call("connect", connectInput());
    changed.mockClear();
    const unknown = await call("setCollections", { collectionIds: [WEBSITES, "not-a-collection"] });
    expect(unknown.status).toBe(400);
    expect(unknown.json.message).toBe("Choose collections from this Vaultwarden");
    expect(changed).not.toHaveBeenCalled();
    const chosen = await call("setCollections", { collectionIds: [WEBSITES] });
    expect(chosen.json.collectionIds).toEqual([WEBSITES]);
    expect(db.sources[0]!.settings).toMatchObject({ collectionIds: [WEBSITES] });
    expect(changed).toHaveBeenCalledWith(db.sources[0]!.id);
  });

  it("disconnects by removing the source, its secret, and only the logins it added", async () => {
    const { db, call, connectInput } = setup();
    await call("connect", connectInput());
    const sourceId = String(db.sources[0]!.id);
    db.vault.push(
      {
        id: "pointer",
        userId: "user-1",
        spaceId: null,
        ciphertext: `vaultwarden:v1:${sourceId}:x`,
      },
      { id: "typed", userId: "user-1", spaceId: null, ciphertext: "enc:typed" },
      { id: "other-source", userId: "user-1", spaceId: null, ciphertext: "vaultwarden:v1:other:x" },
    );
    expect((await call("disconnect", {})).json).toEqual({ ok: true });
    expect(db.sources).toEqual([]);
    expect(db.secrets).toEqual([]);
    expect(db.vault.map((row) => row.id)).toEqual(["typed", "other-source"]);
    expect((await call("status", {})).json).toEqual({ connected: false });
  });

  it("keeps the account vault and a Space's own vault apart", async () => {
    const shared = setup();
    const notInUse = await shared.call("connect", shared.connectInput({ scope: "space" }));
    expect(notInUse.status).toBe(400);
    expect(notInUse.json.message).toBe("This Space uses the account vault");

    const own = setup({ spaceOverride: true });
    await own.call("connect", own.connectInput({ scope: "account" }));
    expect((await own.call("status", { scope: "space" })).json).toEqual({ connected: false });
    expect((await own.call("status", {})).json).toEqual({ connected: false });
    await own.call("connect", own.connectInput());
    expect(own.db.sources.map((row) => row.spaceId)).toEqual([null, "space-1"]);
    expect(own.db.secrets.map((row) => row.spaceId)).toEqual([null, "space-1"]);
    await own.call("disconnect", { scope: "space" });
    expect(own.db.sources.map((row) => row.spaceId)).toEqual([null]);
    expect((await own.call("status", { scope: "account" })).json.connected).toBe(true);
  });
});
