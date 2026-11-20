// POST /v1/commands: offline commands replayed by the desktop host.
//
// The command id is the idempotency key. The first definitive result for
// (account, id) is stored in `commands` and returned unchanged on replay, so
// a command whose response was lost on the network is applied once. Server
// errors (5xx) and kinds this server cannot run yet are not stored: replaying
// them later must be able to succeed.
//
// The id is claimed (a row with a null status) before the handler runs, so two
// overlapping submissions cannot both apply the effect (audit S58). A claim
// that outlives its lease is a handler that died before its receipt: the next
// submission takes it over and re-runs the handler, which every command kind
// makes idempotent on its own client-supplied ids.

import type { FastifyInstance } from "fastify";
import { ZodError, z } from "zod";

import type { ServerContext } from "../context.js";
import { errorBody, HttpError } from "../http/errors.js";
import { ApiRoutes, type Command, type CommandKind, type CommandResult } from "../protocol.js";
import { clientIdSchema, pathId, requireAccount } from "./common.js";
import {
  addMessage,
  createThread,
  deleteMessage,
  deleteThread,
  editMessage,
  reattachThread,
  setThreadStatus,
  type HandlerResult,
} from "./threads.js";

export type CommandHandler<K extends CommandKind = CommandKind> = (
  context: ServerContext,
  accountId: string,
  command: Extract<Command, { kind: K }>,
) => Promise<HandlerResult>;

const COMMAND_KINDS: readonly CommandKind[] = [
  "thread.create",
  "message.create",
  "message.edit",
  "message.delete",
  "thread.status",
  "thread.reattach",
  "thread.delete",
  "suggestions.decide",
  "review.decide",
  "revision.create",
];

const handlers = new Map<CommandKind, CommandHandler>();

/**
 * Installs the handler for a command kind. Suggestion decisions, review
 * decisions and revisions register theirs when those milestones land; until
 * then their commands answer 404 and stay unstored.
 */
export function registerCommandHandler<K extends CommandKind>(kind: K, handler: CommandHandler<K>): void {
  handlers.set(kind, handler as unknown as CommandHandler);
}

const envelope = z.object({
  id: clientIdSchema,
  kind: z.enum(COMMAND_KINDS as unknown as [CommandKind, ...CommandKind[]]),
});
const onDoc = z.object({ docId: pathId });
const onThread = z.object({ threadId: pathId });
const onMessage = z.object({ messageId: pathId });

registerCommandHandler("thread.create", (context, accountId, command) =>
  createThread(context, accountId, onDoc.parse(command).docId, command.body),
);
registerCommandHandler("message.create", (context, accountId, command) =>
  addMessage(context, accountId, onThread.parse(command).threadId, command.body),
);
registerCommandHandler("message.edit", (context, accountId, command) =>
  editMessage(context, accountId, onMessage.parse(command).messageId, command.body),
);
registerCommandHandler("message.delete", (context, accountId, command) =>
  deleteMessage(context, accountId, onMessage.parse(command).messageId),
);
registerCommandHandler("thread.status", (context, accountId, command) =>
  setThreadStatus(context, accountId, onThread.parse(command).threadId, command.body),
);
registerCommandHandler("thread.reattach", (context, accountId, command) =>
  reattachThread(context, accountId, onThread.parse(command).threadId, command.body),
);
registerCommandHandler("thread.delete", (context, accountId, command) =>
  deleteThread(context, accountId, onThread.parse(command).threadId),
);

async function run(context: ServerContext, accountId: string, command: Command): Promise<{ result: HandlerResult; store: boolean }> {
  const handler = handlers.get(command.kind);
  if (!handler) {
    return { result: { status: 404, body: errorBody("not-found", `${command.kind} is not available yet.`) }, store: false };
  }
  try {
    return { result: await handler(context, accountId, command), store: true };
  } catch (error) {
    if (error instanceof HttpError) {
      // Rate limits and expired sessions are about this attempt, not the command.
      const transient = error.status >= 500 || error.code === "rate-limited" || error.code === "token-expired";
      return { result: { status: error.status, body: errorBody(error.code, error.message, error.details) }, store: !transient };
    }
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
      return { result: { status: 400, body: errorBody("bad-request", "Invalid command.", details) }, store: true };
    }
    throw error;
  }
}

/** How long a claim blocks duplicates before a replay may take it over. */
export const COMMAND_CLAIM_LEASE_MS = 60_000;

export function registerCommandRoutes(app: FastifyInstance, context: ServerContext): void {
  const { db } = context;

  app.post(ApiRoutes.commands, async (request): Promise<CommandResult> => {
    const { accountId } = await requireAccount(context, request);
    const { id, kind } = envelope.parse(request.body);
    const command = request.body as Command;

    const receipt = (row: { status: number | null; result: unknown } | undefined): CommandResult | null =>
      row && row.status !== null ? { id, status: row.status, body: row.result } : null;
    const lookup = () => db.selectFrom("commands").select(["status", "result"])
      .where("account_id", "=", accountId).where("id", "=", id).executeTakeFirst();

    const done = receipt(await lookup());
    if (done) return done;

    // Claim the id. Losing means a receipt exists, a live claim is running, or a dead claim can be taken over.
    const claimedAt = new Date();
    const claimed = await db.insertInto("commands")
      .values({ account_id: accountId, id, kind, status: null, result: null, claimed_at: claimedAt })
      .onConflict((conflict) => conflict.columns(["account_id", "id"]).doNothing())
      .returning("id").executeTakeFirst();
    if (!claimed) {
      const taken = await db.updateTable("commands").set({ claimed_at: claimedAt })
        .where("account_id", "=", accountId).where("id", "=", id).where("status", "is", null)
        .where("claimed_at", "<", new Date(claimedAt.getTime() - COMMAND_CLAIM_LEASE_MS))
        .returning("id").executeTakeFirst();
      if (!taken) {
        const raced = receipt(await lookup());
        if (raced) return raced;
        // Still running on another request: a transient answer the host retries.
        return { id, status: 503, body: errorBody("internal", "This command is already being applied. Retry shortly.") };
      }
    }

    let outcome: { result: HandlerResult; store: boolean } | null = null;
    try {
      outcome = await run(context, accountId, command);
    } finally {
      // Nothing to remember (transient or unavailable) or the handler threw: free the id for a retry.
      if (!outcome?.store) {
        await db.deleteFrom("commands").where("account_id", "=", accountId).where("id", "=", id).where("status", "is", null).execute();
      }
    }
    if (!outcome.store) return { id, status: outcome.result.status, body: outcome.result.body };
    await db.updateTable("commands")
      .set({ status: outcome.result.status, result: JSON.stringify(outcome.result.body ?? null) })
      .where("account_id", "=", accountId).where("id", "=", id).where("status", "is", null)
      .execute();
    // A takeover may have stored first; everyone gets that result.
    const winner = await lookup();
    return receipt(winner) ?? { id, status: outcome.result.status, body: outcome.result.body };
  });
}
