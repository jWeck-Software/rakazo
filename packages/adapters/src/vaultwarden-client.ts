import { createHash } from "node:crypto";
import { withAbort } from "@rakazo/core";
import { z } from "zod";
import type { SymmetricKey, VaultwardenKdf } from "./vaultwarden-crypto.js";
import {
  decryptBytes,
  decryptPrivateKey,
  decryptText,
  deriveMasterKey,
  stretchMasterKey,
  symmetricKey,
  unwrapRsaKey,
  uriChecksum,
  VaultwardenDecryptError,
} from "./vaultwarden-crypto.js";

export { VaultwardenArgon2UnsupportedError } from "./vaultwarden-crypto.js";

/** What a connection stores (encrypted). The master password is never part of it. */
export interface VaultwardenCredentials {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Base64 of the 64-byte user symmetric key. */
  userKey: string;
}

const credentialsSchema = z.object({
  baseUrl: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
  userKey: z.string(),
});

/** Reads a stored connection. The error never quotes the plaintext. */
export function parseVaultwardenCredentials(plaintext: string): VaultwardenCredentials {
  try {
    return credentialsSchema.parse(JSON.parse(plaintext));
  } catch {
    throw new Error("The saved Vaultwarden connection is unreadable");
  }
}

const sourceSettingsSchema = z.object({
  origin: z.string(),
  email: z.string(),
  collectionIds: z.array(z.string()),
});

/** A source row's non-secret settings: the server origin, the account, and the chosen collections. */
export type VaultwardenSourceSettings = z.infer<typeof sourceSettingsSchema>;

export function parseVaultwardenSourceSettings(value: unknown): VaultwardenSourceSettings {
  return sourceSettingsSchema.parse(value);
}

/** Every vault_credentials row a source creates stores this prefix plus the cipher id as its ciphertext. */
export function vaultwardenRefPrefix(sourceId: string): string {
  return `vaultwarden:v1:${sourceId}:`;
}

export interface VaultwardenCollection {
  id: string;
  organizationId: string;
  organizationName?: string;
  name: string;
  readOnly: boolean;
  hidePasswords: boolean;
}

export interface VaultwardenLogin {
  cipherId: string;
  name: string;
  /** HTTPS origins only. */
  origins: string[];
  username?: string;
  password?: string;
  /** False when the organization hides the password from this user; fill-only. */
  viewPassword: boolean;
  collectionIds: string[];
}

export interface VaultwardenTransport {
  fetch: typeof globalThis.fetch;
  /** Deployment-owner escape for plain-HTTP private endpoints. Default off. */
  allowPrivateEndpoint?: boolean;
  now?: () => number;
}

export interface VaultwardenScope {
  collectionIds: readonly string[];
  signal?: AbortSignal;
}

export interface VaultwardenClient {
  collections(signal?: AbortSignal): Promise<VaultwardenCollection[]>;
  logins(scope: VaultwardenScope): Promise<VaultwardenLogin[]>;
  login(request: VaultwardenScope & { cipherId: string }): Promise<VaultwardenLogin | undefined>;
}

export class VaultwardenUnavailableError extends Error {
  readonly code = "VAULTWARDEN_UNAVAILABLE";
  constructor(
    readonly status?: number,
    message = "Vaultwarden is unavailable; retry later",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "VaultwardenUnavailableError";
  }
}

export class VaultwardenAuthError extends Error {
  readonly code = "VAULTWARDEN_AUTH";
  constructor(message = "Vaultwarden rejected the API key") {
    super(message);
    this.name = "VaultwardenAuthError";
  }
}

const DEVICE_TYPE = "21";
const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const LOGIN_CIPHER = 1;
/** Bitwarden URI match types that never map to an origin: regular expression and never. */
const UNFILLABLE_MATCH = new Set([4, 5]);

const nullableString = z.string().nullish();

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

const masterKeySchema = z.object({
  Key: z.string(),
  Kdf: z.number(),
  KdfIterations: z.number(),
  KdfMemory: z.number().nullish(),
  KdfParallelism: z.number().nullish(),
  UserDecryptionOptions: z
    .object({ MasterPasswordUnlock: z.object({ Salt: nullableString }).nullish() })
    .nullish(),
});

const syncSchema = z.object({
  profile: z.object({
    email: z.string(),
    privateKey: z.string(),
    organizations: z.array(z.object({ id: z.string(), name: nullableString, key: nullableString })),
  }),
  collections: z.array(z.unknown()),
  ciphers: z.array(z.unknown()),
});

const collectionSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  readOnly: z.boolean().nullish(),
  hidePasswords: z.boolean().nullish(),
});

const cipherSchema = z.object({
  id: z.string(),
  type: z.number(),
  name: z.string(),
  key: nullableString,
  organizationId: nullableString,
  collectionIds: z.array(z.string()).nullish(),
  viewPassword: z.boolean().nullish(),
  /** 1 asks for the master password before use; official clients never autofill those. */
  reprompt: z.number().nullish(),
  deletedDate: nullableString,
  login: z
    .object({
      username: nullableString,
      password: nullableString,
      uris: z
        .array(
          z.object({
            uri: nullableString,
            uriChecksum: nullableString,
            match: z.number().nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
});

type Sync = z.infer<typeof syncSchema>;
type Cipher = z.infer<typeof cipherSchema>;
type Token = { value: string; expires: number };

type OrganizationKeys = Map<string, SymmetricKey>;

function parseBaseUrl(value: string, allowPrivateEndpoint: boolean | undefined): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Vaultwarden URL is invalid");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowPrivateEndpoint === true))
    throw new Error("Vaultwarden URL must use HTTPS");
  if (url.username || url.password || url.href.includes("?") || url.href.includes("#"))
    throw new Error("Vaultwarden URL must not contain credentials, a query, or a fragment");
  return url.href.replace(/\/+$/, "");
}

/** Stable per API key, so token renewals reuse one device instead of registering a new one. */
function deviceIdentifier(clientId: string): string {
  const hex = createHash("sha256").update(`rakazo-vaultwarden:${clientId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

interface Endpoint {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  clientId: string;
  clientSecret: string;
}

async function call(
  endpoint: Endpoint,
  path: string,
  init: RequestInit,
  callerSignal: AbortSignal | undefined,
): Promise<Response> {
  const signal = AbortSignal.any([
    ...(callerSignal ? [callerSignal] : []),
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  ]);
  try {
    return await endpoint.fetch(`${endpoint.baseUrl}${path}`, { ...init, signal });
  } catch (error) {
    if (callerSignal?.aborted) throw callerSignal.reason;
    throw new VaultwardenUnavailableError(undefined, "Vaultwarden could not be reached", {
      cause: error,
    });
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new VaultwardenUnavailableError(
      response.status,
      "Vaultwarden sent an unreadable response",
    );
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new VaultwardenUnavailableError(undefined, "Vaultwarden sent an unexpected response");
  return result.data;
}

async function requestToken(endpoint: Endpoint, signal: AbortSignal | undefined): Promise<unknown> {
  const response = await call(
    endpoint,
    "/identity/connect/token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "Device-Type": DEVICE_TYPE,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: endpoint.clientId,
        client_secret: endpoint.clientSecret,
        scope: "api",
        deviceType: DEVICE_TYPE,
        deviceIdentifier: deviceIdentifier(endpoint.clientId),
        deviceName: "rakazo",
      }).toString(),
    },
    signal,
  );
  if (response.status === 400 || response.status === 401) {
    await response.body?.cancel();
    throw new VaultwardenAuthError();
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new VaultwardenUnavailableError(response.status);
  }
  return readJson(response);
}

class TokenExpiredError extends Error {}

async function requestSync(
  endpoint: Endpoint,
  token: string,
  signal: AbortSignal | undefined,
): Promise<Sync> {
  const response = await call(
    endpoint,
    "/api/sync?excludeDomains=true",
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Device-Type": DEVICE_TYPE,
      },
    },
    signal,
  );
  if (response.status === 401) {
    await response.body?.cancel();
    throw new TokenExpiredError();
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new VaultwardenUnavailableError(response.status);
  }
  return parse(syncSchema, await readJson(response));
}

/** A user key that no longer opens the private key means the account's keys were rotated. */
function organizationKeys(sync: Sync, user: SymmetricKey): OrganizationKeys {
  let privateKey: Buffer;
  try {
    privateKey = decryptPrivateKey(sync.profile.privateKey, user);
  } catch {
    throw new VaultwardenAuthError("Vaultwarden keys changed; reconnect with the master password");
  }
  const organizations = new Map<string, SymmetricKey>();
  for (const organization of sync.profile.organizations) {
    if (!organization.key) continue;
    try {
      organizations.set(organization.id, unwrapRsaKey(organization.key, privateKey));
    } catch {}
  }
  return organizations;
}

function decryptCollections(sync: Sync, keys: OrganizationKeys): VaultwardenCollection[] {
  const names = new Map(sync.profile.organizations.map((org) => [org.id, org.name]));
  return sync.collections.flatMap((raw) => {
    const collection = collectionSchema.safeParse(raw);
    if (!collection.success) return [];
    const key = keys.get(collection.data.organizationId);
    if (!key) return [];
    const organizationName = names.get(collection.data.organizationId);
    try {
      return [
        {
          id: collection.data.id,
          organizationId: collection.data.organizationId,
          ...(organizationName ? { organizationName } : {}),
          name: decryptText(collection.data.name, key),
          readOnly: collection.data.readOnly === true,
          hidePasswords: collection.data.hidePasswords === true,
        },
      ];
    } catch {
      return [];
    }
  });
}

function httpsOrigin(uri: string): string | undefined {
  try {
    const url = new URL(uri.includes("://") ? uri : `https://${uri}`);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Official clients hide a per-item-key cipher's URI whose checksum is missing or wrong. */
function origins(cipher: Cipher, key: SymmetricKey): string[] {
  const result = new Set<string>();
  for (const entry of cipher.login?.uris ?? []) {
    if (!entry.uri || (entry.match != null && UNFILLABLE_MATCH.has(entry.match))) continue;
    const uri = decryptText(entry.uri, key);
    if (
      cipher.key &&
      (!entry.uriChecksum || decryptText(entry.uriChecksum, key) !== uriChecksum(uri))
    )
      continue;
    const origin = httpsOrigin(uri);
    if (origin) result.add(origin);
  }
  return [...result];
}

function decryptLogin(
  raw: unknown,
  keys: OrganizationKeys,
  collectionIds: ReadonlySet<string>,
  cipherId: string | undefined,
): VaultwardenLogin | undefined {
  const parsed = cipherSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const cipher = parsed.data;
  const cipherCollections = cipher.collectionIds ?? [];
  if (
    (cipherId !== undefined && cipher.id !== cipherId) ||
    cipher.type !== LOGIN_CIPHER ||
    cipher.deletedDate ||
    cipher.reprompt ||
    !cipher.organizationId ||
    !cipherCollections.some((id) => collectionIds.has(id))
  )
    return undefined;
  const organizationKey = keys.get(cipher.organizationId);
  if (!organizationKey) return undefined;
  try {
    const key = cipher.key
      ? symmetricKey(decryptBytes(cipher.key, organizationKey))
      : organizationKey;
    const username = cipher.login?.username ? decryptText(cipher.login.username, key) : undefined;
    const password = cipher.login?.password ? decryptText(cipher.login.password, key) : undefined;
    return {
      cipherId: cipher.id,
      name: decryptText(cipher.name, key),
      origins: origins(cipher, key),
      ...(username === undefined ? {} : { username }),
      ...(password === undefined ? {} : { password }),
      viewPassword: cipher.viewPassword !== false,
      collectionIds: cipherCollections,
    };
  } catch (error) {
    if (error instanceof VaultwardenDecryptError) return undefined;
    throw error;
  }
}

function parseKdf(token: z.infer<typeof masterKeySchema>): VaultwardenKdf {
  if (token.Kdf === 0) return { type: "pbkdf2", iterations: token.KdfIterations };
  if (token.Kdf === 1 && token.KdfMemory && token.KdfParallelism)
    return {
      type: "argon2id",
      iterations: token.KdfIterations,
      memoryMiB: token.KdfMemory,
      parallelism: token.KdfParallelism,
    };
  throw new Error("Vaultwarden account uses an unsupported key derivation");
}

/**
 * Logs in once with the API key, unlocks the vault with the master password, and returns the
 * credentials to store. The master password is used here only and never returned.
 */
export async function deriveVaultwardenCredentials(
  options: VaultwardenTransport & {
    baseUrl: string;
    clientId: string;
    clientSecret: string;
    masterPassword: string;
    signal?: AbortSignal;
  },
): Promise<{
  credentials: VaultwardenCredentials;
  email: string;
  collections: VaultwardenCollection[];
}> {
  const endpoint: Endpoint = {
    baseUrl: parseBaseUrl(options.baseUrl, options.allowPrivateEndpoint),
    fetch: options.fetch,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
  };
  const raw = await requestToken(endpoint, options.signal);
  const token = parse(tokenSchema, raw);
  const account = parse(masterKeySchema, raw);
  const sync = await requestSync(endpoint, token.access_token, options.signal).catch((error) => {
    throw error instanceof TokenExpiredError ? new VaultwardenAuthError() : error;
  });
  const email = sync.profile.email.trim().toLowerCase();
  const salt = account.UserDecryptionOptions?.MasterPasswordUnlock?.Salt ?? email;
  const masterKey = await deriveMasterKey(options.masterPassword, salt, parseKdf(account));
  let userKey: Buffer;
  try {
    userKey = decryptBytes(account.Key, stretchMasterKey(masterKey));
  } catch {
    throw new VaultwardenAuthError("Vaultwarden master password is incorrect");
  }
  const keys = organizationKeys(sync, symmetricKey(userKey));
  return {
    credentials: {
      baseUrl: endpoint.baseUrl,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      userKey: userKey.toString("base64"),
    },
    email,
    collections: decryptCollections(sync, keys),
  };
}

/** One access token per client, reused until shortly before expiry and shared by concurrent callers. */
export function createVaultwardenClient(
  credentials: VaultwardenCredentials,
  transport: VaultwardenTransport,
): VaultwardenClient {
  const endpoint: Endpoint = {
    baseUrl: parseBaseUrl(credentials.baseUrl, transport.allowPrivateEndpoint),
    fetch: transport.fetch,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  };
  const now = transport.now ?? Date.now;
  const userKey = symmetricKey(Buffer.from(credentials.userKey, "base64"));
  let token: Token | undefined;
  let pending: Promise<Token> | undefined;

  const accessToken = (signal: AbortSignal | undefined): Promise<Token> => {
    if (token && token.expires - TOKEN_REFRESH_MARGIN_MS > now()) return Promise.resolve(token);
    if (!pending) {
      const login = requestToken(endpoint, undefined).then((raw) => {
        const parsed = parse(tokenSchema, raw);
        token = { value: parsed.access_token, expires: now() + parsed.expires_in * 1000 };
        return token;
      });
      pending = login;
      login
        .finally(() => {
          if (pending === login) pending = undefined;
        })
        .catch(() => {});
    }
    return signal ? withAbort(pending, signal) : pending;
  };

  const sync = async (signal: AbortSignal | undefined): Promise<Sync> => {
    const current = await accessToken(signal);
    try {
      return await requestSync(endpoint, current.value, signal);
    } catch (error) {
      if (!(error instanceof TokenExpiredError)) throw error;
      if (token === current) token = undefined;
      return await requestSync(endpoint, (await accessToken(signal)).value, signal).catch(
        (retry) => {
          throw retry instanceof TokenExpiredError ? new VaultwardenAuthError() : retry;
        },
      );
    }
  };

  const read = async ({ collectionIds, signal }: VaultwardenScope, cipherId?: string) => {
    const data = await sync(signal);
    const keys = organizationKeys(data, userKey);
    const scope = new Set(collectionIds);
    return data.ciphers.flatMap((raw) => decryptLogin(raw, keys, scope, cipherId) ?? []);
  };

  return {
    collections: async (signal) => {
      const data = await sync(signal);
      return decryptCollections(data, organizationKeys(data, userKey));
    },
    logins: (scope) => read(scope),
    login: async ({ cipherId, ...scope }) => (await read(scope, cipherId))[0],
  };
}
