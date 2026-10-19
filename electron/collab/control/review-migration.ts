// One-time move of local review comments to a shared notebook (Phase 2).
//
// Before sharing, review threads live in `<library>/.libera/markdown-reviews.json`
// (src/lib/storage/markdown-reviews.ts), keyed by Libera path. Once a notebook
// is shared its files show server threads instead, so the owner can move the
// old ones over: each thread gets an anchor in the document's annotations
// (from its stored range, when the quote still matches the current text) and
// a server thread authored by the owner with its messages in order. The local
// threads are marked `migratedTo`, never deleted, so nothing is lost if the
// server copy is later removed.
//
// The Next server writes the same file under an OS lock file; the host is a
// separate process, so it follows the same protocol (`<file>.lock` created
// exclusively and holding the owner's pid, atomic rename) instead of importing
// the Next storage module, which resolves its paths from Next's environment.

import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { ReviewDocument, ReviewThread } from "../../../src/lib/markdown-review";

export interface ReviewDatabase {
  schemaVersion: 1;
  documents: MigratableDocument[];
}

/** Marker the migration writes on each local thread it moved. */
export interface MigrationMarker {
  docId: string;
  threadId: string;
  at: string;
}

export type MigratableThread = ReviewThread & { migratedTo?: MigrationMarker };
export type MigratableDocument = Omit<ReviewDocument, "threads"> & { threads: MigratableThread[] };

export function reviewDatabasePath(libraryRoot: string): string {
  return path.join(libraryRoot, ".libera", "markdown-reviews.json");
}

export async function readReviewDatabase(libraryRoot: string): Promise<ReviewDatabase> {
  try {
    const parsed = JSON.parse(await readFile(reviewDatabasePath(libraryRoot), "utf8")) as ReviewDatabase;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.documents)) throw new Error("Unsupported review database.");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, documents: [] };
    throw error;
  }
}

/** Runs `change` on the database under the review storage lock and writes it back atomically. */
export async function updateReviewDatabase(libraryRoot: string, change: (db: ReviewDatabase) => void): Promise<void> {
  const target = reviewDatabasePath(libraryRoot);
  const lockPath = `${target}.lock`;
  let lock;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      lock = await open(lockPath, "wx", 0o600);
      await lock.writeFile(String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Same recovery rule as the Next side: only a dead owner's lock is removed.
      try {
        const owner = Number(await readFile(lockPath, "utf8"));
        if (Number.isInteger(owner) && owner > 0) {
          try {
            process.kill(owner, 0);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ESRCH") await rm(lockPath, { force: true });
          }
        } else if (Date.now() - (await stat(lockPath)).mtimeMs > 30_000) {
          await rm(lockPath, { force: true });
        }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      await delay(50);
    }
  }
  if (!lock) throw new Error("Review storage is busy. Try again in a moment.");
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const db = await readReviewDatabase(libraryRoot);
    change(db);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(db));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

/** Review documents of one notebook folder ("Notebook/...") with threads not yet migrated. */
export function documentsToMigrate(db: ReviewDatabase, notebook: string): MigratableDocument[] {
  const prefix = `${notebook}/`;
  return db.documents.filter((doc) => typeof doc.key === "string" && doc.key.startsWith(prefix) && doc.threads.some((thread) => !thread.migratedTo));
}

/**
 * Where a local thread's anchor lands in the current shared text: its stored
 * range when the quote is still there, else the quote's only occurrence.
 * Null when the quote is gone or repeated (the thread is created detached and
 * the owner reattaches it; repeated passages are never guessed).
 */
export function locateLocalAnchor(thread: ReviewThread, text: string): { start: number; end: number } | null {
  const { start, end, quote } = thread.anchor;
  if (!quote) return null;
  if (Number.isInteger(start) && Number.isInteger(end) && end > start && text.slice(start, end) === quote) return { start, end };
  const first = text.indexOf(quote);
  if (first < 0 || text.indexOf(quote, first + 1) >= 0) return null;
  return { start: first, end: first + quote.length };
}

/**
 * Stable ids per (document, local thread or message), so running the
 * migration again (after a crash between the server write and the marker)
 * replays the same creates, which the server answers with the existing rows.
 */
export function migrationId(prefix: "thr" | "msg" | "anc", ...parts: string[]): string {
  return `${prefix}_mig_${createHash("sha256").update(parts.join("\u0000")).digest("base64url").slice(0, 32)}`;
}
