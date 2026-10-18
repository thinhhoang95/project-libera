// Suggestions (Phase 3): the `suggestions` table mirror, decisions (M3.3)
// and revert.
//
// The overlay itself lives in the annotations sub-document; clients create
// and withdraw pending suggestions there, and only the server moves them to
// accepted, rejected or stale (sync/validate.ts enforces that). Decisions
// run inside the room's write lock (RoomService.batch): the anchor check,
// the content change and the overlay status are one serialized step, so two
// reviewers deciding at once cannot apply a suggestion twice, and an offline
// decision replayed later is checked against the text as it is then.
//
// Mirror strategy: after every persisted annotations update the server
// schedules a reconcile of that document (coalesced per document, run
// outside the lock except for a short read), and the list and decision
// routes reconcile synchronously before they answer. The hook keeps the
// table current for readers that only query it (thread suggestionIds,
// audit); the synchronous pass makes reads exact even when the hook was
// missed (a restart between persist and reconcile). The reconcile is also
// where a suggestion first meets the server, so a new suggestion whose
// anchored text already differs from its baseQuote (an AI edit computed on
// an old snapshot, hard case 7) is marked stale at once.

import type { FastifyInstance, FastifyReply } from "fastify";
import type { Kysely, Selectable } from "kysely";
import * as Y from "yjs";
import { z } from "zod";

import { requireDocumentAction, writeAudit } from "../auth/access.js";
import type { ServerContext } from "../context.js";
import type { DB, SuggestionsTable } from "../db/types.js";
import { HttpError } from "../http/errors.js";
import { isClientId } from "../ids.js";
import {
  AI_FEATURES,
  AnnotationKeys,
  ApiRoutes,
  bindActor,
  EventKind,
  type Actor,
  type AiFeature,
  type DecideSuggestionsResponse,
  type DecisionKind,
  type DecisionOutcome,
  type RevertSuggestionResponse,
  type Revision,
  type SuggestionInfo,
  type SuggestionRecord,
  type UserSummary,
} from "../protocol.js";
import {
  anchorRange,
  positionCharacter,
  replaceRange,
  resolvePosition,
  resolveRange,
  sourceText,
  suggestionStaleReason,
  type SuggestionStaleReason,
} from "../text/ytext.js";
import { registerCommandHandler } from "./commands.js";
import { aiHintSchema, iso, isoOrNull, loadUsers, pathId, publish, requireAccount, route, userOrUnknown } from "./common.js";
import { insertRevision, requireTextDocument } from "./revisions.js";
import type { HandlerResult } from "./threads.js";

// ---------------------------------------------------------------- records

const recordSchema = z.looseObject({
  id: z.string(),
  groupId: z.string().nullish(),
  actor: z.unknown(),
  createdBy: z.string(),
  start: z.unknown(),
  end: z.unknown(),
  baseQuote: z.string(),
  replacement: z.string(),
  threadIds: z.array(z.string()).optional(),
  status: z.enum(["pending", "accepted", "rejected", "stale", "withdrawn"]),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  decidedBy: z.string().optional(),
  decidedAt: z.number().optional(),
  staleReason: z.enum(["text-changed", "target-removed"]).optional(),
});

/**
 * A stored overlay entry, or null when it is not a usable suggestion. Extra
 * fields a client stored (reason, title, …) are kept so writing the record
 * back does not drop them.
 */
function parseRecord(key: string, value: unknown): SuggestionRecord | null {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== key || !isClientId(key)) return null;
  return parsed.data as unknown as SuggestionRecord;
}

function overlayOf(annotations: Y.Doc): Y.Map<unknown> {
  return annotations.getMap<unknown>(AnnotationKeys.suggestions);
}

function readOverlay(annotations: Y.Doc): SuggestionRecord[] {
  const records: SuggestionRecord[] = [];
  for (const [key, value] of overlayOf(annotations)) {
    const record = parseRecord(key, value);
    if (record) records.push(record);
  }
  return records;
}

/** Plain JSON for a Y.Map value: no undefined fields. */
function plain(record: SuggestionRecord): SuggestionRecord {
  return JSON.parse(JSON.stringify(record)) as SuggestionRecord;
}

function writeRecords(annotations: Y.Doc, records: Iterable<SuggestionRecord>): void {
  const overlay = overlayOf(annotations);
  for (const record of records) overlay.set(record.id, plain(record));
}

/**
 * The actor a suggestion is attributed to. The record's actor is written by
 * the client, so only its kind and AI description are kept; the account is
 * always createdBy, which validate.ts binds to the writer for commenters.
 */
function suggestionActor(record: SuggestionRecord): Actor {
  const claimed = record.actor as unknown;
  if (typeof claimed === "object" && claimed !== null && (claimed as { kind?: unknown }).kind === "ai") {
    const ai = claimed as { feature?: unknown; model?: unknown; runId?: unknown };
    if (typeof ai.feature === "string" && AI_FEATURES.includes(ai.feature as AiFeature)) {
      return bindActor(record.createdBy, undefined, {
        feature: ai.feature as AiFeature,
        model: typeof ai.model === "string" ? ai.model : undefined,
        runId: typeof ai.runId === "string" ? ai.runId : undefined,
      });
    }
  }
  return bindActor(record.createdBy, undefined);
}

type StaleReason = SuggestionStaleReason;

/** Why accepting `record` against `content` is no longer possible, or null when it still applies. */
function staleReason(content: Y.Doc, record: SuggestionRecord): StaleReason | null {
  return suggestionStaleReason(content, record);
}

/**
 * The check made when the server first sees a suggestion. An anchor whose
 * characters the server has not received yet (annotations and content sync
 * independently) is left as it is, and the decision checks it again.
 */
function staleOnArrival(content: Y.Doc, record: SuggestionRecord): StaleReason | null {
  if (positionCharacter(content, record.start) === "unknown" || positionCharacter(content, record.end) === "unknown") return null;
  return staleReason(content, record);
}

/** The range a suggestion replaces now; meaningful only when staleReason is null. */
function targetRange(content: Y.Doc, record: SuggestionRecord): { start: number; end: number } | null {
  const from = resolvePosition(content, record.start);
  const to = resolvePosition(content, record.end);
  return from === null || to === null ? null : { start: from, end: Math.max(from, to) };
}

const SERVER_DECISION: Actor = { kind: "system", reason: "decision" };

// ---------------------------------------------------------------- mirror

/**
 * Runs a per-document task serialized per document. A call made while a run
 * is waiting to start shares it (it will read the state after this call); a
 * call made during a run gets a new run after it, so a caller always sees a
 * run that started after its call.
 */
export class PerDocumentRunner {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly queued = new Map<string, Promise<void>>();

  constructor(
    private readonly context: ServerContext,
    private readonly what: string,
    private readonly task: (docId: string) => Promise<void>,
  ) {}

  run(docId: string): Promise<void> {
    const waiting = this.queued.get(docId);
    if (waiting) return waiting;
    const tail = this.tails.get(docId) ?? Promise.resolve();
    const task = tail.then(() => {
      this.queued.delete(docId);
      return this.task(docId);
    });
    this.queued.set(docId, task);
    const settled = task.catch(() => undefined);
    this.tails.set(docId, settled);
    void settled.then(() => {
      if (this.tails.get(docId) === settled) this.tails.delete(docId);
    });
    return task;
  }

  /** Fire and forget, from the persisted-update hook. */
  schedule(docId: string): void {
    this.run(docId).catch((error: unknown) => this.context.log.error({ err: error, docId }, `${this.what} failed`));
  }
}

class SuggestionMirror {
  /** Last mirrored row values per document and suggestion, to skip unchanged rows. */
  private readonly mirrored = new Map<string, Map<string, string>>();
  private readonly runner: PerDocumentRunner;

  constructor(private readonly context: ServerContext) {
    this.runner = new PerDocumentRunner(context, "Suggestion mirror reconcile", (docId) => this.reconcile(docId));
  }

  /** Reconciles the table with the overlay (serialized per document). */
  sync(docId: string): Promise<void> {
    return this.runner.run(docId);
  }

  schedule(docId: string): void {
    this.runner.schedule(docId);
  }

  private async reconcile(docId: string): Promise<void> {
    const { db } = this.context;
    const document = await db
      .selectFrom("documents")
      .select(["project_id", "kind", "deleted_at"])
      .where("id", "=", docId)
      .executeTakeFirst();
    if (!document || document.deleted_at || document.kind === "manifest") return;
    const rows = await db.selectFrom("suggestions").select(["id", "status"]).where("doc_id", "=", docId).execute();
    const known = new Set(rows.map((row) => row.id));

    const records = await this.context.rooms.batch(docId, async (batch) => {
      const arrivedStale: SuggestionRecord[] = [];
      for (const record of readOverlay(batch.docs.annotations)) {
        if (known.has(record.id) || record.status !== "pending") continue;
        const reason = staleOnArrival(batch.docs.content, record);
        if (reason) arrivedStale.push({ ...record, status: "stale", staleReason: reason, updatedAt: Date.now() });
      }
      if (arrivedStale.length > 0) {
        await batch.transact("annotations", SERVER_DECISION, { source: "system" }, (doc) => writeRecords(doc, arrivedStale));
      }
      return readOverlay(batch.docs.annotations);
    });

    const accounts = await existingAccounts(db, records.flatMap((record) => [record.createdBy, record.decidedBy]));
    let cache = this.mirrored.get(docId);
    if (!cache) {
      cache = new Map();
      this.mirrored.set(docId, cache);
    }
    const present = new Set<string>();
    for (const record of records) {
      // The row needs a real account; an editor can write any createdBy.
      if (!accounts.has(record.createdBy)) continue;
      present.add(record.id);
      const decidedBy = record.decidedBy && accounts.has(record.decidedBy) ? record.decidedBy : null;
      const values = {
        group_id: record.groupId ?? null,
        actor: JSON.stringify(suggestionActor(record)),
        base_quote: record.baseQuote,
        replacement: record.replacement,
        status: record.status,
        thread_ids: JSON.stringify(record.threadIds ?? []),
        updated_at: timeOrNow(record.updatedAt),
        decided_by: decidedBy,
        decided_at: record.decidedAt !== undefined && decidedBy ? timeOrNow(record.decidedAt) : null,
        stale_reason: record.status === "stale" ? (record.staleReason ?? null) : null,
      };
      const signature = JSON.stringify(values);
      if (cache.get(record.id) === signature) continue;
      await db
        .insertInto("suggestions")
        .values({
          id: record.id,
          doc_id: docId,
          project_id: document.project_id,
          account_id: record.createdBy,
          created_at: timeOrNow(record.createdAt),
          ...values,
        })
        // Ids are client-chosen: never let one document's overlay overwrite
        // another document's row that happens to share the id.
        .onConflict((conflict) => conflict.column("id").doUpdateSet(values).where("suggestions.doc_id", "=", docId))
        .execute();
      cache.set(record.id, signature);
    }
    // A pending entry removed from the overlay was withdrawn by its author.
    const removed = rows.filter((row) => row.status === "pending" && !present.has(row.id)).map((row) => row.id);
    if (removed.length > 0) {
      await db
        .updateTable("suggestions")
        .set({ status: "withdrawn", updated_at: new Date() })
        .where("doc_id", "=", docId)
        .where("id", "in", removed)
        .execute();
      for (const id of removed) cache.delete(id);
    }
  }
}

function timeOrNow(value: number | undefined): Date {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value) : new Date();
}

async function existingAccounts(db: Kysely<DB>, ids: Array<string | undefined>): Promise<Set<string>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  if (unique.length === 0) return new Set();
  const rows = await db.selectFrom("accounts").select("id").where("id", "in", unique).execute();
  return new Set(rows.map((row) => row.id));
}

const mirrors = new WeakMap<ServerContext, SuggestionMirror>();

export function suggestionMirror(context: ServerContext): SuggestionMirror {
  let mirror = mirrors.get(context);
  if (!mirror) {
    mirror = new SuggestionMirror(context);
    mirrors.set(context, mirror);
  }
  return mirror;
}

// ---------------------------------------------------------------- list

function suggestionInfo(row: Selectable<SuggestionsTable>, users: Map<string, UserSummary>): SuggestionInfo {
  return {
    id: row.id,
    docId: row.doc_id,
    groupId: row.group_id,
    actor: row.actor,
    createdBy: userOrUnknown(users, row.account_id),
    baseQuote: row.base_quote,
    replacement: row.replacement,
    status: row.status,
    createdAt: iso(row.created_at),
    decidedBy: row.decided_by ? userOrUnknown(users, row.decided_by) : null,
    decidedAt: isoOrNull(row.decided_at),
    staleReason: row.stale_reason,
  };
}

export async function listSuggestions(context: ServerContext, accountId: string, docId: string): Promise<SuggestionInfo[]> {
  const access = await requireDocumentAction(context.db, docId, accountId, "read");
  requireTextDocument(access);
  await suggestionMirror(context).sync(docId);
  const rows = await context.db
    .selectFrom("suggestions")
    .selectAll()
    .where("doc_id", "=", docId)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  const users = await loadUsers(context.db, rows.flatMap((row) => [row.account_id, row.decided_by]));
  return rows.map((row) => suggestionInfo(row, users));
}

// ---------------------------------------------------------------- decisions

const decideBody = z.object({
  decisions: z
    .array(z.object({ suggestionId: pathId, decision: z.enum(["accept", "reject"]) }))
    .min(1)
    .max(1000),
  checkpoint: z.boolean().optional(),
  ai: aiHintSchema,
});

interface Unit {
  decision: DecisionKind;
  /** The suggestion, or every member of its group. */
  members: SuggestionRecord[];
}

interface Result {
  outcome: DecisionOutcome;
  /** Account that decided (the winner, for already-decided). */
  decidedBy?: string;
}

/** Members of a group in the overlay, in document order. */
function groupMembers(annotations: Y.Doc, content: Y.Doc, groupId: string): SuggestionRecord[] {
  return byPosition(content, readOverlay(annotations).filter((record) => record.groupId === groupId));
}

function byPosition(content: Y.Doc, records: SuggestionRecord[]): SuggestionRecord[] {
  const position = new Map(records.map((record) => [record.id, resolvePosition(content, record.start) ?? Number.MAX_SAFE_INTEGER]));
  return [...records].sort((a, b) => position.get(a.id)! - position.get(b.id)! || a.id.localeCompare(b.id));
}

/**
 * Why a unit cannot be accepted, per member, or null when all of it can.
 * A group is checked by applying it to a scratch copy, so overlapping
 * members are caught before anything is written: groups are all or nothing.
 */
function unitProblems(content: Y.Doc, unit: Unit): Map<string, StaleReason> | null {
  const problems = new Map<string, StaleReason>();
  for (const member of unit.members) {
    const reason = member.status === "stale" ? (member.staleReason ?? "text-changed") : staleReason(content, member);
    if (reason) problems.set(member.id, reason);
  }
  if (problems.size === 0 && unit.members.length > 1) {
    const scratch = new Y.Doc();
    try {
      Y.applyUpdate(scratch, Y.encodeStateAsUpdate(content));
      for (const member of unit.members) {
        const range = staleReason(scratch, member) === null ? targetRange(scratch, member) : null;
        if (!range) {
          problems.set(member.id, "text-changed");
          break;
        }
        replaceRange(sourceText(scratch), range.start, range.end, member.replacement);
      }
    } finally {
      scratch.destroy();
    }
  }
  return problems.size > 0 ? problems : null;
}

export async function decideSuggestions(context: ServerContext, accountId: string, docId: string, input: unknown): Promise<HandlerResult> {
  const { db } = context;
  const body = decideBody.parse(input);
  const actor = bindActor(accountId, undefined, body.ai);
  const access = await requireDocumentAction(db, docId, accountId, "decide", actor);
  requireTextDocument(access);
  const decider: Actor = { kind: "user", userId: accountId };
  const overlayActor: Actor = { kind: "system", reason: "decision", onBehalfOf: accountId };

  const outcome = await context.rooms.batch(docId, async (batch) => {
    const { annotations, content } = batch.docs;
    const overlay = overlayOf(annotations);
    const results = new Map<string, Result>();
    const units = new Map<string, Unit>();
    for (const { suggestionId, decision } of body.decisions) {
      const record = parseRecord(suggestionId, overlay.get(suggestionId));
      if (!record) {
        results.set(suggestionId, { outcome: "not-found" });
        continue;
      }
      const key = record.groupId ? `group:${record.groupId}` : `one:${record.id}`;
      const existing = units.get(key);
      if (existing) {
        if (existing.decision !== decision) {
          throw new HttpError("bad-request", `Linked suggestions are decided together; ${suggestionId} has conflicting decisions.`);
        }
        continue;
      }
      const members = record.groupId ? groupMembers(annotations, content, record.groupId) : [record];
      units.set(key, { decision, members });
    }

    // A decided member decides the unit: the first decision wins.
    const live: Unit[] = [];
    for (const unit of units.values()) {
      const decided = unit.members.find((member) => member.status !== "pending" && member.status !== "stale");
      if (decided) {
        for (const member of unit.members) results.set(member.id, { outcome: "already-decided", decidedBy: decided.decidedBy });
      } else {
        live.push(unit);
      }
    }

    let checkpoint: Revision | null = null;
    if (live.length > 0 && (body.checkpoint || live.length > 1)) {
      checkpoint = await insertRevision(context, {
        docId,
        serverSeq: batch.serverSeq(),
        kind: "pre-accept-all",
        label: null,
        createdBy: accountId,
      });
    }

    // Document order, so accept-all reads like an editor going top to bottom.
    const firstPosition = new Map(
      live.map((unit) => [unit, Math.min(...unit.members.map((member) => resolvePosition(content, member.start) ?? Number.MAX_SAFE_INTEGER))]),
    );
    live.sort((a, b) => firstPosition.get(a)! - firstPosition.get(b)!);

    const changes = new Map<string, SuggestionRecord>();
    const appliedSeqs = new Map<string, number>();
    const now = Date.now();
    try {
      for (const unit of live) {
        if (unit.decision === "reject") {
          for (const member of unit.members) {
            changes.set(member.id, { ...member, status: "rejected", decidedBy: accountId, decidedAt: now, updatedAt: now });
            results.set(member.id, { outcome: "rejected", decidedBy: accountId });
          }
          continue;
        }
        const problems = unitProblems(content, unit);
        if (problems) {
          const first = problems.values().next().value as StaleReason;
          for (const member of unit.members) {
            changes.set(member.id, { ...member, status: "stale", staleReason: problems.get(member.id) ?? first, updatedAt: now });
            results.set(member.id, { outcome: "stale" });
          }
          continue;
        }
        for (const member of unit.members) {
          const { serverSeq, result: applied } = await batch.transact(
            "content",
            decider,
            { source: "suggestion", suggestionId: member.id, suggestedBy: suggestionActor(member) },
            (doc) => {
              const text = sourceText(doc);
              const range = staleReason(doc, member) === null ? targetRange(doc, member) : null;
              // unitProblems checked this; failing here means a bug, and throwing aborts the write.
              if (!range) {
                throw new Error(`Suggestion ${member.id} changed while its group was applied.`);
              }
              replaceRange(text, range.start, range.end, member.replacement);
              return anchorRange(text, range.start, range.start + member.replacement.length);
            },
          );
          appliedSeqs.set(member.id, serverSeq);
          changes.set(member.id, {
            ...member,
            status: "accepted",
            staleReason: undefined,
            decidedBy: accountId,
            decidedAt: now,
            updatedAt: now,
            appliedStart: applied.start,
            appliedEnd: applied.end,
          });
          results.set(member.id, { outcome: "applied", decidedBy: accountId });
        }
      }
    } finally {
      // Statuses are recorded even if a later write failed, so what was
      // applied is never offered for acceptance again.
      if (changes.size > 0) {
        await batch.transact("annotations", overlayActor, { source: "system" }, (doc) => writeRecords(doc, changes.values()));
      }
    }
    return { results, changes, appliedSeqs, checkpoint, serverSeq: batch.serverSeq(), units: live.length };
  });

  const mirror = suggestionMirror(context);
  await mirror.sync(docId);
  for (const [id, seq] of outcome.appliedSeqs) {
    await db.updateTable("suggestions").set({ decision_server_seq: seq }).where("id", "=", id).where("doc_id", "=", docId).execute();
  }

  const users = await loadUsers(db, [accountId, ...[...outcome.results.values()].map((result) => result.decidedBy)]);
  const ordered = [
    ...new Set([...body.decisions.map((decision) => decision.suggestionId), ...outcome.results.keys()]),
  ].filter((id) => outcome.results.has(id));
  const response: DecideSuggestionsResponse = {
    results: ordered.map((id) => {
      const result = outcome.results.get(id)!;
      return result.decidedBy
        ? { suggestionId: id, outcome: result.outcome, decidedBy: userOrUnknown(users, result.decidedBy) }
        : { suggestionId: id, outcome: result.outcome };
    }),
    serverSeq: outcome.serverSeq,
    checkpointRevisionId: outcome.checkpoint?.id ?? null,
  };

  const deciderSummary = userOrUnknown(users, accountId);
  for (const [id, record] of outcome.changes) {
    const result = outcome.results.get(id)!;
    publish(context, "doc", docId, EventKind.SuggestionDecided, { suggestionId: id, outcome: result.outcome, decidedBy: deciderSummary });
    await writeAudit(db, {
      projectId: access.projectId,
      actor,
      accountId,
      action: "suggestion.decide",
      target: id,
      details: {
        docId,
        decision: record.status === "rejected" ? "reject" : "accept",
        outcome: result.outcome,
        groupId: record.groupId ?? null,
        suggestedBy: suggestionActor(record),
        serverSeq: outcome.appliedSeqs.get(id) ?? null,
        staleReason: record.status === "stale" ? (record.staleReason ?? null) : null,
        checkpointRevisionId: outcome.checkpoint?.id ?? null,
      },
    });
  }
  if (outcome.units > 1) {
    await writeAudit(db, {
      projectId: access.projectId,
      actor,
      accountId,
      action: "suggestions.decide-all",
      target: docId,
      details: {
        checkpointRevisionId: outcome.checkpoint?.id ?? null,
        results: response.results.map((result) => ({ suggestionId: result.suggestionId, outcome: result.outcome })),
        serverSeq: outcome.serverSeq,
      },
    });
  }
  return { status: 200, body: response };
}

// ---------------------------------------------------------------- revert

const revertBody = z.object({ ai: aiHintSchema });

/**
 * Undo of an accept (M3.3): restores baseQuote where the replacement is,
 * as a new edit by the reverter, if nobody has changed the replacement
 * since; otherwise reports a conflict. The suggestion becomes pending again,
 * re-anchored on the restored text, so it can be decided anew.
 */
export async function revertSuggestion(context: ServerContext, accountId: string, suggestionId: string, input: unknown): Promise<HandlerResult> {
  const { db } = context;
  const body = revertBody.parse(input ?? {});
  const actor = bindActor(accountId, undefined, body.ai);
  const row = await db.selectFrom("suggestions").select(["doc_id"]).where("id", "=", suggestionId).executeTakeFirst();
  if (!row) throw new HttpError("not-found", "Suggestion not found.");
  const docId = row.doc_id;
  const access = await requireDocumentAction(db, docId, accountId, "decide", actor);
  requireTextDocument(access);

  const outcome = await context.rooms.batch(docId, async (batch) => {
    const record = parseRecord(suggestionId, overlayOf(batch.docs.annotations).get(suggestionId));
    if (!record) throw new HttpError("not-found", "Suggestion not found.");
    if (record.status !== "accepted") throw new HttpError("conflict", `Only accepted suggestions can be reverted (this one is ${record.status}).`);
    const range = resolveRange(batch.docs.content, record.appliedStart, record.appliedEnd);
    const current = range ? sourceText(batch.docs.content).toString().slice(range.start, range.end) : null;
    if (!range || current !== record.replacement) {
      return { outcome: "conflict" as const, serverSeq: batch.serverSeq(), record };
    }
    const { serverSeq, result: anchors } = await batch.transact(
      "content",
      { kind: "user", userId: accountId },
      { source: "undo", suggestionId, suggestedBy: suggestionActor(record) },
      (doc) => {
        const text = sourceText(doc);
        replaceRange(text, range.start, range.end, record.baseQuote);
        return anchorRange(text, range.start, range.start + record.baseQuote.length);
      },
    );
    const reopened: SuggestionRecord = {
      ...record,
      status: "pending",
      start: anchors.start,
      end: anchors.end,
      decidedBy: undefined,
      decidedAt: undefined,
      appliedStart: undefined,
      appliedEnd: undefined,
      staleReason: undefined,
      updatedAt: Date.now(),
    };
    await batch.transact("annotations", { kind: "system", reason: "decision", onBehalfOf: accountId }, { source: "system" }, (doc) =>
      writeRecords(doc, [reopened]),
    );
    return { outcome: "reverted" as const, serverSeq, record };
  });

  if (outcome.outcome === "reverted") {
    await suggestionMirror(context).sync(docId);
    await db.updateTable("suggestions").set({ decision_server_seq: null }).where("id", "=", suggestionId).where("doc_id", "=", docId).execute();
  }
  await writeAudit(db, {
    projectId: access.projectId,
    actor,
    accountId,
    action: "suggestion.revert",
    target: suggestionId,
    details: { docId, outcome: outcome.outcome, serverSeq: outcome.serverSeq, groupId: outcome.record.groupId ?? null },
  });
  const response: RevertSuggestionResponse = { outcome: outcome.outcome, serverSeq: outcome.serverSeq };
  return { status: 200, body: response };
}

// ---------------------------------------------------------------- routes

function send(reply: FastifyReply, result: HandlerResult) {
  return reply.status(result.status).send(result.body);
}

const docParams = z.object({ docId: pathId });
const suggestionParams = z.object({ suggestionId: pathId });

registerCommandHandler("suggestions.decide", (context, accountId, command) =>
  decideSuggestions(context, accountId, docParams.parse(command).docId, command.body),
);

export function registerSuggestionRoutes(app: FastifyInstance, context: ServerContext): void {
  const mirror = suggestionMirror(context);
  context.rooms.onPersisted((update) => {
    if (update.subdoc === "annotations") mirror.schedule(update.docId);
  });

  app.get(route(ApiRoutes.suggestions, "docId"), async (request) => {
    const { accountId } = await requireAccount(context, request);
    const { docId } = docParams.parse(request.params);
    return listSuggestions(context, accountId, docId);
  });

  app.post(route(ApiRoutes.suggestionDecisions, "docId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { docId } = docParams.parse(request.params);
    return send(reply, await decideSuggestions(context, accountId, docId, request.body));
  });

  app.post(route(ApiRoutes.suggestionRevert, "suggestionId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { suggestionId } = suggestionParams.parse(request.params);
    return send(reply, await revertSuggestion(context, accountId, suggestionId, request.body));
  });
}
