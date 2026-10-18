// POST /v1/commands: offline commands replayed by the desktop host.
//
// The command id is the idempotency key. The first definitive result for
// (account, id) is stored in `commands` and returned unchanged on replay, so
// a command whose response was lost on the network is applied once. Server
// errors (5xx) and kinds this server cannot run yet are not stored: replaying
// them later must be able to succeed.

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

export function registerCommandRoutes(app: FastifyInstance, context: ServerContext): void {
  const { db } = context;

  app.post(ApiRoutes.commands, async (request): Promise<CommandResult> => {
    const { accountId } = await requireAccount(context, request);
    const { id, kind } = envelope.parse(request.body);
    const command = request.body as Command;

    const stored = await db
      .selectFrom("commands")
      .select(["status", "result"])
      .where("account_id", "=", accountId)
      .where("id", "=", id)
      .executeTakeFirst();
    if (stored) return { id, status: stored.status, body: stored.result };

    const { result, store } = await run(context, accountId, command);
    if (!store) return { id, status: result.status, body: result.body };
    await db
      .insertInto("commands")
      .values({ account_id: accountId, id, kind, status: result.status, result: JSON.stringify(result.body ?? null) })
      .onConflict((conflict) => conflict.columns(["account_id", "id"]).doNothing())
      .execute();
    // A concurrent replay may have stored first; everyone gets that result.
    const winner = await db
      .selectFrom("commands")
      .select(["status", "result"])
      .where("account_id", "=", accountId)
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return { id, status: winner.status, body: winner.result };
  });
}
