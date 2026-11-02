import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { FetchLike } from "../../electron/collab/core";
import { walkNotebook } from "../../electron/collab/notebooks/fs-ops";
import { invalidateSharedNotebookCache, sharedNotebookMarker } from "../../src/lib/collab/shared-notebook";
import { updateMarkdownFile } from "../../src/lib/storage/files";
import { deleteNotebook } from "../../src/lib/storage/notebooks";
import { ManifestKeys, type ManifestEntry } from "../../src/lib/collab/protocol/schema";
import { closePeer, makePeer, readText, register, sleep, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

const MARKER = ".libera-shared.json";

async function withStorage(peer: Peer, body: () => Promise<void>): Promise<void> {
  const data = process.env.LIBERA_DATA_DIR;
  const lifecycle = process.env.LIBERA_COLLAB_LIFECYCLE_DIR;
  process.env.LIBERA_DATA_DIR = path.resolve(peer.library, "../..");
  process.env.LIBERA_COLLAB_LIFECYCLE_DIR = peer.service.lifecycleDirectory;
  invalidateSharedNotebookCache();
  try { await body(); }
  finally {
    if (data === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = data;
    if (lifecycle === undefined) delete process.env.LIBERA_COLLAB_LIFECYCLE_DIR; else process.env.LIBERA_COLLAB_LIFECYCLE_DIR = lifecycle;
    invalidateSharedNotebookCache();
  }
}

test("confirmed takedown survives restart and does not authorize writes to a new share at the same root", { timeout: 60_000 }, async () => {
  const temp = tempRoot("libera-lifecycle-ledger-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const auth = await register(server, "LedgerOwner");
    let owner = await makePeer(temp.dir, "owner", server, auth);
    peers.push(owner);
    const root = path.join(owner.library, "Ledger");
    writeTree(root, { "note.md": "shared\n" });
    const original = await owner.service.share({ notebook: "Ledger" });
    const savedMarker = readFileSync(path.join(root, MARKER));
    await owner.service.takeDown(original.projectId);
    await closePeer(owner);
    // The host is stopped: Next must consult durable local confirmation,
    // without depending on a poll repairing the newly delivered old marker.
    writeFileSync(path.join(root, MARKER), savedMarker);
    await withStorage(owner, async () => {
      assert.equal(sharedNotebookMarker("Ledger"), null);
      await updateMarkdownFile("Ledger/note.md", "now local\n");
      assert.equal(readText(root, "note.md"), "now local\n");
    });
    owner = await makePeer(temp.dir, "owner", server, auth);
    peers.push(owner);
    assert.equal(existsSync(path.join(root, MARKER)), false, "startup repairs the stale cloud marker too");
    const next = await owner.service.share({ notebook: "Ledger" });
    assert.notEqual(next.projectId, original.projectId);
    await withStorage(owner, async () => {
      assert.equal(sharedNotebookMarker("Ledger")?.projectId, next.projectId);
      await assert.rejects(updateMarkdownFile("Ledger/note.md", "must be guarded"), /shared-document/);
      await assert.rejects(deleteNotebook("Ledger"), /shared-document/);
      const currentMarker = readFileSync(path.join(root, MARKER));
      writeFileSync(path.join(root, MARKER), savedMarker);
      invalidateSharedNotebookCache();
      await assert.rejects(updateMarkdownFile("Ledger/note.md", "old marker must not unlock the new project"), /shared-document/);
      // A newer active local binding prevents cleanup for an older identity
      // from deleting the marker and opening the ordinary storage path.
      await (owner!.service as unknown as { tick(): Promise<void> }).tick();
      await assert.rejects(deleteNotebook("Ledger"), /shared-document/);
      assert.equal(readText(root, "note.md"), "now local\n");
      writeFileSync(path.join(root, MARKER), currentMarker);
      invalidateSharedNotebookCache();
    });
  } finally {
    for (const peer of peers.reverse()) await closePeer(peer);
    await server.stop(); removeDataDir(server.dataDir); temp.cleanup();
  }
});

test("quarantined state retains its exact input while healthy notebooks start", { timeout: 60_000 }, async () => {
  const temp = tempRoot("libera-corrupt-state-recovery-");
  const server = await startServerProcess();
  let owner: Peer | undefined;
  try {
    const auth = await register(server, "StateRecovery");
    owner = await makePeer(temp.dir, "owner", server, auth);
    writeTree(path.join(owner.library, "A-broken"), { "note.md": "retained\n" });
    writeTree(path.join(owner.library, "Z-healthy"), { "note.md": "healthy\n" });
    const broken = await owner.service.share({ notebook: "A-broken" });
    const healthy = await owner.service.share({ notebook: "Z-healthy" });
    await owner.service.stop();
    const directory = path.join(owner.library, "A-broken", ".libera/collab");
    const bytes = Buffer.from('{"version":1,"layout":{"bad":null},"reconciliations":[]}');
    writeFileSync(path.join(directory, "state.json"), bytes);
    await owner.service.start();
    const copies = readdirSync(directory).filter((name) => name.startsWith("state.json.invalid-"));
    assert.equal(copies.length, 1);
    assert.deepEqual(readFileSync(path.join(directory, copies[0])), bytes);
    assert.ok(owner.service.project(healthy.projectId));
    await until(() => owner!.service.resolvePath("A-broken/note.md") !== null, "rebuilt baseline");
    await owner.service.project(broken.projectId)!.whenIdle();
    assert.equal(readText(path.join(owner.library, "A-broken"), "note.md"), "retained\n");
  } finally {
    if (owner) await closePeer(owner);
    await server.stop(); removeDataDir(server.dataDir); temp.cleanup();
  }
});

test("independent legacy copies without folder IDs converge on one writer lease", { timeout: 60_000 }, async () => {
  const temp = tempRoot("libera-legacy-lease-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const auth = await register(server, "LegacyLease");
    const source = await makePeer(temp.dir, "source", server, auth);
    peers.push(source);
    const root = path.join(source.library, "Legacy");
    writeTree(root, { "note.md": "one writer\n" });
    const shared = await source.service.share({ notebook: "Legacy" });
    await source.service.project(shared.projectId)!.whenIdle();
    await closePeer(source);
    const legacy = JSON.parse(readFileSync(path.join(root, MARKER), "utf8"));
    delete legacy.folderId;
    delete legacy.writer;
    const libraries = ["legacy-a", "legacy-b"].map((name) => path.join(temp.dir, name));
    for (const library of libraries) {
      mkdirSync(library);
      cpSync(root, path.join(library, "Legacy"), { recursive: true });
      writeFileSync(path.join(library, "Legacy", MARKER), JSON.stringify(legacy));
    }
    const a = await makePeer(temp.dir, "legacy-a", server, auth, { library: libraries[0] });
    peers.push(a);
    const b = await makePeer(temp.dir, "legacy-b", server, auth, { library: libraries[1] });
    peers.push(b);
    const marker = (library: string) => JSON.parse(readFileSync(path.join(library, "Legacy", MARKER), "utf8"));
    assert.equal(marker(libraries[0]).folderId, marker(libraries[1]).folderId);
    assert.equal(a.service.project(shared.projectId)!.follower, false);
    assert.equal(b.service.project(shared.projectId)!.follower, true);
  } finally {
    for (const peer of peers.reverse()) await closePeer(peer);
    await server.stop(); removeDataDir(server.dataDir); temp.cleanup();
  }
});

test("periodic content verification catches an overwrite without watch events or changed stats", { timeout: 60_000 }, async () => {
  const temp = tempRoot("libera-periodic-content-");
  const server = await startServerProcess();
  let owner: Peer | undefined;
  try {
    const auth = await register(server, "PeriodicVerify");
    owner = await makePeer(temp.dir, "owner", server, auth, { timings: { pollMs: 40, verifyMs: 250 } });
    const root = path.join(owner.library, "Periodic");
    writeTree(root, { "note.md": "AAAA\n" });
    const file = path.join(root, "note.md");
    const settled = Math.floor((Date.now() - 20_000) / 2000) * 2000;
    utimesSync(file, settled / 1000, settled / 1000);
    const shared = await owner.service.share({ notebook: "Periodic" });
    const project = owner.service.project(shared.projectId)!;
    await project.whenIdle();
    const internals = project as unknown as {
      watcher: { close(): void } | null;
      walk: () => ReturnType<typeof walkNotebook>;
      enqueue(task: () => Promise<void>): Promise<void>;
      scan(): Promise<void>;
    };
    internals.watcher?.close();
    internals.watcher = null;
    const before = statSync(file);
    internals.walk = async () => {
      const walked = await walkNotebook(root);
      for (const entry of walked.entries) if (entry.relative === "note.md") entry.ctimeMs = before.ctimeMs;
      return walked;
    };
    await internals.enqueue(() => internals.scan());
    writeFileSync(file, "BBBB\n");
    utimesSync(file, before.atimeMs / 1000, before.mtimeMs / 1000);
    await until(() => project.reconcilePending > 0, "periodic hash verification", 5000);
    const [recovery] = await project.reconciliations();
    assert.equal(recovery.shared, "AAAA\n");
    assert.equal(recovery.disk, "BBBB\n");
    assert.equal(readText(root, "note.md"), "BBBB\n");
  } finally {
    if (owner) await closePeer(owner);
    await server.stop(); removeDataDir(server.dataDir); temp.cleanup();
  }
});

test("an uncertain binary stays recoverable while its current shared version cannot be downloaded", { timeout: 60_000 }, async () => {
  const temp = tempRoot("libera-uncertain-blob-");
  const server = await startServerProcess();
  let owner: Peer | undefined;
  let unavailable = false;
  try {
    const auth = await register(server, "UncertainBlob");
    const flaky: FetchLike = async (url, init) => unavailable && init.method === "GET" && url.includes("/blobs/")
      ? new Response("temporarily unavailable", { status: 503 }) : fetch(url, init);
    owner = await makePeer(temp.dir, "owner", server, auth, { fetch: flaky });
    const root = path.join(owner.library, "Binary");
    const current = Buffer.from([1, 2, 3, 4]);
    const uncertain = Buffer.from([9, 8, 7, 6]);
    writeTree(root, { "image.png": current });
    const shared = await owner.service.share({ notebook: "Binary" });
    const project = owner.service.project(shared.projectId)!;
    await project.whenIdle();
    const hub = owner.host.acquire(project.info.manifestDocId);
    try {
      const entries = () => [...hub.getDoc("manifest").getMap<ManifestEntry>(ManifestKeys.files).values()];
      const originalHash = entries()[0].blobHash;
      const file = path.join(root, "image.png");
      const older = statSync(file).mtimeMs - 10_000;
      unavailable = true;
      writeFileSync(file, uncertain);
      utimesSync(file, older / 1000, older / 1000);
      await sleep(1800); // Longer than this fixture's shared-delete grace.
      assert.deepEqual(readFileSync(file), uncertain, "failed download must not leave an artificial missing-file gap");
      assert.equal(entries()[0].blobHash, originalHash);
      unavailable = false;
      await until(() => { try { return readFileSync(file).equals(current); } catch { return false; } }, "current binary restored");
      assert.deepEqual(readFileSync(path.join(root, "_archive/image.png")), uncertain);
      assert.equal(entries()[0].blobHash, originalHash);
    } finally { owner.host.release(hub.docId); }
  } finally {
    unavailable = false;
    if (owner) await closePeer(owner);
    await server.stop(); removeDataDir(server.dataDir); temp.cleanup();
  }
});

test("an automatic upload outliving its lease stays local while explicit follower operations still work", { timeout: 60_000 }, async () => {
  const temp = tempRoot("libera-lease-upload-fence-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  let release = () => {};
  try {
    const auth = await register(server, "UploadFence");
    let delayUpload = false;
    let denyLease = false;
    let started = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchOld: FetchLike = async (url, init) => {
      if (denyLease && url.includes("/folder-lease")) throw new Error("lease partition");
      if (delayUpload && init.method === "PUT" && url.includes("/blobs/")) { started = true; await gate; }
      return fetch(url, init);
    };
    const old = await makePeer(temp.dir, "old", server, auth, { fetch: fetchOld, leaseTtlMs: 1500 });
    peers.push(old);
    const root = path.join(old.library, "Fence");
    writeTree(root, { "image.png": Buffer.from([1, 2, 3, 4]) });
    const shared = await old.service.share({ notebook: "Fence" });
    await old.service.project(shared.projectId)!.whenIdle();
    const library = path.join(temp.dir, "next-library");
    mkdirSync(library);
    const nextRoot = path.join(library, "Fence");
    cpSync(root, nextRoot, { recursive: true });
    const next = await makePeer(temp.dir, "next", server, auth, { library, leaseTtlMs: 1500 });
    peers.push(next);
    const project = old.service.project(shared.projectId)!;
    const manifest = old.host.acquire(project.info.manifestDocId);
    const entries = () => [...manifest.getDoc("manifest").getMap<ManifestEntry>(ManifestKeys.files).values()];
    try {
      const originalHash = entries()[0].blobHash;
      delayUpload = true;
      writeFileSync(path.join(root, "image.png"), Buffer.from([9, 8, 7, 6]));
      await until(() => started, "automatic disk upload starts");
      denyLease = true;
      await until(() => next.service.project(shared.projectId)?.follower === false, "lease takeover");
      release();
      await until(() => old.service.project(shared.projectId)?.follower === true, "old scan drains and follows");
      assert.equal(entries()[0].blobHash, originalHash);
      assert.deepEqual(readFileSync(path.join(root, "image.png")), Buffer.from([9, 8, 7, 6]));
      assert.deepEqual(readFileSync(path.join(nextRoot, "image.png")), Buffer.from([1, 2, 3, 4]));
      await old.service.fileOp(shared.projectId, { op: "rename", path: "image.png", to: "kept.png" });
      await until(() => existsSync(path.join(nextRoot, "kept.png")), "explicit follower rename");
      assert.equal(entries()[0].path, "kept.png");
      assert.equal(entries()[0].blobHash, originalHash);
    } finally { old.host.release(manifest.docId); }
  } finally {
    release();
    for (const peer of peers.reverse()) await closePeer(peer);
    await server.stop(); removeDataDir(server.dataDir); temp.cleanup();
  }
});
