import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { createMemoryPortPair } from "../../electron/collab/core/ports";
import { SharedDocRegistry } from "../../src/lib/collab/client/registry";
import { ControlRoutes, type HostEvent } from "../../src/lib/collab/local-api";
import { ContentKeys } from "../../src/lib/collab/protocol/schema";
import { browserPort } from "./support/wire-harness";
import { closePeer, invite, makePeer, readText, register, sleep, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

test("notebook identity, external renames and deleted open documents", { timeout: 120_000 }, async (t) => {
  const temp = tempRoot("libera-notebook-lifecycle-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  const registries: SharedDocRegistry[] = [];
  try {
    const ownerAuth = await register(server, "Owner");
    const peerAuth = await register(server, "Peer");
    const owner = await makePeer(temp.dir, "owner", server, ownerAuth);
    const peer = await makePeer(temp.dir, "peer", server, peerAuth, { timings: { writeDebounceMs: 1000, writeMaxWaitMs: 5000 } });
    peers.push(owner, peer);
    writeTree(path.join(owner.library, "Lab"), { "note.md": "original\n", "keep.md": "keep\n", "offline.md": "offline base\n" });
    const shared = await owner.router.call("POST", ControlRoutes.share, { notebook: "Lab" });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    const projectId = (shared.body as { projectId: string }).projectId;
    const joined = await peer.router.call("POST", ControlRoutes.join, { invitation: await invite(server, ownerAuth, projectId, "peer@example.test") });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const notebook = (joined.body as { notebook: string }).notebook;
    const root = path.join(peer.library, notebook);
    const docId = peer.service.resolvePath(`${notebook}/keep.md`)!.docId;

    await t.test("a moved or replaced root cannot publish deletions or be recreated by pending writes", async () => {
      const moved = path.join(peer.library, "Moved notebook");
      assert.ok(root.startsWith(temp.dir + path.sep) && moved.startsWith(temp.dir + path.sep));
      await peer.service.project(projectId)!.whenIdle();
      renameSync(root, moved);
      const hub = owner.host.acquire(docId);
      try {
        hub.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, "remote\n"), { source: "typing" });
        await sleep(2200); // Longer than two scans, delete grace and the write debounce.
        assert.ok(owner.service.resolvePath("Lab/keep.md"));
        assert.equal(existsSync(root), false, "materialization and state saves leave a missing notebook alone");
        mkdirSync(root);
        const marker = JSON.parse(readFileSync(path.join(moved, ".libera-shared.json"), "utf8"));
        writeFileSync(path.join(root, ".libera-shared.json"), JSON.stringify({ ...marker, folderId: "different-folder" }));
        await sleep(1600);
        assert.ok(owner.service.resolvePath("Lab/keep.md"), "a replacement with the same project but a different identity cannot delete shared files");
        // Move the replacement aside, then restore the original notebook.
        const replaced = path.join(peer.library, "Replacement notebook");
        assert.ok(replaced.startsWith(temp.dir + path.sep));
        renameSync(root, replaced);
        renameSync(moved, root);
        await until(() => readText(root, "keep.md") === "remote\nkeep\n", "pending writes resume after restoring the root");
      } finally { owner.host.release(docId); }
    });

    await t.test("an external file rename emits the move on its originating client", async () => {
      peer.events.length = 0;
      renameSync(path.join(root, "keep.md"), path.join(root, "renamed.md"));
      await until(() => owner.service.resolvePath("Lab/renamed.md")?.docId === docId, "rename reaches collaborator");
      assert.ok(peer.events.some((event) => event.t === "tree-changed" && event.moves.some((move) => move.from === `${notebook}/keep.md` && move.to === `${notebook}/renamed.md`)), "the originating open tab receives its move");
      assert.ok(!peer.events.some((event) => event.t === "tree-changed" && event.removed.includes(`${notebook}/keep.md`)), "a rename is not a deletion");
    });

    await t.test("deleting an open document preserves current text and keeps the tab read-only", async () => {
      const liberaPath = `${notebook}/note.md`;
      const events: { listener?: (event: HostEvent) => void } = {};
      const registry = new SharedDocRegistry({
        resolve: async (p) => peer.service.resolvePath(p),
        attach: async (id) => {
          const ports = createMemoryPortPair();
          peer.host.attachReplica(id, ports.hub, { projectId });
          return browserPort(ports.replica);
        },
        available: () => true, replicaOptions: { schedule: queueMicrotask },
        subscribeEvents: (next) => { events.listener = next; return () => { events.listener = undefined; }; },
      });
      registries.push(registry);
      await registry.bindTab(liberaPath, liberaPath);
      const session = registry.sessionForTab(liberaPath)!;
      await session.replica.whenAttached();
      session.replica.ytext.insert(0, "latest text\n");
      session.replica.flush();
      const hub = peer.host.acquire(session.docId);
      try {
        await until(() => hub.getText().startsWith("latest text"), "last edit reaches SQLite");
        const deleted = await owner.router.call("POST", ControlRoutes.files(projectId), { op: "delete", path: "note.md" });
        assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
        await until(() => peer.service.resolvePath(liberaPath) === null, "manifest deletion arrives");
        for (const event of peer.events) events.listener?.(event);
        await until(() => !session.replica.canEditContent(), "open editor becomes read-only");
        assert.equal(hub.canSync(), false);
        assert.equal(hub.getStatus().state, "deleted");
        assert.equal(readText(root, "_archive/note.md"), "latest text\noriginal\n", "archive includes edits newer than the disk copy");
        assert.equal((await registry.bindTab(liberaPath, liberaPath)).kind, "shared", "deleted tabs stay recovery views");
        assert.equal(registry.readTabText(liberaPath), "latest text\noriginal\n");
        assert.equal(peer.service.localProjects()[0].revoked, false, "file deletion does not revoke the notebook");
      } finally { peer.host.release(session.docId); }
    });

    await t.test("a client returning after deletion keeps offline edits without losing notebook access", async () => {
      const resolved = peer.service.resolvePath(`${notebook}/offline.md`)!;
      const hub = peer.host.acquire(resolved.docId);
      try {
        peer.host.setAccount(null);
        hub.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, "offline edit\n"), { source: "typing" });
        assert.ok(hub.pendingCount > 0);
        const deleted = await owner.router.call("POST", ControlRoutes.files(projectId), { op: "delete", path: "offline.md" });
        assert.equal(deleted.status, 200);
        const manifest = owner.host.acquire(owner.service.project(projectId)!.info.manifestDocId);
        try { await until(() => manifest.pendingCount === 0, "deletion commits on the server before reconnecting"); }
        finally { owner.host.release(manifest.docId); }
        peer.host.setAccount({ accountId: peerAuth.account.id, serverUrl: server.url,
          tokenProvider: { getAccessToken: async () => peerAuth.accessToken, refresh: async () => null } });
        await until(() => hub.getStatus().state === "deleted" && peer.service.resolvePath(`${notebook}/offline.md`) === null, "offline deletion settles");
        assert.equal(hub.getText(), "offline edit\noffline base\n");
        assert.ok(hub.pendingCount > 0, "orphan edits are kept locally rather than acknowledged");
        assert.equal(hub.canSync(), false);
        assert.equal(peer.service.localProjects()[0].revoked, false);
        assert.ok(peer.service.resolvePath(`${notebook}/renamed.md`));
      } finally { peer.host.release(resolved.docId); }
    });

    await t.test("deleting the local notebook folder does not delete its shared files", async () => {
      assert.ok(path.resolve(root).startsWith(path.resolve(temp.dir) + path.sep), "only remove this test's temporary notebook");
      rmSync(root, { recursive: true, force: true });
      await sleep(1800);
      assert.ok(owner.service.resolvePath("Lab/renamed.md"));
      assert.equal(readText(path.join(owner.library, "Lab"), "renamed.md"), "remote\nkeep\n");
      assert.equal(existsSync(root), false);
    });
  } finally {
    for (const registry of registries) registry.destroy();
    for (const peer of peers) await closePeer(peer);
    await server.stop();
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
