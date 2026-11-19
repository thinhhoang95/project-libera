// Audit 2026-11-19, writer leases: finding 31 (renewal never waits behind
// discovery or another project's lifecycle work; the disk guard re-checks
// lease eligibility after its marker read) and finding 40 (a refused follower
// contests near the holder's expiry; discovery has its own, slower cadence
// that scales with battery).

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import type { FetchLike } from "../../electron/collab/core";
import { ControlRoutes } from "../../src/lib/collab/local-api";
import { closePeer, makePeer, register, sleep, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

const LEASE_TTL_MS = 900;

interface Handle {
  writer: boolean;
  leaseDeadline?: number;
  nextContestAt?: number;
  runtime: unknown;
}
interface Internals {
  projects: Map<string, Handle>;
  lease(handle: Handle): Promise<{ outcome: string }>;
  checkLease(handle: Handle, renewed?: unknown): Promise<void>;
  adoptMarkers(): Promise<void>;
  loadStoredProjects(): Promise<void>;
  powerChanged(onBattery: boolean): void;
  resumed(): void;
}
const internals = (peer: Peer) => peer.service as unknown as Internals;

test("writer lease audit fixes", { timeout: 240_000 }, async (t) => {
  const temp = tempRoot("libera-audit-1119-leases-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const auth = await register(server, "Alice");
    const leaseCalls = new Map<string, number>();
    // "refuse": answers lease claims like a server whose lease is held by another installation.
    let mode: "plain" | "refuse" | "refuse-no-duration" = "plain";
    const fetchLike: FetchLike = async (url, init) => {
      if (!url.includes("/folder-lease") || init?.method !== "POST") return fetch(url, init);
      const projectId = /projects\/([^/]+)\/folder-lease/.exec(url)?.[1] ?? "";
      leaseCalls.set(projectId, (leaseCalls.get(projectId) ?? 0) + 1);
      if (mode === "plain") return fetch(url, init);
      const body = { folderId: "x", holder: "inst_other", granted: false, contended: true, expiresAt: new Date(Date.now() + 5000).toISOString(), ...(mode === "refuse" ? { retryAfterMs: 5000 } : {}) };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    const alice = await makePeer(temp.dir, "alice", server, auth, { leaseTtlMs: LEASE_TTL_MS, fetch: fetchLike });
    peers.push(alice);
    const share = async (name: string) => {
      writeTree(path.join(alice.library, name), { "note.md": `${name}\n` });
      const shared = await alice.router.call("POST", ControlRoutes.share, { notebook: name });
      assert.equal(shared.status, 200, JSON.stringify(shared.body));
      const { projectId } = shared.body as { projectId: string };
      await alice.service.project(projectId)?.whenIdle();
      return projectId;
    };
    const one = await share("One");
    const two = await share("Two");
    const service = internals(alice);
    const calls = (id: string) => leaseCalls.get(id) ?? 0;

    await t.test("31: discovery stuck on a slow provider does not hold up renewal", async () => {
      const real = service.adoptMarkers.bind(service);
      let release!: () => void;
      const stuck = new Promise<void>((resolve) => { release = resolve; });
      service.adoptMarkers = () => stuck;
      try {
        // Whatever calls adoptMarkers (the old tick, or the discovery timer), renewal goes on.
        const beforeOne = calls(one);
        const beforeTwo = calls(two);
        await until(() => calls(one) >= beforeOne + 4 && calls(two) >= beforeTwo + 4, "renewals while discovery is stuck", 10_000);
        assert.equal(alice.service.project(one)?.follower, false, "the writer was not demoted");
      } finally {
        service.adoptMarkers = real;
        release();
      }
    });

    await t.test("31: one project's stuck lifecycle check does not hold up another project's renewal", async () => {
      const real = service.checkLease.bind(service);
      const handleOne = service.projects.get(one)!;
      let release!: () => void;
      const stuck = new Promise<void>((resolve) => { release = resolve; });
      service.checkLease = (handle, renewed) => (handle === handleOne ? stuck : real(handle, renewed));
      try {
        await sleep(100);
        const beforeTwo = calls(two);
        await until(() => calls(two) >= beforeTwo + 4, "the other project to keep renewing", 10_000);
        assert.ok((service.projects.get(two)!.leaseDeadline ?? 0) > performance.now(), "its lease is live");
      } finally {
        service.checkLease = real;
        release();
      }
    });

    await t.test("31: the disk guard re-checks lease eligibility after reading the marker", async () => {
      await until(() => alice.service.project(one) !== null && !alice.service.project(one)!.follower, "a writing runtime");
      const runtime = alice.service.project(one)! as unknown as { diskGuard(): { canCommit(): Promise<boolean> }; rootAvailable(): Promise<boolean> };
      const handle = service.projects.get(one)!;
      const realAvailable = runtime.rootAvailable.bind(runtime);
      assert.equal(await runtime.diskGuard().canCommit(), true, "an eligible writer commits");
      // The lease runs out while the (slow) marker read is in flight.
      runtime.rootAvailable = async () => {
        await sleep(20);
        handle.leaseDeadline = 0;
        return true;
      };
      try {
        assert.equal(await runtime.diskGuard().canCommit(), false);
      } finally {
        runtime.rootAvailable = realAvailable;
      }
    });

    await t.test("40: a refused follower contests near the holder's expiry, not on every tick", async () => {
      const handle = service.projects.get(two)!;
      const original = handle.writer;
      handle.writer = false;
      handle.nextContestAt = 0;
      mode = "refuse";
      try {
        const before = calls(two);
        assert.equal((await service.lease(handle)).outcome, "refused");
        const delay = (handle.nextContestAt ?? 0) - performance.now();
        // The server said 5 s left, the lease is 0.9 s: never later than one lifetime plus jitter.
        assert.ok(delay > 500 && delay <= LEASE_TTL_MS + 400, `next contest in ${delay} ms`);
        for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await service.lease(handle)).outcome, "refused");
        assert.equal(calls(two), before + 1, "later checks inside the window do not call the server");
        // A wake from sleep contests at once.
        service.resumed();
        assert.equal(handle.nextContestAt, 0);
        await service.lease(handle);
        assert.equal(calls(two) >= before + 2, true);
        // Without the server's duration the expiry is all there is.
        mode = "refuse-no-duration";
        handle.nextContestAt = 0;
        await service.lease(handle);
        assert.ok((handle.nextContestAt ?? 0) > performance.now() + 500);
      } finally {
        mode = "plain";
        handle.writer = original;
        handle.nextContestAt = 0;
      }
      await until(() => (service.projects.get(two)!.leaseDeadline ?? 0) > performance.now(), "the real lease to be renewed again");
    });

    await t.test("40: discovery runs on its own slow cadence, slower still on battery", async () => {
      const real = service.adoptMarkers.bind(service);
      let passes = 0;
      service.adoptMarkers = async () => {
        passes += 1;
        await real();
      };
      try {
        // Several renewal ticks (every 300 ms) pass; discovery (1.8 s) runs at most once or twice.
        await sleep(2_100);
        assert.ok(passes <= 2, `${passes} discovery passes in 2.1 s`);
        const discoveryMs = (alice.service as unknown as { discoveryMs: number }).discoveryMs;
        assert.ok(discoveryMs >= LEASE_TTL_MS, "discovery is not on the renewal cadence");
        service.powerChanged(true);
        const settled = passes;
        await sleep(2_100);
        assert.ok(passes - settled <= 1, `${passes - settled} discovery passes on battery`);
      } finally {
        service.powerChanged(false);
        service.adoptMarkers = real;
      }
    });
  } finally {
    for (const peer of peers) await closePeer(peer);
    await server.stop();
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
