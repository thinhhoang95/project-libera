import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import * as Y from "yjs";

import { newId } from "../src/ids.js";
import { loadSubdocState } from "../src/sync/index.js";
import { createDocument, startSyncEnv, type SyncEnv } from "./support/sync-fixtures.js";

function insert(text: string) {
  return (doc: Y.Doc) => {
    const source = doc.getText("source");
    source.insert(source.length, text);
  };
}

async function waitUntil(check: () => boolean, message: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

describe("compaction", () => {
  let env: SyncEnv;
  before(async () => {
    env = await startSyncEnv({ SNAPSHOT_EVERY_UPDATES: 5, LOG_RETENTION_DAYS: 30, ROOM_IDLE_MS: 50 });
  });
  after(() => env.close());

  const compact = () => env.server.server.jobs.runNow("compaction");
  const snapshots = (docId: string) =>
    env.db
      .selectFrom("doc_snapshots")
      .select(["subdoc", "upto_server_seq"])
      .where("doc_id", "=", docId)
      .orderBy("subdoc")
      .orderBy("upto_server_seq")
      .execute();

  test("busy sub-documents are snapshotted and cold loads match the pre-compaction state", async () => {
    const docId = await createDocument(env.db, env.project.id);
    const client = await env.connect();
    await client.open(docId);
    for (let index = 0; index < 12; index += 1) await client.acked(client.edit(docId, "content", insert(`c${index} `)));
    for (let index = 0; index < 2; index += 1) {
      await client.acked(client.edit(docId, "annotations", (doc) => doc.getMap("anchors").set(`a${index}`, { createdBy: env.owner.id })));
    }
    const before = client.text(docId);

    // Compaction while the room is live and a client keeps writing.
    const writes = Array.from({ length: 5 }, (_, index) => client.edit(docId, "content", insert(`live${index} `)));
    await compact();
    await Promise.all(writes.map((sent) => client.acked(sent)));
    assert.ok(before.length > 0);

    const written = await snapshots(docId);
    assert.ok(written.length >= 1);
    assert.ok(written.every((row) => row.subdoc === "content"), "only content had enough updates");
    await compact();
    const settled = (await snapshots(docId)).length;
    await compact();
    assert.equal((await snapshots(docId)).length, settled, "nothing new to snapshot");

    // A tail after the snapshot.
    await client.acked(client.edit(docId, "content", insert("tail")));
    const expected = client.text(docId);
    await client.close();
    await waitUntil(() => env.server.server.sync.roomCount() === 0, "room unloads");

    const cold = await env.connect();
    await cold.open(docId);
    assert.equal(cold.text(docId), expected);
    assert.deepEqual(Object.keys(cold.doc(docId, "annotations").getMap("anchors").toJSON()).sort(), ["a0", "a1"]);
    await cold.close();
  });

  test("retention prunes old covered updates and keeps revision snapshots", async () => {
    const docId = await createDocument(env.db, env.project.id);
    const client = await env.connect();
    await client.open(docId);
    let revisionSeq = 0;
    let revisionText = "";
    for (let index = 0; index < 9; index += 1) {
      const ack = await client.acked(client.edit(docId, "content", insert(`r${index} `)));
      if (index === 3) {
        revisionSeq = ack.serverSeq;
        revisionText = client.text(docId);
      }
    }
    await client.acked(client.edit(docId, "meta", (doc) => doc.getMap("meta").set("schemaVersion", 1)));
    await env.db
      .insertInto("revisions")
      .values({ id: newId("rev"), doc_id: docId, server_seq: revisionSeq, kind: "named", label: "v1" })
      .execute();
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await env.db.updateTable("doc_updates").set({ received_at: old }).where("doc_id", "=", docId).execute();
    // Two recent updates stay in the log; a revision between them is rebuilt from the cutoff snapshot.
    const recent = await client.acked(client.edit(docId, "content", insert("recent1 ")));
    const recentText = client.text(docId);
    await env.db
      .insertInto("revisions")
      .values({ id: newId("rev"), doc_id: docId, server_seq: recent.serverSeq, kind: "auto" })
      .execute();
    await client.acked(client.edit(docId, "content", insert("recent2")));
    const expected = client.text(docId);

    await compact();

    const remaining = await env.db
      .selectFrom("doc_updates")
      .select(["server_seq", "subdoc"])
      .where("doc_id", "=", docId)
      .orderBy("server_seq")
      .execute();
    assert.deepEqual(
      remaining.map((row) => row.subdoc),
      ["content", "content"],
      "every update older than the cutoff is pruned",
    );
    const kept = await snapshots(docId);
    for (const subdoc of ["content", "annotations", "meta"]) {
      assert.ok(
        kept.some((row) => row.subdoc === subdoc && row.upto_server_seq === revisionSeq),
        `revision snapshot for ${subdoc}`,
      );
    }
    const atRevision = await loadSubdocState(env.db, docId, "content", revisionSeq);
    assert.equal(atRevision.getText("source").toString(), revisionText);
    atRevision.destroy();
    const atRecent = await loadSubdocState(env.db, docId, "content", recent.serverSeq);
    assert.equal(atRecent.getText("source").toString(), recentText);
    atRecent.destroy();
    const cutoffSeq = revisionSeq + 6;
    assert.deepEqual(
      kept.filter((row) => row.subdoc === "content").map((row) => row.upto_server_seq),
      [revisionSeq, cutoffSeq, cutoffSeq + 2],
      "revision, cutoff and latest snapshots remain",
    );

    await client.close();
    await waitUntil(() => env.server.server.sync.roomCount() === 0, "room unloads");
    const cold = await env.connect();
    await cold.open(docId);
    assert.equal(cold.text(docId), expected);
    assert.equal(cold.doc(docId, "meta").getMap("meta").get("schemaVersion"), 1);

    // Still writable, and still loads after another pass.
    await cold.acked(cold.edit(docId, "content", insert(" after")));
    const final = cold.text(docId);
    await cold.close();
    await compact();
    await waitUntil(() => env.server.server.sync.roomCount() === 0, "room unloads");
    const fromDb = await loadSubdocState(env.db, docId, "content");
    assert.equal(fromDb.getText("source").toString(), final);
    fromDb.destroy();
  });
});
