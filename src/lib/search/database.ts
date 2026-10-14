import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type { SearchFileKind } from "@/lib/global-search";
import { documentFileTitle, documentPrompt } from "@/lib/search/chunking";

/**
 * The Global Search index: one SQLite file holding files, their passages, a
 * full-text index (FTS5) and a vector index (sqlite-vec). SQLite comes from
 * Node itself (`node:sqlite`), so nothing native has to match Electron's ABI;
 * sqlite-vec is a loadable extension.
 */

// `node:sqlite` is newer than this project's Node typings.
type SqlValue = null | number | bigint | string | Uint8Array;
type StatementSync = {
  run(...values: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...values: SqlValue[]): Record<string, unknown> | undefined;
  all(...values: SqlValue[]): Record<string, unknown>[];
};
type DatabaseSync = {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  loadExtension(path: string): void;
  enableLoadExtension(enabled: boolean): void;
  close(): void;
};
type SqliteModule = { DatabaseSync: new (path: string, options?: { allowExtension?: boolean }) => DatabaseSync };

const SCHEMA_VERSION = "1";
// Resolve at run time from the server bundle, as the PDF text cache does for pdfjs.
const nodeRequire = eval("require") as NodeRequire;

function loadSqlite(): SqliteModule {
  // Node prints an experimental warning once; the module itself is stable for this use.
  return nodeRequire("node:sqlite") as SqliteModule;
}

function sqliteVecPath() {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const extension = process.platform === "win32" ? "dll" : process.platform === "darwin" ? "dylib" : "so";
  return nodeRequire.resolve(`sqlite-vec-${platform}-${process.arch}/vec0.${extension}`);
}

export type IndexedFile = {
  id: number;
  key: string;
  source: "library" | "gallery";
  kind: SearchFileKind;
  path: string;
  name: string;
  notebook: string;
  signature: string;
  meta: string | null;
  status: string;
};

export type NewChunk = {
  /** Image content hash. Text identities are calculated from the complete prompt. */
  hash?: string;
  title: string;
  text: string;
  context: string;
  page?: number;
  line?: number;
  endLine?: number;
  start?: number;
  end?: number;
};

export type PendingChunk = {
  id: number;
  generation: number;
  fileId: number;
  kind: SearchFileKind;
  key: string;
  source: "library" | "gallery";
  path: string;
  name: string;
  signature: string;
  title: string;
  text: string;
  context: string;
};

export type ChunkRow = {
  id: number;
  fileId: number;
  title: string;
  text: string;
  page: number | null;
  line: number | null;
  endLine: number | null;
  start: number | null;
  end: number | null;
  embedded: number;
  key: string;
  source: "library" | "gallery";
  kind: SearchFileKind;
  path: string;
  name: string;
  notebook: string;
  meta: string | null;
};

function vectorBlob(vector: Float32Array) {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

const LEGACY_IMAGE_HASH = /^image:[a-f0-9]{40}$/;

function promptHash(kind: SearchFileKind, name: string, chunk: Pick<NewChunk, "title" | "text" | "context">) {
  return createHash("sha256")
    .update(`${kind}\u0000${documentPrompt(kind, documentFileTitle(name), chunk)}`).digest("hex");
}

/** Keep the leading dimensions (Matryoshka) and restore unit length. */
export function truncateVector(vector: Float32Array, dimensions: number) {
  const truncated = new Float32Array(vector.subarray(0, dimensions));
  let norm = 0;
  for (let index = 0; index < truncated.length; index += 1) norm += truncated[index] * truncated[index];
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < truncated.length; index += 1) truncated[index] /= norm;
  return truncated;
}

export class SearchDatabase {
  readonly filePath: string;
  private readonly db: DatabaseSync;
  private dimensions = 0;
  private generation = 0;
  private readonly statements = new Map<string, StatementSync>();

  constructor(filePath: string) {
    this.filePath = filePath;
    // An existing file must be a Libera index: its tables are never rebuilt over someone else's data.
    const existing = existsSync(filePath) && statSync(filePath).size > 0;
    mkdirSync(path.dirname(filePath), { recursive: true });
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(this.filePath, { allowExtension: true });

    if (existing) {
      let schema: unknown;
      try {
        schema = this.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get()?.value;
      } catch {
        schema = undefined;
      }
      if (typeof schema !== "string") {
        this.db.close();
        throw new Error(`${path.basename(filePath)} is not a Libera search index.`);
      }
    }

    this.db.loadExtension(sqliteVecPath());
    this.db.enableLoadExtension(false);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);

    if (this.getMeta("schema") !== SCHEMA_VERSION) this.resetSchema();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        notebook TEXT NOT NULL DEFAULT '',
        signature TEXT NOT NULL,
        meta TEXT,
        status TEXT NOT NULL DEFAULT 'ok',
        error TEXT,
        indexed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        hash TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        page INTEGER,
        line INTEGER,
        end_line INTEGER,
        start INTEGER,
        end INTEGER,
        embedded INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file_id, ordinal);
      CREATE INDEX IF NOT EXISTS chunks_hash ON chunks(hash);
      CREATE INDEX IF NOT EXISTS chunks_pending ON chunks(embedded) WHERE embedded = 0;
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        name, title, text,
        content='', contentless_delete=1,
        tokenize='unicode61 remove_diacritics 2'
      );
    `);
    this.setMeta("schema", SCHEMA_VERSION);
    this.transaction(() => {
      // Also recognize old hashes in indexes already opened by an earlier repair.
      // Hash the saved prompt so unchanged text keeps its original chunk and vector.
      const legacy = this.db.prepare(`
        SELECT c.id, c.hash, c.title, c.text, c.context, f.kind, f.name
        FROM chunks c JOIN files f ON f.id = c.file_id
        WHERE f.kind != 'image' AND length(c.hash) = 40
      `).all() as Array<NewChunk & { id: number; kind: SearchFileKind; name: string }>;
      const updateHash = this.statement("UPDATE chunks SET hash = ? WHERE id = ?");
      for (const chunk of legacy) {
        const oldHash = createHash("sha1").update(`${chunk.kind}\u0000${chunk.title}\u0000${chunk.text}`).digest("hex");
        if (chunk.hash === oldHash) updateHash.run(promptHash(chunk.kind, chunk.name, chunk), chunk.id);
      }
      const images = this.db.prepare(`
        SELECT c.hash FROM chunks c JOIN files f ON f.id = c.file_id
        WHERE f.kind = 'image' AND c.embedded = 1
      `).all();
      if (images.some((chunk) => LEGACY_IMAGE_HASH.test(String(chunk.hash)))) this.setMeta("legacy_image_vectors", "1");
      if (this.getMeta("content_version") !== "2") {
        this.db.exec("UPDATE files SET signature = ''");
        this.setMeta("content_version", "2");
      }
    });
  }

  close() {
    this.generation += 1;
    // Do not leave this connection's WAL to be replayed over a replacement
    // index at the same path when the indexer reopens it.
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
  }

  private statement(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private resetSchema() {
    this.db.exec(`
      DROP TABLE IF EXISTS chunks_vec;
      DROP TABLE IF EXISTS chunks_fts;
      DROP TABLE IF EXISTS chunks;
      DROP TABLE IF EXISTS files;
      DELETE FROM meta;
    `);
    this.statements.clear();
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getMeta(key: string) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return typeof row?.value === "string" ? row.value : null;
  }

  setMeta(key: string, value: string) {
    this.statement("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /**
   * Make the vector table match the embedding size and model. Vectors from a
   * different model, or of another size, have to be embedded again; that can
   * take hours, so it happens only when `allowReset` says so (a new index, or
   * the user asked). Otherwise the stored vectors are kept and the mismatch is
   * returned, and they are not used. Without a configured model nothing is
   * compared.
   */
  prepareVectors(dimensions: number, textSignature: string, visionSignature: string, allowReset = false) {
    const storedDimensions = Number(this.getMeta("dimensions") ?? 0);
    const storedText = this.getMeta("text_signature") ?? "";
    const storedVision = this.getMeta("vision_signature") ?? "";
    const hasVectors = this.countEmbedded() > 0;
    const sizeDiffers = storedDimensions > 0 && storedDimensions !== dimensions;
    const textDiffers = Boolean(textSignature && storedText && textSignature !== storedText);
    const visionDiffers = Boolean(visionSignature && storedVision && visionSignature !== storedVision);
    const legacyImageFlag = this.getMeta("legacy_image_vectors") === "1";
    const legacyImages = legacyImageFlag && Boolean(this.statement(`
      SELECT 1 FROM chunks c JOIN files f ON f.id = c.file_id
      WHERE f.kind = 'image' AND c.embedded = 1 LIMIT 1
    `).get());

    if (hasVectors && !allowReset && (sizeDiffers || textDiffers || visionDiffers || legacyImages)) {
      this.ensureVectorTable(storedDimensions || dimensions);
      const reasons = [
        sizeDiffers ? `${storedDimensions} dimensions instead of ${dimensions}` : "",
        textDiffers ? `the text model ${storedText.split(":")[0]}` : "",
        visionDiffers && !textDiffers ? "different vision encoder or image detail settings" : "",
        legacyImages ? "older partial image fingerprints (re-embed to verify their contents)" : "",
      ].filter(Boolean);
      return `This index was built with ${reasons.join(" and ")}.`;
    }

    const previousDimensions = this.dimensions;
    try {
      return this.transaction(() => {
        if (legacyImageFlag && !legacyImages) this.setMeta("legacy_image_vectors", "");
        const resetAll = allowReset || storedDimensions !== dimensions || textDiffers || legacyImages;
        if (resetAll) {
          this.generation += 1;
          this.db.exec("DROP TABLE IF EXISTS chunks_vec");
          this.statements.clear();
          this.db.exec("UPDATE chunks SET embedded = 0");
          this.setMeta("dimensions", String(dimensions));
          this.setMeta("legacy_image_vectors", "");
        }
        this.ensureVectorTable(dimensions);

        if (!resetAll && visionDiffers) {
          this.generation += 1;
          const ids = this.db.prepare(
            "SELECT c.id FROM chunks c JOIN files f ON f.id = c.file_id WHERE f.kind = 'image' AND c.embedded = 1",
          ).all();
          const remove = this.statement("DELETE FROM chunks_vec WHERE rowid = ?");
          for (const row of ids) remove.run(BigInt(row.id as number));
          this.db.exec("UPDATE chunks SET embedded = 0 WHERE file_id IN (SELECT id FROM files WHERE kind = 'image')");
        }

        if (textSignature) this.setMeta("text_signature", textSignature);
        if (visionSignature) this.setMeta("vision_signature", visionSignature);
        return null;
      });
    } catch (error) {
      this.dimensions = previousDimensions;
      this.statements.clear();
      throw error;
    }
  }

  private ensureVectorTable(dimensions: number) {
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      embedding float[${dimensions}] distance_metric=cosine,
      kind text
    )`);
    this.dimensions = dimensions;
  }

  private countEmbedded() {
    try {
      return Number(this.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE embedded = 1").get()?.n ?? 0);
    } catch {
      return 0;
    }
  }

  listFiles(): IndexedFile[] {
    return this.statement("SELECT id, key, source, kind, path, name, notebook, signature, meta, status FROM files").all() as IndexedFile[];
  }

  private chunkIdsOf(fileId: number) {
    return this.statement("SELECT id, hash, embedded FROM chunks WHERE file_id = ? ORDER BY ordinal").all(fileId) as Array<{
      id: number;
      hash: string;
      embedded: number;
    }>;
  }

  private deleteChunkRows(ids: number[]) {
    const removeFts = this.statement("DELETE FROM chunks_fts WHERE rowid = ?");
    const removeVec = this.statement("DELETE FROM chunks_vec WHERE rowid = ?");
    const removeChunk = this.statement("DELETE FROM chunks WHERE id = ?");
    for (const id of ids) {
      removeFts.run(id);
      removeVec.run(BigInt(id));
      removeChunk.run(id);
    }
  }

  deleteFile(fileId: number) {
    this.generation += 1;
    this.transaction(() => {
      this.deleteChunkRows(this.chunkIdsOf(fileId).map((chunk) => chunk.id));
      this.statement("DELETE FROM files WHERE id = ?").run(fileId);
    });
  }

  /**
   * Store a file and its passages. Passages whose text is unchanged keep their
   * vectors, and a passage seen in another file (a moved or copied file)
   * borrows that vector, so only new text is embedded again.
   */
  replaceFile(
    file: Omit<IndexedFile, "id" | "status"> & { status?: string; error?: string | null },
    chunks: NewChunk[],
    ftsName: string,
  ) {
    this.generation += 1;
    return this.transaction(() => {
      const now = new Date().toISOString();
      const existing = this.statement("SELECT id FROM files WHERE key = ?").get(file.key) as { id: number } | undefined;
      let fileId: number;

      if (existing) {
        fileId = existing.id;
        this.statement(
          "UPDATE files SET source = ?, kind = ?, path = ?, name = ?, notebook = ?, signature = ?, meta = ?, status = ?, error = ?, indexed_at = ? WHERE id = ?",
        ).run(file.source, file.kind, file.path, file.name, file.notebook, file.signature, file.meta, file.status ?? "ok", file.error ?? null, now, fileId);
      } else {
        fileId = Number(this.statement(
          "INSERT INTO files(key, source, kind, path, name, notebook, signature, meta, status, error, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(file.key, file.source, file.kind, file.path, file.name, file.notebook, file.signature, file.meta, file.status ?? "ok", file.error ?? null, now).lastInsertRowid);
      }

      const previous = this.chunkIdsOf(fileId);
      const reusable = new Map<string, Array<{ id: number; embedded: number }>>();
      for (const chunk of previous) {
        const list = reusable.get(chunk.hash) ?? [];
        list.push(chunk);
        reusable.set(chunk.hash, list);
      }

      const keep = new Set<number>();
      // Partial image hashes cannot prove that the pixels are unchanged. Retain
      // their vectors, blocked by prepareVectors(), until the user resets them.
      const legacyImage = file.kind === "image" && this.getMeta("legacy_image_vectors") === "1"
        ? previous.find((chunk) => chunk.embedded === 1 && LEGACY_IMAGE_HASH.test(chunk.hash)) : undefined;
      const updateChunk = this.statement(
        "UPDATE chunks SET ordinal = ?, title = ?, text = ?, context = ?, page = ?, line = ?, end_line = ?, start = ?, end = ?, embedded = CASE WHEN embedded = 2 THEN 0 ELSE embedded END WHERE id = ?",
      );
      const insertChunk = this.statement(
        "INSERT INTO chunks(file_id, ordinal, hash, title, text, context, page, line, end_line, start, end, embedded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
      );
      const insertFts = this.statement("INSERT INTO chunks_fts(rowid, name, title, text) VALUES (?, ?, ?, ?)");
      const removeFts = this.statement("DELETE FROM chunks_fts WHERE rowid = ?");
      const findShared = this.statement(
        "SELECT c.id FROM chunks c JOIN files f ON f.id = c.file_id WHERE c.hash = ? AND c.embedded = 1 AND f.kind = ? LIMIT 1",
      );
      const readVector = this.statement("SELECT embedding FROM chunks_vec WHERE rowid = ?");
      const insertVector = this.statement("INSERT INTO chunks_vec(rowid, embedding, kind) VALUES (?, ?, ?)");
      const markEmbedded = this.statement("UPDATE chunks SET embedded = 1 WHERE id = ?");

      chunks.forEach((chunk, ordinal) => {
        const hash = file.kind === "image" ? chunk.hash : promptHash(file.kind, file.name, chunk);
        if (!hash) throw new Error("An image passage needs a content fingerprint.");
        const match = reusable.get(hash)?.shift() ?? (ordinal === 0 ? legacyImage : undefined);
        if (match) {
          keep.add(match.id);
          this.statement("UPDATE chunks SET hash = ? WHERE id = ?").run(hash, match.id);
          updateChunk.run(ordinal, chunk.title, chunk.text, chunk.context, chunk.page ?? null, chunk.line ?? null, chunk.endLine ?? null, chunk.start ?? null, chunk.end ?? null, match.id);
          removeFts.run(match.id);
          insertFts.run(match.id, ftsName, chunk.title, chunk.text);
          return;
        }

        const id = Number(insertChunk.run(fileId, ordinal, hash, chunk.title, chunk.text, chunk.context, chunk.page ?? null, chunk.line ?? null, chunk.endLine ?? null, chunk.start ?? null, chunk.end ?? null).lastInsertRowid);
        insertFts.run(id, ftsName, chunk.title, chunk.text);

        const shared = findShared.get(hash, file.kind) as { id: number } | undefined;
        const vector = shared ? readVector.get(BigInt(shared.id))?.embedding : undefined;
        if (vector instanceof Uint8Array) {
          insertVector.run(BigInt(id), vector, file.kind);
          markEmbedded.run(id);
        }
      });

      this.deleteChunkRows(previous.filter((chunk) => !keep.has(chunk.id)).map((chunk) => chunk.id));
      return fileId;
    });
  }

  /**
   * Point an entry at another path (see `planIndexRepair`), keeping its
   * passages and vectors. The file name is part of the keyword index, so its
   * passages are indexed again under the new name.
   */
  relocateFile(fileId: number, file: Pick<IndexedFile, "key" | "path" | "name" | "notebook" | "meta">, ftsName: string) {
    this.generation += 1;
    this.transaction(() => {
      // A path/size match is a candidate, not proof of identical contents.
      this.statement("UPDATE files SET key = ?, path = ?, name = ?, notebook = ?, meta = ?, signature = '' WHERE id = ?")
        .run(file.key, file.path, file.name, file.notebook, file.meta, fileId);
      const removeFts = this.statement("DELETE FROM chunks_fts WHERE rowid = ?");
      const insertFts = this.statement("INSERT INTO chunks_fts(rowid, name, title, text) VALUES (?, ?, ?, ?)");
      const chunks = this.statement("SELECT id, title, text FROM chunks WHERE file_id = ?").all(fileId);
      for (const chunk of chunks) {
        removeFts.run(chunk.id as number);
        insertFts.run(chunk.id as number, ftsName, chunk.title as string, chunk.text as string);
      }
    });
  }

  /** Record a failed read; the next scan retries even if its metadata is unchanged. */
  markFailed(file: Omit<IndexedFile, "id" | "status" | "meta"> & { meta?: string | null }, error: string, ftsName: string) {
    this.replaceFile({ ...file, meta: file.meta ?? null, status: "error", error }, [], ftsName);
  }

  pendingChunks(limit: number, includeImages: boolean): PendingChunk[] {
    return this.statement(`
      SELECT c.id, c.file_id AS fileId, f.kind, f.key, f.source, f.path, f.name, f.signature, c.title, c.text, c.context
      FROM chunks c JOIN files f ON f.id = c.file_id
      WHERE c.embedded = 0 AND (f.kind != 'image' OR ?)
      ORDER BY (f.kind = 'image'), c.file_id, c.ordinal
      LIMIT ?
    `).all(includeImages ? 1 : 0, limit).map((row) => ({ ...row, generation: this.generation })) as PendingChunk[];
  }

  countPending(includeImages: boolean) {
    const row = this.statement(`
      SELECT COUNT(*) AS n FROM chunks c JOIN files f ON f.id = c.file_id
      WHERE c.embedded = 0 AND (f.kind != 'image' OR ?)
    `).get(includeImages ? 1 : 0);
    return Number(row?.n ?? 0);
  }

  storeVectors(entries: Array<{ id: number; generation: number; kind: SearchFileKind; vector: Float32Array }>) {
    this.transaction(() => {
      const exists = this.statement("SELECT 1 FROM chunks WHERE id = ? AND embedded = 0");
      const remove = this.statement("DELETE FROM chunks_vec WHERE rowid = ?");
      const insert = this.statement("INSERT INTO chunks_vec(rowid, embedding, kind) VALUES (?, ?, ?)");
      const mark = this.statement("UPDATE chunks SET embedded = 1 WHERE id = ?");
      for (const entry of entries) {
        // The passage may have been replaced while it was being embedded.
        if (entry.generation !== this.generation || !exists.get(entry.id)) continue;
        remove.run(BigInt(entry.id));
        insert.run(BigInt(entry.id), vectorBlob(truncateVector(entry.vector, this.dimensions)), entry.kind);
        mark.run(entry.id);
      }
    });
  }

  /** Passages the model could not read are skipped until the model or the file changes. */
  markEmbeddingFailed(chunks: Pick<PendingChunk, "id" | "generation">[]) {
    const mark = this.statement("UPDATE chunks SET embedded = 2 WHERE id = ? AND embedded = 0");
    for (const chunk of chunks) if (chunk.generation === this.generation) mark.run(chunk.id);
  }

  retryFailedEmbeddings() {
    this.db.exec("UPDATE chunks SET embedded = 0 WHERE embedded = 2");
  }

  nearest(vector: Float32Array, limit: number, kinds?: SearchFileKind[]) {
    const query = vectorBlob(truncateVector(vector, this.dimensions));
    const rows = kinds?.length
      ? this.statement(
          "SELECT rowid AS id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ? AND kind IN (SELECT value FROM json_each(?)) ORDER BY distance",
        ).all(query, limit, JSON.stringify(kinds))
      : this.statement("SELECT rowid AS id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance").all(query, limit);
    return rows.map((row) => ({ id: Number(row.id), similarity: 1 - Number(row.distance) }));
  }

  keyword(match: string, limit: number, kinds?: SearchFileKind[]) {
    const rows = this.statement(`
      SELECT chunks_fts.rowid AS id, bm25(chunks_fts, 4.0, 2.0, 1.0) AS rank
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      JOIN files f ON f.id = c.file_id
      WHERE chunks_fts MATCH ? AND (? IS NULL OR f.kind IN (SELECT value FROM json_each(?)))
      ORDER BY rank
      LIMIT ?
    `).all(match, kinds?.length ? 1 : null, JSON.stringify(kinds ?? []), limit);
    return rows.map((row) => ({ id: Number(row.id), rank: Number(row.rank) }));
  }

  chunkRows(ids: number[]): ChunkRow[] {
    if (!ids.length) return [];
    return this.statement(`
      SELECT c.id, c.file_id AS fileId, c.title, c.text, c.page, c.line, c.end_line AS endLine, c.start, c.end, c.embedded,
        f.key, f.source, f.kind, f.path, f.name, f.notebook, f.meta
      FROM chunks c JOIN files f ON f.id = c.file_id
      WHERE c.id IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify(ids)) as ChunkRow[];
  }

  counts() {
    const row = this.statement(`
      SELECT
        (SELECT COUNT(*) FROM files WHERE status = 'ok') AS files,
        (SELECT COUNT(*) FROM files WHERE status = 'error') AS failed,
        (SELECT COUNT(*) FROM files WHERE kind = 'image' AND status = 'ok') AS images,
        (SELECT COUNT(*) FROM chunks) AS chunks,
        (SELECT COUNT(*) FROM chunks WHERE embedded = 1) AS embedded
    `).get() ?? {};
    return {
      files: Number(row.files ?? 0),
      failedFiles: Number(row.failed ?? 0),
      images: Number(row.images ?? 0),
      chunks: Number(row.chunks ?? 0),
      embeddedChunks: Number(row.embedded ?? 0),
    };
  }

  /** Forget everything; the next scan indexes the library from scratch. */
  clear() {
    this.generation += 1;
    this.transaction(() => {
      this.db.exec("DELETE FROM chunks_fts; DELETE FROM chunks; DELETE FROM files;");
      this.db.exec("DELETE FROM chunks_vec");
    });
  }

  checkpoint() {
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }
}
