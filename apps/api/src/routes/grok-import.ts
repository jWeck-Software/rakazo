import { ORPCError } from "@orpc/server";
import type { CursorDeps, GrokImportRefusal } from "@rakazo/adapters";
import {
  cursorStatus,
  fetchGrokTemplate,
  GrokImportError,
  pollCursorSignIn,
  signOutCursor,
  startCursorSignIn,
} from "@rakazo/adapters";
import { grokShareId } from "@rakazo/core";
import { recordSecurityEvent } from "@rakazo/db";
import { cursorSignedInEvent } from "../security-audit.js";
import type { RouterContext } from "./context.js";

/** Never 401: clients take that as their own Rakazo session ending. */
const REFUSALS = {
  grok_not_found: { code: "NOT_FOUND", message: "This Grok Bot link was not found." },
  grok_unavailable: { code: "BAD_GATEWAY", message: "Grok Bot could not be reached." },
  cursor_signed_out: { code: "PRECONDITION_FAILED", message: "Sign in with Cursor first." },
  cursor_needs_grok_bot: {
    code: "FORBIDDEN",
    message: "This Cursor account needs a plan with Grok Bot.",
  },
} as const satisfies Record<GrokImportRefusal, { code: string; message: string }>;

function refused(reason: GrokImportRefusal) {
  const { code, message } = REFUSALS[reason];
  return new ORPCError(code, { message, data: { reason } });
}

export function grokImportRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const cursor: CursorDeps = { prisma: deps.prisma, secretStore: deps.secrets };
  return {
    grokImport: {
      template: authed.grokImport.template.handler(async ({ context, input }) => {
        const shareId = grokShareId(input.link);
        if (!shareId) throw refused("grok_not_found");
        try {
          return { files: await fetchGrokTemplate(cursor, context.actor, shareId) };
        } catch (error) {
          if (error instanceof GrokImportError) throw refused(error.reason);
          throw error;
        }
      }),
      cursor: authed.grokImport.cursor.handler(({ context }) =>
        cursorStatus(cursor, context.actor),
      ),
      cursorSignIn: authed.grokImport.cursorSignIn.handler(({ context }) =>
        startCursorSignIn(cursor, context.actor),
      ),
      cursorSignInPoll: authed.grokImport.cursorSignInPoll.handler(async ({ context, input }) => {
        const status = await pollCursorSignIn(cursor, context.actor, input.pending);
        if (status.status === "signed_in")
          await recordSecurityEvent(cursorSignedInEvent(context.actor));
        return status;
      }),
      cursorSignOut: authed.grokImport.cursorSignOut.handler(({ context }) =>
        signOutCursor(cursor, context.actor),
      ),
    },
  };
}
