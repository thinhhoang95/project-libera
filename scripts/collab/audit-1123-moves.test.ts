// Audit 2026-11-23, package MV (moves, case and respells): a case-only folder
// rename is applied on disk and never ping-pongs, keeps its empty folder and
// never retires the live path (H7); staged-move results reach the pass whatever
// the manifest says, and a refused staged target is still waiting (M6); a
// folder's companions are split into batches with the main entries (M9); a
// rename intent follows a later byte replacement (M20); respell marks are
// bounded by the manifest, not by a small cache (L3).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, promises as fsp, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as Y from "yjs";

import { ManifestIntents, trackEntryWrites, type EntryRecord } from "../../electron/collab/notebooks/manifest-intents";
import { STATE_DIRECTORY } from "../../electron/collab/notebooks/fs-ops";
import { placeStagedMoves, writeMoveJournal } from "../../electron/collab/notebooks/move-journal";
import { MessageType } from "../../src/lib/collab/protocol/messages";
import { ManifestKeys } from "../../src/lib/collab/protocol/schema";
import { closePeer, makePeer, register, sleep, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

let seq = 3_000_000;

/** Delivers a manifest change the way the server's broadcast does, without the server learning of it. */
function deliverManifest(peer: Peer, manifestDocId: string, mutate: (files: Y.Map<unknown>) => void): void {
  const hub = peer.host.acquire(manifestDocId);
  try {
    const clone = new Y.Doc();
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(hub.getDoc("manifest")));
    let update: Uint8Array | null = null;
    clone.on("update", (value: Uint8Array) => { update = value; });
    clone.transact(() => mutate(clone.getMap<unknown>(ManifestKeys.files)));
    assert.ok(update, "the change produced an update");
    seq += 1;
    hub.handleRemote({ type: MessageType.Remote, docId: manifestDocId, subdoc: "manifest", serverSeq: seq, update, userId: "", clientId: "audit-1123-mv" });
  } finally {
    peer.host.release(manifestDocId);
  }
}

function entriesOf(peer: Peer, manifestDocId: string): Array<{ key: string; record: Record<string, unknown> }> {
  const hub = peer.host.acquire(manifestDocId);
  try {
    const files = hub.getDoc("manifest").getMap<unknown>(ManifestKeys.files);
    return [...files.entries()].map(([key, value]) => ({ key, record: JSON.parse(JSON.stringify(value)) as Record<string, unknown> }));
  } finally {
    peer.host.release(manifestDocId);
  }
}

const entryFor = (peer: Peer, manifestDocId: string, liberaPath: string) => {
  const found = entriesOf(peer, manifestDocId).find((item) => item.record.path === liberaPath);
  if (!found) throw new Error(`no manifest entry for ${liberaPath}`);
  return found;
};

// --- M20 -----------------------------------------------------------------

const FILE = "f1";
const OLD = "a".repeat(64);
const NEW = "b".repeat(64);

class Device {
  readonly doc = new Y.Doc();
  readonly intents = new ManifestIntents();
  constructor(clientID: number) { this.doc.clientID = clientID; }
  get files(): Y.Map<unknown> { return this.doc.getMap<unknown>(ManifestKeys.files); }
  entry(): EntryRecord { return this.files.get(FILE) as EntryRecord; }
  write(change: EntryRecord): void {
    trackEntryWrites(this.files, this.intents, () => this.doc.transact(() => this.files.set(FILE, { ...this.entry(), ...change })));
  }
  settle(): void {
    for (const [fileId, record] of this.intents.reconcile(this.files, false)) {
      trackEntryWrites(this.files, this.intents, () => this.doc.transact(() => this.files.set(fileId, record)));
    }
  }
}

function exchange(a: Device, b: Device): void {
  const toB = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc));
  const toA = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
  Y.applyUpdate(b.doc, toB);
  Y.applyUpdate(a.doc, toA);
}

test("M20: a collaborator's deliberate revert of a rename survives a later local byte replacement", () => {
  const seed = new Device(1);
  seed.doc.transact(() => seed.files.set(FILE, { fileId: FILE, path: "a.png", kind: "blob", blobHash: OLD, size: 3, mime: "image/png", createdBy: "u", createdAt: 1, updatedAt: 1 }));
  const a = new Device(100);
  const b = new Device(200);
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(seed.doc));
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(seed.doc));
  a.write({ path: "b.png", updatedAt: 2 });
  a.write({ blobHash: NEW, size: 9, updatedAt: 3 });
  exchange(a, b);
  // The collaborator saw both changes and undoes only the rename.
  b.write({ path: "a.png", updatedAt: 9 });
  exchange(a, b);
  a.settle();
  assert.equal(a.entry().path, "a.png", "the revert is not written over");
  assert.equal(a.entry().blobHash, NEW);
});

// --- M6, move-journal ------------------------------------------------------

test("M6: a staged file whose wanted path is refused is still waiting", async () => {
  const temp = tempRoot("libera-audit-1123-journal-");
  try {
    const root = temp.dir;
    const moving = path.join(root, ...STATE_DIRECTORY, "moving");
    mkdirSync(moving, { recursive: true });
    writeFileSync(path.join(moving, "fil_x-move_x"), "bytes");
    await writeMoveJournal(root, { fileId: "fil_x", source: "old.md", destination: "new.md", staged: "fil_x-move_x", stagedAt: 1 });
    const results = await placeStagedMoves(root, new Map([["fil_x", "../outside.md"]]), undefined, { listed: new Set(["fil_x"]) });
    assert.deepEqual([...results.waiting], ["fil_x"], "a rejected target keeps the file waiting");
    assert.ok(existsSync(path.join(moving, "fil_x-move_x")), "the staged bytes are untouched");
  } finally { temp.cleanup(); }
});

// --- host -----------------------------------------------------------------

interface LayoutRecord { path: string; kind: string; hash?: string; docId?: string }
interface Internals {
  state: { layout: Record<string, LayoutRecord>; remoteRespells?: Record<string, { path: string; at: number }> };
  retired: Map<string, Set<string>>;
  noteRemoteRespells(next: Map<string, { path: string; kind: string }>): void;
  recordedPaths: Map<string, { path: string; kind: string }>;
  applyManifestPass(): Promise<void>;
  enqueue<T>(task: () => Promise<T>): Promise<T>;
  placeBlob(entry: unknown, record: LayoutRecord): Promise<boolean>;
  inkCompanionMoves(...args: unknown[]): unknown[];
}

function caseInsensitive(dir: string): boolean {
  const probe = path.join(dir, "CaseProbe");
  writeFileSync(probe, "x");
  return existsSync(path.join(dir, "caseprobe"));
}

test("audit 1123 MV: moves, case and respells", { timeout: 300_000 }, async (t) => {
  const temp = tempRoot("libera-audit-1123-mv-");
  const server = await startServerProcess();
  let peer: Peer | undefined;
  try {
    const auth = await register(server, "MovesCase");
    peer = await makePeer(temp.dir, "owner", server, auth, { timings: { pollMs: 150, importQuietMs: 100, retryMs: 300 } });
    const owner = peer;
    const root = path.join(owner.library, "Moves");
    const insensitive = caseInsensitive(owner.library);
    writeTree(root, { "Notes/a.md": "a note\n", "Empty/": "", "data.bin": Buffer.from("blob data bytes") });
    const shared = await owner.service.share({ notebook: "Moves" });
    const project = owner.service.project(shared.projectId)!;
    await project.whenIdle();
    const manifestDocId = project.info.manifestDocId;
    const runtime = project as unknown as Internals;
    const names = () => readdirSync(root).filter((name) => !name.startsWith("."));

    await t.test("H7: a remote case-only folder rename is applied on disk, keeps the empty folder, retires nothing live and does not come back", async (sub) => {
      if (!insensitive) { sub.skip("this volume is case-sensitive"); return; }
      const notes = entryFor(owner, manifestDocId, "Notes");
      const note = entryFor(owner, manifestDocId, "Notes/a.md");
      const empty = entryFor(owner, manifestDocId, "Empty");
      deliverManifest(owner, manifestDocId, (files) => {
        files.set(notes.key, { ...notes.record, path: "notes", updatedAt: Date.now() });
        files.set(note.key, { ...note.record, path: "notes/a.md", updatedAt: Date.now() });
        files.set(empty.key, { ...empty.record, path: "empty", updatedAt: Date.now() });
      });
      await until(() => names().includes("notes"), "the folder to take the manifest's spelling");
      await project.whenIdle();
      await sleep(1_500);
      await project.whenIdle();
      assert.ok(names().includes("notes") && !names().includes("Notes"), `disk spelling ${names()}`);
      assert.ok(names().includes("empty") && !names().includes("Empty"), "the empty folder is still there, under the new spelling");
      assert.equal(readFileSync(path.join(root, "notes", "a.md"), "utf8"), "a note\n");
      const paths = entriesOf(owner, manifestDocId).map((item) => item.record.path);
      assert.ok(paths.includes("notes") && paths.includes("notes/a.md") && paths.includes("empty"), `the manifest was not renamed back: ${paths}`);
      assert.ok(!runtime.retired.has("notes") && !runtime.retired.has("empty"), "the live path was not retired");
      writeTree(root, { "notes/new.md": "new under the folder\n" });
      await until(() => entriesOf(owner, manifestDocId).some((item) => item.record.path === "notes/new.md"), "a file created under the folder to be imported");
    });

    await t.test("M6: a staged move that is still waiting holds its file, whatever the manifest path says", async () => {
      await project.whenIdle();
      const data = entryFor(owner, manifestDocId, "data.bin");
      const fileId = String(data.record.fileId);
      const moving = path.join(root, ...STATE_DIRECTORY, "moving");
      mkdirSync(moving, { recursive: true });
      writeFileSync(path.join(moving, `${fileId}-move_t`), "staged other bytes");
      await writeMoveJournal(root, { fileId, source: "data.bin", destination: "data.bin", staged: `${fileId}-move_t`, stagedAt: Date.now() });
      const record = runtime.state.layout[fileId];
      assert.ok(record?.hash, "the layout holds the blob's hash");
      const placed: string[] = [];
      const real = runtime.placeBlob;
      runtime.placeBlob = async (entry: unknown) => { placed.push(String((entry as { fileId: string }).fileId)); return false; };
      try {
        runtime.state.layout[fileId] = { ...record, hash: undefined };
        await runtime.enqueue(() => runtime.applyManifestPass());
        assert.ok(!placed.includes(fileId), "its bytes are mid-move: nothing is placed from the manifest meanwhile");
      } finally {
        runtime.placeBlob = real;
        runtime.state.layout[fileId] = record;
      }
      for (const name of readdirSync(moving)) if (name.startsWith(fileId)) await fsp.rm(path.join(moving, name), { force: true });
    });

    await t.test("M9: the companions of a folder are split into batches with the main entries", async () => {
      await project.whenIdle();
      const sizes: number[] = [];
      const hub = owner.host.acquire(manifestDocId);
      const listener = (update: Uint8Array) => { sizes.push(update.length); };
      try {
        const longName = "c".repeat(180);
        const make = (index: number, base: string) => ({ fileId: `ink_${index}`, path: `${base}/${longName}${index}`, kind: "folder", createdBy: "u", createdAt: 1, updatedAt: 1 });
        const real = runtime.inkCompanionMoves;
        runtime.inkCompanionMoves = (...args: unknown[]) => (args[1] === "Notes" || args[1] === "notes" ? Array.from({ length: 2500 }, (_, index) => make(index, `_ink/${String(args[2])}`)) : real.apply(runtime, args));
        hub.getDoc("manifest").on("update", listener);
        try {
          await owner.service.fileOp(shared.projectId, { op: "rename", path: insensitive ? "notes" : "Notes", to: "Renamed" });
        } finally {
          delete (runtime as Partial<Internals>).inkCompanionMoves;
        }
        const biggest = Math.max(...sizes);
        assert.ok(biggest < 300_000, `no single manifest update carries all the companions (largest ${biggest} bytes of ${sizes.length})`);
        sizes.length = 0;
        await owner.service.fileOp(shared.projectId, { op: "delete", path: "Renamed" });
        assert.ok(Math.max(...sizes) < 300_000, `a delete is split too (largest ${Math.max(...sizes)} bytes)`);
        assert.ok(!entriesOf(owner, manifestDocId).some((item) => String(item.record.path).startsWith("_ink/Renamed")), "every companion went");
      } finally {
        hub.getDoc("manifest").off("update", listener);
        owner.host.release(manifestDocId);
      }
    });

    await t.test("L3: respell marks are bounded by the manifest, not by a cache that evicts live names", async () => {
      const marks: Record<string, { path: string; at: number }> = {};
      const next = new Map<string, { path: string; kind: string }>();
      const before = new Map<string, { path: string; kind: string }>();
      for (let index = 0; index < 450; index += 1) {
        before.set(`fil_r${index}`, { path: `café${index}.md`, kind: "file" });
        next.set(`fil_r${index}`, { path: `café${index}.md`, kind: "file" });
      }
      const savedRecorded = runtime.recordedPaths;
      runtime.recordedPaths = before;
      runtime.state.remoteRespells = marks;
      try {
        runtime.noteRemoteRespells(next);
        assert.equal(Object.keys(runtime.state.remoteRespells ?? {}).length, 450, "every remote respell of a live entry is kept");
        runtime.noteRemoteRespells(new Map([...next].slice(0, 10)));
        assert.equal(Object.keys(runtime.state.remoteRespells ?? {}).length, 10, "marks of entries the manifest lost are dropped");
      } finally {
        runtime.recordedPaths = savedRecorded;
        runtime.state.remoteRespells = {};
      }
    });
  } finally {
    if (peer) await closePeer(peer).catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
