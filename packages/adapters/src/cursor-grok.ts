import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { AgentImportErrorReason, AgentImportFile, CursorStatus } from "@rakazo/contracts";
import { AgentImportFilesSchema, GrokRecipeSchema } from "@rakazo/contracts";
import { grokBotFiles, grokBotFromRecipe, grokShareUrl } from "@rakazo/core";
import type { CursorSession, PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import { INFISICAL_REF_PREFIX } from "./infisical-secret-store.js";
import { isUniqueViolation } from "./run-messages.js";
import { deleteSecretBestEffort } from "./secret-store-factory.js";
import type { SafeWebFetchOptions } from "./web-ssrf.js";
import { fetchSafeHttpRequest } from "./web-ssrf.js";

/*
 * "Sign in with Cursor", which reads a Grok Bot template's whole recipe. The person signs in to
 * their own Cursor account in their browser with the PKCE flow Cursor's CLI uses. The requests
 * follow pi-grokbot-import (MIT, Shixuuu, https://github.com/Shixuuu/pi-grokbot-import) and the
 * flow follows OpenMausBot (Apache-2.0, milind-soni, https://github.com/milind-soni/OpenMausBot).
 * The tokens are stored encrypted and sent only to api2.cursor.sh.
 */

const CURSOR_API = "https://api2.cursor.sh";
const CURSOR_LOGIN_PAGE = "https://cursor.com/loginDeepControl";
/** The public client id Cursor's own CLI signs in and refreshes with. */
const CURSOR_CLI_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const IMPORT_DETAILS_PATH = "/aiserver.v1.GrokBotService/GetGrokBotTemplateImportDetails";
/** Cursor's answer signs a link to a recipe in one of these: official and community templates. */
const RECIPE_HOSTS = new Set([
  "grok-bot-marketplace-public-assets.s3.us-east-1.amazonaws.com",
  "grok-bot-templates.s3.us-east-1.amazonaws.com",
]);
const SIGN_IN_WINDOW_MS = 10 * 60_000;
const TIMEOUT_MS = 20_000;
/** The claim's write, the refresh and the new tokens' write, each bounded by TIMEOUT_MS. */
const REFRESH_CLAIM_MS = 3 * TIMEOUT_MS;
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

export interface CursorDeps {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "put" | "load" | "delete">;
  /** Offline seam for Cursor and its recipe storage. */
  egress?: Pick<SafeWebFetchOptions, "fetch" | "resolveHostname">;
}

type Actor = { userId: string; spaceId: string };
type Session = { row: CursorSession; tokens: Tokens };

const Tokens = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().nullable(),
  /** Set while one request refreshes them; others neither refresh nor sign out meanwhile. */
  refreshingUntil: z.number().optional(),
});
type Tokens = z.infer<typeof Tokens>;
const PendingSignIn = z.object({
  userId: z.string(),
  uuid: z.string(),
  verifier: z.string(),
  expiresAt: z.number(),
});
const ImportDetails = z.object({
  template: z.object({ name: z.string().default("") }),
  blobGetUrl: z.string(),
  /** Community templates only. */
  creatorDisplayName: z.string().nullish(),
});

export type GrokImportRefusal = Extract<
  AgentImportErrorReason,
  "grok_not_found" | "grok_unavailable" | "cursor_signed_out" | "cursor_needs_grok_bot"
>;

/** Why a template could not be read; clients show their own copy for each reason. */
export class GrokImportError extends Error {
  constructor(readonly reason: GrokImportRefusal) {
    super(reason);
    this.name = "GrokImportError";
  }
}

const SIGNED_OUT: CursorStatus = { status: "signed_out" };
const PENDING: CursorStatus = { status: "pending" };
const SIGNED_IN: CursorStatus = { status: "signed_in" };

const sessionRecord = (userId: string) => `cursor-session:${userId}`;
const signInRecord = (userId: string) => `cursor-sign-in:${userId}`;

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Error names only: a failed request can quote its URL, which may carry the PKCE verifier. */
function warn(message: string, error: unknown): void {
  getLogger().warn(`${message}: ${error instanceof Error ? error.name : typeof error}`);
}

function secretContext(actor: Actor, operation: string): AdapterContext {
  return {
    operationId: `cursor-session.${operation}`,
    traceId: `cursor-session.${operation}`,
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
}

/** One request to api2.cursor.sh. A redirect comes back as an answer and is never followed. */
async function cursorRequest(
  deps: Pick<CursorDeps, "egress">,
  path: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
): Promise<{ status: number; body: unknown }> {
  const response = await fetchSafeHttpRequest(`${CURSOR_API}${path}`, init, {
    ...deps.egress,
    timeoutMs: TIMEOUT_MS,
    maxBytes: MAX_ANSWER_BYTES,
    allowedPorts: [443],
  });
  if (response.truncated) throw new GrokImportError("grok_unavailable");
  return { status: response.status, body: parseJson(new TextDecoder().decode(response.body)) };
}

/** Cursor answers with camelCase, OAuth with snake_case; a refresh may keep the refresh token. */
function tokensFrom(body: unknown, previousRefresh: string | null = null): Tokens | null {
  const fields = z
    .object({
      accessToken: z.string().nullish(),
      access_token: z.string().nullish(),
      refreshToken: z.string().nullish(),
      refresh_token: z.string().nullish(),
    })
    .safeParse(body);
  if (!fields.success) return null;
  const { accessToken, access_token, refreshToken, refresh_token } = fields.data;
  const access = accessToken || access_token;
  return access
    ? { accessToken: access, refreshToken: refreshToken || refresh_token || previousRefresh }
    : null;
}

/**
 * Starts a sign-in the person approves in their browser. Nothing is stored: the client holds
 * the sealed `pending` handle, which any API instance can open, and polls with it.
 */
export async function startCursorSignIn(
  deps: Pick<CursorDeps, "secretStore">,
  actor: Actor,
): Promise<{ url: string; pending: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const uuid = randomUUID();
  const sealed = await deps.secretStore.put(
    JSON.stringify({
      userId: actor.userId,
      uuid,
      verifier,
      expiresAt: Date.now() + SIGN_IN_WINDOW_MS,
    }),
    secretContext(actor, "sign-in"),
    { recordId: signInRecord(actor.userId), ephemeral: true },
  );
  const query = new URLSearchParams({ challenge, uuid, mode: "login", redirectTarget: "cli" });
  return { url: `${CURSOR_LOGIN_PAGE}?${query}`, pending: sealed.ciphertext };
}

/** This user's unexpired sign-in, or null for anything else a client sends. */
async function openSignIn(deps: Pick<CursorDeps, "secretStore">, actor: Actor, pending: string) {
  // Sealed locally, so never a reference the remote store would look up.
  if (pending.startsWith(INFISICAL_REF_PREFIX)) return null;
  try {
    const plaintext = await deps.secretStore.load(pending, {
      recordId: signInRecord(actor.userId),
    });
    const parsed = PendingSignIn.safeParse(parseJson(plaintext));
    return parsed.success &&
      parsed.data.userId === actor.userId &&
      parsed.data.expiresAt > Date.now()
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}

/**
 * Asks Cursor once whether the person approved (`GET /auth/poll`, 404 until then) and keeps
 * the tokens it gives. A busy or failing Cursor is asked again on the next call.
 */
export async function pollCursorSignIn(
  deps: CursorDeps,
  actor: Actor,
  pending: string,
): Promise<CursorStatus> {
  const signIn = await openSignIn(deps, actor, pending);
  if (!signIn) return SIGNED_OUT;
  let answer: { status: number; body: unknown };
  try {
    const query = new URLSearchParams({ uuid: signIn.uuid, verifier: signIn.verifier });
    answer = await cursorRequest(deps, `/auth/poll?${query}`, {
      method: "GET",
      headers: { "x-cursor-client-type": "cli" },
    });
  } catch (error) {
    warn("Cursor sign-in check failed", error);
    return PENDING;
  }
  if (answer.status === 404 || answer.status === 429 || answer.status >= 500) return PENDING;
  const tokens = answer.status >= 200 && answer.status < 300 ? tokensFrom(answer.body) : null;
  if (!tokens) {
    getLogger().warn(`Cursor refused a sign-in: HTTP ${answer.status}`);
    return SIGNED_OUT;
  }
  const row = await deps.prisma.cursorSession.findUnique({ where: { userId: actor.userId } });
  await swap(deps, actor, row, tokens);
  return SIGNED_IN;
}

export async function cursorStatus(deps: CursorDeps, actor: Actor): Promise<CursorStatus> {
  const row = await deps.prisma.cursorSession.findUnique({ where: { userId: actor.userId } });
  return row ? SIGNED_IN : SIGNED_OUT;
}

export async function signOutCursor(deps: CursorDeps, actor: Actor): Promise<CursorStatus> {
  for (
    let row = await deps.prisma.cursorSession.findUnique({ where: { userId: actor.userId } });
    row;
    row = await deps.prisma.cursorSession.findUnique({ where: { userId: actor.userId } })
  ) {
    await forget(deps, row);
  }
  return SIGNED_OUT;
}

const dropSecret = (deps: CursorDeps, userId: string, ciphertext: string) =>
  deleteSecretBestEffort(deps.secretStore, ciphertext, sessionRecord(userId));

/**
 * Writes the tokens only over the row as it was read, so a sign-in or refresh that landed
 * meanwhile is never overwritten (a refresh token can be single-use). The new ciphertext, or
 * null when the other write won.
 */
async function swap(
  deps: CursorDeps,
  actor: Actor,
  row: Pick<CursorSession, "id" | "ciphertext"> | null,
  tokens: Tokens,
): Promise<string | null> {
  const stored = await deps.secretStore.put(
    JSON.stringify(tokens),
    secretContext(actor, "persist"),
    { recordId: sessionRecord(actor.userId) },
  );
  const written = row
    ? (
        await deps.prisma.cursorSession.updateMany({
          where: { id: row.id, ciphertext: row.ciphertext },
          data: { ciphertext: stored.ciphertext },
        })
      ).count === 1
    : await deps.prisma.cursorSession
        .create({ data: { userId: actor.userId, ciphertext: stored.ciphertext } })
        .then(
          () => true,
          (error: unknown) => {
            if (isUniqueViolation(error)) return false;
            throw error;
          },
        );
  if (!written) {
    await dropSecret(deps, actor.userId, stored.ciphertext);
    return null;
  }
  if (row) await dropSecret(deps, actor.userId, row.ciphertext);
  return stored.ciphertext;
}

/** Deletes the row only while it still holds the same tokens, so a newer sign-in survives. */
async function forget(
  deps: CursorDeps,
  row: Pick<CursorSession, "id" | "userId" | "ciphertext">,
): Promise<void> {
  const { count } = await deps.prisma.cursorSession.deleteMany({
    where: { id: row.id, ciphertext: row.ciphertext },
  });
  if (count) await dropSecret(deps, row.userId, row.ciphertext);
}

/** Null when signed out; tokens that no longer open are forgotten. A store outage throws. */
async function currentSession(deps: CursorDeps, userId: string): Promise<Session | null> {
  const row = await deps.prisma.cursorSession.findUnique({ where: { userId } });
  if (!row) return null;
  try {
    const tokens = Tokens.safeParse(
      parseJson(await deps.secretStore.load(row.ciphertext, { recordId: sessionRecord(userId) })),
    );
    if (tokens.success) return { row, tokens: tokens.data };
  } catch (error) {
    if (error instanceof SecretStoreUnavailableError) throw error;
  }
  await forget(deps, row);
  return null;
}

const refreshing = (tokens: Tokens) => (tokens.refreshingUntil ?? 0) > Date.now();

/**
 * One refresh with the refresh token from sign-in, as Cursor's CLI does. It is claimed in the
 * stored tokens first: a refresh token another request spent reads as refused, and signing out
 * then would drop the tokens that request is about to store. Null, and signed out, when Cursor
 * refuses it; a refresh that could not be asked keeps the sign-in.
 */
async function renew(deps: CursorDeps, actor: Actor, session: Session): Promise<Session | null> {
  if (refreshing(session.tokens)) throw new GrokImportError("grok_unavailable");
  const refreshToken = session.tokens.refreshToken;
  if (!refreshToken) {
    await forget(deps, session.row);
    return null;
  }
  const claim = await swap(deps, actor, session.row, {
    ...session.tokens,
    refreshingUntil: Date.now() + REFRESH_CLAIM_MS,
  });
  if (!claim) {
    // Written since this request read it: newer tokens, or another request's claim.
    const current = await currentSession(deps, actor.userId);
    if (current && refreshing(current.tokens)) throw new GrokImportError("grok_unavailable");
    return current;
  }
  const claimed = { ...session.row, ciphertext: claim };
  let answer: { status: number; body: unknown };
  try {
    answer = await cursorRequest(deps, "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cursor-client-type": "cli" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CURSOR_CLI_CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });
  } catch (error) {
    warn("Cursor token refresh failed", error);
    throw new GrokImportError("grok_unavailable");
  }
  if (answer.status === 429 || answer.status >= 500) {
    throw new GrokImportError("grok_unavailable");
  }
  const tokens =
    answer.status >= 200 && answer.status < 300 ? tokensFrom(answer.body, refreshToken) : null;
  if (!tokens) {
    await forget(deps, claimed);
    return null;
  }
  const written = await swap(deps, actor, claimed, tokens);
  // When another write won, these tokens still answer the request in hand.
  return { row: written ? { ...claimed, ciphertext: written } : claimed, tokens };
}

type DetailsAnswer =
  | { kind: "ok"; details: unknown }
  | { kind: "needs_plan" | "unauthenticated" | "not_found" | "failed" };

/** Cursor's answer to GetGrokBotTemplateImportDetails, sorted once. */
function sortDetails(answer: { status: number; body: unknown }): DetailsAnswer {
  const fields = z
    .object({ code: z.string().optional(), message: z.string().optional() })
    .safeParse(answer.body);
  const { code = "", message = "" } = fields.success ? fields.data : {};
  const text = JSON.stringify(answer.body) ?? "";
  if (answer.status === 401 || code === "unauthenticated" || text.includes("ERROR_NOT_LOGGED_IN")) {
    return { kind: "unauthenticated" };
  }
  // Signed in, but the account has no Grok Bot: signing in again would not help.
  if (/requires an ultra|premium .*seat/i.test(message) || text.includes("ERROR_UNAUTHORIZED")) {
    return { kind: "needs_plan" };
  }
  if (answer.status === 404 || code === "not_found") return { kind: "not_found" };
  if (answer.status < 200 || answer.status >= 300) return { kind: "failed" };
  return { kind: "ok", details: answer.body };
}

/** Why the import stops when the sign-in itself still holds. */
const REFUSED = {
  needs_plan: "cursor_needs_grok_bot",
  not_found: "grok_not_found",
  failed: "grok_unavailable",
} as const satisfies Record<string, GrokImportRefusal>;

async function askDetails(
  deps: CursorDeps,
  accessToken: string,
  shareId: string,
): Promise<DetailsAnswer> {
  try {
    return sortDetails(
      await cursorRequest(deps, IMPORT_DETAILS_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "connect-protocol-version": "1",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ shareId }),
      }),
    );
  } catch (error) {
    warn("Cursor could not be reached", error);
    return { kind: "failed" };
  }
}

/** The signed recipe link, fetched without the token and only from Cursor's buckets. */
async function downloadRecipe(deps: CursorDeps, address: string): Promise<unknown> {
  const url = URL.parse(address);
  if (
    url?.protocol !== "https:" ||
    !RECIPE_HOSTS.has(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new GrokImportError("grok_unavailable");
  }
  try {
    const response = await fetchSafeHttpRequest(
      url.href,
      { method: "GET" },
      { ...deps.egress, timeoutMs: TIMEOUT_MS, maxBytes: MAX_ANSWER_BYTES, allowedPorts: [443] },
    );
    if (response.status !== 200 || response.truncated) {
      throw new GrokImportError("grok_unavailable");
    }
    return parseJson(new TextDecoder().decode(response.body));
  } catch (error) {
    if (error instanceof GrokImportError) throw error;
    warn("Grok Bot recipe download failed", error);
    throw new GrokImportError("grok_unavailable");
  }
}

/**
 * A template's whole setup, read with the user's Cursor sign-in, as import files. An access
 * token Cursor refuses is refreshed once; refused again, the sign-in is forgotten.
 */
export async function fetchGrokTemplate(
  deps: CursorDeps,
  actor: Actor,
  shareId: string,
): Promise<AgentImportFile[]> {
  const session = await currentSession(deps, actor.userId);
  if (!session) throw new GrokImportError("cursor_signed_out");
  let answer = await askDetails(deps, session.tokens.accessToken, shareId);
  if (answer.kind === "unauthenticated") {
    const renewed = await renew(deps, actor, session);
    if (!renewed) throw new GrokImportError("cursor_signed_out");
    answer = await askDetails(deps, renewed.tokens.accessToken, shareId);
    if (answer.kind === "unauthenticated") {
      await forget(deps, renewed.row);
      throw new GrokImportError("cursor_signed_out");
    }
  }
  if (answer.kind !== "ok") {
    getLogger().warn(`Cursor did not share a Grok Bot template: ${answer.kind}`);
    throw new GrokImportError(REFUSED[answer.kind]);
  }
  const details = ImportDetails.safeParse(answer.details);
  if (!details.success) throw new GrokImportError("grok_unavailable");
  const recipe = GrokRecipeSchema.safeParse(await downloadRecipe(deps, details.data.blobGetUrl));
  if (!recipe.success) throw new GrokImportError("grok_unavailable");
  const files = grokBotFiles(
    grokBotFromRecipe(recipe.data, {
      url: grokShareUrl(shareId),
      name: details.data.template.name,
      creator: details.data.creatorDisplayName?.trim() || null,
    }),
  );
  // A template too large to import as a whole is refused rather than cut short.
  if (!AgentImportFilesSchema.safeParse(files).success) {
    throw new GrokImportError("grok_unavailable");
  }
  return files;
}
