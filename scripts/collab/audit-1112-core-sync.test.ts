import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";

import * as Y from "yjs";

import { MessageType, type AckMessage, type OpenedMessage, type RemoteMessage, type UpdateMessage } from "../../src/lib/collab/protocol/messages";
import { ApiClient } from "../../electron/collab/core/api-client";
import { CollabHost } from "../../electron/collab/core/host";
import { DocHub, type HubTransport } from "../../electron/collab/core/doc-hub";
import { replayRecoveryFiles } from "../../electron/collab/core/recovery";
import { HostStore } from "../../electron/collab/core/store";
import { chunkTextEdits } from "../../electron/collab/notebooks/text-edit-chunks";
import { ManualClock, TestTokens, quietLogger, settle, tempDir, waitFor } from "./support/host-helpers";

const EMPTY = Y.encodeStateVector(new Y.Doc());

function fakeTransport() {
  const sent: UpdateMessage[] = [];
  let reopens = 0;
  const transport: HubTransport = {
    send: (message) => {
      sent.push(message);
      return true;
    },
    sendAwareness: () => {},
    reopen: () => {
      reopens += 1;
    },
  };
  return { transport, sent, reopens: () => reopens };
}

function opened(diff: Uint8Array, serverSeq = 1): OpenedMessage {
  return {
    type: MessageType.Opened,
    docId: "d1",
    projectId: "p1",
    role: "editor",
    schemaVersion: 1,
    serverSeq,
    subdocs: [{ subdoc: "content", diff, stateVector: EMPTY }],
  };
}

function remoteUpdate(text: string): Uint8Array {
  const doc = new Y.Doc();
  let captured: Uint8Array = new Uint8Array();
  doc.on("update", (update: Uint8Array) => {
    captured = update;
  });
  doc.getText("source").insert(0, text);
  return captured;
}

function remoteMessage(update: Uint8Array, serverSeq: number): RemoteMessage {
  return { type: MessageType.Remote, docId: "d1", subdoc: "content", serverSeq, update, userId: "u2", clientId: "c2" };
}

function failOnce(store: HostStore, method: "appendAcked" | "appendLocal", times = 1): { restore: () => void } {
  const original = store[method].bind(store) as (...args: unknown[]) => number;
  let remaining = times;
  (store as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
    if (remaining > 0) {
      remaining -= 1;
      throw new Error("database or disk is full");
    }
    return original(...args);
  };
  return { restore: () => ((store as unknown as Record<string, unknown>)[method] = original) };
}

test("DATA-2: a failed remote append makes the hub re-open from its durable state instead of dropping the update", () => {
  const clock = new ManualClock();
  const store = new HostStore({ path: ":memory:" });
  const hub = new DocHub({ docId: "d1", store, logger: quietLogger, clock });
  const link = fakeTransport();
  hub.connectionChanged(link.transport);
  hub.handleOpened(opened(new Uint8Array()));
  failOnce(store, "appendAcked");
  const first = remoteUpdate("one");
  hub.handleRemote(remoteMessage(first, 2)); // fails to persist: must not throw nor apply
  assert.equal(hub.getText("content"), "");
  // A later broadcast could depend on the lost one: it is ignored until the resync.
  hub.handleRemote(remoteMessage(remoteUpdate("two"), 3));
  assert.equal(hub.getText("content"), "");
  assert.equal(link.reopens(), 0);
  clock.advance(1000);
  assert.equal(link.reopens(), 1, "the document re-opens once storage may have recovered");
  hub.handleOpened(opened(first, 3));
  assert.equal(hub.getText("content"), "one");
  assert.equal(store.allUpdates("d1").length, 1);
  hub.close();
  store.close();
});

test("DATA-2: an initial diff that cannot be stored does not mark the document opened", () => {
  const clock = new ManualClock();
  const store = new HostStore({ path: ":memory:" });
  const hub = new DocHub({ docId: "d1", store, logger: quietLogger, clock });
  const link = fakeTransport();
  hub.connectionChanged(link.transport);
  failOnce(store, "appendAcked");
  const diff = remoteUpdate("state");
  hub.handleOpened(opened(diff, 5));
  assert.equal(hub.hasOpened, false);
  assert.equal(store.getDocMeta("d1")?.lastSeenServerSeq ?? 0, 0);
  clock.advance(1000);
  assert.equal(link.reopens(), 1);
  hub.handleOpened(opened(diff, 5));
  assert.equal(hub.hasOpened, true);
  assert.equal(hub.getText("content"), "state");
  hub.close();
  store.close();
});

test("DATA-3: updates that could not be saved when the hub closes are written to recovery and replayed on the next start", () => {
  const dir = tempDir();
  try {
    const store = new HostStore({ path: ":memory:" });
    const hub = new DocHub({ docId: "d1", store, logger: quietLogger, recoveryDir: dir.file("recovery") });
    failOnce(store, "appendLocal", 100);
    hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, "precious"));
    assert.equal(hub.unpersistedCount, 1, "applied in memory only");
    hub.close();
    assert.equal(store.allUpdates("d1").length, 0);
    assert.equal(readdirSync(dir.file("recovery")).filter((name) => name.endsWith(".recovery.json")).length, 1);

    const next = new HostStore({ path: ":memory:" });
    assert.equal(replayRecoveryFiles(dir.file("recovery"), next, quietLogger), 1);
    assert.equal(readdirSync(dir.file("recovery")).length, 0, "replayed files are removed");
    const reopened = new DocHub({ docId: "d1", store: next, logger: quietLogger });
    assert.equal(reopened.getText("content"), "precious");
    assert.equal(reopened.pendingCount, 1, "and it is queued for the server");
    reopened.close();
    next.close();
    store.close();
  } finally {
    dir.cleanup();
  }
});

test("DL-7: an update over the size limit is reported, never sent, and does not block the queue behind it", async () => {
  const store = new HostStore({ path: ":memory:" });
  const hub = new DocHub({ docId: "d1", store, logger: quietLogger, limits: { maxUpdateBytes: 200, batchMaxBytes: 1 } });
  const errors: string[] = [];
  const link = fakeTransport();
  hub.connectionChanged(link.transport);
  hub.handleOpened(opened(new Uint8Array(), 0));
  hub.onStatus(() => {});
  hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, "x".repeat(1000)));
  hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, "small"));
  await hub.flushOutbound();
  await settle();
  assert.ok(link.sent.length >= 1);
  assert.ok(link.sent.every((message) => message.update.length <= 200), "nothing over the limit is written to the socket");
  assert.ok(hub.getStatus().detail?.includes("cannot be synced"), `status explains it: ${hub.getStatus().detail}`);
  void errors;
  hub.close();
  store.close();
});

test("DL-7: chunkTextEdits splits a large edit into bounded pieces that rebuild the same text", () => {
  const original = "head " + "tail";
  const insert = "ab".repeat(30) + "\u{1F600}".repeat(10) + "end";
  const edits = [{ start: 5, end: 5, text: insert }, { start: 0, end: 1, text: "H" }];
  // Edits are ascending in real use; order them that way.
  const ordered = [edits[1], edits[0]];
  const chunks = chunkTextEdits(ordered, 16);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.reduce((total, op) => total + op.text.length, 0) <= 16 + 1);
  const doc = new Y.Doc();
  const text = doc.getText("t");
  text.insert(0, original);
  for (const chunk of chunks) {
    for (const op of chunk) {
      if (op.del > 0) text.delete(op.pos, op.del);
      if (op.text) text.insert(op.pos, op.text);
    }
  }
  assert.equal(text.toString(), "Head " + insert + "tail");
  // No lone surrogate halves were ever inserted on their own.
  for (const chunk of chunks) for (const op of chunk) assert.equal(op.text, op.text.toWellFormed());
});

test("SYNC-6: only a bounded window is in flight; acks release more and a timeout resends only the oldest", async () => {
  const clock = new ManualClock();
  const store = new HostStore({ path: ":memory:" });
  const hub = new DocHub({ docId: "d1", store, logger: quietLogger, clock, limits: { batchMaxBytes: 1, maxOutstandingBatches: 2 } });
  for (let index = 0; index < 5; index += 1) hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, `e${index}`));
  const link = fakeTransport();
  hub.connectionChanged(link.transport);
  hub.handleOpened(opened(new Uint8Array(), 0));
  await settle();
  const seqs = () => link.sent.map((message) => message.clientSeq);
  assert.deepEqual(seqs(), [1, 2], "the backlog is not written all at once");
  hub.handleAck({ type: MessageType.Ack, docId: "d1", clientSeq: 1, serverSeq: 1 } as AckMessage);
  assert.deepEqual(seqs(), [1, 2, 3], "an acknowledgement releases the next batch in order");
  clock.advance(15_000);
  assert.deepEqual(seqs(), [1, 2, 3, 2], "a timeout resends only the oldest outstanding batch");
  hub.close();
  store.close();
});

test("DATA-18: a queued decision or revision waits until the document's earlier edits are acknowledged", async () => {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ id: "cmd1", status: 200, body: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const host = new CollabHost({
    dbPath: ":memory:",
    appVersion: "test",
    installationId: "inst",
    logger: quietLogger,
    compaction: false,
    telemetry: false,
    divergence: false,
    limits: { backoffBaseMs: 5, backoffMaxMs: 20 },
  });
  host.start();
  try {
    const hub = host.acquire("d1");
    hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, "offline edit"));
    const link = fakeTransport();
    host.commands.setApi(new ApiClient({ baseUrl: "https://collab.test", tokenProvider: new TestTokens(), fetch }));
    host.commands.setOnline(true);
    host.commands.enqueue({ id: "cmd1", kind: "revision.create", docId: "d1", body: { kind: "named", title: "v1" } as never });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(calls.filter((url) => url.endsWith("/v1/commands")).length, 0, "the command was held back");
    assert.equal(host.commands.list().length, 1);

    hub.connectionChanged(link.transport);
    hub.handleOpened(opened(new Uint8Array(), 0));
    await settle();
    assert.equal(link.sent.length, 1);
    hub.handleAck({ type: MessageType.Ack, docId: "d1", clientSeq: link.sent[0].clientSeq, serverSeq: 1 } as AckMessage);
    await waitFor(() => calls.some((url) => url.endsWith("/v1/commands")), 3000, "the command to be sent");
    await waitFor(() => host.commands.list().length === 0, 3000, "the command to settle");
  } finally {
    await host.stop();
  }
});
