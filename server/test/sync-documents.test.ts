import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

import {
  AnnotationKeys,
  ManifestKeys,
  MessageType,
  SyncLimits,
  type AnchorRecord,
  type AwarenessMessage,
  type RemoteMessage,
  type SuggestionRecord,
} from "../src/protocol.js";
import type { SyncTestClient } from "./support/sync-client.js";
import { createDocument, startSyncEnv, type SyncEnv } from "./support/sync-fixtures.js";

function insert(text: string, at?: number) {
  return (doc: Y.Doc) => {
    const source = doc.getText("source");
    source.insert(at ?? source.length, text);
  };
}

function anchor(id: string, createdBy: string): AnchorRecord {
  return { id, kind: "comment", start: { assoc: 0 }, end: { assoc: 0 }, createdBy, createdAt: Date.now() };
}

function suggestion(id: string, createdBy: string, status: SuggestionRecord["status"] = "pending"): SuggestionRecord {
  return {
    id,
    actor: { kind: "user", userId: createdBy },
    createdBy,
    start: { assoc: 0 },
    end: { assoc: 0 },
    baseQuote: "a",
    replacement: "b",
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function setEntry(map: string, key: string, value: unknown) {
  return (doc: Y.Doc) => doc.getMap(map).set(key, value);
}

async function serverText(env: SyncEnv, docId = env.docId): Promise<string> {
  return env.server.server.context.rooms.withDocs(docId, (docs) => docs.content.getText("source").toString());
}

async function eventually(check: () => boolean | Promise<boolean>, message: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

describe("sync documents", () => {
  let env: SyncEnv;
  before(async () => {
    env = await startSyncEnv({ SYNC_CONNECTIONS_PER_MINUTE: 1000, SYNC_MAX_SOCKETS_PER_ACCOUNT: 100 });
  });
  after(() => env.close());

  test("opened carries only what the client's state vector lacks", async () => {
    const docId = await createDocument(env.db, env.project.id);
    const writer = await env.connect();
    const empty = await writer.open(docId);
    assert.equal(empty.serverSeq, 0);
    assert.equal(empty.role, "owner");
    assert.equal(empty.projectId, env.project.id);
    assert.deepEqual(empty.subdocs.map((entry) => entry.subdoc).sort(), ["annotations", "content", "meta"]);
    await writer.acked(writer.edit(docId, "content", insert("hello")));

    const reader = await env.connect();
    await reader.open(docId);
    assert.equal(reader.text(docId), "hello");
    const known = Y.encodeStateVector(reader.doc(docId, "content"));
    reader.send({ type: MessageType.Close, docId });
    await reader.waitFor((m) => m.type === MessageType.Closed && m.reason === "client-closed");

    await writer.acked(writer.edit(docId, "content", insert(" world")));
    const reopened = await reader.open(docId);
    assert.equal(reader.text(docId), "hello world");
    assert.equal(reopened.serverSeq, 2);
    const content = reopened.subdocs.find((entry) => entry.subdoc === "content");
    assert.ok(content);
    const knownClocks = Y.decodeStateVector(known);
    const structs = Y.decodeUpdate(content.diff).structs;
    assert.ok(structs.length > 0);
    for (const struct of structs) {
      assert.ok(struct.id.clock >= (knownClocks.get(struct.id.client) ?? 0), "diff resends nothing the client had");
    }
    assert.deepEqual(content.stateVector, Y.encodeStateVector(writer.doc(docId, "content")));
    await writer.close();
    await reader.close();
  });

  test("two clients editing concurrently converge", async () => {
    const docId = await createDocument(env.db, env.project.id);
    const editor = await env.member("editor");
    const a = await env.connect();
    const b = await env.connect(editor);
    await a.open(docId);
    await b.open(docId);
    const sent = [];
    for (let index = 0; index < 25; index += 1) {
      sent.push({ client: a, update: a.edit(docId, "content", insert(`a${index} `, 0)) });
      sent.push({ client: b, update: b.edit(docId, "content", insert(`b${index} `)) });
    }
    await Promise.all(sent.map(({ client, update }) => client.acked(update)));
    await eventually(() => a.remotes.length === 25 && b.remotes.length === 25, "every remote arrives");
    assert.equal(a.text(docId), b.text(docId));
    assert.equal(await serverText(env, docId), a.text(docId));
    for (let index = 0; index < 25; index += 1) {
      assert.ok(a.text(docId).includes(`a${index} `) && a.text(docId).includes(`b${index} `));
    }
    const remote = b.remotes[0] as RemoteMessage;
    assert.equal(remote.userId, env.owner.id);
    assert.equal(remote.clientId, a.clientId);
    await a.close();
    await b.close();
  });

  test("acks arrive in clientSeq order with increasing serverSeqs", async () => {
    const docId = await createDocument(env.db, env.project.id);
    const client = await env.connect();
    await client.open(docId);
    const sent = Array.from({ length: 40 }, (_, index) => client.edit(docId, "content", insert(`${index},`)));
    await Promise.all(sent.map((update) => client.acked(update)));
    const acks = client.received.filter((m) => m.type === MessageType.Ack && m.docId === docId);
    assert.deepEqual(
      acks.map((ack) => ack.type === MessageType.Ack && ack.clientSeq),
      sent.map((update) => update.clientSeq),
    );
    const serverSeqs = acks.map((ack) => (ack.type === MessageType.Ack ? ack.serverSeq : 0));
    for (let index = 1; index < serverSeqs.length; index += 1) assert.ok(serverSeqs[index] > serverSeqs[index - 1]);
    assert.equal(serverSeqs.at(-1), await env.server.server.context.rooms.currentServerSeq(docId));
    await client.close();
  });

  test("a resent update gets the same serverSeq and is applied once", async () => {
    const docId = await createDocument(env.db, env.project.id);
    const client = await env.connect();
    const watcher = await env.connect();
    await client.open(docId);
    await watcher.open(docId);
    const sent = client.edit(docId, "content", insert("once"));
    const first = await client.acked(sent);
    client.sendUpdate(sent);
    const second = await client.acked(sent);
    assert.equal(second.serverSeq, first.serverSeq);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(watcher.remotes.length, 1, "the resend is not fanned out again");
    const rows = await env.db
      .selectFrom("doc_updates")
      .select("server_seq")
      .where("doc_id", "=", docId)
      .execute();
    assert.equal(rows.length, 1);
    assert.equal(await serverText(env, docId), "once");
    await client.close();
    await watcher.close();
  });

  test("viewers and commenters cannot write content; viewers cannot write annotations", async () => {
    const docId = await createDocument(env.db, env.project.id);
    const viewer = await env.connect(await env.member("viewer"));
    const commenter = await env.connect(await env.member("commenter"));
    for (const client of [viewer, commenter]) {
      await client.open(docId);
      const rejected = await client.rejected(client.edit(docId, "content", insert("nope")));
      assert.equal(rejected.reason, "forbidden");
      await client.rollback(docId);
    }
    const annotation = await viewer.rejected(
      viewer.edit(docId, "annotations", setEntry(AnnotationKeys.anchors, "x", anchor("x", "someone"))),
    );
    assert.equal(annotation.reason, "forbidden");
    assert.equal(await serverText(env, docId), "", "nothing rejected was applied");
    const fresh = await env.connect();
    await fresh.open(docId);
    assert.equal(fresh.text(docId), "");
    for (const client of [viewer, commenter, fresh]) await client.close();
  });

  test("commenters may only change their own annotations; suggestion status is server-owned", async () => {
    const docId = await createDocument(env.db, env.project.id);
    const commenterAccount = await env.member("commenter");
    const owner = await env.connect();
    const commenter = await env.connect(commenterAccount);
    await owner.open(docId);
    await commenter.open(docId);
    const mine = commenterAccount.id;
    const anchors = AnnotationKeys.anchors;
    const suggestions = AnnotationKeys.suggestions;

    await owner.acked(owner.edit(docId, "annotations", setEntry(anchors, "owners", anchor("owners", env.owner.id))));
    await commenter.acked(commenter.edit(docId, "annotations", setEntry(anchors, "mine", anchor("mine", mine))));
    await commenter.acked(
      commenter.edit(docId, "annotations", setEntry(anchors, "mine", { ...anchor("mine", mine), createdAt: 1 })),
    );

    const attempts: Array<[string, (doc: Y.Doc) => void]> = [
      ["edit someone else's anchor", setEntry(anchors, "owners", anchor("owners", mine))],
      ["delete someone else's anchor", (doc) => doc.getMap(anchors).delete("owners")],
      ["create an anchor for someone else", setEntry(anchors, "forged", anchor("forged", env.owner.id))],
      ["write outside the annotation maps", setEntry("other", "x", { createdBy: mine })],
      ["create an accepted suggestion", setEntry(suggestions, "s0", suggestion("s0", mine, "accepted"))],
    ];
    for (const [label, change] of attempts) {
      await eventually(() => commenter.remotes.length >= 1, "commenter saw the owner's anchor");
      const rejected = await commenter.rejected(commenter.edit(docId, "annotations", change));
      assert.equal(rejected.reason, "annotation-ownership", label);
      await commenter.rollback(docId);
    }

    await commenter.acked(commenter.edit(docId, "annotations", setEntry(suggestions, "s1", suggestion("s1", mine))));
    const accept = await commenter.rejected(
      commenter.edit(docId, "annotations", setEntry(suggestions, "s1", suggestion("s1", mine, "accepted"))),
    );
    assert.equal(accept.reason, "annotation-ownership");
    await commenter.rollback(docId);
    await commenter.acked(
      commenter.edit(docId, "annotations", setEntry(suggestions, "s1", suggestion("s1", mine, "withdrawn"))),
    );

    // Editors are bound by the status rules too.
    await commenter.acked(commenter.edit(docId, "annotations", setEntry(suggestions, "s2", suggestion("s2", mine))));
    await eventually(
      async () =>
        (await env.server.server.context.rooms.withDocs(docId, (docs) => docs.annotations.getMap(suggestions).size)) === 2 &&
        owner.doc(docId, "annotations").getMap(suggestions).size === 2,
      "owner has both suggestions",
    );
    const decided = await owner.rejected(
      owner.edit(docId, "annotations", setEntry(suggestions, "s2", suggestion("s2", mine, "rejected"))),
    );
    assert.equal(decided.reason, "annotation-ownership");
    await owner.rollback(docId);
    const withdrawOthers = await owner.rejected(
      owner.edit(docId, "annotations", setEntry(suggestions, "s2", suggestion("s2", mine, "withdrawn"))),
    );
    assert.equal(withdrawOthers.reason, "annotation-ownership");
    await owner.rollback(docId);
    await owner.acked(owner.edit(docId, "annotations", (doc) => doc.getMap(anchors).delete("mine")));

    const state = await env.server.server.context.rooms.withDocs(docId, (docs) => ({
      anchors: docs.annotations.getMap<AnchorRecord>(anchors).toJSON(),
      suggestions: docs.annotations.getMap<SuggestionRecord>(suggestions).toJSON(),
    }));
    assert.deepEqual(Object.keys(state.anchors), ["owners"]);
    assert.equal(state.anchors.owners.createdBy, env.owner.id);
    assert.equal(state.suggestions.s1.status, "withdrawn");
    assert.equal(state.suggestions.s2.status, "pending");
    await owner.close();
    await commenter.close();
  });

  test("manifest entries with unsafe paths are rejected", async () => {
    const client = await env.connect();
    const opened = await client.open(env.project.manifestDocId);
    assert.deepEqual(opened.subdocs.map((entry) => entry.subdoc), ["manifest"]);
    const entry = (path: string) => ({ fileId: "f1", path, kind: "doc", createdBy: env.owner.id, createdAt: 1, updatedAt: 1 });
    for (const path of ["../escape.md", "/abs.md", "notes/con.md", ".libera/x.md"]) {
      const rejected = await client.rejected(
        client.edit(env.project.manifestDocId, "manifest", setEntry(ManifestKeys.files, "f1", entry(path))),
      );
      assert.equal(rejected.reason, "invalid-update", path);
      await client.rollback(env.project.manifestDocId);
    }
    await client.acked(
      client.edit(env.project.manifestDocId, "manifest", setEntry(ManifestKeys.files, "f1", entry("notes/a.md"))),
    );
    const wrong = await client.rejected(client.edit(env.project.manifestDocId, "content", insert("x")));
    assert.equal(wrong.reason, "invalid-update");
    await client.close();
  });

  test("malformed, oversized and out-of-order updates are rejected without being applied", async () => {
    const docId = await createDocument(env.db, env.project.id);
    const client = await env.connect();
    await client.open(docId);
    const garbage = client.sendUpdate({ docId, subdoc: "content", clientSeq: client.nextSeq(), update: new Uint8Array([1, 2, 3, 4, 5]) });
    assert.equal((await client.rejected(garbage)).reason, "invalid-update");

    // An update whose predecessor the server never received.
    const detached = new Y.Doc();
    detached.getText("source").insert(0, "first");
    const before = Y.encodeStateVector(detached);
    detached.getText("source").insert(5, " second");
    const gap = client.sendUpdate({
      docId,
      subdoc: "content",
      clientSeq: client.nextSeq(),
      update: Y.encodeStateAsUpdate(detached, before),
    });
    assert.equal((await client.rejected(gap)).reason, "invalid-update");

    const huge = client.sendUpdate({
      docId,
      subdoc: "content",
      clientSeq: client.nextSeq(),
      update: new Uint8Array(SyncLimits.maxUpdateBytes + 1),
    });
    assert.equal((await client.rejected(huge)).reason, "too-large");

    const notOpen = await createDocument(env.db, env.project.id);
    const closed = client.sendUpdate({ docId: notOpen, subdoc: "content", clientSeq: client.nextSeq(), update: new Uint8Array() });
    assert.equal((await client.rejected(closed)).reason, "not-open");

    await client.acked(client.edit(docId, "content", insert("fine")));
    assert.equal(await serverText(env, docId), "fine");
    client.send({ type: MessageType.Open, docId: "doc_missing", subdocs: [] });
    const notFound = await client.waitFor((m) => m.type === MessageType.Closed && m.docId === "doc_missing");
    assert.equal(notFound.type === MessageType.Closed && notFound.reason, "not-found");
    await client.close();
  });

  test("AI provenance is stored with an AI actor bound to the account", async () => {
    const docId = await createDocument(env.db, env.project.id);
    const client = await env.connect();
    await client.open(docId);
    const sent = client.edit(docId, "content", insert("drafted"), {
      source: "ai",
      feature: "rewrite",
      model: "some/model",
      runId: "run_1",
      suggestedBy: { kind: "user", userId: "spoofed" },
    });
    await client.acked(sent);
    const row = await env.db
      .selectFrom("doc_updates")
      .select(["actor", "provenance", "account_id", "client_id"])
      .where("doc_id", "=", docId)
      .executeTakeFirstOrThrow();
    assert.deepEqual(row.actor, {
      kind: "ai",
      onBehalfOf: env.owner.id,
      clientId: client.clientId,
      feature: "rewrite",
      model: "some/model",
      runId: "run_1",
    });
    assert.deepEqual(row.provenance, { source: "ai", feature: "rewrite", model: "some/model", runId: "run_1" });
    assert.equal(row.account_id, env.owner.id);
    assert.equal(row.client_id, client.clientId);
    await client.close();
  });

  test("awareness is relayed between sockets, including viewers, and removed on disconnect", async () => {
    const docId = await createDocument(env.db, env.project.id);
    const viewerAccount = await env.member("viewer");
    const a = await env.connect();
    const b = await env.connect(viewerAccount);
    await a.open(docId);
    await b.open(docId);

    const presenceA = new Awareness(new Y.Doc());
    const presenceB = new Awareness(new Y.Doc());
    const seenByB = new Awareness(new Y.Doc());
    try {
      presenceA.setLocalState({ user: "a", cursor: 1 });
      a.send({ type: MessageType.Awareness, docId, update: encodeAwarenessUpdate(presenceA, [presenceA.clientID]) });
      const relayed = await b.waitFor<AwarenessMessage>((m) => m.type === MessageType.Awareness);
      applyAwarenessUpdate(seenByB, relayed.update, "server");
      assert.deepEqual(seenByB.getStates().get(presenceA.clientID), { user: "a", cursor: 1 });

      presenceB.setLocalState({ user: "b" });
      b.send({ type: MessageType.Awareness, docId, update: encodeAwarenessUpdate(presenceB, [presenceB.clientID]) });
      await a.waitFor((m) => m.type === MessageType.Awareness);

      // B cannot overwrite A's presence.
      const forged = new Awareness(new Y.Doc());
      forged.clientID = presenceA.clientID;
      forged.meta.set(presenceA.clientID, { clock: 100, lastUpdated: Date.now() });
      forged.states.set(presenceA.clientID, { user: "forged" });
      b.send({ type: MessageType.Awareness, docId, update: encodeAwarenessUpdate(forged, [presenceA.clientID]) });
      forged.destroy();
      // Frames on one socket are handled in order, so the pong means the forgery was processed.
      b.send({ type: MessageType.Ping, nonce: 7 });
      await b.waitFor((m) => m.type === MessageType.Pong);

      const late = await env.connect();
      await late.open(docId);
      const snapshot = await late.waitFor<AwarenessMessage>((m) => m.type === MessageType.Awareness && m.docId === docId);
      const seenByLate = new Awareness(new Y.Doc());
      applyAwarenessUpdate(seenByLate, snapshot.update, "server");
      assert.deepEqual(seenByLate.getStates().get(presenceA.clientID), { user: "a", cursor: 1 });
      assert.deepEqual(seenByLate.getStates().get(presenceB.clientID), { user: "b" });
      seenByLate.destroy();

      a.ws.terminate();
      const removal = await b.waitFor<AwarenessMessage>((m) => m.type === MessageType.Awareness);
      applyAwarenessUpdate(seenByB, removal.update, "server");
      assert.equal(seenByB.getStates().has(presenceA.clientID), false);
      await late.close();
      await b.close();
    } finally {
      presenceA.destroy();
      presenceB.destroy();
      seenByB.destroy();
    }
  });

  test("events reach sockets by doc, project and user scope", async () => {
    const docId = await createDocument(env.db, env.project.id);
    const memberAccount = await env.member("editor");
    const opener = await env.connect();
    const idle = await env.connect(memberAccount);
    await opener.open(docId);
    const { events } = env.server.server.context;
    const isEvent = (kind: string) => (m: { type: number; kind?: string }) => m.type === MessageType.Event && m.kind === kind;

    events.publish({ scope: "doc", id: docId, kind: "test.doc", payload: { n: 1 } });
    events.publish({ scope: "project", id: env.project.id, kind: "test.project", payload: { n: 2 } });
    events.publish({ scope: "project", id: "prj_other", kind: "test.other-project", payload: {} });
    events.publish({ scope: "user", id: memberAccount.id, kind: "test.user", payload: { n: 3 } });

    const docEvent = await opener.waitFor(isEvent("test.doc"));
    assert.deepEqual(docEvent, { type: MessageType.Event, scope: "doc", id: docId, kind: "test.doc", payload: { n: 1 } });
    await opener.waitFor(isEvent("test.project"));
    await idle.waitFor(isEvent("test.user"));
    assert.equal(await opener.sees(isEvent("test.user"), 100), false);
    assert.equal(await idle.sees(isEvent("test.doc"), 50), false);
    assert.equal(await idle.sees(isEvent("test.project"), 50), false, "no document of the project is open");
    assert.equal(await opener.sees(isEvent("test.other-project"), 50), false);
    await opener.close();
    await idle.close();
  });
});
