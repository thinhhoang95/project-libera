// File-moving review 2026-11-25, package H1 (collab host: case-only renames, PDF resolve, scan moves, intents):
// S-H1 a case-only rename of a folder no entry names (an implied folder) is applied on disk and never comes back;
// S-H2 PdfMarksRuntime.resolve matches with the manifest's name rule; S-M1 a folder moved outside Libera with
// files that share bytes moves as one folder; S-M2 intents are written through the project's queue and survive a
// restart; S-M4 (host) a displaced local folder is told as a folder, staged moves cannot leave a file looking placed
// after an exception, and a shared notebook's undelivered PDF keeps its text cache.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as Y from "yjs";

import { ManifestIntents, type EntryRecord } from "../../electron/collab/notebooks/manifest-intents";
import { STATE_DIRECTORY } from "../../electron/collab/notebooks/fs-ops";
import { placeStagedMoves, writeMoveJournal } from "../../electron/collab/notebooks/move-journal";
import { PdfMarksRuntime } from "../../electron/collab/notebooks/pdf-marks";
import { MessageType } from "../../src/lib/collab/protocol/messages";
import { ManifestKeys, type ManifestEntry } from "../../src/lib/collab/protocol/schema";
import { PDF_LIVE_SETTING } from "../../src/lib/collab/protocol/pdf";
import type { CollabHost } from "../../electron/collab/core/host";
import { closePeer, makePeer, register, sleep, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };
let seq = 5_000_000;

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
    hub.handleRemote({ type: MessageType.Remote, docId: manifestDocId, subdoc: "manifest", serverSeq: seq, update, userId: "", clientId: "review-1125-h1" });
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

function caseInsensitive(dir: string): boolean {
  const probe = path.join(dir, "CaseProbe");
  writeFileSync(probe, "x");
  return existsSync(path.join(dir, "caseprobe"));
}

// --- S-H2 -------------------------------------------------------------------

test("S-H2: resolve matches a PDF by the manifest's name rule (case, Unicode form)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "libera-review-1125-pdf-"));
  const root = path.join(dir, "notebook");
  mkdirSync(root);
  const docs = new Map<string, Y.Doc>();
  const hub = {
    getStatus: () => ({ state: "saved-remote" }), observe: () => () => {}, onStatus: () => () => {}, onRejected: () => () => {},
    getDoc: (name: string) => { if (!docs.has(name)) docs.set(name, new Y.Doc()); return docs.get(name)!; }, isClosed: false, hasOpened: true,
  };
  const host = { store: { upsertDoc() {} }, acquire: () => hub, release() {}, api: { importPdf: async () => {} } } as unknown as CollabHost;
  const manifest = new Y.Doc();
  manifest.getMap(ManifestKeys.settings).set(PDF_LIVE_SETTING, true);
  const runtime = new PdfMarksRuntime({
    host, logger: quietLogger, projectId: "prj_test", notebook: "Notebook", root, writeMs: 60_000,
    role: () => "commenter", canWriteDisk: () => true, guard: () => ({ root, canCommit: async () => true }),
    authorityReady: () => true, recordLive: async () => {}, filesChanged() {}, commentsChanged() {}, manifest: () => manifest,
    listComments: async () => [],
  } as never);
  try {
    const sync = (files: Array<{ fileId: string; path: string }>) => runtime.sync(
      files.map((file): ManifestEntry => ({ fileId: file.fileId, path: file.path, kind: "blob", createdBy: "acc_me", createdAt: 1, updatedAt: 1 })),
      new Map(files.map((file) => [file.fileId, file.path])),
    );
    sync([{ fileId: "fil_nfc", path: "Papers/Café.pdf" }]);
    assert.equal(runtime.resolve("Papers/Café.pdf")?.fileId, "fil_nfc", "the exact spelling still resolves");
    assert.equal(runtime.resolve("Papers/Café.pdf")?.fileId, "fil_nfc", "an NFD spelling from the disk resolves");
    assert.equal(runtime.resolve("papers/CAFÉ.PDF")?.fileId, "fil_nfc", "another case resolves");
    assert.equal(runtime.resolve("Papers/Other.pdf"), null);
    // Two PDFs that differ only in case (a case-sensitive volume): the exact spelling decides, and an unspelled one is not guessed.
    sync([{ fileId: "fil_a", path: "x/Doc.pdf" }, { fileId: "fil_b", path: "x/doc.pdf" }]);
    assert.equal(runtime.resolve("x/Doc.pdf")?.fileId, "fil_a");
    assert.equal(runtime.resolve("x/doc.pdf")?.fileId, "fil_b");
    assert.equal(runtime.resolve("x/DOC.pdf"), null, "an ambiguous folded match is refused");
  } finally {
    await runtime.stop();
    manifest.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- S-M2 (intents) ---------------------------------------------------------

test("S-M2: intents survive a restart through export and restore, bounded and checked", () => {
  const FILE = "f1";
  const files = new Y.Doc().getMap<unknown>(ManifestKeys.files);
  const doc = files.doc as Y.Doc;
  doc.transact(() => files.set(FILE, { fileId: FILE, path: "a.png", kind: "blob", blobHash: "a".repeat(64), size: 3, mime: "image/png", createdBy: "u", createdAt: 1, updatedAt: 1 }));
  const before = new ManifestIntents();
  const entry = () => files.get(FILE) as EntryRecord;
  before.record(FILE, entry(), { ...entry(), path: "b.png", updatedAt: 2 });
  assert.equal(before.size, 1);
  const saved = JSON.parse(JSON.stringify(before.export()));
  assert.equal(saved.length, 1);

  const after = new ManifestIntents();
  after.restore([...saved, { fileId: 5 }, "junk", { ...saved[0], recordedAt: 1 }]);
  assert.equal(after.size, 1, "malformed and too-old items are left out");
  // After the restart the merge brings back the old path together with another device's other change: the rename is written again.
  const merged = { ...entry(), blobHash: "c".repeat(64), updatedAt: 9 };
  const rewrites = after.reconcile({ get: () => merged }, false);
  assert.equal(rewrites.get(FILE)?.path, "b.png", "the restored intent guards the rename");
  assert.ok(after.revision > 0);
});

// --- S-M4 (host parts) ------------------------------------------------------

test("S-M4: an exception while placing one staged move leaves that file waiting, not absent", async () => {
  const temp = tempRoot("libera-review-1125-journal-");
  try {
    const root = temp.dir;
    const moving = path.join(root, ...STATE_DIRECTORY, "moving");
    mkdirSync(moving, { recursive: true });
    writeFileSync(path.join(moving, "fil_x-move_x"), "bytes");
    await writeMoveJournal(root, { fileId: "fil_x", source: "old.md", destination: "new.md", staged: "fil_x-move_x", stagedAt: 1 });
    const hostile = new Map<string, string>([["fil_x", "new.md"]]);
    hostile.get = () => { throw new Error("the lookup failed"); };
    const results = await placeStagedMoves(root, hostile, undefined, { listed: new Set(["fil_x"]) });
    assert.deepEqual([...results.waiting], ["fil_x"], "the file waits");
    assert.ok(existsSync(path.join(moving, "fil_x-move_x")), "its staged bytes are untouched");
    assert.ok(readdirSync(moving).some((name) => name.endsWith(".journal")), "its journal is kept");
  } finally { temp.cleanup(); }
});

test("S-M4: a shared notebook's undelivered PDF keeps its text cache; a plain notebook's missing PDF loses it", async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "libera-review-1125-prune-"));
  const previous = process.env.LIBERA_DATA_DIR;
  const machine = process.env.LIBERA_MACHINE_ID;
  process.env.LIBERA_DATA_DIR = path.join(base, "library");
  process.env.LIBERA_MACHINE_ID = "computer-a";
  try {
    const { createNotebook } = await import("../../src/lib/storage/notebooks");
    const { pdfTextCachePath, getAdminRoot } = await import("../../src/lib/storage/paths");
    const { prunePdfTextCaches } = await import("../../src/lib/storage/pdf-text-cache");
    await createNotebook("Plain");
    await createNotebook("Shared");
    writeFileSync(path.join(getAdminRoot(), "Shared", ".libera-shared.json"), JSON.stringify({ projectId: "prj_x", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString() }));
    for (const notebook of ["Plain", "Shared"]) {
      const cache = pdfTextCachePath(notebook, ["missing.pdf"]);
      mkdirSync(path.dirname(cache), { recursive: true });
      writeFileSync(cache, "{}");
    }
    await prunePdfTextCaches("Plain");
    await prunePdfTextCaches("Shared");
    assert.ok(!existsSync(pdfTextCachePath("Plain", ["missing.pdf"])), "a plain notebook's orphan cache is pruned");
    assert.ok(existsSync(pdfTextCachePath("Shared", ["missing.pdf"])), "the shared notebook's PDF may still be arriving (its manifest cannot be read here), so its cache stays");
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    if (machine === undefined) delete process.env.LIBERA_MACHINE_ID; else process.env.LIBERA_MACHINE_ID = machine;
    rmSync(base, { recursive: true, force: true });
  }
});

// --- host -------------------------------------------------------------------

interface Internals {
  state: { layout: Record<string, { path: string; kind: string; hash?: string }>; intents?: Array<{ fileId: string; field: string }>; remoteRespells?: Record<string, { path: string; at: number }> };
  recordedPaths: Map<string, { path: string; kind: string }>;
  manifestIntents: ManifestIntents;
  noteRemoteRespells(next: Map<string, { path: string; kind: string }>): void;
  enqueue<T>(task: () => Promise<T>): Promise<T>;
  writeManifest(...args: unknown[]): Promise<number>;
  scheduleIntents(): void;
  ctx: { host: { store: { commitManifestPaths(projectId: string, diff: { transitions?: Array<{ fileId: string; kind: string; from: string; to: string }> }): unknown } } };
}

test("review 1125 H1: host", { timeout: 300_000 }, async (t) => {
  const temp = tempRoot("libera-review-1125-h1-");
  const server = await startServerProcess();
  let peer: Peer | undefined;
  try {
    const auth = await register(server, "ReviewH1");
    peer = await makePeer(temp.dir, "owner", server, auth, { timings: { pollMs: 150, importQuietMs: 100, retryMs: 300 } });
    const owner = peer;
    const root = path.join(owner.library, "Rev");
    const insensitive = caseInsensitive(owner.library);
    writeTree(root, {
      "Imp/Sub/a.bin": Buffer.from("implied folder bytes"),
      "Dup/a.md": "",
      "Dup/b.md": "",
      "Dup/c.md": "a unique note\n",
      "Occ/x.bin": Buffer.from("local only"),
      "data.bin": Buffer.from("blob data bytes"),
      "scratch.bin": Buffer.from("scratch bytes"),
    });
    // The folder that will be displaced is not shared yet: it is created after the share, below.
    rmSync(path.join(root, "Occ"), { recursive: true, force: true });
    const shared = await owner.service.share({ notebook: "Rev" });
    const project = owner.service.project(shared.projectId)!;
    await project.whenIdle();
    const manifestDocId = project.info.manifestDocId;
    const runtime = project as unknown as Internals;
    const names = (dir = root) => readdirSync(dir).filter((name) => !name.startsWith("."));

    await t.test("S-H1: a case-only rename of an implied folder is applied on disk and does not come back", async (sub) => {
      if (!insensitive) { sub.skip("this volume is case-sensitive"); return; }
      const file = entryFor(owner, manifestDocId, "Imp/Sub/a.bin");
      // No entry names the folders: they are only implied by the file's path (as `_ink/<file>/` is).
      deliverManifest(owner, manifestDocId, (files) => {
        for (const [key, value] of [...files.entries()]) {
          const record = value as { kind?: string; path?: string };
          if (record.kind === "folder" && (record.path === "Imp" || record.path === "Imp/Sub")) files.delete(key);
        }
        files.set(file.key, { ...file.record, path: "imp/sub/a.bin", updatedAt: Date.now() });
      });
      await until(() => names().includes("imp"), "the implied folder to take the manifest's spelling");
      await project.whenIdle();
      await sleep(1_500);
      await project.whenIdle();
      assert.ok(names().includes("imp") && !names().includes("Imp"), `disk spelling ${names()}`);
      assert.deepEqual(names(path.join(root, "imp")), ["sub"], "the subfolder took its spelling too");
      assert.equal(entryFor(owner, manifestDocId, "imp/sub/a.bin").record.fileId, file.record.fileId, "the manifest was not renamed back to the old spelling");
      assert.ok(!entriesOf(owner, manifestDocId).some((item) => item.record.path === "Imp/Sub/a.bin"));
    });

    await t.test("S-H1: a remote respell of case only is remembered, so a disk that keeps the other spelling does not rename it back", () => {
      const marks: Record<string, { path: string; at: number }> = {};
      const savedRecorded = runtime.recordedPaths;
      runtime.recordedPaths = new Map([["fil_c", { path: "_ink/Note.md/p.ink", kind: "file" }]]);
      runtime.state.remoteRespells = marks;
      try {
        runtime.noteRemoteRespells(new Map([["fil_c", { path: "_ink/note.md/p.ink", kind: "file" }]]));
        assert.equal(runtime.state.remoteRespells?.fil_c?.path, "_ink/note.md/p.ink");
      } finally {
        runtime.recordedPaths = savedRecorded;
        runtime.state.remoteRespells = {};
      }
    });

    await t.test("S-M1: a folder moved outside Libera with byte-identical files moves as one folder", async () => {
      await project.whenIdle();
      const before = new Map(["Dup", "Dup/a.md", "Dup/b.md", "Dup/c.md"].map((item) => [item, entryFor(owner, manifestDocId, item).record.fileId as string]));
      // Files that have been there a while (a new empty file is held back a few seconds as the start of a copy).
      const longAgo = new Date(Date.now() - 3_600_000);
      for (const name of ["a.md", "b.md", "c.md"]) utimesSync(path.join(root, "Dup", name), longAgo, longAgo);
      renameSync(path.join(root, "Dup"), path.join(root, "Moved"));
      await until(() => entriesOf(owner, manifestDocId).some((item) => item.record.path === "Moved/c.md"), "the moved folder's files to follow", 30_000);
      await until(() => ["Moved", "Moved/a.md", "Moved/b.md", "Moved/c.md"].every((item) => entriesOf(owner, manifestDocId).some((entry) => entry.record.path === item)), "every file and the folder at the new place", 30_000);
      await project.whenIdle();
      await sleep(1_000);
      const entries = entriesOf(owner, manifestDocId);
      for (const [oldPath, fileId] of before) {
        const moved = entries.find((item) => item.record.fileId === fileId);
        assert.equal(moved?.record.path, oldPath.replace(/^Dup/, "Moved"), `${oldPath} kept its identity`);
      }
      assert.ok(!entries.some((item) => String(item.record.path).startsWith("Dup")), "no copy of the old folder or its files was restored");
      assert.ok(!names().includes("Dup"), "the old folder is not recreated on disk");
    });

    await t.test("S-M4: a local folder in the way of a moved file is displaced as a folder", async () => {
      await project.whenIdle();
      mkdirSync(path.join(root, "Occ"), { recursive: true });
      writeFileSync(path.join(root, "Occ", "local.txt"), "mine");
      const calls: Array<{ fileId: string; kind: string; from: string }> = [];
      const store = runtime.ctx.host.store;
      const real = store.commitManifestPaths;
      store.commitManifestPaths = function (projectId, diff) {
        for (const item of diff.transitions ?? []) if (item.fileId.startsWith("displaced-")) calls.push(item);
        return real.call(this, projectId, diff);
      };
      try {
        const data = entryFor(owner, manifestDocId, "data.bin");
        deliverManifest(owner, manifestDocId, (files) => files.set(data.key, { ...data.record, path: "Occ", updatedAt: Date.now() }));
        await until(() => calls.length > 0, "the displaced folder to be recorded", 30_000);
        assert.equal(calls[0].kind, "folder");
        assert.equal(calls[0].from, "Occ");
      } finally {
        store.commitManifestPaths = real;
      }
    });

    await t.test("S-M2: the intents' write goes through the project's queue and is kept in the state", async () => {
      await project.whenIdle();
      const scratch = entryFor(owner, manifestDocId, "scratch.bin");
      const fileId = String(scratch.record.fileId);
      let queued = 0;
      const writes: boolean[] = [];
      const realEnqueue = runtime.enqueue;
      const realWrite = runtime.writeManifest;
      runtime.enqueue = function (this: unknown, task: () => Promise<unknown>) { return realEnqueue.call(this, async () => { queued += 1; try { return await task(); } finally { queued -= 1; } }); } as typeof realEnqueue;
      runtime.writeManifest = function (...args) { writes.push(queued > 0); return realWrite.apply(this, args); };
      try {
        // An intent from before a restart: the rename to "kept.bin" was undone by a merge that also differs elsewhere.
        runtime.manifestIntents.restore([{ fileId, field: "path", from: "scratch.bin", to: "kept.bin", other: "[]", unit: { updatedAt: Date.now(), path: "kept.bin" }, recordedAt: Date.now() }]);
        runtime.scheduleIntents();
        await until(() => entriesOf(owner, manifestDocId).some((item) => item.record.fileId === fileId && item.record.path === "kept.bin"), "the intent to be written again");
        assert.ok(writes.length > 0 && writes.every(Boolean), "the manifest write ran inside the project's queue");
        await until(() => (runtime.state.intents ?? []).some((item) => item.fileId === fileId), "the intent to reach the state that is saved");
      } finally {
        runtime.enqueue = realEnqueue;
        runtime.writeManifest = realWrite;
      }
    });
  } finally {
    if (peer) await closePeer(peer).catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
