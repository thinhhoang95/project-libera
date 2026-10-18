// verify [--doc <id>] [--project <id>] [--include-deleted] [--expect counts.json] [--blobs]
//
// Checks that the database can serve every document, for the restore drill
// (ops/collab/backup/restore-drill.sh) and after any manual repair. Read-only.
// Works on Postgres and PGlite.
//
// For each document and sub-document:
//   1. documents.last_server_seq is at or above every update and snapshot.
//   2. Each update's size column matches its bytes.
//   3. Every snapshot decodes, has nothing pending, and its stored state
//      vector matches its state.
//   4. Replaying the retained log from the retention boundary (or from
//      nothing) integrates every update, and reproduces every later snapshot
//      at its seq exactly (same state vector, same content).
//   5. The state a room would load (latest snapshot plus tail) equals the
//      replayed state: the text reconstructs.
// Then, optionally, the table counts equal the ones recorded at backup time
// (--expect) and every recorded blob is in the blob store (--blobs).

import { readFile } from "node:fs/promises";

import { sql, type Kysely } from "kysely";
import * as Y from "yjs";

import { createBlobStore, type BlobStore } from "../blobs/index.js";
import type { DB, DocumentRow } from "../db/types.js";
import { canonicalJson, ManifestKeys, type ManifestEntry, type Subdoc } from "../protocol.js";
import { loadSubdocState, subdocsForKind } from "../sync/store.js";
import { table, type AdminContext, type CommandResult } from "./context.js";
import { CliError, logBounds, plainState } from "./history.js";

/** Tables whose row counts the backup records and the drill compares. */
export const COUNTED_TABLES = [
  "accounts",
  "projects",
  "memberships",
  "documents",
  "doc_updates",
  "doc_snapshots",
  "revisions",
  "blobs",
  "threads",
  "messages",
  "suggestions",
  "reviews",
  "audit_log",
  "quarantined_updates",
] as const;

export interface VerifyProblem {
  docId: string | null;
  subdoc: Subdoc | null;
  check: string;
  detail: string;
}

export interface VerifyReport {
  ok: boolean;
  documents: number;
  subdocs: number;
  updatesReplayed: number;
  snapshotsChecked: number;
  counts: Record<string, number>;
  /** Blobs checked against the blob store (--blobs), or null when not checked. */
  blobsChecked: number | null;
  failures: VerifyProblem[];
  warnings: VerifyProblem[];
}

function sameState(a: Y.Doc, b: Y.Doc, subdoc: Subdoc): boolean {
  return (
    Buffer.from(Y.encodeStateVector(a)).equals(Buffer.from(Y.encodeStateVector(b))) &&
    canonicalJson(plainState(a, subdoc)) === canonicalJson(plainState(b, subdoc))
  );
}

function pending(doc: Y.Doc): boolean {
  return doc.store.pendingStructs !== null || doc.store.pendingDs !== null;
}

function fromUpdate(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
}

async function verifySubdoc(db: Kysely<DB>, document: DocumentRow, subdoc: Subdoc, report: VerifyReport): Promise<void> {
  const docId = document.id;
  const lastSeq = Number(document.last_server_seq);
  const fail = (check: string, detail: string) => report.failures.push({ docId, subdoc, check, detail });

  const snapshots = await db
    .selectFrom("doc_snapshots")
    .select(["upto_server_seq", "state", "state_vector"])
    .where("doc_id", "=", docId)
    .where("subdoc", "=", subdoc)
    .orderBy("upto_server_seq")
    .execute();
  const updates = await db
    .selectFrom("doc_updates")
    .select(["server_seq", "update", "size"])
    .where("doc_id", "=", docId)
    .where("subdoc", "=", subdoc)
    .orderBy("server_seq")
    .execute();
  report.subdocs += 1;

  const maxUpdate = updates.length > 0 ? Number(updates[updates.length - 1].server_seq) : 0;
  const maxSnapshot = snapshots.length > 0 ? Number(snapshots[snapshots.length - 1].upto_server_seq) : 0;
  if (maxUpdate > lastSeq || maxSnapshot > lastSeq) {
    fail("seq", `last_server_seq ${lastSeq} is below update ${maxUpdate} / snapshot ${maxSnapshot}`);
  }
  for (const row of updates) {
    if (row.size !== row.update.byteLength) fail("size", `update ${row.server_seq}: size ${row.size} but ${row.update.byteLength} bytes`);
  }

  // 3. Snapshots on their own.
  const decoded = new Map<number, Y.Doc>();
  try {
    for (const snapshot of snapshots) {
      const seq = Number(snapshot.upto_server_seq);
      report.snapshotsChecked += 1;
      let doc: Y.Doc;
      try {
        doc = fromUpdate(snapshot.state);
      } catch (error) {
        fail("snapshot-decode", `snapshot at ${seq}: ${(error as Error).message}`);
        continue;
      }
      decoded.set(seq, doc);
      if (pending(doc)) fail("snapshot-pending", `snapshot at ${seq} holds updates it cannot integrate`);
      if (!Buffer.from(Y.encodeStateVector(doc)).equals(Buffer.from(snapshot.state_vector))) {
        fail("snapshot-vector", `snapshot at ${seq}: stored state vector does not match its state`);
      }
    }

    // 4. Replay the retained log from the retention boundary.
    const bounds = await logBounds(db, docId, subdoc);
    const base = bounds.base === null ? null : decoded.get(bounds.base);
    const running = new Y.Doc();
    try {
      if (base) Y.applyUpdate(running, Y.encodeStateAsUpdate(base));
      const later = snapshots.map((s) => Number(s.upto_server_seq)).filter((seq) => bounds.base === null || seq > bounds.base);
      let next = 0;
      const compareUpTo = (seq: number) => {
        while (next < later.length && later[next] <= seq) {
          const snapshot = decoded.get(later[next]);
          if (snapshot && !sameState(running, snapshot, subdoc)) {
            fail("snapshot-log", `snapshot at ${later[next]} differs from the log replayed up to it`);
          }
          next += 1;
        }
      };
      for (const row of updates) {
        compareUpTo(Number(row.server_seq) - 1);
        try {
          Y.applyUpdate(running, row.update);
        } catch (error) {
          fail("update-decode", `update ${row.server_seq}: ${(error as Error).message}`);
        }
        report.updatesReplayed += 1;
      }
      compareUpTo(Number.MAX_SAFE_INTEGER);
      if (pending(running)) fail("log-pending", "the retained log has updates that depend on missing ones");

      // 5. What a room loads.
      let loaded: Y.Doc | undefined;
      try {
        loaded = await loadSubdocState(db, docId, subdoc, lastSeq);
        if (pending(loaded)) fail("load-pending", "the loaded state holds updates it cannot integrate");
        if (!sameState(loaded, running, subdoc)) fail("load", "latest snapshot plus tail differs from the replayed log");
      } catch (error) {
        fail("load", (error as Error).message);
      } finally {
        loaded?.destroy();
      }
    } finally {
      running.destroy();
    }
  } finally {
    for (const doc of decoded.values()) doc.destroy();
  }
}

async function verifyManifest(db: Kysely<DB>, document: DocumentRow, report: VerifyReport): Promise<void> {
  const doc = await loadSubdocState(db, document.id, "manifest");
  let entries: ManifestEntry[];
  try {
    entries = Object.values(doc.getMap(ManifestKeys.files).toJSON() as Record<string, ManifestEntry>);
  } finally {
    doc.destroy();
  }
  const docIds = entries.filter((entry) => entry.kind === "doc" && entry.docId).map((entry) => entry.docId as string);
  const hashes = entries.filter((entry) => entry.kind === "blob" && entry.blobHash).map((entry) => entry.blobHash as string);
  const docs = new Set(
    docIds.length === 0
      ? []
      : (await db.selectFrom("documents").select("id").where("project_id", "=", document.project_id).where("id", "in", docIds).execute()).map((row) => row.id),
  );
  const blobs = new Set(
    hashes.length === 0
      ? []
      : (await db.selectFrom("blobs").select("hash").where("project_id", "=", document.project_id).where("hash", "in", hashes).execute()).map((row) => row.hash),
  );
  for (const id of docIds) {
    if (!docs.has(id)) report.warnings.push({ docId: document.id, subdoc: "manifest", check: "manifest-doc", detail: `entry points at missing document ${id}` });
  }
  for (const hash of hashes) {
    if (!blobs.has(hash)) report.warnings.push({ docId: document.id, subdoc: "manifest", check: "manifest-blob", detail: `entry points at unrecorded blob ${hash}` });
  }
}

export async function tableCounts(db: Kysely<DB>): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const name of COUNTED_TABLES) {
    const result = await sql<{ n: number | string }>`select count(*) as n from ${sql.table(name)}`.execute(db);
    counts[name] = Number(result.rows[0]?.n ?? 0);
  }
  return counts;
}

export async function verifyDatabase(
  db: Kysely<DB>,
  options: {
    docId?: string;
    projectId?: string;
    includeDeleted?: boolean;
    expectedCounts?: Record<string, number>;
    blobStore?: BlobStore;
  } = {},
): Promise<VerifyReport> {
  const report: VerifyReport = {
    ok: true,
    documents: 0,
    subdocs: 0,
    updatesReplayed: 0,
    snapshotsChecked: 0,
    counts: await tableCounts(db),
    blobsChecked: null,
    failures: [],
    warnings: [],
  };
  let query = db.selectFrom("documents").selectAll().orderBy("id");
  if (options.docId) query = query.where("id", "=", options.docId);
  if (options.projectId) query = query.where("project_id", "=", options.projectId);
  if (!options.includeDeleted) query = query.where("deleted_at", "is", null);
  // Ids only up front; each document's rows are read when it is checked.
  const documents = await query.execute();
  for (const document of documents) {
    report.documents += 1;
    for (const subdoc of subdocsForKind(document.kind)) {
      try {
        await verifySubdoc(db, document, subdoc, report);
      } catch (error) {
        report.failures.push({ docId: document.id, subdoc, check: "error", detail: (error as Error).message });
      }
    }
    if (document.kind === "manifest") {
      try {
        await verifyManifest(db, document, report);
      } catch (error) {
        report.failures.push({ docId: document.id, subdoc: "manifest", check: "manifest", detail: (error as Error).message });
      }
    }
  }
  if (options.expectedCounts) {
    for (const [name, expected] of Object.entries(options.expectedCounts)) {
      if (!(name in report.counts)) continue;
      if (report.counts[name] !== Number(expected)) {
        report.failures.push({ docId: null, subdoc: null, check: "count", detail: `${name}: ${report.counts[name]} rows, backup recorded ${expected}` });
      }
    }
  }
  if (options.blobStore) {
    report.blobsChecked = 0;
    let blobs = db.selectFrom("blobs").select(["project_id", "hash"]).orderBy("hash");
    if (options.projectId) blobs = blobs.where("project_id", "=", options.projectId);
    const seen = new Set<string>();
    for (const row of await blobs.execute()) {
      if (seen.has(row.hash)) continue;
      seen.add(row.hash);
      report.blobsChecked += 1;
      if (!(await options.blobStore.has(row.hash))) {
        report.failures.push({ docId: null, subdoc: null, check: "blob-missing", detail: `blob ${row.hash} (project ${row.project_id}) is not in the blob store` });
      }
    }
  }
  report.ok = report.failures.length === 0;
  return report;
}

export async function verifyCommand(ctx: AdminContext): Promise<CommandResult> {
  let expectedCounts: Record<string, number> | undefined;
  const expect = ctx.args.string("expect");
  if (expect) {
    try {
      expectedCounts = JSON.parse(await readFile(expect, "utf8")) as Record<string, number>;
    } catch (error) {
      throw new CliError(`Cannot read --expect ${expect}: ${(error as Error).message}`);
    }
  }
  const report = await verifyDatabase(ctx.db, {
    docId: ctx.args.string("doc"),
    projectId: ctx.args.string("project"),
    includeDeleted: ctx.args.has("include-deleted"),
    expectedCounts,
    blobStore: ctx.args.has("blobs") ? createBlobStore(ctx.config) : undefined,
  });
  const text = [
    `${report.ok ? "PASS" : "FAIL"}: ${report.documents} documents, ${report.subdocs} sub-documents, ` +
      `${report.updatesReplayed} updates replayed, ${report.snapshotsChecked} snapshots checked` +
      (report.blobsChecked === null ? "." : `, ${report.blobsChecked} blobs found.`),
    "",
    "Counts",
    ...table(["TABLE", "ROWS", "EXPECTED"], Object.entries(report.counts).map(([name, n]) => [name, n, expectedCounts?.[name] ?? null])),
  ];
  if (report.failures.length > 0) {
    text.push("", "Failures", ...table(["DOC", "SUBDOC", "CHECK", "DETAIL"], report.failures.map((f) => [f.docId, f.subdoc, f.check, f.detail])));
  }
  if (report.warnings.length > 0) {
    text.push("", "Warnings", ...table(["DOC", "SUBDOC", "CHECK", "DETAIL"], report.warnings.map((w) => [w.docId, w.subdoc, w.check, w.detail])));
  }
  return { data: report, text, exitCode: report.ok ? 0 : 1 };
}
