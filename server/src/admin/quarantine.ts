// doc quarantine <docId> --range <from>..<to> --yes [--dry-run]
//
// DANGER. This is the one admin command that removes updates from a
// document's history. Use it only when an update range makes the document
// unloadable or corrupt and a forward rebuild (doc rebuild) cannot help.
//
// What it does, in one transaction:
//   1. Moves the updates in the range into quarantined_updates.
//   2. Also moves every later update that can no longer be integrated without
//      them (Yjs would hold it as pending forever, and the room would then
//      reject every new edit as "depends on changes the server does not
//      have"). These are listed as `dependent` before anything is written.
//   3. Deletes the snapshots that include the range and writes a new
//      snapshot at the current serverSeq from the remaining log.
//
// What it cannot do:
//   - Clients that already hold the quarantined changes keep them. A client
//     that re-sends them (a resend of an unacked update, or a reconcile
//     diff) puts them back. Affected collaborators must discard their local
//     replica of the document (the host's reset/rollback path) after this.
//   - Revisions inside or after the range now show history without the
//     quarantined updates.
//
// It refuses while the document's room is loaded on the running server,
// because the room would keep serving the old state, and refuses ranges that
// retention already compacted into a snapshot.

import type { Kysely } from "kysely";
import * as Y from "yjs";

import { writeAudit } from "../auth/access.js";
import type { DB, SubdocColumn } from "../db/types.js";
import { newId } from "../ids.js";
import type { Subdoc } from "../protocol.js";
import { consistentRead, loadSubdocState, writeSnapshot } from "../sync/store.js";
import type { AdminContext, CommandResult } from "./context.js";
import { findDocument } from "./documents.js";
import { CliError, describeChange, compareStates, parseRange } from "./history.js";
import { liveServer, requireRoomUnloaded, roomStatus } from "./live.js";
import { MIGRATION_ACTOR } from "./rebuild.js";

export const QUARANTINE_WARNING = [
  "doc quarantine removes updates from the document's history.",
  "Collaborators who already have those changes keep them and may upload them again;",
  "they must discard their local copy of the document afterwards.",
  "Run with --dry-run first, then again with --yes.",
];

/** Rebuilds the state from `base` plus rows, checkpointing so a rejected row costs at most CHECKPOINT_EVERY re-applies. */
const CHECKPOINT_EVERY = 256;

interface Row {
  server_seq: number;
  update: Uint8Array;
}

export interface SubdocPlan {
  subdoc: Subdoc;
  /** The snapshot the rebuild starts from (null: the log from its start). */
  baseSeq: number | null;
  rangeSeqs: number[];
  dependentSeqs: number[];
  /** The rebuilt state (from the remaining log). */
  doc: Y.Doc;
}

export interface QuarantinePlan {
  from: number;
  to: number;
  lastSeq: number;
  subdocs: SubdocPlan[];
}

function hasPending(doc: Y.Doc): boolean {
  return doc.store.pendingStructs !== null || doc.store.pendingDs !== null;
}

/** Replays `rows` onto `base`, leaving out each row that would stay pending. */
export function replayWithout(base: Uint8Array | null, rows: Row[]): { doc: Y.Doc; dependent: number[] } {
  const fresh = (from: Uint8Array | null) => {
    const doc = new Y.Doc();
    if (from) Y.applyUpdate(doc, from);
    return doc;
  };
  let checkpoint = base;
  let sinceCheckpoint: Row[] = [];
  let doc = fresh(checkpoint);
  const dependent: number[] = [];
  for (const row of rows) {
    Y.applyUpdate(doc, row.update);
    if (hasPending(doc)) {
      dependent.push(Number(row.server_seq));
      doc.destroy();
      doc = fresh(checkpoint);
      for (const kept of sinceCheckpoint) Y.applyUpdate(doc, kept.update);
      continue;
    }
    sinceCheckpoint.push(row);
    if (sinceCheckpoint.length >= CHECKPOINT_EVERY) {
      checkpoint = Y.encodeStateAsUpdate(doc);
      sinceCheckpoint = [];
    }
  }
  return { doc, dependent };
}

export async function planQuarantine(db: Kysely<DB>, docId: string, from: number, to: number): Promise<QuarantinePlan> {
  const document = await db.selectFrom("documents").select("last_server_seq").where("id", "=", docId).executeTakeFirstOrThrow();
  const lastSeq = Number(document.last_server_seq);
  const inRange = await db
    .selectFrom("doc_updates")
    .select(["server_seq", "subdoc"])
    .where("doc_id", "=", docId)
    .where("server_seq", ">=", from)
    .where("server_seq", "<=", to)
    .orderBy("server_seq")
    .execute();
  if (inRange.length === 0) throw new CliError(`No retained updates of ${docId} in ${from}..${to}.`);

  // serverSeq is dense per document, so every seq in the range is either in
  // the log or already quarantined; anything else was pruned by retention
  // and is baked into a snapshot.
  const alreadyQuarantined = await db
    .selectFrom("quarantined_updates")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("doc_id", "=", docId)
    .where("server_seq", ">=", from)
    .where("server_seq", "<=", to)
    .executeTakeFirst();
  const present = inRange.length + Number(alreadyQuarantined?.n ?? 0);
  if (present < Math.min(to, lastSeq) - from + 1) {
    throw new CliError(
      `Part of ${from}..${to} was already compacted into a snapshot by retention; it can no longer be separated. ` +
        "Use doc rebuild instead.",
    );
  }

  const plans: SubdocPlan[] = [];
  for (const subdoc of [...new Set(inRange.map((row) => row.subdoc))]) {
    const rangeSeqs = inRange.filter((row) => row.subdoc === subdoc).map((row) => Number(row.server_seq));
    const base = await db
      .selectFrom("doc_snapshots")
      .select(["upto_server_seq", "state"])
      .where("doc_id", "=", docId)
      .where("subdoc", "=", subdoc)
      .where("upto_server_seq", "<", from)
      .orderBy("upto_server_seq", "desc")
      .limit(1)
      .executeTakeFirst();
    const rows = await db
      .selectFrom("doc_updates")
      .select(["server_seq", "update"])
      .where("doc_id", "=", docId)
      .where("subdoc", "=", subdoc)
      .where("server_seq", ">", base ? Number(base.upto_server_seq) : 0)
      .where((eb) => eb.or([eb("server_seq", "<", from), eb("server_seq", ">", to)]))
      .orderBy("server_seq")
      .execute();
    const { doc, dependent } = replayWithout(base?.state ?? null, rows);
    plans.push({ subdoc, baseSeq: base ? Number(base.upto_server_seq) : null, rangeSeqs, dependentSeqs: dependent, doc });
  }
  return { from, to, lastSeq, subdocs: plans };
}

async function moveRows(trx: Kysely<DB>, docId: string, quarantineId: string, plan: QuarantinePlan): Promise<number> {
  let moved = 0;
  for (const subdocPlan of plan.subdocs) {
    const seqs = [...subdocPlan.rangeSeqs, ...subdocPlan.dependentSeqs];
    for (let index = 0; index < seqs.length; index += 500) {
      const chunk = seqs.slice(index, index + 500);
      const rows = await trx
        .selectFrom("doc_updates")
        .selectAll()
        .where("doc_id", "=", docId)
        .where("server_seq", "in", chunk)
        .execute();
      if (rows.length === 0) continue;
      await trx
        .insertInto("quarantined_updates")
        .values(
          rows.map((row) => ({
            doc_id: row.doc_id,
            subdoc: row.subdoc,
            server_seq: row.server_seq,
            account_id: row.account_id,
            client_id: row.client_id,
            client_seq: row.client_seq,
            actor: JSON.stringify(row.actor),
            provenance: row.provenance === null ? null : JSON.stringify(row.provenance),
            update: row.update,
            size: row.size,
            received_at: row.received_at,
            quarantine_id: quarantineId,
            reason: Number(row.server_seq) >= plan.from && Number(row.server_seq) <= plan.to ? ("range" as const) : ("dependent" as const),
          })),
        )
        .execute();
      await trx.deleteFrom("doc_updates").where("doc_id", "=", docId).where("server_seq", "in", chunk).execute();
      moved += rows.length;
    }
  }
  return moved;
}

export async function docQuarantine(ctx: AdminContext): Promise<CommandResult> {
  const docId = ctx.args.positional(2, "docId");
  const range = parseRange(ctx.args.string("range"), "--range");
  if (range.to === null) throw new CliError("--range needs an end: quarantine an explicit range like 120..180.");
  const { from, to } = { from: range.from, to: range.to };
  const dryRun = ctx.args.has("dry-run");
  if (!dryRun && !ctx.args.has("yes")) throw new CliError(QUARANTINE_WARNING.join("\n"));
  const { db } = ctx;
  const document = await findDocument(db, docId);

  const live = liveServer(ctx.config, ctx.args.string("server"));
  if (!dryRun) await requireRoomUnloaded(live, docId, ctx.args.has("server-stopped"));

  const subdocsBefore = new Map<Subdoc, Y.Doc>();
  const quarantineId = newId("qrn");
  const run = async (trx: Kysely<DB>) => {
    const plan = await planQuarantine(trx, docId, from, to);
    for (const entry of plan.subdocs) subdocsBefore.set(entry.subdoc, await loadSubdocState(trx, docId, entry.subdoc, plan.lastSeq));
    if (dryRun) return { plan, moved: 0 };
    const moved = await moveRows(trx, docId, quarantineId, plan);
    for (const entry of plan.subdocs) {
      await trx
        .deleteFrom("doc_snapshots")
        .where("doc_id", "=", docId)
        .where("subdoc", "=", entry.subdoc as SubdocColumn)
        .where("upto_server_seq", ">=", from)
        .execute();
      await writeSnapshot(trx, docId, entry.subdoc, plan.lastSeq, entry.doc);
      // The new storage must load cleanly: snapshot plus nothing after it.
      const check = await loadSubdocState(trx, docId, entry.subdoc, plan.lastSeq);
      const clean = !hasPending(check);
      check.destroy();
      if (!clean) throw new CliError(`${entry.subdoc} still has unintegrable updates after the quarantine; nothing was changed.`);
    }
    await writeAudit(trx, {
      projectId: document.project_id,
      actor: MIGRATION_ACTOR,
      accountId: null,
      action: "admin.document.quarantine",
      target: docId,
      details: {
        quarantineId,
        from,
        to,
        moved,
        subdocs: plan.subdocs.map((entry) => ({ subdoc: entry.subdoc, range: entry.rangeSeqs.length, dependent: entry.dependentSeqs })),
      },
    });
    return { plan, moved };
  };

  const { plan, moved } = dryRun ? await consistentRead(db, run) : await db.transaction().execute(run);
  try {
    const text = [
      dryRun ? `Dry run: quarantining ${from}..${to} of ${docId} would move:` : `Quarantined ${moved} updates of ${docId} (run ${quarantineId}):`,
    ];
    for (const entry of plan.subdocs) {
      text.push(
        `  ${entry.subdoc}: ${entry.rangeSeqs.length} in range, ${entry.dependentSeqs.length} dependent` +
          (entry.dependentSeqs.length > 0 ? ` (${entry.dependentSeqs.join(", ")})` : "") +
          `; rebuilt from ${entry.baseSeq === null ? "the start of the log" : `the snapshot at ${entry.baseSeq}`}`,
      );
      const before = subdocsBefore.get(entry.subdoc);
      if (before) text.push(...describeChange(compareStates(entry.subdoc, before, entry.doc)).map((line) => `  ${line}`));
    }
    if (!dryRun) {
      text.push(...QUARANTINE_WARNING.slice(1, 3).map((line) => `Note: ${line}`));
      const after = await roomStatus(live, docId).catch(() => null);
      if (after?.loaded) ctx.note(`Warning: ${docId} was opened on the running server meanwhile; restart the server.`);
    } else {
      text.push(`Run again with --yes to apply.`);
    }
    return {
      data: {
        docId,
        from,
        to,
        dryRun,
        quarantineId: dryRun ? null : quarantineId,
        moved,
        subdocs: plan.subdocs.map((entry) => ({
          subdoc: entry.subdoc,
          baseSeq: entry.baseSeq,
          rangeSeqs: entry.rangeSeqs,
          dependentSeqs: entry.dependentSeqs,
        })),
      },
      text,
    };
  } finally {
    for (const entry of plan.subdocs) entry.doc.destroy();
    for (const doc of subdocsBefore.values()) doc.destroy();
  }
}

