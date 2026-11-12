// Audit 2026-11-12, DATA-1: a host crash must not strand edits in a renderer.
//
// A replica keeps typing after the host process died and was replaced. The
// registry learns of the new host generation (host-down / host-ready events
// from Electron main), re-attaches the replica over a fresh port, and the
// replica hands over its whole state, so edits that were queued, sent into a
// dead port or never acknowledged reach the new host's SQLite. Until then the
// document counts as holding unconfirmed work.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import * as Y from "yjs";

import { parseReplicaMessage } from "../../electron/collab/adapters/message-port";
import { CollabHost } from "../../electron/collab/core/host";
import { createMemoryPortPair } from "../../electron/collab/core/ports";
import { HostStore } from "../../electron/collab/core/store";
import { SharedDocRegistry } from "../../src/lib/collab/client/registry";
import type { HostEvent, ResolvedDoc } from "../../src/lib/collab/local-api";
import { ContentKeys } from "../../src/lib/collab/protocol/schema";
import { browserPort } from "./support/wire-harness";

const quietLogger = { warn() {}, error() {} };
const docId = "doc_reconnect";
const resolved: ResolvedDoc = { docId, projectId: "p1", fileId: "f1", path: "Shared/note.md", kind: "markdown", role: "editor", readOnly: false };

async function until(condition: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function newHost(dbPath: string): CollabHost {
  const host = new CollabHost({ dbPath, appVersion: "test", installationId: "inst_reconnect_test", logger: quietLogger, compaction: false, hubIdleMs: 10 });
  host.start();
  return host;
}

/** Text a fresh host would load from the database file alone. */
function persistedText(dbPath: string): string {
  const store = new HostStore({ path: dbPath });
  try {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.mergeUpdates(store.allUpdates(docId).filter((row) => row.subdoc === "content").map((row) => row.update)));
    return doc.getText(ContentKeys.source).toString();
  } finally {
    store.close();
  }
}

function fixture(options: { attachFailures?: number } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "libera-audit1112-reconnect-"));
  const dbPath = path.join(dir, "host.sqlite");
  let host = newHost(dbPath);
  let listener: ((event: HostEvent) => void) | null = null;
  let failures = options.attachFailures ?? 0;
  let attachCalls = 0;
  const ports: Array<ReturnType<typeof browserPort>> = [];
  const registry = new SharedDocRegistry({
    resolve: async () => resolved,
    attach: async () => {
      attachCalls += 1;
      if (attachCalls > 1 && failures > 0) {
        failures -= 1;
        throw new Error("The collaboration service is not running.");
      }
      const pair = createMemoryPortPair();
      host.attachReplica(docId, pair.hub);
      const port = browserPort(pair.replica);
      ports.push(port);
      return port;
    },
    subscribeEvents: (next) => { listener = next; return () => { listener = null; }; },
    replicaOptions: { schedule: queueMicrotask },
    available: () => true,
    reconnectDelayMs: 5,
  });
  return {
    registry,
    dbPath,
    ports,
    attachCalls: () => attachCalls,
    get host() { return host; },
    emit: (event: HostEvent) => listener?.(event),
    /** The utility process dies: its ports close with it and nothing is flushed beyond SQLite commits. */
    async crash() {
      for (const port of ports) port.close();
      await host.stop();
    },
    restart() { host = newHost(dbPath); },
    async cleanup() {
      registry.destroy();
      await host.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("updates carry a sequence number and the hub acknowledges them once committed", async () => {
  const f = fixture();
  try {
    const lease = f.registry.acquire(resolved, "tab:1");
    const { replica } = await lease.ready;
    await replica.whenAttached();
    assert.equal(replica.hasUnconfirmedWork(), false);
    replica.ytext.insert(0, "abc");
    assert.equal(replica.hasUnconfirmedWork(), true, "queued, not yet sent");
    await until(() => !replica.hasUnconfirmedWork(), "the hub's acknowledgement");
    assert.equal(f.host.registry.get(docId)?.getText(), "abc");
    assert.ok(parseReplicaMessage({ t: "update", docId, subdoc: "content", update: new Uint8Array(2), seq: 3 }));
    assert.equal(parseReplicaMessage({ t: "update", docId, subdoc: "content", update: new Uint8Array(2), seq: -1 }), null);
  } finally {
    await f.cleanup();
  }
});

test("edits typed after a host crash, announced by host-down, reach the replacement host", async () => {
  const f = fixture();
  try {
    const lease = f.registry.acquire(resolved, "tab:1");
    const { replica } = await lease.ready;
    await replica.whenAttached();
    replica.ytext.insert(0, "before ");
    await until(() => !replica.hasUnconfirmedWork(), "the first edit to be acknowledged");

    await f.crash();
    f.emit({ t: "host-down", generation: 1 });
    assert.equal(replica.getSnapshot().hostConnected, false);
    assert.equal(f.registry.unconfirmedDocumentCount(), 1, "a lost host counts as unsaved work");

    replica.ytext.insert(replica.ytext.length, "while down");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(replica.hasUnconfirmedWork(), true, "the edit is kept, not dropped from the queue");

    f.restart();
    f.emit({ t: "host-ready", generation: 2 });
    await until(() => !replica.hasUnconfirmedWork() && replica.getSnapshot().hostConnected, "the replica to re-attach and be acknowledged");
    assert.equal(f.registry.unconfirmedDocumentCount(), 0);
    assert.equal(f.host.registry.get(docId)?.getText(), "before while down");

    await f.host.stop();
    assert.equal(persistedText(f.dbPath), "before while down", "the new host committed the edit to SQLite");
  } finally {
    await f.cleanup();
  }
});

test("edits sent into a dead port with no event at all are still recovered at host-ready", async () => {
  const f = fixture();
  try {
    const lease = f.registry.acquire(resolved, "tab:1");
    const { replica } = await lease.ready;
    await replica.whenAttached();
    replica.ytext.insert(0, "one");
    await until(() => !replica.hasUnconfirmedWork(), "the first edit to be acknowledged");

    await f.crash();
    // The port is dead but the replica was never told: this is posted and lost.
    replica.ytext.insert(replica.ytext.length, " two");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(replica.hasUnconfirmedWork(), true, "sent but never acknowledged");

    f.restart();
    f.emit({ t: "host-ready", generation: 2 });
    await until(() => !replica.hasUnconfirmedWork() && replica.getSnapshot().hostConnected, "the resync to be acknowledged");
    assert.equal(f.host.registry.get(docId)?.getText(), "one two");
    await f.host.stop();
    assert.equal(persistedText(f.dbPath), "one two");
  } finally {
    await f.cleanup();
  }
});

test("re-attaching retries while the new host is still starting, and an idle replica sends nothing new", async () => {
  const f = fixture({ attachFailures: 3 });
  try {
    const lease = f.registry.acquire(resolved, "tab:1");
    const { replica } = await lease.ready;
    await replica.whenAttached();
    replica.ytext.insert(0, "kept");
    await until(() => !replica.hasUnconfirmedWork(), "the edit to be acknowledged");
    const before = f.host.registry.get(docId)?.getText();
    assert.equal(before, "kept");

    await f.crash();
    f.emit({ t: "host-down", generation: 1 });
    f.restart();
    f.emit({ t: "host-ready", generation: 2 });
    await until(() => f.attachCalls() >= 5 && replica.getSnapshot().hostConnected, "the retries to succeed");
    assert.equal(f.attachCalls(), 5, "three refused attempts, then one success after the first attach");
    await until(() => f.host.registry.get(docId)?.getText() === "kept", "the replacement hub to load the document");

    // The tab keeps working against the new host.
    replica.ytext.insert(replica.ytext.length, "!");
    await until(() => !replica.hasUnconfirmedWork(), "an edit on the new port to be acknowledged");
    assert.equal(f.host.registry.get(docId)?.getText(), "kept!");
  } finally {
    await f.cleanup();
  }
});
