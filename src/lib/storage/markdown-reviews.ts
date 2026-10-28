import { randomUUID } from "node:crypto";
import { getStateRoot } from "./paths";
import { StorageError } from "./errors";
import { findReviewDocument, isSafeReviewId, readReviewDocument, readReviewDocuments, withReviewTransaction, type ReviewTransaction } from "./review-files";
import { agentSuggestionTitle, anchorAt, newReview, syncReview, type AgentSuggestion, type ReviewDocument, type ReviewRange } from "../markdown-review";

// Each document's review is its own file (review-files.ts), so a write
// rewrites only the document it changed. A lock coordinates separate Next
// workers and the Electron host.
function transaction<T>(fn: (tx: ReviewTransaction<ReviewDocument>) => T | Promise<T>): Promise<T> {
  return withReviewTransaction(getStateRoot(), fn, () => new StorageError("Review storage is busy. Retry; if the app crashed, restart it and check the review storage lock.", 409));
}
export async function loadReview(key: string, snapshot: string) {
  // Atomic rename makes an existing review safe to read without a write lock.
  const existing = await findReviewDocument<ReviewDocument>(getStateRoot(), key);
  if (existing) return existing;
  return transaction(async (tx) => {
    let doc = await tx.find(key);
    if (!doc) { doc = newReview(key, snapshot, randomUUID()); tx.put(doc); }
    return doc;
  });
}
/** A document's stored review, or null when it has none. Never creates one. */
export async function findReview(key: string) {
  return findReviewDocument<ReviewDocument>(getStateRoot(), key);
}
/**
 * Add comment threads to a document's review, creating it if needed. `snapshot`
 * is the text the ranges refer to; existing threads are mapped onto it first.
 * Review mode is turned on so the new comments are highlighted.
 */
export async function addReviewThreads(key: string, snapshot: string, threads: { range: ReviewRange; text: string; author?: "agent" }[]) {
  return transaction(async (tx) => {
    const doc = syncReview(await tx.find(key) ?? newReview(key, snapshot, randomUUID()), snapshot);
    const createdAt = new Date().toISOString();
    for (const thread of threads) {
      doc.threads.push({ id: randomUUID(), anchor: anchorAt(snapshot, thread.range), messages: [{ id: randomUUID(), text: thread.text, createdAt, ...(thread.author ? { author: thread.author } : {}) }], status: "open" });
    }
    doc.enabled = true;
    doc.revision++;
    tx.put(doc);
    return doc;
  });
}
/** Add a reply to one of a document's review threads. StorageError 404 when the review or thread is gone. */
export async function addReviewReply(key: string, threadId: string, text: string, author?: "agent") {
  return transaction(async (tx) => {
    const doc = await tx.find(key);
    const thread = doc?.threads.find((t) => t.id === threadId);
    if (!doc || !thread) throw new StorageError("Comment thread was not found.", 404);
    const message = { id: randomUUID(), text, createdAt: new Date().toISOString(), ...(author ? { author } : {}) };
    thread.messages.push(message);
    doc.revision++;
    return { doc, thread, message };
  });
}
export type AgentSuggestionInput = {
  /** The passage to replace, in `snapshot`. */
  range: ReviewRange;
  after: string;
  reason: string;
  title?: string;
  /** Becomes an agent comment thread on the passage, linked to the suggestion. */
  comment?: string;
  runId?: string;
};
/**
 * Add agent suggestions (pending suggested edits) to a document's review, the
 * way addReviewThreads adds comments: `snapshot` is the text the ranges refer
 * to, existing threads and suggestions are mapped onto it first, and review
 * mode is turned on so the suggestions show.
 */
export async function addAgentSuggestions(key: string, snapshot: string, suggestions: AgentSuggestionInput[]) {
  return transaction(async (tx) => {
    const doc = syncReview(await tx.find(key) ?? newReview(key, snapshot, randomUUID()), snapshot);
    const createdAt = new Date().toISOString();
    const added: AgentSuggestion[] = suggestions.map((input) => {
      const anchor = anchorAt(snapshot, input.range);
      const commentIds: string[] = [];
      if (input.comment?.trim()) {
        const thread = { id: randomUUID(), anchor, messages: [{ id: randomUUID(), text: input.comment.trim(), createdAt, author: "agent" as const }], status: "open" as const };
        doc.threads.push(thread);
        commentIds.push(thread.id);
      }
      return {
        id: randomUUID(), version: 1, title: input.title?.trim() || agentSuggestionTitle(input.reason), reason: input.reason, commentIds,
        edits: [{ start: anchor.start, end: anchor.end, before: anchor.quote, after: input.after }], anchors: [anchor],
        status: "pending", author: "agent", createdAt, ...(input.runId ? { runId: input.runId } : {}),
      };
    });
    doc.agentSuggestions = [...(doc.agentSuggestions ?? []), ...added];
    doc.enabled = true;
    doc.revision++;
    tx.put(doc);
    return doc;
  });
}
export async function readReview(id: string) {
  const doc = await readReviewDocument<ReviewDocument>(getStateRoot(), id);
  if (!doc) throw new StorageError("Review document was not found.", 404);
  return doc;
}
/**
 * Apply `change` to the stored review at `revision`. A change that leaves the
 * document as it was (a sync against the same text) returns it unchanged: no
 * new revision and no write.
 */
export async function updateReview(id: string, revision: number, change: (doc: ReviewDocument) => ReviewDocument) {
  if (!isSafeReviewId(id)) throw new StorageError("Review document was not found.", 404);
  return transaction(async (tx) => {
    const stored = await tx.get(id);
    if (!stored) throw new StorageError("Review document was not found.", 404);
    if (stored.revision !== revision) throw new StorageError("Review changed in another window. Reload review before retrying.", 409);
    const next = change(structuredClone(stored));
    if (JSON.stringify(next) === JSON.stringify(stored)) return stored;
    next.revision = revision + 1;
    tx.put(next);
    return next;
  });
}
const under = (key: string, folder: string) => key === folder || key.startsWith(`${folder}/`);
export async function moveReviewPath(from: string, to: string) {
  return transaction(async (tx) => {
    // A review whose file has not synced yet still follows its file.
    for (const [id, key] of tx.keys()) if (under(key, from)) {
      const doc = await tx.getIfPresent(id);
      if (doc) { doc.key = to + doc.key.slice(from.length); doc.revision++; }
      else tx.rekey(id, to + key.slice(from.length));
    }
  });
}
export async function deleteReviewPath(key: string) {
  return transaction((tx) => { for (const [id, stored] of tx.keys()) if (under(stored, key)) tx.remove(id); });
}
export async function copyReviewPath(from: string, to: string) {
  return transaction(async (tx) => {
    for (const [id, key] of tx.keys()) if (under(key, from)) {
      const original = await tx.getIfPresent(id);
      if (!original) continue;
      const copied = newReview(to + original.key.slice(from.length), original.snapshot, randomUUID());
      copied.enabled = original.enabled;
      copied.threads = structuredClone(original.threads).map((t) => ({ ...t, id: randomUUID(), messages: t.messages.map((m) => ({ ...m, id: randomUUID() })) }));
      tx.put(copied);
    }
  });
}
export async function listRecoverableReviews() {
  return (await readReviewDocuments<ReviewDocument>(getStateRoot(), (key) => key.startsWith("draft:"))).filter((d) => d.threads.length || d.session).map((d) => ({ id: d.id, key: d.key, snapshot: d.snapshot, commentCount: d.threads.length }));
}
/** Add review documents kept elsewhere, skipping ones the library already has. */
export async function mergeReviewDocuments(documents: ReviewDocument[]) {
  if (!documents.length) return;
  return transaction((tx) => {
    const keys = tx.keys();
    const ids = new Set(keys.map(([id]) => id));
    const paths = new Set(keys.map(([, key]) => key));
    for (const doc of documents) {
      if (!doc || typeof doc.id !== "string" || typeof doc.key !== "string" || ids.has(doc.id) || paths.has(doc.key)) continue;
      tx.put(isSafeReviewId(doc.id) ? doc : { ...doc, id: randomUUID() });
    }
  });
}
