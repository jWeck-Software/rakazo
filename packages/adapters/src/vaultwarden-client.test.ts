import * as nodeCrypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createVaultwardenClient,
  deriveVaultwardenCredentials,
  VaultwardenAuthError,
  VaultwardenUnavailableError,
} from "./vaultwarden-client.js";
import { decryptBytes, decryptText, symmetricKey } from "./vaultwarden-crypto.js";
import { vaultwardenFake } from "./vaultwarden-fake.js";

const WEBSITES = "142b8424-8057-483c-94b6-29ff8d70705a";
const HIDDEN_PW = "f9748025-8216-4578-b02c-936b58051d97";

const websiteLogins = [
  {
    cipherId: "39d8fc55-7221-48f0-bc4a-1abcee9d883d",
    name: "Org CipherKey",
    origins: ["https://ock.example.test"],
    username: "dave",
    password: "pw-OCK-111",
    viewPassword: true,
    collectionIds: [WEBSITES],
  },
  {
    cipherId: "5915e24d-8b10-4d25-a04a-6c7a44426950",
    name: "Org Shared",
    origins: ["https://org.example.test"],
    username: "shared-user",
    password: "pw-ORG-789",
    viewPassword: true,
    collectionIds: [WEBSITES],
  },
  {
    cipherId: "f4f1d20d-d721-4ea2-a29e-1a2325080b40",
    name: "XCheck Org",
    origins: ["https://org.xcheck.example.test"],
    username: "xorg",
    password: "Org-kGOdqg3UAbtZ!",
    viewPassword: true,
    collectionIds: [WEBSITES],
  },
];

function setup(account?: Parameters<typeof vaultwardenFake>[0]) {
  const fake = vaultwardenFake(account);
  let clock = 1_000_000;
  const client = createVaultwardenClient(fake.credentials, {
    fetch: fake.fetcher,
    now: () => clock,
  });
  return {
    fake,
    client,
    advance(ms: number) {
      clock += ms;
    },
  };
}

const cipher = (sync: any, id: string) => sync.ciphers.find((entry: any) => entry.id === id);

describe("deriveVaultwardenCredentials", () => {
  const derive = (fake: ReturnType<typeof vaultwardenFake>, overrides = {}) =>
    deriveVaultwardenCredentials({
      baseUrl: `${fake.credentials.baseUrl}/`,
      clientId: fake.credentials.clientId,
      clientSecret: fake.credentials.clientSecret,
      masterPassword: fake.masterPassword,
      fetch: fake.fetcher,
      ...overrides,
    });

  it("unlocks a PBKDF2 account and returns storable credentials without the master password", async () => {
    const fake = vaultwardenFake("pbkdf2");
    const result = await derive(fake);
    expect(result).toEqual({
      credentials: fake.credentials,
      email: "spike@example.test",
      collections: [
        {
          id: WEBSITES,
          organizationId: "5074d654-69e5-4162-8aa9-2fc48a002d28",
          organizationName: "Spike Org",
          name: "Websites",
          readOnly: false,
          hidePasswords: false,
        },
        {
          id: HIDDEN_PW,
          organizationId: "5074d654-69e5-4162-8aa9-2fc48a002d28",
          organizationName: "Spike Org",
          name: "Hidden-PW",
          readOnly: false,
          hidePasswords: false,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(fake.masterPassword);
    expect(fake.logins).toBe(1);
  });

  it.skipIf(typeof nodeCrypto.argon2 !== "function")("unlocks an Argon2id account", async () => {
    const fake = vaultwardenFake("argon2");
    const result = await derive(fake);
    expect(result.credentials).toEqual(fake.credentials);
    expect(result.email).toBe("spike-argon@example.test");
  });

  it("rejects a wrong master password or API key without echoing either", async () => {
    const fake = vaultwardenFake("pbkdf2");
    const wrongPassword = await derive(fake, { masterPassword: "wrong-master-password" }).catch(
      (error: unknown) => error,
    );
    expect(wrongPassword).toBeInstanceOf(VaultwardenAuthError);
    const wrongSecret = await derive(fake, { clientSecret: "wrong-client-secret" }).catch(
      (error: unknown) => error,
    );
    expect(wrongSecret).toBeInstanceOf(VaultwardenAuthError);
    for (const error of [wrongPassword, wrongSecret] as Error[])
      expect(`${error.message} ${error.stack}`).not.toMatch(
        /wrong-master-password|wrong-client-secret|private response value/,
      );
  });

  it("requires HTTPS unless private endpoints are allowed", async () => {
    const fake = vaultwardenFake("pbkdf2");
    await expect(derive(fake, { baseUrl: "http://vault.example.test" })).rejects.toThrow(
      "Vaultwarden URL must use HTTPS",
    );
    expect(fake.fetcher).not.toHaveBeenCalled();
    expect(() =>
      createVaultwardenClient(
        { ...fake.credentials, baseUrl: "http://127.0.0.1:8088" },
        { fetch: fake.fetcher, allowPrivateEndpoint: true },
      ),
    ).not.toThrow();
  });
});

describe("VaultwardenClient", () => {
  it("decrypts org, per-item-key, and official-client logins in the selected collections", async () => {
    const { client } = setup();
    const logins = await client.logins({ collectionIds: [WEBSITES] });
    expect(logins.sort((a, b) => a.cipherId.localeCompare(b.cipherId))).toEqual(websiteLogins);
    expect(
      await client.login({ cipherId: websiteLogins[2]!.cipherId, collectionIds: [WEBSITES] }),
    ).toEqual(websiteLogins[2]);
  });

  it("never returns personal, non-login, deleted, or out-of-scope items", async () => {
    const { fake, client } = setup();
    cipher(fake.sync, "5915e24d-8b10-4d25-a04a-6c7a44426950").type = 2;
    cipher(fake.sync, "39d8fc55-7221-48f0-bc4a-1abcee9d883d").deletedDate = "2026-10-31T12:00:00Z";
    const both = await client.logins({ collectionIds: [WEBSITES, HIDDEN_PW] });
    expect(both.map((login) => login.name).sort()).toEqual(["XCheck Hidden", "XCheck Org"]);
    expect(await client.logins({ collectionIds: [HIDDEN_PW] })).toHaveLength(1);
    expect(await client.logins({ collectionIds: [] })).toEqual([]);
    expect(
      await client.login({
        cipherId: "27c4ae6b-033f-40a0-9f9b-28c4bccfa689",
        collectionIds: [WEBSITES],
      }),
    ).toBeUndefined();
  });

  it("leaves out items that ask for the master password before use", async () => {
    const { fake, client } = setup();
    cipher(fake.sync, websiteLogins[1]!.cipherId).reprompt = 1;
    const logins = await client.logins({ collectionIds: [WEBSITES] });
    expect(logins.map((login) => login.name).sort()).toEqual(["Org CipherKey", "XCheck Org"]);
    expect(
      await client.login({ cipherId: websiteLogins[1]!.cipherId, collectionIds: [WEBSITES] }),
    ).toBeUndefined();
  });

  it("decrypts personal items with the user key, including per-item keys and non-ASCII text", () => {
    const { fake } = setup();
    const userKey = symmetricKey(Buffer.from(fake.credentials.userKey, "base64"));
    const personal = cipher(fake.sync, "27c4ae6b-033f-40a0-9f9b-28c4bccfa689");
    expect(decryptText(personal.login.password, userKey)).toBe('Xc!#ü€~"\\ eOo55xXOb-l8');
    const perItem = cipher(fake.sync, "68e00206-315b-4441-ae84-deccf3027fe4");
    const itemKey = symmetricKey(decryptBytes(perItem.key, userKey));
    expect(decryptText(perItem.login.password, itemKey)).toBe("pw-CK-000");
  });

  it("hides a per-item-key URI whose checksum is missing or wrong", async () => {
    const { fake, client } = setup();
    const perItem = cipher(fake.sync, "39d8fc55-7221-48f0-bc4a-1abcee9d883d");
    perItem.login.uris[0].uriChecksum = null;
    const missing = await client.logins({ collectionIds: [WEBSITES] });
    expect(missing.find((login) => login.name === "Org CipherKey")?.origins).toEqual([]);
    expect(missing.find((login) => login.name === "Org Shared")?.origins).toEqual([
      "https://org.example.test",
    ]);
    perItem.login.uris[0].uriChecksum = perItem.name;
    const wrong = await client.logins({ collectionIds: [WEBSITES] });
    expect(wrong.find((login) => login.name === "Org CipherKey")?.origins).toEqual([]);
  });

  it("returns fill-only logins whose password the organization hides", async () => {
    const { client } = setup("hiddenPassword");
    expect(await client.logins({ collectionIds: [HIDDEN_PW] })).toEqual([
      {
        cipherId: "f5d2dc98-2ee0-454a-b09b-771ed8d84797",
        name: "XCheck Hidden",
        origins: ["https://hidden.example.test"],
        username: "hidden-user",
        password: "pw-HIDDEN-555",
        viewPassword: false,
        collectionIds: [HIDDEN_PW],
      },
    ]);
  });

  it("skips an item that fails its integrity check and keeps the rest", async () => {
    const { fake, client } = setup();
    const tampered = cipher(fake.sync, "f4f1d20d-d721-4ea2-a29e-1a2325080b40");
    const [iv, data, mac] = tampered.login.password.slice(2).split("|");
    const flipped = Buffer.from(mac, "base64");
    flipped[0]! ^= 1;
    tampered.login.password = `2.${iv}|${data}|${flipped.toString("base64")}`;
    const logins = await client.logins({ collectionIds: [WEBSITES] });
    expect(logins.map((login) => login.name).sort()).toEqual(["Org CipherKey", "Org Shared"]);
  });

  it("reuses one token across calls and shares one login between concurrent callers", async () => {
    const { fake, client } = setup();
    let release!: () => void;
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.gate = () => opened;
    const concurrent = Promise.all(
      [1, 2, 3].map(() => client.logins({ collectionIds: [WEBSITES] })),
    );
    release();
    await concurrent;
    fake.gate = undefined;
    await client.logins({ collectionIds: [WEBSITES] });
    expect(fake.logins).toBe(1);
  });

  it("logs in again shortly before expiry and when the server revokes the token", async () => {
    const { fake, client, advance } = setup();
    await client.logins({ collectionIds: [WEBSITES] });
    advance(7200_000 - 61_000);
    await client.logins({ collectionIds: [WEBSITES] });
    expect(fake.logins).toBe(1);
    advance(2_000);
    await client.logins({ collectionIds: [WEBSITES] });
    expect(fake.logins).toBe(2);
    fake.revokeTokens();
    expect(await client.logins({ collectionIds: [WEBSITES] })).toHaveLength(3);
    expect(fake.logins).toBe(3);
  });

  it("reports rate limits, server errors, and outages as unavailable", async () => {
    const { fake, client } = setup();
    const failures: unknown[] = [];
    fake.loginStatuses.push(429);
    failures.push(await client.logins({ collectionIds: [WEBSITES] }).catch((error) => error));
    fake.syncStatuses.push(503);
    failures.push(await client.logins({ collectionIds: [WEBSITES] }).catch((error) => error));
    fake.offline = true;
    failures.push(await client.logins({ collectionIds: [WEBSITES] }).catch((error) => error));
    expect(failures.map((error) => (error as VaultwardenUnavailableError).status)).toEqual([
      429,
      503,
      undefined,
    ]);
    for (const error of failures as Error[]) {
      expect(error).toBeInstanceOf(VaultwardenUnavailableError);
      expect(error.message).not.toContain("private response value");
    }
  });

  it("reports a rejected API key as an auth error", async () => {
    const fake = vaultwardenFake();
    const client = createVaultwardenClient(
      { ...fake.credentials, clientSecret: "revoked-secret" },
      { fetch: fake.fetcher },
    );
    const error = await client.logins({ collectionIds: [WEBSITES] }).catch((caught) => caught);
    expect(error).toBeInstanceOf(VaultwardenAuthError);
    expect(`${error.message} ${error.stack}`).not.toContain("revoked-secret");
  });
});
