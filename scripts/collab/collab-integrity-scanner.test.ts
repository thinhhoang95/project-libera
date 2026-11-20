// Regressions for the 2026-11-20 collaboration integrity review, package H2
// (the host's scanner and outside changes): S39 respelled names, S40 rename
// plus edit, S41 uncertain absence, S42 explicit-rename rules, S43 folder
// moves, S44 retirement evidence, S49 a fair scan budget.

import assert from "node:assert/strict";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { readManifest } from "../../electron/collab/notebooks/layout";
import { retirementHashes } from "../../electron/collab/notebooks/project";
import { MAX_SKIPPED_PASSES, ScanFairness } from "../../electron/collab/notebooks/scan-fairness";
import { sha256 } from "../../electron/collab/notebooks/fs-ops";
import { closePeer, makePeer, register, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

interface Internals {
  retirePath(relative: string, hashes: string[]): void;
  retirementEvidence(relative: string): "none" | "hashes" | "unknown";
  sourceAbsence(record: unknown): Promise<"absent" | "present" | "uncertain">;
}

function manifestEntries(peer: Peer, projectId: string) {
  const manifestId = peer.service.project(projectId)!.info.manifestDocId;
  const hub = peer.host.acquire(manifestId);
  try { return [...readManifest(hub.getDoc("manifest")).values()]; } finally { peer.host.release(manifestId); }
}

const entryAt = (peer: Peer, projectId: string, name: string) => manifestEntries(peer, projectId).find((entry) => entry.path === name);

test("S49: files left out go first, and a failing path sits out a capped number of scans", () => {
  const fair = new ScanFairness();
  fair.beginPass();
  const names = ["a", "b", "c", "d"];
  assert.deepEqual(fair.order(names, (name) => name), names);
  fair.leftOut("c");
  fair.beginPass();
  fair.leftOut("d");
  assert.deepEqual(fair.order(names, (name) => name), ["c", "d", "a", "b"], "the oldest left-out file is served first, the rest keep their order");
  fair.failed("a");
  assert.equal(fair.skipped("a"), true, "a failed read sits out the next scan");
  fair.beginPass();
  fair.beginPass();
  assert.equal(fair.skipped("a"), false, "and comes back after it");
  for (let index = 0; index < 20; index += 1) fair.failed("a");
  for (let index = 0; index < MAX_SKIPPED_PASSES; index += 1) fair.beginPass();
  assert.equal(fair.skipped("a"), true, "the wait is counted in scans and capped, not a clock");
  fair.beginPass();
  fair.beginPass();
  assert.equal(fair.skipped("a"), false, "it is never starved for good");
  fair.served("a");
  fair.keepOnly(new Set(["c"]));
  assert.deepEqual(fair.order(["x", "c", "d"], (name) => name), ["c", "x", "d"], "entries of files that are gone are dropped");
});

test("S44: a follower's retirement keeps the manifest's and the shared text's hashes", () => {
  const record = { path: "a.md", kind: "doc" as const, docId: "doc_1" };
  assert.deepEqual(retirementHashes(record, undefined, null), [], "nothing known stays empty");
  const hashes = retirementHashes(record, { fileId: "fil_1", path: "a.md", kind: "blob", blobHash: "blobhash" } as never, "shared text");
  assert.ok(hashes.includes("blobhash"));
  assert.ok(hashes.includes(sha256(new TextEncoder().encode("shared text"))));
});

test("S39 to S44 through the host: outside renames keep identities and hold what is uncertain", { timeout: 240_000 }, async () => {
  const temp = tempRoot("libera-h2-scanner-");
  const server = await startServerProcess();
  let peer: Peer | undefined;
  try {
    const auth = await register(server, "ScannerH2");
    peer = await makePeer(temp.dir, "owner", server, auth, { timings: { pollMs: 50, importQuietMs: 200 } });
    const root = path.join(peer.library, "Fix");
    const original = "the first draft of a note that is long enough to recognise\nsecond line\n";
    writeTree(root, {
      "Photo.bin": "case spelling\n",
      "Café.bin": "normalization spelling\n",
      "Dir/x.bin": "x bytes\n", "Dir/y.bin": "y bytes\n",
      "a.md": original,
      "rec.mp3": "audio bytes", "rec.mp3.transcript": "{\"segments\":[]}",
      "Folder/f1.bin": "folder file one\n", "Folder/f2.bin": "folder file two\n",
      "u1.bin": "unique bytes one\n", "v1.bin": "unique bytes two\n",
    });
    const shared = await peer.service.share({ notebook: "Fix" });
    const projectId = shared.projectId;
    const project = peer.service.project(projectId)!;
    await project.whenIdle();
    const internals = project as unknown as Internals;
    const ids = (name: string) => entryAt(peer!, projectId, name)!.fileId;
    const photoId = ids("Photo.bin");
    const cafeId = ids("Café.bin");
    const xId = ids("Dir/x.bin");
    const aId = ids("a.md");
    const folderEntry = manifestEntries(peer, projectId).find((entry) => entry.kind === "folder" && entry.path === "Folder");
    const f1Id = ids("Folder/f1.bin");

    // S39: an outside case change and a Unicode normalization change become renames to the observed spelling, IDs kept.
    renameSync(path.join(root, "Photo.bin"), path.join(root, "photo.bin"));
    renameSync(path.join(root, "Café.bin"), path.join(root, "Café.bin"));
    renameSync(path.join(root, "Dir"), path.join(root, "dir"));
    await until(() => entryAt(peer!, projectId, "photo.bin")?.fileId === photoId, "the manifest takes the new case, same ID");
    await until(() => entryAt(peer!, projectId, "Café.bin")?.fileId === cafeId, "the manifest takes the new normalization, same ID");
    await until(() => entryAt(peer!, projectId, "dir/x.bin")?.fileId === xId, "a renamed parent folder carries its files, same IDs");
    assert.equal(manifestEntries(peer, projectId).filter((entry) => entry.path.toLowerCase() === "photo.bin").length, 1, "no second entry");

    // S40: a rename plus an edit holds both versions in a reconciliation and keeps the document's ID.
    renameSync(path.join(root, "a.md"), path.join(root, "b.md"));
    writeFileSync(path.join(root, "b.md"), `${original}an edit made outside\n`);
    await until(async () => (await project.reconciliations()).length === 1, "the renamed and edited note waits for the user");
    const [reconciliation] = await project.reconciliations();
    assert.ok(reconciliation.shared.includes("first draft") && !reconciliation.shared.includes("an edit made outside"), "the shared text is kept");
    assert.ok(reconciliation.disk.includes("an edit made outside"), "the disk text is kept");
    assert.equal(entryAt(peer, projectId, "b.md")?.fileId, aId, "the original identity moved to the new name");
    assert.equal(entryAt(peer, projectId, "a.md"), undefined, "no restored second identity");
    assert.ok(!existsSync(path.join(root, "a.md")), "the old path is not put back");

    // S42: a rename that an explicit rename would refuse (a recording that loses its transcript) is not a move.
    const recId = ids("rec.mp3");
    renameSync(path.join(root, "rec.mp3"), path.join(root, "rec.bin"));
    await until(() => entryAt(peer!, projectId, "rec.bin") !== undefined, "the new name is shared as its own file");
    await until(() => existsSync(path.join(root, "rec.mp3")), "the recording is put back");
    assert.equal(entryAt(peer, projectId, "rec.mp3")?.fileId, recId);
    assert.notEqual(entryAt(peer, projectId, "rec.bin")?.fileId, recId);
    assert.ok(entryAt(peer, projectId, "rec.mp3.transcript"), "the transcript stays with its recording");

    // S43: a whole folder moved outside is one folder rename, the folder entry's ID kept.
    renameSync(path.join(root, "Folder"), path.join(root, "Moved"));
    await until(() => entryAt(peer!, projectId, "Moved/f1.bin")?.fileId === f1Id, "the files keep their IDs");
    await project.whenIdle();
    const folders = manifestEntries(peer, projectId).filter((entry) => entry.kind === "folder" && (entry.path === "Folder" || entry.path === "Moved"));
    assert.equal(folders.length, 1, `one folder identity, not two: ${JSON.stringify(manifestEntries(peer, projectId).map((entry) => [entry.kind, entry.path]))}`);
    assert.equal(folders[0].path, "Moved");
    if (folderEntry) assert.equal(folders[0].fileId, folderEntry.fileId);
    assert.ok(!existsSync(path.join(root, "Folder")), "the old folder is not restored");

    // S41: when the old path's absence cannot be established, a byte match does not hand over the identity.
    const u1 = ids("u1.bin");
    let asked = 0;
    internals.sourceAbsence = async () => { asked += 1; return "uncertain"; };
    renameSync(path.join(root, "u1.bin"), path.join(root, "u2.bin"));
    await until(() => existsSync(path.join(root, "u1.bin")) && entryAt(peer!, projectId, "u2.bin") !== undefined, "after being held, the old path is put back and the new file imported");
    assert.ok(asked >= 3, `the pairing was held for several scans (asked ${asked})`);
    assert.equal(entryAt(peer, projectId, "u1.bin")?.fileId, u1);
    assert.notEqual(entryAt(peer, projectId, "u2.bin")?.fileId, u1);
    delete (internals as Partial<Internals>).sourceAbsence;
    const v1 = ids("v1.bin");
    renameSync(path.join(root, "v1.bin"), path.join(root, "v2.bin"));
    await until(() => entryAt(peer!, projectId, "v2.bin")?.fileId === v1, "with a clear absence the same bytes are a rename");

    // S44: a path retired with no history is named as such.
    internals.retirePath("nowhere.bin", []);
    assert.equal(internals.retirementEvidence("nowhere.bin"), "unknown");
    internals.retirePath("somewhere.bin", [sha256(new TextEncoder().encode("x"))]);
    assert.equal(internals.retirementEvidence("somewhere.bin"), "hashes");
    assert.equal(internals.retirementEvidence("never.bin"), "none");
  } finally {
    if (peer) await closePeer(peer);
    await server.stop(); removeDataDir(server.dataDir); temp.cleanup();
  }
});
