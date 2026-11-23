// Audit 2026-11-23, PR1 (project registration races): H17 (a failed share leaves
// no zombie handle), H26 (a rejoined notebook's new folder is adopted by another
// device that still holds the revoked one), H27 (startup holds the project lock;
// a revoked handle never starts a runtime), M25 (a join cancelled while it awaits
// its lease leaks no runtime), M4 and M23 part 2 (rejoin and takedown clear the
// old folder's fences, retired paths, manifest paths and transitions).

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { readMarker, writeMarker } from "../../electron/collab/notebooks/state";
import { ControlRoutes } from "../../src/lib/collab/local-api";
import { api, closePeer, makePeer, register, sleep, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

interface Handle { projectId: string; root: string; revoked: boolean; runtime: unknown; writer: boolean }
interface Internals {
  projects: Map<string, Handle>;
  locked<T>(key: string, task: () => Promise<T>): Promise<T>;
  run(handle: Handle): Promise<void>;
  lease(handle: Handle): Promise<{ outcome: string; contended: boolean }>;
  claimRole(handle: Handle, marker: unknown): Promise<boolean>;
  loadStoredProjects(): Promise<void>;
  adoptMarkers(): Promise<void>;
}
const internals = (peer: Peer) => peer.service as unknown as Internals;

test("registration races (audit 2026-11-23, PR1)", { timeout: 240_000 }, async (t) => {
  const temp = tempRoot("libera-audit-1123-registration-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const aliceAuth = await register(server, "Alice");
    const bobAuth = await register(server, "Bob");
    const alice = await makePeer(temp.dir, "alice", server, aliceAuth, { leaseTtlMs: 900 });
    const bob = await makePeer(temp.dir, "bob", server, bobAuth, { leaseTtlMs: 900 });
    peers.push(alice, bob);

    const share = async (name: string) => {
      writeTree(path.join(alice.library, name), { "note.md": `${name}\n` });
      const shared = await alice.router.call("POST", ControlRoutes.share, { notebook: name });
      assert.equal(shared.status, 200, JSON.stringify(shared.body));
      const { projectId } = shared.body as { projectId: string };
      await alice.service.project(projectId)?.whenIdle();
      return projectId;
    };
    const invitation = async (projectId: string) => {
      const created = await api<{ token: string }>(server, `/v1/projects/${projectId}/invitations`, { email: "bob@example.test", role: "editor" }, aliceAuth.accessToken);
      assert.equal(created.status, 201);
      return created.body.token;
    };
    const seedBookkeeping = (peer: Peer, projectId: string) => {
      const store = peer.host.store;
      store.requireExternalAdoption(projectId);
      store.retirePath(projectId, "old-folder-file.md", ["hash-old"]);
      store.commitManifestPaths(projectId, {
        upserts: [{ fileId: "fil_stale", path: "old-folder-file.md", kind: "file" }],
        removals: [],
        transitions: [{ fileId: "fil_stale", kind: "file", from: "older.md", to: "old-folder-file.md", at: 1 }],
      });
    };
    const staleLeft = (peer: Peer, projectId: string) => {
      const store = peer.host.store;
      return {
        fence: store.requiresExternalAdoption(projectId),
        retired: store.retiredPaths(projectId).has("old-folder-file.md"),
        path: store.manifestPaths(projectId).has("fil_stale"),
        transition: store.transitionsAfter(projectId).some((row) => row.fileId === "fil_stale"),
      };
    };

    await t.test("H17: a share that fails after registering leaves no handle behind", async () => {
      const service = internals(alice);
      const realRun = service.run.bind(service);
      let failures = 1;
      service.run = async (handle) => {
        if (failures-- > 0) throw new Error("simulated start failure");
        return realRun(handle);
      };
      try {
        writeTree(path.join(alice.library, "Zed"), { "note.md": "zed\n" });
        await assert.rejects(alice.router.call("POST", ControlRoutes.share, { notebook: "Zed" }), /simulated start failure/);
        assert.equal(service.projects.size, 0, "no zombie handle stays registered");
        await service.loadStoredProjects();
        assert.equal(service.projects.size, 1, "the stored row starts again on the next pass");
        assert.ok([...service.projects.values()][0].runtime, "with a runtime");
      } finally { service.run = realRun; }
    });

    const projectId = await share("Notes");
    const link = await invitation(projectId);
    let bobRoot = "";

    await t.test("M25: a join cancelled while it awaits its lease leaks no runtime", async () => {
      const service = internals(bob);
      const realLease = service.lease.bind(service);
      const realRun = service.run.bind(service);
      let seen: Handle | undefined;
      let stopping: Promise<void> | undefined;
      service.run = async (handle) => { seen = handle; return realRun(handle); };
      service.lease = async () => {
        stopping = bob.service.stop();
        await sleep(100);
        return { outcome: "unavailable", contended: false };
      };
      try {
        await bob.router.call("POST", ControlRoutes.join, { invitation: link }).catch(() => undefined);
        await stopping;
        assert.ok(seen, "the join got as far as starting the runtime");
        assert.equal(seen.runtime, null, "no runtime keeps running after stop");
        assert.equal(service.projects.size, 0);
      } finally {
        service.lease = realLease;
        service.run = realRun;
        await bob.service.start();
      }
    });

    await t.test("H27: startup of a stored project waits for the project lock and never runs a revoked handle", async () => {
      const service = internals(bob);
      // A join that finished cleanly is the baseline: one handle, one runtime.
      const second = await bob.router.call("POST", ControlRoutes.join, { invitation: link });
      assert.equal(second.status, 200, JSON.stringify(second.body));
      bobRoot = path.join(bob.library, (second.body as { notebook: string }).notebook);
      await bob.service.project(projectId)?.whenIdle();
      const handle = service.projects.get(projectId)!;
      await (handle.runtime as { stop(o?: unknown): Promise<void> }).stop();
      service.projects.delete(projectId);
      handle.runtime = null;

      let release!: () => void;
      const held = service.locked(`project:${projectId}`, () => new Promise<void>((resolve) => { release = resolve; }));
      const loading = service.loadStoredProjects();
      await sleep(400);
      assert.equal(service.projects.has(projectId), false, "startup waits while the project lock is held");
      release();
      await held;
      await loading;
      assert.ok(service.projects.get(projectId)?.runtime, "and runs once it is free");

      // Revoked while the role is being claimed: no runtime starts.
      const running = service.projects.get(projectId)!;
      await (running.runtime as { stop(o?: unknown): Promise<void> }).stop();
      service.projects.delete(projectId);
      const realClaim = service.claimRole.bind(service);
      let seen: Handle | undefined;
      service.claimRole = async (h, marker) => { seen = h; h.revoked = true; return realClaim(h, marker); };
      try {
        await service.loadStoredProjects();
        assert.ok(seen, "startup reached the role claim");
        assert.equal(seen.runtime, null, "no live runtime on a revoked handle");
        assert.equal(service.projects.get(projectId)?.runtime ?? null, null);
      } finally {
        service.claimRole = realClaim;
      }
      await service.loadStoredProjects();
      assert.ok(service.projects.get(projectId)?.runtime, "the next pass starts it normally");
    });

    await t.test("H26 and M23: a revoked notebook rejoined elsewhere is adopted by the other device, without the old folder's records", async () => {
      const service = internals(bob);
      const removed = await fetch(`${server.url}/v1/projects/${projectId}/members/${bobAuth.account.id}`, { method: "DELETE", headers: { authorization: `Bearer ${aliceAuth.accessToken}` } });
      assert.ok(removed.status === 204 || removed.status === 200);
      await until(() => bob.service.localProjects().some((project) => project.projectId === projectId && project.revoked), "the revocation");
      seedBookkeeping(bob, projectId);

      // The same account rejoins on another device into "Notes (2)"; the folder reaches this device by sync.
      const token = await invitation(projectId);
      const summary = await bob.host.api!.acceptInvitation(token);
      const old = (await readMarker(bobRoot))!;
      const folder = path.join(bob.library, "Notes (2)");
      mkdirSync(folder, { recursive: true });
      cpSync(path.join(bobRoot, "note.md"), path.join(folder, "note.md"));
      const { revoked: _revoked, revokedAt: _revokedAt, writer: _writer, ...rest } = old;
      await writeMarker(folder, { ...rest, manifestDocId: summary.manifestDocId, folderId: "fld_rejoined_elsewhere" });

      await service.adoptMarkers();
      assert.ok(!bob.service.unjoinedFolders().some((entry) => entry.reason === "duplicate-root"), "the new folder is not a duplicate of the revoked one");
      const handle = service.projects.get(projectId)!;
      assert.equal(path.resolve(handle.root), path.resolve(folder));
      assert.equal(handle.revoked, false);
      await until(() => service.projects.get(projectId)?.runtime != null, "the adopted folder to run");
      assert.equal(path.resolve(bob.host.store.getProject(projectId)!.localRoot!), path.resolve(folder));
      assert.deepEqual(staleLeft(bob, projectId), { fence: false, retired: false, path: false, transition: false });
      assert.ok(existsSync(path.join(bobRoot, ".libera-shared.json")), "the revoked folder is left as it was");
    });

    await t.test("M4 and M23: deleting a project clears its fences, retired paths, manifest paths and transitions", async () => {
      const store = alice.host.store;
      seedBookkeeping(alice, "prj_gone");
      store.upsertProject({ projectId: "prj_gone", name: "Gone", localRoot: path.join(alice.library, "Gone"), role: "owner" });
      assert.deepEqual(staleLeft(alice, "prj_gone"), { fence: true, retired: true, path: true, transition: true });
      store.deleteProject("prj_gone");
      assert.deepEqual(staleLeft(alice, "prj_gone"), { fence: false, retired: false, path: false, transition: false });
    });

    await t.test("M4 and M23: joining again into a fresh folder drops the old folder's records", async () => {
      // Bob's account is a member once more (accepted above), and its row is bound to "Notes (2)": leave and rejoin through the route.
      const service = internals(bob);
      const removed = await fetch(`${server.url}/v1/projects/${projectId}/members/${bobAuth.account.id}`, { method: "DELETE", headers: { authorization: `Bearer ${aliceAuth.accessToken}` } });
      assert.ok(removed.status === 204 || removed.status === 200);
      await until(() => service.projects.get(projectId)?.revoked === true, "the second revocation");
      seedBookkeeping(bob, projectId);
      const joined = await bob.router.call("POST", ControlRoutes.join, { invitation: await invitation(projectId) });
      assert.equal(joined.status, 200, JSON.stringify(joined.body));
      assert.deepEqual(staleLeft(bob, projectId), { fence: false, retired: false, path: false, transition: false });
    });
  } finally {
    for (const peer of peers) await closePeer(peer).catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
