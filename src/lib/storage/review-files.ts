// Review storage on disk: one file per reviewed document at
// `<root>/.libera/reviews/<id>.json`, and `index.json` beside them mapping
// each id to its key (a Libera path, `draft:<tabId>` or `standalone:<id>`).
// Editing one document rewrites only that document's file; the index changes
// only when a document is created, moved, copied or deleted. The index is
// authoritative for keys, so a document's `key` is read from it.
//
// The library folder is often synced (OneDrive, iCloud), so the lock lives in
// the OS temp folder and each write is a temp file renamed into place, written
// from the temp folder when it is on the same volume.
//
// This module takes the library root as an argument and uses only Node, so the
// Next server (markdown-reviews.ts) and the Electron host
// (review-migration.ts) share it and its lock.
//
// Libraries written before this layout keep one `.libera/markdown-reviews.json`
// holding every document. The first access moves it into the layout above and
// renames it to `markdown-reviews.json.migrated`.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** The fields this module relies on; the rest of a document is opaque here. */
export type StoredReview = { id: string; key: string };

type ReviewIndex = { schemaVersion: 2; documents: Record<string, string> };

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
export const isSafeReviewId = (id: unknown): id is string => typeof id === "string" && SAFE_ID.test(id);

export function reviewsDirectory(root: string) {
  return path.join(root, ".libera", "reviews");
}
export function legacyReviewDatabasePath(root: string) {
  return path.join(root, ".libera", "markdown-reviews.json");
}
const indexPath = (root: string) => path.join(reviewsDirectory(root), "index.json");
function documentPath(root: string, id: string) {
  if (!isSafeReviewId(id)) throw new Error("Invalid review document ID.");
  return path.join(reviewsDirectory(root), `${id}.json`);
}
function lockPath(root: string) {
  const digest = createHash("sha256").update(path.resolve(reviewsDirectory(root)).toLowerCase()).digest("hex").slice(0, 32);
  return path.join(os.tmpdir(), "libera-locks", `reviews-${digest}.lock`);
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (missing(error)) return undefined; throw error; }
}

async function readIndexFile(root: string): Promise<Map<string, string> | null> {
  const index = await readJson(indexPath(root)) as ReviewIndex | undefined;
  if (index === undefined) return null;
  if (index.schemaVersion !== 2 || !index.documents || typeof index.documents !== "object") throw new Error("Unsupported review index.");
  return new Map(Object.entries(index.documents));
}

async function readDocumentFile<D extends StoredReview>(root: string, id: string, key: string): Promise<D | undefined> {
  const doc = await readJson(documentPath(root, id)) as D | undefined;
  if (doc === undefined) return undefined;
  if (!doc || typeof doc !== "object" || doc.id !== id) throw new Error("Unsupported review document.");
  doc.key = key;
  return doc;
}

// Temp files go to the OS temp folder when a rename from there reaches the
// library (same volume), else beside the target. Remembered per directory.
const crossVolume = new Set<string>();
async function writeAtomic(target: string, contents: string) {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true });
  const local = !crossVolume.has(directory);
  const temporary = local ? path.join(os.tmpdir(), "libera-locks", `review-${randomUUID()}.tmp`) : `${target}.${randomUUID()}.tmp`;
  try {
    if (local) await mkdir(path.dirname(temporary), { recursive: true });
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target);
  } catch (error) {
    if (!local || (error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    crossVolume.add(directory);
    await rm(temporary, { force: true });
    return writeAtomic(target, contents);
  } finally { await rm(temporary, { force: true }); }
}

async function withLock<T>(root: string, busy: () => Error, fn: () => Promise<T>): Promise<T> {
  const target = lockPath(root);
  await mkdir(path.dirname(target), { recursive: true });
  let lock;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { lock = await open(target, "wx", 0o600); await lock.writeFile(String(process.pid)); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Recover a lock left by a dead process. Never steal from a live owner.
      try {
        const owner = Number(await readFile(target, "utf8"));
        if (Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); }
          catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ESRCH") await rm(target, { force: true }); }
        } else if (Date.now() - (await stat(target)).mtimeMs > 30_000) await rm(target, { force: true });
      } catch (cause) { if (!missing(cause)) throw cause; }
      await delay(50);
    }
  }
  if (!lock) throw busy();
  try { return await fn(); }
  finally { await lock.close(); await rm(target, { force: true }); }
}

const defaultBusy = () => new Error("Review storage is busy. Try again in a moment.");

// Moves a library's single-file database into per-document files, once. Only
// a library that has an index is remembered, so one without reviews yet still
// notices a database that appears later (copied in, or synced from elsewhere).
const migrated = new Set<string>();
async function ensureLayout(root: string, busy: () => Error) {
  if (migrated.has(root)) return;
  if (await readIndexFile(root) !== null) { migrated.add(root); return; }
  if (await readJson(legacyReviewDatabasePath(root)) !== undefined) {
    await withLock(root, busy, async () => {
      if (await readIndexFile(root) !== null) return;
      const legacy = await readJson(legacyReviewDatabasePath(root)) as { schemaVersion?: number; documents?: (StoredReview & Record<string, unknown>)[] } | undefined;
      if (legacy === undefined) return;
      if (legacy.schemaVersion !== 1 || !Array.isArray(legacy.documents)) throw new Error("Unsupported review database.");
      const documents: Record<string, string> = {};
      for (const doc of legacy.documents) {
        if (!doc || typeof doc.key !== "string") continue;
        const id = isSafeReviewId(doc.id) && !(doc.id in documents) ? doc.id : randomUUID();
        await writeAtomic(documentPath(root, id), JSON.stringify({ ...doc, id }));
        documents[id] = doc.key;
      }
      await writeAtomic(indexPath(root), JSON.stringify({ schemaVersion: 2, documents } satisfies ReviewIndex));
      await rename(legacyReviewDatabasePath(root), `${legacyReviewDatabasePath(root)}.migrated`);
    });
    migrated.add(root);
  }
}

// ---- Lock-free reads. Every file is replaced by an atomic rename, so a read
// sees either the old or the new version, never a partial one.

/** Every stored document's id and key. */
export async function readReviewKeys(root: string): Promise<Map<string, string>> {
  await ensureLayout(root, defaultBusy);
  return await readIndexFile(root) ?? new Map();
}
export async function readReviewDocument<D extends StoredReview>(root: string, id: string): Promise<D | null> {
  if (!isSafeReviewId(id)) return null;
  const key = (await readReviewKeys(root)).get(id);
  return key === undefined ? null : await readDocumentFile<D>(root, id, key) ?? null;
}
export async function findReviewDocument<D extends StoredReview>(root: string, key: string): Promise<D | null> {
  for (const [id, stored] of await readReviewKeys(root)) {
    if (stored !== key) continue;
    const doc = await readDocumentFile<D>(root, id, key);
    if (doc) return doc;
  }
  return null;
}
/** Documents whose key matches, read in index order. */
export async function readReviewDocuments<D extends StoredReview>(root: string, matches: (key: string) => boolean = () => true): Promise<D[]> {
  const documents: D[] = [];
  for (const [id, key] of await readReviewKeys(root)) {
    if (!matches(key)) continue;
    const doc = await readDocumentFile<D>(root, id, key);
    if (doc) documents.push(doc);
  }
  return documents;
}

// ---- Transactions

export interface ReviewTransaction<D extends StoredReview> {
  /** Every stored document's id and key, including changes made in this transaction. */
  keys(): [id: string, key: string][];
  /** The stored document. Changes to the returned object are written on commit. */
  get(id: string): Promise<D | undefined>;
  find(key: string): Promise<D | undefined>;
  /** Adds a document, or replaces the stored one with the same id. */
  put(doc: D): void;
  remove(id: string): void;
}

/**
 * Runs `fn` under the review storage lock. On return, each document it read
 * or put is written if its JSON changed, then the index if a key changed,
 * then removed documents' files are deleted. Nothing changed, nothing written.
 */
export async function withReviewTransaction<D extends StoredReview, T>(root: string, fn: (tx: ReviewTransaction<D>) => T | Promise<T>, busy: () => Error = defaultBusy): Promise<T> {
  await ensureLayout(root, busy);
  return withLock(root, busy, async () => {
    const index = await readIndexFile(root) ?? new Map<string, string>();
    const indexBefore = JSON.stringify([...index]);
    const loaded = new Map<string, { doc: D; before: string | null }>();
    const removed = new Set<string>();
    const tx: ReviewTransaction<D> = {
      keys: () => [...index],
      async get(id) {
        if (removed.has(id)) return undefined;
        const tracked = loaded.get(id);
        if (tracked) return tracked.doc;
        const key = index.get(id);
        if (key === undefined) return undefined;
        const doc = await readDocumentFile<D>(root, id, key);
        // An index entry without its file (an interrupted delete) is dropped.
        if (!doc) { index.delete(id); return undefined; }
        loaded.set(id, { doc, before: JSON.stringify(doc) });
        return doc;
      },
      async find(key) {
        for (const [id, stored] of [...index]) {
          if (stored !== key) continue;
          const doc = await tx.get(id);
          if (doc) return doc;
        }
        return undefined;
      },
      put(doc) {
        if (!isSafeReviewId(doc.id)) throw new Error("Invalid review document ID.");
        removed.delete(doc.id);
        loaded.set(doc.id, { doc, before: loaded.get(doc.id)?.before ?? null });
        index.set(doc.id, doc.key);
      },
      remove(id) { removed.add(id); index.delete(id); loaded.delete(id); },
    };
    const result = await fn(tx);
    // New and changed documents first, then the index that names them, so an
    // interrupted commit leaves at most an unreferenced file.
    for (const [id, { doc, before }] of loaded) {
      index.set(id, doc.key);
      const json = JSON.stringify(doc);
      if (json !== before) await writeAtomic(documentPath(root, id), json);
    }
    if (JSON.stringify([...index]) !== indexBefore) await writeAtomic(indexPath(root), JSON.stringify({ schemaVersion: 2, documents: Object.fromEntries(index) } satisfies ReviewIndex));
    for (const id of removed) await rm(documentPath(root, id), { force: true });
    return result;
  });
}
