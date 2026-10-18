// Comment threads and messages (Phase 2). The anchor itself lives in the
// document's annotations sub-document; the server stores the thread, its
// messages and status, keyed by ids the client chose so offline replays are
// idempotent.
//
// The handlers take unparsed input and return { status, body } so the REST
// routes and POST /v1/commands share them exactly.

import type { FastifyInstance, FastifyReply } from "fastify";
import type { Kysely, Selectable } from "kysely";
import { z } from "zod";

import { requireDocumentAction, type DocAccess } from "../auth/access.js";
import type { ServerContext } from "../context.js";
import type { DB, MessagesTable, ThreadsTable } from "../db/types.js";
import { HttpError } from "../http/errors.js";
import {
  ApiRoutes,
  bindActor,
  EventKind,
  roleAtLeast,
  type Thread,
  type ThreadMessage,
  type UserSummary,
} from "../protocol.js";
import {
  aiHintSchema,
  clientIdSchema,
  iso,
  isoOrNull,
  isUniqueViolation,
  loadUsers,
  pathId,
  publish,
  requireAccount,
  route,
  userOrUnknown,
} from "./common.js";
import { notify, type NewNotification } from "./notifications.js";

export interface HandlerResult {
  status: number;
  body: unknown;
}

const messageBody = z.string().trim().min(1).max(20_000);
const mentions = z.array(pathId).max(50).optional();

export const createThreadBody = z.object({
  id: clientIdSchema,
  anchorId: clientIdSchema,
  quote: z.string().max(10_000),
  body: messageBody,
  mentions,
  ai: aiHintSchema,
});
export const createMessageBody = z.object({ id: clientIdSchema, body: messageBody, mentions, ai: aiHintSchema });
export const editMessageBody = z.object({ body: messageBody, mentions });
export const setStatusBody = z.object({ status: z.enum(["open", "resolved", "detached"]) });
export const reattachBody = z.object({ anchorId: clientIdSchema, quote: z.string().max(10_000) });

type ThreadRow = Selectable<ThreadsTable>;
type MessageRow = Selectable<MessagesTable>;

function messageInfo(row: MessageRow, users: Map<string, UserSummary>): ThreadMessage {
  const deleted = row.deleted_at !== null;
  return {
    id: row.id,
    threadId: row.thread_id,
    actor: row.actor,
    author: userOrUnknown(users, row.account_id),
    body: deleted ? "" : row.body,
    mentions: deleted ? [] : row.mentions,
    createdAt: iso(row.created_at),
    editedAt: isoOrNull(row.edited_at),
    deletedAt: isoOrNull(row.deleted_at),
  };
}

async function buildThreads(db: Kysely<DB>, threads: ThreadRow[]): Promise<Thread[]> {
  if (threads.length === 0) return [];
  const ids = threads.map((thread) => thread.id);
  const messages = await db
    .selectFrom("messages")
    .selectAll()
    .where("thread_id", "in", ids)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  const docIds = [...new Set(threads.map((thread) => thread.doc_id))];
  const suggestions = await db
    .selectFrom("suggestions")
    .select(["id", "thread_ids"])
    .where("doc_id", "in", docIds)
    .execute();
  const users = await loadUsers(db, [
    ...threads.flatMap((thread) => [thread.account_id, thread.resolved_by]),
    ...messages.map((message) => message.account_id),
  ]);
  return threads.map((thread) => ({
    id: thread.id,
    docId: thread.doc_id,
    anchorId: thread.anchor_id,
    quote: thread.quote_text,
    status: thread.status,
    actor: thread.actor,
    createdBy: userOrUnknown(users, thread.account_id),
    createdAt: iso(thread.created_at),
    updatedAt: iso(thread.updated_at),
    resolvedBy: thread.resolved_by ? userOrUnknown(users, thread.resolved_by) : null,
    resolvedAt: isoOrNull(thread.resolved_at),
    suggestionIds: suggestions.filter((entry) => entry.thread_ids.includes(thread.id)).map((entry) => entry.id),
    messages: messages.filter((message) => message.thread_id === thread.id).map((message) => messageInfo(message, users)),
  }));
}

export async function loadThread(db: Kysely<DB>, threadId: string): Promise<Thread> {
  const row = await db.selectFrom("threads").selectAll().where("id", "=", threadId).executeTakeFirstOrThrow();
  const [thread] = await buildThreads(db, [row]);
  return thread;
}

async function liveThread(db: Kysely<DB>, threadId: string): Promise<ThreadRow> {
  const row = await db
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", threadId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) throw new HttpError("not-found", "Thread not found.");
  return row;
}

/** Threads are visible only through their document, so a non-member gets 404 too. */
async function threadWithAccess(context: ServerContext, accountId: string, threadId: string) {
  const thread = await liveThread(context.db, threadId);
  const access = await requireDocumentAction(context.db, thread.doc_id, accountId, "comment", bindActor(accountId, undefined));
  return { thread, access };
}

/** Commenters manage their own threads; editors and owners manage anyone's. */
function canManageThread(thread: ThreadRow, access: DocAccess, accountId: string): boolean {
  return thread.account_id === accountId || roleAtLeast(access.role, "editor");
}

async function changed(context: ServerContext, threadId: string, kind: string = EventKind.ThreadChanged): Promise<Thread> {
  const thread = await loadThread(context.db, threadId);
  publish(context, "doc", thread.docId, kind, { thread });
  return thread;
}

/** Mentioned ids that are members of the project, without the author. */
async function memberMentions(db: Kysely<DB>, projectId: string, ids: string[] | undefined, authorId: string): Promise<string[]> {
  const wanted = [...new Set(ids ?? [])].filter((id) => id !== authorId);
  if (wanted.length === 0) return [];
  const rows = await db
    .selectFrom("memberships")
    .select("account_id")
    .where("project_id", "=", projectId)
    .where("account_id", "in", wanted)
    .execute();
  const members = new Set(rows.map((row) => row.account_id));
  return wanted.filter((id) => members.has(id));
}

function excerpt(text: string): string {
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

async function author(db: Kysely<DB>, accountId: string): Promise<UserSummary> {
  return userOrUnknown(await loadUsers(db, [accountId]), accountId);
}

function messagePayload(thread: ThreadRow, message: { id: string; body: string }, by: UserSummary): Record<string, unknown> {
  return {
    threadId: thread.id,
    messageId: message.id,
    docId: thread.doc_id,
    quote: excerpt(thread.quote_text),
    excerpt: excerpt(message.body),
    author: by,
  };
}

export async function listThreads(context: ServerContext, accountId: string, docId: string): Promise<Thread[]> {
  await requireDocumentAction(context.db, docId, accountId, "read");
  const rows = await context.db
    .selectFrom("threads")
    .selectAll()
    .where("doc_id", "=", docId)
    .where("deleted_at", "is", null)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return buildThreads(context.db, rows);
}

export async function createThread(context: ServerContext, accountId: string, docId: string, input: unknown): Promise<HandlerResult> {
  const { db } = context;
  const body = createThreadBody.parse(input);
  const actor = bindActor(accountId, undefined, body.ai);
  const access = await requireDocumentAction(db, docId, accountId, "comment", actor);

  const replay = async (): Promise<HandlerResult | null> => {
    const existing = await db.selectFrom("threads").select(["account_id", "doc_id"]).where("id", "=", body.id).executeTakeFirst();
    if (!existing) return null;
    if (existing.account_id !== accountId || existing.doc_id !== docId) {
      throw new HttpError("conflict", "A thread with this id already exists.");
    }
    return { status: 200, body: await loadThread(db, body.id) };
  };
  const first = await replay();
  if (first) return first;

  const mentioned = await memberMentions(db, access.projectId, body.mentions, accountId);
  try {
    await db.transaction().execute(async (trx) => {
      const now = new Date();
      await trx
        .insertInto("threads")
        .values({
          id: body.id,
          doc_id: docId,
          project_id: access.projectId,
          anchor_id: body.anchorId,
          quote_text: body.quote,
          status: "open",
          actor: JSON.stringify(actor),
          account_id: accountId,
          created_at: now,
          updated_at: now,
        })
        .execute();
      // The opening message shares the thread's id, so an offline client can
      // edit it before the create has synced.
      await trx
        .insertInto("messages")
        .values({
          id: body.id,
          thread_id: body.id,
          actor: JSON.stringify(actor),
          account_id: accountId,
          body: body.body,
          mentions: JSON.stringify(mentioned),
          created_at: now,
        })
        .execute();
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await replay();
    if (raced) return raced;
    throw new HttpError("conflict", "A message with this id already exists.");
  }

  const thread = await changed(context, body.id);
  const threadRow = await liveThread(db, body.id);
  const by = await author(db, accountId);
  await notify(
    context,
    mentioned.map((id) => ({
      accountId: id,
      kind: "mention",
      projectId: access.projectId,
      docId,
      payload: messagePayload(threadRow, { id: body.id, body: body.body }, by),
    })),
  );
  return { status: 201, body: thread };
}

export async function addMessage(context: ServerContext, accountId: string, threadId: string, input: unknown): Promise<HandlerResult> {
  const { db } = context;
  const body = createMessageBody.parse(input);
  const thread = await liveThread(db, threadId);
  const actor = bindActor(accountId, undefined, body.ai);
  const access = await requireDocumentAction(db, thread.doc_id, accountId, "comment", actor);

  const replay = async (): Promise<HandlerResult | null> => {
    const existing = await db.selectFrom("messages").selectAll().where("id", "=", body.id).executeTakeFirst();
    if (!existing) return null;
    if (existing.account_id !== accountId || existing.thread_id !== threadId) {
      throw new HttpError("conflict", "A message with this id already exists.");
    }
    return { status: 200, body: messageInfo(existing, await loadUsers(db, [accountId])) };
  };
  const first = await replay();
  if (first) return first;

  const mentioned = await memberMentions(db, access.projectId, body.mentions, accountId);
  // Everyone already in the conversation hears about replies.
  const participants = await db
    .selectFrom("messages")
    .select("account_id")
    .distinct()
    .where("thread_id", "=", threadId)
    .where("deleted_at", "is", null)
    .execute();

  let row: MessageRow;
  try {
    row = await db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto("messages")
        .values({
          id: body.id,
          thread_id: threadId,
          actor: JSON.stringify(actor),
          account_id: accountId,
          body: body.body,
          mentions: JSON.stringify(mentioned),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx.updateTable("threads").set({ updated_at: new Date() }).where("id", "=", threadId).execute();
      return inserted;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await replay();
    if (raced) return raced;
    throw error;
  }

  await changed(context, threadId);
  const by = await author(db, accountId);
  const payload = messagePayload(thread, row, by);
  const notifications: NewNotification[] = mentioned.map((id) => ({
    accountId: id,
    kind: "mention",
    projectId: access.projectId,
    docId: thread.doc_id,
    payload,
  }));
  const repliedTo = new Set([thread.account_id, ...participants.map((entry) => entry.account_id)]);
  for (const id of repliedTo) {
    if (id === accountId || mentioned.includes(id)) continue;
    notifications.push({ accountId: id, kind: "reply", projectId: access.projectId, docId: thread.doc_id, payload });
  }
  // A former member keeps their messages but must not get notifications.
  const members = new Set(
    (
      await db
        .selectFrom("memberships")
        .select("account_id")
        .where("project_id", "=", access.projectId)
        .execute()
    ).map((entry) => entry.account_id),
  );
  await notify(context, notifications.filter((entry) => members.has(entry.accountId)));
  return { status: 201, body: messageInfo(row, await loadUsers(db, [accountId])) };
}

async function messageWithAccess(context: ServerContext, accountId: string, messageId: string) {
  const message = await context.db.selectFrom("messages").selectAll().where("id", "=", messageId).executeTakeFirst();
  if (!message) throw new HttpError("not-found", "Message not found.");
  const { thread, access } = await threadWithAccess(context, accountId, message.thread_id);
  return { message, thread, access };
}

export async function editMessage(context: ServerContext, accountId: string, messageId: string, input: unknown): Promise<HandlerResult> {
  const { db } = context;
  const body = editMessageBody.parse(input);
  const { message, thread, access } = await messageWithAccess(context, accountId, messageId);
  if (message.account_id !== accountId) throw new HttpError("forbidden", "You can only edit your own messages.");
  if (message.deleted_at) throw new HttpError("not-found", "Message was deleted.");

  const mentioned = await memberMentions(db, access.projectId, body.mentions, accountId);
  const now = new Date();
  const row = await db
    .updateTable("messages")
    .set({ body: body.body, mentions: JSON.stringify(mentioned), edited_at: now })
    .where("id", "=", messageId)
    .returningAll()
    .executeTakeFirstOrThrow();
  await db.updateTable("threads").set({ updated_at: now }).where("id", "=", thread.id).execute();
  await changed(context, thread.id);
  // Only people newly mentioned by the edit; the others were told already.
  const added = mentioned.filter((id) => !message.mentions.includes(id));
  const by = await author(db, accountId);
  await notify(
    context,
    added.map((id) => ({ accountId: id, kind: "mention", projectId: access.projectId, docId: thread.doc_id, payload: messagePayload(thread, row, by) })),
  );
  return { status: 200, body: messageInfo(row, await loadUsers(db, [accountId])) };
}

export async function deleteMessage(context: ServerContext, accountId: string, messageId: string): Promise<HandlerResult> {
  const { db } = context;
  const { message, thread, access } = await messageWithAccess(context, accountId, messageId);
  if (message.account_id !== accountId && access.role !== "owner") {
    throw new HttpError("forbidden", "You can only delete your own messages.");
  }
  if (!message.deleted_at) {
    const now = new Date();
    // The text is dropped, not kept hidden: deleting is meant to remove it.
    await db
      .updateTable("messages")
      .set({ deleted_at: now, body: "", mentions: JSON.stringify([]) })
      .where("id", "=", messageId)
      .execute();
    await db.updateTable("threads").set({ updated_at: now }).where("id", "=", thread.id).execute();
    await changed(context, thread.id);
  }
  return { status: 204, body: null };
}

export async function setThreadStatus(context: ServerContext, accountId: string, threadId: string, input: unknown): Promise<HandlerResult> {
  const { db } = context;
  const body = setStatusBody.parse(input);
  const { thread, access } = await threadWithAccess(context, accountId, threadId);
  if (!canManageThread(thread, access, accountId)) {
    throw new HttpError("forbidden", "Commenters can only change the status of their own threads.");
  }
  if (thread.status === body.status) return { status: 200, body: await loadThread(db, threadId) };
  const now = new Date();
  const resolved = body.status === "resolved";
  await db
    .updateTable("threads")
    .set({
      status: body.status,
      updated_at: now,
      resolved_by: resolved ? accountId : null,
      resolved_at: resolved ? now : null,
    })
    .where("id", "=", threadId)
    .execute();
  const updated = await changed(context, threadId);
  if (resolved && thread.account_id !== accountId) {
    await notify(context, [
      {
        accountId: thread.account_id,
        kind: "thread-resolved",
        projectId: access.projectId,
        docId: thread.doc_id,
        payload: { threadId, docId: thread.doc_id, quote: excerpt(thread.quote_text), resolvedBy: await author(db, accountId) },
      },
    ]);
  }
  return { status: 200, body: updated };
}

export async function reattachThread(context: ServerContext, accountId: string, threadId: string, input: unknown): Promise<HandlerResult> {
  const body = reattachBody.parse(input);
  const { thread, access } = await threadWithAccess(context, accountId, threadId);
  if (!canManageThread(thread, access, accountId)) {
    throw new HttpError("forbidden", "Commenters can only reattach their own threads.");
  }
  await context.db
    .updateTable("threads")
    .set({
      anchor_id: body.anchorId,
      quote_text: body.quote,
      // A reattached thread has an anchor again; a resolved one stays resolved.
      status: thread.status === "detached" ? "open" : thread.status,
      updated_at: new Date(),
    })
    .where("id", "=", threadId)
    .execute();
  return { status: 200, body: await changed(context, threadId) };
}

export async function deleteThread(context: ServerContext, accountId: string, threadId: string): Promise<HandlerResult> {
  const { thread, access } = await threadWithAccess(context, accountId, threadId);
  if (!canManageThread(thread, access, accountId)) {
    throw new HttpError("forbidden", "Only the thread's author or an editor can delete it.");
  }
  await context.db.updateTable("threads").set({ deleted_at: new Date(), updated_at: new Date() }).where("id", "=", threadId).execute();
  await changed(context, threadId, EventKind.ThreadDeleted);
  return { status: 204, body: null };
}

function send(reply: FastifyReply, result: HandlerResult) {
  return result.status === 204 ? reply.status(204).send() : reply.status(result.status).send(result.body);
}

const docParams = z.object({ docId: pathId });
const threadParams = z.object({ threadId: pathId });
const messageParams = z.object({ messageId: pathId });

export function registerThreadRoutes(app: FastifyInstance, context: ServerContext): void {
  app.get(route(ApiRoutes.threads, "docId"), async (request) => {
    const { accountId } = await requireAccount(context, request);
    const { docId } = docParams.parse(request.params);
    return listThreads(context, accountId, docId);
  });

  app.post(route(ApiRoutes.threads, "docId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { docId } = docParams.parse(request.params);
    return send(reply, await createThread(context, accountId, docId, request.body));
  });

  app.get(route(ApiRoutes.thread, "threadId"), async (request) => {
    const { accountId } = await requireAccount(context, request);
    const { threadId } = threadParams.parse(request.params);
    const thread = await liveThread(context.db, threadId);
    await requireDocumentAction(context.db, thread.doc_id, accountId, "read");
    return loadThread(context.db, threadId);
  });

  app.delete(route(ApiRoutes.thread, "threadId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { threadId } = threadParams.parse(request.params);
    return send(reply, await deleteThread(context, accountId, threadId));
  });

  app.post(route(ApiRoutes.threadMessages, "threadId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { threadId } = threadParams.parse(request.params);
    return send(reply, await addMessage(context, accountId, threadId, request.body));
  });

  app.post(route(ApiRoutes.threadStatus, "threadId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { threadId } = threadParams.parse(request.params);
    return send(reply, await setThreadStatus(context, accountId, threadId, request.body));
  });

  app.post(route(ApiRoutes.threadReattach, "threadId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { threadId } = threadParams.parse(request.params);
    return send(reply, await reattachThread(context, accountId, threadId, request.body));
  });

  app.patch(route(ApiRoutes.message, "messageId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { messageId } = messageParams.parse(request.params);
    return send(reply, await editMessage(context, accountId, messageId, request.body));
  });

  app.delete(route(ApiRoutes.message, "messageId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { messageId } = messageParams.parse(request.params);
    return send(reply, await deleteMessage(context, accountId, messageId));
  });
}
