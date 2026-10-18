import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import type * as Y from "yjs";

import { EventKind, MessageType, type Actor, type RemoteMessage } from "../src/protocol.js";
import { addMember, createDocument, startSyncEnv, type SyncEnv } from "./support/sync-fixtures.js";

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

describe("RoomService", () => {
  let env: SyncEnv;
  before(async () => {
    env = await startSyncEnv({ ROOM_IDLE_MS: 100, SYNC_CONNECTIONS_PER_MINUTE: 1000 });
  });
  after(() => env.close());

  test("transact persists the server change and broadcasts it to every socket, requester included", async () => {
    const docId = await createDocument(env.db, env.project.id);
    const rooms = env.server.server.context.rooms;
    const a = await env.connect();
    const b = await env.connect(await env.member("editor"));
    await a.open(docId);
    await b.open(docId);
    await a.acked(a.edit(docId, "content", insert("base ")));

    const actor: Actor = { kind: "system", reason: "decision", onBehalfOf: env.owner.id };
    const { serverSeq, result } = await rooms.transact(docId, "content", actor, { source: "suggestion", suggestionId: "sug_1" }, (doc) => {
      doc.getText("source").insert(0, "[accepted] ");
      return "done";
    });
    assert.equal(result, "done");
    assert.equal(serverSeq, 2);
    for (const client of [a, b]) {
      const remote: RemoteMessage = await client.waitFor<RemoteMessage>((m) => m.type === MessageType.Remote && m.serverSeq === serverSeq);
      assert.equal(remote.userId, "");
      assert.equal(remote.clientId, "");
      assert.deepEqual(remote.provenance, { source: "suggestion", suggestionId: "sug_1" });
      assert.equal(client.text(docId), "[accepted] base ");
    }
    const row = await env.db
      .selectFrom("doc_updates")
      .select(["client_id", "client_seq", "actor", "account_id"])
      .where("doc_id", "=", docId)
      .where("server_seq", "=", serverSeq)
      .executeTakeFirstOrThrow();
    assert.equal(row.client_id, "server");
    assert.equal(row.client_seq, serverSeq);
    assert.deepEqual(row.actor, actor);
    assert.equal(row.account_id, env.owner.id);

    // A change that throws leaves nothing behind.
    await assert.rejects(
      rooms.transact(docId, "content", actor, { source: "system" }, (doc) => {
        doc.getText("source").insert(0, "half-done ");
        throw new Error("abort");
      }),
      /abort/,
    );
    const unchanged = await rooms.transact(docId, "content", actor, { source: "system" }, () => 1);
    assert.equal(unchanged.serverSeq, serverSeq, "an empty change persists nothing");
    const view = await rooms.withDocs(docId, (docs, seq) => ({ text: docs.content.getText("source").toString(), seq }));
    assert.deepEqual(view, { text: "[accepted] base ", seq: serverSeq });
    assert.equal(await rooms.currentServerSeq(docId), serverSeq);

    // Client updates keep working after the aborted change.
    await b.acked(b.edit(docId, "content", insert("more")));
    assert.equal(await rooms.withDocs(docId, (docs) => docs.content.getText("source").toString()), "[accepted] base more");
    await a.close();
    await b.close();
  });

  test("transact works on a document nobody has open", async () => {
    const docId = await createDocument(env.db, env.project.id);
    const rooms = env.server.server.context.rooms;
    const actor: Actor = { kind: "system", reason: "import" };
    const { serverSeq } = await rooms.transact(docId, "content", actor, { source: "import" }, insert("imported"));
    assert.equal(serverSeq, 1);
    const client = await env.connect();
    await client.open(docId);
    assert.equal(client.text(docId), "imported");
    await client.close();
  });

  test("membershipChanged re-scopes roles and revokes access", async () => {
    const docId = await createDocument(env.db, env.project.id);
    const rooms = env.server.server.context.rooms;
    const account = await env.member("commenter");
    const client = await env.connect(account);
    await client.open(docId);
    assert.equal((await client.rejected(client.edit(docId, "content", insert("x")))).reason, "forbidden");
    await client.rollback(docId);

    await addMember(env.db, env.project.id, account.id, "editor");
    rooms.membershipChanged(env.project.id, account.id, "editor");
    const event = await client.waitFor((m) => m.type === MessageType.Event && m.kind === EventKind.RoleChanged);
    assert.deepEqual(event.type === MessageType.Event && event.payload, { projectId: env.project.id, role: "editor" });
    assert.equal(event.type === MessageType.Event && event.scope, "user");
    await client.acked(client.edit(docId, "content", insert("now allowed")));

    await env.db
      .deleteFrom("memberships")
      .where("project_id", "=", env.project.id)
      .where("account_id", "=", account.id)
      .execute();
    rooms.membershipChanged(env.project.id, account.id, null);
    const closed = await client.waitFor((m) => m.type === MessageType.Closed && m.docId === docId);
    assert.equal(closed.type === MessageType.Closed && closed.reason, "access-revoked");
    assert.equal((await client.rejected(client.edit(docId, "content", insert("y")))).reason, "not-open");
    client.send({ type: MessageType.Open, docId, subdocs: [] });
    const refused = await client.waitFor((m) => m.type === MessageType.Closed && m.docId === docId);
    assert.equal(refused.type === MessageType.Closed && refused.reason, "not-found");
    await client.close();
  });

  test("documentDeleted closes the document everywhere and unloads its room", async () => {
    const docId = await createDocument(env.db, env.project.id);
    const rooms = env.server.server.context.rooms;
    const a = await env.connect();
    const b = await env.connect();
    await a.open(docId);
    await b.open(docId);
    const loaded = env.server.server.sync.roomCount();
    await env.db.updateTable("documents").set({ deleted_at: new Date() }).where("id", "=", docId).execute();
    rooms.documentDeleted(docId);
    for (const client of [a, b]) {
      const closed = await client.waitFor((m) => m.type === MessageType.Closed && m.docId === docId);
      assert.equal(closed.type === MessageType.Closed && closed.reason, "document-deleted");
    }
    assert.equal(env.server.server.sync.roomCount(), loaded - 1);
    a.send({ type: MessageType.Open, docId, subdocs: [] });
    const refused = await a.waitFor((m) => m.type === MessageType.Closed && m.docId === docId);
    assert.equal(refused.type === MessageType.Closed && refused.reason, "not-found");
    await a.close();
    await b.close();
  });

  test("idle rooms unload and reload the same state from the database", async () => {
    const docId = await createDocument(env.db, env.project.id);
    const client = await env.connect();
    await client.open(docId);
    for (let index = 0; index < 10; index += 1) await client.acked(client.edit(docId, "content", insert(`${index} `)));
    await client.acked(client.edit(docId, "annotations", (doc) => doc.getMap("anchors").set("a1", { createdBy: env.owner.id })));
    const expected = client.text(docId);
    await client.close();
    await waitUntil(() => env.server.server.sync.roomCount() === 0, "room unloads after ROOM_IDLE_MS");

    const again = await env.connect();
    const opened = await again.open(docId);
    assert.equal(opened.serverSeq, 11);
    assert.equal(again.text(docId), expected);
    assert.deepEqual(again.doc(docId, "annotations").getMap("anchors").toJSON(), { a1: { createdBy: env.owner.id } });
    await again.close();
  });
});
