// Persistence of the update log and snapshots (doc_updates, doc_snapshots).
//
// Every write that assigns a serverSeq goes through persistUpdate, and every
// sub-document state is rebuilt with loadSubdocState, so the sync rooms, the
// compaction job and revision reconstruction agree on what a seq means.

import type { Kysely } from "kysely";
import * as Y from "yjs";

import type { DB } from "../db/types.js";
import type { Actor, DocKind, Provenance, Subdoc } from "../protocol.js";

export type DocumentKind = DocKind | "manifest";

/** The sub-documents a document of `kind` is made of. */
export function subdocsForKind(kind: DocumentKind): Subdoc[] {
  return kind === "manifest" ? ["manifest"] : ["content", "annotations", "meta"];
}

/**
 * Reads several things that must agree with each other (a document row, its
 * snapshots and its log). On Postgres a repeatable-read transaction gives one
 * consistent view even while compaction or a room writes; PGlite has a single
 * connection, so its transactions are serialized anyway.
 */
export function consistentRead<T>(db: Kysely<DB>, read: (trx: Kysely<DB>) => Promise<T>): Promise<T> {
  return db.transaction().setIsolationLevel("repeatable read").execute(read);
}

/**
 * Rebuilds one sub-document from its latest snapshot plus the updates after
 * it. With `uptoSeq`, rebuilds the state as of that serverSeq instead (the
 * latest snapshot at or below it, plus the updates up to it).
 */
export async function loadSubdocState(
  db: Kysely<DB>,
  docId: string,
  subdoc: Subdoc,
  uptoSeq?: number,
): Promise<Y.Doc> {
  let snapshotQuery = db
    .selectFrom("doc_snapshots")
    .select(["upto_server_seq", "state"])
    .where("doc_id", "=", docId)
    .where("subdoc", "=", subdoc);
  if (uptoSeq !== undefined) snapshotQuery = snapshotQuery.where("upto_server_seq", "<=", uptoSeq);
  const snapshot = await snapshotQuery.orderBy("upto_server_seq", "desc").limit(1).executeTakeFirst();

  let updatesQuery = db
    .selectFrom("doc_updates")
    .select("update")
    .where("doc_id", "=", docId)
    .where("subdoc", "=", subdoc)
    .where("server_seq", ">", snapshot?.upto_server_seq ?? 0);
  if (uptoSeq !== undefined) updatesQuery = updatesQuery.where("server_seq", "<=", uptoSeq);
  const updates = await updatesQuery.orderBy("server_seq").execute();

  const doc = new Y.Doc();
  doc.transact(() => {
    if (snapshot) Y.applyUpdate(doc, snapshot.state);
    for (const row of updates) Y.applyUpdate(doc, row.update);
  });
  return doc;
}

export interface LoadedDocument {
  projectId: string;
  kind: DocumentKind;
  schemaVersion: number;
  serverSeq: number;
  docs: Map<Subdoc, Y.Doc>;
}

/** Loads every sub-document of a live document, or null when it is missing or deleted. */
export async function loadDocument(db: Kysely<DB>, docId: string): Promise<LoadedDocument | null> {
  return consistentRead(db, async (trx) => {
    const row = await trx
      .selectFrom("documents")
      .select(["project_id", "kind", "schema_version", "last_server_seq", "deleted_at"])
      .where("id", "=", docId)
      .executeTakeFirst();
    if (!row || row.deleted_at) return null;
    const docs = new Map<Subdoc, Y.Doc>();
    for (const subdoc of subdocsForKind(row.kind)) {
      docs.set(subdoc, await loadSubdocState(trx, docId, subdoc, row.last_server_seq));
    }
    return {
      projectId: row.project_id,
      kind: row.kind,
      schemaVersion: row.schema_version,
      serverSeq: row.last_server_seq,
      docs,
    };
  });
}

export interface PersistInput {
  docId: string;
  subdoc: Subdoc;
  accountId: string | null;
  clientId: string;
  /** Omitted for server-applied updates, which use the new serverSeq. */
  clientSeq?: number;
  actor: Actor;
  provenance: Provenance | undefined;
  update: Uint8Array;
  /** File documents removed by this manifest update, tombstoned in the same transaction. */
  removedDocIds?: string[];
}

/**
 * Appends one update and bumps documents.last_server_seq in one transaction.
 * The row update takes the document's row lock, so seqs are gap-free and
 * commit in order even if two writers ever raced. Returns null when the
 * document no longer exists.
 */
export async function persistUpdate(db: Kysely<DB>, input: PersistInput): Promise<number | null> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable("documents")
      .set((eb) => ({ last_server_seq: eb("last_server_seq", "+", 1) }))
      .where("id", "=", input.docId)
      .where("deleted_at", "is", null)
      .returning(["last_server_seq", "project_id"])
      .executeTakeFirst();
    if (!row) return null;
    const serverSeq = row.last_server_seq;
    await trx
      .insertInto("doc_updates")
      .values({
        doc_id: input.docId,
        subdoc: input.subdoc,
        server_seq: serverSeq,
        account_id: input.accountId,
        client_id: input.clientId,
        client_seq: input.clientSeq ?? serverSeq,
        actor: JSON.stringify(input.actor),
        provenance: input.provenance ? JSON.stringify(input.provenance) : null,
        update: input.update,
        size: input.update.length,
      })
      .execute();
    if (input.subdoc === "manifest" && input.removedDocIds?.length) {
      await trx.updateTable("documents").set({ deleted_at: new Date() })
        .where("project_id", "=", row.project_id)
        .where("kind", "!=", "manifest")
        .where("id", "in", input.removedDocIds)
        .where("deleted_at", "is", null)
        .execute();
    }
    return serverSeq;
  });
}

/** The update a client already sent with this clientSeq, if any. */
export async function findPersisted(
  db: Kysely<DB>,
  docId: string,
  clientId: string,
  clientSeq: number,
): Promise<{ serverSeq: number; accountId: string | null; subdoc: Subdoc } | null> {
  const row = await db
    .selectFrom("doc_updates")
    .select(["server_seq", "account_id", "subdoc"])
    .where("doc_id", "=", docId)
    .where("client_id", "=", clientId)
    .where("client_seq", "=", clientSeq)
    .executeTakeFirst();
  return row ? { serverSeq: row.server_seq, accountId: row.account_id, subdoc: row.subdoc } : null;
}

/** Writes a snapshot of `doc` as of `uptoSeq`. Existing snapshots at that seq are kept. */
export async function writeSnapshot(
  db: Kysely<DB>,
  docId: string,
  subdoc: Subdoc,
  uptoSeq: number,
  doc: Y.Doc,
): Promise<void> {
  await db
    .insertInto("doc_snapshots")
    .values({
      doc_id: docId,
      subdoc,
      upto_server_seq: uptoSeq,
      state: Y.encodeStateAsUpdate(doc),
      state_vector: Y.encodeStateVector(doc),
    })
    .onConflict((oc) => oc.columns(["doc_id", "subdoc", "upto_server_seq"]).doNothing())
    .execute();
}
