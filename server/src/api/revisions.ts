// Revisions (M2.4) and restore (M2.5).
//
// A revision is only a named serverSeq: its text is rebuilt from the log
// with loadSubdocState, and compaction keeps a snapshot at every revision's
// seq so that stays possible after the log is pruned. Restore never rewrites
// history: it computes the smallest forward edits from the current text to
// the revision's (or one section of it) and applies them as a new update.

import type { FastifyInstance, FastifyReply } from "fastify";
import type { Kysely, Selectable } from "kysely";
import { z } from "zod";

import { requireDocumentAction, writeAudit, type DocAccess } from "../auth/access.js";
import type { ServerContext } from "../context.js";
import type { DB, RevisionsTable } from "../db/types.js";
import { HttpError } from "../http/errors.js";
import { newId } from "../ids.js";
import {
  ApiRoutes,
  bindActor,
  EventKind,
  type Actor,
  type RestoreResponse,
  type Revision,
  type RevisionContent,
  type RevisionKind,
  type UserSummary,
} from "../protocol.js";
import { loadSubdocState } from "../sync/store.js";
import { diffText } from "../text/diff.js";
import { locateSection } from "../text/locate.js";
import { applyTextEdits, sourceText } from "../text/ytext.js";
import { registerCommandHandler } from "./commands.js";
import { aiHintSchema, iso, loadUsers, pathId, publish, requireAccount, route, userOrUnknown } from "./common.js";
import type { HandlerResult } from "./threads.js";

type RevisionRow = Selectable<RevisionsTable>;

export const createRevisionBody = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  kind: z.enum(["named", "auto", "session-end"]).optional(),
});

const restoreBody = z.object({
  revisionId: pathId,
  range: z
    .object({ start: z.number().int().min(0), end: z.number().int().min(0) })
    .refine((range) => range.start <= range.end, "range.start must not be after range.end.")
    .optional(),
  ai: aiHintSchema,
});

export function revisionInfo(row: RevisionRow, users: Map<string, UserSummary>): Revision {
  return {
    id: row.id,
    docId: row.doc_id,
    serverSeq: Number(row.server_seq),
    label: row.label,
    kind: row.kind,
    createdBy: row.created_by ? userOrUnknown(users, row.created_by) : null,
    createdAt: iso(row.created_at),
  };
}

async function revisionWithUsers(db: Kysely<DB>, row: RevisionRow): Promise<Revision> {
  return revisionInfo(row, await loadUsers(db, [row.created_by]));
}

/** Revisions only make sense for text documents; the manifest has no source text. */
export function requireTextDocument(access: DocAccess): void {
  if (access.kind === "manifest") throw new HttpError("bad-request", "The project manifest has no revisions.");
}

/**
 * Inserts a revision at `serverSeq` and announces it. Callers inside a room
 * batch pass the batch's serverSeq so the revision is exactly the state the
 * lock holder sees.
 */
export async function insertRevision(
  context: ServerContext,
  input: { docId: string; serverSeq: number; kind: RevisionKind; label?: string | null; createdBy: string | null },
): Promise<Revision> {
  const row = await context.db
    .insertInto("revisions")
    .values({
      id: newId("rev"),
      doc_id: input.docId,
      server_seq: input.serverSeq,
      label: input.label ?? null,
      kind: input.kind,
      created_by: input.createdBy,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const revision = await revisionWithUsers(context.db, row);
  publish(context, "doc", input.docId, EventKind.RevisionCreated, { revision });
  return revision;
}

export async function findRevision(db: Kysely<DB>, docId: string, revisionId: string): Promise<RevisionRow> {
  const row = await db
    .selectFrom("revisions")
    .selectAll()
    .where("id", "=", revisionId)
    .where("doc_id", "=", docId)
    .executeTakeFirst();
  if (!row) throw new HttpError("not-found", "Revision not found.");
  return row;
}

/** The plain source text as of a serverSeq, rebuilt from the latest snapshot at or below it. */
export async function textAt(db: Kysely<DB>, docId: string, serverSeq: number): Promise<string> {
  const doc = await loadSubdocState(db, docId, "content", serverSeq);
  try {
    return sourceText(doc).toString();
  } finally {
    doc.destroy();
  }
}

export async function listRevisions(context: ServerContext, accountId: string, docId: string): Promise<Revision[]> {
  const access = await requireDocumentAction(context.db, docId, accountId, "read");
  requireTextDocument(access);
  const rows = await context.db
    .selectFrom("revisions")
    .selectAll()
    .where("doc_id", "=", docId)
    .orderBy("server_seq", "desc")
    .orderBy("created_at", "desc")
    .execute();
  const users = await loadUsers(context.db, rows.map((row) => row.created_by));
  return rows.map((row) => revisionInfo(row, users));
}

export async function createRevision(context: ServerContext, accountId: string, docId: string, input: unknown): Promise<HandlerResult> {
  const { db } = context;
  const body = createRevisionBody.parse(input ?? {});
  const kind = body.kind ?? "named";
  // Naming a version is an editor action. Automatic and session-end
  // checkpoints come from whoever was writing, which includes commenters
  // (they write annotations); viewers write nothing and get no checkpoints.
  const access = await requireDocumentAction(db, docId, accountId, kind === "named" ? "name-revision" : "comment");
  requireTextDocument(access);
  const serverSeq = await context.rooms.currentServerSeq(docId);
  if (kind !== "named") {
    // Checkpoints are idempotent per state: a client that ends a session
    // twice, or several clients checkpointing the same state, share one.
    const latest = await db
      .selectFrom("revisions")
      .selectAll()
      .where("doc_id", "=", docId)
      .orderBy("server_seq", "desc")
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (latest && Number(latest.server_seq) === serverSeq && latest.kind === kind) {
      return { status: 200, body: await revisionWithUsers(db, latest) };
    }
  }
  const revision = await insertRevision(context, { docId, serverSeq, kind, label: body.label ?? null, createdBy: accountId });
  return { status: 201, body: revision };
}

export async function revisionContent(context: ServerContext, accountId: string, docId: string, revisionId: string): Promise<RevisionContent> {
  const access = await requireDocumentAction(context.db, docId, accountId, "read");
  requireTextDocument(access);
  const row = await findRevision(context.db, docId, revisionId);
  return { revision: await revisionWithUsers(context.db, row), text: await textAt(context.db, docId, Number(row.server_seq)) };
}

export async function restoreRevision(context: ServerContext, accountId: string, docId: string, input: unknown): Promise<HandlerResult> {
  const { db } = context;
  const body = restoreBody.parse(input);
  const actor = bindActor(accountId, undefined, body.ai);
  const access = await requireDocumentAction(db, docId, accountId, "restore", actor);
  requireTextDocument(access);
  const revision = await findRevision(db, docId, body.revisionId);
  // History is immutable, so the target text can be rebuilt outside the lock.
  const target = await textAt(db, docId, Number(revision.server_seq));
  if (body.range && body.range.end > target.length) {
    throw new HttpError("bad-request", `range is outside the revision text (length ${target.length}).`);
  }

  const systemActor: Actor = { kind: "system", reason: "restore", onBehalfOf: accountId };
  const outcome = await context.rooms.batch(docId, async (batch) => {
    const current = sourceText(batch.docs.content).toString();
    let from = 0;
    let to = current.length;
    let wanted = target;
    if (body.range) {
      const located = locateSection(target, body.range.start, body.range.end, current);
      if (!located) {
        throw new HttpError("conflict", "The section could not be found in the current text.", { revisionId: revision.id });
      }
      ({ start: from, end: to } = located);
      wanted = target.slice(body.range.start, body.range.end);
    }
    const edits = diffText(current.slice(from, to), wanted).map((edit) => ({ ...edit, start: edit.start + from }));
    // The checkpoint is the exact state before the restore: nothing else can
    // write while the batch holds the lock.
    const checkpoint = await insertRevision(context, {
      docId,
      serverSeq: batch.serverSeq(),
      kind: "pre-restore",
      label: null,
      createdBy: accountId,
    });
    if (edits.length === 0) return { serverSeq: batch.serverSeq(), checkpoint, edits: 0 };
    const { serverSeq } = await batch.transact("content", systemActor, { source: "restore" }, (doc) => {
      applyTextEdits(sourceText(doc), edits);
    });
    return { serverSeq, checkpoint, edits: edits.length };
  });

  await writeAudit(db, {
    projectId: access.projectId,
    actor,
    accountId,
    action: "document.restore",
    target: docId,
    details: {
      revisionId: revision.id,
      revisionServerSeq: Number(revision.server_seq),
      range: body.range ?? null,
      checkpointRevisionId: outcome.checkpoint.id,
      serverSeq: outcome.serverSeq,
      edits: outcome.edits,
    },
  });
  const response: RestoreResponse = { serverSeq: outcome.serverSeq, checkpointRevisionId: outcome.checkpoint.id };
  return { status: 200, body: response };
}

function send(reply: FastifyReply, result: HandlerResult) {
  return reply.status(result.status).send(result.body);
}

const docParams = z.object({ docId: pathId });
const revisionParams = z.object({ docId: pathId, revisionId: pathId });
const onDoc = z.object({ docId: pathId });

registerCommandHandler("revision.create", (context, accountId, command) =>
  createRevision(context, accountId, onDoc.parse(command).docId, command.body),
);

export function registerRevisionRoutes(app: FastifyInstance, context: ServerContext): void {
  app.get(route(ApiRoutes.revisions, "docId"), async (request) => {
    const { accountId } = await requireAccount(context, request);
    const { docId } = docParams.parse(request.params);
    return listRevisions(context, accountId, docId);
  });

  app.post(route(ApiRoutes.revisions, "docId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { docId } = docParams.parse(request.params);
    return send(reply, await createRevision(context, accountId, docId, request.body));
  });

  app.get(route(ApiRoutes.revisionContent, "docId", "revisionId"), async (request) => {
    const { accountId } = await requireAccount(context, request);
    const { docId, revisionId } = revisionParams.parse(request.params);
    return revisionContent(context, accountId, docId, revisionId);
  });

  app.post(route(ApiRoutes.restore, "docId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { docId } = docParams.parse(request.params);
    return send(reply, await restoreRevision(context, accountId, docId, request.body));
  });
}
