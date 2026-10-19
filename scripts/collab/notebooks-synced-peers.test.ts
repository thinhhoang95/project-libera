// Two installations of one account on one synced library folder (a second
// device or Libera profile on the same OneDrive data folder): the second
// adopts the shared notebook it finds there and follows through the CRDT,
// and the writing role moves between them through the server's lease.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { FetchLike } from "../../electron/collab/core";
import type { SharedMarker } from "../../electron/collab/notebooks/state";
import { ControlRoutes } from "../../src/lib/collab/local-api";
import { ContentKeys } from "../../src/lib/collab/protocol/schema";
import { closePeer, makePeer, readText, register, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

const MARKER = ".libera-shared.json";
const LEASE_TTL_MS = 1500;

function readMarkerFile(root: string): SharedMarker {
  return JSON.parse(readFileSync(path.join(root, MARKER), "utf8")) as SharedMarker;
}

function sharedText(peer: Peer, liberaPath: string): string | null {
  const resolved = peer.service.resolvePath(liberaPath);
  if (!resolved) return null;
  const hub = peer.host.acquire(resolved.docId);
  try {
    return hub.getText("content");
  } finally {
    peer.host.release(resolved.docId);
  }
}

function typeInto(peer: Peer, liberaPath: string, text: string): void {
  const resolved = peer.service.resolvePath(liberaPath);
  assert.ok(resolved, `${liberaPath} resolves on ${peer.name}`);
  const hub = peer.host.acquire(resolved.docId);
  try {
    hub.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, text), { source: "typing" });
  } finally {
    peer.host.release(resolved.docId);
  }
}

const isFollower = (peer: Peer, projectId: string) => peer.service.project(projectId)?.follower;

test("a synced notebook folder is adopted, followed and handed over between installations", { timeout: 240_000 }, async (t) => {
  const temp = tempRoot("libera-notebooks-peers-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const aliceAuth = await register(server, "Alice");
    const bobAuth = await register(server, "Bob");
    let alice = await makePeer(temp.dir, "alice", server, aliceAuth, { leaseTtlMs: LEASE_TTL_MS });
    peers.push(alice);
    const library = alice.library;
    const root = path.join(library, "Research");
    writeTree(root, { "note.md": "first line\n" });
    const shared = await alice.router.call("POST", ControlRoutes.share, { notebook: "Research" });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    const { projectId } = shared.body as { projectId: string };
    assert.equal(readMarkerFile(root).writer, alice.host.installationId);
    assert.ok(readMarkerFile(root).folderId);

    // Same account, same folder, another installation: no store row, only the marker.
    let twinLeaseBlocked = false;
    const twinFetch: FetchLike = (url, init) =>
      twinLeaseBlocked && url.includes("/folder-lease") ? Promise.reject(new Error("offline")) : fetch(url, init);
    const twin = await makePeer(temp.dir, "alice-twin", server, aliceAuth, { library, leaseTtlMs: LEASE_TTL_MS, fetch: twinFetch });
    peers.push(twin);

    await t.test("the second installation adopts the marker it finds and follows", async () => {
      assert.deepEqual(twin.service.localProjects().map((project) => [project.projectId, project.notebook, project.role]), [[projectId, "Research", "owner"]]);
      assert.equal(twin.host.store.getProject(projectId)?.localRoot, root);
      assert.equal(isFollower(twin, projectId), true);
      assert.equal(isFollower(alice, projectId), false);
      await until(() => sharedText(twin, "Research/note.md") === "first line\n", "the follower to sync the document");
      // The writer learns from the server that another installation uses the folder.
      await until(() => readMarkerFile(root).syncedElsewhere === true, "the marker to record a second installation");
      assert.equal(readMarkerFile(root).writer, alice.host.installationId);
    });

    await t.test("the follower's edits and file operations reach the CRDT and the writer's disk", async () => {
      typeInto(twin, "Research/note.md", "from the twin: ");
      await until(() => readText(root, "note.md") === "from the twin: first line\n", "the writer to write the follower's edit");
      const created = await twin.router.call("POST", ControlRoutes.files(projectId), { op: "create-file", path: "twin.md", content: "made on the twin\n" });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      await until(() => readText(root, "twin.md") === "made on the twin\n", "the writer to write the follower's new file");
      await until(() => sharedText(alice, "Research/twin.md") === "made on the twin\n", "the writer to see the new document");
      await alice.service.project(projectId)?.whenIdle();
      assert.equal(readMarkerFile(root).writer, alice.host.installationId);
    });

    await t.test("folders this host cannot use are left alone, with a clear error", async () => {
      // A marker for this account whose project the server will not open.
      const ghost = path.join(library, "Ghost");
      mkdirSync(ghost);
      const ghostMarker: SharedMarker = { projectId: "prj_ghost", serverUrl: server.url, accountId: aliceAuth.account.id, manifestDocId: "doc_ghost", sharedAt: new Date().toISOString(), writer: "inst_elsewhere", folderId: "fld_ghost" };
      writeFileSync(path.join(ghost, MARKER), JSON.stringify(ghostMarker));
      await until(() => twin.service.unjoinedFolders().some((folder) => folder.notebook === "Ghost" && folder.status === 404), "the ghost folder to be reported");
      assert.equal(twin.host.store.getProject("prj_ghost"), null);
      assert.deepEqual(JSON.parse(readFileSync(path.join(ghost, MARKER), "utf8")), ghostMarker);

      // Another account on the same folder: not adopted, and writes say why.
      const bob = await makePeer(temp.dir, "bob", server, bobAuth, { library, leaseTtlMs: LEASE_TTL_MS });
      peers.push(bob);
      assert.deepEqual(bob.service.localProjects(), []);
      const refused = await bob.router.call("POST", ControlRoutes.files(projectId), { op: "create-file", path: "bob.md", content: "" });
      assert.equal(refused.status, 404);
      assert.equal((refused.body as { error: { code: string } }).error.code, "not-joined");
      await closePeer(bob);
      peers.splice(peers.indexOf(bob), 1);
    });

    await t.test("when the writer stops, the follower takes over from the folder's state", async () => {
      await closePeer(alice);
      peers.splice(peers.indexOf(alice), 1);
      await until(() => isFollower(twin, projectId) === false, "the follower to become the writer");
      assert.equal(readMarkerFile(root).writer, twin.host.installationId);
      await twin.service.project(projectId)?.whenIdle();
      // It started from the folder's state.json: nothing was archived as unknown.
      assert.equal(existsSync(path.join(root, "_archive")), false);
      writeFileSync(path.join(root, "note.md"), "edited on disk after the handover\n");
      await until(() => sharedText(twin, "Research/note.md") === "edited on disk after the handover\n", "the new writer to take in a disk edit");
    });

    await t.test("a writer that cannot renew loses the role once another holds the lease, and steps down", async () => {
      alice = await makePeer(temp.dir, "alice", server, aliceAuth, { library, leaseTtlMs: LEASE_TTL_MS });
      peers.push(alice);
      assert.equal(isFollower(alice, projectId), true, "the lease is the twin's");
      twinLeaseBlocked = true;
      await until(() => isFollower(alice, projectId) === false, "the lease to expire and move", 20_000);
      assert.equal(readMarkerFile(root).writer, alice.host.installationId);
      // The twin's renewals fail, but the marker now names another writer.
      await until(() => isFollower(twin, projectId) === true, "the stale writer to step down");
      twinLeaseBlocked = false;
      await sleepTicks(3);
      assert.equal(isFollower(alice, projectId), false);
      assert.equal(isFollower(twin, projectId), true);
    });

    await t.test("signing out gives the lease up and never keeps a shared folder's writing role", async () => {
      await alice.service.beforeAccountChange();
      alice.host.setAccount(null);
      await alice.service.accountChanged();
      assert.equal(isFollower(alice, projectId), true, "signed out, a folder used elsewhere is only followed");
      await until(() => isFollower(twin, projectId) === false, "the other installation to take over at once", LEASE_TTL_MS);
      assert.equal(readMarkerFile(root).writer, twin.host.installationId);
      await sleepTicks(3);
      assert.equal(isFollower(alice, projectId), true);
    });

    await t.test("signed out, a folder no other installation uses keeps its writer", async () => {
      const carolAuth = await register(server, "Carol");
      const carol = await makePeer(temp.dir, "carol", server, carolAuth, { leaseTtlMs: LEASE_TTL_MS });
      peers.push(carol);
      writeTree(path.join(carol.library, "Diary"), { "day.md": "alone\n" });
      const carolShare = await carol.router.call("POST", ControlRoutes.share, { notebook: "Diary" });
      assert.equal(carolShare.status, 200, JSON.stringify(carolShare.body));
      const carolProject = (carolShare.body as { projectId: string }).projectId;
      await carol.service.beforeAccountChange();
      carol.host.setAccount(null);
      await carol.service.accountChanged();
      assert.equal(isFollower(carol, carolProject), false);
      writeFileSync(path.join(carol.library, "Diary", "day.md"), "alone, offline\n");
      await until(() => sharedText(carol, "Diary/day.md") === "alone, offline\n", "the signed-out writer to keep taking in disk edits");
    });

    await t.test("a takedown from the follower returns the writer's folder to a local notebook", async () => {
      await closePeer(alice);
      peers.splice(peers.indexOf(alice), 1);
      alice = await makePeer(temp.dir, "alice", server, aliceAuth, { library, leaseTtlMs: LEASE_TTL_MS });
      peers.push(alice);
      assert.equal(isFollower(alice, projectId), true, "the lease is the twin's");
      const removed = await alice.router.call("DELETE", ControlRoutes.project(projectId));
      assert.equal(removed.status, 204, JSON.stringify(removed.body));
      assert.deepEqual(alice.service.localProjects(), []);
      await until(() => !existsSync(path.join(root, MARKER)), "the writer to remove the marker");
      assert.deepEqual(twin.service.localProjects(), [], "the writer forgets the project instead of keeping it revoked");
      assert.equal(twin.host.store.getProject(projectId), null);
      assert.equal(readText(root, "note.md"), "edited on disk after the handover\n", "the files stay");
    });
  } finally {
    for (const peer of peers) await closePeer(peer).catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});

function sleepTicks(count: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, (LEASE_TTL_MS / 3) * count + 100));
}
