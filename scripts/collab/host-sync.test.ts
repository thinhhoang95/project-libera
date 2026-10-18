import assert from "node:assert/strict";
import test from "node:test";

import * as Y from "yjs";

import { MessageType, type UpdateMessage } from "../../src/lib/collab/protocol/messages";
import type { Clock } from "../../electron/collab/core/clock";
import { DocHub } from "../../electron/collab/core/doc-hub";
import { createMemoryPortPair } from "../../electron/collab/core/ports";
import { HostStore } from "../../electron/collab/core/store";
import { SyncClient, type SyncClientEvent, type WebSocketFactory } from "../../electron/collab/core/sync-client";
import { FakeSyncServer } from "./support/host-fake-server";
import { ManualClock, TestReplica, TestTokens, quietLogger, settle, sleep, waitFor } from "./support/host-helpers";

interface Setup {
  server: FakeSyncServer;
  store: HostStore;
  tokens: TestTokens;
  client: SyncClient;
  hub: DocHub;
  events: SyncClientEvent[];
  close: () => void;
}

function setup(
  options: {
    server?: FakeSyncServer;
    store?: HostStore;
    tokens?: TestTokens;
    clock?: Clock;
    random?: () => number;
    factory?: WebSocketFactory;
    batchMaxBytes?: number;
    pingIntervalMs?: number;
    docId?: string;
    start?: boolean;
  } = {},
): Setup {
  const server = options.server ?? new FakeSyncServer();
  const store = options.store ?? new HostStore({ path: ":memory:" });
  const tokens = options.tokens ?? new TestTokens();
  const client = new SyncClient({
    url: "ws://fake/sync",
    appVersion: "test",
    clientId: "install:acct",
    tokenProvider: tokens,
    webSocketFactory: options.factory ?? server.factory,
    logger: quietLogger,
    clock: options.clock,
    random: options.random ?? (() => 0),
    limits: { pingIntervalMs: options.pingIntervalMs ?? 60_000 },
  });
  const hub = new DocHub({
    docId: options.docId ?? "d1",
    store,
    logger: quietLogger,
    clock: options.clock,
    limits: options.batchMaxBytes ? { batchMaxBytes: options.batchMaxBytes } : undefined,
  });
  const events: SyncClientEvent[] = [];
  client.on((event) => events.push(event));
  client.register(hub);
  if (options.start !== false) client.start();
  return {
    server,
    store,
    tokens,
    client,
    hub,
    events,
    close: () => {
      client.stop();
      hub.close();
      store.close();
    },
  };
}

function type(hub: DocHub, text: string, provenance?: Parameters<DocHub["applyLocalChange"]>[2]) {
  hub.applyLocalChange("content", (doc) => doc.getText("source").insert(doc.getText("source").length, text), provenance);
}

async function connected(client: SyncClient, hub: DocHub) {
  await waitFor(() => client.connected && hub.getStatus().state !== "loading" && hub.getStatus().connected, 3000, "connected");
  await settle();
}

test("edits within the batch window become one batch with one clientSeq, acked as a unit", async () => {
  const s = setup();
  try {
    await connected(s.client, s.hub);
    s.server.holdAcks = true;
    for (let index = 0; index < 10; index += 1) type(s.hub, `${index}`, { source: "typing" });
    await waitFor(() => s.server.updates().length === 1);
    await sleep(60);
    const updates = s.server.updates();
    assert.equal(updates.length, 1, "ten edits were merged into one batch");
    assert.equal(updates[0].clientSeq, 1);
    assert.deepEqual(updates[0].provenance, { source: "typing" });
    const [batch] = s.hub.pendingBatches();
    assert.equal(batch.localSeqs.length, 10, "the batch maps to every covered local_seq");
    assert.deepEqual(batch.update, updates[0].update, "the persisted batch bytes are what was sent");
    assert.equal(s.hub.getStatus().state, "syncing");
    assert.equal(s.hub.getStatus().pending, 10);

    s.server.releaseAcks();
    await waitFor(() => s.hub.pendingCount === 0);
    assert.equal(s.hub.getStatus().state, "saved-remote");
    assert.ok(s.hub.getStatus().lastAckAt !== null);
    assert.ok(s.store.allUpdates("d1").every((row) => row.ackedServerSeq === 1));
    assert.equal(s.store.outboundBatches("d1").length, 0);
    assert.equal(s.store.getDocMeta("d1")?.nextClientSeq, 2);
    assert.equal(s.server.text("d1"), "0123456789");
  } finally {
    s.close();
  }
});

test("provenance changes split batches, and an update over the batch limit is sent alone", async () => {
  const s = setup({ batchMaxBytes: 200 });
  try {
    await connected(s.client, s.hub);
    s.server.holdAcks = true;
    type(s.hub, "a", { source: "typing" });
    type(s.hub, "b", { source: "typing" });
    type(s.hub, "x".repeat(400), { source: "typing" });
    type(s.hub, "c", { source: "typing" });
    type(s.hub, "AI", { source: "ai", feature: "rewrite" });
    type(s.hub, "AI", { source: "ai", feature: "rewrite" });
    await waitFor(() => s.server.updates().length >= 4);
    await sleep(60);
    const batches = s.hub.pendingBatches();
    assert.deepEqual(
      batches.map((batch) => batch.localSeqs.length),
      [2, 1, 1, 2],
    );
    assert.ok(batches[1].update.length > 200, "the oversized update went alone");
    assert.deepEqual(batches[3].provenance, { source: "ai", feature: "rewrite" });
    assert.deepEqual(
      s.server.updates().map((message) => message.clientSeq),
      [1, 2, 3, 4],
    );
  } finally {
    s.close();
  }
});

test("a resend after reconnect reuses the same clientSeq and bytes, and the server dedupes it", async () => {
  const s = setup();
  try {
    await connected(s.client, s.hub);
    s.server.holdAcks = true;
    type(s.hub, "hello ");
    await waitFor(() => s.server.updates().length === 1);
    // The server persisted the update but the ack is lost with the socket.
    s.server.disconnectAll();
    await waitFor(() => !s.client.connected || s.server.helloCount > 1);
    type(s.hub, "offline");
    s.server.holdAcks = false;
    await waitFor(() => s.hub.pendingCount === 0, 3000, "everything acked");

    const sent = s.server.updates();
    const first = sent.filter((message) => message.clientSeq === 1);
    assert.equal(first.length, 2, "clientSeq 1 was sent twice");
    assert.deepEqual(first[0].update, first[1].update, "with identical bytes");
    assert.ok(sent.some((message) => message.clientSeq === 2), "the offline edit got the next clientSeq");
    assert.equal(s.server.appliedCount("d1"), 2, "the resend was deduplicated");
    assert.equal(s.server.text("d1"), "hello offline");
  } finally {
    s.close();
  }
});

test("batches survive a host restart and are resent with the same clientSeq", async () => {
  const server = new FakeSyncServer();
  const store = new HostStore({ path: ":memory:" });
  const first = setup({ server, store });
  await connected(first.client, first.hub);
  server.holdAcks = true;
  type(first.hub, "durable");
  await waitFor(() => server.updates().length === 1);
  const sentBefore = server.updates()[0];
  first.client.stop();
  first.hub.close();

  server.holdAcks = false;
  const second = setup({ server, store });
  try {
    await waitFor(() => second.hub.pendingCount === 0, 3000, "acked after restart");
    const resent = server.updates().filter((message) => message.clientSeq === sentBefore.clientSeq);
    assert.equal(resent.length, 2);
    assert.deepEqual(resent[1].update, sentBefore.update);
    assert.equal(server.appliedCount("d1"), 1);
  } finally {
    second.close();
  }
});

test("on open the hub sends what the server lacks beyond its queue", async () => {
  let current = new FakeSyncServer();
  const s = setup({ factory: (url) => current.factory(url) });
  try {
    await connected(s.client, s.hub);
    type(s.hub, "acked text");
    await waitFor(() => s.hub.pendingCount === 0);
    // The server lost the doc (restored from an old backup).
    const fresh = new FakeSyncServer();
    const old = current;
    current = fresh;
    old.disconnectAll();
    await waitFor(() => fresh.updates().length === 1, 3000, "missing state sent");
    const [message] = fresh.updates();
    assert.equal(message.clientSeq, 2, "the recovery batch gets a new clientSeq");
    await waitFor(() => s.hub.pendingBatches().length === 0);
    assert.equal(fresh.text("d1"), "acked text");
  } finally {
    s.close();
  }
});

test("remote updates are persisted as acked, applied and broadcast as remote", async () => {
  const s = setup();
  try {
    const pair = createMemoryPortPair();
    s.hub.attachReplica(pair.hub);
    const replica = new TestReplica(pair.replica, "d1");
    replica.attach();
    await connected(s.client, s.hub);
    const serverSeq = s.server.remoteEdit("d1", "content", (doc) => doc.getText("source").insert(0, "from bob"));
    await waitFor(() => replica.text() === "from bob");
    assert.equal(s.hub.getText(), "from bob");
    const update = replica.of("update").find((message) => message.origin === "remote");
    assert.ok(update, "broadcast with origin remote");
    const row = s.store.allUpdates("d1").find((entry) => entry.origin?.kind === "remote");
    assert.ok(row);
    assert.equal(row.ackedServerSeq, serverSeq);
    assert.deepEqual(row.origin, { kind: "remote", userId: "u2", clientId: "other" });
    assert.equal(s.store.getDocMeta("d1")?.lastSeenServerSeq, serverSeq);
    assert.equal(s.hub.pendingCount, 0);
  } finally {
    s.close();
  }
});

test("state the server has before open arrives as an acked server diff", async () => {
  const server = new FakeSyncServer();
  server.remoteEdit("d1", "content", (doc) => doc.getText("source").insert(0, "existing"));
  const s = setup({ server });
  try {
    const pair = createMemoryPortPair();
    s.hub.attachReplica(pair.hub);
    const replica = new TestReplica(pair.replica, "d1");
    replica.attach();
    await waitFor(() => replica.text() === "existing");
    assert.ok(replica.of("update").some((message) => message.origin === "server"));
    const rows = s.store.allUpdates("d1");
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].origin, { kind: "server" });
    assert.equal(rows[0].ackedServerSeq, 1);
    assert.equal(s.hub.getMeta().projectId, "p1");
    // Reconnecting again does not grow the log with empty diffs.
    server.disconnectAll();
    await waitFor(() => server.helloCount === 2 && s.client.connected);
    await settle();
    assert.equal(s.store.allUpdates("d1").length, 1);
  } finally {
    s.close();
  }
});

test("a reject rolls the sub-document back to the server state and keeps the rejected text", async () => {
  const server = new FakeSyncServer();
  server.remoteEdit("d1", "content", (doc) => doc.getText("source").insert(0, "base "));
  const s = setup({ server });
  try {
    const pair = createMemoryPortPair();
    s.hub.attachReplica(pair.hub);
    const replica = new TestReplica(pair.replica, "d1");
    replica.attach();
    await waitFor(() => replica.text() === "base ");
    await connected(s.client, s.hub);
    const rejected: string[] = [];
    s.hub.onRejected((edit) => rejected.push(edit.rejectedText));
    server.rejectRules.push({ reason: "forbidden" });
    replica.edit((text) => text.insert(text.length, "my unsynced words"));
    await waitFor(() => rejected.length === 1, 3000, "rollback");
    assert.equal(rejected[0], "base my unsynced words");

    await waitFor(() => replica.text() === "base " && s.hub.getText() === "base ", 3000, "rebuilt from the server");
    const kinds = replica.messages.map((message) => message.t);
    const rejectedAt = kinds.indexOf("rejected");
    assert.ok(rejectedAt >= 0);
    assert.equal(kinds[rejectedAt + 1], "state", "rejected is followed by fresh state");
    const notice = replica.of("rejected")[0];
    assert.equal(notice.subdoc, "content");
    assert.equal(notice.reason, "forbidden");
    assert.equal(notice.rejectedText, "base my unsynced words");

    assert.equal(s.hub.pendingCount, 0);
    assert.equal(s.store.unackedUpdates("d1").length, 0, "the rejected updates are gone from the log");
    assert.equal(s.store.outboundBatches("d1").length, 0);
    assert.equal(s.hub.getRejected("content")[0].rejectedText, "base my unsynced words");
    assert.equal(s.store.listRejected("d1").length, 1, "the rejected text survives a restart");
    const opens = server.received.filter((message) => message.type === MessageType.Open);
    assert.ok(opens.length >= 2, "the doc was reopened");
    const reopen = opens[opens.length - 1];
    assert.ok(reopen.type === MessageType.Open);
    const contentVector = reopen.subdocs.find((entry) => entry.subdoc === "content")?.stateVector;
    assert.deepEqual(contentVector, Y.encodeStateVector(new Y.Doc()), "reopened with an empty state vector");

    // Editing continues normally afterwards.
    replica.edit((text) => text.insert(text.length, "ok"));
    await waitFor(() => server.text("d1") === "base ok");
  } finally {
    s.close();
  }
});

test("reconnect uses exponential backoff with full jitter, and nudge reconnects at once", async () => {
  const clock = new ManualClock();
  const server = new FakeSyncServer();
  server.refuseConnections = true;
  const s = setup({ server, clock, random: () => 0.5 });
  try {
    const delays: number[] = [];
    for (let attempt = 0; attempt < 9; attempt += 1) {
      await waitFor(() => s.client.connectionState === "backoff" && s.client.lastBackoffMs !== null);
      delays.push(s.client.lastBackoffMs as number);
      const delay = s.client.lastBackoffMs as number;
      s.client.lastBackoffMs = null;
      clock.advance(delay);
    }
    assert.deepEqual(delays, [250, 500, 1000, 2000, 4000, 8000, 15000, 15000, 15000]);
    await waitFor(() => s.client.connectionState === "backoff" && s.client.lastBackoffMs !== null);
    server.refuseConnections = false;
    s.client.nudge();
    await waitFor(() => s.client.connected, 3000, "connected after nudge");
    assert.equal(s.hub.getStatus().connected, true);
    // A later failure starts again from the base delay.
    server.disconnectAll();
    await waitFor(() => s.client.connectionState === "backoff");
    assert.ok((s.client.lastBackoffMs ?? Infinity) <= 250);
  } finally {
    s.close();
  }
});

test("close 4001 refreshes the token and reconnects", async () => {
  const server = new FakeSyncServer();
  server.validTokens.add("t2");
  const tokens = new TestTokens("t1", "t2");
  const s = setup({ server, tokens });
  try {
    await connected(s.client, s.hub);
    assert.equal(tokens.refreshCalls, 1);
    assert.equal(server.helloCount, 2);
    assert.equal(server.liveSockets[0].token, "t2");
  } finally {
    s.close();
  }
});

test("a failed refresh means needs sign-in while local edits keep working", async () => {
  const server = new FakeSyncServer();
  server.validTokens.add("good");
  const tokens = new TestTokens("expired", null);
  const s = setup({ server, tokens });
  try {
    await waitFor(() => s.client.connectionState === "needs-sign-in");
    assert.ok(s.events.some((event) => event.type === "needs-sign-in"));
    type(s.hub, "still typing");
    const status = s.hub.getStatus();
    assert.equal(status.state, "offline");
    assert.equal(status.pending, 1);
    assert.match(status.detail ?? "", /Sign in/);
    assert.equal(s.store.unackedUpdates("d1").length, 1, "the edit is safe locally");

    tokens.token = "good";
    s.client.nudge();
    await waitFor(() => s.hub.pendingCount === 0, 3000, "synced after sign-in");
    assert.equal(server.text("d1"), "still typing");
  } finally {
    s.close();
  }
});

test("close 4026 means update required and does not reconnect", async () => {
  const server = new FakeSyncServer();
  server.minProtocolVersion = 99;
  const s = setup({ server });
  try {
    await waitFor(() => s.client.connectionState === "update-required");
    assert.ok(s.events.some((event) => event.type === "update-required"));
    s.client.nudge();
    await sleep(30);
    assert.equal(server.helloCount, 1);
    assert.match(s.hub.getStatus().detail ?? "", /Update Libera/);
  } finally {
    s.close();
  }
});

test("close 4002 signs out; 4029 and 4050 back off", async () => {
  const server = new FakeSyncServer();
  const s = setup({ server });
  try {
    await connected(s.client, s.hub);
    server.liveSockets[0].serverClose(4050, "restart");
    await waitFor(() => s.client.connectionState === "backoff" || server.helloCount === 2);
    await waitFor(() => s.client.connected);
    server.liveSockets[0].serverClose(4029, "busy");
    await waitFor(() => server.helloCount === 3 && s.client.connected);
    server.liveSockets[0].serverClose(4002, "signed out everywhere");
    await waitFor(() => s.client.connectionState === "signed-out");
    assert.ok(s.events.some((event) => event.type === "signed-out"));
    await sleep(20);
    assert.equal(server.helloCount, 3);
  } finally {
    s.close();
  }
});

test("access revoked makes the doc read-only, keeps local work and sends nothing more", async () => {
  const s = setup();
  try {
    const pair = createMemoryPortPair();
    s.hub.attachReplica(pair.hub);
    const replica = new TestReplica(pair.replica, "d1");
    replica.attach();
    await connected(s.client, s.hub);
    type(s.hub, "shared ");
    await waitFor(() => s.hub.pendingCount === 0);
    s.server.holdAcks = true;
    type(s.hub, "pending");
    await waitFor(() => s.server.updates().length === 2);
    s.server.revoke("d1");
    await waitFor(() => s.hub.getStatus().state === "access-changed");
    await waitFor(() => replica.of("meta").some((message) => message.meta.readOnly && message.meta.readOnlyReason === "access-revoked"));
    assert.equal(s.store.getDocMeta("d1")?.readOnlyReason, "access-revoked");
    const before = s.server.received.length;
    type(s.hub, " more");
    await sleep(60);
    assert.equal(s.store.unackedUpdates("d1").length, 2, "local work is kept");
    assert.equal(s.hub.getText(), "shared pending more");
    assert.equal(s.server.received.length, before, "nothing more is sent for the doc");
    // A reconnect does not reopen it.
    s.server.disconnectAll();
    await waitFor(() => s.server.helloCount === 2 && s.client.connected);
    await settle();
    const opens = s.server.received.slice(before).filter((message) => message.type === MessageType.Open);
    assert.equal(opens.length, 0);
  } finally {
    s.close();
  }
});

test("a newer document schema opens read-only and pauses sending", async () => {
  const server = new FakeSyncServer();
  server.schemaVersion = 99;
  const s = setup({ server });
  try {
    await waitFor(() => s.hub.getStatus().state === "read-only");
    assert.equal(s.hub.getMeta().readOnlyReason, "schema-newer");
    type(s.hub, "local only");
    await sleep(60);
    assert.equal(server.updates().length, 0);
    server.schemaVersion = 1;
    server.disconnectAll();
    await waitFor(() => s.hub.pendingCount === 0, 3000, "sent after the schema is supported");
  } finally {
    s.close();
  }
});

test("a missing pong drops the socket and reconnects", async () => {
  const server = new FakeSyncServer();
  const s = setup({ server, pingIntervalMs: 25 });
  try {
    await connected(s.client, s.hub);
    server.respondToPing = false;
    await waitFor(() => server.helloCount >= 2, 3000, "reconnect after missing pong");
    server.respondToPing = true;
    await waitFor(() => s.client.connected);
  } finally {
    s.close();
  }
});

test("a token close to expiry is refreshed and sent as refresh-token", async () => {
  const clock = new ManualClock();
  const tokens = new TestTokens("t1", "t2");
  tokens.expiresAt = clock.now() + 61_000;
  const s = setup({ clock, tokens });
  try {
    await waitFor(() => s.client.connected);
    clock.advance(1_000);
    await waitFor(() => s.server.received.some((message) => message.type === MessageType.RefreshToken));
    const message = s.server.received.find((entry) => entry.type === MessageType.RefreshToken);
    assert.ok(message && message.type === MessageType.RefreshToken && message.token === "t2");
  } finally {
    s.close();
  }
});

test("server events are re-emitted and nudge pings a live socket", async () => {
  const s = setup();
  try {
    await connected(s.client, s.hub);
    s.server.sendEvent("notification.created", { id: "n1" });
    await waitFor(() => s.events.some((event) => event.type === "server-event"));
    const event = s.events.find((entry) => entry.type === "server-event");
    assert.ok(event && event.type === "server-event" && event.event.kind === "notification.created");
    const pings = () => s.server.received.filter((message) => message.type === MessageType.Ping).length;
    s.client.nudge();
    await waitFor(() => pings() === 1);
    assert.equal(s.client.connected, true);
  } finally {
    s.close();
  }
});

test("awareness from replicas goes to the server and remote awareness to replicas", async () => {
  const s = setup();
  try {
    const pair = createMemoryPortPair();
    s.hub.attachReplica(pair.hub);
    const replica = new TestReplica(pair.replica, "d1");
    replica.attach();
    await connected(s.client, s.hub);
    const { Awareness, encodeAwarenessUpdate } = await import("y-protocols/awareness");
    const local = new Awareness(new Y.Doc());
    local.setLocalState({ name: "me" });
    pair.replica.postMessage({ t: "awareness", docId: "d1", update: encodeAwarenessUpdate(local, [local.clientID]) });
    await waitFor(() => s.server.received.some((message) => message.type === MessageType.Awareness));
    const remote = new Awareness(new Y.Doc());
    remote.setLocalState({ name: "bob" });
    for (const socket of s.server.liveSockets) {
      socket.push({ type: MessageType.Awareness, docId: "d1", update: encodeAwarenessUpdate(remote, [remote.clientID]) });
    }
    await waitFor(() => s.hub.awareness.getStates().has(remote.clientID));
    await waitFor(() => replica.of("awareness").length >= 1);
    // A disconnect clears remote presence for the replicas.
    s.server.disconnectAll();
    await waitFor(() => !s.hub.awareness.getStates().has(remote.clientID));
    local.destroy();
    remote.destroy();
  } finally {
    s.close();
  }
});

test("updates are only sent once per connection even when reopened", async () => {
  const s = setup();
  try {
    await connected(s.client, s.hub);
    s.server.holdAcks = true;
    type(s.hub, "x");
    await waitFor(() => s.server.updates().length === 1);
    s.hub.clearReadOnly();
    // Force a reopen on the same connection (as after a rollback of another sub-document).
    (s.hub as unknown as { link: { reopen(): void } }).link.reopen();
    await sleep(60);
    const sent: UpdateMessage[] = s.server.updates();
    assert.equal(sent.length, 1);
  } finally {
    s.close();
  }
});
