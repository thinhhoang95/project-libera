import assert from "node:assert/strict";
import test from "node:test";

import * as Y from "yjs";

import { Compactor, type CompactionStats, type CompactionTarget } from "../../electron/collab/core/compaction";
import { DocHub } from "../../electron/collab/core/doc-hub";
import { HostStore } from "../../electron/collab/core/store";
import { SyncClient } from "../../electron/collab/core/sync-client";
import { FakeSyncServer } from "./support/host-fake-server";
import { TestTokens, quietLogger, sleep, tempDir, waitFor } from "./support/host-helpers";

function type(hub: DocHub, text: string) {
  hub.applyLocalChange("content", (doc) => doc.getText("source").insert(doc.getText("source").length, text), { source: "typing" });
}

test("compaction snapshots the log but keeps unacked updates and outbound bytes", async () => {
  const temp = tempDir();
  const server = new FakeSyncServer();
  const store = new HostStore({ path: temp.file("c.sqlite") });
  const compactor = new Compactor({ store, logger: quietLogger, updatesThreshold: 50 });
  const compactions: CompactionStats[] = [];
  compactor.onCompacted((stats) => compactions.push(stats));
  const hub = new DocHub({ docId: "d1", store, logger: quietLogger, compactor });
  const client = new SyncClient({
    url: "ws://fake/sync",
    appVersion: "test",
    clientId: "i:a",
    tokenProvider: new TestTokens(),
    webSocketFactory: server.factory,
    logger: quietLogger,
    random: () => 0,
  });
  client.register(hub);
  client.start();
  try {
    await waitFor(() => client.connected && hub.getStatus().state === "saved-remote");
    for (let index = 0; index < 30; index += 1) type(hub, `a${index} `);
    await waitFor(() => hub.pendingCount === 0, 3000, "first edits acked");
    server.holdAcks = true;
    for (let index = 0; index < 30; index += 1) {
      type(hub, `u${index} `);
      // Spread the edits over several batches.
      if (index % 10 === 9) await sleep(40);
    }
    await waitFor(() => compactions.length >= 1, 5000, "compaction ran");
    await compactor.whenIdle();
    await hub.flushOutbound();
    await sleep(40);
    const batchesBefore = hub.pendingBatches();
    await hub.compactNow();
    await compactor.whenIdle();

    const snapshot = store.latestSnapshot("d1", "content");
    assert.ok(snapshot, "a snapshot was written");
    const rows = store.allUpdates("d1");
    assert.ok(rows.every((row) => row.ackedServerSeq === null), "only acked updates were deleted");
    assert.equal(rows.length, 30, "all 30 unacked updates survive");
    assert.equal(hub.pendingCount, 30);
    const batchesAfter = hub.pendingBatches();
    assert.deepEqual(
      batchesAfter.map((batch) => [batch.clientSeq, batch.update]),
      batchesBefore.map((batch) => [batch.clientSeq, batch.update]),
      "outbound bytes are untouched",
    );
    assert.deepEqual(store.outboundBatches("d1").map((batch) => batch.update), batchesBefore.map((batch) => batch.update));

    // The unacked updates still sync, with their original batches.
    server.releaseAcks();
    await waitFor(() => hub.pendingCount === 0, 3000, "acked after compaction");
    assert.equal(server.text("d1"), hub.getText());
  } finally {
    client.stop();
    hub.close();
    await compactor.close();
    store.close();
    temp.cleanup();
  }
});

test("a cold start from snapshot plus tail equals the state before the restart", async () => {
  const temp = tempDir();
  try {
    const path = temp.file("cold.sqlite");
    let store = new HostStore({ path });
    let compactor = new Compactor({ store, logger: quietLogger, updatesThreshold: 100 });
    let hub = new DocHub({ docId: "d1", store, logger: quietLogger, compactor });
    for (let index = 0; index < 250; index += 1) {
      hub.applyLocalChange("content", (doc) => {
        const text = doc.getText("source");
        if (index % 7 === 3 && text.length > 10) text.delete(Math.floor(text.length / 2), 3);
        else text.insert(index % 5 === 0 ? 0 : text.length, `w${index} `);
      });
      if (index % 50 === 0) hub.applyLocalChange("annotations", (doc) => doc.getMap("anchors").set(`a${index}`, { id: `a${index}` }));
      if (index % 60 === 59) await compactor.whenIdle();
    }
    await compactor.whenIdle();
    for (let index = 0; index < 20; index += 1) type(hub, `tail${index} `);
    const before = {
      text: hub.getText(),
      annotations: hub.getText("annotations"),
      vector: Y.encodeStateVector(hub.getDoc("content")),
    };
    hub.close();
    await compactor.close();
    store.close();

    store = new HostStore({ path });
    const { snapshot, tail } = store.loadSubdoc("d1", "content");
    assert.ok(snapshot && snapshot.uptoLocalSeq > 0, "loaded from a snapshot");
    assert.ok(tail.length >= 20, "plus a tail");
    compactor = new Compactor({ store, logger: quietLogger });
    hub = new DocHub({ docId: "d1", store, logger: quietLogger, compactor });
    assert.equal(hub.getText(), before.text);
    assert.equal(hub.getText("annotations"), before.annotations);
    assert.deepEqual(Y.encodeStateVector(hub.getDoc("content")), before.vector);
    hub.close();
    await compactor.close();
    store.close();
  } finally {
    temp.cleanup();
  }
});

/** Builds about 1 MB of acked log for one sub-document: realistic typing with some mid-document edits. */
function seedMegabyteLog(store: HostStore, docId: string): { text: string; rows: number; bytes: number } {
  const doc = new Y.Doc();
  const text = doc.getText("source");
  let pending: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array) => pending.push(update));
  let rows = 0;
  let bytes = 0;
  let serverSeq = 0;
  const words = "the quick brown fox jumps over the lazy dog while compaction runs in the background ".split(" ");
  let edit = 0;
  while (bytes < 1024 * 1024) {
    edit += 1;
    const word = `${words[edit % words.length]}${edit % 13 === 0 ? ".\n" : " "}`;
    if (edit % 20 === 0 && text.length > 100) {
      const at = Math.floor((text.length * ((edit * 7919) % 1000)) / 1000);
      if (edit % 40 === 0) text.delete(at, 4);
      else text.insert(at, word);
    } else {
      text.insert(text.length, word);
    }
    if (pending.length >= 8) {
      const update = Y.mergeUpdates(pending);
      pending = [];
      serverSeq += 1;
      store.appendAcked(docId, "content", update, { kind: "server" }, serverSeq);
      rows += 1;
      bytes += update.length;
    }
  }
  return { text: text.toString(), rows, bytes };
}

function target(store: HostStore, docId: string): CompactionTarget {
  return {
    docId,
    generation: () => 1,
    lastPersistedSeq: () => store.tailStats(docId, "content").lastLocalSeq,
    compacted: () => {},
  };
}

test("compacting 1 MB of log keeps every main-thread step short", { timeout: 120_000 }, async () => {
  const temp = tempDir();
  try {
    const store = new HostStore({ path: temp.file("big.sqlite") });
    const seeded = seedMegabyteLog(store, "big");
    const unackedDoc = new Y.Doc();
    Y.applyUpdate(unackedDoc, Y.mergeUpdates(store.allUpdates("big").map((row) => row.update)));
    // One unacked local edit inside the range must survive.
    const sv = Y.encodeStateVector(unackedDoc);
    unackedDoc.getText("source").insert(0, "UNACKED ");
    const unackedSeq = store.appendLocal("big", "content", Y.encodeStateAsUpdate(unackedDoc, sv));

    // Watch the event loop while compaction runs: no gap may be long.
    let maxGap = 0;
    let last = performance.now();
    let watching = true;
    const watch = () => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      if (watching) setImmediate(watch);
    };
    const compactor = new Compactor({ store, logger: quietLogger });
    setImmediate(watch);
    const stats = await compactor.schedule(target(store, "big"), "content");
    watching = false;
    assert.ok(stats, "compaction ran");
    assert.equal(stats.mode, "worker");
    console.log(
      `[host-compaction] 1 MB log: ${seeded.rows} rows, ${(stats.inputBytes / 1024).toFixed(0)} KB in, ` +
        `${(stats.stateBytes / 1024).toFixed(0)} KB snapshot, merge ${stats.mergeMs.toFixed(1)} ms in worker, ` +
        `longest main-thread step ${stats.maxMainTaskMs.toFixed(2)} ms (${stats.slowestStep}), longest event-loop gap ${maxGap.toFixed(2)} ms, total ${stats.totalMs.toFixed(0)} ms`,
    );
    // The design budget is 10 ms per main-thread task (source plan §7); the
    // log line above reports the real figure (3–7 ms when run alone). The
    // assertion only catches regressions by an order of magnitude, because
    // the default suite runs ~60 files in parallel on one CPU; set
    // LIBERA_COLLAB_TASK_BUDGET_MS=10 to check the real budget on a quiet machine.
    const budgetMs = Number(process.env.LIBERA_COLLAB_TASK_BUDGET_MS ?? 50);
    assert.ok(stats.maxMainTaskMs < budgetMs, `longest main-thread step ${stats.maxMainTaskMs} ms`);
    assert.ok(maxGap < 50, `longest event-loop gap ${maxGap} ms`);
    assert.equal(stats.deletedRows, seeded.rows, "every acked row was deleted");
    const left = store.allUpdates("big");
    assert.deepEqual(left.map((row) => row.localSeq), [unackedSeq], "the unacked update survived");
    const { snapshot, tail } = store.loadSubdoc("big", "content");
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, (snapshot as { state: Uint8Array }).state);
    for (const row of tail) Y.applyUpdate(rebuilt, row.update);
    assert.equal(rebuilt.getText("source").toString(), `UNACKED ${seeded.text}`);

    // For comparison: the inline fallback on the same data.
    const inlineStore = new HostStore({ path: temp.file("inline.sqlite") });
    seedMegabyteLog(inlineStore, "big");
    const inline = new Compactor({ store: inlineStore, logger: quietLogger, mode: "inline" });
    const inlineStats = await inline.schedule(target(inlineStore, "big"), "content");
    assert.ok(inlineStats);
    console.log(`[host-compaction] inline fallback on the same log: longest main-thread step ${inlineStats.maxMainTaskMs.toFixed(2)} ms (${inlineStats.slowestStep})`);
    await inline.close();
    inlineStore.close();
    await compactor.close();
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("a rollback during compaction aborts it", async () => {
  const store = new HostStore({ path: ":memory:" });
  const compactor = new Compactor({ store, logger: quietLogger });
  const hub = new DocHub({ docId: "d1", store, logger: quietLogger, compactor });
  for (let index = 0; index < 20; index += 1) type(hub, `${index} `);
  const job = compactor.schedule(hub, "content");
  hub.rollback("content", "forbidden", "test");
  assert.equal(await job, null);
  assert.equal(store.latestSnapshot("d1", "content"), null);
  hub.close();
  await compactor.close();
  store.close();
});
