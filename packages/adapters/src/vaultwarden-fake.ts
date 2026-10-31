import { readFileSync } from "node:fs";
import { expect, vi } from "vitest";
import type { VaultwardenCredentials } from "./vaultwarden-client.js";

type AccountName = "pbkdf2" | "argon2" | "hiddenPassword";

const fixture = (name: string): any =>
  JSON.parse(readFileSync(new URL(`./testing/vaultwarden/${name}`, import.meta.url), "utf8"));

const accounts = fixture("accounts.json") as Record<
  AccountName,
  { masterPassword?: string; userKey: string }
>;
const files: Record<AccountName, { token?: string; sync: string }> = {
  pbkdf2: { token: "token-pbkdf2.json", sync: "sync-pbkdf2.json" },
  argon2: { token: "token-argon2.json", sync: "sync-argon2.json" },
  hiddenPassword: { sync: "sync-hidden-password.json" },
};

/** Vaultwarden 1.37 answers a bad API key with HTTP 400 and this body. */
const invalidClient = () =>
  Response.json(
    {
      message: "Incorrect client_secret",
      validationErrors: { "": ["Incorrect client_secret"] },
      errorModel: { message: "Incorrect client_secret", object: "error" },
      error: "",
      error_description: "",
      object: "error",
    },
    { status: 400 },
  );

/** Strict offline Vaultwarden REST fake serving recorded token and sync responses. */
export function vaultwardenFake(account: AccountName = "pbkdf2") {
  const baseUrl = "https://vault.example.test";
  const clientId = `user.fake-${account}`;
  const clientSecret = "fake-client-secret";
  const token = files[account].token ? fixture(files[account].token) : {};
  const sync = fixture(files[account].sync);
  const loginStatuses: number[] = [];
  const syncStatuses: number[] = [];
  const revoked = new Set<string>();
  let logins = 0;
  let expiresIn = 7200;
  let offline = false;
  let gate: (() => Promise<void>) | undefined;
  const failure = (status: number) =>
    new Response("private response value", { status, headers: { "content-type": "text/html" } });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(baseUrl);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    init?.signal?.throwIfAborted();
    if (offline) throw new TypeError("fetch failed: private response value");
    if (gate) await gate();
    init?.signal?.throwIfAborted();
    const headers = new Headers(init?.headers);
    expect(headers.get("device-type")).toBe("21");
    if (url.pathname === "/identity/connect/token") {
      expect(init?.method).toBe("POST");
      expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
      const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
      expect(form).toEqual({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: expect.any(String),
        scope: "api",
        deviceType: "21",
        deviceIdentifier: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
        deviceName: "rakazo",
      });
      const status = loginStatuses.shift() ?? 200;
      if (status !== 200) return failure(status);
      if (form.client_secret !== clientSecret) return invalidClient();
      logins++;
      return Response.json({
        ...token,
        access_token: `token-${logins}`,
        expires_in: expiresIn,
        token_type: "Bearer",
        scope: "api",
      });
    }
    expect(`${url.pathname}${url.search}`).toBe("/api/sync?excludeDomains=true");
    expect(init?.method).toBe("GET");
    const bearer = headers.get("authorization")?.match(/^Bearer (token-([1-9][0-9]*))$/);
    expect(bearer).toBeTruthy();
    expect(Number(bearer![2])).toBeLessThanOrEqual(logins);
    if (revoked.has(bearer![1]!)) return failure(401);
    const status = syncStatuses.shift() ?? 200;
    if (status !== 200) return failure(status);
    return Response.json(sync);
  });
  const credentials: VaultwardenCredentials = {
    baseUrl,
    clientId,
    clientSecret,
    userKey: accounts[account].userKey,
  };
  return {
    credentials,
    masterPassword: accounts[account].masterPassword ?? "",
    sync,
    loginStatuses,
    syncStatuses,
    fetcher,
    get logins() {
      return logins;
    },
    revokeTokens() {
      for (let issued = 1; issued <= logins; issued++) revoked.add(`token-${issued}`);
    },
    set expiresIn(value: number) {
      expiresIn = value;
    },
    set offline(value: boolean) {
      offline = value;
    },
    set gate(value: (() => Promise<void>) | undefined) {
      gate = value;
    },
  };
}
