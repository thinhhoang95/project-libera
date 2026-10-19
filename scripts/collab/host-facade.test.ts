import assert from "node:assert/strict";
import test from "node:test";

import type { Command } from "../../src/lib/collab/protocol/api";
import { CollabHost, syncClientId, type CollabHostEvent } from "../../electron/collab/core/host";
import { createMemoryPortPair } from "../../electron/collab/core/ports";
import { HostStore, HostStoreLockedError } from "../../electron/collab/core/store";
import { FakeSyncServer } from "./support/host-fake-server";
import { TestReplica, TestTokens, quietLogger, sleep, tempDir, waitFor } from "./support/host-helpers";

function commandsFetch(applied: string[]) {
  return async (_url: string, init: RequestInit) => {
    const command = JSON.parse(String(init.body)) as Command;
    applied.push(command.id);
    return new Response(JSON.stringify({ id: command.id, status: 201, body: {} }), { status: 200 });
  };
}

function newHost(dbPath: string, server: FakeSyncServer, applied: string[] = []) {
  return new CollabHost({
    dbPath,
    appVersion: "test",
    installationId: "install-1",
    logger: quietLogger,
    webSocketFactory: server.factory,
    fetch: commandsFetch(applied),
    random: () => 0,
    hubIdleMs: 20,
  });
}

test("CollabHost wires replicas, sync, commands and shutdown", async () => {
  const temp = tempDir();
  const server = new FakeSyncServer();
  const applied: string[] = [];
  const host = newHost(temp.file("acct.sqlite"), server, applied);
  try {
    host.start();
    assert.throws(() => new HostStore({ path: temp.file("acct.sqlite") }), HostStoreLockedError);
    const events: CollabHostEvent[] = [];
    host.on((event) => events.push(event));
    host.commands.enqueue({ id: "cmd-1", kind: "thread.delete", threadId: "t1" });
    host.setAccount({ accountId: "acct", serverUrl: "https://collab.test", tokenProvider: new TestTokens() });
    assert.ok(host.api, "an API client exists once signed in");

    const pair = createMemoryPortPair();
    const { hub } = host.attachReplica("d1", pair.hub, { projectId: "p1" });
    const replica = new TestReplica(pair.replica, "d1");
    replica.attach();
    await waitFor(() => host.connectionState === "connected");
    replica.edit((text) => text.insert(0, "from the window"));
    await waitFor(() => server.text("d1") === "from the window", 3000, "synced");
    await waitFor(() => hub.pendingCount === 0);
    await waitFor(() => applied.includes("cmd-1"), 3000, "command replayed once online");
    assert.ok(server.sockets[0].url.startsWith("wss://collab.test/sync"));
    assert.equal(server.liveSockets[0].clientId, syncClientId("install-1", "acct"));
    // Same rule as the server's isClientId (server/src/ids.ts).
    assert.match(server.liveSockets[0].clientId, /^[A-Za-z0-9_-]{8,80}$/);
    assert.ok(events.some((event) => event.source === "sync" && event.event.type === "welcome"));
    assert.ok(events.some((event) => event.source === "commands" && event.event.type === "settled"));

    // The hub closes once the replica detaches and the idle delay passes.
    pair.replica.postMessage({ t: "detach", docId: "d1" });
    await waitFor(() => hub.isClosed, 2000, "idle close");
    // nudge on a live connection checks it with a ping.
    host.nudge();
    await sleep(10);
  } finally {
    await host.stop();
    temp.cleanup();
  }
  // stop() released the database.
  assert.equal(host.connectionState, "idle");
});

test("edits made offline are pushed after a restart even when no window opens the doc", async () => {
  const temp = tempDir();
  const server = new FakeSyncServer();
  const dbPath = temp.file("acct.sqlite");
  let host = newHost(dbPath, server);
  host.start();
  const hub = host.acquire("d1");
  hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, "written offline"));
  host.release("d1");
  await waitFor(() => hub.isClosed);
  await host.stop();

  host = newHost(dbPath, server);
  try {
    host.start();
    host.setAccount({ accountId: "acct", serverUrl: "https://collab.test", tokenProvider: new TestTokens() });
    await waitFor(() => server.text("d1") === "written offline", 3000, "pushed in the background");
    // Once acked, the background reference is released and the hub closes.
    await waitFor(() => host.registry.get("d1") === null, 3000, "background hub released");
    assert.equal(host.store.docsWithUnacked().length, 0);
  } finally {
    await host.stop();
    temp.cleanup();
  }
});

test("a reject surfaces as a host event with the rejected text", async () => {
  const temp = tempDir();
  const server = new FakeSyncServer();
  const host = newHost(temp.file("acct.sqlite"), server);
  try {
    host.start();
    host.setAccount({ accountId: "acct", serverUrl: "http://localhost:1234", tokenProvider: new TestTokens() });
    const events: CollabHostEvent[] = [];
    host.on((event) => events.push(event));
    const hub = host.acquire("d1");
    await waitFor(() => host.connectionState === "connected" && hub.getStatus().state === "saved-remote");
    server.rejectRules.push({ reason: "forbidden" });
    hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, "not allowed"));
    await waitFor(() => events.some((event) => event.source === "doc"));
    const event = events.find((entry) => entry.source === "doc");
    assert.ok(event && event.source === "doc" && event.edit.rejectedText === "not allowed");
    assert.ok(server.sockets[0].url.startsWith("ws://localhost:1234/sync"));
    host.release("d1");
  } finally {
    await host.stop();
    temp.cleanup();
  }
});
