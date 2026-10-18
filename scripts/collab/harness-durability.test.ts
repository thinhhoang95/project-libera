// Durability matrix: one test per row of source-plan §3.2, with real hosts
// against the real server through the chaos proxy (plan M1.7 "done when").
//
// Each test states the required behaviour of its row and asserts it. Rows
// that need a different server configuration (token TTL) run their own
// cluster; the rest share one server with fresh projects and docs per test.

import assert from "node:assert/strict";
import { monitorEventLoopDelay } from "node:perf_hooks";
import path from "node:path";
import test, { after, before } from "node:test";

import type { UpdateRecord, UpdatesPage } from "../../src/lib/collab/protocol/api";
import { ApiRoutes } from "../../src/lib/collab/protocol/api";
import { Cluster, sleep, uniqueId, waitUntil, type HarnessHost, type HarnessUser, type HostOptions } from "./harness/cluster";
import { ackedMarkers, checkMarkers, committedMarkers, markersIn, markersInUpdate } from "./harness/markers";
import { HEAVY, PERF_SLACK, ms, percentile, report } from "./harness/stats";
import { MarkerTypist, RandomTypist, appendMarker, seededRandom } from "./harness/typist";

let cluster: Cluster;
let users: HarnessUser[];

before(async () => {
  cluster = await Cluster.start();
  users = [];
  for (const name of ["Alice", "Bob", "Carol"]) users.push(await cluster.registerUser(name));
});

after(async () => {
  await cluster?.stop();
});

interface Scene {
  projectId: string;
  docId: string;
  hosts: HarnessHost[];
}

/** A project owned by the first user, every listed user an editor, one doc open on one host per user. */
async function scene(members: HarnessUser[], options: HostOptions = {}, target: Cluster = cluster): Promise<Scene> {
  const [owner, ...others] = members;
  const projectId = await target.createProject(owner);
  for (const user of others) await target.addMember(projectId, owner, user);
  const docId = await target.createDoc(projectId, owner);
  const hosts: HarnessHost[] = [];
  for (const user of members) {
    const host = await target.addHost(user, options);
    host.open(docId, projectId);
    hosts.push(host);
  }
  await waitUntil(() => hosts.every((host) => host.hub(docId).getStatus().state === "saved-remote"), "hosts to open the doc");
  return { projectId, docId, hosts };
}

async function teardown(target: Cluster = cluster): Promise<void> {
  for (const host of [...target.hosts]) await target.removeHost(host);
}

function assertMarkersOnce(text: string, expected: Iterable<string>, label: string): void {
  const { missing, duplicated } = checkMarkers(text, expected);
  assert.deepEqual(missing, [], `${label}: missing edits`);
  assert.deepEqual(duplicated, [], `${label}: duplicated edits`);
}

function sawEvent(host: HarnessHost, type: string): boolean {
  return host.events.some((event) => event.source === "sync" && event.event.type === type);
}

// ---------------------------------------------------------------- high latency

test("§3.2 high latency: local typing is unaffected, remote edits arrive later, nothing is lost", { timeout: 90_000 }, async () => {
  try {
    const { docId, hosts } = await scene([users[0], users[1]]);
    const [alice, bob] = hosts;
    // 400 ms each way: an 800 ms round trip.
    alice.link.set({ latencyMs: 400, jitterMs: 40 });
    bob.link.set({ latencyMs: 400, jitterMs: 40 });
    const hubA = alice.hub(docId);
    const hubB = bob.hub(docId);

    const typedAt = new Map<string, number>();
    const arrivedAt = new Map<string, number>();
    const off = hubB.observe("content", () => {
      for (const marker of markersIn(hubB.getText())) if (!arrivedAt.has(marker)) arrivedAt.set(marker, performance.now());
    });
    const loop = monitorEventLoopDelay({ resolution: 5 });
    loop.enable();

    const commitMs: number[] = [];
    let firstStatusMs = Number.NaN;
    const markers: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const marker = `<lat:${index}>`;
      let statusAt: number | null = null;
      const offStatus = hubA.onStatus(() => (statusAt ??= performance.now()));
      const started = performance.now();
      appendMarker(hubA, `${marker}\n`);
      const committed = performance.now();
      offStatus();
      typedAt.set(marker, started);
      markers.push(marker);
      commitMs.push(committed - started);
      if (index === 0) firstStatusMs = (statusAt ?? Number.POSITIVE_INFINITY) - started;
      // Saved on this device means: in SQLite when applyLocalChange returns.
      const status = hubA.getStatus();
      assert.ok(status.state === "saved-local" || status.state === "syncing", `state after a local edit: ${status.state}`);
      assert.ok(status.pending >= 1, "the edit counts as pending");
      assert.ok(
        alice.host.store.unackedUpdates(docId).some((row) => markersInUpdate(row.update).includes(marker)),
        "the edit is in SQLite before applyLocalChange returns",
      );
      await sleep(15);
    }
    await waitUntil(() => markers.every((marker) => arrivedAt.has(marker)), "Bob to receive every edit", 30_000);
    loop.disable();
    off();

    const arrival = markers.map((marker) => (arrivedAt.get(marker) as number) - (typedAt.get(marker) as number));
    report("high latency: local commit p95 (800 ms RTT)", ms(percentile(commitMs, 95)));
    report("high latency: first status emit after an edit", ms(firstStatusMs));
    report("high latency: remote arrival min / p95", `${ms(Math.min(...arrival))} / ${ms(percentile(arrival, 95))}`);
    report("high latency: event loop delay max", ms(loop.max / 1e6));
    assert.ok(percentile(commitMs, 95) < 50, `local commit p95 ${percentile(commitMs, 95)} ms must stay under 50 ms`);
    assert.ok(firstStatusMs < 50, `the status changes ${firstStatusMs} ms after the edit, budget 50 ms`);
    // One way to the server and one way back to Bob: at least 2 × 400 ms.
    assert.ok(Math.min(...arrival) >= 750, `remote edits arrive later (min ${Math.min(...arrival)} ms)`);
    assert.ok(loop.max / 1e6 < 250, `no jank: event loop delay max ${loop.max / 1e6} ms`);

    alice.link.clear();
    bob.link.clear();
    const { text } = await cluster.awaitConvergence(docId, hosts);
    assertMarkersOnce(text, markers, "after high latency");
  } finally {
    await teardown();
  }
});

// ---------------------------------------------------------------- temporary disconnect

test("§3.2 temporary disconnect: editing continues, the queue grows, status shows the offline count, then drains", { timeout: 90_000 }, async () => {
  try {
    const { docId, hosts } = await scene([users[0], users[1]]);
    const [alice, bob] = hosts;
    const hubA = alice.hub(docId);
    alice.link.partition();
    await waitUntil(() => hubA.getStatus().state === "offline", "Alice to show offline");

    const typistA = new MarkerTypist(() => hubA, "offA");
    for (let count = 1; count <= 20; count += 1) {
      typistA.type();
      const status = hubA.getStatus();
      assert.equal(status.state, "offline");
      assert.equal(status.pending, count, "the queue grows by one per edit");
      assert.equal(status.detail, `Offline — ${count} changes on this device.`);
    }
    assert.equal(alice.host.store.unackedUpdates(docId).length, 20, "every offline edit is in SQLite");

    // Bob is unaffected and syncs while Alice is away.
    const typistB = new MarkerTypist(() => bob.hub(docId), "onB");
    for (let index = 0; index < 5; index += 1) typistB.type();
    await waitUntil(() => bob.hub(docId).getStatus().state === "saved-remote", "Bob to stay in sync");
    const during = await cluster.readServer(docId);
    assert.deepEqual(checkMarkers(during.text, typistA.markers).missing.length, 20, "the server has none of Alice's offline edits yet");

    // Heal without a nudge: the backoff timer alone reconnects and drains the queue.
    alice.link.heal();
    await waitUntil(() => hubA.pendingCount === 0, "Alice's queue to drain", 40_000);
    const { text } = await cluster.awaitConvergence(docId, hosts);
    assertMarkersOnce(text, [...typistA.markers, ...typistB.markers], "after reconnect");
  } finally {
    await teardown();
  }
});

// ---------------------------------------------------------------- sleep / network switch

test("§3.2 laptop sleep: nudge() on resume reconnects within ~2 s instead of waiting for the backoff tick", { timeout: 90_000 }, async () => {
  try {
    // A slow backoff (about 18 s for the first retry) makes "waited for the tick" obvious.
    const { docId, hosts } = await scene([users[0], users[1]], { limits: { backoffBaseMs: 20_000, backoffMaxMs: 30_000 }, random: () => 0.9 });
    const [alice] = hosts;
    const hubA = alice.hub(docId);
    alice.link.partition();
    await waitUntil(() => alice.connectionState === "backoff", "Alice to back off");
    const typist = new MarkerTypist(() => hubA, "sleep");
    for (let index = 0; index < 3; index += 1) typist.type();

    // The network is back, but nothing tells the host: it keeps waiting.
    alice.link.heal();
    await sleep(1000);
    assert.equal(alice.connectionState, "backoff", "without a nudge the host still waits for its backoff timer");

    const started = performance.now();
    alice.nudge();
    await waitUntil(() => alice.connectionState === "connected", "Alice to reconnect after the nudge", 10_000);
    const reconnectMs = performance.now() - started;
    report("sleep/resume: nudge to connected", ms(reconnectMs));
    assert.ok(reconnectMs < 2000, `reconnected ${reconnectMs} ms after resume, budget ~2 s`);
    await waitUntil(() => hubA.pendingCount === 0, "the edits made before sleep to sync", 10_000);
    const { text } = await cluster.awaitConvergence(docId, hosts);
    assertMarkersOnce(text, typist.markers, "after resume");
  } finally {
    await teardown();
  }
});

test(
  "§3.2 network switch: nudge() replaces a socket that silently died within ~2 s",
  {
    timeout: 90_000,
    todo:
      "SyncClient.nudge() on a 'connected' socket sends a ping and only drops the socket after nudgePongTimeoutMs " +
      "(5000 ms default), and CollabHostOptions cannot set that timeout. After a network switch the old socket is " +
      "silently dead, so the host reconnects about 5.5 s after resume, not within the ~2 s of source-plan §3.2.",
  },
  async () => {
    try {
      const { docId, hosts } = await scene([users[0], users[1]]);
      const [alice] = hosts;
      const hubA = alice.hub(docId);
      const connectionsBefore = alice.link.stats.connections;
      // The old Wi-Fi is gone: the open socket forwards nothing, new sockets work.
      alice.link.killSilently();
      const typist = new MarkerTypist(() => hubA, "switch");
      typist.type();
      const started = performance.now();
      alice.nudge();
      await waitUntil(
        () => alice.link.stats.connections > connectionsBefore && alice.connectionState === "connected" && hubA.pendingCount === 0,
        "Alice to reconnect on the new network and sync",
        8000,
      ).catch(() => undefined);
      const reconnectMs = performance.now() - started;
      report("network switch: nudge to synced on a new socket", ms(reconnectMs));
      assert.ok(reconnectMs < 2500, `synced ${reconnectMs} ms after the network switch, budget ~2 s`);
    } finally {
      await teardown();
    }
  },
);

test(
  "§3.2 server restart: a reconnect attempt refused while the server was down does not delay recovery",
  {
    timeout: 90_000,
    todo:
      "SyncClient assumes 'an error is always followed by close' (sync-client.ts connect()). With Node's built-in " +
      "WebSocket (undici 6.21, Node 22.17; Electron's main process uses the same), a handshake that fails with " +
      "ECONNREFUSED or a reset fires onerror (or nothing) but never onclose, and readyState stays CONNECTING. The " +
      "client stays 'connecting' until connectTimeoutMs (15 s) and nudge() is a no-op while connecting, so after a " +
      "server restart or a brief partition, hosts resync ~15 s late instead of on the next backoff tick or nudge.",
  },
  async () => {
    try {
      const { docId, hosts } = await scene([users[0], users[1]]);
      const [alice] = hosts;
      const hubA = alice.hub(docId);
      await cluster.stopServer("kill");
      // The first retry (backoff below 500 ms) hits a closed port.
      await sleep(1500);
      const typist = new MarkerTypist(() => hubA, "refused");
      typist.type();
      await cluster.startServer();
      const started = performance.now();
      alice.nudge();
      await waitUntil(() => alice.connectionState === "connected" && hubA.pendingCount === 0, "Alice to resync", 20_000).catch(
        () => undefined,
      );
      const elapsed = performance.now() - started;
      report("refused reconnect: server back to synced", ms(elapsed));
      assert.ok(elapsed < 2000, `resynced ${elapsed} ms after the server came back`);
    } finally {
      await teardown();
    }
  },
);

// ---------------------------------------------------------------- long offline

test("§3.2 reconnect after long offline: 2,000 offline edits resync with only the missing diff", { timeout: 120_000 }, async () => {
  try {
    const { docId, hosts } = await scene([users[0], users[1]]);
    const [alice, bob] = hosts;
    const hubA = alice.hub(docId);
    const hubB = bob.hub(docId);
    alice.link.partition();
    await waitUntil(() => hubA.getStatus().state === "offline", "Alice to go offline");

    const edits = HEAVY ? 10_000 : 2000;
    // Mostly typing, some deletes and replaces, as in a writing session.
    const typist = new RandomTypist({ seed: 2000, weights: { paste: 0, delete: 5, replace: 5 } });
    const markers = new MarkerTypist(() => hubA, "long");
    for (let index = 0; index < edits; index += 1) {
      if (index % 10 === 0) markers.type();
      else typist.step(hubA);
    }
    assert.equal(hubA.pendingCount, edits, "every offline edit is queued");
    // Random deletes may remove some of Alice's own markers; the rest must all arrive.
    const survivingA = markersIn(hubA.getText());
    assert.ok(survivingA.length >= edits / 40, `enough markers survive Alice's own deletes (${survivingA.length})`);
    // Bob keeps working while Alice is away, so Alice must also receive a diff.
    const typistB = new MarkerTypist(() => hubB, "away");
    for (let index = 0; index < 50; index += 1) typistB.type();
    await waitUntil(() => hubB.pendingCount === 0, "Bob to sync");
    const bytesBefore = alice.link.stats.bytesDown;
    // A reconnect attempt made during the partition can sit in "connecting"
    // for connectTimeoutMs (see the "refused connection" todo below), and
    // nudge() ignores a host that is connecting. Wait it out so this test
    // measures the resync itself.
    await waitUntil(() => alice.connectionState !== "connecting", "Alice to leave a stuck connection attempt", 30_000);

    alice.link.heal();
    const started = performance.now();
    alice.nudge();
    await waitUntil(
      () => hubA.pendingCount === 0 && hubA.getText() === hubB.getText(),
      "Alice and Bob to agree after resync",
      30_000,
      2,
    );
    const resyncMs = performance.now() - started;
    report(`long offline: resync of ${edits} edits (nudge to acked and converged)`, ms(resyncMs));
    // Only the missing diff comes down: Bob's 50 short lines, not the whole document.
    const downloaded = alice.link.stats.bytesDown - bytesBefore;
    report("long offline: bytes received during resync", `${downloaded} B for a ${hubB.getText().length}-char doc`);
    assert.ok(downloaded < 64 * 1024, `resync downloaded ${downloaded} bytes`);
    assert.ok(resyncMs < 2000 * PERF_SLACK, `resync took ${resyncMs} ms (budget 2000 ms × slack ${PERF_SLACK})`);
    const { text } = await cluster.awaitConvergence(docId, hosts);
    assertMarkersOnce(text, [...survivingA, ...typistB.markers], "after long offline");
  } finally {
    await teardown();
  }
});

// ---------------------------------------------------------------- app crash

test("§3.2 app crash: a host killed mid-typing recovers every committed edit and syncs it", { timeout: 120_000 }, async () => {
  try {
    const [owner, member] = users;
    const projectId = await cluster.createProject(owner);
    await cluster.addMember(projectId, owner, member);
    const docId = await cluster.createDoc(projectId, owner);
    const observer = await cluster.addHost(owner);
    observer.open(docId, projectId);

    const rounds = HEAVY ? 5 : 2;
    const link = await cluster.proxy.addLink(uniqueId("crash"));
    const dbPath = path.join(cluster.dir, `${uniqueId("crash")}.sqlite`);
    const installationId = uniqueId("inst_crash");
    const committed: string[] = [];
    const random = seededRandom(Date.now() & 0xffff);
    for (let round = 0; round < rounds; round += 1) {
      const child = await cluster.spawnChildHost(member, {
        docId,
        projectId,
        tag: "crash",
        dbPath,
        installationId,
        link,
        intervalMs: 3,
        startIndex: round * 1_000_000,
      });
      await child.waitForCommitted(30);
      await sleep(50 + Math.floor(random() * 400));
      await child.kill();
      committed.push(...child.committed);
    }
    assert.ok(committed.length >= 30 * rounds);

    // Relaunch offline first: the edits must come back from SQLite alone.
    link.partition();
    const restarted = await cluster.addHost(member, { dbPath, installationId, link });
    const hub = restarted.open(docId, projectId);
    assertMarkersOnce(hub.getText(), committed, "recovered from SQLite");

    link.heal();
    restarted.nudge();
    const { text } = await cluster.awaitConvergence(docId, [restarted, observer], { timeoutMs: 40_000 });
    assertMarkersOnce(text, committed, "on the server after restart");
    report("app crash: committed edits recovered", `${committed.length} of ${committed.length} over ${rounds} kills`);
  } finally {
    await teardown();
  }
});

// ---------------------------------------------------------------- server crash

test("§3.2 server crash: acknowledged edits survive, unacknowledged ones are resent", { timeout: 120_000 }, async () => {
  try {
    const { docId, hosts } = await scene([users[0], users[1]]);
    const [alice, bob] = hosts;
    const typists = [new MarkerTypist(() => alice.hub(docId), "srvA"), new MarkerTypist(() => bob.hub(docId), "srvB")];
    for (const typist of typists) typist.start(4);
    await waitUntil(
      () => ackedMarkers(alice.host.store, docId).size > 20 && ackedMarkers(bob.host.store, docId).size > 20,
      "some acknowledged edits on both hosts",
      30_000,
      20,
    );
    await sleep(Math.floor(Math.random() * 300));
    await cluster.stopServer("kill");
    // Keep the hosts away until the restarted server has been read.
    alice.link.partition();
    bob.link.partition();
    await sleep(200);
    for (const typist of typists) typist.stop();

    const acked = new Set([...ackedMarkers(alice.host.store, docId), ...ackedMarkers(bob.host.store, docId)]);
    const all = typists.flatMap((typist) => typist.markers);
    const unacked = all.filter((marker) => !acked.has(marker));
    assert.ok(unacked.length > 0, "some edits were not acknowledged when the server died");

    await cluster.startServer();
    const recovered = await cluster.readServer(docId);
    assertMarkersOnce(recovered.text, acked, "acknowledged edits after the server crash");

    alice.link.heal();
    bob.link.heal();
    alice.nudge();
    bob.nudge();
    const { text } = await cluster.awaitConvergence(docId, hosts, { timeoutMs: 40_000 });
    assertMarkersOnce(text, all, "every edit after the resend");
    report("server crash: acked / resent edits", `${acked.size} acked survived, ${unacked.length} resent`);
  } finally {
    await teardown();
  }
});

// ---------------------------------------------------------------- token expiry

test("§3.2 token expiry: silent refresh; a failed refresh keeps local editing and asks for sign-in", { timeout: 120_000 }, async () => {
  // Tokens live 3 s here; the shared cluster keeps the default 15 minutes.
  const short = await Cluster.start({ serverEnv: { ACCESS_TOKEN_TTL_SECONDS: "3" } });
  try {
    const owner = await short.registerUser("Owner");
    const alice = await short.registerUser("Alice");
    const projectId = await short.createProject(owner);
    await short.addMember(projectId, owner, alice);
    const docId = await short.createDoc(projectId, owner);

    // Silent refresh: the token expires while the host is offline; on
    // reconnect the server says 4001 and the host refreshes by itself.
    const session = await short.login(alice);
    const host = await short.addHost(alice, { session });
    const hub = host.open(docId, projectId);
    await waitUntil(() => hub.getStatus().state === "saved-remote", "Alice to open the doc");
    host.link.partition();
    const typist = new MarkerTypist(() => hub, "ttl");
    for (let index = 0; index < 5; index += 1) typist.type();
    await sleep(4000);
    assert.ok(session.accessTokenExpiresAt < Date.now(), "the access token has expired");
    host.link.heal();
    host.nudge();
    await waitUntil(() => hub.pendingCount === 0, "the offline edits to sync after a silent refresh", 20_000);
    assert.ok(session.refreshCalls >= 1, "the host refreshed the token");
    assert.ok(!sawEvent(host, "needs-sign-in"), "the user was never asked to sign in");
    let state = await short.readServer(docId, owner);
    assertMarkersOnce(state.text, typist.markers, "after silent refresh");

    // Failed refresh: the session is signed out on the server while offline.
    host.link.partition();
    await short.logout(session);
    await sleep(4000);
    for (let index = 0; index < 3; index += 1) typist.type();
    host.link.heal();
    host.nudge();
    await waitUntil(() => host.connectionState === "needs-sign-in", "the host to ask for sign-in", 20_000);
    assert.ok(sawEvent(host, "needs-sign-in"));
    // Editing continues locally.
    for (let index = 0; index < 2; index += 1) typist.type();
    const status = hub.getStatus();
    assert.equal(status.state, "offline");
    assert.equal(status.pending, 5);
    assert.match(status.detail ?? "", /5 changes on this device\. Sign in to sync\./);
    assert.equal(host.host.store.unackedUpdates(docId).length, 5, "the edits are safe in SQLite");
    state = await short.readServer(docId, owner);
    assert.equal(checkMarkers(state.text, typist.markers.slice(5)).missing.length, 5, "nothing synced without a session");

    // Signing in again sends everything.
    host.signIn(await short.login(alice));
    await waitUntil(() => hub.pendingCount === 0, "the edits to sync after sign-in", 20_000);
    state = await short.readServer(docId, owner);
    assertMarkersOnce(state.text, typist.markers, "after signing in again");
  } finally {
    await short.stop();
  }
});

// ---------------------------------------------------------------- access revoked

test("§3.2 access revoked while online: the doc becomes read-only with local work kept", { timeout: 60_000 }, async () => {
  try {
    const [owner, member] = users;
    const { projectId, docId, hosts } = await scene([owner, member]);
    const hub = hosts[1].hub(docId);
    const typist = new MarkerTypist(() => hub, "rev");
    typist.type();
    await waitUntil(() => hub.pendingCount === 0, "the first edit to sync");
    await cluster.removeMember(projectId, owner, member);
    await waitUntil(() => hub.getStatus().state === "access-changed", "the member to see Access changed");
    assert.equal(hub.getMeta().readOnly, true);
    assert.equal(hub.getMeta().readOnlyReason, "access-revoked");
    assertMarkersOnce(hub.getText(), typist.markers, "local copy after revocation");
  } finally {
    await teardown();
  }
});

test("§3.2 access revoked while offline: local work is preserved and sync is refused", { timeout: 60_000 }, async () => {
  try {
    const [owner, member] = users;
    const { projectId, docId, hosts } = await scene([owner, member]);
    const [ownerHost, memberHost] = hosts;
    const hub = memberHost.hub(docId);
    memberHost.link.partition();
    await waitUntil(() => hub.getStatus().state === "offline", "the member to go offline");
    const typist = new MarkerTypist(() => hub, "offrev");
    for (let index = 0; index < 4; index += 1) typist.type();
    await cluster.removeMember(projectId, owner, member);

    memberHost.link.heal();
    memberHost.nudge();
    await waitUntil(() => memberHost.connectionState === "connected", "the member to reconnect");
    await sleep(1500);
    const server = await cluster.readServer(docId, owner);
    assert.equal(checkMarkers(server.text, typist.markers).missing.length, 4, "the server refused the revoked member's edits");
    assert.equal(checkMarkers(ownerHost.text(docId), typist.markers).missing.length, 4, "no other host received them");
    assertMarkersOnce(hub.getText(), typist.markers, "the member's local copy");
    assert.equal(memberHost.host.store.unackedUpdates(docId).length, 4, "the edits stay in SQLite for export");
  } finally {
    await teardown();
  }
});

test(
  "§3.2 access revoked while offline: on reconnect the doc shows Access changed and becomes read-only",
  {
    timeout: 60_000,
    todo:
      "When a member lost access while offline, the server answers the reconnect's `open` with closed{reason: " +
      "'not-found'} (session.ts open(): documentAccess() is null for a non-member), and DocHub.handleClosed treats " +
      "'not-found' as 'This document is not on the server.': the doc stays writable (readOnly false) with status " +
      "'offline'/'saved-local' instead of 'access-changed', unlike a revocation seen while online (closed " +
      "'access-revoked'). Either the server should send 'access-revoked'/'forbidden' for an existing doc the " +
      "account can no longer open, or the hub should treat not-found for a doc with server history as revoked.",
  },
  async () => {
    try {
      const [owner, member] = users;
      const { projectId, docId, hosts } = await scene([owner, member]);
      const memberHost = hosts[1];
      const hub = memberHost.hub(docId);
      memberHost.link.partition();
      await waitUntil(() => hub.getStatus().state === "offline", "the member to go offline");
      const typist = new MarkerTypist(() => hub, "offrev2");
      typist.type();
      await cluster.removeMember(projectId, owner, member);
      memberHost.link.heal();
      memberHost.nudge();
      await waitUntil(() => hub.getStatus().state === "access-changed", "Access changed after reconnect", 8000).catch(() => undefined);
      assert.equal(hub.getStatus().state, "access-changed");
      assert.equal(hub.getMeta().readOnly, true);
      assert.equal(hub.getMeta().readOnlyReason, "access-revoked");
    } finally {
      await teardown();
    }
  },
);

test("§3.2 access reduced to viewer while offline: edits are rejected, the rejected text stays available", { timeout: 60_000 }, async () => {
  try {
    const [owner, member] = users;
    const { projectId, docId, hosts } = await scene([owner, member]);
    const memberHost = hosts[1];
    const hub = memberHost.hub(docId);
    const base = new MarkerTypist(() => hub, "base");
    base.type();
    await waitUntil(() => hub.pendingCount === 0, "the first edit to sync");
    memberHost.link.partition();
    await waitUntil(() => hub.getStatus().state === "offline", "the member to go offline");
    const typist = new MarkerTypist(() => hub, "viewer");
    for (let index = 0; index < 3; index += 1) typist.type();
    await cluster.setRole(projectId, owner, member, "viewer");

    memberHost.link.heal();
    memberHost.nudge();
    await waitUntil(() => hub.getRejected("content").length > 0, "the offline edits to be rejected", 15_000);
    const [rejected] = hub.getRejected("content");
    assert.equal(rejected.reason, "forbidden");
    assertMarkersOnce(rejected.rejectedText, [...base.markers, ...typist.markers], "rejected text kept for export");
    await waitUntil(() => hub.getText() === base.markers.map((marker) => `${marker}\n`).join(""), "the doc to reload the server's state");
    assert.equal(hub.getMeta().readOnly, true);
    assert.equal(hub.getMeta().readOnlyReason, "role");
    assert.equal(hub.pendingCount, 0);
    const server = await cluster.readServer(docId, owner);
    assert.equal(checkMarkers(server.text, typist.markers).missing.length, 3, "the server has none of the rejected edits");
  } finally {
    await teardown();
  }
});

// ---------------------------------------------------------------- old client

test("§3.2 old client: below the minimum protocol the host stops syncing (update required) and keeps local edits", { timeout: 120_000 }, async () => {
  try {
    const { docId, hosts } = await scene([users[0], users[1]]);
    const [alice] = hosts;
    const hub = alice.hub(docId);
    const typist = new MarkerTypist(() => hub, "old");
    typist.type();
    await waitUntil(() => hub.pendingCount === 0, "the first edit to sync");

    // A server deploy raises the minimum protocol above this client's.
    await cluster.restartServer({ mode: "graceful", env: { MIN_PROTOCOL_VERSION: "2" } });
    for (const host of hosts) host.nudge();
    await waitUntil(() => alice.connectionState === "update-required", "the host to require an update", 20_000);
    assert.ok(sawEvent(alice, "update-required"));
    for (let index = 0; index < 3; index += 1) typist.type();
    const status = hub.getStatus();
    assert.equal(status.state, "offline");
    assert.equal(status.pending, 3);
    assert.match(status.detail ?? "", /Update Libera to keep syncing\./);
    assert.equal(alice.host.store.unackedUpdates(docId).length, 3, "local edits are kept");
    // It does not keep knocking: nudges and time do not reconnect an outdated client.
    const connections = alice.link.stats.connections;
    alice.nudge();
    await sleep(1500);
    assert.equal(alice.connectionState, "update-required");
    assert.equal(alice.link.stats.connections, connections, "no reconnect attempts while update is required");

    // The minimum goes back down (as if the app was updated): the edits sync.
    await cluster.restartServer({ mode: "graceful", env: { MIN_PROTOCOL_VERSION: "1" } });
    for (const host of hosts) await host.restart();
    const { text } = await cluster.awaitConvergence(docId, hosts, { timeoutMs: 30_000 });
    assertMarkersOnce(text, typist.markers, "after the update");
  } finally {
    await teardown();
  }
});

// ---------------------------------------------------------------- duplicate / reordered delivery

test("§3.2 duplicate and reordered delivery: no duplicated or lost text", { timeout: 120_000 }, async () => {
  try {
    const { docId, hosts } = await scene([users[0], users[1], users[2]]);
    for (const host of hosts) host.link.set({ duplicateRate: 0.5, reorderRate: 0.3, latencyMs: 3, jitterMs: 6 });
    const random = seededRandom(77);
    const typists = hosts.map((host, index) => new MarkerTypist(() => host.hub(docId), `dup${index}`, "random", random));
    for (const typist of typists) typist.start(12);
    await sleep(HEAVY ? 10_000 : 2500);
    for (const typist of typists) typist.stop();
    const duplicated = hosts.reduce((sum, host) => sum + host.link.stats.duplicatedFrames, 0);
    const reordered = hosts.reduce((sum, host) => sum + host.link.stats.reorderedFrames, 0);
    assert.ok(duplicated > 20, `frames were duplicated (${duplicated})`);
    assert.ok(reordered > 5, `frames were reordered (${reordered})`);
    for (const host of hosts) host.link.clear();
    const { text } = await cluster.awaitConvergence(docId, hosts);
    assertMarkersOnce(text, typists.flatMap((typist) => typist.markers), "with duplicates and reordering");
    report("duplicate/reorder: frames duplicated / reordered", `${duplicated} / ${reordered}`);

    // An explicit resend of an identical batch: the server persists the
    // update, the ack is held back, the socket resets, and the host sends
    // the same clientSeq and bytes again on the next connection.
    const [alice] = hosts;
    const hub = alice.hub(docId);
    alice.link.stall(undefined, "down");
    const resent = new MarkerTypist(() => hub, "resend");
    resent.type();
    await hub.flushOutbound();
    const [batch] = hub.pendingBatches();
    assert.ok(batch, "the edit is in a sent batch");
    await sleep(300);
    // Reset first: the held acks are discarded with the connection.
    alice.link.reset();
    alice.link.heal();
    alice.nudge();
    await waitUntil(() => hub.pendingCount === 0, "the resent batch to be acknowledged", 15_000);
    const records: UpdateRecord[] = [];
    for (let fromSeq: number | null = 1; fromSeq !== null; ) {
      const page: { status: number; body: UpdatesPage } = await cluster.api<UpdatesPage>(
        `${ApiRoutes.documentUpdates(docId)}?fromSeq=${fromSeq}&limit=1000`,
        { token: await cluster.token(users[0]) },
      );
      assert.equal(page.status, 200);
      records.push(...page.body.updates);
      fromSeq = page.body.nextFromSeq;
    }
    const keys = records.map((update) => `${update.clientId}:${update.update}`);
    assert.equal(new Set(keys).size, keys.length, "the server log holds no update twice");
    const final = await cluster.awaitConvergence(docId, hosts);
    assertMarkersOnce(final.text, [...typists.flatMap((typist) => typist.markers), ...resent.markers], "after an identical resend");
  } finally {
    await teardown();
  }
});

// ---------------------------------------------------------------- committed vs typed

test("harness self-check: committed markers in SQLite match what the typist recorded", { timeout: 30_000 }, async () => {
  try {
    const { docId, hosts } = await scene([users[0]]);
    const hub = hosts[0].hub(docId);
    const typist = new MarkerTypist(() => hub, "self");
    for (let index = 0; index < 10; index += 1) typist.type();
    assert.deepEqual([...committedMarkers(hosts[0].host.store, docId)].sort(), [...typist.markers].sort());
  } finally {
    await teardown();
  }
});
