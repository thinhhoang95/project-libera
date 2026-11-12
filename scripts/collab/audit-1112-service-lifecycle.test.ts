// Audit 2026-11-12, service lifecycle: DL-5 (lease lifetime vs. client clock),
// DL-2 (failed runtime replacement), DL-4 (renewal isolation), DATA-10 (marker
// repair into a replacement directory), DL-3 (bounded whenIdle), MISC-3
// (duplicate roots reported).

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { FetchLike } from "../../electron/collab/core";
import { ControlRoutes } from "../../src/lib/collab/local-api";
import { closePeer, makePeer, register, sleep, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

const MARKER = ".libera-shared.json";
const LEASE_TTL_MS = 900;

interface Internals {
  projects: Map<string, { runtime: unknown; restart?: unknown; writer: boolean; leaseDeadline?: number }>;
  locked<T>(key: string, task: () => Promise<T>): Promise<T>;
  run(handle: unknown): Promise<void>;
  switchRole(handle: unknown, writer: boolean): Promise<void>;
}
const internals = (peer: Peer) => peer.service as unknown as Internals;

test("service lifecycle audit fixes", { timeout: 240_000 }, async (t) => {
  const temp = tempRoot("libera-audit-1112-lifecycle-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const auth = await register(server, "Alice");
    const leaseCalls = new Map<string, number>();
    // "skew": rewrites the granted lease the way a device whose wall clock is
    // far ahead of the server sees it (expiry already in its past), and drops
    // ttlMs when "legacy" (an older server).
    let mode: "plain" | "skew" | "legacy" = "plain";
    const fetchLike: FetchLike = async (url, init) => {
      const response = await fetch(url, init);
      if (!url.includes("/folder-lease") || init?.method !== "POST") return response;
      const projectId = /projects\/([^/]+)\/folder-lease/.exec(url)?.[1] ?? "";
      leaseCalls.set(projectId, (leaseCalls.get(projectId) ?? 0) + 1);
      if (mode === "plain") return response;
      const body = (await response.json()) as Record<string, unknown>;
      body.expiresAt = new Date(Date.now() - 10 * 60_000).toISOString();
      if (mode === "legacy") delete body.ttlMs;
      return new Response(JSON.stringify(body), { status: response.status, headers: { "content-type": "application/json" } });
    };
    const alice = await makePeer(temp.dir, "alice", server, auth, { leaseTtlMs: LEASE_TTL_MS, fetch: fetchLike });
    peers.push(alice);
    (alice.service as unknown as { markerRepairDelayMs: number }).markerRepairDelayMs = 400;
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

    await t.test("DL-5: a client clock ahead of the server does not turn grants into zero-length leases", async () => {
      for (const next of ["skew", "legacy"] as const) {
        mode = next;
        const before = leaseCalls.get(one) ?? 0;
        await until(() => (leaseCalls.get(one) ?? 0) >= before + 3, "several renewals");
        const handle = internals(alice).projects.get(one)!;
        assert.equal(handle.writer, true, `${next}: still the writer`);
        assert.equal(alice.service.project(one)?.follower, false, `${next}: the runtime was not demoted`);
        assert.ok((handle.leaseDeadline ?? 0) > performance.now(), `${next}: the lease is usable`);
      }
      mode = "plain";
    });

    await t.test("DL-4: a project stuck behind its lifecycle lock does not stop other projects renewing", async () => {
      let release!: () => void;
      const stuck = internals(alice).locked(`project:${one}`, () => new Promise<void>((resolve) => { release = resolve; }));
      try {
        const beforeOne = leaseCalls.get(one) ?? 0;
        const beforeTwo = leaseCalls.get(two) ?? 0;
        await until(() => (leaseCalls.get(two) ?? 0) >= beforeTwo + 3, "the other project to keep renewing");
        await until(() => (leaseCalls.get(one) ?? 0) >= beforeOne + 2, "even the locked project's lease to keep renewing");
        assert.ok(alice.service.project(two) && !alice.service.project(two)!.follower);
      } finally {
        release();
        await stuck;
      }
    });

    await t.test("DL-2: a failed role change leaves an explicit failed state that later ticks retry", async () => {
      const service = internals(alice);
      const handle = service.projects.get(one)!;
      const realRun = service.run.bind(service);
      let failures = 1;
      service.run = async (target) => {
        if (failures-- > 0) throw new Error("simulated reopen failure");
        return realRun(target);
      };
      try {
        await assert.rejects(service.switchRole(handle, false), /simulated reopen failure/);
        assert.equal(handle.runtime, null);
        assert.ok(handle.restart, "the failure is recorded on the handle");
        assert.equal(service.projects.get(one), handle);
        await until(() => alice.service.project(one) !== null, "a later tick to reopen the runtime");
        assert.equal(handle.restart, undefined);
      } finally {
        service.run = realRun;
      }
    });

    await t.test("DL-3: whenIdle can be bounded and reports false while work keeps re-arming", async () => {
      const runtime = alice.service.project(two)!;
      const state = runtime as unknown as { scanTimer: ReturnType<typeof setTimeout> | null };
      const timer = setTimeout(() => undefined, 60_000);
      state.scanTimer = timer;
      try {
        const started = Date.now();
        assert.equal(await runtime.whenIdle(250), false);
        assert.ok(Date.now() - started < 5_000);
      } finally {
        clearTimeout(timer);
        state.scanTimer = null;
      }
      assert.equal(await runtime.whenIdle(5_000), true);
    });

    await t.test("MISC-3: a second folder carrying a registered project's marker is reported", async () => {
      const source = path.join(alice.library, "Two");
      const copy = path.join(alice.library, "Two copy");
      cpSync(source, copy, { recursive: true });
      await until(() => alice.service.unjoinedFolders().some((folder) => folder.notebook === "Two copy" && folder.reason === "duplicate-root" && folder.projectId === two), "the duplicate to be reported");
      assert.ok(!alice.service.unjoinedFolders().some((folder) => folder.notebook === "Two"), "the registered root is not reported");
      rmSync(copy, { recursive: true, force: true });
      await until(() => !alice.service.unjoinedFolders().some((folder) => folder.notebook === "Two copy"), "the report to clear once the duplicate is gone");
    });

    await t.test("DATA-10: a replacement directory at the old path does not get the old marker", async () => {
      const root = path.join(alice.library, "One");
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root);
      writeFileSync(path.join(root, "unrelated.md"), "someone else's notebook\n");
      await until(() => alice.service.unjoinedFolders().some((folder) => folder.notebook === "One" && folder.reason === "needs-recovery"), "the folder to be reported as needing recovery", 30_000);
      await sleep(1_000);
      assert.equal(existsSync(path.join(root, MARKER)), false, "no marker was written into the replacement directory");
    });
  } finally {
    for (const peer of peers) await closePeer(peer);
    await server.stop();
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
