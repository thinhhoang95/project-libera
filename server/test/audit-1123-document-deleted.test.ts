import assert from "node:assert/strict";
import test from "node:test";

import { MessageType } from "../src/protocol.js";
import type { SyncServer } from "../src/sync/server.js";
import { startSyncEnv } from "./support/sync-fixtures.js";

// C10: a deleted file reaches a member as `document-deleted` on every path,
// never as `not-found` or `access-revoked` (which the client reads as losing
// the notebook).

const closedFor = (docId: string) => (message: { type: number } & { docId?: string }) =>
  message.type === MessageType.Closed && message.docId === docId;

test("an update that races a file delete closes the document as document-deleted", { timeout: 30_000 }, async () => {
  const env = await startSyncEnv();
  try {
    const editor = await env.member("editor");
    const client = await env.connect(editor);
    await client.open(env.docId);
    // The row is gone before the server's notification reaches the room.
    await env.db.updateTable("documents").set({ deleted_at: new Date() }).where("id", "=", env.docId).execute();
    client.edit(env.docId, "content", (doc) => doc.getText("source").insert(0, "late"));
    const closed = await client.waitFor<{ type: number; reason: string }>(closedFor(env.docId) as never);
    assert.equal(closed.reason, "document-deleted");
  } finally { await env.close(); }
});

test("a removed member still hears access-revoked when their update races the removal", { timeout: 30_000 }, async () => {
  const env = await startSyncEnv();
  try {
    const editor = await env.member("editor");
    const client = await env.connect(editor);
    await client.open(env.docId);
    await env.db.deleteFrom("memberships").where("project_id", "=", env.project.id).where("account_id", "=", editor.id).execute();
    client.edit(env.docId, "content", (doc) => doc.getText("source").insert(0, "late"));
    const closed = await client.waitFor<{ type: number; reason: string }>(closedFor(env.docId) as never);
    assert.equal(closed.reason, "access-revoked");
  } finally { await env.close(); }
});

test("an open whose document is deleted while it waits in the room queue is document-deleted", { timeout: 30_000 }, async () => {
  const env = await startSyncEnv();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sync = env.server.server.sync as SyncServer;
  const room = sync.acquireRoom(env.docId);
  try {
    const editor = await env.member("editor");
    const client = await env.connect(editor);
    let blocked!: () => void;
    const holding = new Promise<void>((resolve) => { blocked = resolve; });
    const job = env.server.server.context.rooms.withDocs(env.docId, async () => { blocked(); await gate; });
    await holding;
    client.send({ type: MessageType.Open, docId: env.docId, subdocs: [] });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await env.db.updateTable("documents").set({ deleted_at: new Date() }).where("id", "=", env.docId).execute();
    release();
    await job;
    const closed = await client.waitFor<{ type: number; reason: string }>(closedFor(env.docId) as never);
    assert.equal(closed.reason, "document-deleted");
  } finally {
    release();
    sync.releaseRoom(room);
    await env.close();
  }
});
