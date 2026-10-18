import assert from "node:assert/strict";
import test from "node:test";

import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

import type { HubToReplica } from "../../src/lib/collab/protocol/local";
import { DocHub } from "../../electron/collab/core/doc-hub";
import { createMemoryPortPair, type ReplicaPort } from "../../electron/collab/core/ports";
import { DocHubRegistry } from "../../electron/collab/core/registry";
import { HostStore } from "../../electron/collab/core/store";
import { ManualClock, TestReplica, quietLogger, settle, tempDir, waitFor } from "./support/host-helpers";

function newHub(store: HostStore, docId = "d1") {
  return new DocHub({ docId, store, logger: quietLogger });
}

/** A hub-side port that records how many log rows existed when each message was posted. */
function recordingPort(port: ReplicaPort, store: HostStore, docId: string) {
  const seen: Array<{ message: HubToReplica; rows: number }> = [];
  const wrapped: ReplicaPort = {
    postMessage(message) {
      seen.push({ message, rows: store.allUpdates(docId).length });
      port.postMessage(message);
    },
    onMessage: (listener) => port.onMessage(listener),
    onClose: (listener) => port.onClose?.(listener) ?? (() => {}),
    close: () => port.close(),
  };
  return { port: wrapped, seen };
}

test("a replica update is committed before it is broadcast and before status", async () => {
  const store = new HostStore({ path: ":memory:" });
  const hub = newHub(store);
  const a = createMemoryPortPair();
  const b = createMemoryPortPair();
  const recordA = recordingPort(a.hub, store, "d1");
  const recordB = recordingPort(b.hub, store, "d1");
  hub.attachReplica(recordA.port);
  hub.attachReplica(recordB.port);
  const replicaA = new TestReplica(a.replica, "d1");
  const replicaB = new TestReplica(b.replica, "d1");
  replicaA.attach();
  replicaB.attach();
  await settle();
  recordA.seen.length = 0;
  recordB.seen.length = 0;

  replicaA.edit((text) => text.insert(0, "hello"), { source: "typing" });
  await waitFor(() => replicaB.text() === "hello");
  await waitFor(() => recordA.seen.some((entry) => entry.message.t === "status"), 2000, "status");

  const broadcast = recordB.seen.find((entry) => entry.message.t === "update");
  assert.ok(broadcast, "the other replica got the update");
  assert.equal(broadcast.rows, 1, "the row was committed before the broadcast");
  assert.equal((broadcast.message as Extract<HubToReplica, { t: "update" }>).origin, "local");
  assert.ok(!recordA.seen.some((entry) => entry.message.t === "update"), "the sender does not get its own update back");
  const status = recordA.seen.find((entry) => entry.message.t === "status");
  assert.ok(status && status.rows === 1, "status is sent after the commit");
  const sent = (status.message as Extract<HubToReplica, { t: "status" }>).status;
  assert.equal(sent.pending, 1);
  assert.equal(sent.state, "offline", "no sync client: edits are safe locally");

  const [row] = store.allUpdates("d1");
  assert.deepEqual(row.origin, { kind: "local", provenance: { source: "typing" } });
  hub.close();
  store.close();
});

test("attach sends only what the replica lacks, then meta and status", async () => {
  const store = new HostStore({ path: ":memory:" });
  const hub = newHub(store);
  hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, "hello"));
  const partial = Y.encodeStateAsUpdate(hub.getDoc("content"));
  hub.applyLocalChange("content", (doc) => doc.getText("source").insert(5, " world"));
  hub.applyLocalChange("meta", (doc) => doc.getMap("meta").set("kind", "markdown"));

  const pair = createMemoryPortPair();
  hub.attachReplica(pair.hub);
  const replica = new TestReplica(pair.replica, "d1");
  Y.applyUpdate(replica.docs.get("content") as Y.Doc, partial, "test-replica:hub");
  const vector = Y.encodeStateVector(replica.docs.get("content") as Y.Doc);
  replica.attach();
  await waitFor(() => replica.of("status").length > 0);

  const kinds = replica.messages.map((message) => message.t);
  assert.deepEqual(kinds.slice(0, 5), ["state", "state", "state", "meta", "status"]);
  const contentState = replica.of("state").find((message) => message.subdoc === "content");
  assert.ok(contentState);
  assert.deepEqual(contentState.update, Y.encodeStateAsUpdate(hub.getDoc("content"), vector), "the diff is computed from the replica's state vector");
  assert.ok(contentState.update.length < Y.encodeStateAsUpdate(hub.getDoc("content")).length);
  assert.equal(replica.text(), "hello world");
  assert.equal((replica.docs.get("meta") as Y.Doc).getMap("meta").get("kind"), "markdown");
  const meta = replica.of("meta")[0].meta;
  assert.equal(meta.docId, "d1");
  assert.equal(meta.readOnly, false);
  hub.close();
  store.close();
});

test("two replicas on one hub stay in sync, and in-process changes reach both", async () => {
  const store = new HostStore({ path: ":memory:" });
  const hub = newHub(store);
  const pairA = createMemoryPortPair();
  const pairB = createMemoryPortPair();
  hub.attachReplica(pairA.hub);
  hub.attachReplica(pairB.hub);
  const a = new TestReplica(pairA.replica, "d1");
  const b = new TestReplica(pairB.replica, "d1");
  a.attach();
  b.attach();
  await settle();

  const changes: string[] = [];
  hub.observe("content", (change) => changes.push(change.origin));
  for (let index = 0; index < 20; index += 1) {
    a.edit((text) => text.insert(text.length, "a"));
    b.edit((text) => text.insert(0, "b"));
  }
  const applied = hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, "<"), { source: "ai", feature: "agent" });
  assert.ok(applied, "applyLocalChange returns the update");
  assert.equal(hub.applyLocalChange("content", () => {}), null, "a no-op change returns null");
  await waitFor(() => a.text() === hub.getText() && b.text() === hub.getText() && hub.getText().length === 41);
  assert.equal(a.text(), b.text());
  assert.ok(changes.includes("replica") && changes.includes("local"));
  const rows = store.allUpdates("d1");
  assert.ok(rows.length >= 41);
  const aiRows = rows.filter((row) => row.origin?.kind === "local" && row.origin.provenance?.source === "ai");
  assert.equal(aiRows.length, 1, "the in-process change kept its provenance");
  assert.equal(hub.replicaCount, 2);
  hub.close();
  store.close();
});

test("an update that changes nothing is not persisted again", async () => {
  const store = new HostStore({ path: ":memory:" });
  const hub = newHub(store);
  const pair = createMemoryPortPair();
  hub.attachReplica(pair.hub);
  const replica = new TestReplica(pair.replica, "d1");
  replica.attach();
  await settle();
  replica.edit((text) => text.insert(0, "x"));
  await waitFor(() => store.allUpdates("d1").length === 1);
  const update = Y.encodeStateAsUpdate(replica.docs.get("content") as Y.Doc);
  pair.replica.postMessage({ t: "update", docId: "d1", subdoc: "content", update });
  pair.replica.postMessage({ t: "update", docId: "d1", subdoc: "content", update });
  await settle();
  assert.equal(store.allUpdates("d1").length, 1);
  assert.equal(hub.pendingCount, 1);
  hub.close();
  store.close();
});

test("updates before attach and for another doc are refused", async () => {
  const store = new HostStore({ path: ":memory:" });
  const hub = newHub(store);
  const pair = createMemoryPortPair();
  hub.attachReplica(pair.hub);
  const replica = new TestReplica(pair.replica, "d1");
  replica.edit((text) => text.insert(0, "early"));
  pair.replica.postMessage({ t: "attach", docId: "other", stateVectors: {} });
  await settle();
  assert.equal(store.allUpdates("d1").length, 0);
  assert.equal(replica.of("error").length, 2);
  hub.close();
  store.close();
});

test("awareness is relayed between replicas and cleared when one detaches", async () => {
  const store = new HostStore({ path: ":memory:" });
  const hub = newHub(store);
  const pairA = createMemoryPortPair();
  const pairB = createMemoryPortPair();
  hub.attachReplica(pairA.hub);
  hub.attachReplica(pairB.hub);
  const a = new TestReplica(pairA.replica, "d1");
  const b = new TestReplica(pairB.replica, "d1");
  a.attach();
  b.attach();
  await settle();

  const awarenessA = new Awareness(a.docs.get("content") as Y.Doc);
  awarenessA.setLocalState({ user: { name: "A" }, cursor: 3 });
  pairA.replica.postMessage({ t: "awareness", docId: "d1", update: encodeAwarenessUpdate(awarenessA, [awarenessA.clientID]) });
  await waitFor(() => b.of("awareness").length === 1);
  assert.deepEqual(hub.awareness.getStates().get(awarenessA.clientID), { user: { name: "A" }, cursor: 3 });
  assert.equal(a.of("awareness").length, 0, "the sender does not get its own awareness back");

  pairA.replica.postMessage({ t: "detach", docId: "d1" });
  await waitFor(() => b.of("awareness").length === 2);
  assert.equal(hub.awareness.getStates().has(awarenessA.clientID), false);
  assert.equal(hub.replicaCount, 1);
  awarenessA.destroy();
  hub.close();
  store.close();
});

test("the registry keeps a hub open while referenced and closes it after the idle delay", async () => {
  const store = new HostStore({ path: ":memory:" });
  const clock = new ManualClock();
  let created = 0;
  const registry = new DocHubRegistry({
    clock,
    idleMs: 1000,
    create: (docId) => {
      created += 1;
      return new DocHub({ docId, store, clock, logger: quietLogger });
    },
  });
  const first = registry.acquire("d1");
  const second = registry.acquire("d1");
  assert.equal(first, second);
  assert.equal(created, 1);
  registry.release("d1");
  registry.release("d1");
  assert.equal(registry.refCount("d1"), 0);
  clock.advance(500);
  // Re-acquired before the delay: the same hub, no reload.
  assert.equal(registry.acquire("d1"), first);
  registry.release("d1");
  clock.advance(1000);
  await settle();
  assert.equal(first.isClosed, true);
  assert.equal(registry.get("d1"), null);
  const third = registry.acquire("d1");
  assert.notEqual(third, first);
  assert.equal(created, 2);
  await registry.closeAll();
  assert.equal(third.isClosed, true);
  store.close();
});

test("a hub reloads its state from the log after a restart", () => {
  const temp = tempDir();
  try {
    const path = temp.file("a.sqlite");
    let store = new HostStore({ path });
    let hub = newHub(store);
    hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, "persisted"));
    hub.applyLocalChange("annotations", (doc) => doc.getMap("anchors").set("a1", { id: "a1" }));
    hub.close();
    store.close();
    store = new HostStore({ path });
    hub = newHub(store);
    assert.equal(hub.getText(), "persisted");
    assert.deepEqual(hub.getDoc("annotations").getMap("anchors").toJSON(), { a1: { id: "a1" } });
    assert.equal(hub.pendingCount, 2);
    hub.close();
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("a manifest hub has only the manifest sub-document", () => {
  const store = new HostStore({ path: ":memory:" });
  const hub = new DocHub({ docId: "m1", store, kind: "manifest", logger: quietLogger });
  assert.deepEqual(hub.subdocs, ["manifest"]);
  hub.applyLocalChange("manifest", (doc) => doc.getMap("files").set("f1", { path: "a.md" }));
  hub.close();
  // The kind is remembered in doc_meta.
  const again = new DocHub({ docId: "m1", store, logger: quietLogger });
  assert.equal(again.kind, "manifest");
  assert.match(again.getText(), /a\.md/);
  again.close();
  store.close();
});
