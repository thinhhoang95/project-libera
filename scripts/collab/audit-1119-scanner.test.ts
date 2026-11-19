// Regressions for the 2026-11-19 sync audit's scanner findings 12, 19, 22,
// 28 (scan parts) and 34.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { readManifest } from "../../electron/collab/notebooks/layout";
import { sha256, WriteCancelledError } from "../../electron/collab/notebooks/fs-ops";
import { readShared } from "../../electron/collab/notebooks/scan-reads";
import { ControlRoutes, type LocalAlbum, type ShareAlbumResult } from "../../src/lib/collab/local-api";
import { manifestNewNameError, manifestPathError } from "../../src/lib/collab/protocol/schema";
import { assertSafeSegment, sidecarName } from "../../src/lib/storage/paths";
import { closePeer, makePeer, register, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

/** A structurally valid JPEG with an EXIF block holding a stand-in for GPS data (as in albums-host.test.ts). */
function jpegWithExif(marker: string): Buffer {
  const exif = Buffer.concat([
    Buffer.from("Exif\0\0", "binary"),
    Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 6, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from(`GPS:${marker}`, "binary"),
  ]);
  const segment = (code: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, code, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe1, exif),
    segment(0xdb, Buffer.from([0x00, ...new Array(64).fill(1)])),
    segment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])),
    Buffer.from(`image-data-${marker}`, "binary"),
    Buffer.from([0xff, 0xd9]),
  ]);
}

interface Internals {
  retirePath(relative: string, hashes: string[]): void;
  stripForUpload(absolute: string, relative: string, bytes: Uint8Array): Promise<unknown>;
}

function manifestEntries(peer: Peer, projectId: string) {
  const manifestId = peer.service.project(projectId)!.info.manifestDocId;
  const hub = peer.host.acquire(manifestId);
  try { return [...readManifest(hub.getDoc("manifest")).values()]; } finally { peer.host.release(manifestId); }
}

const manifestPaths = (peer: Peer, projectId: string) => manifestEntries(peer, projectId).map((entry) => entry.path);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("finding 28: a read of a file whose stat moved is not trusted", async () => {
  const temp = tempRoot("libera-1119-reads-");
  try {
    const file = path.join(temp.dir, "same-length.bin");
    writeFileSync(file, "aaaa");
    const stats = statSync(file);
    // Same length, but the file is not what the observation described.
    assert.equal(typeof await readShared(file, 1000, { size: stats.size, mtimeMs: stats.mtimeMs }), "object");
    const other = path.join(temp.dir, "moved.bin");
    writeFileSync(other, "bbbb");
    const before = statSync(other);
    const result = await readShared(other, 1000, { size: before.size, mtimeMs: before.mtimeMs - 5000 });
    assert.equal(typeof result, "symbol", "a changed mtime rejects the read");
  } finally { temp.cleanup(); }
});

test("finding 22: names compare and trim by one rule", () => {
  assert.equal(assertSafeSegment("  lead.md  ", "File"), "  lead.md", "leading whitespace is part of a manifest name; only the end is trimmed");
  assert.equal(manifestPathError("  lead.md"), null);
  assert.throws(() => assertSafeSegment("   ", "File"));
  const full = `${"a".repeat(251)}.md`;
  assert.equal(manifestPathError(full), null, "an existing name at the limit stays valid");
  assert.ok(manifestNewNameError(full), "a new name needs room for its sidecar suffix");
  assert.equal(manifestNewNameError(`${"a".repeat(230)}.md`), null);
  assert.throws(() => sidecarName(full), /too long/);
  assert.equal(sidecarName("a.md"), "a.md.json");
});

test("findings 12, 19, 22, 28 and 34 through the host", { timeout: 180_000 }, async () => {
  const temp = tempRoot("libera-1119-scanner-");
  const server = await startServerProcess();
  let peer: Peer | undefined;
  try {
    const auth = await register(server, "Scanner1119");
    peer = await makePeer(temp.dir, "owner", server, auth, { timings: { pollMs: 50, importQuietMs: 200 } });
    const root = path.join(peer.library, "Scan");
    const sharedBytes = "identical bytes for the rename tests\n";
    writeTree(root, {
      "p.bin": sharedBytes, "q.bin": sharedBytes,
      "Photo.bin": "case spelling test\n",
      "rec.mp3": "audio one", "rec.mp3.transcript": "{\"segments\":[]}",
      "gone.md": "gone v1\n",
      "closed.db": "SQLite format 3\0v1",
      "open.db": "SQLite format 3\0open", "open.db-wal": "wal",
      "m.bin": "m one",
    });
    const shared = await peer.service.share({ notebook: "Scan" });
    const projectId = shared.projectId;
    const project = peer.service.project(projectId)!;
    await project.whenIdle();
    const internals = project as unknown as Internals;

    // 34: initial share skips an open database; the closed one is shared.
    assert.ok(manifestPaths(peer, projectId).includes("closed.db"));
    assert.ok(!manifestPaths(peer, projectId).includes("open.db"), "an open database is not read by the initial share");

    // 34: a shared database that is opened later is not re-uploaded.
    const closedHash = manifestEntries(peer, projectId).find((entry) => entry.path === "closed.db")!.blobHash;
    writeFileSync(path.join(root, "closed.db-wal"), "wal");
    writeFileSync(path.join(root, "closed.db"), "SQLite format 3\0v2 half written");
    await pause(1500);
    await project.whenIdle();
    assert.equal(manifestEntries(peer, projectId).find((entry) => entry.path === "closed.db")!.blobHash, closedHash, "an open database keeps its last consistent snapshot");
    rmSync(path.join(root, "closed.db-wal"));
    await until(() => manifestEntries(peer!, projectId).find((entry) => entry.path === "closed.db")!.blobHash !== closedHash, "the closed database is uploaded afterwards");

    // 22: the same name in another case is not a move.
    renameSync(path.join(root, "Photo.bin"), path.join(root, "photo-tmp.bin"));
    renameSync(path.join(root, "photo-tmp.bin"), path.join(root, "photo.bin"));
    await pause(1500);
    await project.whenIdle();
    const photo = manifestPaths(peer, projectId).filter((name) => name.toLowerCase() === "photo.bin");
    assert.deepEqual(photo, ["Photo.bin"], "the manifest keeps its spelling and gains no second entry");

    // 12: unknown bytes with an old mtime at a retired notebook path are a new file.
    await peer.service.fileOp(projectId, { op: "delete", path: "gone.md" });
    await project.whenIdle();
    writeFileSync(path.join(root, "gone.md"), "an older-looking file someone copied in\n");
    utimesSync(path.join(root, "gone.md"), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    await until(() => peer!.service.resolvePath("Scan/gone.md") !== null, "bytes the retired entry never had are shared, whatever their mtime");

    // 19: a rename is inferred only when unambiguous. p.bin and q.bin hold the same bytes.
    rmSync(path.join(root, "p.bin"));
    writeFileSync(path.join(root, "r.bin"), sharedBytes);
    await until(() => manifestPaths(peer!, projectId).includes("r.bin"), "the new file is shared");
    await until(() => existsSync(path.join(root, "p.bin")), "the missing original is restored, not renamed away");
    const names = manifestPaths(peer, projectId);
    assert.ok(names.includes("p.bin") && names.includes("q.bin") && names.includes("r.bin"), `three entries: ${names.join(",")}`);

    // 19: an unambiguous audio rename takes its transcript along.
    assert.ok(manifestPaths(peer, projectId).includes("rec.mp3.transcript"));
    renameSync(path.join(root, "rec.mp3"), path.join(root, "rec2.mp3"));
    await until(() => manifestPaths(peer!, projectId).includes("rec2.mp3"), "the recording is renamed");
    await until(() => manifestPaths(peer!, projectId).includes("rec2.mp3.transcript"), "its transcript follows");
    assert.ok(!manifestPaths(peer, projectId).includes("rec.mp3.transcript"));

    // 28: bytes that change while the upload is in flight are not published under the old hash.
    const api = peer.host.api!;
    const upload = api.uploadBlob.bind(api);
    const first = Buffer.from("m two, the version the scan hashed");
    const second = Buffer.from("m three, written during the upload!");
    let interfered = false;
    api.uploadBlob = async (...args: Parameters<typeof upload>) => {
      const result = await upload(...args);
      if (!interfered && Buffer.from(args[1] as Uint8Array).equals(first)) {
        interfered = true;
        writeFileSync(path.join(root, "m.bin"), second);
      }
      return result;
    };
    const mId = manifestEntries(peer, projectId).find((entry) => entry.path === "m.bin")!.fileId;
    const seenHashes = new Set<string>();
    const manifestHub = peer.host.acquire(project.info.manifestDocId);
    const watch = () => { const hash = readManifest(manifestHub.getDoc("manifest")).get(mId)?.blobHash; if (hash) seenHashes.add(hash); };
    manifestHub.getDoc("manifest").on("update", watch);
    writeFileSync(path.join(root, "m.bin"), first);
    await until(() => interfered, "the upload ran");
    await until(() => manifestEntries(peer!, projectId).find((entry) => entry.path === "m.bin")!.blobHash === sha256(second), "the later bytes are what is published");
    assert.ok(!seenHashes.has(sha256(first)), "the stale snapshot's hash was never published");
    manifestHub.getDoc("manifest").off("update", watch);
    peer.host.release(project.info.manifestDocId);

    // 12 (notebook): a file already retired with these bytes is still set aside.
    const known = Buffer.from("these bytes were removed\n");
    internals.retirePath("dropped.bin", [sha256(known)]);
    writeFileSync(path.join(root, "dropped.bin"), known);
    await until(() => existsSync(path.join(root, "_archive", "dropped.bin")), "a returning removed file is archived");
  } finally {
    if (peer) await closePeer(peer);
    await server.stop(); removeDataDir(server.dataDir); temp.cleanup();
  }
});

test("finding 12: albums delete only bytes known to be a retired version", { timeout: 120_000 }, async () => {
  const temp = tempRoot("libera-1119-album-");
  const server = await startServerProcess();
  let peer: Peer | undefined;
  try {
    const auth = await register(server, "Album1119");
    peer = await makePeer(temp.dir, "owner", server, auth, { timings: { pollMs: 50, importQuietMs: 200 } });
    const gallery = path.join(peer.library, "..", "..", "gallery", "Trip");
    mkdirSync(gallery, { recursive: true });
    writeFileSync(path.join(gallery, "beach.jpg"), jpegWithExif("beach"));
    const response = await peer.router.call("POST", ControlRoutes.albumShare, { folder: "Trip", name: "Trip", photos: [{ name: "beach.jpg" }] });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const projectId = (response.body as ShareAlbumResult).projectId;
    const project = peer.service.project(projectId)!;
    await project.whenIdle();
    const internals = project as unknown as Internals;
    const albumPhotos = async () => ((await peer!.router.call("GET", ControlRoutes.albums)).body as LocalAlbum[])[0].photos.map((photo) => photo.name);

    // Different bytes, an old mtime, a retired name: a new photo, never deleted.
    internals.retirePath("old.jpg", [sha256(jpegWithExif("retired version"))]);
    writeFileSync(path.join(gallery, "old.jpg"), jpegWithExif("a different photo"));
    utimesSync(path.join(gallery, "old.jpg"), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    await until(async () => (await albumPhotos()).includes("old.jpg"), "the photo copied under a retired name is imported");
    assert.ok(existsSync(path.join(gallery, "old.jpg")));

    // The retired version itself coming back is removed.
    const retired = jpegWithExif("retired again");
    internals.retirePath("late.jpg", [sha256(retired)]);
    writeFileSync(path.join(gallery, "late.jpg"), retired);
    await until(() => !existsSync(path.join(gallery, "late.jpg")), "a late copy of the retired bytes is deleted");

    // The metadata rewrite is fenced on the bytes that were read.
    const absolute = path.join(gallery, "swapped.jpg");
    const current = jpegWithExif("changed since the read");
    writeFileSync(absolute, current);
    await assert.rejects(internals.stripForUpload(absolute, "swapped.jpg", jpegWithExif("what was read")), WriteCancelledError);
    assert.deepEqual(readFileSync(absolute), current, "a file changed after the read is never replaced");
  } finally {
    if (peer) await closePeer(peer);
    await server.stop(); removeDataDir(server.dataDir); temp.cleanup();
  }
});
