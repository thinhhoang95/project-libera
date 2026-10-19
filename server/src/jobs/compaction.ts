// Server compaction job (M1.10, decision D6).
//
// 1. Snapshots every sub-document with SNAPSHOT_EVERY_UPDATES or more updates
//    after its latest snapshot, so cold room loads replay a short tail.
// 2. Retention: prunes updates older than LOG_RETENTION_DAYS once a snapshot
//    at the cutoff covers them, and the older snapshots that are not
//    revisions. Before pruning, every revision at or below the cutoff gets a
//    snapshot at exactly its serverSeq, so it can still be rebuilt.
//
// It is safe while rooms are live without taking their locks: it only reads
// committed rows inside one consistent transaction and never changes what a
// room would load. A snapshot at seq S equals snapshot-before-S plus the log
// up to S, and an update is deleted only when a snapshot at or after it
// exists, so "latest snapshot + tail" is the same state before and after.

import { sql, type Kysely } from "kysely";

import type { ServerContext } from "../context.js";
import type { DB } from "../db/types.js";
import type { Subdoc } from "../protocol.js";
import { consistentRead, loadSubdocState, subdocsForKind, writeSnapshot } from "../sync/store.js";
import type { Job } from "./index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const compactionJob: Job = {
  name: "compaction",
  intervalMs: 5 * 60_000,
  async run(context) {
    await snapshotBusySubdocs(context);
    await applyRetention(context);
  },
};

async function snapshotBusySubdocs(context: ServerContext): Promise<void> {
  const { db, config } = context;
  const candidates = await db
    .selectFrom("doc_updates as u")
    .select(["u.doc_id", "u.subdoc"])
    .where(
      "u.server_seq",
      ">",
      sql<number>`coalesce((select max(s.upto_server_seq) from doc_snapshots s where s.doc_id = u.doc_id and s.subdoc = u.subdoc), 0)`,
    )
    .groupBy(["u.doc_id", "u.subdoc"])
    .having(sql<number>`count(*)`, ">=", config.SNAPSHOT_EVERY_UPDATES)
    .execute();

  for (const { doc_id: docId, subdoc } of candidates) {
    await consistentRead(db, async (trx) => {
      const row = await trx
        .selectFrom("documents")
        .select("last_server_seq")
        .where("id", "=", docId)
        .executeTakeFirst();
      if (!row) return;
      const doc = await loadSubdocState(trx, docId, subdoc, row.last_server_seq);
      try {
        await writeSnapshot(trx, docId, subdoc, row.last_server_seq, doc);
      } finally {
        doc.destroy();
      }
    });
    context.log.debug({ docId, subdoc }, "Snapshot written");
  }
}

async function applyRetention(context: ServerContext): Promise<void> {
  const { db, config } = context;
  const cutoff = new Date(Date.now() - config.LOG_RETENTION_DAYS * DAY_MS);
  const docs = await db
    .selectFrom("doc_updates")
    .innerJoin("documents", "documents.id", "doc_updates.doc_id")
    .select(["doc_updates.doc_id", "documents.kind"])
    .select((eb) => eb.fn.max("doc_updates.server_seq").as("cutoff_seq"))
    .where("doc_updates.received_at", "<", cutoff)
    .groupBy(["doc_updates.doc_id", "documents.kind"])
    .execute();

  for (const { doc_id: docId, kind, cutoff_seq } of docs) {
    const cutoffSeq = Number(cutoff_seq);
    await consistentRead(db, async (trx) => {
      const revisionSeqs = await snapshotRevisions(trx, docId, subdocsForKind(kind), cutoffSeq);
      for (const subdoc of subdocsForKind(kind)) {
        const boundary = await retentionBoundary(trx, docId, subdoc, cutoffSeq);
        if (boundary === null) continue;
        await trx
          .deleteFrom("doc_updates")
          .where("doc_id", "=", docId)
          .where("subdoc", "=", subdoc)
          .where("server_seq", "<=", boundary)
          .where("received_at", "<", cutoff)
          .execute();
        // Past the log window only revision snapshots are kept (D6); the
        // boundary snapshot replaces the older ones.
        let prune = trx
          .deleteFrom("doc_snapshots")
          .where("doc_id", "=", docId)
          .where("subdoc", "=", subdoc)
          .where("upto_server_seq", "<", boundary);
        if (revisionSeqs.length > 0) prune = prune.where("upto_server_seq", "not in", revisionSeqs);
        await prune.execute();
      }
    });
  }
}

/**
 * The seq up to which a sub-document's log may be pruned: a snapshot at the
 * cutoff, written now if old updates after the last snapshot exist. Updates
 * after the cutoff stay, so a revision above it is that snapshot plus the
 * retained tail. Returns null when the sub-document has nothing old.
 */
async function retentionBoundary(trx: Kysely<DB>, docId: string, subdoc: Subdoc, cutoffSeq: number): Promise<number | null> {
  const latest = await trx
    .selectFrom("doc_snapshots")
    .select((eb) => eb.fn.max("upto_server_seq").as("seq"))
    .where("doc_id", "=", docId)
    .where("subdoc", "=", subdoc)
    .where("upto_server_seq", "<=", cutoffSeq)
    .executeTakeFirst();
  const covered = latest?.seq === null || latest?.seq === undefined ? null : Number(latest.seq);
  const uncovered = await trx
    .selectFrom("doc_updates")
    .select("server_seq")
    .where("doc_id", "=", docId)
    .where("subdoc", "=", subdoc)
    .where("server_seq", ">", covered ?? 0)
    .where("server_seq", "<=", cutoffSeq)
    .limit(1)
    .executeTakeFirst();
  if (!uncovered) return covered;
  const doc = await loadSubdocState(trx, docId, subdoc, cutoffSeq);
  try {
    await writeSnapshot(trx, docId, subdoc, cutoffSeq, doc);
  } finally {
    doc.destroy();
  }
  return cutoffSeq;
}

/** Gives every revision at or below `cutoffSeq` a snapshot at exactly its seq. Returns those seqs. */
async function snapshotRevisions(trx: Kysely<DB>, docId: string, subdocs: Subdoc[], cutoffSeq: number): Promise<number[]> {
  const revisions = await trx
    .selectFrom("revisions")
    .select("server_seq")
    .distinct()
    .where("doc_id", "=", docId)
    .where("server_seq", "<=", cutoffSeq)
    .orderBy("server_seq")
    .execute();
  for (const { server_seq: seq } of revisions) {
    for (const subdoc of subdocs) {
      const exists = await trx
        .selectFrom("doc_snapshots")
        .select("upto_server_seq")
        .where("doc_id", "=", docId)
        .where("subdoc", "=", subdoc)
        .where("upto_server_seq", "=", seq)
        .executeTakeFirst();
      if (exists) continue;
      const doc = await loadSubdocState(trx, docId, subdoc, seq);
      try {
        await writeSnapshot(trx, docId, subdoc, seq, doc);
      } finally {
        doc.destroy();
      }
    }
  }
  return revisions.map((row) => row.server_seq);
}
