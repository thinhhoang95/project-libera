import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAdminRoot } from "./paths";
import { StorageError } from "./errors";
import { newReview, type ReviewDocument } from "../markdown-review";

type ReviewDatabase = { schemaVersion: 1; documents: ReviewDocument[] };
const databasePath = () => path.join(getAdminRoot(), ".libera", "markdown-reviews.json");
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
    let dirty = true;
    const result = await fn(db, () => { dirty = false; });
    if (!dirty) return result;
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
