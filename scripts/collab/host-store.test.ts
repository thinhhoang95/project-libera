import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { statSync, utimesSync, writeFileSync } from "node:fs";
import test from "node:test";

import * as Y from "yjs";

import { HostStore, HostStoreLockedError, STORE_SCHEMA_VERSION } from "../../electron/collab/core/store";
import { tempDir } from "./support/host-helpers";

function textUpdates(count: number): Uint8Array[] {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array) => updates.push(update));
  for (let index = 0; index < count; index += 1) doc.getText("source").insert(doc.getText("source").length, `${index} `);
  return updates;
}

test("store opens with WAL, synchronous=FULL, foreign keys and a migrated schema", () => {
  const temp = tempDir();
  try {
    const store = new HostStore({ path: temp.file("a.sqlite") });
    assert.equal(String(store.pragma("journal_mode")).toLowerCase(), "wal");
    assert.equal(Number(store.pragma("synchronous")), 2);
    assert.equal(Number(store.pragma("foreign_keys")), 1);
    assert.ok(Number(store.pragma("busy_timeout")) > 0);
    assert.equal(store.schemaVersion(), STORE_SCHEMA_VERSION);
    store.close();
    // Reopening runs no migration twice.
    const again = new HostStore({ path: temp.file("a.sqlite") });
    assert.equal(again.schemaVersion(), STORE_SCHEMA_VERSION);
    again.close();
  } finally {
    temp.cleanup();
  }
});

test("a second store on the same file fails fast with a clear error", () => {
  const temp = tempDir();
  try {
    const path = temp.file("a.sqlite");
    const store = new HostStore({ path });
    assert.throws(
      () => new HostStore({ path }),
      (error: unknown) => error instanceof HostStoreLockedError && error.ownerPid === process.pid && /another Libera process/.test(error.message),
    );
    store.close();
    // Released on close.
    new HostStore({ path }).close();
  } finally {
    temp.cleanup();
  }
});

test("a stale lock from a dead process is taken over", async () => {
  const temp = tempDir();
  try {
    const path = temp.file("a.sqlite");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10)"]);
    const deadPid = child.pid as number;
    await new Promise((resolve) => child.on("exit", resolve));
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: deadPid, token: "stale" }));
    const store = new HostStore({ path });
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("an old lock whose pid now belongs to another program is taken over", () => {
  const temp = tempDir();
  try {
    const path = temp.file("a.sqlite");
    // A host died and the OS reused its pid: the pid is alive (here, this
    // test's own), but nothing has refreshed the lock for minutes.
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, host: "x", token: "dead-host" }));
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(`${path}.lock`, old, old);
    const store = new HostStore({ path });
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("a live owner keeps its lock fresh, so a second store stays out", async () => {
  const temp = tempDir();
  try {
    const path = temp.file("a.sqlite");
    const store = new HostStore({ path, lockHeartbeatMs: 20, lockStaleMs: 200 });
    const first = statSync(`${path}.lock`).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(statSync(`${path}.lock`).mtimeMs > first, "the heartbeat refreshes the lock");
    assert.throws(() => new HostStore({ path, lockHeartbeatMs: 20, lockStaleMs: 200 }), HostStoreLockedError);
    store.close();
    new HostStore({ path }).close();
  } finally {
    temp.cleanup();
  }
});

test("a database from a newer build is refused", () => {
  const temp = tempDir();
  try {
    const path = temp.file("a.sqlite");
    const store = new HostStore({ path });
    (store as unknown as { db: { exec(sql: string): void } }).db.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION + 5}`);
    store.close();
    assert.throws(() => new HostStore({ path }), /newer Libera/);
  } finally {
    temp.cleanup();
  }
});

test("appends are committed when they return and survive reopening", () => {
  const temp = tempDir();
  try {
    const path = temp.file("a.sqlite");
    const updates = textUpdates(5);
    const store = new HostStore({ path });
    const seqs = updates.map((update) => store.appendLocal("d1", "content", update, { source: "typing" }));
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    // No close(): the rows must already be durable.
    (store as unknown as { db: { close(): void } }).db.close();
    (store as unknown as { lock: { release(): void } }).lock.release();
    const reopened = new HostStore({ path });
    const rows = reopened.allUpdates("d1");
    assert.deepEqual(
      rows.map((row) => row.localSeq),
      seqs,
    );
    assert.deepEqual(rows[0].origin, { kind: "local", provenance: { source: "typing" } });
    assert.equal(rows[0].ackedServerSeq, null);
    reopened.close();
  } finally {
    temp.cleanup();
  }
});

test("batches allocate clientSeq per doc and acks mark covered updates", () => {
  const store = new HostStore({ path: ":memory:" });
  const [a, b, c] = textUpdates(3);
  const s1 = store.appendLocal("d1", "content", a);
  const s2 = store.appendLocal("d1", "content", b);
  const s3 = store.appendLocal("d2", "content", c);
  const batch1 = store.createBatch("d1", "content", [s1, s2], Y.mergeUpdates([a, b]));
  const batch2 = store.createBatch("d2", "content", [s3], c);
  assert.equal(batch1.clientSeq, 1);
  assert.equal(batch2.clientSeq, 1, "clientSeq is per document");
  assert.equal(store.getDocMeta("d1")?.nextClientSeq, 2);
  assert.deepEqual(store.unbatchedUpdates("d1"), []);
  assert.deepEqual(store.outboundBatches("d1")[0].localSeqs, [s1, s2]);
  assert.deepEqual(store.ackBatch("d1", 1, 42), [s1, s2]);
  assert.equal(store.ackBatch("d1", 1, 42), null, "a duplicate ack is ignored");
  assert.deepEqual(
    store.allUpdates("d1").map((row) => row.ackedServerSeq),
    [42, 42],
  );
  assert.equal(store.outboundBatches("d1").length, 0);
  assert.equal(store.getDocMeta("d1")?.lastSeenServerSeq, 42);
  assert.deepEqual(store.docsWithUnacked(), ["d2"]);
  store.close();
});

test("pending commands, threads cache, projects, docs and blobs round-trip", () => {
  const store = new HostStore({ path: ":memory:" });
  const command = { id: "c1", kind: "thread.delete" as const, threadId: "t1" };
  assert.equal(store.insertCommand(command), true);
  assert.equal(store.insertCommand(command), false);
  store.recordCommandAttempt("c1", "offline");
  assert.deepEqual(store.listCommands()[0], { id: "c1", kind: "thread.delete", command, createdAt: store.listCommands()[0].createdAt, attempts: 1, lastError: "offline" });
  store.deleteCommand("c1");
  assert.equal(store.listCommands().length, 0);

  store.putThread("t1", "d1", { quote: "hi" });
  assert.deepEqual(store.listThreads("d1")[0].json, { quote: "hi" });
  store.upsertProject({ projectId: "p1", name: "Notes", localRoot: "/x", role: "editor" });
  store.upsertDoc({ docId: "d1", projectId: "p1", fileId: "f1", path: "a.md", materializedHash: null });
  store.setMaterializedHash("d1", "abc");
  assert.equal(store.getDoc("d1")?.materializedHash, "abc");
  assert.equal(store.listDocs("p1").length, 1);
  store.putBlob({ hash: "h", localPath: "/b", size: 3 });
  assert.equal(store.getBlob("h")?.size, 3);
  store.deleteProject("p1");
  assert.equal(store.getDoc("d1"), null);
  store.close();
});

test("p95 append-commit latency stays under 50 ms", () => {
  const temp = tempDir();
  try {
    const store = new HostStore({ path: temp.file("latency.sqlite") });
    const updates = textUpdates(600);
    const samples: number[] = [];
    for (const update of updates) {
      const started = performance.now();
      store.appendLocal("lat", "content", update, { source: "typing" });
      samples.push(performance.now() - started);
    }
    store.close();
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)];
    const p95 = samples[Math.floor(samples.length * 0.95)];
    const max = samples[samples.length - 1];
    console.log(`[host-store] append commit latency over ${samples.length} appends: p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${max.toFixed(2)} ms`);
    assert.ok(p95 < 50, `p95 ${p95} ms`);
  } finally {
    temp.cleanup();
  }
});
