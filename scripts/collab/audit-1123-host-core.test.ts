// K3 of the three-way sync review (2026-11-23): host, registry, divergence, locks.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import test from "node:test";

import * as Y from "yjs";

import type { Command, DocumentDigest } from "../../src/lib/collab/protocol/api";
import type { ApiClient } from "../../electron/collab/core/api-client";
import { DivergenceChecker, digestOf, type DivergenceHost } from "../../electron/collab/core/divergence";
import type { DocHub } from "../../electron/collab/core/doc-hub";
import { CollabHost } from "../../electron/collab/core/host";
import { PendingCommands } from "../../electron/collab/core/pending-commands";
import { HostStore } from "../../electron/collab/core/store";
import { SyncClient } from "../../electron/collab/core/sync-client";
import { FakeSyncServer } from "./support/host-fake-server";
import { ManualClock, TestTokens, quietLogger, settle, sleep, tempDir, waitFor } from "./support/host-helpers";

// ---------------------------------------------------------------- H10

function newHost(dbPath: string, server: FakeSyncServer) {
  return new CollabHost({
    dbPath,
    appVersion: "test",
    installationId: "install-1",
    logger: quietLogger,
    webSocketFactory: server.factory,
    fetch: async () => new Response("{}", { status: 200 }),
    random: () => 0,
    hubIdleMs: 20,
  });
}

async function offlineHost(temp: ReturnType<typeof tempDir>, server: FakeSyncServer) {
  const host = newHost(temp.file("acct.sqlite"), server);
  host.start();
  host.setAccount({ accountId: "acct", serverUrl: "https://collab.test", tokenProvider: new TestTokens() });
  await waitFor(() => host.connectionState === "connected");
  server.refuseConnections = true;
  server.disconnectAll();
  await waitFor(() => host.connectionState !== "connected");
  return host;
}

test("H10: an idle hub with unacknowledged edits stays open, and its edits sync on reconnect", async () => {
  const temp = tempDir();
  const server = new FakeSyncServer();
  const host = await offlineHost(temp, server);
  try {
    const hub = host.acquire("d1");
    hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, "typed offline"));
    host.release("d1");
    await sleep(120);
    assert.equal(hub.isClosed, false, "kept open while the server lacks its edits");
    server.refuseConnections = false;
    host.nudge();
    await waitFor(() => server.text("d1") === "typed offline", 3000, "pushed after reconnect");
    await waitFor(() => host.registry.get("d1") === null, 3000, "closed once acknowledged");
  } finally {
    await host.stop();
    temp.cleanup();
  }
});

test("H10: every reconnect syncs documents whose hub is gone", async () => {
  const temp = tempDir();
  const server = new FakeSyncServer();
  const host = await offlineHost(temp, server);
  try {
    const hub = host.acquire("d1");
    hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, "left behind"));
    host.release("d1");
    hub.close();
    assert.equal(host.registry.get("d1"), null);
    server.refuseConnections = false;
    host.nudge();
    await waitFor(() => server.text("d1") === "left behind", 3000, "pushed by the reconnect sweep");
  } finally {
    await host.stop();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------- H14, M17

type Listener = (status: unknown) => void;

class FakeHub {
  isClosed = false;
  hasOpened = false;
  readOnlyReason = null;
  kind = "doc";
  pending = 0;
  connected = true;
  readonly doc = new Y.Doc();
  private readonly listeners = new Set<Listener>();
  getStatus() {
    return { state: this.hasOpened ? "saved-remote" : "saved-local", pending: this.pending, connected: this.connected };
  }
  onStatus(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit() {
    for (const listener of [...this.listeners]) listener(this.getStatus());
  }
  getDoc() {
    return this.doc;
  }
}

function digestFor(server: Y.Doc, serverSeq: number): DocumentDigest {
  return {
    docId: "d1",
    kind: "markdown" as DocumentDigest["kind"],
    serverSeq,
    contentSha256: digestOf("content", server),
    stateVectors: { content: Buffer.from(Y.encodeStateVector(server)).toString("base64") },
  };
}

/** A local replica and a server doc with the same inserts, where only the local one lacks a deletion... or the reverse. */
function pair(): { hub: FakeHub; server: Y.Doc } {
  const hub = new FakeHub();
  hub.doc.getText("source").insert(0, "abc");
  const server = new Y.Doc();
  Y.applyUpdate(server, Y.encodeStateAsUpdate(hub.doc));
  return { hub, server };
}

function checker(hub: FakeHub, options: { digest: () => DocumentDigest; lastSeen: number; onRequest?: () => void }) {
  const log = { acquired: 0, released: 0, reopened: 0, openedAtReopen: [] as boolean[] };
  const host: DivergenceHost = {
    api: () => ({
      request: async () => {
        options.onRequest?.();
        return options.digest();
      },
    }) as unknown as ApiClient,
    store: () => ({ getDocMeta: () => ({ lastSeenServerSeq: options.lastSeen }) }) as unknown as HostStore,
    openHub: () => hub as unknown as DocHub,
    openDocIds: () => ["d1"],
    acquire: () => {
      log.acquired += 1;
      return hub as unknown as DocHub;
    },
    release: () => {
      log.released += 1;
    },
    reopenFull: async () => {
      log.reopened += 1;
      log.openedAtReopen.push(hub.hasOpened);
      return true;
    },
  };
  return { log, divergence: new DivergenceChecker({ host, logger: quietLogger, recoveryTimeoutMs: 400, retryMs: 10_000_000 }) };
}

test("H14: recovery holds a reference and waits for the hub to have opened before the full re-open", async () => {
  const { hub, server } = pair();
  // The server never deleted "b" while the local replica did: equal vectors, different text.
  hub.doc.getText("source").delete(1, 1);
  const { log, divergence } = checker(hub, { digest: () => digestFor(server, 5), lastSeen: 5 });
  setTimeout(() => {
    hub.hasOpened = true;
    hub.emit();
  }, 40);
  const record = await divergence.checkDoc("d1");
  assert.equal(record.outcome, "mismatch");
  assert.equal(log.acquired, 1, "an already-open idle hub is referenced too");
  assert.equal(log.released, 1);
  assert.deepEqual(log.openedAtReopen, [true], "the re-open is sent only after the first open was answered");
  divergence.stop();
});

test("M17: a local change during the digest round trip skips the check", async () => {
  const { hub, server } = pair();
  let first = true;
  const { log, divergence } = checker(hub, {
    digest: () => digestFor(server, 5),
    lastSeen: 5,
    onRequest: () => {
      if (!first) return;
      first = false;
      hub.doc.getText("source").delete(1, 1); // a remote deletion lands: same state vector, new text
    },
  });
  hub.hasOpened = true;
  const record = await divergence.checkDoc("d1");
  assert.equal(record.outcome, "skipped");
  assert.equal(record.detail, "changed-during-check");
  assert.equal(log.reopened, 0);
  divergence.stop();
});

test("M17: a digest older than what the host has seen is not conclusive", async () => {
  const { hub, server } = pair();
  hub.doc.getText("source").delete(1, 1);
  hub.hasOpened = true;
  const { log, divergence } = checker(hub, { digest: () => digestFor(server, 3), lastSeen: 5 });
  const record = await divergence.checkDoc("d1");
  assert.equal(record.outcome, "inconclusive");
  assert.equal(log.reopened, 0);
  divergence.stop();
});

test("M17: a host behind the digest that never catches up has missed an update: mismatch and recovery", async () => {
  const { hub, server } = pair();
  hub.doc.getText("source").delete(1, 1);
  hub.hasOpened = true;
  const { log, divergence } = checker(hub, { digest: () => digestFor(server, 7), lastSeen: 5 });
  const keepAlive = setTimeout(() => {}, 5000); // the checker's own timers are unref'd
  const record = await divergence.checkDoc("d1");
  clearTimeout(keepAlive);
  assert.equal(record.outcome, "mismatch");
  assert.equal(log.reopened, 1);
  divergence.stop();
});

test("M17: a host behind the digest that catches up compares again", async () => {
  const { hub, server } = pair();
  hub.hasOpened = true;
  server.getText("source").delete(1, 1); // the server deleted "b"; the host has not received that yet
  let seen = 5;
  const log = { reopened: 0 };
  const dh: DivergenceHost = {
    api: () => ({ request: async () => digestFor(server, 7) }) as unknown as ApiClient,
    store: () => ({ getDocMeta: () => ({ lastSeenServerSeq: seen }) }) as unknown as HostStore,
    openHub: () => hub as unknown as DocHub,
    openDocIds: () => ["d1"],
    acquire: () => hub as unknown as DocHub,
    release: () => {},
    reopenFull: async () => {
      log.reopened += 1;
      return true;
    },
  };
  const divergence = new DivergenceChecker({ host: dh, logger: quietLogger, recoveryTimeoutMs: 2000, retryMs: 10_000_000 });
  setTimeout(() => {
    hub.doc.getText("source").delete(1, 1); // the update arrives and the host is level with the digest
    seen = 7;
    hub.emit();
  }, 30);
  const record = await divergence.checkDoc("d1");
  assert.equal(record.outcome, "match");
  assert.equal(log.reopened, 0);
  divergence.stop();
});

// ---------------------------------------------------------------- H15

test("H15: judging a stale lock against a different token leaves a live lock untouched", () => {
  const temp = tempDir();
  const path = temp.file("db.sqlite");
  const store = new HostStore({ path, lockHeartbeatMs: 600_000, lockStaleMs: 600_000 });
  try {
    const lock = (store as unknown as { lock: { removeStale(token: string | null): void } }).lock;
    const before = { text: readFileSync(`${path}.lock`, "utf8"), ctime: statSync(`${path}.lock`).ctimeMs };
    lock.removeStale("some-other-token");
    assert.equal(readFileSync(`${path}.lock`, "utf8"), before.text);
    assert.equal(statSync(`${path}.lock`).ctimeMs, before.ctime, "the live lock was never renamed away");
    assert.equal(store.ownsDatabase(), true);
  } finally {
    store.close();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------- M5, L4

test("M5: retirePath writes the path and its hashes in one commit", () => {
  const store = new HostStore({ path: ":memory:" });
  try {
    function* failing(): Generator<string> {
      yield "h1";
      throw new Error("crash between the inserts");
    }
    assert.throws(() => store.retirePath("p1", "a.md", failing()));
    assert.equal(store.retiredPaths("p1").size, 0, "no retired path without its history");
    store.retirePath("p1", "a.md", ["h1", "h2"]);
    assert.deepEqual([...(store.retiredPaths("p1").get("a.md") ?? [])].sort(), ["h1", "h2"]);
  } finally {
    store.close();
  }
});

test("L4: a constructor that fails after opening the database closes the handle", () => {
  const temp = tempDir();
  const path = temp.file("garbage.sqlite");
  writeFileSync(path, Buffer.from("this is not a sqlite database, only text that is long enough to look like a header"));
  try {
    assert.throws(() => new HostStore({ path }));
    let listing: string;
    try {
      listing = execFileSync("lsof", ["-p", String(process.pid), "-Fn"], { encoding: "utf8" });
    } catch {
      return; // no lsof here: nothing to observe
    }
    assert.equal(listing.split("\n").some((line) => line.endsWith("garbage.sqlite")), false, "the database file is not left open");
  } finally {
    temp.cleanup();
  }
});

// ---------------------------------------------------------------- M14

test("M14: a new command for an unrelated key is sent while another key is backing off", async () => {
  const store = new HostStore({ path: ":memory:" });
  const clock = new ManualClock();
  const posted: string[] = [];
  const failing = new Set(["c1"]);
  const api = {
    postCommand: async (command: Command) => {
      posted.push(command.id);
      return failing.has(command.id) ? { id: command.id, status: 503, body: null } : { id: command.id, status: 200, body: {} };
    },
  } as unknown as ApiClient;
  const queue = new PendingCommands({ store, clock, random: () => 1, logger: quietLogger, backoffBaseMs: 1000 });
  try {
    queue.setApi(api);
    queue.setOnline(true);
    await queue.idle();
    queue.enqueue({ id: "c1", kind: "thread.delete", threadId: "t1" });
    await waitFor(() => clock.pending().length > 0, 3000, "backoff armed");
    await queue.idle();
    queue.enqueue({ id: "c2", kind: "thread.delete", threadId: "t2" });
    await waitFor(() => posted.includes("c2"), 1000, "unrelated command sent during backoff");
    await queue.idle();
    assert.deepEqual(posted, ["c1", "c2"], "c1 keeps its backoff");
    assert.deepEqual(queue.list().map((row) => row.id), ["c1"]);
    // A command for the failing key still waits.
    queue.enqueue({ id: "c3", kind: "thread.delete", threadId: "t1" });
    await queue.idle();
    assert.equal(posted.includes("c3"), false);
    failing.clear();
    clock.advance(1000);
    await waitFor(() => queue.list().length === 0, 3000, "everything sent after the backoff");
  } finally {
    queue.stop();
    store.close();
  }
});

// ---------------------------------------------------------------- L5

test("L5: a nudge ping does not leave the regular ping timer to fire during its round trip", async () => {
  const server = new FakeSyncServer();
  const store = new HostStore({ path: ":memory:" });
  const clock = new ManualClock();
  const client = new SyncClient({
    url: "ws://fake/sync",
    appVersion: "test",
    clientId: "install:acct",
    tokenProvider: new TestTokens(),
    webSocketFactory: server.factory,
    logger: quietLogger,
    clock,
    random: () => 0,
    limits: { pingIntervalMs: 1000 },
  });
  try {
    client.start();
    await waitFor(() => client.connected, 3000, "connected");
    await settle();
    clock.advance(900);
    client.nudge();
    clock.advance(150); // the regular timer's due time passes before the pong can arrive
    await settle();
    await sleep(30);
    assert.equal(server.sockets.length, 1, "a healthy socket is not dropped for a missing pong");
    assert.equal(client.connected, true);
  } finally {
    client.stop();
    store.close();
  }
});
