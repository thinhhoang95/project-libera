// Audit 2026-11-19, package P1: findings 7 (a dropped renderer update must not
// be acknowledged) and 43 (reconnect backoff classification and reset).
// Finding 6 is covered on the server in server/test/audit-1119-pipeline.test.ts.

import assert from "node:assert/strict";
import test from "node:test";

import * as Y from "yjs";

import { openReplica } from "../../src/lib/collab/client/replica";
import type { HubToReplica, ReplicaToHub } from "../../src/lib/collab/protocol/local";
import { DocHub } from "../../electron/collab/core/doc-hub";
import { createMemoryPortPair } from "../../electron/collab/core/ports";
import { HostStore } from "../../electron/collab/core/store";
import { STABLE_CONNECTION_MS, SyncClient, type WebSocketLike } from "../../electron/collab/core/sync-client";
import { FakeSyncServer } from "./support/host-fake-server";
import { ManualClock, TestTokens, quietLogger, settle, waitFor } from "./support/host-helpers";
import { browserPort } from "./support/wire-harness";

// ------------------------------------------------------------------ finding 7

function capture(text: string, base?: Y.Doc): { doc: Y.Doc; update: Uint8Array } {
  const doc = base ?? new Y.Doc();
  let update: Uint8Array = new Uint8Array();
  const listener = (bytes: Uint8Array) => {
    update = bytes;
  };
  doc.on("update", listener);
  doc.getText("source").insert(doc.getText("source").length, text);
  doc.off("update", listener);
  return { doc, update };
}

test("finding 7: the hub does not acknowledge an update whose dependencies it dropped, and asks for a resync", async () => {
  const store = new HostStore({ path: ":memory:" });
  const hub = new DocHub({ docId: "d1", store, logger: quietLogger });
  const pair = createMemoryPortPair();
  hub.attachReplica(pair.hub);
  const received: HubToReplica[] = [];
  pair.replica.onMessage((message) => received.push(message));
  pair.replica.postMessage({ t: "attach", docId: "d1", stateVectors: {} });
  await settle();

  const first = capture("one ");
  const second = capture("two", first.doc);
  // The second update alone depends on structs the hub never received.
  pair.replica.postMessage({ t: "update", docId: "d1", subdoc: "content", update: second.update, seq: 1 });
  await settle();
  assert.equal(received.some((message) => message.t === "ack"), false, "a dropped update is not acknowledged");
  assert.ok(received.some((message) => message.t === "resync"), "the replica is told to resync");
  assert.equal(hub.getText(), "", "nothing was integrated");

  // The resync sends everything; a whole update is acknowledged.
  pair.replica.postMessage({ t: "update", docId: "d1", subdoc: "content", update: Y.encodeStateAsUpdate(first.doc), seq: 2 });
  await waitFor(() => received.some((message) => message.t === "ack" && message.seq === 2));
  assert.equal(hub.getText(), "one two");
  hub.close();
  store.close();
});

test("finding 7: a replica keeps its unsaved state on resync and re-sends its state until the hub acknowledges it", async () => {
  const pair = createMemoryPortPair();
  const toHub: ReplicaToHub[] = [];
  const reply = (message: HubToReplica) => pair.hub.postMessage(message);
  const meta = { docId: "d1", projectId: "p1", fileId: "f1", role: "editor", schemaVersion: 1, readOnly: false } as unknown as Extract<HubToReplica, { t: "meta" }>["meta"];
  const status = { connected: true, pending: 0 } as unknown as Extract<HubToReplica, { t: "status" }>["status"];
  const answerAttach = () => {
    for (const subdoc of ["content", "annotations", "meta"] as const) reply({ t: "state", docId: "d1", subdoc, update: Y.encodeStateAsUpdate(new Y.Doc()) });
    reply({ t: "meta", docId: "d1", meta });
    reply({ t: "status", docId: "d1", status });
  };
  pair.hub.onMessage((message) => {
    toHub.push(message);
    if (message.t === "attach") answerAttach();
  });
  const replica = openReplica("d1", browserPort(pair.replica), { schedule: queueMicrotask });
  try {
    await replica.whenAttached();
    replica.ytext.insert(0, "typed");
    await waitFor(() => toHub.some((message) => message.t === "update"));
    const sent = toHub.find((message): message is Extract<ReplicaToHub, { t: "update" }> => message.t === "update");
    assert.equal(sent?.seq, 1);
    const attaches = () => toHub.filter((message) => message.t === "attach").length;
    assert.equal(attaches(), 1);

    // The hub dropped it, and an ack for a later update must not cover it.
    reply({ t: "resync", docId: "d1", subdoc: "content" });
    reply({ t: "ack", docId: "d1", seq: 1 });
    await waitFor(() => attaches() === 2, 2000, "the replica attaches again");
    assert.equal(replica.hasUnconfirmedWork(), true, "unsaved state stays until the hub acknowledges the resent state");
    assert.equal(replica.text(), "typed");

    // The resync re-sends the replica's state with a new sequence number.
    await waitFor(() => toHub.filter((message) => message.t === "update").length >= 2);
    const resent = toHub.filter((message): message is Extract<ReplicaToHub, { t: "update" }> => message.t === "update").at(-1);
    assert.ok((resent?.seq ?? 0) > 1);
    reply({ t: "ack", docId: "d1", seq: resent?.seq ?? 0 });
    await waitFor(() => !replica.hasUnconfirmedWork());
  } finally {
    replica.destroy();
  }
});

// ------------------------------------------------------------------ finding 43

/** A socket that opens but never answers the hello. */
function silentFactory(): { factory: (url: string) => WebSocketLike; opened: () => number } {
  let opened = 0;
  return {
    opened: () => opened,
    factory: () => {
      const socket: WebSocketLike = {
        binaryType: "arraybuffer",
        readyState: 0,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: () => {},
        close: () => {
          socket.readyState = 3;
        },
      } as unknown as WebSocketLike;
      setImmediate(() => {
        socket.readyState = 1;
        opened += 1;
        socket.onopen?.({});
      });
      return socket;
    },
  };
}

test("finding 43: a connection that opens but never completes the handshake is probed like an unreachable server", async () => {
  const clock = new ManualClock();
  const silent = silentFactory();
  let probes = 0;
  const client = new SyncClient({
    url: "ws://fake/sync",
    appVersion: "test",
    clientId: "install:acct",
    tokenProvider: new TestTokens(),
    webSocketFactory: silent.factory,
    logger: quietLogger,
    clock,
    random: () => 0.5,
    probe: async () => {
      probes += 1;
      return false;
    },
  });
  try {
    client.start();
    await waitFor(() => silent.opened() === 1);
    clock.advance(15_000);
    await waitFor(() => client.connectionState === "backoff");
    // The reachability probe (1-2 s) is scheduled next to the backoff timer.
    assert.ok(clock.pending().includes(1500), `a probe is pending (${clock.pending().join(", ")})`);
    assert.equal(probes, 0);
  } finally {
    client.stop();
  }
});

test("finding 43: welcome-and-drop flaps keep growing the backoff; a stable connection resets it", async () => {
  const clock = new ManualClock();
  const server = new FakeSyncServer();
  const client = new SyncClient({
    url: "ws://fake/sync",
    appVersion: "test",
    clientId: "install:acct",
    tokenProvider: new TestTokens(),
    webSocketFactory: server.factory,
    logger: quietLogger,
    clock,
    random: () => 0.5,
    limits: { pingIntervalMs: 10 * 60_000 },
  });
  try {
    client.start();
    const delays: number[] = [];
    for (let flap = 0; flap < 4; flap += 1) {
      await waitFor(() => client.connected, 3000, "connected");
      server.disconnectAll();
      await waitFor(() => client.connectionState === "backoff" && client.lastBackoffMs !== null);
      const delay = client.lastBackoffMs as number;
      delays.push(delay);
      client.lastBackoffMs = null;
      clock.advance(delay);
    }
    assert.deepEqual(delays, [250, 500, 1000, 2000], "a welcome that drops at once does not reset the backoff");

    await waitFor(() => client.connected, 3000, "connected");
    clock.advance(STABLE_CONNECTION_MS + 1);
    server.disconnectAll();
    await waitFor(() => client.connectionState === "backoff" && client.lastBackoffMs !== null);
    assert.equal(client.lastBackoffMs, 250, "a connection that stayed up starts the backoff over");
  } finally {
    client.stop();
  }
});
