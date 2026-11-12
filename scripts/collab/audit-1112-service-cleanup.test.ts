// Audit 2026-11-12, package P07 (service cleanup): DATA-11 identity fences on
// cleanup, WRITE-1 compact share journal, STALE-5 retried album cleanup,
// DATA-17 best-effort binary preservation on a receiving device.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, promises as fs, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WriteCancelledError, pruneEmptyDirectories, type WriteGuard } from "../../electron/collab/notebooks/fs-ops";
import {
  deleteBase, deleteMarker, readBase, readMarker, readSharePlan, recordShareUpload, writeBase, writeMarker, type SharePlan,
} from "../../electron/collab/notebooks/state";
import { ControlRoutes } from "../../src/lib/collab/local-api";
import { closePeer, invite, makePeer, register, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

const never: WriteGuard = { root: "", canCommit: async () => false };

test("DATA-11: cleanup steps re-validate their guard immediately before acting", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "libera-p07-fence-"));
  try {
    mkdirSync(path.join(root, "a", "b"), { recursive: true });
    await pruneEmptyDirectories(root, "a/b", () => false, { root, canCommit: async () => false });
    assert.ok(existsSync(path.join(root, "a", "b")), "a refused guard keeps the empty directories");
    await pruneEmptyDirectories(root, "a/b", () => false, { root, canCommit: async () => true });
    assert.ok(!existsSync(path.join(root, "a")), "an accepting guard still prunes upwards");

    writeFileSync(path.join(root, ".libera-shared.json"), "{}");
    await assert.rejects(deleteMarker(root, { ...never, root }), WriteCancelledError);
    assert.ok(existsSync(path.join(root, ".libera-shared.json")));
    await writeBase(root, "doc_1", "text");
    await assert.rejects(deleteBase(root, "doc_1", { ...never, root }), WriteCancelledError);
    assert.equal(await readBase(root, "doc_1"), "text");
    await deleteBase(root, "doc_1");
    assert.equal(await readBase(root, "doc_1"), null, "unguarded callers behave as before");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("WRITE-1: share journal covers documents and old-format plans still read", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "libera-p07-journal-"));
  try {
    const plan: SharePlan = {
      version: 1, name: "N", startedAt: 1, projectId: "p", manifestDocId: "m",
      files: [
        { path: "a.md", kind: "doc", fileId: "fil_a", docId: "doc_a", docKind: "markdown", blobHash: "h1", initialText: "a" },
        { path: "b.md", kind: "doc", fileId: "fil_b", docId: "doc_b", docKind: "markdown", blobHash: "h2", initialText: "b", uploaded: true },
        { path: "c.png", kind: "blob", fileId: "fil_c", blobHash: "h3" },
      ],
    };
    writeFileSync(path.join(root, ".libera-share-pending.json"), JSON.stringify(plan));
    await recordShareUpload(root, plan.files[0]);
    await recordShareUpload(root, { ...plan.files[2], blobHash: "stale" });
    const read = await readSharePlan(root);
    assert.deepEqual(read!.files.map((file) => !!file.uploaded), [true, true, false], "journaled doc, legacy inline flag, stale blob record ignored");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("service cleanup against the real host and server", { timeout: 180_000 }, async (t) => {
  const temp = tempRoot("libera-p07-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const aliceAuth = await register(server, "Alice");
    const bobAuth = await register(server, "Bob");
    const alice = await makePeer(temp.dir, "alice", server, aliceAuth);
    const bob = await makePeer(temp.dir, "bob", server, bobAuth);
    peers.push(alice, bob);

    await t.test("WRITE-1: sharing writes the plan twice, whatever the number of files", async () => {
      const root = path.join(alice.library, "Many");
      writeTree(root, { ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`n${i}.md`, `note ${i}\n`])), "img/pic.png": Buffer.from([1, 2, 3, 0, 4]) });
      const originalWriteFile = fs.writeFile;
      let planWrites = 0;
      const writes = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
        if (path.dirname(String(args[0])) === root) {
          try {
            const value = JSON.parse(String(args[1]));
            if (Array.isArray(value.files) && value.startedAt) planWrites++;
          } catch { /* Not a plan. */ }
        }
        return originalWriteFile(...args);
      });
      try {
        const shared = await alice.router.call("POST", ControlRoutes.share, { notebook: "Many" });
        assert.equal(shared.status, 200, JSON.stringify(shared.body));
      } finally { writes.mock.restore(); }
      assert.equal(planWrites, 2, "one plan and one project checkpoint");
    });

    await t.test("STALE-5: album cleanup handles EXDEV, persists failures and retries them", async () => {
      const root = path.join(alice.library, "AlbumCleanup");
      writeTree(root, { "theirs.jpg": "x", "busy.jpg": "y", "mine.jpg": "z" });
      const marker = { projectId: "prj_p07", serverUrl: "http://x", accountId: "acc", manifestDocId: "doc_man", sharedAt: new Date().toISOString(), kind: "album" as const, writer: "inst_alice_notebooks", folderId: "fld_p07" };
      await writeMarker(root, marker);
      const stats = statSync(root);
      const service = alice.service as unknown as {
        runAlbumCleanup(entry: unknown): Promise<void>;
        retryAlbumCleanups(): Promise<void>;
        lifecycleDirectory: string;
        started: boolean;
      };
      const entry = {
        version: 1, projectId: "prj_p07", manifestDocId: "doc_man", folderId: "fld_p07", writer: true, root,
        rootId: { dev: stats.dev, ino: stats.ino, birthtimeMs: stats.birthtimeMs },
        remove: ["theirs.jpg", "busy.jpg", "../escape"],
      };
      const originalRename = fs.rename;
      let busy = true;
      const rename = t.mock.method(fs, "rename", async (from: string, to: string) => {
        const source = String(from);
        if (path.dirname(source) === root) {
          if (path.basename(source) === "busy.jpg" && busy) throw Object.assign(new Error("busy"), { code: "EBUSY" });
          if (!String(to).startsWith(root)) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        return originalRename(from, to);
      });
      try {
        await service.runAlbumCleanup(entry);
        assert.ok(!existsSync(path.join(root, "theirs.jpg")), "a cross-volume photo is removed through a quarantine");
        assert.ok(!readdirSync(root).some((name) => name.startsWith(".libera-removing-")), "the quarantine is deleted");
        assert.ok(existsSync(path.join(root, "busy.jpg")), "a busy photo stays");
        assert.ok(existsSync(path.join(root, "mine.jpg")), "photos that are not listed are never touched");
        assert.ok(await readMarker(root), "the marker stays while cleanup is pending");
        const pending = readdirSync(path.join(service.lifecycleDirectory, "album-cleanup")).filter((name) => name.startsWith("pending-"));
        assert.equal(pending.length, 1, "the unfinished item is persisted");
        assert.deepEqual(JSON.parse(readFileSync(path.join(service.lifecycleDirectory, "album-cleanup", pending[0]), "utf8")).remove, ["busy.jpg"]);

        busy = false;
        await service.retryAlbumCleanups();
        assert.ok(!existsSync(path.join(root, "busy.jpg")), "a later tick removes it");
        assert.ok(!existsSync(path.join(root, ".libera-shared.json")), "the marker goes last");
        assert.ok(existsSync(path.join(root, "mine.jpg")));
        assert.equal(readdirSync(path.join(service.lifecycleDirectory, "album-cleanup")).filter((name) => name.startsWith("pending-")).length, 0);
      } finally { rename.mock.restore(); }
    });

    await t.test("STALE-5: a replaced album folder is not touched by a retry", async () => {
      const root = path.join(alice.library, "AlbumReplaced");
      writeTree(root, { "theirs.jpg": "x" });
      const marker = { projectId: "prj_p07b", serverUrl: "http://x", accountId: "acc", manifestDocId: "doc_man_b", sharedAt: new Date().toISOString(), kind: "album" as const, writer: "inst_alice_notebooks" };
      await writeMarker(root, marker);
      const stats = statSync(root);
      rmSync(root, { recursive: true });
      writeTree(root, { "theirs.jpg": "replacement" });
      await writeMarker(root, { ...marker, projectId: "prj_other" });
      const service = alice.service as unknown as { runAlbumCleanup(entry: unknown): Promise<void> };
      await service.runAlbumCleanup({
        version: 1, projectId: "prj_p07b", manifestDocId: "doc_man_b", writer: true, root,
        rootId: { dev: stats.dev, ino: stats.ino, birthtimeMs: stats.birthtimeMs }, remove: ["theirs.jpg"],
      });
      assert.equal(readFileSync(path.join(root, "theirs.jpg"), "utf8"), "replacement");
      assert.equal((await readMarker(root))?.projectId, "prj_other");
    });

    await t.test("DATA-17: a removed member records the binaries that never arrived", async () => {
      const root = path.join(alice.library, "Thesis");
      writeTree(root, { "note.md": "note\n", "img/pic.png": Buffer.from([9, 8, 7, 0, 6]), "img/two.png": Buffer.from([1, 1, 2, 0, 3]) });
      const shared = await alice.router.call("POST", ControlRoutes.share, { notebook: "Thesis" });
      assert.equal(shared.status, 200, JSON.stringify(shared.body));
      const { projectId } = shared.body as { projectId: string };
      const joined = await bob.router.call("POST", ControlRoutes.join, { invitation: await invite(server, aliceAuth, projectId, "bob@example.test", "editor") });
      assert.equal(joined.status, 200, JSON.stringify(joined.body));
      const bobRoot = path.join(bob.library, (joined.body as { notebook: string }).notebook);
      await until(() => existsSync(path.join(bobRoot, "img", "pic.png")) && existsSync(path.join(bobRoot, "img", "two.png")), "Bob's binaries");
      const runtime = bob.service.project(projectId)!;

      // The server can still supply a missing file: it is restored.
      rmSync(path.join(bobRoot, "img", "pic.png"));
      assert.deepEqual(await runtime.preserveBinariesAfterTakedown(), []);
      assert.deepEqual([...readFileSync(path.join(bobRoot, "img", "pic.png"))], [9, 8, 7, 0, 6]);

      // It cannot: exactly that file is reported, and nothing else.
      const download = t.mock.method(bob.host.api!, "downloadBlob", async () => { throw new Error("gone"); });
      try {
        rmSync(path.join(bobRoot, "img", "two.png"));
        assert.deepEqual(await runtime.preserveBinariesAfterTakedown(), ["img/two.png"]);
        // Alice removes Bob: the revocation records what is not current here.
        const removed = await fetch(`${server.url}/v1/projects/${projectId}/members/${bobAuth.account.id}`, { method: "DELETE", headers: { authorization: `Bearer ${aliceAuth.accessToken}` } });
        assert.ok(removed.status === 204 || removed.status === 200);
        const note = path.join(bobRoot, "_archive", "shared-takedown-incomplete-files.txt");
        await until(() => existsSync(note), "the incomplete-files note");
        const text = readFileSync(note, "utf8");
        assert.ok(text.includes("img/two.png") && !text.includes("img/pic.png"));
      } finally { download.mock.restore(); }
    });
  } finally {
    for (const peer of peers) await closePeer(peer).catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
