// Shared notebook folders that a sync client (OneDrive and the like) also
// manages: older copies coming back, the marker naming the installation
// that keeps the folder in sync, and takedowns and revocations that must
// not rewrite a marker that is no longer theirs.

import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { ControlRoutes } from "../../src/lib/collab/local-api";
import type { SharedMarker } from "../../electron/collab/notebooks/state";
import { closePeer, invite, makePeer, readText, register, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

const MARKER = ".libera-shared.json";

function readMarkerFile(root: string): SharedMarker {
  return JSON.parse(readFileSync(path.join(root, MARKER), "utf8")) as SharedMarker;
}

function writeMarkerFile(root: string, marker: SharedMarker): void {
  writeFileSync(path.join(root, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
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

/** Puts bytes in place the way a sync client does: a rename, carrying the source's mtime. */
function restoreCopy(root: string, relative: string, content: string, mtimeMs: number): void {
  const staging = path.join(root, ".restore-staging");
  writeFileSync(staging, content);
  utimesSync(staging, new Date(), new Date(mtimeMs));
  renameSync(staging, path.join(root, relative));
}

test("a synced notebook folder survives stale copies, other writers and takedowns", { timeout: 180_000 }, async (t) => {
  const temp = tempRoot("libera-notebooks-synced-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const aliceAuth = await register(server, "Alice");
    const bobAuth = await register(server, "Bob");
    const alice = await makePeer(temp.dir, "alice", server, aliceAuth);
    const bob = await makePeer(temp.dir, "bob", server, bobAuth);
    peers.push(alice, bob);
    const root = path.join(alice.library, "Research");
    writeTree(root, { "note.md": "version one\n" });
    const shared = await alice.router.call("POST", ControlRoutes.share, { notebook: "Research" });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    const { projectId } = shared.body as { projectId: string };

    await t.test("the marker names the installation that keeps the folder in sync", () => {
      assert.equal(readMarkerFile(root).writer, alice.host.installationId);
    });

    await t.test("an older copy put back by a sync client does not undo newer edits", async () => {
      writeFileSync(path.join(root, "note.md"), "version two\n");
      await until(() => sharedText(alice, "Research/note.md") === "version two\n", "the second version to be taken in");
      const second = statSync(path.join(root, "note.md")).mtimeMs;
      await new Promise((resolve) => setTimeout(resolve, 50));
      writeFileSync(path.join(root, "note.md"), "version three\n");
      await until(() => sharedText(alice, "Research/note.md") === "version three\n", "the third version to be taken in");
      await alice.service.project(projectId)?.whenIdle();

      restoreCopy(root, "note.md", "version two\n", second);
      await until(() => readText(root, "note.md") === "version three\n", "the current text to be written again");
      await alice.service.project(projectId)?.whenIdle();
      assert.equal(sharedText(alice, "Research/note.md"), "version three\n");
    });

    await t.test("the same text saved again by a person is an edit", async () => {
      writeFileSync(path.join(root, "note.md"), "version two\n");
      await until(() => sharedText(alice, "Research/note.md") === "version two\n", "the person's edit to be taken in");
    });

    await t.test("a legacy marker is claimed by the host that loads it", async () => {
      const legacy = readMarkerFile(root);
      delete legacy.writer;
      writeMarkerFile(root, legacy);
      await alice.service.stop();
      await alice.service.start();
      assert.equal(readMarkerFile(root).writer, alice.host.installationId);
      assert.equal(alice.service.localProjects().length, 1);
    });

    await t.test("another installation on the same folder follows and leaves the folder to its writer", async () => {
      // Same account and library folder, another installation: a second
      // Libera profile or device on the same synced data folder.
      const twin = await makePeer(temp.dir, "alice-twin", server, aliceAuth, { library: alice.library });
      peers.push(twin);
      twin.host.store.upsertProject({ projectId, name: "Research", localRoot: root, role: "owner" });
      await twin.service.accountChanged();
      assert.deepEqual(twin.service.localProjects().map((project) => project.projectId), [projectId]);
      assert.equal(twin.service.project(projectId)?.follower, true);
      assert.equal(readMarkerFile(root).writer, alice.host.installationId);
    });

    await t.test("takedown and revocation leave markers that are not theirs", async () => {
      const link = await invite(server, aliceAuth, projectId, "bob@example.test", "editor");
      const joined = await bob.router.call("POST", ControlRoutes.join, { invitation: link });
      assert.equal(joined.status, 200, JSON.stringify(joined.body));
      const bobRoot = path.join(bob.library, (joined.body as { notebook: string }).notebook);
      assert.equal(readMarkerFile(bobRoot).writer, bob.host.installationId);

      // Bob's folder now syncs from another of his installations, and
      // Alice's folder holds a newer share that arrived from elsewhere.
      const bobMarker: SharedMarker = { ...readMarkerFile(bobRoot), writer: "inst_bob_elsewhere" };
      writeMarkerFile(bobRoot, bobMarker);
      const newer: SharedMarker = { ...readMarkerFile(root), projectId: "prj_newer_share", writer: "inst_alice_elsewhere" };
      writeMarkerFile(root, newer);

      const removed = await alice.router.call("DELETE", ControlRoutes.project(projectId));
      assert.equal(removed.status, 204, JSON.stringify(removed.body));
      assert.deepEqual(alice.service.localProjects(), []);
      assert.ok(existsSync(path.join(root, MARKER)));
      assert.deepEqual(readMarkerFile(root), newer);

      await until(() => bob.service.localProjects()[0]?.revoked === true, "Bob to lose shared access");
      assert.deepEqual(readMarkerFile(bobRoot), bobMarker);
    });
  } finally {
    for (const peer of peers) await closePeer(peer).catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
