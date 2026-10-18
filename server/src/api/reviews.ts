// Formal review (M3.5): requests, assignee decisions bound to a revision,
// outdated approvals, and close.
//
// An approval must never silently stay green. Each decision stores a
// fingerprint of the scope's text as of the revision it was made on (in the
// review's scope JSON, keyed by reviewer). After every persisted update of
// the document, and again before reviews are listed, the server compares the
// fingerprints of decided assignments with the scope's current text and
// marks changed ones outdated.
//
// changesSinceBase: for a document scope, the number of content updates since
// the base revision. For a range scope, the base state is rebuilt and the
// content updates since are replayed one by one; an update counts when the
// scope's text (resolved through its anchor, before and after the update)
// changed. Counting by effect rather than by position means edits next to
// the scope, which shift it but leave its text alone, do not count.

import type { FastifyInstance, FastifyReply } from "fastify";
import type { Kysely, Selectable } from "kysely";
import * as Y from "yjs";
import { z } from "zod";

import { projectRole, requireDocumentAction, writeAudit } from "../auth/access.js";
import type { ServerContext } from "../context.js";
import type { DB, ReviewAssignmentsTable, ReviewsTable } from "../db/types.js";
import { HttpError } from "../http/errors.js";
import { newId } from "../ids.js";
import {
  AnnotationKeys,
  ApiRoutes,
  bindActor,
  EventKind,
  type AnchorRecord,
  type Review,
  type ReviewAssignment,
  type ReviewScope,
  type ReviewScopeRecord,
  type ReviewStatus,
  type Subdoc,
} from "../protocol.js";
import { loadSubdocState } from "../sync/store.js";
import { fingerprint, resolveRange, sourceText } from "../text/ytext.js";
import { registerCommandHandler } from "./commands.js";
import { aiHintSchema, clientIdSchema, iso, isoOrNull, loadUsers, pathId, publish, requireAccount, route, userOrUnknown } from "./common.js";
import { notify } from "./notifications.js";
import { findRevision, insertRevision, requireTextDocument } from "./revisions.js";
import { PerDocumentRunner } from "./suggestions.js";
import type { HandlerResult } from "./threads.js";

type ReviewRow = Selectable<ReviewsTable>;
type AssignmentRow = Selectable<ReviewAssignmentsTable>;

/** What reviews.scope holds: the API scope plus the reviewers' decision fingerprints. */
interface StoredScope {
  kind: "document" | "range";
  anchorId?: string;
  quote?: string;
  fingerprints?: Record<string, string>;
}

const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("document") }),
  z.object({ kind: z.literal("range"), anchorId: clientIdSchema, quote: z.string().max(10_000) }),
]);

const createBody = z.object({
  scope: scopeSchema,
  assignees: z.array(pathId).min(1).max(50),
  note: z.string().trim().max(5_000).optional(),
  ai: aiHintSchema,
});

const decideBody = z.object({
  decision: z.enum(["approved", "changes-requested"]),
  revisionId: pathId.optional(),
  comment: z.string().trim().max(5_000).optional(),
  ai: aiHintSchema,
});

function apiScope(stored: StoredScope): ReviewScope {
  return stored.kind === "range"
    ? { kind: "range", anchorId: stored.anchorId ?? "", quote: stored.quote ?? "" }
    : { kind: "document" };
}

// ---------------------------------------------------------------- scope text

interface ScopeAnchor {
  start: unknown;
  end: unknown;
}

/**
 * The anchor a range scope follows: an entry of `anchors`, or a
 * `reviewScopes` entry (keyed by review id) that names one.
 */
function scopeAnchor(annotations: Y.Doc, anchorId: string): ScopeAnchor | null {
  const anchors = annotations.getMap<unknown>(AnnotationKeys.anchors);
  const direct = anchors.get(anchorId) as Partial<AnchorRecord> | undefined;
  if (direct && typeof direct === "object" && direct.start && direct.end) return { start: direct.start, end: direct.end };
  const scope = annotations.getMap<unknown>(AnnotationKeys.reviewScopes).get(anchorId) as Partial<ReviewScopeRecord> | undefined;
  if (scope && typeof scope === "object" && typeof scope.anchorId === "string" && scope.anchorId !== anchorId) {
    return scopeAnchor(annotations, scope.anchorId);
  }
  return null;
}

/** The scope's text in `content`: the whole text, the anchored range, or null when the anchor is gone. */
function scopeText(content: Y.Doc, scope: StoredScope, anchor: ScopeAnchor | null): string | null {
  const text = sourceText(content).toString();
  if (scope.kind === "document") return text;
  if (!anchor) return null;
  const range = resolveRange(content, anchor.start, anchor.end);
  return range ? text.slice(range.start, range.end) : null;
}

function anchorFor(annotations: Y.Doc, scope: StoredScope): ScopeAnchor | null {
  return scope.kind === "range" && scope.anchorId ? scopeAnchor(annotations, scope.anchorId) : null;
}

async function changesSinceBase(db: Kysely<DB>, docId: string, baseSeq: number, scope: StoredScope, anchor: ScopeAnchor | null): Promise<number> {
  if (scope.kind === "document") {
    const row = await db
      .selectFrom("doc_updates")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("doc_id", "=", docId)
      .where("subdoc", "=", "content")
      .where("server_seq", ">", baseSeq)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }
  const doc = await loadSubdocState(db, docId, "content", baseSeq);
  try {
    const base = scopeText(doc, scope, anchor);
    const rows = await db
      .selectFrom("doc_updates")
      .select("update")
      .where("doc_id", "=", docId)
      .where("subdoc", "=", "content")
      .where("server_seq", ">", baseSeq)
      .orderBy("server_seq")
      .execute();
    let previous = base;
    let count = 0;
    for (const row of rows) {
      Y.applyUpdate(doc, row.update);
      if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) {
        // Retention pruned updates after the base (only snapshots are left),
        // so they cannot be replayed one by one. Fall back to comparing the
        // base with the latest state: at least one change when they differ.
        const latest = await loadSubdocState(db, docId, "content");
        try {
          return Math.max(count, scopeText(latest, scope, anchor) === base ? 0 : 1);
        } finally {
          latest.destroy();
        }
      }
      const now = scopeText(doc, scope, anchor);
      if (now !== previous) count += 1;
      previous = now;
    }
    return count;
  } finally {
    doc.destroy();
  }
}

// ---------------------------------------------------------------- loading

function computeStatus(review: ReviewRow, assignments: AssignmentRow[]): ReviewStatus {
  if (review.status === "closed") return "closed";
  if (assignments.some((assignment) => assignment.decision === "changes-requested")) return "changes-requested";
  if (assignments.length > 0 && assignments.every((assignment) => assignment.decision === "approved" && !assignment.outdated)) {
    return "approved";
  }
  return "open";
}

async function buildReviews(context: ServerContext, docId: string, reviews: ReviewRow[]): Promise<Review[]> {
  const { db } = context;
  if (reviews.length === 0) return [];
  const assignments = await db
    .selectFrom("review_assignments")
    .selectAll()
    .where("review_id", "in", reviews.map((review) => review.id))
    .orderBy("account_id")
    .execute();
  const users = await loadUsers(db, [...reviews.map((review) => review.requested_by), ...assignments.map((row) => row.account_id)]);
  const baseSeqs = new Map(
    (
      await db
        .selectFrom("revisions")
        .select(["id", "server_seq"])
        .where("id", "in", reviews.map((review) => review.base_revision_id))
        .execute()
    ).map((row) => [row.id, Number(row.server_seq)]),
  );
  // Anchors are read once from the live annotations; history positions
  // resolve against the old content states because the characters exist there.
  const anchors = await context.rooms.withDocs(docId, (docs) =>
    reviews.map((review) => anchorFor(docs.annotations, review.scope as unknown as StoredScope)),
  );
  const result: Review[] = [];
  for (const [index, review] of reviews.entries()) {
    const scope = review.scope as unknown as StoredScope;
    const own = assignments.filter((row) => row.review_id === review.id);
    result.push({
      id: review.id,
      docId: review.doc_id,
      requestedBy: userOrUnknown(users, review.requested_by),
      baseRevisionId: review.base_revision_id,
      scope: apiScope(scope),
      note: review.note,
      status: review.status,
      createdAt: iso(review.created_at),
      closedAt: isoOrNull(review.closed_at),
      assignments: own.map(
        (row): ReviewAssignment => ({
          reviewer: userOrUnknown(users, row.account_id),
          decision: row.decision,
          decidedRevisionId: row.decided_revision_id,
          decidedAt: isoOrNull(row.decided_at),
          outdated: row.outdated,
        }),
      ),
      changesSinceBase: await changesSinceBase(db, docId, baseSeqs.get(review.base_revision_id) ?? 0, scope, anchors[index]),
    });
  }
  return result;
}

async function loadReview(context: ServerContext, reviewId: string): Promise<Review> {
  const row = await context.db.selectFrom("reviews").selectAll().where("id", "=", reviewId).executeTakeFirstOrThrow();
  const [review] = await buildReviews(context, row.doc_id, [row]);
  return review;
}

async function changed(context: ServerContext, reviewId: string): Promise<Review> {
  const review = await loadReview(context, reviewId);
  publish(context, "doc", review.docId, EventKind.ReviewChanged, { review });
  return review;
}

/** Stores the status that follows from the assignments. Returns whether it changed. */
async function refreshStatus(db: Kysely<DB>, reviewId: string): Promise<boolean> {
  const review = await db.selectFrom("reviews").selectAll().where("id", "=", reviewId).executeTakeFirstOrThrow();
  const assignments = await db.selectFrom("review_assignments").selectAll().where("review_id", "=", reviewId).execute();
  const status = computeStatus(review, assignments);
  if (status === review.status) return false;
  await db.updateTable("reviews").set({ status }).where("id", "=", reviewId).execute();
  return true;
}

// ---------------------------------------------------------------- outdated detection

class ReviewWatcher {
  private readonly runner: PerDocumentRunner;

  constructor(private readonly context: ServerContext) {
    this.runner = new PerDocumentRunner(context, "Review outdated check", (docId) => this.check(docId));
  }

  /** Re-checks the document's decided assignments (serialized per document). */
  sync(docId: string): Promise<void> {
    return this.runner.run(docId);
  }

  schedule(docId: string): void {
    this.runner.schedule(docId);
  }

  private async check(docId: string): Promise<void> {
    const { db } = this.context;
    const decided = await db
      .selectFrom("review_assignments as a")
      .innerJoin("reviews as r", "r.id", "a.review_id")
      .select(["a.review_id", "a.account_id", "r.scope"])
      .where("r.doc_id", "=", docId)
      .where("r.status", "!=", "closed")
      .where("a.decision", "!=", "pending")
      .where("a.outdated", "=", false)
      .execute();
    if (decided.length === 0) return;
    const current = await this.context.rooms.withDocs(docId, (docs) => {
      const prints = new Map<string, string>();
      for (const row of decided) {
        if (prints.has(row.review_id)) continue;
        const scope = row.scope as unknown as StoredScope;
        prints.set(row.review_id, fingerprint(scopeText(docs.content, scope, anchorFor(docs.annotations, scope))));
      }
      return prints;
    });
    const touched = new Set<string>();
    for (const row of decided) {
      const stored = (row.scope as unknown as StoredScope).fingerprints?.[row.account_id];
      if (stored === current.get(row.review_id)) continue;
      const result = await db
        .updateTable("review_assignments")
        .set({ outdated: true })
        .where("review_id", "=", row.review_id)
        .where("account_id", "=", row.account_id)
        .where("outdated", "=", false)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) > 0) touched.add(row.review_id);
    }
    for (const reviewId of touched) {
      await refreshStatus(db, reviewId);
      await changed(this.context, reviewId);
    }
  }
}

const watchers = new WeakMap<ServerContext, ReviewWatcher>();

function reviewWatcher(context: ServerContext): ReviewWatcher {
  let watcher = watchers.get(context);
  if (!watcher) {
    watcher = new ReviewWatcher(context);
    watchers.set(context, watcher);
  }
  return watcher;
}

// ---------------------------------------------------------------- handlers

export async function listReviews(context: ServerContext, accountId: string, docId: string): Promise<Review[]> {
  const access = await requireDocumentAction(context.db, docId, accountId, "read");
  requireTextDocument(access);
  // Exact even if an update's background check has not run yet.
  await reviewWatcher(context).sync(docId);
  const rows = await context.db
    .selectFrom("reviews")
    .selectAll()
    .where("doc_id", "=", docId)
    .orderBy("created_at", "desc")
    .orderBy("id")
    .execute();
  return buildReviews(context, docId, rows);
}

export async function createReview(context: ServerContext, accountId: string, docId: string, input: unknown): Promise<HandlerResult> {
  const { db } = context;
  const body = createBody.parse(input);
  const actor = bindActor(accountId, undefined, body.ai);
  const access = await requireDocumentAction(db, docId, accountId, "request-review", actor);
  requireTextDocument(access);

  const assignees = [...new Set(body.assignees)];
  const members = await db
    .selectFrom("memberships")
    .select("account_id")
    .where("project_id", "=", access.projectId)
    .where("account_id", "in", assignees)
    .execute();
  const memberIds = new Set(members.map((row) => row.account_id));
  const strangers = assignees.filter((id) => !memberIds.has(id));
  if (strangers.length > 0) throw new HttpError("bad-request", "Every assignee must be a member of the project.", { notMembers: strangers });

  const reviewId = newId("rvw");
  const stored: StoredScope = { ...body.scope, fingerprints: {} };
  const base = await context.rooms.batch(docId, async (batch) => {
    if (body.scope.kind === "range") {
      const anchorId = body.scope.anchorId;
      if (!scopeAnchor(batch.docs.annotations, anchorId)) {
        throw new HttpError("bad-request", "The scope's anchor is not in the document's annotations.");
      }
      // Clients find a review's section through reviewScopes, keyed by review id.
      const record: ReviewScopeRecord = { reviewId, anchorId, createdBy: accountId, createdAt: Date.now() };
      await batch.transact("annotations", actor, { source: "system" }, (doc) =>
        doc.getMap<unknown>(AnnotationKeys.reviewScopes).set(reviewId, record),
      );
    }
    return insertRevision(context, { docId, serverSeq: batch.serverSeq(), kind: "review-base", label: null, createdBy: accountId });
  });

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("reviews")
      .values({
        id: reviewId,
        doc_id: docId,
        project_id: access.projectId,
        requested_by: accountId,
        base_revision_id: base.id,
        scope: JSON.stringify(stored),
        note: body.note ?? "",
        status: "open",
      })
      .execute();
    await trx
      .insertInto("review_assignments")
      .values(assignees.map((id) => ({ review_id: reviewId, account_id: id })))
      .execute();
  });

  const review = await changed(context, reviewId);
  await writeAudit(db, {
    projectId: access.projectId,
    actor,
    accountId,
    action: "review.request",
    target: reviewId,
    details: { docId, scope: body.scope, assignees, baseRevisionId: base.id },
  });
  await notify(
    context,
    assignees
      .filter((id) => id !== accountId)
      .map((id) => ({
        accountId: id,
        kind: "review-requested" as const,
        projectId: access.projectId,
        docId,
        payload: { reviewId, docId, requestedBy: review.requestedBy, note: review.note, scope: review.scope },
      })),
  );
  return { status: 201, body: review };
}

async function reviewRow(db: Kysely<DB>, reviewId: string): Promise<ReviewRow> {
  const row = await db.selectFrom("reviews").selectAll().where("id", "=", reviewId).executeTakeFirst();
  if (!row) throw new HttpError("not-found", "Review not found.");
  return row;
}

export async function decideReview(context: ServerContext, accountId: string, reviewId: string, input: unknown): Promise<HandlerResult> {
  const { db } = context;
  const body = decideBody.parse(input);
  const actor = bindActor(accountId, undefined, body.ai);
  const review = await reviewRow(db, reviewId);
  // Assigned reviewers decide whatever their role, so the role check is only "can see it".
  const access = await requireDocumentAction(db, review.doc_id, accountId, "read");
  if (actor.kind === "ai") throw new HttpError("ai-cannot-decide", "AI actions cannot approve reviews.");
  const assignment = await db
    .selectFrom("review_assignments")
    .selectAll()
    .where("review_id", "=", reviewId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  if (!assignment) throw new HttpError("forbidden", "Only assigned reviewers can decide this review.");
  if (review.status === "closed") throw new HttpError("conflict", "The review is closed.");
  const scope = review.scope as unknown as StoredScope;

  const chosen = body.revisionId ? await findRevision(db, review.doc_id, body.revisionId) : null;
  const { revisionId, serverSeq, print } = await context.rooms.batch(review.doc_id, async (batch) => {
    const anchor = anchorFor(batch.docs.annotations, scope);
    if (chosen) {
      // The fingerprint is of what the reviewer read: the scope at that revision.
      const old = await loadSubdocState(db, review.doc_id, "content", Number(chosen.server_seq));
      try {
        return { revisionId: chosen.id, serverSeq: Number(chosen.server_seq), print: fingerprint(scopeText(old, scope, anchor)) };
      } finally {
        old.destroy();
      }
    }
    const seq = batch.serverSeq();
    const latest = await db
      .selectFrom("revisions")
      .selectAll()
      .where("doc_id", "=", review.doc_id)
      .where("server_seq", "=", seq)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    const revision = latest
      ? { id: latest.id }
      : await insertRevision(context, { docId: review.doc_id, serverSeq: seq, kind: "auto", label: "Review decision", createdBy: accountId });
    return { revisionId: revision.id, serverSeq: seq, print: fingerprint(scopeText(batch.docs.content, scope, anchor)) };
  });

  await db.transaction().execute(async (trx) => {
    // Row lock: two reviewers deciding at once must not lose each other's fingerprint.
    const locked = await trx.selectFrom("reviews").select("scope").where("id", "=", reviewId).forUpdate().executeTakeFirstOrThrow();
    const current = locked.scope as unknown as StoredScope;
    const next: StoredScope = { ...current, fingerprints: { ...(current.fingerprints ?? {}), [accountId]: print } };
    await trx.updateTable("reviews").set({ scope: JSON.stringify(next) }).where("id", "=", reviewId).execute();
    await trx
      .updateTable("review_assignments")
      .set({
        decision: body.decision,
        decided_revision_id: revisionId,
        decided_server_seq: serverSeq,
        decided_at: new Date(),
        outdated: false,
      })
      .where("review_id", "=", reviewId)
      .where("account_id", "=", accountId)
      .execute();
  });
  // A decision on an older revision is outdated at once if the scope changed since.
  await reviewWatcher(context).sync(review.doc_id);
  await refreshStatus(db, reviewId);
  const updated = await changed(context, reviewId);

  await writeAudit(db, {
    projectId: access.projectId,
    actor,
    accountId,
    action: "review.decide",
    target: reviewId,
    details: { docId: review.doc_id, decision: body.decision, revisionId, serverSeq, comment: body.comment ?? null, status: updated.status },
  });
  if (review.requested_by !== accountId) {
    const reviewer = userOrUnknown(await loadUsers(db, [accountId]), accountId);
    await notify(context, [
      {
        accountId: review.requested_by,
        kind: "review-decided",
        projectId: access.projectId,
        docId: review.doc_id,
        payload: { reviewId, docId: review.doc_id, decision: body.decision, reviewer, comment: body.comment ?? null, status: updated.status },
      },
    ]);
  }
  return { status: 200, body: updated };
}

export async function closeReview(context: ServerContext, accountId: string, reviewId: string): Promise<HandlerResult> {
  const { db } = context;
  const review = await reviewRow(db, reviewId);
  const access = await requireDocumentAction(db, review.doc_id, accountId, "read");
  const role = await projectRole(db, access.projectId, accountId);
  if (review.requested_by !== accountId && role !== "owner") {
    throw new HttpError("forbidden", "Only the requester or the project owner can close a review.");
  }
  if (review.status !== "closed") {
    await db.updateTable("reviews").set({ status: "closed", closed_at: new Date() }).where("id", "=", reviewId).execute();
    await writeAudit(db, {
      projectId: access.projectId,
      actor: bindActor(accountId, undefined),
      accountId,
      action: "review.close",
      target: reviewId,
      details: { docId: review.doc_id, previousStatus: review.status },
    });
    return { status: 200, body: await changed(context, reviewId) };
  }
  return { status: 200, body: await loadReview(context, reviewId) };
}

// ---------------------------------------------------------------- routes

function send(reply: FastifyReply, result: HandlerResult) {
  return reply.status(result.status).send(result.body);
}

const docParams = z.object({ docId: pathId });
const reviewParams = z.object({ reviewId: pathId });

registerCommandHandler("review.decide", (context, accountId, command) =>
  decideReview(context, accountId, reviewParams.parse(command).reviewId, command.body),
);

const WATCHED: ReadonlySet<Subdoc> = new Set<Subdoc>(["content", "annotations"]);

export function registerReviewRoutes(app: FastifyInstance, context: ServerContext): void {
  const watcher = reviewWatcher(context);
  // Content edits change scope text; annotation edits can move a scope's anchor.
  context.rooms.onPersisted((update) => {
    if (WATCHED.has(update.subdoc)) watcher.schedule(update.docId);
  });

  app.get(route(ApiRoutes.reviews, "docId"), async (request) => {
    const { accountId } = await requireAccount(context, request);
    const { docId } = docParams.parse(request.params);
    return listReviews(context, accountId, docId);
  });

  app.post(route(ApiRoutes.reviews, "docId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { docId } = docParams.parse(request.params);
    return send(reply, await createReview(context, accountId, docId, request.body));
  });

  app.post(route(ApiRoutes.reviewDecision, "reviewId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { reviewId } = reviewParams.parse(request.params);
    return send(reply, await decideReview(context, accountId, reviewId, request.body));
  });

  app.post(route(ApiRoutes.reviewClose, "reviewId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { reviewId } = reviewParams.parse(request.params);
    return send(reply, await closeReview(context, accountId, reviewId));
  });
}

