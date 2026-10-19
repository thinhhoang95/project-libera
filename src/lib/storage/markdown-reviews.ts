import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getStateRoot } from "./paths";
import { StorageError } from "./errors";
import { agentSuggestionTitle, anchorAt, newReview, syncReview, type AgentSuggestion, type ReviewDocument, type ReviewRange } from "../markdown-review";

type ReviewDatabase = { schemaVersion: 1; documents: ReviewDocument[] };
const databasePath = () => path.join(getStateRoot(), ".libera", "markdown-reviews.json");
async function readDatabase(): Promise<ReviewDatabase> {
  try {
    const db = JSON.parse(await readFile(databasePath(), "utf8"));
    if (db.schemaVersion !== 1 || !Array.isArray(db.documents)) throw new Error("Unsupported review database.");
    return db;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, documents: [] }; throw error; }
}
// One atomic database keeps document identities and their paths consistent
// during folder moves. An OS lock also coordinates separate Next workers.
async function transaction<T>(fn: (db: ReviewDatabase, unchanged: () => void) => T | Promise<T>): Promise<T> {
  const target = databasePath();
  await mkdir(path.dirname(target), { recursive: true });
  let lock;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { lock = await open(`${target}.lock`, "wx", 0o600); await lock.writeFile(String(process.pid)); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Recover a lock left by a dead worker. Never steal from a live owner.
      try {
        const owner = Number(await readFile(`${target}.lock`, "utf8"));
        if (Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); }
          catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ESRCH") await rm(`${target}.lock`, { force: true }); }
        } else if (Date.now() - (await stat(`${target}.lock`)).mtimeMs > 30_000) await rm(`${target}.lock`, { force: true });
      } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
      await delay(50);
    }
  }
  if (!lock) throw new StorageError("Review storage is busy. Retry; if the app crashed, restart it and check the review storage lock.", 409);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const db = await readDatabase();
    const before = JSON.stringify(db);
    let dirty = true;
    const result = await fn(db, () => { dirty = false; });
    if (!dirty || JSON.stringify(db) === before) return result;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(db)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target);
    return result;
  } finally { await rm(temporary, { force: true }); await lock.close(); await rm(`${target}.lock`, { force: true }); }
}
export async function loadReview(key: string, snapshot: string) {
  // Atomic rename makes an existing snapshot safe to read without a write lock.
  const existing = (await readDatabase()).documents.find((d) => d.key === key);
  if (existing) return existing;
  return transaction((db, unchanged) => {
    let doc = db.documents.find((d) => d.key === key);
    if (doc) unchanged();
    if (!doc) { doc = newReview(key, snapshot, randomUUID()); db.documents.push(doc); }
    return doc;
  });
}
/** A document's stored review, or null when it has none. Never creates one. */
export async function findReview(key: string) {
  return (await readDatabase()).documents.find((d) => d.key === key) ?? null;
}
/**
 * Add comment threads to a document's review, creating it if needed. `snapshot`
 * is the text the ranges refer to; existing threads are mapped onto it first.
 * Review mode is turned on so the new comments are highlighted.
 */
export async function addReviewThreads(key: string, snapshot: string, threads: { range: ReviewRange; text: string; author?: "agent" }[]) {
  return transaction((db) => {
    let index = db.documents.findIndex((d) => d.key === key);
    if (index < 0) { db.documents.push(newReview(key, snapshot, randomUUID())); index = db.documents.length - 1; }
    const doc = syncReview(db.documents[index], snapshot);
    const createdAt = new Date().toISOString();
    for (const thread of threads) {
      doc.threads.push({ id: randomUUID(), anchor: anchorAt(snapshot, thread.range), messages: [{ id: randomUUID(), text: thread.text, createdAt, ...(thread.author ? { author: thread.author } : {}) }], status: "open" });
    }
    doc.enabled = true;
    doc.revision++;
    db.documents[index] = doc;
    return doc;
  });
}
/** Add a reply to one of a document's review threads. StorageError 404 when the review or thread is gone. */
export async function addReviewReply(key: string, threadId: string, text: string, author?: "agent") {
  return transaction((db) => {
    const doc = db.documents.find((d) => d.key === key);
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
  return transaction((db) => {
    let index = db.documents.findIndex((d) => d.key === key);
    if (index < 0) { db.documents.push(newReview(key, snapshot, randomUUID())); index = db.documents.length - 1; }
    const doc = syncReview(db.documents[index], snapshot);
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
    db.documents[index] = doc;
    return doc;
  });
}
export async function readReview(id: string) {
  const doc = (await readDatabase()).documents.find((d) => d.id === id);
  if (!doc) throw new StorageError("Review document was not found.", 404);
  return doc;
}
export async function updateReview(id: string, revision: number, change: (doc: ReviewDocument) => ReviewDocument) {
  return transaction((db) => {
    const index = db.documents.findIndex((d) => d.id === id);
    if (index < 0) throw new StorageError("Review document was not found.", 404);
    if (db.documents[index].revision !== revision) throw new StorageError("Review changed in another window. Reload review before retrying.", 409);
    const next = change(structuredClone(db.documents[index]));
    next.revision = revision + 1;
    db.documents[index] = next;
    return next;
  });
}
export async function moveReviewPath(from: string, to: string) {
  return transaction((db) => {
    for (const doc of db.documents) if (doc.key === from || doc.key.startsWith(`${from}/`)) {
      doc.key = to + doc.key.slice(from.length); doc.revision++;
    }
  });
}
export async function deleteReviewPath(key: string) {
  return transaction((db) => { db.documents = db.documents.filter((d) => d.key !== key && !d.key.startsWith(`${key}/`)); });
}
export async function copyReviewPath(from: string, to: string) {
  return transaction((db) => {
    const originals = db.documents.filter((d) => d.key === from || d.key.startsWith(`${from}/`));
    for (const original of originals) {
      const copied = newReview(to + original.key.slice(from.length), original.snapshot, randomUUID());
      copied.enabled = original.enabled;
      copied.threads = structuredClone(original.threads).map((t) => ({ ...t, id: randomUUID(), messages: t.messages.map((m) => ({ ...m, id: randomUUID() })) }));
      db.documents.push(copied);
    }
  });
}
export async function listRecoverableReviews() {
  return (await readDatabase()).documents.filter((d) => d.key.startsWith("draft:") && (d.threads.length || d.session)).map((d) => ({ id: d.id, key: d.key, snapshot: d.snapshot, commentCount: d.threads.length }));
}
/** Add review documents kept elsewhere, skipping ones the library already has. */
export async function mergeReviewDocuments(documents: ReviewDocument[]) {
  if (!documents.length) return;
  return transaction((db, unchanged) => {
    const ids = new Set(db.documents.map((d) => d.id));
    const keys = new Set(db.documents.map((d) => d.key));
    const added = documents.filter((d) => d && typeof d.id === "string" && typeof d.key === "string" && !ids.has(d.id) && !keys.has(d.key));
    if (!added.length) { unchanged(); return; }
    db.documents.push(...added);
  });
}
