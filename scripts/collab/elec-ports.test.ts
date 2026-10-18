// The host's Electron adapters under plain Node: the MessagePort adapter with
// node:worker_threads ports standing in for MessagePortMain, and the
// utilityProcess side of the parent-port protocol (start/ready, attach with
// a transferred port, safeStorage requests to main, shutdown).

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MessageChannel, type MessagePort } from "node:worker_threads";

import * as Y from "yjs";

import { adaptMessagePort, parseReplicaMessage, type MessagePortLike } from "../../electron/collab/adapters/message-port";
import type { HostToMain, MainToHost } from "../../electron/collab/adapters/protocol";
import { UtilityHost, installationId } from "../../electron/collab/adapters/utility";
import { CollabHost } from "../../electron/collab/core/host";
import type { HostStatus } from "../../src/lib/collab/local-api";
import type { HubToReplica, ReplicaToHub } from "../../src/lib/collab/protocol/local";
import { ContentKeys } from "../../src/lib/collab/protocol/schema";

const quietLogger = { warn() {}, error() {} };

async function until(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The renderer's end: collects hub messages. */
function replicaEnd(port: MessagePort) {
  const received: HubToReplica[] = [];
  port.on("message", (message: HubToReplica) => received.push(message));
  return {
    received,
    send: (message: ReplicaToHub) => port.postMessage(message),
    close: () => port.close(),
  };
}

/** MessagePortMain's shape: "message" events are `{ data, ports }`. */
class ElectronStylePort extends EventEmitter implements MessagePortLike {
  constructor(private readonly inner: MessagePort) {
    super();
    inner.on("message", (data: unknown) => this.emit("message", { data, ports: [] }));
    inner.on("close", () => this.emit("close"));
  }
  postMessage(message: unknown): void {
    this.inner.postMessage(message);
  }
  start(): void {}
  close(): void {
    this.inner.close();
  }
}

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test("parseReplicaMessage drops malformed messages", () => {
  const bytes = new Uint8Array([0, 0]);
  assert.ok(parseReplicaMessage({ t: "attach", docId: "d", stateVectors: { content: bytes } }));
  assert.ok(parseReplicaMessage({ t: "update", docId: "d", subdoc: "content", update: bytes }));
  assert.equal(parseReplicaMessage({ t: "update", docId: "d", subdoc: "nope", update: bytes }), null);
  assert.equal(parseReplicaMessage({ t: "update", docId: "d", subdoc: "content", update: "text" }), null);
  assert.equal(parseReplicaMessage({ t: "attach", docId: "d", stateVectors: { content: [1, 2] } }), null);
  assert.equal(parseReplicaMessage({ t: "awareness", docId: "", update: bytes }), null);
  assert.equal(parseReplicaMessage({ t: "boom", docId: "d" }), null);
  assert.equal(parseReplicaMessage(null), null);
});

for (const style of ["node", "electron"] as const) {
  test(`MessagePort adapter (${style} events) connects a replica to a hub`, async () => {
    const dir = tempDir("libera-elec-ports-");
    const host = new CollabHost({ dbPath: path.join(dir, "host.sqlite"), appVersion: "test", installationId: "inst_ports_test", logger: quietLogger, compaction: false, hubIdleMs: 10 });
    host.start();
    try {
      const { port1, port2 } = new MessageChannel();
      const hubSide: MessagePortLike = style === "electron" ? new ElectronStylePort(port1) : (port1 as unknown as MessagePortLike);
      const replica = replicaEnd(port2);
      const docId = "doc_ports";
      host.attachReplica(docId, adaptMessagePort(hubSide, quietLogger));
      assert.equal(host.registry.refCount(docId), 1);

      replica.send({ t: "attach", docId, stateVectors: {} });
      await until(() => replica.received.some((message) => message.t === "status"), "the hub's attach reply");
      assert.deepEqual(
        replica.received.filter((message) => message.t === "state").map((message) => (message as { subdoc: string }).subdoc),
        ["content", "annotations", "meta"],
      );

      // A replica edit is persisted and applied to the hub's doc.
      const local = new Y.Doc();
      local.getText(ContentKeys.source).insert(0, "typed in the renderer");
      replica.send({ t: "update", docId, subdoc: "content", update: Y.encodeStateAsUpdate(local), provenance: { source: "typing" } });
      await until(() => host.registry.get(docId)?.getText() === "typed in the renderer", "the update to reach the hub");
      assert.equal(host.store.unackedUpdates(docId).length, 1, "persisted before anything else");

      // An in-process edit reaches the replica.
      replica.received.length = 0;
      host.registry.get(docId)?.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, ">> "), { source: "ai", feature: "agent" });
      await until(() => replica.received.some((message) => message.t === "update"), "the hub's edit to reach the replica");
      const update = replica.received.find((message) => message.t === "update") as Extract<HubToReplica, { t: "update" }>;
      Y.applyUpdate(local, update.update);
      assert.equal(local.getText(ContentKeys.source).toString(), ">> typed in the renderer");

      // Garbage is dropped without hurting the connection.
      port2.postMessage({ t: "update", docId, subdoc: "content", update: "not bytes" });
      port2.postMessage("nonsense");

      // The renderer going away detaches the replica and releases the hub.
      replica.close();
      await until(() => host.registry.refCount(docId) === 0, "the hub reference to be released");
    } finally {
      await host.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("utility host: start, ready, attach, secrets, shutdown", { timeout: 60_000 }, async () => {
  const userData = tempDir("libera-elec-utility-");
  const dataDir = tempDir("libera-elec-data-");
  const sent: HostToMain[] = [];
  const parent = new EventEmitter() as EventEmitter & { postMessage(message: unknown): void };
  const secretsAsked: string[] = [];
  parent.postMessage = (message: unknown) => {
    const out = message as HostToMain;
    sent.push(out);
    // Play main's safeStorage role.
    if (out.t === "secret") {
      secretsAsked.push(out.op);
      const value = out.op === "decrypt" ? Buffer.from(out.value, "base64").toString() : Buffer.from(out.value).toString("base64");
      setImmediate(() => parent.emit("message", { data: { t: "secret-result", id: out.id, ok: true, value } satisfies MainToHost, ports: [] }));
    }
  };
  const fromMain = (data: MainToHost, ports: MessagePortLike[] = []) => parent.emit("message", { data, ports });
  const exits: number[] = [];

  // A remembered account on an unreachable server: the host decrypts the
  // session through main, fails to refresh over the network, and is offline.
  const collabDir = path.join(userData, "collab");
  mkdirSync(collabDir, { recursive: true });
  writeFileSync(path.join(collabDir, "account.json"), JSON.stringify({ version: 1, serverUrl: "http://127.0.0.1:9", account: { id: "acct_test", email: "t@example.test", displayName: "T", color: "#2563eb" } }));
  writeFileSync(path.join(collabDir, "session.bin"), JSON.stringify({ version: 1, accountId: "acct_test", refreshToken: Buffer.from("refresh-secret").toString("base64") }));

  const utility = new UtilityHost(parent, { logger: quietLogger, onExit: (code) => exits.push(code), app: { host: { compaction: false, hubIdleMs: 10, connectTimeoutMs: 2_000 } } });
  try {
    fromMain({ t: "start", protocol: 1, userData, dataDir, appVersion: "test", port: 0, token: "utility-token" });
    await until(() => sent.some((message) => message.t === "ready" || message.t === "fatal"), "ready");
    const ready = sent.find((message) => message.t === "ready") as Extract<HostToMain, { t: "ready" }>;
    assert.ok(ready, JSON.stringify(sent));
    assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(secretsAsked.includes("decrypt"), "the session was decrypted by main");
    assert.ok(existsSync(path.join(collabDir, "acct_test.sqlite")));
    assert.equal(await installationId(collabDir), await installationId(collabDir), "the installation id is stable");

    const status = await fetch(`${ready.url}/status`, { headers: { authorization: "Bearer utility-token" } });
    assert.equal(status.status, 200);
    assert.equal(((await status.json()) as HostStatus).account?.id, "acct_test");
    await until(
      () => sent.some((message) => message.t === "event" && message.event.t === "status" && message.event.status.connection === "offline"),
      "an offline status event",
    );

    // attach: the port arrives in the event's ports.
    const { port1, port2 } = new MessageChannel();
    const replica = replicaEnd(port2);
    fromMain({ t: "attach", docId: "doc_utility" }, [port1 as unknown as MessagePortLike]);
    replica.send({ t: "attach", docId: "doc_utility", stateVectors: {} });
    await until(() => replica.received.some((message) => message.t === "status"), "the attached hub to answer");
    const hostCore = utility.controlApp?.runtime.host;
    assert.equal(hostCore?.registry.refCount("doc_utility"), 1);
    fromMain({ t: "nudge" });
    fromMain({ t: "suspend" });
    fromMain({ t: "resume" });

    // shutdown flushes, closes the database and acknowledges.
    fromMain({ t: "shutdown", id: 7 });
    await until(() => sent.some((message) => message.t === "shutdown-done"), "shutdown-done");
    assert.deepEqual(sent.find((message) => message.t === "shutdown-done"), { t: "shutdown-done", id: 7 });
    assert.deepEqual(exits, [0]);
    assert.ok(!existsSync(path.join(collabDir, "acct_test.sqlite.lock")), "the database lock is released");
    await assert.rejects(fetch(`${ready.url}/status`, { headers: { authorization: "Bearer utility-token" } }));
    replica.close();
  } finally {
    rmSync(userData, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("utility host reports a fatal start", async () => {
  const sent: HostToMain[] = [];
  const parent = new EventEmitter() as EventEmitter & { postMessage(message: unknown): void };
  parent.postMessage = (message: unknown) => sent.push(message as HostToMain);
  const exits: number[] = [];
  new UtilityHost(parent, { logger: quietLogger, onExit: (code) => exits.push(code) });
  parent.emit("message", { data: { t: "start", protocol: 99, userData: tmpdir(), dataDir: tmpdir(), appVersion: "x", port: 0, token: "t" }, ports: [] });
  await until(() => sent.length > 0, "fatal");
  assert.equal(sent[0].t, "fatal");
  assert.deepEqual(exits, [1]);
});
