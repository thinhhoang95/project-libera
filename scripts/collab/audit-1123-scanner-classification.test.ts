// Regressions for the 2026-11-23 three-way sync review, package SC2 (scanner
// classification): C8 uncertain binary copies, H8 emptied folders and recent
// moves, M7 a recording moved with its transcript, M22 the path takeExternalEdit
// looks at.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { readManifest } from "../../electron/collab/notebooks/layout";
import { sha256 } from "../../electron/collab/notebooks/fs-ops";
import { ControlRoutes } from "../../src/lib/collab/local-api";
import { closePeer, makePeer, register, sleep, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

interface Internals {
  retirementEvidence(relative: string): "none" | "hashes" | "unknown";
  state: { layout: Record<string, { path: string; hash?: string; docId?: string; previous?: Array<{ hash: string; mtimeMs: number }> }> };
  docs: Map<string, unknown>;
  takeExternalEdit(runtime: unknown, record: unknown, disk: Uint8Array, diskHash: string, read?: { path: string; size: number; mtimeMs: number }): Promise<void>;
  writeManifest(fn: (files: { get(key: string): unknown; set(key: string, value: unknown): void }) => void, provenance: { source: string }): Promise<number>;
  uploadedBlobs: Map<string, Uint8Array>;
  info: { album?: boolean };
  scheduleManifest(ms: number): void;
}

function manifestEntries(peer: Peer, projectId: string) {
  const manifestId = peer.service.project(projectId)!.info.manifestDocId;
  const hub = peer.host.acquire(manifestId);
  try { return [...readManifest(hub.getDoc("manifest")).values()]; } finally { peer.host.release(manifestId); }
}
const entryAt = (peer: Peer, projectId: string, name: string) => manifestEntries(peer, projectId).find((entry) => entry.path === name);
const setTime = (file: string, ms: number) => utimesSync(file, ms / 1000, ms / 1000);

test("C8: an uncertain binary copy is the user's edit, never put back over", { timeout: 120_000 }, async () => {
  const temp = tempRoot("libera-1123-c8-");
  const server = await startServerProcess();
  let peer: Peer | undefined;
  try {
    const auth = await register(server, "C8Owner");
    peer = await makePeer(temp.dir, "owner", server, auth, { timings: { pollMs: 50, importQuietMs: 200 } });
    const root = path.join(peer.library, "Bin");
    writeTree(root, { "fig.bin": "version one bytes\n" });
    const shared = await peer.service.share({ notebook: "Bin" });
    const projectId = shared.projectId;
    const project = peer.service.project(projectId)!;
    await project.whenIdle();
    const file = path.join(root, "fig.bin");
    const v1 = sha256(Buffer.from("version one bytes\n"));
    const v2 = sha256(Buffer.from("version two bytes!\n"));
    writeFileSync(file, "version two bytes!\n");
    await until(() => entryAt(peer!, projectId, "fig.bin")?.blobHash === v2, "the edit is shared");
    await project.whenIdle();

    // A revert to an earlier version (new mtime) is the user's choice, shared as the new version.
    writeFileSync(file, "version one bytes\n");
    await until(() => entryAt(peer!, projectId, "fig.bin")?.blobHash === v1, "the revert is shared, not undone");
    await project.whenIdle();
    await sleep(400);
    assert.equal(readFileSync(file, "utf8"), "version one bytes\n", "the user's file stays");

    // A replacement that kept an older mtime (copied or extracted) is shared too.
    const v3 = sha256(Buffer.from("a third, copied in\n"));
    writeFileSync(file, "a third, copied in\n");
    setTime(file, statSync(file).mtimeMs - 3_600_000);
    await until(() => entryAt(peer!, projectId, "fig.bin")?.blobHash === v3, "the copied replacement is shared");
    await sleep(400);
    assert.equal(readFileSync(file, "utf8"), "a third, copied in\n");
  } finally {
    if (peer) await closePeer(peer);
    await server.stop(); removeDataDir(server.dataDir); temp.cleanup();
  }
});

test("C8: an album keeps bytes the shared album does not have", { timeout: 120_000 }, async () => {
  const temp = tempRoot("libera-1123-c8-album-");
  const server = await startServerProcess();
  let peer: Peer | undefined;
  try {
    const auth = await register(server, "C8Album");
    peer = await makePeer(temp.dir, "owner", server, auth, { timings: { pollMs: 50, importQuietMs: 5_000 } });
    const gallery = path.join(peer.library, "..", "..", "gallery", "Trip");
    writeTree(gallery, { "beach.jpg": Buffer.from("not really a jpeg, but an album blob") });
    const result = await peer.router.call("POST", ControlRoutes.albumShare, { folder: "Trip", name: "Trip", photos: [{ name: "beach.jpg" }] });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const projectId = (result.body as { projectId: string }).projectId;
    const project = peer.service.project(projectId)!;
    await project.whenIdle();
    const internals = project as unknown as Internals;
    assert.equal(internals.info.album, true);
    const entry = manifestEntries(peer, projectId).find((item) => item.kind === "blob")!;
    const file = path.join(gallery, entry.path);
    // The member's own replacement is on disk, unshared; the album then moves to a newer blob.
    const mine = Buffer.from("the user's own replacement photo");
    writeFileSync(file, mine);
    const newer = Buffer.from("a newer photo from another member");
    const newerHash = sha256(newer);
    internals.uploadedBlobs.set(newerHash, newer);
    await internals.writeManifest((files) => { files.set(entry.fileId, { ...(files.get(entry.fileId) as object), blobHash: newerHash, size: newer.byteLength }); }, { source: "typing" });
    internals.scheduleManifest(0);
    await sleep(1500);
    await project.whenIdle();
    assert.ok(existsSync(file), "the file was not deleted");
    assert.equal(readFileSync(file).toString(), mine.toString(), "bytes the album never had are not removed");
  } finally {
    if (peer) await closePeer(peer);
    await server.stop(); removeDataDir(server.dataDir); temp.cleanup();
  }
});

test("H8, M7 and M22 through the host", { timeout: 240_000 }, async () => {
  const temp = tempRoot("libera-1123-scanner-");
  const server = await startServerProcess();
  let peer: Peer | undefined;
  try {
    const auth = await register(server, "SC2Owner");
    peer = await makePeer(temp.dir, "owner", server, auth, { timings: { pollMs: 50, importQuietMs: 200 } });
    const root = path.join(peer.library, "Fix");
    writeTree(root, {
      "Keep/only.bin": "the only file of a folder that is kept\n",
      "Other/placeholder.bin": "other folder file\n",
      "FolderA/f1.bin": "folder A file one\n", "FolderA/f2.bin": "folder A file two\n", "FolderA/f3.bin": "folder A file three\n",
      "Rec/rec.mp3": "audio bytes of the recording", "Rec/rec.mp3.transcript": "{\"segments\":[]}",
      "note.md": "the note, first version\n",
    });
    const shared = await peer.service.share({ notebook: "Fix" });
    const projectId = shared.projectId;
    const project = peer.service.project(projectId)!;
    await project.whenIdle();
    const internals = project as unknown as Internals;
    const folderId = (name: string) => manifestEntries(peer!, projectId).find((entry) => entry.kind === "folder" && entry.path === name)!.fileId;

    // H8: the last file dragged into another folder; the emptied folder is kept on disk and in the manifest.
    const keepId = folderId("Keep");
    renameSync(path.join(root, "Keep/only.bin"), path.join(root, "Other/only.bin"));
    await until(() => entryAt(peer!, projectId, "Other/only.bin") !== undefined, "the file's new place is shared");
    await project.whenIdle();
    await sleep(800);
    assert.equal(entryAt(peer, projectId, "Keep")?.fileId, keepId, "the kept folder keeps its entry");
    assert.ok(existsSync(path.join(root, "Keep")), "and its directory");

    // H8: an earlier move out of a folder does not stop the folder from being renamed later.
    const aId = folderId("FolderA");
    renameSync(path.join(root, "FolderA/f1.bin"), path.join(root, "f1-out.bin"));
    await until(() => entryAt(peer!, projectId, "f1-out.bin") !== undefined, "the earlier move is paired");
    await project.whenIdle();
    renameSync(path.join(root, "FolderA"), path.join(root, "FolderB"));
    await until(() => entryAt(peer!, projectId, "FolderB/f2.bin") !== undefined, "the files follow the folder");
    await project.whenIdle();
    await sleep(600);
    assert.equal(entryAt(peer, projectId, "FolderB")?.fileId, aId, "the renamed folder keeps its identity");
    assert.equal(entryAt(peer, projectId, "FolderA"), undefined, "no second folder identity");
    assert.ok(!existsSync(path.join(root, "FolderA")), "the old folder is not restored");

    // M7: a recording moved together with its transcript outside Libera.
    const transcriptId = entryAt(peer, projectId, "Rec/rec.mp3.transcript")!.fileId;
    // The scan pairs files in layout order; the recording goes first so its companion move precedes the transcript's own pairing.
    const recordingId = entryAt(peer, projectId, "Rec/rec.mp3")!.fileId;
    internals.state.layout = { [recordingId]: internals.state.layout[recordingId], ...internals.state.layout };
    mkdirSync(path.join(root, "Rec2"));
    renameSync(path.join(root, "Rec/rec.mp3"), path.join(root, "Rec2/rec.mp3"));
    renameSync(path.join(root, "Rec/rec.mp3.transcript"), path.join(root, "Rec2/rec.mp3.transcript"));
    await until(() => entryAt(peer!, projectId, "Rec2/rec.mp3.transcript")?.fileId === transcriptId, "the transcript keeps its identity at the new path");
    await project.whenIdle();
    await sleep(600);
    assert.equal(internals.retirementEvidence("Rec2/rec.mp3.transcript"), "none", "the live transcript path is not retired");
    assert.ok(existsSync(path.join(root, "Rec2/rec.mp3.transcript")));
    assert.equal(internals.state.layout[transcriptId].path, "Rec2/rec.mp3.transcript");

    // M22: the guards look at the file that was read, not at the record's path.
    const noteId = entryAt(peer, projectId, "note.md")!.fileId;
    const note = path.join(root, "note.md");
    const first = "the note, first version\n";
    const firstMtime = statSync(note).mtimeMs;
    writeFileSync(note, "the note, second version\n");
    setTime(note, firstMtime + 10_000);
    await until(() => (internals.state.layout[noteId].previous ?? []).some((item) => item.hash === sha256(Buffer.from(first))), "the edit is taken in");
    await project.whenIdle();
    const record = internals.state.layout[noteId];
    const runtime = internals.docs.get(record.docId as string);
    assert.ok(runtime, "the document is open");
    const respelled = path.join(root, "Note-copy.md");
    writeFileSync(respelled, first);
    const hubText = () => (runtime as { hub: { getText(name: string): string } }).hub.getText("content");
    assert.equal(hubText(), "the note, second version\n");
    await internals.takeExternalEdit(runtime, record, Buffer.from(first), sha256(Buffer.from(first)), { path: "Note-copy.md", size: first.length, mtimeMs: firstMtime });
    assert.equal(hubText(), "the note, second version\n", "an older copy read under another spelling is not taken as an edit");
    assert.equal(readFileSync(respelled, "utf8"), "the note, second version\n", "the file that was read gets the current text back");
  } finally {
    if (peer) await closePeer(peer);
    await server.stop(); removeDataDir(server.dataDir); temp.cleanup();
  }
});
