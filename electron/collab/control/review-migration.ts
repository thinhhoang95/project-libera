// One-time move of local review comments to a shared notebook (Phase 2).
//
// Before sharing, review threads live in `<library>/.libera/reviews/`, one file
// per document (src/lib/storage/review-files.ts), keyed by Libera path. Once a notebook
// is shared its files show server threads instead, so the owner can move the
// old ones over: each thread gets an anchor in the document's annotations
// (from its stored range, when the quote still matches the current text) and
// a server thread authored by the owner with its messages in order. The local
// threads are marked `migratedTo`, never deleted, so nothing is lost if the
// server copy is later removed.
//
// The Next server writes the same files; the host is a separate process, so it
// uses review-files.ts directly with the library root (and so the same lock)
// instead of the Next storage module, which resolves its paths from Next's
// environment.

import { createHash } from "node:crypto";

import type { ReviewDocument, ReviewThread } from "../../../src/lib/markdown-review";
import { readReviewDocuments, withReviewTransaction } from "../../../src/lib/storage/review-files";

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

export async function readReviewDatabase(libraryRoot: string): Promise<ReviewDatabase> {
  return { schemaVersion: 1, documents: await readReviewDocuments<MigratableDocument>(libraryRoot) };
}

/**
 * Runs `change` on every stored document under the review storage lock and
 * writes back the ones it changed or added.
 */
export async function updateReviewDatabase(libraryRoot: string, change: (db: ReviewDatabase) => void): Promise<void> {
  await withReviewTransaction<MigratableDocument, void>(libraryRoot, async (tx) => {
    const documents: MigratableDocument[] = [];
    for (const [id] of tx.keys()) {
      const doc = await tx.get(id);
      if (doc) documents.push(doc);
    }
    const db: ReviewDatabase = { schemaVersion: 1, documents };
    change(db);
    for (const doc of db.documents) tx.put(doc);
  });
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
