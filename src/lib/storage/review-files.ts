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
import { mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** The fields this module relies on; the rest of a document is opaque here. */
export type StoredReview = { id: string; key: string };

type ReviewIndex = { schemaVersion: 2; documents: Record<string, string> };

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
export const isSafeReviewId = (id: unknown): id is string => typeof id === "string" && SAFE_ID.test(id) && !/^(index|con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id);

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
async function lockPath(root: string) {
  const resolved = await realpath(root).catch((error) => { if (!missing(error)) throw error; return path.resolve(root); });
  const digest = createHash("sha256").update(path.join(resolved, ".libera", "reviews").toLowerCase()).digest("hex").slice(0, 32);
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
  if (!index || index.schemaVersion !== 2 || !index.documents || typeof index.documents !== "object" || Array.isArray(index.documents)) throw new Error("Unsupported review index.");
  const ids = new Set<string>();
  for (const [id, key] of Object.entries(index.documents)) {
    if (!isSafeReviewId(id) || typeof key !== "string" || ids.has(id.toLowerCase())) throw new Error("Unsupported review index.");
    ids.add(id.toLowerCase());
  }
  return new Map(Object.entries(index.documents));
}

/**
 * An index entry whose file is not on disk, usually one a sync has not
 * delivered yet. Opening that review fails (never replaced by an empty one);
 * listings skip it and moves re-key it without reading it.
 */
export class ReviewDocumentMissingError extends Error {}
const skipMissing = (error: unknown) => { if (error instanceof ReviewDocumentMissingError) return undefined; throw error; };

async function readDocumentFile<D extends StoredReview>(root: string, id: string, key: string): Promise<D | undefined> {
  const doc = await readJson(documentPath(root, id)) as D | undefined;
  if (doc === undefined) throw new ReviewDocumentMissingError("Review document is missing. Wait for library sync to finish, then retry.");
  if (!doc || typeof doc !== "object" || doc.id !== id) throw new Error("Unsupported review document.");
  doc.key = key;
  return doc;
}

// Temp files go to the OS temp folder when a rename from there reaches the
// library (same volume), else beside the target. Remembered per directory.
const crossVolume = new Set<string>();
async function renameReview(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) {
      if (attempt >= 9 || !["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await delay(50 * (attempt + 1));
    }
  }
}
async function writeAtomic(target: string, contents: string) {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true });
  const local = !crossVolume.has(directory);
  const temporary = local ? path.join(os.tmpdir(), "libera-locks", `review-${randomUUID()}.tmp`) : `${target}.${randomUUID()}.tmp`;
  try {
    if (local) await mkdir(path.dirname(temporary), { recursive: true });
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
    await renameReview(temporary, target);
  } catch (error) {
    if (!local || (error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    crossVolume.add(directory);
    await rm(temporary, { force: true });
    return writeAtomic(target, contents);
  } finally { await rm(temporary, { force: true }); }
}

async function withLock<T>(root: string, busy: () => Error, fn: () => Promise<T>): Promise<T> {
  const target = await lockPath(root);
  await mkdir(path.dirname(target), { recursive: true });
  const token = `${process.pid}-${randomUUID()}`;
  const candidate = `${target}.${token}`;
  await mkdir(candidate);
  let locked = false;
  try {
    await writeFile(path.join(candidate, token), "", { flag: "wx" });
    for (let attempt = 0; attempt < 100; attempt++) {
      // Publish a nonempty directory: a late recoverer's rmdir cannot remove
      // a new owner's lock, and its unique marker cannot remove the new marker.
      try { await rename(candidate, target); locked = true; break; }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "ENOTDIR", "EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        try {
          const entries = await readdir(target);
          for (const entry of entries) {
            const owner = Number(entry.split("-")[0]);
            if (!Number.isInteger(owner) || owner <= 0) throw new Error("Unsupported review lock.");
            try { process.kill(owner, 0); }
            catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ESRCH") await rm(path.join(target, entry), { force: true }); }
          }
          await rmdir(target).catch((cause) => { if (!missing(cause) && !["ENOTEMPTY", "EEXIST"].includes(cause.code)) throw cause; });
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOTDIR") {
            // Locks left by the single-file protocol can only be replaced by directories.
            const owner = Number(await readFile(target, "utf8"));
            try { if (Number.isInteger(owner) && owner > 0) process.kill(owner, 0); else if (Date.now() - (await stat(target)).mtimeMs > 30_000) await unlink(target).catch(() => undefined); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") await unlink(target).catch(() => undefined); }
          } else if (!missing(cause)) throw cause;
        }
        await delay(50);
      }
    }
    if (!locked) throw busy();
    return await fn();
  } finally {
    const directory = locked ? target : candidate;
    await rm(path.join(directory, token), { force: true });
    await rmdir(directory).catch((cause) => { if (!missing(cause) && !["ENOTEMPTY", "EEXIST"].includes(cause.code)) throw cause; });
  }
}

const defaultBusy = () => new Error("Review storage is busy. Try again in a moment.");

// A legacy database can arrive after the index (sync), or remain after an interrupted migration.
async function ensureLayout(root: string, busy: () => Error) {
  if (await readJson(legacyReviewDatabasePath(root)) !== undefined) {
    await withLock(root, busy, async () => {
      const legacy = await readJson(legacyReviewDatabasePath(root)) as { schemaVersion?: number; documents?: (StoredReview & Record<string, unknown>)[] } | undefined;
      if (legacy === undefined) return;
      if (legacy.schemaVersion !== 1 || !Array.isArray(legacy.documents)) throw new Error("Unsupported review database.");
      const documents = await readIndexFile(root) ?? new Map<string, string>();
      const ids = new Set([...documents.keys()].map((id) => id.toLowerCase()));
      const keys = new Set(documents.values());
      for (const doc of legacy.documents) {
        if (!doc || typeof doc.key !== "string") continue;
        if (keys.has(doc.key)) continue;
        const id = isSafeReviewId(doc.id) && !ids.has(doc.id.toLowerCase()) ? doc.id : randomUUID();
        await writeAtomic(documentPath(root, id), JSON.stringify({ ...doc, id }));
        documents.set(id, doc.key); ids.add(id.toLowerCase());
      }
      await writeAtomic(indexPath(root), JSON.stringify({ schemaVersion: 2, documents: Object.fromEntries(documents) } satisfies ReviewIndex));
      await renameReview(legacyReviewDatabasePath(root), `${legacyReviewDatabasePath(root)}.migrated`);
    });
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
    const doc = await readDocumentFile<D>(root, id, key).catch(skipMissing);
    if (doc) documents.push(doc);
  }
  return documents;
}

// ---- Transactions

export interface ReviewTransaction<D extends StoredReview> {
  /** Every stored document's id and key, including changes made in this transaction. */
  keys(): [id: string, key: string][];
  /** The stored document. Changes to the returned object are written on commit. ReviewDocumentMissingError when its file is not on disk. */
  get(id: string): Promise<D | undefined>;
  /** Like `get`, but undefined when the document's file is not on disk. */
  getIfPresent(id: string): Promise<D | undefined>;
  find(key: string): Promise<D | undefined>;
  /** Moves a document to another key without reading it (its file may not be on disk yet). */
  rekey(id: string, key: string): void;
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
        if (!doc) return undefined;
        loaded.set(id, { doc, before: JSON.stringify(doc) });
        return doc;
      },
      getIfPresent: (id) => tx.get(id).catch(skipMissing),
      rekey(id, key) { if (index.has(id) && !removed.has(id)) { index.set(id, key); const tracked = loaded.get(id); if (tracked) tracked.doc.key = key; } },
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
        if ([...index.keys()].some((id) => id !== doc.id && id.toLowerCase() === doc.id.toLowerCase())) throw new Error("Duplicate review document ID.");
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
