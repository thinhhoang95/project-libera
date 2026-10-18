// The host's local SQLite store (source plan §5.1, collaboration map §8).
//
// Durability rules:
// - Every append is its own committed transaction and returns only after the
//   commit. With WAL and synchronous=FULL a commit is on disk when it returns,
//   which is what lets the UI say "Saved on this device".
// - One process owns a database file. A second host on the same file fails
//   at open with HostStoreLockedError instead of interleaving writes.

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";

import type { Command } from "../../../src/lib/collab/protocol/api";
import type { Provenance } from "../../../src/lib/collab/protocol/actor";
import type { Role, Subdoc } from "../../../src/lib/collab/protocol/roles";
import { isRole, isSubdoc } from "../../../src/lib/collab/protocol/roles";
import {
  asBytes,
  asNullableNumber,
  asNullableString,
  asNumber,
  openDatabase,
  type DatabaseSync,
  type SqlValue,
  type StatementSync,
} from "./sqlite";

/** Where an update in the log came from. Stored as JSON in `updates.origin`. */
export type UpdateOrigin =
  | { kind: "local"; provenance?: Provenance }
  | { kind: "remote"; userId: string; clientId: string; provenance?: Provenance }
  /** State the server sent in `opened` (catch-up, not a live update). */
  | { kind: "server" };

export interface UpdateRow {
  localSeq: number;
  docId: string;
  subdoc: Subdoc;
  update: Uint8Array;
  origin: UpdateOrigin | null;
  createdAt: number;
  ackedServerSeq: number | null;
}

export interface SnapshotRow {
  docId: string;
  subdoc: Subdoc;
  uptoLocalSeq: number;
  state: Uint8Array;
  stateVector: Uint8Array;
  createdAt: number;
}

export interface OutboundBatch {
  docId: string;
  subdoc: Subdoc;
  clientSeq: number;
  /** The exact bytes sent; a resend must reuse them so the server dedupes. */
  update: Uint8Array;
  provenance?: Provenance;
  localSeqs: number[];
  createdAt: number;
}

export type DocKindTag = "file" | "manifest";
export type ReadOnlyReason = "schema-newer" | "access-revoked";

export interface DocMetaRow {
  docId: string;
  projectId: string | null;
  kind: DocKindTag | null;
  schemaVersion: number | null;
  role: Role | null;
  lastSeenServerSeq: number;
  nextClientSeq: number;
  lastOpenedAt: number | null;
  readOnlyReason: ReadOnlyReason | null;
}

export interface PendingCommandRow {
  id: string;
  kind: string;
  command: Command;
  createdAt: number;
  attempts: number;
  lastError: string | null;
}

export interface ThreadCacheRow {
  threadId: string;
  docId: string;
  json: unknown;
  updatedAt: number;
}

export interface ProjectRow {
  projectId: string;
  name: string;
  localRoot: string | null;
  role: Role | null;
}

export interface DocRecordRow {
  docId: string;
  projectId: string;
  fileId: string | null;
  path: string | null;
  materializedHash: string | null;
}

export interface BlobCacheRow {
  hash: string;
  localPath: string;
  size: number;
}

export interface RejectedEditRow {
  docId: string;
  subdoc: Subdoc;
  reason: string;
  message: string;
  /** The sub-document's text (content) or JSON (maps) just before the rollback. */
  rejectedText: string;
  at: number;
}

export class HostStoreLockedError extends Error {
  constructor(
    readonly lockPath: string,
    readonly ownerPid: number,
  ) {
    super(
      `The collaboration database is already open in another Libera process (pid ${ownerPid}). ` +
        `Close it first; if no such process exists, delete ${lockPath}.`,
    );
    this.name = "HostStoreLockedError";
  }
}

export interface HostStoreOptions {
  /** Database file path, or ":memory:" for tests that need no durability. */
  path: string;
  busyTimeoutMs?: number;
  now?: () => number;
}

// Each entry upgrades user_version N to N+1. Never edit a shipped entry.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE updates (
    local_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    subdoc TEXT NOT NULL,
    "update" BLOB NOT NULL,
    origin TEXT,
    created_at INTEGER NOT NULL,
    acked_server_seq INTEGER
  );
  CREATE INDEX updates_doc ON updates (doc_id, subdoc, local_seq);
  CREATE INDEX updates_unacked ON updates (doc_id, local_seq) WHERE acked_server_seq IS NULL;

  -- A snapshot's state is stored in parts so that writing a large one is a
  -- series of small commits; the snapshots row is written last and makes
  -- the parts visible. Parts without a row are leftovers of an aborted write.
  CREATE TABLE snapshots (
    doc_id TEXT NOT NULL,
    subdoc TEXT NOT NULL,
    upto_local_seq INTEGER NOT NULL,
    state_vector BLOB NOT NULL,
    size INTEGER NOT NULL,
    parts INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (doc_id, subdoc, upto_local_seq)
  );

  CREATE TABLE snapshot_parts (
    doc_id TEXT NOT NULL,
    subdoc TEXT NOT NULL,
    upto_local_seq INTEGER NOT NULL,
    part INTEGER NOT NULL,
    bytes BLOB NOT NULL,
    PRIMARY KEY (doc_id, subdoc, upto_local_seq, part)
  );

  CREATE TABLE outbound_batches (
    doc_id TEXT NOT NULL,
    client_seq INTEGER NOT NULL,
    subdoc TEXT NOT NULL,
    "update" BLOB NOT NULL,
    provenance TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (doc_id, client_seq)
  );

  CREATE TABLE outbound (
    doc_id TEXT NOT NULL,
    subdoc TEXT NOT NULL,
    client_seq INTEGER NOT NULL,
    local_seq INTEGER NOT NULL,
    PRIMARY KEY (doc_id, client_seq, local_seq),
    FOREIGN KEY (doc_id, client_seq) REFERENCES outbound_batches (doc_id, client_seq) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX outbound_local ON outbound (local_seq);

  CREATE TABLE doc_meta (
    doc_id TEXT PRIMARY KEY,
    project_id TEXT,
    doc_kind TEXT,
    schema_version INTEGER,
    role TEXT,
    last_seen_server_seq INTEGER NOT NULL DEFAULT 0,
    next_client_seq INTEGER NOT NULL DEFAULT 1,
    last_opened_at INTEGER,
    read_only_reason TEXT
  );

  CREATE TABLE threads_cache (
    thread_id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX threads_cache_doc ON threads_cache (doc_id);

  CREATE TABLE pending_commands (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );

  CREATE TABLE projects (
    project_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    local_root TEXT,
    role TEXT
  );

  CREATE TABLE docs (
    doc_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    file_id TEXT,
    path TEXT,
    materialized_hash TEXT
  );
  CREATE INDEX docs_project ON docs (project_id);

  CREATE TABLE blobs_cache (
    hash TEXT PRIMARY KEY,
    local_path TEXT NOT NULL,
    size INTEGER NOT NULL
  );

  -- Text a reject rollback removed, kept until the user copies or dismisses it.
  CREATE TABLE rejected_edits (
    doc_id TEXT NOT NULL,
    subdoc TEXT NOT NULL,
    reason TEXT NOT NULL,
    message TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (doc_id, subdoc)
  );
  `,
];

export const STORE_SCHEMA_VERSION = MIGRATIONS.length;

/** Snapshot part size: small enough that one part's commit stays well under the 10 ms task budget. */
export const SNAPSHOT_PART_BYTES = 64 * 1024;

export function splitParts(bytes: Uint8Array, partBytes: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += partBytes) parts.push(bytes.subarray(offset, offset + partBytes));
  if (parts.length === 0) parts.push(new Uint8Array(0));
  return parts;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** An owner lock file next to the database: `<db>.lock` holding the owner's pid. */
class OwnerLock {
  private readonly token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  private held = false;

  constructor(readonly path: string) {}

  acquire(): void {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.path, "wx");
        try {
          writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), token: this.token }));
        } finally {
          closeSync(fd);
        }
        this.held = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const owner = this.readOwner();
      // A lock from a live process (including another store in this process)
      // is real. A dead owner crashed or was killed: its lock is stale.
      if (owner && processAlive(owner.pid)) throw new HostStoreLockedError(this.path, owner.pid);
      try {
        unlinkSync(this.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const owner = this.readOwner();
    throw new HostStoreLockedError(this.path, owner?.pid ?? -1);
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      if (this.readOwner()?.token === this.token) unlinkSync(this.path);
    } catch {
      // A missing lock file is already released.
    }
  }

  private readOwner(): { pid: number; token: string } | null {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as { pid?: unknown; token?: unknown };
      if (typeof parsed.pid !== "number") return null;
      return { pid: parsed.pid, token: String(parsed.token ?? "") };
    } catch {
      // A lock file being written right now, or garbage: treat as unowned
      // only if it stays unreadable (the caller retries once).
      return null;
    }
  }
}

function parseJson<T>(text: unknown): T | null {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function subdocOf(value: unknown): Subdoc {
  if (!isSubdoc(value)) throw new Error(`Corrupt subdoc in store: ${String(value)}`);
  return value;
}

export class HostStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly lock: OwnerLock | null;
  private readonly now: () => number;
  private readonly statements = new Map<string, StatementSync>();
  private inTransaction = false;
  private closed = false;

  constructor(options: HostStoreOptions) {
    this.path = options.path;
    this.now = options.now ?? Date.now;
    const memory = options.path === ":memory:";
    this.lock = memory ? null : new OwnerLock(`${options.path}.lock`);
    this.lock?.acquire();
    try {
      this.db = openDatabase(options.path);
      this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))}`);
      if (!memory) this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = FULL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.migrate();
    } catch (error) {
      this.lock?.release();
      throw error;
    }
  }

  // ------------------------------------------------------------ plumbing

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private run(sql: string, ...values: SqlValue[]) {
    return this.statement(sql).run(...values);
  }

  private get(sql: string, ...values: SqlValue[]) {
    return this.statement(sql).get(...values);
  }

  private all(sql: string, ...values: SqlValue[]) {
    return this.statement(sql).all(...values);
  }

  /** Runs `fn` in one IMMEDIATE transaction; returns after COMMIT. */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The failed statement may already have rolled the transaction back.
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  private migrate(): void {
    const current = asNumber(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (current > MIGRATIONS.length) {
      throw new Error(
        `The collaboration database was written by a newer Libera (schema ${current}, this build knows ${MIGRATIONS.length}).`,
      );
    }
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version]);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  schemaVersion(): number {
    return asNumber(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  }

  pragma(name: "journal_mode" | "synchronous" | "foreign_keys" | "busy_timeout"): unknown {
    const row = this.db.prepare(`PRAGMA ${name}`).get();
    return row ? Object.values(row)[0] : undefined;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    try {
      // Fold the WAL back so the file is self-contained after a clean exit.
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Checkpointing is an optimization; the WAL is replayed on next open.
    }
    this.db.close();
    this.lock?.release();
  }

  // ------------------------------------------------------------ updates

  private rowToUpdate(row: Record<string, unknown>): UpdateRow {
    return {
      localSeq: asNumber(row.local_seq),
      docId: String(row.doc_id),
      subdoc: subdocOf(row.subdoc),
      update: asBytes(row.update),
      origin: parseJson<UpdateOrigin>(row.origin),
      createdAt: asNumber(row.created_at),
      ackedServerSeq: asNullableNumber(row.acked_server_seq),
    };
  }

  /** Appends a local edit and commits. Returns its local_seq. */
  appendLocal(docId: string, subdoc: Subdoc, update: Uint8Array, provenance?: Provenance): number {
    const origin: UpdateOrigin = provenance ? { kind: "local", provenance } : { kind: "local" };
    const result = this.run(
      `INSERT INTO updates (doc_id, subdoc, "update", origin, created_at, acked_server_seq) VALUES (?, ?, ?, ?, ?, NULL)`,
      docId,
      subdoc,
      update,
      JSON.stringify(origin),
      this.now(),
    );
    return asNumber(result.lastInsertRowid);
  }

  /** Appends an update the server already persisted (remote or opened diff) and commits. */
  appendAcked(docId: string, subdoc: Subdoc, update: Uint8Array, origin: UpdateOrigin, serverSeq: number): number {
    return this.transaction(() => {
      const result = this.run(
        `INSERT INTO updates (doc_id, subdoc, "update", origin, created_at, acked_server_seq) VALUES (?, ?, ?, ?, ?, ?)`,
        docId,
        subdoc,
        update,
        JSON.stringify(origin),
        this.now(),
        serverSeq,
      );
      this.bumpServerSeq(docId, serverSeq);
      return asNumber(result.lastInsertRowid);
    });
  }

  /** Records that the server has persisted up to `serverSeq` for this doc. */
  noteServerSeq(docId: string, serverSeq: number): void {
    this.transaction(() => this.bumpServerSeq(docId, serverSeq));
  }

  private bumpServerSeq(docId: string, serverSeq: number): void {
    this.ensureDocMeta(docId);
    this.run(
      `UPDATE doc_meta SET last_seen_server_seq = MAX(last_seen_server_seq, ?) WHERE doc_id = ?`,
      serverSeq,
      docId,
    );
  }

  /** Every update of a doc in local_seq order (tests, recovery tools). */
  allUpdates(docId: string): UpdateRow[] {
    return this.all(`SELECT * FROM updates WHERE doc_id = ? ORDER BY local_seq`, docId).map((row) =>
      this.rowToUpdate(row),
    );
  }

  hasLocalSeq(localSeq: number): boolean {
    return this.get(`SELECT 1 AS present FROM updates WHERE local_seq = ?`, localSeq) !== undefined;
  }

  /** The latest snapshot plus every later update, for loading a sub-document. */
  loadSubdoc(docId: string, subdoc: Subdoc): { snapshot: SnapshotRow | null; tail: UpdateRow[] } {
    const snapshot = this.latestSnapshot(docId, subdoc);
    const tail = this.all(
      `SELECT * FROM updates WHERE doc_id = ? AND subdoc = ? AND local_seq > ? ORDER BY local_seq`,
      docId,
      subdoc,
      snapshot?.uptoLocalSeq ?? 0,
    ).map((row) => this.rowToUpdate(row));
    return { snapshot, tail };
  }

  /** Updates between two local_seqs (exclusive, inclusive], at most `limit` rows. */
  updatesInRange(docId: string, subdoc: Subdoc, afterSeq: number, uptoSeq: number, limit: number): UpdateRow[] {
    return this.all(
      `SELECT * FROM updates WHERE doc_id = ? AND subdoc = ? AND local_seq > ? AND local_seq <= ? ORDER BY local_seq LIMIT ?`,
      docId,
      subdoc,
      afterSeq,
      uptoSeq,
      limit,
    ).map((row) => this.rowToUpdate(row));
  }

  /** Local updates the server has not acknowledged, in order. */
  unackedUpdates(docId: string): UpdateRow[] {
    return this.all(
      `SELECT * FROM updates WHERE doc_id = ? AND acked_server_seq IS NULL ORDER BY local_seq`,
      docId,
    ).map((row) => this.rowToUpdate(row));
  }

  /** local_seq, sub-document and age of every unacked update (no bytes). */
  unackedSummary(docId: string): { localSeq: number; subdoc: Subdoc; createdAt: number }[] {
    return this.all(
      `SELECT local_seq, subdoc, created_at FROM updates WHERE doc_id = ? AND acked_server_seq IS NULL ORDER BY local_seq`,
      docId,
    ).map((row) => ({ localSeq: asNumber(row.local_seq), subdoc: subdocOf(row.subdoc), createdAt: asNumber(row.created_at) }));
  }

  /** Unacked updates that are not part of an outbound batch yet. */
  unbatchedUpdates(docId: string): UpdateRow[] {
    return this.all(
      `SELECT u.* FROM updates u LEFT JOIN outbound o ON o.local_seq = u.local_seq
       WHERE u.doc_id = ? AND u.acked_server_seq IS NULL AND o.local_seq IS NULL ORDER BY u.local_seq`,
      docId,
    ).map((row) => this.rowToUpdate(row));
  }

  /** Doc ids that still have local work the server has not acknowledged. */
  docsWithUnacked(): string[] {
    return this.all(`SELECT DISTINCT doc_id FROM updates WHERE acked_server_seq IS NULL ORDER BY doc_id`).map((row) =>
      String(row.doc_id),
    );
  }

  /** Row count and bytes per sub-document after its latest snapshot (compaction triggers). */
  tailStats(docId: string, subdoc: Subdoc): { count: number; bytes: number; lastLocalSeq: number } {
    const upto = this.latestSnapshotSeq(docId, subdoc);
    const row = this.get(
      `SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH("update")), 0) AS bytes, COALESCE(MAX(local_seq), 0) AS last
       FROM updates WHERE doc_id = ? AND subdoc = ? AND local_seq > ?`,
      docId,
      subdoc,
      upto,
    );
    return {
      count: asNumber(row?.count ?? 0),
      bytes: asNumber(row?.bytes ?? 0),
      lastLocalSeq: Math.max(upto, asNumber(row?.last ?? 0)),
    };
  }

  // ------------------------------------------------------------ snapshots

  latestSnapshot(docId: string, subdoc: Subdoc): SnapshotRow | null {
    const row = this.get(
      `SELECT * FROM snapshots WHERE doc_id = ? AND subdoc = ? ORDER BY upto_local_seq DESC LIMIT 1`,
      docId,
      subdoc,
    );
    if (!row) return null;
    const uptoLocalSeq = asNumber(row.upto_local_seq);
    const parts = this.all(
      `SELECT bytes FROM snapshot_parts WHERE doc_id = ? AND subdoc = ? AND upto_local_seq = ? ORDER BY part`,
      docId,
      subdoc,
      uptoLocalSeq,
    ).map((part) => asBytes(part.bytes));
    const size = asNumber(row.size);
    if (parts.length !== asNumber(row.parts)) throw new Error(`Snapshot ${docId}/${subdoc}@${uptoLocalSeq} is missing parts`);
    const state = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      state.set(part, offset);
      offset += part.length;
    }
    if (offset !== size) throw new Error(`Snapshot ${docId}/${subdoc}@${uptoLocalSeq} has the wrong size`);
    return {
      docId,
      subdoc,
      uptoLocalSeq,
      state,
      stateVector: asBytes(row.state_vector),
      createdAt: asNumber(row.created_at),
    };
  }

  latestSnapshotSeq(docId: string, subdoc: Subdoc): number {
    const row = this.get(
      `SELECT MAX(upto_local_seq) AS upto FROM snapshots WHERE doc_id = ? AND subdoc = ?`,
      docId,
      subdoc,
    );
    return asNullableNumber(row?.upto) ?? 0;
  }

  /**
   * Stores a snapshot covering every update up to `uptoLocalSeq` and drops
   * older snapshots. Updates are not deleted here (see deleteAckedCovered).
   */
  writeSnapshot(
    docId: string,
    subdoc: Subdoc,
    uptoLocalSeq: number,
    state: Uint8Array,
    stateVector: Uint8Array,
    partBytes = SNAPSHOT_PART_BYTES,
  ): void {
    const parts = splitParts(state, partBytes);
    parts.forEach((part, index) => this.writeSnapshotPart(docId, subdoc, uptoLocalSeq, index, part));
    this.commitSnapshot(docId, subdoc, uptoLocalSeq, stateVector, state.length, parts.length);
  }

  /** Stores one part of a snapshot; it is not visible until commitSnapshot. */
  writeSnapshotPart(docId: string, subdoc: Subdoc, uptoLocalSeq: number, part: number, bytes: Uint8Array): void {
    this.run(
      `INSERT OR REPLACE INTO snapshot_parts (doc_id, subdoc, upto_local_seq, part, bytes) VALUES (?, ?, ?, ?, ?)`,
      docId,
      subdoc,
      uptoLocalSeq,
      part,
      bytes,
    );
  }

  /** Makes a fully written snapshot current and drops older snapshots and stray parts. */
  commitSnapshot(docId: string, subdoc: Subdoc, uptoLocalSeq: number, stateVector: Uint8Array, size: number, parts: number): void {
    this.transaction(() => {
      this.run(
        `INSERT OR REPLACE INTO snapshots (doc_id, subdoc, upto_local_seq, state_vector, size, parts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        docId,
        subdoc,
        uptoLocalSeq,
        stateVector,
        size,
        parts,
        this.now(),
      );
      this.run(`DELETE FROM snapshots WHERE doc_id = ? AND subdoc = ? AND upto_local_seq < ?`, docId, subdoc, uptoLocalSeq);
      this.run(
        `DELETE FROM snapshot_parts WHERE doc_id = ? AND subdoc = ? AND (upto_local_seq != ? OR part >= ?)`,
        docId,
        subdoc,
        uptoLocalSeq,
        parts,
      );
    });
  }

  /**
   * Deletes up to `limit` ACKED updates covered by a snapshot. Unacked
   * updates stay: the outbound queue still needs their bytes and mapping.
   * Returns the number of rows deleted.
   */
  deleteAckedCovered(docId: string, subdoc: Subdoc, uptoLocalSeq: number, limit: number): number {
    if (this.latestSnapshotSeq(docId, subdoc) < uptoLocalSeq) return 0;
    const result = this.run(
      `DELETE FROM updates WHERE local_seq IN (
         SELECT local_seq FROM updates
         WHERE doc_id = ? AND subdoc = ? AND local_seq <= ? AND acked_server_seq IS NOT NULL
         ORDER BY local_seq LIMIT ?)`,
      docId,
      subdoc,
      uptoLocalSeq,
      limit,
    );
    return asNumber(result.changes);
  }

  // ------------------------------------------------------------ outbound

  /**
   * Records a batch: allocates the doc's next clientSeq, stores the merged
   * bytes and the local_seqs it covers, all in one transaction.
   */
  createBatch(
    docId: string,
    subdoc: Subdoc,
    localSeqs: readonly number[],
    update: Uint8Array,
    provenance?: Provenance,
  ): OutboundBatch {
    return this.transaction(() => {
      this.ensureDocMeta(docId);
      const clientSeq = asNumber(this.get(`SELECT next_client_seq FROM doc_meta WHERE doc_id = ?`, docId)?.next_client_seq);
      this.run(`UPDATE doc_meta SET next_client_seq = ? WHERE doc_id = ?`, clientSeq + 1, docId);
      const createdAt = this.now();
      this.run(
        `INSERT INTO outbound_batches (doc_id, client_seq, subdoc, "update", provenance, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        docId,
        clientSeq,
        subdoc,
        update,
        provenance ? JSON.stringify(provenance) : null,
        createdAt,
      );
      for (const localSeq of localSeqs) {
        this.run(
          `INSERT INTO outbound (doc_id, subdoc, client_seq, local_seq) VALUES (?, ?, ?, ?)`,
          docId,
          subdoc,
          clientSeq,
          localSeq,
        );
      }
      return { docId, subdoc, clientSeq, update, provenance, localSeqs: [...localSeqs], createdAt };
    });
  }

  outboundBatches(docId: string): OutboundBatch[] {
    const batches = this.all(`SELECT * FROM outbound_batches WHERE doc_id = ? ORDER BY client_seq`, docId);
    return batches.map((row) => {
      const clientSeq = asNumber(row.client_seq);
      const localSeqs = this.all(
        `SELECT local_seq FROM outbound WHERE doc_id = ? AND client_seq = ? ORDER BY local_seq`,
        docId,
        clientSeq,
      ).map((entry) => asNumber(entry.local_seq));
      const provenance = parseJson<Provenance>(row.provenance) ?? undefined;
      return {
        docId,
        subdoc: subdocOf(row.subdoc),
        clientSeq,
        update: asBytes(row.update),
        ...(provenance ? { provenance } : {}),
        localSeqs,
        createdAt: asNumber(row.created_at),
      };
    });
  }

  /**
   * Marks a batch's updates acked and drops the batch. Returns the covered
   * local_seqs, or null when the batch is unknown (a duplicate ack).
   */
  ackBatch(docId: string, clientSeq: number, serverSeq: number): number[] | null {
    return this.transaction(() => {
      const batch = this.get(`SELECT 1 AS present FROM outbound_batches WHERE doc_id = ? AND client_seq = ?`, docId, clientSeq);
      if (!batch) return null;
      const localSeqs = this.all(
        `SELECT local_seq FROM outbound WHERE doc_id = ? AND client_seq = ? ORDER BY local_seq`,
        docId,
        clientSeq,
      ).map((row) => asNumber(row.local_seq));
      this.run(
        `UPDATE updates SET acked_server_seq = ? WHERE local_seq IN (SELECT local_seq FROM outbound WHERE doc_id = ? AND client_seq = ?)`,
        serverSeq,
        docId,
        clientSeq,
      );
      this.run(`DELETE FROM outbound_batches WHERE doc_id = ? AND client_seq = ?`, docId, clientSeq);
      this.bumpServerSeq(docId, serverSeq);
      return localSeqs;
    });
  }

  /**
   * Forgets everything local about one sub-document: its log, snapshots and
   * outbound batches. Used by reject rollback before reloading from the server.
   */
  wipeSubdoc(docId: string, subdoc: Subdoc): void {
    this.transaction(() => {
      this.run(`DELETE FROM outbound_batches WHERE doc_id = ? AND subdoc = ?`, docId, subdoc);
      this.run(`DELETE FROM updates WHERE doc_id = ? AND subdoc = ?`, docId, subdoc);
      this.run(`DELETE FROM snapshots WHERE doc_id = ? AND subdoc = ?`, docId, subdoc);
      this.run(`DELETE FROM snapshot_parts WHERE doc_id = ? AND subdoc = ?`, docId, subdoc);
    });
  }

  // ------------------------------------------------------------ doc_meta

  ensureDocMeta(docId: string): void {
    this.run(`INSERT OR IGNORE INTO doc_meta (doc_id) VALUES (?)`, docId);
  }

  getDocMeta(docId: string): DocMetaRow | null {
    const row = this.get(`SELECT * FROM doc_meta WHERE doc_id = ?`, docId);
    if (!row) return null;
    const kind = row.doc_kind === "file" || row.doc_kind === "manifest" ? row.doc_kind : null;
    const reason =
      row.read_only_reason === "schema-newer" || row.read_only_reason === "access-revoked" ? row.read_only_reason : null;
    return {
      docId,
      projectId: asNullableString(row.project_id),
      kind,
      schemaVersion: asNullableNumber(row.schema_version),
      role: isRole(row.role) ? row.role : null,
      lastSeenServerSeq: asNumber(row.last_seen_server_seq),
      nextClientSeq: asNumber(row.next_client_seq),
      lastOpenedAt: asNullableNumber(row.last_opened_at),
      readOnlyReason: reason,
    };
  }

  updateDocMeta(
    docId: string,
    patch: Partial<Pick<DocMetaRow, "projectId" | "kind" | "schemaVersion" | "role" | "lastOpenedAt" | "readOnlyReason">>,
  ): void {
    const columns: Record<string, string> = {
      projectId: "project_id",
      kind: "doc_kind",
      schemaVersion: "schema_version",
      role: "role",
      lastOpenedAt: "last_opened_at",
      readOnlyReason: "read_only_reason",
    };
    const sets: string[] = [];
    const values: SqlValue[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (!column || value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value as SqlValue);
    }
    this.transaction(() => {
      this.ensureDocMeta(docId);
      if (sets.length > 0) this.run(`UPDATE doc_meta SET ${sets.join(", ")} WHERE doc_id = ?`, ...values, docId);
    });
  }

  // ------------------------------------------------------------ rejected_edits

  putRejected(edit: RejectedEditRow): void {
    this.run(
      `INSERT OR REPLACE INTO rejected_edits (doc_id, subdoc, reason, message, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      edit.docId,
      edit.subdoc,
      edit.reason,
      edit.message,
      edit.rejectedText,
      edit.at,
    );
  }

  listRejected(docId: string): RejectedEditRow[] {
    return this.all(`SELECT * FROM rejected_edits WHERE doc_id = ? ORDER BY created_at`, docId).map((row) => ({
      docId,
      subdoc: subdocOf(row.subdoc),
      reason: String(row.reason),
      message: String(row.message),
      rejectedText: String(row.text),
      at: asNumber(row.created_at),
    }));
  }

  deleteRejected(docId: string, subdoc: Subdoc): void {
    this.run(`DELETE FROM rejected_edits WHERE doc_id = ? AND subdoc = ?`, docId, subdoc);
  }

  // ------------------------------------------------------------ threads_cache

  putThread(threadId: string, docId: string, json: unknown): void {
    this.run(
      `INSERT INTO threads_cache (thread_id, doc_id, json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (thread_id) DO UPDATE SET doc_id = excluded.doc_id, json = excluded.json, updated_at = excluded.updated_at`,
      threadId,
      docId,
      JSON.stringify(json),
      this.now(),
    );
  }

  listThreads(docId: string): ThreadCacheRow[] {
    return this.all(`SELECT * FROM threads_cache WHERE doc_id = ? ORDER BY updated_at`, docId).map((row) => ({
      threadId: String(row.thread_id),
      docId: String(row.doc_id),
      json: parseJson<unknown>(row.json),
      updatedAt: asNumber(row.updated_at),
    }));
  }

  deleteThread(threadId: string): void {
    this.run(`DELETE FROM threads_cache WHERE thread_id = ?`, threadId);
  }

  // ------------------------------------------------------------ pending_commands

  /** Persists a command; a second insert with the same id is ignored (idempotent enqueue). */
  insertCommand(command: Command): boolean {
    const result = this.run(
      `INSERT OR IGNORE INTO pending_commands (id, kind, payload, created_at) VALUES (?, ?, ?, ?)`,
      command.id,
      command.kind,
      JSON.stringify(command),
      this.now(),
    );
    return asNumber(result.changes) > 0;
  }

  listCommands(): PendingCommandRow[] {
    return this.all(`SELECT * FROM pending_commands ORDER BY seq`).map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      command: JSON.parse(String(row.payload)) as Command,
      createdAt: asNumber(row.created_at),
      attempts: asNumber(row.attempts),
      lastError: asNullableString(row.last_error),
    }));
  }

  recordCommandAttempt(id: string, error: string | null): void {
    this.run(`UPDATE pending_commands SET attempts = attempts + 1, last_error = ? WHERE id = ?`, error, id);
  }

  deleteCommand(id: string): void {
    this.run(`DELETE FROM pending_commands WHERE id = ?`, id);
  }

  // ------------------------------------------------------------ projects, docs, blobs

  upsertProject(project: ProjectRow): void {
    this.run(
      `INSERT INTO projects (project_id, name, local_root, role) VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id) DO UPDATE SET name = excluded.name, local_root = excluded.local_root, role = excluded.role`,
      project.projectId,
      project.name,
      project.localRoot,
      project.role,
    );
  }

  getProject(projectId: string): ProjectRow | null {
    const row = this.get(`SELECT * FROM projects WHERE project_id = ?`, projectId);
    if (!row) return null;
    return {
      projectId,
      name: String(row.name),
      localRoot: asNullableString(row.local_root),
      role: isRole(row.role) ? row.role : null,
    };
  }

  listProjects(): ProjectRow[] {
    return this.all(`SELECT project_id FROM projects ORDER BY name`).map(
      (row) => this.getProject(String(row.project_id)) as ProjectRow,
    );
  }

  deleteProject(projectId: string): void {
    this.transaction(() => {
      this.run(`DELETE FROM docs WHERE project_id = ?`, projectId);
      this.run(`DELETE FROM projects WHERE project_id = ?`, projectId);
    });
  }

  upsertDoc(doc: DocRecordRow): void {
    this.run(
      `INSERT INTO docs (doc_id, project_id, file_id, path, materialized_hash) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (doc_id) DO UPDATE SET project_id = excluded.project_id, file_id = excluded.file_id,
         path = excluded.path, materialized_hash = excluded.materialized_hash`,
      doc.docId,
      doc.projectId,
      doc.fileId,
      doc.path,
      doc.materializedHash,
    );
  }

  private rowToDoc(row: Record<string, unknown>): DocRecordRow {
    return {
      docId: String(row.doc_id),
      projectId: String(row.project_id),
      fileId: asNullableString(row.file_id),
      path: asNullableString(row.path),
      materializedHash: asNullableString(row.materialized_hash),
    };
  }

  getDoc(docId: string): DocRecordRow | null {
    const row = this.get(`SELECT * FROM docs WHERE doc_id = ?`, docId);
    return row ? this.rowToDoc(row) : null;
  }

  listDocs(projectId: string): DocRecordRow[] {
    return this.all(`SELECT * FROM docs WHERE project_id = ? ORDER BY path`, projectId).map((row) => this.rowToDoc(row));
  }

  setMaterializedHash(docId: string, hash: string | null): void {
    this.run(`UPDATE docs SET materialized_hash = ? WHERE doc_id = ?`, hash, docId);
  }

  putBlob(blob: BlobCacheRow): void {
    this.run(
      `INSERT INTO blobs_cache (hash, local_path, size) VALUES (?, ?, ?)
       ON CONFLICT (hash) DO UPDATE SET local_path = excluded.local_path, size = excluded.size`,
      blob.hash,
      blob.localPath,
      blob.size,
    );
  }

  getBlob(hash: string): BlobCacheRow | null {
    const row = this.get(`SELECT * FROM blobs_cache WHERE hash = ?`, hash);
    return row ? { hash, localPath: String(row.local_path), size: asNumber(row.size) } : null;
  }

  deleteBlob(hash: string): void {
    this.run(`DELETE FROM blobs_cache WHERE hash = ?`, hash);
  }
}
