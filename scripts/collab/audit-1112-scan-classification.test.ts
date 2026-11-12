// Regressions for the 2026-11-12 sync audit's scan-classification findings:
// STALE-7 (unknown bytes at a retired path), DATA-4 (SQLite families),
// SYNC-3 (watcher/scan exclusions) and SYNC-5 (multi-hyphen device copies).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { readManifest } from "../../electron/collab/notebooks/layout";
import { isActiveSqliteDatabase, isExcludedPath, isIgnoredName, isShareablePath } from "../../electron/collab/notebooks/fs-ops";
import { closePeer, makePeer, register, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

test("SYNC-3: the watcher predicate covers every scan exclusion, including excluded ancestors", () => {
  for (const excluded of [".libera/collab/state.json", ".git/HEAD", "_archive/old.md", "_Archive/x/y.md", "sub/.DS_Store", "a/Thumbs.db", "a/~$lock.docx", "a/b.md.123.abcd.tmp", "sub/.hidden/file.md", "~$x"]) {
    assert.ok(isExcludedPath(excluded), `${excluded} is excluded`);
  }
  for (const kept of ["note.md", "sub/note.md", "sub/_archive/note.md", "paper.aux", "data.db"]) {
    assert.ok(!isExcludedPath(kept), `${kept} is not excluded`);
  }
});

test("DATA-4: SQLite sidecars are never shareable and an open database is detected", () => {
  for (const name of ["app.db-wal", "app.db-shm", "app.sqlite-journal", "x.SQLITE3-WAL"]) {
    assert.ok(isIgnoredName(name), `${name} is ignored`);
    assert.ok(!isShareablePath(`sub/${name}`), `${name} is not shareable`);
  }
  assert.ok(!isIgnoredName("my-journal.md"));
  assert.ok(isShareablePath("app.db"));
  const temp = tempRoot("libera-sqlite-");
  try {
    writeFileSync(path.join(temp.dir, "closed.db"), "x");
    writeFileSync(path.join(temp.dir, "open.db"), "x");
    writeFileSync(path.join(temp.dir, "open.db-wal"), "x");
    mkdirSync(path.join(temp.dir, "sub"));
    writeFileSync(path.join(temp.dir, "sub", "j.sqlite"), "x");
    writeFileSync(path.join(temp.dir, "sub", "j.sqlite-journal"), "x");
    assert.equal(isActiveSqliteDatabase(temp.dir, "closed.db"), false);
    assert.equal(isActiveSqliteDatabase(temp.dir, "open.db"), true);
    assert.equal(isActiveSqliteDatabase(temp.dir, "sub/j.sqlite"), true);
    assert.equal(isActiveSqliteDatabase(temp.dir, "open.db-wal"), false);
  } finally { temp.cleanup(); }
});

test("STALE-7 and SYNC-5 and DATA-4 through the host", { timeout: 90_000 }, async () => {
  const temp = tempRoot("libera-scan-classification-");
  const server = await startServerProcess();
  let peer: Peer | undefined;
  try {
    const auth = await register(server, "ScanClass");
    peer = await makePeer(temp.dir, "owner", server, auth, { timings: { pollMs: 50 } });
    const root = path.join(peer.library, "Scan");
    writeTree(root, { "note.md": "first\n", "gone.md": "gone v1\n", "other.md": "other v1\n" });
    const shared = await peer.service.share({ notebook: "Scan" });
    const project = peer.service.project(shared.projectId)!;
    await project.whenIdle();
    writeFileSync(path.join(root, "note.md"), "second\n");
    await until(async () => { await project.whenIdle(); return readFileSync(path.join(root, "note.md"), "utf8") === "second\n" && peer!.service.resolvePath("Scan/note.md") !== null; }, "edit imported");
    await sleepUntilHash(peer, "Scan/note.md", "second\n");

    // STALE-7: bytes the remembered history has never seen, at a deleted path.
    await peer.service.fileOp(shared.projectId, { op: "delete", path: "gone.md" });
    await project.whenIdle();
    // A sync client keeps the version's original mtime; a person's new file has a fresh one.
    writeFileSync(path.join(root, "gone.md"), "an older version nobody remembers\n");
    utimesSync(path.join(root, "gone.md"), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    await until(() => !existsSync(path.join(root, "gone.md")), "unknown bytes at a retired path set aside");
    assert.equal(peer.service.resolvePath("Scan/gone.md"), null);
    assert.ok(readdirSync(path.join(root, "_archive")).some((name) => name.startsWith("gone")), "kept in _archive, not deleted");
    await peer.service.fileOp(shared.projectId, { op: "create-file", path: "gone.md", content: "explicit\n" });
    assert.equal(readFileSync(path.join(root, "gone.md"), "utf8"), "explicit\n");
    // A person's later new file at another retired path (fresh mtime) is still shared.
    await peer.service.fileOp(shared.projectId, { op: "delete", path: "other.md" });
    await project.whenIdle();
    writeFileSync(path.join(root, "other.md"), "a different note written after the delete\n");
    await until(() => peer!.service.resolvePath("Scan/other.md") !== null, "new bytes written after the delete are shared");

    // SYNC-5: OneDrive's name-COMPUTER-NAME copy of an earlier version.
    writeFileSync(path.join(root, "note-DESKTOP-ABC123.md"), "first\n");
    await until(() => existsSync(path.join(root, "_archive", "note-DESKTOP-ABC123.md")), "multi-hyphen device copy set aside");
    assert.equal(peer.service.resolvePath("Scan/note-DESKTOP-ABC123.md"), null);

    // DATA-4: an open database and its sidecars stay out; a closed one is shared.
    writeFileSync(path.join(root, "live.db"), "SQLite format 3\0live");
    writeFileSync(path.join(root, "live.db-wal"), "wal");
    writeFileSync(path.join(root, "live.db-shm"), "shm");
    writeFileSync(path.join(root, "closed.db"), "SQLite format 3\0closed");
    await until(() => manifestPaths(peer!, shared.projectId).includes("closed.db"), "closed database shared");
    await project.whenIdle();
    for (const name of ["live.db", "live.db-wal", "live.db-shm"]) {
      assert.ok(!manifestPaths(peer, shared.projectId).includes(name), `${name} is not shared`);
      assert.ok(existsSync(path.join(root, name)), `${name} stays on disk`);
    }
  } finally {
    if (peer) await closePeer(peer);
    await server.stop(); removeDataDir(server.dataDir); temp.cleanup();
  }
});

async function sleepUntilHash(peer: Peer, notebookPath: string, text: string): Promise<void> {
  await until(() => {
    const resolved = peer.service.resolvePath(notebookPath);
    if (!resolved) return false;
    const hub = peer.host.acquire(resolved.docId);
    try { return hub.getText("content") === text; } finally { peer.host.release(resolved.docId); }
  }, "shared text to take the edit");
}

function manifestPaths(peer: Peer, projectId: string): string[] {
  const manifestId = peer.service.project(projectId)!.info.manifestDocId;
  const hub = peer.host.acquire(manifestId);
  try { return [...readManifest(hub.getDoc("manifest")).values()].map((entry) => entry.path); } finally { peer.host.release(manifestId); }
}
