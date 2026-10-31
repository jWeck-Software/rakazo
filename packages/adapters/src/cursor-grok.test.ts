import { createHash } from "node:crypto";
import type { AgentImportFile } from "@rakazo/contracts";
import { parseAgentImport } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CursorDeps } from "./cursor-grok.js";
import {
  cursorStatus,
  fetchGrokTemplate,
  GrokImportError,
  pollCursorSignIn,
  signOutCursor,
  startCursorSignIn,
} from "./cursor-grok.js";
import { INFISICAL_REF_PREFIX } from "./infisical-secret-store.js";
import { EncryptedSecretStore } from "./secrets.js";

const SHARE_ID = "AAAAAAAAAAAAAAAAAAAA1";
const BUCKET = "grok-bot-templates.s3.us-east-1.amazonaws.com";
const OFFICIAL_BUCKET = "grok-bot-marketplace-public-assets.s3.us-east-1.amazonaws.com";
const BLOB_URL = `https://${BUCKET}/templates/${SHARE_ID}_v1.json?X-Amz-Signature=example`;
const RECIPE = JSON.stringify({
  profile: { name: "Harbor Desk", title: "", description: "Plans dock slots." },
  memory: [{ kind: "profile", content: "Be brief." }],
});
const ALICE = { userId: "user-alice", spaceId: "space-alice" };
const BOB = { userId: "user-bob", spaceId: "space-bob" };

type Row = { id: string; userId: string; ciphertext: string };
type Sent = {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
  redirect: RequestRedirect | undefined;
};
type Answer = (request: Sent) => Response | Promise<Response>;

/** Like Prisma, every read returns its own copy of the row. */
function fakePrisma() {
  let rows: Row[] = [];
  let next = 0;
  const matches = (row: Row, where: Partial<Row>) =>
    Object.entries(where).every(([key, value]) => row[key as keyof Row] === value);
  const cursorSession = {
    findUnique: async ({ where }: { where: Partial<Row> }) => {
      const row = rows.find((candidate) => matches(candidate, where));
      return row ? { ...row } : null;
    },
    create: async ({ data }: { data: Omit<Row, "id"> }) => {
      if (rows.some((row) => row.userId === data.userId)) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      const row = { id: `session-${++next}`, ...data };
      rows.push(row);
      return { ...row };
    },
    updateMany: async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
      let count = 0;
      rows = rows.map((row) => {
        if (!matches(row, where)) return row;
        count += 1;
        return { ...row, ...data };
      });
      return { count };
    },
    deleteMany: async ({ where }: { where: Partial<Row> }) => {
      const before = rows.length;
      rows = rows.filter((row) => !matches(row, where));
      return { count: before - rows.length };
    },
  };
  return { prisma: { cursorSession } as unknown as PrismaClient, rows: () => rows };
}

/** Cursor, its buckets and DNS, offline. Any request the answer does not expect fails loudly. */
function setup() {
  const db = fakePrisma();
  const sent: Sent[] = [];
  let answer: Answer = (request) => {
    throw new Error(`Unexpected request to ${request.url.href}`);
  };
  const deps: CursorDeps = {
    prisma: db.prisma,
    secretStore: new EncryptedSecretStore("test-encryption-key-test-encryption-key"),
    egress: {
      resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const request: Sent = {
          method: init?.method ?? "GET",
          url: new URL(String(input)),
          headers: new Headers(init?.headers),
          body: typeof init?.body === "string" ? init.body : "",
          redirect: init?.redirect,
        };
        sent.push(request);
        return answer(request);
      }) as typeof globalThis.fetch,
    },
  };
  return {
    deps,
    db,
    sent,
    answer: (next: Answer) => {
      answer = next;
    },
    /** Method, host and path of each request since the last call. */
    requests: () =>
      sent
        .splice(0)
        .map((request) => `${request.method} ${request.url.host}${request.url.pathname}`),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const DETAILS = "POST api2.cursor.sh/aiserver.v1.GrokBotService/GetGrokBotTemplateImportDetails";
const REFRESH = "POST api2.cursor.sh/oauth/token";
const DOWNLOAD = `GET ${BUCKET}/templates/${SHARE_ID}_v1.json`;

async function signIn(
  env: ReturnType<typeof setup>,
  tokens: Record<string, string> = { accessToken: "access-1", refreshToken: "refresh-1" },
  actor = ALICE,
) {
  const { pending } = await startCursorSignIn(env.deps, actor);
  env.answer(() => json(tokens));
  expect(await pollCursorSignIn(env.deps, actor, pending)).toEqual({ status: "signed_in" });
  env.requests();
}

/** Cursor that accepts only `valid` access tokens and answers a refresh with `refresh`. */
function cursor(
  env: ReturnType<typeof setup>,
  options: {
    valid?: readonly string[];
    refresh?: Answer;
    details?: Record<string, unknown>;
    recipe?: Answer;
  } = {},
) {
  const valid = options.valid ?? ["access-1"];
  env.answer((request) => {
    if (request.url.host === "api2.cursor.sh" && request.url.pathname === "/oauth/token") {
      if (!options.refresh) throw new Error("Unexpected refresh");
      return options.refresh(request);
    }
    if (request.url.host === "api2.cursor.sh") {
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      return valid.includes(token)
        ? json({ template: { name: "Harbor Desk" }, blobGetUrl: BLOB_URL, ...options.details })
        : json({ code: "unauthenticated", message: "ERROR_NOT_LOGGED_IN" }, 401);
    }
    if (request.url.host === BUCKET || request.url.host === OFFICIAL_BUCKET) {
      return options.recipe ? options.recipe(request) : new Response(RECIPE);
    }
    throw new Error(`Unexpected request to ${request.url.href}`);
  });
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "imported",
    (error: unknown) => {
      if (error instanceof GrokImportError) return error.reason;
      throw error;
    },
  );

const credit = (files: AgentImportFile[]) => {
  const plan = parseAgentImport(files);
  if ("error" in plan) throw new Error(plan.error);
  return plan.instructions[0]?.content.trim().split("\n").at(-1);
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Cursor sign-in", () => {
  it("opens Cursor's login page with a PKCE challenge only the poll can answer", async () => {
    const env = setup();
    const { url, pending } = await startCursorSignIn(env.deps, ALICE);
    expect(env.sent).toEqual([]);
    const page = new URL(url);
    expect(`${page.origin}${page.pathname}`).toBe("https://cursor.com/loginDeepControl");
    expect(page.searchParams.get("mode")).toBe("login");
    expect(page.searchParams.get("redirectTarget")).toBe("cli");

    env.answer(() => json({}, 404));
    expect(await pollCursorSignIn(env.deps, ALICE, pending)).toEqual({ status: "pending" });
    const [poll] = env.sent;
    expect(`${poll?.method} ${poll?.url.origin}${poll?.url.pathname}`).toBe(
      "GET https://api2.cursor.sh/auth/poll",
    );
    const verifier = poll!.url.searchParams.get("verifier")!;
    expect(poll!.url.searchParams.get("uuid")).toBe(page.searchParams.get("uuid"));
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      page.searchParams.get("challenge"),
    );
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(url).not.toContain(verifier);
    expect(pending).not.toContain(verifier);
  });

  it("stays pending until Cursor approves, also while Cursor is busy or unreachable", async () => {
    const env = setup();
    const { pending } = await startCursorSignIn(env.deps, ALICE);
    for (const answer of [
      () => json({}, 404),
      () => json({}, 429),
      () => json({}, 503),
      () => {
        throw new TypeError("fetch failed");
      },
    ]) {
      env.answer(answer);
      expect(await pollCursorSignIn(env.deps, ALICE, pending)).toEqual({ status: "pending" });
    }
    expect(await cursorStatus(env.deps, ALICE)).toEqual({ status: "signed_out" });
    expect(env.db.rows()).toEqual([]);
  });

  it("signs in once Cursor approves, storing the tokens only encrypted", async () => {
    const env = setup();
    const { pending } = await startCursorSignIn(env.deps, ALICE);
    env.answer(() => json({ accessToken: "access-secret-1", refreshToken: "refresh-secret-1" }));
    const status = await pollCursorSignIn(env.deps, ALICE, pending);
    expect(status).toEqual({ status: "signed_in" });
    expect(await cursorStatus(env.deps, ALICE)).toEqual({ status: "signed_in" });
    expect(await cursorStatus(env.deps, BOB)).toEqual({ status: "signed_out" });
    expect(env.db.rows()).toHaveLength(1);
    expect(env.db.rows()[0]?.userId).toBe(ALICE.userId);
    const stored = JSON.stringify(env.db.rows());
    expect(stored).not.toContain("access-secret-1");
    expect(stored).not.toContain("refresh-secret-1");

    expect(await pollCursorSignIn(env.deps, ALICE, pending)).toEqual({ status: "signed_in" });
    expect(env.db.rows()).toHaveLength(1);
  });

  it("stays signed out when Cursor refuses the sign-in or sends no token", async () => {
    const env = setup();
    const { pending } = await startCursorSignIn(env.deps, ALICE);
    for (const answer of [
      () => json({ error: "invalid" }, 400),
      () => json({ refreshToken: "r" }),
    ]) {
      env.answer(answer);
      expect(await pollCursorSignIn(env.deps, ALICE, pending)).toEqual({ status: "signed_out" });
    }
    expect(env.db.rows()).toEqual([]);
  });

  it("refuses a handle that is not this user's unexpired sign-in, without asking Cursor", async () => {
    const env = setup();
    env.answer(() => json({ accessToken: "access-1", refreshToken: "refresh-1" }));
    const { pending } = await startCursorSignIn(env.deps, ALICE);
    const middle = Math.floor(pending.length / 2);
    const tampered = `${pending.slice(0, middle)}${pending[middle] === "A" ? "B" : "A"}${pending.slice(middle + 1)}`;

    expect(await pollCursorSignIn(env.deps, BOB, pending)).toEqual({ status: "signed_out" });
    expect(await pollCursorSignIn(env.deps, ALICE, tampered)).toEqual({ status: "signed_out" });
    expect(await pollCursorSignIn(env.deps, ALICE, "not a handle")).toEqual({
      status: "signed_out",
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(await pollCursorSignIn(env.deps, ALICE, pending)).toEqual({ status: "signed_out" });
    expect(env.sent).toEqual([]);
    expect(env.db.rows()).toEqual([]);

    vi.useRealTimers();
    expect(await pollCursorSignIn(env.deps, ALICE, pending)).toEqual({ status: "signed_in" });
  });

  it("never looks a handle up in the remote secret store", async () => {
    const env = setup();
    const answers = JSON.stringify({
      userId: ALICE.userId,
      uuid: "00000000-0000-4000-8000-000000000000",
      verifier: "remote-verifier",
      expiresAt: Date.now() + 60_000,
    });
    const store = env.deps.secretStore;
    const deps: CursorDeps = {
      ...env.deps,
      secretStore: {
        put: (...args) => store.put(...args),
        delete: (...args) => store.delete(...args),
        load: async (ref, options) =>
          ref.startsWith(INFISICAL_REF_PREFIX) ? answers : store.load(ref, options),
      },
    };
    env.answer(() => json({ accessToken: "access-1", refreshToken: "refresh-1" }));
    expect(await pollCursorSignIn(deps, ALICE, `${INFISICAL_REF_PREFIX}example/ref`)).toEqual({
      status: "signed_out",
    });
    expect(env.sent).toEqual([]);
    expect(env.db.rows()).toEqual([]);
  });
});

describe("Cursor sign-out", () => {
  it("forgets the tokens, and a template read then asks the user to sign in", async () => {
    const env = setup();
    await signIn(env);
    await signIn(env, undefined, BOB);
    expect(await signOutCursor(env.deps, ALICE)).toEqual({ status: "signed_out" });
    expect(await cursorStatus(env.deps, ALICE)).toEqual({ status: "signed_out" });
    expect(await cursorStatus(env.deps, BOB)).toEqual({ status: "signed_in" });
    expect(await signOutCursor(env.deps, ALICE)).toEqual({ status: "signed_out" });

    cursor(env);
    expect(await refusal(fetchGrokTemplate(env.deps, ALICE, SHARE_ID))).toBe("cursor_signed_out");
    expect(env.requests()).toEqual([]);
  });

  it("holds while a refresh lands afterwards", async () => {
    const env = setup();
    await signIn(env);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refreshSeen!: () => void;
    const refreshing = new Promise<void>((resolve) => {
      refreshSeen = resolve;
    });
    cursor(env, {
      valid: ["access-2"],
      refresh: async () => {
        refreshSeen();
        await held;
        return json({ access_token: "access-2", refresh_token: "refresh-2" });
      },
    });
    const reading = refusal(fetchGrokTemplate(env.deps, ALICE, SHARE_ID));
    await refreshing;
    await signOutCursor(env.deps, ALICE);
    release();
    expect(await reading).toBe("imported");
    expect(await cursorStatus(env.deps, ALICE)).toEqual({ status: "signed_out" });
    expect(env.db.rows()).toEqual([]);
  });
});

describe("reading a Grok Bot template", () => {
  it("asks Cursor with the sign-in and downloads the recipe without it", async () => {
    const env = setup();
    await signIn(env);
    cursor(env, { details: { creatorDisplayName: "Sample Maker" } });
    const files = await fetchGrokTemplate(env.deps, ALICE, SHARE_ID);
    const [details, download] = env.sent;
    expect(env.requests()).toEqual([DETAILS, DOWNLOAD]);
    expect(details?.headers.get("authorization")).toBe("Bearer access-1");
    expect(JSON.parse(details!.body)).toEqual({ shareId: SHARE_ID });
    expect(download?.headers.has("authorization")).toBe(false);
    expect(download?.headers.has("cookie")).toBe(false);
    expect(download?.url.searchParams.get("X-Amz-Signature")).toBe("example");
    expect(credit(files)).toBe(
      `Based on the Grok Bot template [Harbor Desk](https://x.ai/bot/${SHARE_ID}) by Sample Maker.`,
    );
  });

  it("credits no one when Cursor names no creator", async () => {
    const env = setup();
    await signIn(env);
    for (const details of [{}, { creatorDisplayName: null }, { creatorDisplayName: "  " }]) {
      cursor(env, { details });
      expect(credit(await fetchGrokTemplate(env.deps, ALICE, SHARE_ID))).toBe(
        `Based on the Grok Bot template [Harbor Desk](https://x.ai/bot/${SHARE_ID}).`,
      );
    }
  });

  it("asks a signed-out user to sign in without asking Cursor", async () => {
    const env = setup();
    cursor(env);
    expect(await refusal(fetchGrokTemplate(env.deps, ALICE, SHARE_ID))).toBe("cursor_signed_out");
    expect(env.sent).toEqual([]);
  });

  it("refreshes a refused access token once and keeps the new tokens", async () => {
    const env = setup();
    await signIn(env);
    cursor(env, {
      valid: ["access-2"],
      refresh: () => json({ access_token: "access-2", refresh_token: "refresh-2" }),
    });
    await fetchGrokTemplate(env.deps, ALICE, SHARE_ID);
    const refresh = env.sent[1];
    expect(env.requests()).toEqual([DETAILS, REFRESH, DETAILS, DOWNLOAD]);
    expect(JSON.parse(refresh!.body)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
    });
    expect(refresh?.headers.has("authorization")).toBe(false);
    expect(JSON.stringify(env.db.rows())).not.toContain("access-2");

    await fetchGrokTemplate(env.deps, ALICE, SHARE_ID);
    expect(env.sent[0]?.headers.get("authorization")).toBe("Bearer access-2");
    expect(env.requests()).toEqual([DETAILS, DOWNLOAD]);
  });

  it("keeps the refresh token when Cursor's refresh answer leaves it out", async () => {
    const env = setup();
    await signIn(env);
    cursor(env, { valid: ["access-2"], refresh: () => json({ access_token: "access-2" }) });
    await fetchGrokTemplate(env.deps, ALICE, SHARE_ID);
    env.requests();
    cursor(env, { valid: ["access-3"], refresh: () => json({ access_token: "access-3" }) });
    await fetchGrokTemplate(env.deps, ALICE, SHARE_ID);
    expect(JSON.parse(env.sent[1]!.body)).toMatchObject({ refresh_token: "refresh-1" });
  });

  it("signs out when Cursor refuses the refresh or the refreshed token", async () => {
    for (const refresh of [
      () => json({ error: "invalid_grant" }, 400),
      () => json({ access_token: "" }),
    ]) {
      const env = setup();
      await signIn(env);
      cursor(env, { valid: ["access-2"], refresh });
      expect(await refusal(fetchGrokTemplate(env.deps, ALICE, SHARE_ID))).toBe("cursor_signed_out");
      expect(env.requests()).toEqual([DETAILS, REFRESH]);
      expect(await cursorStatus(env.deps, ALICE)).toEqual({ status: "signed_out" });
    }

    const env = setup();
    await signIn(env);
    env.answer((request) =>
      request.url.pathname === "/oauth/token"
        ? json({ access_token: "access-2" })
        : json({ code: "unauthenticated", message: "ERROR_UNAUTHORIZED" }, 401),
    );
    expect(await refusal(fetchGrokTemplate(env.deps, ALICE, SHARE_ID))).toBe("cursor_signed_out");
    expect(env.requests()).toEqual([DETAILS, REFRESH, DETAILS]);
    expect(await cursorStatus(env.deps, ALICE)).toEqual({ status: "signed_out" });
  });

  it("signs out a refused sign-in that has no refresh token", async () => {
    const env = setup();
    await signIn(env, { accessToken: "access-1" });
    cursor(env, { valid: [] });
    expect(await refusal(fetchGrokTemplate(env.deps, ALICE, SHARE_ID))).toBe("cursor_signed_out");
    expect(env.requests()).toEqual([DETAILS]);
    expect(await cursorStatus(env.deps, ALICE)).toEqual({ status: "signed_out" });
  });

  it("keeps the sign-in when the refresh cannot be asked", async () => {
    for (const refresh of [
      () => json({}, 503),
      () => json({}, 429),
      () => {
        throw new TypeError("fetch failed");
      },
    ]) {
      const env = setup();
      await signIn(env);
      cursor(env, { valid: ["access-2"], refresh });
      expect(await refusal(fetchGrokTemplate(env.deps, ALICE, SHARE_ID))).toBe("grok_unavailable");
      expect(await cursorStatus(env.deps, ALICE)).toEqual({ status: "signed_in" });
    }
  });

  it("keeps the sign-in when Cursor refuses for any other reason", async () => {
    const cases = [
      [
        403,
        { code: "permission_denied", message: "This requires an Ultra plan" },
        "cursor_needs_grok_bot",
      ],
      [
        403,
        { code: "permission_denied", details: [{ debug: "ERROR_UNAUTHORIZED" }] },
        "cursor_needs_grok_bot",
      ],
      [404, { code: "not_found" }, "grok_not_found"],
      [400, { code: "invalid_argument" }, "grok_unavailable"],
      [500, {}, "grok_unavailable"],
      [302, {}, "grok_unavailable"],
    ] as const;
    for (const [status, body, reason] of cases) {
      const env = setup();
      await signIn(env);
      env.answer(() => json(body, status));
      expect(await refusal(fetchGrokTemplate(env.deps, ALICE, SHARE_ID)), `${status}`).toBe(reason);
      expect(env.requests()).toEqual([DETAILS]);
      expect(await cursorStatus(env.deps, ALICE)).toEqual({ status: "signed_in" });
    }
  });

  it("refuses an answer or recipe it cannot read", async () => {
    const env = setup();
    await signIn(env);
    env.answer(() => new Response("<html>", { status: 200 }));
    expect(await refusal(fetchGrokTemplate(env.deps, ALICE, SHARE_ID))).toBe("grok_unavailable");
    env.answer(() => json({ template: { name: "Harbor Desk" } }));
    expect(await refusal(fetchGrokTemplate(env.deps, ALICE, SHARE_ID))).toBe("grok_unavailable");
    for (const recipe of [
      () => new Response("<xml/>"),
      () => new Response(JSON.stringify({ skills: "none" })),
      () => new Response(RECIPE, { status: 403 }),
    ]) {
      cursor(env, { recipe });
      expect(await refusal(fetchGrokTemplate(env.deps, ALICE, SHARE_ID))).toBe("grok_unavailable");
    }
    expect(await cursorStatus(env.deps, ALICE)).toEqual({ status: "signed_in" });
  });
});

describe("two template reads that both find the access token refused", () => {
  function heldRefresh(env: ReturnType<typeof setup>) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refreshSeen!: () => void;
    const seen = new Promise<void>((resolve) => {
      refreshSeen = resolve;
    });
    const refreshes: string[] = [];
    cursor(env, {
      valid: ["access-2"],
      refresh: async (request) => {
        const token = JSON.parse(request.body).refresh_token as string;
        refreshes.push(token);
        // Cursor's refresh tokens are single-use.
        if (refreshes.length > 1 || token !== "refresh-1") {
          return json({ error: "invalid_grant" }, 400);
        }
        refreshSeen();
        await held;
        return json({ access_token: "access-2", refresh_token: "refresh-2" });
      },
    });
    return { release, seen, refreshes };
  }

  it("refresh once and keep the user signed in when the second arrives mid-refresh", async () => {
    const env = setup();
    await signIn(env);
    const refresh = heldRefresh(env);
    const first = refusal(fetchGrokTemplate(env.deps, ALICE, SHARE_ID));
    await refresh.seen;
    const second = await refusal(fetchGrokTemplate(env.deps, ALICE, SHARE_ID));
    refresh.release();
    expect({ first: await first, second }).toEqual({
      first: "imported",
      second: "grok_unavailable",
    });
    expect(refresh.refreshes).toEqual(["refresh-1"]);
    expect(await cursorStatus(env.deps, ALICE)).toEqual({ status: "signed_in" });

    env.requests();
    expect(await refusal(fetchGrokTemplate(env.deps, ALICE, SHARE_ID))).toBe("imported");
    expect(env.sent[0]?.headers.get("authorization")).toBe("Bearer access-2");
    expect(env.requests()).toEqual([DETAILS, DOWNLOAD]);
  });

  it("refresh once and keep the user signed in when both start together", async () => {
    const env = setup();
    await signIn(env);
    const refresh = heldRefresh(env);
    const first = refusal(fetchGrokTemplate(env.deps, ALICE, SHARE_ID));
    const second = refusal(fetchGrokTemplate(env.deps, ALICE, SHARE_ID));
    await Promise.race([first, second]);
    refresh.release();
    expect([await first, await second].sort()).toEqual(["grok_unavailable", "imported"]);
    expect(refresh.refreshes).toEqual(["refresh-1"]);
    expect(await cursorStatus(env.deps, ALICE)).toEqual({ status: "signed_in" });
    env.requests();
    expect(await refusal(fetchGrokTemplate(env.deps, ALICE, SHARE_ID))).toBe("imported");
    expect(env.requests()).toEqual([DETAILS, DOWNLOAD]);
  });
});

describe("outbound requests", () => {
  it("download recipes only over https from Cursor's two buckets", async () => {
    const env = setup();
    await signIn(env);
    for (const blobGetUrl of [
      "https://evil.example.test/x",
      `http://${BUCKET}/x`,
      `https://${BUCKET}:8443/x`,
      `https://user:pw@${BUCKET}/x`,
      `https://${BUCKET}./x`,
      `https://${BUCKET}.example.test/x`,
      `//${BUCKET}/x`,
      "file:///etc/passwd",
      "not a url",
    ]) {
      cursor(env, { details: { blobGetUrl } });
      expect(await refusal(fetchGrokTemplate(env.deps, ALICE, SHARE_ID)), blobGetUrl).toBe(
        "grok_unavailable",
      );
      expect(env.requests(), blobGetUrl).toEqual([DETAILS]);
    }
    for (const blobGetUrl of [
      `https://${OFFICIAL_BUCKET}/x`,
      `https://${BUCKET.toUpperCase()}/x`,
      `https://${BUCKET}:443/x`,
    ]) {
      cursor(env, { details: { blobGetUrl } });
      expect(await refusal(fetchGrokTemplate(env.deps, ALICE, SHARE_ID)), blobGetUrl).toBe(
        "imported",
      );
      expect(env.requests()[1], blobGetUrl).toMatch(
        /^GET [^/]+\.s3\.us-east-1\.amazonaws\.com\/x$/,
      );
    }
  });

  it("never follow a redirect", async () => {
    const env = setup();
    await signIn(env);
    cursor(env, {
      recipe: () =>
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
    });
    expect(await refusal(fetchGrokTemplate(env.deps, ALICE, SHARE_ID))).toBe("grok_unavailable");
    expect(env.sent.every((request) => request.redirect === "manual")).toBe(true);
    expect(env.requests()).toEqual([DETAILS, DOWNLOAD]);

    const { pending } = await startCursorSignIn(env.deps, BOB);
    env.answer(
      () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example.test/" } }),
    );
    expect(await pollCursorSignIn(env.deps, BOB, pending)).toEqual({ status: "signed_out" });
    expect(env.sent.every((request) => request.redirect === "manual")).toBe(true);
    expect(env.requests()).toEqual(["GET api2.cursor.sh/auth/poll"]);
  });

  it("refuse an answer or recipe over 4 MiB", async () => {
    const env = setup();
    await signIn(env);
    const limit = 4 * 1024 * 1024;
    const details = JSON.stringify({ template: { name: "Harbor Desk" }, blobGetUrl: BLOB_URL });
    const read = (detailsBytes: number, recipeBytes: number) => {
      env.answer((request) =>
        request.url.host === "api2.cursor.sh"
          ? new Response(details.padEnd(detailsBytes))
          : new Response(RECIPE.padEnd(recipeBytes)),
      );
      return refusal(fetchGrokTemplate(env.deps, ALICE, SHARE_ID));
    };
    expect(await read(limit, limit)).toBe("imported");
    expect(await read(limit, limit + 1)).toBe("grok_unavailable");
    expect(await read(limit + 1, limit)).toBe("grok_unavailable");
    expect(await cursorStatus(env.deps, ALICE)).toEqual({ status: "signed_in" });
  });

  it("refuse Cursor or a bucket that resolves to a private address", async () => {
    const env = setup();
    await signIn(env);
    cursor(env);
    const local = (host: string): CursorDeps => ({
      ...env.deps,
      egress: {
        ...env.deps.egress,
        resolveHostname: async (hostname) => [
          { address: hostname === host ? "127.0.0.1" : "93.184.216.34", family: 4 },
        ],
      },
    });
    expect(await refusal(fetchGrokTemplate(local("api2.cursor.sh"), ALICE, SHARE_ID))).toBe(
      "grok_unavailable",
    );
    expect(env.requests()).toEqual([]);
    expect(await refusal(fetchGrokTemplate(local(BUCKET), ALICE, SHARE_ID))).toBe(
      "grok_unavailable",
    );
    expect(env.requests()).toEqual([DETAILS]);

    const { pending } = await startCursorSignIn(env.deps, BOB);
    expect(await pollCursorSignIn(local("api2.cursor.sh"), BOB, pending)).toEqual({
      status: "pending",
    });
    expect(env.requests()).toEqual([]);
  });
});
