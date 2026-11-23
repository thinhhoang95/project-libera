// Three-way sync review 2026-11-23, package K2 (outbound queue): C12 (an uncuttable
// update blocks its subdoc), H11 (a delete-only diff is still sent), H12 (batches
// without local seqs count as pending), M12 (split pieces are stored atomically).

import assert from "node:assert/strict";
import test from "node:test";

import * as Y from "yjs";

import { MessageType, type OpenedMessage, type UpdateMessage } from "../../src/lib/collab/protocol/messages";
import { DocHub, type HubTransport } from "../../electron/collab/core/doc-hub";
import { OutboundQueue } from "../../electron/collab/core/outbound";
import { HostStore } from "../../electron/collab/core/store";
import { ManualClock, quietLogger, settle } from "./support/host-helpers";

const EMPTY = Y.encodeStateVector(new Y.Doc());

function fakeTransport() {
  const sent: UpdateMessage[] = [];
  const transport: HubTransport = {
    send: (message) => { sent.push(message); return true; },
    sendAwareness: () => {},
    reopen: () => true,
  };
  return { transport, sent };
}

function opened(): OpenedMessage {
  return { type: MessageType.Opened, docId: "d1", projectId: "p1", role: "editor", schemaVersion: 1, serverSeq: 0, subdocs: [{ subdoc: "content", diff: new Uint8Array(), stateVector: EMPTY }] };
}

function queueFor(store: HostStore, maxUpdateBytes?: number): OutboundQueue {
  return new OutboundQueue({
    docId: "d1",
    store,
    clock: new ManualClock(),
    logger: quietLogger,
    limits: { batchWindowMs: 1, batchMaxBytes: 1, ...(maxUpdateBytes ? { maxUpdateBytes } : {}) },
  });
}

test("C12: after an uncuttable update, later updates of that subdoc are held, not sent past the gap", async () => {
  const store = new HostStore({ path: ":memory:" });
  const hub = new DocHub({ docId: "d1", store, logger: quietLogger, limits: { maxUpdateBytes: 200, batchMaxBytes: 1 } });
  const link = fakeTransport();
  hub.connectionChanged(link.transport);
  hub.handleOpened(opened());
  hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, "x".repeat(1000)));
  hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, "small"));
  for (let round = 0; round < 3; round += 1) { await hub.flushOutbound(); await settle(); }
  assert.equal(link.sent.length, 0, "nothing of this subdoc is sent: it would depend on the skipped clocks");
  assert.ok(hub.syncBlockedDetail?.includes("cannot be synced"), "the user still sees why");
  assert.equal(hub.pendingCount, 2, "both changes stay pending and kept on this device");
  hub.close();
  store.close();
});

test("C12: an oversized batch already persisted holds the later batches of its subdoc", async () => {
  const store = new HostStore({ path: ":memory:" });
  store.createBatch("d1", "content", [], new Uint8Array(500).fill(1));
  store.createBatch("d1", "content", [], new Uint8Array(10).fill(2));
  const queue = queueFor(store, 200);
  const sent: UpdateMessage[] = [];
  await queue.start({ send: (message) => { sent.push(message); return true; } });
  assert.equal(sent.length, 0);
  queue.dispose();
  store.close();
});

test("H11: a delete-only diff is sent, a genuinely empty one is not", async () => {
  const doc = new Y.Doc();
  doc.getText("source").insert(0, "abc");
  const known = Y.encodeStateVector(doc);
  const before = Y.encodeStateAsUpdate(doc);
  doc.getText("source").delete(0, 3);
  const store = new HostStore({ path: ":memory:" });
  const queue = queueFor(store);
  const sent: UpdateMessage[] = [];
  await queue.start(
    { send: (message) => { sent.push(message); return true; } },
    new Map([["content" as const, known]]),
    (_subdoc, stateVector) => Y.encodeStateAsUpdate(doc, stateVector),
  );
  assert.equal(sent.length, 1, "the deletion reaches the server");
  const server = new Y.Doc();
  Y.applyUpdate(server, before);
  Y.applyUpdate(server, sent[0].update);
  assert.equal(server.getText("source").toString(), "");
  queue.dispose();

  const empty = new Y.Doc();
  const idle = queueFor(new HostStore({ path: ":memory:" }));
  const none: UpdateMessage[] = [];
  await idle.start(
    { send: (message) => { none.push(message); return true; } },
    new Map([["content" as const, Y.encodeStateVector(empty)]]),
    (_subdoc, stateVector) => Y.encodeStateAsUpdate(empty, stateVector),
  );
  assert.equal(none.length, 0, "an empty update is skipped");
  idle.dispose();
  store.close();
});

test("H12: batches without local seqs are pending and listed as unacked", () => {
  const store = new HostStore({ path: ":memory:" });
  const doc = new Y.Doc();
  doc.getText("source").insert(0, "abc");
  assert.equal(store.docsWithUnacked().includes("d1"), false);
  const batch = store.createBatch("d1", "content", [], Y.encodeStateAsUpdate(doc));
  const hub = new DocHub({ docId: "d1", store, logger: quietLogger });
  assert.equal(hub.pendingCount, 1, "an encodeMissing batch counts");
  assert.ok(store.docsWithUnacked().includes("d1"), "and keeps the doc listed across a restart");
  assert.equal(hub.getStatus().pending, 1);
  store.ackBatch("d1", batch.clientSeq, 1);
  hub.close();
  store.close();
});

test("M12: the pieces of a split update are stored in one transaction", async () => {
  const store = new HostStore({ path: ":memory:" });
  const source = new Y.Doc();
  let update: Uint8Array = new Uint8Array();
  source.on("update", (value: Uint8Array) => { update = value; });
  const files = source.getMap("files");
  source.transact(() => { for (let index = 0; index < 300; index += 1) files.set(`f${index}`, { path: `dir/with/a/long/name/${index}.md`, n: index }); });
  const localSeq = store.appendLocal("d1", "content", update);
  const real = store.createBatch.bind(store);
  let calls = 0;
  store.createBatch = (...args: Parameters<typeof real>) => {
    calls += 1;
    if (calls === 2) throw new Error("SQLITE_BUSY");
    return real(...args);
  };
  const queue = queueFor(store, 6_000);
  queue.enqueue("content", localSeq, update);
  await queue.start({ send: () => true });
  assert.ok(calls >= 2, "the split reached its second piece");
  assert.equal(store.outboundBatches("d1").length, 0, "no orphaned pieces remain after the failure");
  queue.dispose();
  store.close();
});
