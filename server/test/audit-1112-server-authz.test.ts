// Regressions for the 2026-11-12 sync audit, server authorization package:
// PERM-2 (REST commits fence on current access), DATA-15 (blob GC vs upload),
// PERM-3 (album addedBy), WRITE-5 (command replay), STALE-6 server half.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import test from "node:test";

import type * as Y from "yjs";

import { deleteThread, createThread, deleteMessage, editMessage, reattachThread, setThreadStatus } from "../src/api/threads.js";
import { collectOrphanedBlobs } from "../src/blobs/gc.js";
import { setBlobStore, type BlobStore } from "../src/blobs/index.js";
import type { ServerContext } from "../src/context.js";
import { ManifestKeys } from "../src/protocol.js";
import type { SyncServer } from "../src/sync/server.js";
import { sourceText } from "../src/text/ytext.js";
import { json } from "./helpers.js";
import { createProject, startSyncEnv, type SyncEnv } from "./support/sync-fixtures.js";

/** A context whose first transaction runs `before` (e.g. a demotion) just before it starts. */
function racingContext(context: ServerContext, before: () => Promise<void>): ServerContext {
  let armed = true;
  const db = new Proxy(context.db, {
    get(target, property, receiver) {
      if (property !== "transaction") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return () => ({
        execute: async <T>(callback: (trx: never) => Promise<T>) => {
          if (armed) {
            armed = false;
            await before();
          }
          return target.transaction().execute(callback as never);
        },
      });
    },
  });
  return { ...context, db } as ServerContext;
}

async function demote(env: SyncEnv, accountId: string, role: "viewer" | null): Promise<void> {
  if (role) await env.db.updateTable("memberships").set({ role }).where("project_id", "=", env.project.id).where("account_id", "=", accountId).execute();
  else await env.db.deleteFrom("memberships").where("project_id", "=", env.project.id).where("account_id", "=", accountId).execute();
}

for (const role of [null, "viewer"] as const) {
  test(`PERM-2: a queued text restore rechecks access (${role ?? "removed"}) before it writes`, { timeout: 30_000 }, async () => {
    const env = await startSyncEnv();
    const sync = env.server.server.sync as SyncServer;
    const room = sync.acquireRoom(env.docId);
    const originalRun = room.queue.run;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const editor = await env.member("editor");
      const { rooms } = env.server.server.context;
      await rooms.transact(env.docId, "content", { kind: "user", userId: env.owner.id }, { source: "typing" }, (doc) => { sourceText(doc).insert(0, "hello"); });
      await env.db.insertInto("revisions").values({ id: "rev_empty", doc_id: env.docId, server_seq: 0, kind: "named", created_by: env.owner.id }).execute();
      let blocked!: () => void;
      const holding = new Promise<void>((resolve) => { blocked = resolve; });
      const job = rooms.withDocs(env.docId, async () => { blocked(); await gate; });
      await holding;
      let enqueued!: () => void;
      const queued = new Promise<void>((resolve) => { enqueued = resolve; });
      room.queue.run = function<T>(task: () => T | Promise<T>): Promise<T> {
        enqueued();
        return originalRun.call(this, task) as Promise<T>;
      };
      const response = json(env.server.url, `/v1/documents/${env.docId}/restore`, { method: "POST", token: editor.token, body: { revisionId: "rev_empty" } });
      await queued;
      room.queue.run = originalRun;
      await demote(env, editor.id, role);
      release();
      await job;
      const result = await response;
      assert.ok(result.status === 403 || result.status === 404, JSON.stringify(result));
      assert.equal(await rooms.withDocs(env.docId, (docs) => docs.content.getText("source").toString()), "hello");
    } finally {
      room.queue.run = originalRun;
      release();
      sync.releaseRoom(room);
      await env.close();
    }
  });
}

test("PERM-2: thread and message mutations recheck membership inside their write transaction", { timeout: 30_000 }, async () => {
  const env = await startSyncEnv();
  try {
    const context = env.server.server.context;
    const editor = await env.member("editor");
    let n = 0;
    const make = async () => {
      n += 1;
      const id = `thread_audit_${n}`;
      const created = await createThread(context, editor.id, env.docId, { id, anchorId: `anchor_audit_${n}`, quote: "q", body: "hello" });
      assert.equal(created.status, 201);
      return id;
    };
    const status = (id: string) => env.db.selectFrom("threads").select(["status", "deleted_at", "anchor_id"]).where("id", "=", id).executeTakeFirstOrThrow();
    const cases: Array<[string, (racing: ServerContext, id: string) => Promise<unknown>, (id: string) => Promise<boolean>]> = [
      ["setThreadStatus", (racing, id) => setThreadStatus(racing, editor.id, id, { status: "resolved" }), async (id) => (await status(id)).status === "open"],
      ["deleteThread", (racing, id) => deleteThread(racing, editor.id, id), async (id) => (await status(id)).deleted_at === null],
      ["reattachThread", (racing, id) => reattachThread(racing, editor.id, id, { anchorId: "anchor_changed_1", quote: "z" }), async (id) => (await status(id)).anchor_id !== "anchor_changed_1"],
      ["editMessage", (racing, id) => editMessage(racing, editor.id, id, { body: "changed" }), async (id) => (await env.db.selectFrom("messages").select("body").where("id", "=", id).executeTakeFirstOrThrow()).body === "hello"],
      ["deleteMessage", (racing, id) => deleteMessage(racing, editor.id, id), async (id) => (await env.db.selectFrom("messages").select("deleted_at").where("id", "=", id).executeTakeFirstOrThrow()).deleted_at === null],
    ];
    for (const [name, run, untouched] of cases) {
      await demote(env, editor.id, null);
      await env.db.insertInto("memberships").values({ project_id: env.project.id, account_id: editor.id, role: "editor" }).execute();
      const id = await make();
      await assert.rejects(run(racingContext(context, () => demote(env, editor.id, null)), id), { code: "forbidden" }, name);
      assert.ok(await untouched(id), `${name} must not write after removal`);
    }
  } finally { await env.close(); }
});

test("DATA-15: blob gc cannot delete an object an upload re-referenced meanwhile", { timeout: 30_000 }, async () => {
  const env = await startSyncEnv();
  try {
    const body = Buffer.from("same bytes for two projects");
    const hash = createHash("sha256").update(body).digest("hex");
    const stored = new Set<string>([hash]);
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    let deleting!: () => void;
    const deleteStarted = new Promise<void>((resolve) => { deleting = resolve; });
    const store: BlobStore = {
      async put(h) { stored.add(h); },
      async get(): Promise<Readable | null> { return null; },
      async has(h) { return stored.has(h); },
      async delete(h) { deleting(); await deleteGate; stored.delete(h); },
    };
    setBlobStore(env.server.server.context, store);
    await env.db.insertInto("blob_orphans").values({ hash }).execute();
    const other = await createProject(env.db, env.owner.id);

    const collected = collectOrphanedBlobs(env.server.server.context, { olderThanMs: -1_000 });
    await deleteStarted;
    const upload = fetch(`${env.server.url}/v1/projects/${other.id}/blobs/${hash}`, {
      method: "PUT", headers: { authorization: `Bearer ${env.owner.token}`, "content-type": "text/plain" }, body,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseDelete();
    assert.equal(await collected, 1);
    const response = await upload;
    assert.ok(response.status === 201 || response.status === 200, String(response.status));
    const row = await env.db.selectFrom("blobs").select("hash").where("project_id", "=", other.id).where("hash", "=", hash).executeTakeFirst();
    assert.ok(row, "the upload's row committed");
    assert.ok(stored.has(hash), "and its object exists");
  } finally { await env.close(); }
});

test("PERM-3: album addedBy is fixed on creation and cannot be rewritten", { timeout: 30_000 }, async () => {
  const env = await startSyncEnv();
  try {
    await env.db.updateTable("projects").set({ kind: "album" }).where("id", "=", env.project.id).execute();
    const manifest = env.project.manifestDocId;
    const entry = (fileId: string, createdBy: string) => ({
      fileId, path: `${fileId}.jpg`, kind: "blob", blobHash: "a".repeat(64), mime: "image/jpeg", createdBy, createdAt: 1, updatedAt: 1,
    });
    const owner = await env.connect();
    await owner.open(manifest);
    await owner.acked(owner.edit(manifest, "manifest", (doc: Y.Doc) => {
      doc.getMap(ManifestKeys.files).set("f1", entry("f1", env.owner.id));
      doc.getMap(ManifestKeys.photos).set("f1", { fileId: "f1", addedBy: env.owner.id, updatedAt: 1 });
    }));
    const editorAccount = await env.member("editor");
    const editor = await env.connect(editorAccount);
    await editor.open(manifest);

    // Taking over another contributor's photo is refused.
    const takeover = await editor.rejected(editor.edit(manifest, "manifest", (doc: Y.Doc) => {
      doc.getMap(ManifestKeys.photos).set("f1", { fileId: "f1", addedBy: editorAccount.id, updatedAt: 2, updatedBy: editorAccount.id });
    }));
    assert.equal(takeover.reason, "invalid-update");
    await editor.rollback(manifest);
    // A new photo cannot be attributed to somebody else.
    const forged = await editor.rejected(editor.edit(manifest, "manifest", (doc: Y.Doc) => {
      doc.getMap(ManifestKeys.files).set("f2", entry("f2", editorAccount.id));
      doc.getMap(ManifestKeys.photos).set("f2", { fileId: "f2", addedBy: env.owner.id, updatedAt: 2 });
    }));
    assert.equal(forged.reason, "invalid-update");
    await editor.rollback(manifest);
    // Legitimate flows: a caption on someone else's photo, and one's own new photo.
    await editor.acked(editor.edit(manifest, "manifest", (doc: Y.Doc) => {
      doc.getMap(ManifestKeys.photos).set("f1", { fileId: "f1", addedBy: env.owner.id, updatedAt: 3, updatedBy: editorAccount.id, caption: "nice" });
    }));
    await editor.acked(editor.edit(manifest, "manifest", (doc: Y.Doc) => {
      doc.getMap(ManifestKeys.files).set("f2", entry("f2", editorAccount.id));
      doc.getMap(ManifestKeys.photos).set("f2", { fileId: "f2", addedBy: editorAccount.id, updatedAt: 4 });
    }));
  } finally { await env.close(); }
});

test("WRITE-5: replaying a named-revision command whose result was lost creates one revision", { timeout: 30_000 }, async () => {
  const env = await startSyncEnv();
  try {
    const command = { id: "cmd_revision_1", kind: "revision.create", docId: env.docId, body: { label: "Draft one" } };
    const first = await json(env.server.url, "/v1/commands", { token: env.owner.token, body: command });
    assert.equal(first.status, 200, JSON.stringify(first));
    // The crash: the effect committed, the stored result did not.
    await env.db.deleteFrom("commands").where("id", "=", command.id).execute();
    const second = await json(env.server.url, "/v1/commands", { token: env.owner.token, body: command });
    assert.equal(second.status, 200, JSON.stringify(second));
    const rows = await env.db.selectFrom("revisions").select("id").where("doc_id", "=", env.docId).where("kind", "=", "named").execute();
    assert.equal(rows.length, 1);
  } finally { await env.close(); }
});

test("STALE-6: an upload that loses its access writes no object", { timeout: 30_000 }, async () => {
  const env = await startSyncEnv();
  try {
    const body = Buffer.from("no object for a removed contributor");
    const hash = createHash("sha256").update(body).digest("hex");
    const stored = new Set<string>();
    setBlobStore(env.server.server.context, {
      async put(h) { stored.add(h); },
      async get(): Promise<Readable | null> { return null; },
      async has(h) { return stored.has(h); },
    });
    const editor = await env.member("editor");
    await demote(env, editor.id, "viewer");
    const response = await fetch(`${env.server.url}/v1/projects/${env.project.id}/blobs/${hash}`, {
      method: "PUT", headers: { authorization: `Bearer ${editor.token}`, "content-type": "text/plain" }, body,
    });
    assert.equal(response.status, 403);
    assert.equal(stored.size, 0);
  } finally { await env.close(); }
});

