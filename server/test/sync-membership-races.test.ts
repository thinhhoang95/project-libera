import assert from "node:assert/strict";
import test from "node:test";

import { MessageType, type Role } from "../src/protocol.js";
import type { SyncServer } from "../src/sync/server.js";
import { persistUpdate, UpdateAccessChangedError } from "../src/sync/store.js";
import { json } from "./helpers.js";
import { startSyncEnv } from "./support/sync-fixtures.js";

for (const nextRole of [null, "viewer"] as const) {
  test(`a queued open rechecks membership after ${nextRole === null ? "removal" : "demotion"}`, { timeout: 30_000 }, async () => {
    const env = await startSyncEnv();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sync = env.server.server.sync as SyncServer;
    const room = sync.acquireRoom(env.docId);
    const originalRun = room.queue.run;
    try {
      const editor = await env.member("editor");
      const client = await env.connect(editor);
      let blocked!: () => void;
      const holding = new Promise<void>((resolve) => { blocked = resolve; });
      const job = env.server.server.context.rooms.withDocs(env.docId, async () => { blocked(); await gate; });
      await holding;
      let enqueued!: () => void;
      const queued = new Promise<void>((resolve) => { enqueued = resolve; });
      room.queue.run = function<T>(task: () => T | Promise<T>): Promise<T> {
        enqueued();
        return originalRun.call(this, task) as Promise<T>;
      };
      client.send({ type: MessageType.Open, docId: env.docId, subdocs: [] });
      const response = client.waitFor((message) => "docId" in message && message.docId === env.docId &&
        (message.type === MessageType.Opened || message.type === MessageType.Closed));
      await queued;
      room.queue.run = originalRun;
      const changed = await json(env.server.url, `/v1/projects/${env.project.id}/members/${editor.id}`, {
        method: nextRole === null ? "DELETE" : "PATCH", token: env.owner.token,
        ...(nextRole === null ? {} : { body: { role: nextRole } }),
      });
      assert.equal(changed.status, nextRole === null ? 204 : 200);
      release();
      await job;
      const opened = await response;
      if (nextRole === null) {
        assert.equal(opened.type, MessageType.Closed);
      } else {
        assert.equal(opened.type, MessageType.Opened);
        if (opened.type === MessageType.Opened) assert.equal(opened.role, "viewer");
        const sent = client.edit(env.docId, "content", (doc) => doc.getText("source").insert(0, "not allowed"));
        assert.equal((await client.rejected(sent)).reason, "forbidden");
      }
      assert.equal(await env.server.server.context.rooms.withDocs(env.docId, (docs) => docs.content.getText("source").toString()), "");
    } finally {
      room.queue.run = originalRun;
      release();
      sync.releaseRoom(room);
      await env.close();
    }
  });
}

test("persistence rejects an access change without allocating a server sequence", async () => {
  const env = await startSyncEnv();
  try {
    const editor = await env.member("editor");
    for (const role of ["viewer", null] as Array<Role | null>) {
      if (role) await env.db.updateTable("memberships").set({ role }).where("project_id", "=", env.project.id).where("account_id", "=", editor.id).execute();
      else await env.db.deleteFrom("memberships").where("project_id", "=", env.project.id).where("account_id", "=", editor.id).execute();
      await assert.rejects(persistUpdate(env.db, {
        docId: env.docId, subdoc: "content", accountId: editor.id, clientId: "client_access_race", clientSeq: 1,
        actor: { kind: "user", userId: editor.id }, provenance: { source: "typing" }, update: new Uint8Array([0, 0]),
        requiredAccess: { projectId: env.project.id, role: "editor" },
      }), UpdateAccessChangedError);
      const doc = await env.db.selectFrom("documents").select("last_server_seq").where("id", "=", env.docId).executeTakeFirstOrThrow();
      assert.equal(doc.last_server_seq, 0);
    }
  } finally { await env.close(); }
});
