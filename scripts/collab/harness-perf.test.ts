// Performance checks against the source-plan §10 budgets, with real hosts
// and the real server on loopback. Every number is printed with a
// "[collab-perf]" prefix (and recorded in docs/collaboration/testing.md);
// the assertions use the budget times LIBERA_COLLAB_PERF_SLACK (default 3)
// so a loaded CI machine does not flake while a real regression still fails.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import test, { after, before } from "node:test";

import { ContentKeys } from "../../src/lib/collab/protocol/schema";
import { Cluster, sleep, waitUntil, type Collaborator, type HarnessHost, type HarnessUser } from "./harness/cluster";
import { checkMarkers, markersInUpdate } from "./harness/markers";
import { HEAVY, PERF_SLACK, ms, report, summarize } from "./harness/stats";
import { MarkerTypist, RandomTypist } from "./harness/typist";

let cluster: Cluster;
let users: HarnessUser[];

const HOSTS_ON_ONE_DOC = 20;

before(async () => {
  cluster = await Cluster.start();
  users = [];
  for (let index = 0; index < HOSTS_ON_ONE_DOC; index += 1) users.push(await cluster.registerUser(`Perf${index}`));
});

after(async () => {
  await cluster?.stop();
});

async function scene(members: HarnessUser[]): Promise<{ projectId: string; docId: string; hosts: HarnessHost[] }> {
  const [owner, ...others] = members;
  const projectId = await cluster.createProject(owner);
  for (const user of others) await cluster.addMember(projectId, owner, user);
  const docId = await cluster.createDoc(projectId, owner);
  const hosts: HarnessHost[] = [];
  for (const user of members) {
    const host = await cluster.addHost(user);
    host.open(docId, projectId);
    hosts.push(host);
  }
  await waitUntil(() => hosts.every((host) => host.hub(docId).getStatus().state === "saved-remote"), "hosts to open the doc", 30_000);
  return { projectId, docId, hosts };
}

async function teardown(): Promise<void> {
  for (const host of [...cluster.hosts]) await cluster.removeHost(host);
}

/** Records when each marker first reaches each observing host (from the remote update bytes). */
function watchArrivals(hosts: HarnessHost[], docId: string): { arrivals: Map<string, Map<string, number>>; stop: () => void } {
  const arrivals = new Map<string, Map<string, number>>();
  const offs = hosts.map((host) =>
    host.hub(docId).observe("content", (change) => {
      if (change.origin !== "remote" && change.origin !== "server") return;
      const now = performance.now();
      for (const marker of markersInUpdate(change.update)) {
        let byHost = arrivals.get(marker);
        if (!byHost) arrivals.set(marker, (byHost = new Map()));
        if (!byHost.has(host.name)) byHost.set(host.name, now);
      }
    }),
  );
  return { arrivals, stop: () => offs.forEach((off) => off()) };
}

test("§10 local edit to saved on this device: p95 under 50 ms", { timeout: 60_000 }, async () => {
  try {
    const { docId, hosts } = await scene([users[0], users[1]]);
    const hub = hosts[0].hub(docId);
    const typist = new RandomTypist({ seed: 10, maxPaste: 4000 });
    const online: number[] = [];
    for (let index = 0; index < 500; index += 1) {
      const started = performance.now();
      typist.step(hub);
      online.push(performance.now() - started);
      if (index % 10 === 0) await sleep(1);
    }
    hosts[0].link.partition();
    await waitUntil(() => hub.getStatus().state === "offline", "offline");
    const offline: number[] = [];
    for (let index = 0; index < 300; index += 1) {
      const started = performance.now();
      typist.step(hub);
      offline.push(performance.now() - started);
    }
    const on = summarize(online);
    const off = summarize(offline);
    report("local edit to saved-local, online (p50 / p95 / max)", `${ms(on.p50)} / ${ms(on.p95)} / ${ms(on.max)}`);
    report("local edit to saved-local, offline (p50 / p95 / max)", `${ms(off.p50)} / ${ms(off.p95)} / ${ms(off.max)}`);
    assert.ok(on.p95 < 50 * PERF_SLACK, `online p95 ${on.p95} ms`);
    assert.ok(off.p95 < 50 * PERF_SLACK, `offline p95 ${off.p95} ms`);
    hosts[0].link.heal();
    hosts[0].nudge();
  } finally {
    await teardown();
  }
});

test("§10 remote edit visible to a collaborator: p95 under 300 ms (loopback and 40 ms RTT)", { timeout: 90_000 }, async () => {
  try {
    const { docId, hosts } = await scene([users[0], users[1]]);
    const [alice, bob] = hosts;
    for (const [label, latencyMs] of [
      ["loopback", 0],
      // 20 ms each way: a 40 ms round trip to the server, as in one region.
      ["40 ms RTT", 20],
    ] as const) {
      alice.link.set({ latencyMs, jitterMs: latencyMs / 2 });
      bob.link.set({ latencyMs, jitterMs: latencyMs / 2 });
      const { arrivals, stop } = watchArrivals([bob], docId);
      const typist = new MarkerTypist(() => alice.hub(docId), `vis${latencyMs}`);
      const typedAt = new Map<string, number>();
      for (let index = 0; index < 150; index += 1) {
        const marker = typist.type();
        typedAt.set(marker, performance.now());
        await sleep(15);
      }
      await waitUntil(() => typist.markers.every((marker) => arrivals.get(marker)?.has(bob.name)), "every edit to reach Bob", 30_000);
      stop();
      const delays = typist.markers.map((marker) => (arrivals.get(marker)?.get(bob.name) as number) - (typedAt.get(marker) as number));
      const summary = summarize(delays);
      report(`remote edit visible, ${label} (p50 / p95 / max)`, `${ms(summary.p50)} / ${ms(summary.p95)} / ${ms(summary.max)}`);
      assert.ok(summary.p95 < 300 * PERF_SLACK, `${label} p95 ${summary.p95} ms`);
    }
  } finally {
    await teardown();
  }
});

test("§10 cold open of a 1 MB document from the host's SQLite: under 1.5 s", { timeout: 180_000 }, async () => {
  try {
    const { docId, projectId, hosts } = await scene([users[0], users[1]]);
    const writer = hosts[0];
    const hub = writer.hub(docId);
    // 1 MB (UTF-8) built from about 1,600 edits spread over the document,
    // like a long-lived file rather than one paste.
    const line = `${"Lorem ipsum dolor sit amet, tiếng Việt có dấu, 日本語, emoji 🚀. ".repeat(8)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    const target = 1024 * 1024;
    let edits = 0;
    while (edits * lineBytes < target) {
      hub.applyLocalChange("content", (doc) => {
        // Every line has the same length, so a multiple of it is a line start
        // (never inside a surrogate pair).
        const lineIndex = Math.floor((edits + 1) * ((edits * 0.618) % 1));
        doc.getText(ContentKeys.source).insert(lineIndex * line.length, line);
      });
      edits += 1;
      if (edits % 50 === 0) await sleep(1);
    }
    const textBytes = Buffer.byteLength(hub.getText(), "utf8");
    await waitUntil(() => hub.pendingCount === 0, "the document to sync", 60_000);
    report("cold open: document size", `${(textBytes / 1024 / 1024).toFixed(2)} MB UTF-8, ${hub.getText().length} UTF-16 units, ${edits} edits`);

    // Offline, so the open is purely local: SQLite to Y.Doc to text.
    writer.link.partition();
    await writer.host.stop();
    const reopen = async (compaction: boolean): Promise<{ openMs: number; length: number }> => {
      const started = performance.now();
      const reopened = await cluster.addHost(users[0], {
        dbPath: writer.dbPath,
        installationId: writer.installationId,
        link: writer.link,
        compaction: compaction ? { mode: "worker" } : false,
      });
      const reopenedHub = reopened.open(docId, projectId);
      const length = reopenedHub.getText().length;
      const openMs = performance.now() - started;
      if (compaction) await reopenedHub.compactNow();
      await cluster.removeHost(reopened, { keepLink: true });
      return { openMs, length };
    };
    const fromLog = await reopen(true);
    // The first reopen compacted: the second loads a snapshot plus an empty tail.
    const fromSnapshot = await reopen(false);
    report("cold open 1 MB from the update log", ms(fromLog.openMs));
    report("cold open 1 MB from a snapshot", ms(fromSnapshot.openMs));
    assert.equal(fromLog.length, hub.getText().length);
    assert.equal(fromSnapshot.length, hub.getText().length);
    assert.ok(fromLog.openMs < 1500 * PERF_SLACK, `log cold open ${fromLog.openMs} ms`);
    assert.ok(fromSnapshot.openMs < 1500 * PERF_SLACK, `snapshot cold open ${fromSnapshot.openMs} ms`);

    // A fresh machine opening the same document from the server.
    writer.link.heal();
    const fresh = await cluster.addHost(users[1]);
    const started = performance.now();
    const freshHub = fresh.open(docId, projectId);
    await waitUntil(() => freshHub.getText().length === hub.getText().length, "a fresh host to load 1 MB from the server", 60_000);
    report("first open 1 MB from the server (empty host)", ms(performance.now() - started));
  } finally {
    await teardown();
  }
});

test("§10 resync after 1 h offline with 2,000 local edits: under 2 s", { timeout: 120_000 }, async () => {
  try {
    const { docId, hosts } = await scene([users[0], users[1]]);
    const [alice, bob] = hosts;
    const hubA = alice.hub(docId);
    alice.link.partition();
    await waitUntil(() => hubA.getStatus().state === "offline", "offline");
    const typist = new RandomTypist({ seed: 3600, weights: { paste: 1 } });
    for (let index = 0; index < 2000; index += 1) typist.step(hubA);
    const bobTypist = new RandomTypist({ seed: 3601, weights: { paste: 0 } });
    for (let index = 0; index < 200; index += 1) bobTypist.step(bob.hub(docId));
    await waitUntil(() => bob.hub(docId).pendingCount === 0, "Bob to sync");
    // An attempt made during the partition can be stuck in "connecting" (durability todo); not part of the resync.
    await waitUntil(() => alice.connectionState !== "connecting", "no stuck connection attempt", 30_000);
    alice.link.heal();
    const started = performance.now();
    alice.nudge();
    await waitUntil(() => hubA.pendingCount === 0 && hubA.getText() === bob.hub(docId).getText(), "resync", 30_000, 2);
    const resyncMs = performance.now() - started;
    report("resync after offline, 2,000 local + 200 remote edits", ms(resyncMs));
    assert.ok(resyncMs < 2000 * PERF_SLACK, `resync ${resyncMs} ms`);
    await cluster.awaitConvergence(docId, hosts);
  } finally {
    await teardown();
  }
});

test("§10 paste of 1 MB: the host's event loop is never blocked long", { timeout: 120_000 }, async () => {
  try {
    const { docId, hosts } = await scene([users[0], users[1]]);
    const [alice, bob] = hosts;
    const paste = "Pasted paragraph with tiếng Việt and 🚀 emoji.\n".repeat(Math.ceil((1024 * 1024) / 48));
    const loop = monitorEventLoopDelay({ resolution: 2 });
    loop.enable();
    const started = performance.now();
    alice.hub(docId).applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, paste), { source: "paste" });
    const commitMs = performance.now() - started;
    await waitUntil(() => bob.hub(docId).getText().length === paste.length, "Bob to receive the paste", 60_000);
    const syncedMs = performance.now() - started;
    loop.disable();
    report("paste 1 MB: applyLocalChange (apply + SQLite commit)", ms(commitMs));
    report("paste 1 MB: visible on the other host", ms(syncedMs));
    report("paste 1 MB: event loop delay max during paste and sync", ms(loop.max / 1e6));
    // The renderer budget (no freeze over 100 ms) is not measured here; the
    // host must not block its own loop for long either.
    assert.ok(commitMs < 100 * PERF_SLACK, `paste commit ${commitMs} ms`);
  } finally {
    await teardown();
  }
});

test(`§10 ${HOSTS_ON_ONE_DOC} active collaborators on one doc: the budgets above still hold`, { timeout: 300_000 }, async () => {
  const collaborators: Collaborator[] = [];
  try {
    const members = users.slice(0, HOSTS_ON_ONE_DOC);
    const [owner, ...others] = members;
    const projectId = await cluster.createProject(owner);
    for (const user of others) await cluster.addMember(projectId, owner, user);
    const docId = await cluster.createDoc(projectId, owner);
    const durationMs = HEAVY ? 60_000 : 6000;
    collaborators.push(
      ...(await Promise.all(
        members.map((user, index) =>
          cluster.spawnCollaborator(user, { docId, projectId, tag: `c${index}`, editsPerSecond: 2, durationMs, seed: 500 + index }),
        ),
      )),
    );
    for (const collaborator of collaborators) collaborator.go();
    await waitUntil(() => collaborators.every((collaborator) => collaborator.typingDone), "typing to finish", durationMs + 30_000, 50);
    const typed = new Map<string, { at: number; commitMs: number; by: Collaborator }>();
    for (const collaborator of collaborators) for (const [marker, info] of collaborator.typed) typed.set(marker, { ...info, by: collaborator });
    await waitUntil(
      () =>
        [...typed].every(([marker, info]) => collaborators.every((collaborator) => collaborator === info.by || collaborator.received.has(marker))),
      "every edit to reach every other collaborator",
      60_000,
      50,
    );
    const delays: number[] = [];
    for (const [marker, info] of typed) {
      for (const collaborator of collaborators) if (collaborator !== info.by) delays.push((collaborator.received.get(marker) as number) - info.at);
    }
    const visible = summarize(delays);
    const local = summarize([...typed.values()].map((info) => info.commitMs));
    report(`${HOSTS_ON_ONE_DOC} collaborators (one process each): edits typed`, `${typed.size} in ${durationMs / 1000} s`);
    report(`${HOSTS_ON_ONE_DOC} collaborators: local commit (p50 / p95)`, `${ms(local.p50)} / ${ms(local.p95)}`);
    report(`${HOSTS_ON_ONE_DOC} collaborators: remote visible (p50 / p95 / max)`, `${ms(visible.p50)} / ${ms(visible.p95)} / ${ms(visible.max)}`);
    assert.ok(local.p95 < 50 * PERF_SLACK, `local p95 ${local.p95} ms`);
    assert.ok(visible.p95 < 300 * PERF_SLACK, `remote p95 ${visible.p95} ms`);

    // Everyone converges, and agrees with the server.
    await waitUntil(
      () =>
        collaborators.every(
          (collaborator) => collaborator.digest !== null && collaborator.digest.pending === 0 && collaborator.digest.hash === collaborators[0].digest?.hash,
        ),
      "every collaborator to hold the same text",
      60_000,
      50,
    );
    const server = await cluster.readServer(docId, owner);
    assert.equal(createHash("sha256").update(server.text).digest("hex"), collaborators[0].digest?.hash, "the server holds the same text");
    const { missing, duplicated } = checkMarkers(server.text, typed.keys());
    assert.deepEqual(missing, []);
    assert.deepEqual(duplicated, []);
  } finally {
    await Promise.all(collaborators.map((collaborator) => collaborator.stop()));
  }
});
