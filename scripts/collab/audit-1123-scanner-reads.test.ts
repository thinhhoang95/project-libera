// Audit 2026-11-23, SC1: the read and deferral side of a notebook scan.
// - C9:  a read that fails (not "absent") does not abort scan();
// - H4:  the watcher shortcut trusts only this host's own write signature;
// - H9:  files deferred before they were read still hold the missing ones;
// - M8:  a photo whose location details could not be removed is never uploaded;
// - M19: a file that sits out a scan schedules the retry;
// - L2:  an empty file is neither deferred forever nor left without a follow-up.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, test } from "node:test";

import { mayStillBeCopying, type WalkEntry } from "../../electron/collab/notebooks/fs-ops";
import { DEFAULT_TIMINGS, SharedProject } from "../../electron/collab/notebooks/project";
import { MAX_OUTSTANDING_READS, readShared } from "../../electron/collab/notebooks/scan-reads";
import type { LayoutRecord } from "../../electron/collab/notebooks/state";

const roots: string[] = [];
const tempRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "libera-scan-1123-"));
  roots.push(root);
  return root;
};
const keepAlive = setInterval(() => {}, 1000);
after(() => { clearInterval(keepAlive); for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const OLD = Math.floor((Date.now() - 60_000) / 1000) * 1000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Replaces fs.promises.readFile: `behave(file)` may throw or return a promise to wait on. */
function spyReads(behave: (file: string) => Promise<void> | void) {
  const original = fsp.readFile;
  (fsp as { readFile: unknown }).readFile = async (file: unknown, ...rest: unknown[]) => {
    await behave(String(file));
    return (original as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
  };
  return () => { (fsp as { readFile: unknown }).readFile = original; };
}
let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

function put(root: string, relative: string, text: string, times: { mtimeMs: number; ctimeMs: number } = { mtimeMs: OLD, ctimeMs: OLD }): WalkEntry {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), text);
  utimesSync(path.join(root, relative), times.mtimeMs / 1000, times.mtimeMs / 1000);
  return { relative, kind: "file", size: Buffer.byteLength(text), mtimeMs: times.mtimeMs, ctimeMs: times.ctimeMs, birthtimeMs: times.mtimeMs };
}

interface Rig {
  project: SharedProject;
  created: string[];
  uploads: number[];
  /** Scheduled scan delays; -1 is a retry. */
  scans: number[];
  manifestRuns: number[];
  baselineMissing: Set<string>;
}

function rig(root: string, entries: WalkEntry[], layout: Record<string, Partial<LayoutRecord>> = {}, extra: Record<string, unknown> = {}): Rig {
  const created: string[] = [];
  const uploads: number[] = [];
  const scans: number[] = [];
  const manifestRuns: number[] = [];
  const baselineMissing = new Set<string>();
  const project = Object.create(SharedProject.prototype) as unknown as Record<string, unknown>;
  Object.assign(project, {
    ctx: {
      timings: { ...DEFAULT_TIMINGS },
      logger: { warn() {}, error() {} },
      accountId: async () => "acc",
      host: { api: { uploadBlob: async (_project: string, bytes: Uint8Array) => { uploads.push(bytes.byteLength); } } },
    },
    info: { projectId: "prj", notebook: "N", root, album: false, role: "editor", follower: false },
    state: { layout, externalAdoptionRequired: false },
    stopped: false, missingSince: new Map(), baselineMissing, verified: new Map(), entries: new Map(), docs: new Map(), retired: new Map(),
    dirtyPaths: new Set(), verifyAll: true,
    manifestReady: () => true, manifestCaughtUp: () => true, rootAvailable: async () => true, noticeMissedEvents: () => {}, readEntries: () => new Map(),
    walk: async () => ({ entries, skipped: [], complete: true }),
    scheduleScan: (delay: number) => { scans.push(delay); },
    scheduleRetry: () => { scans.push(-1); },
    scheduleManifest: (delay: number) => { manifestRuns.push(delay); },
    saveSoon: () => {},
    createFromDisk: async (entry: WalkEntry) => { created.push(entry.relative); return null; },
    ...extra,
  });
  return { project: project as unknown as SharedProject, created, uploads, scans, manifestRuns, baselineMissing };
}

const scan = (value: Rig) => (value.project as unknown as { scan(): Promise<void> }).scan();
const fairness = (value: Rig) => (value.project as unknown as { scanFairness: { failed(key: string): void } }).scanFairness;
const blobRecord = (relative: string, size: number, hash = "h-old"): Partial<LayoutRecord> => ({ kind: "blob", path: relative, hash, size, mtimeMs: OLD - 1000 });

describe("C9: a failed read does not end the scan", () => {
  test("an unreadable tracked file is recorded as failed and the files after it are still scanned", async () => {
    const root = tempRoot();
    const locked = put(root, "a-locked.bin", "locked");
    const fresh = put(root, "z-new.bin", "brand new");
    restore = spyReads((file) => { if (file.endsWith("a-locked.bin")) throw Object.assign(new Error("busy"), { code: "EBUSY" }); });
    const value = rig(root, [locked, fresh], { f1: blobRecord("a-locked.bin", locked.size) });
    await scan(value);
    assert.deepEqual(value.created, ["z-new.bin"], "the later file was reached");
    assert.ok(value.scans.includes(-1), "a retry is scheduled");
  });

  test("an unreadable new file does not stop the files after it", async () => {
    const root = tempRoot();
    const first = put(root, "a-denied.bin", "denied");
    const second = put(root, "b-ok.bin", "fine");
    restore = spyReads((file) => { if (file.endsWith("a-denied.bin")) throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    const value = rig(root, [first, second]);
    await scan(value);
    assert.deepEqual(value.created, ["b-ok.bin"]);
    assert.ok(value.scans.includes(-1));
  });

  test("readShared answers the uncertain sentinel for a failed read", async () => {
    const root = tempRoot();
    const entry = put(root, "x.bin", "x");
    restore = spyReads(() => { throw Object.assign(new Error("io"), { code: "EIO" }); });
    const answer = await readShared(path.join(root, "x.bin"), 1000, entry);
    assert.equal(typeof answer, "symbol");
  });
});

describe("H4: the watcher shortcut", () => {
  interface Own {
    stopped: boolean;
    dirtyPaths: Set<string>;
    scheduleScan(delay: number): void;
    enqueue(task: () => Promise<void>): Promise<void>;
    scan(): Promise<void>;
    scanTimer: ReturnType<typeof setTimeout> | null;
    noteOwnWrite(absolute: string, stats: ReturnType<typeof statSync>): void;
  }
  function detached(root: string, layout: Record<string, Partial<LayoutRecord>>) {
    const project = Object.create(SharedProject.prototype) as unknown as Own;
    Object.assign(project, {
      ctx: { timings: { ...DEFAULT_TIMINGS }, logger: { warn() {}, error() {} } },
      info: { projectId: "prj", notebook: "N", root, follower: false },
      state: { layout },
      watcher: null, watcherTrusted: true, watchRetrustAt: null, watchMisses: 0, resumedAt: 0, watchBaseline: null, watchBaselineAt: 0,
      reportedAt: new Map(), dirtyPaths: new Set(), verifyAll: false, stopped: false,
      pollTimer: null, pollArmedAt: 0, scanTimer: null, scanDueAt: 0, scanFirstAt: 0, scanForced: false, scanQueued: false, scanDeferred: false,
    });
    const counts = { scans: 0 };
    project.enqueue = async (task) => task();
    project.scan = async () => { counts.scans += 1; };
    return { project, counts, dispose: () => { project.stopped = true; if (project.scanTimer) clearTimeout(project.scanTimer); } };
  }
  const event = async (project: Own, ...paths: string[]) => {
    for (const relative of paths) project.dirtyPaths.add(relative);
    project.scheduleScan(10);
    await pause(120);
  };

  test("an edit that kept the size and mtime still starts a scan", async () => {
    const root = tempRoot();
    put(root, "note.md", "aaaa");
    const before = statSync(path.join(root, "note.md"));
    const { project, counts, dispose } = detached(root, { f1: { kind: "doc", path: "note.md", hash: "h", size: before.size, mtimeMs: before.mtimeMs } });
    try {
      // Same length, mtime put back: only the ctime shows it.
      await pause(20);
      writeFileSync(path.join(root, "note.md"), "bbbb");
      utimesSync(path.join(root, "note.md"), before.atimeMs / 1000, before.mtimeMs / 1000);
      assert.equal(statSync(path.join(root, "note.md")).mtimeMs, before.mtimeMs);
      await event(project, "note.md");
      assert.equal(counts.scans, 1);
    } finally { dispose(); }
  });

  test("this host's own write, recorded with its signature, starts no scan", async () => {
    const root = tempRoot();
    put(root, "note.md", "own bytes");
    const stats = statSync(path.join(root, "note.md"));
    const { project, counts, dispose } = detached(root, { f1: { kind: "doc", path: "note.md", hash: "h", size: stats.size, mtimeMs: stats.mtimeMs } });
    try {
      project.noteOwnWrite(path.join(root, "note.md"), stats);
      await event(project, "note.md");
      assert.equal(counts.scans, 0);
      assert.equal(project.dirtyPaths.size, 0);
    } finally { dispose(); }
  });

  test("an edit that keeps the size and mtime after the own write is scanned", async () => {
    const root = tempRoot();
    put(root, "note.md", "aaaa");
    const stats = statSync(path.join(root, "note.md"));
    const { project, counts, dispose } = detached(root, { f1: { kind: "doc", path: "note.md", hash: "h", size: stats.size, mtimeMs: stats.mtimeMs } });
    try {
      project.noteOwnWrite(path.join(root, "note.md"), stats);
      await pause(20);
      writeFileSync(path.join(root, "note.md"), "bbbb");
      utimesSync(path.join(root, "note.md"), stats.atimeMs / 1000, stats.mtimeMs / 1000);
      await event(project, "note.md");
      assert.equal(counts.scans, 1);
    } finally { dispose(); }
  });

  test("a case-only rename (another spelling of the recorded name) is scanned", async () => {
    const root = tempRoot();
    put(root, "note.md", "own bytes");
    const stats = statSync(path.join(root, "note.md"));
    const { project, counts, dispose } = detached(root, { f1: { kind: "doc", path: "Note.md", hash: "h", size: stats.size, mtimeMs: stats.mtimeMs } });
    try {
      project.noteOwnWrite(path.join(root, "Note.md"), stats);
      await event(project, "note.md");
      assert.equal(counts.scans, 1);
    } finally { dispose(); }
  });
});

describe("H9: files deferred before they were read still hold the missing ones", () => {
  const MISSING = "old.bin";

  test("a new file that sits out this scan (earlier failed read) holds a missing file of its size", async () => {
    const root = tempRoot();
    const moved = put(root, "moved.bin", "12345");
    const value = rig(root, [moved], { f1: blobRecord(MISSING, 5) });
    fairness(value).failed("path:moved.bin");
    await scan(value);
    assert.equal(value.baselineMissing.has("f1"), false, "the old path is not put back");
    assert.deepEqual(value.manifestRuns, []);
    assert.deepEqual(value.created, []);
  });

  test("a new file whose read is given up on (no free read slot) holds a missing file of its size", async () => {
    const root = tempRoot();
    const moved = put(root, "moved.bin", "12345");
    const hanging: WalkEntry[] = [];
    for (let index = 0; index < MAX_OUTSTANDING_READS; index += 1) hanging.push(put(root, `hang${index}.bin`, "h"));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    restore = spyReads((file) => (path.basename(file).startsWith("hang") ? gate : undefined));
    const value = rig(root, [moved], { f1: blobRecord(MISSING, 5) });
    try {
      for (const entry of hanging) void readShared(path.join(root, entry.relative), 10, entry, value.project);
      await pause(30);
      await scan(value);
      assert.equal(value.baselineMissing.has("f1"), false);
      assert.deepEqual(value.manifestRuns, []);
    } finally { release(); }
  });

  test("a renamed file edited to the same length does not restore the old path", async () => {
    const root = tempRoot();
    const now = Date.now();
    // Its ctime is recent (the rename), and its bytes are not the missing file's.
    const moved = put(root, "moved.bin", "12345", { mtimeMs: OLD, ctimeMs: now - 500 });
    const value = rig(root, [moved], { f1: blobRecord(MISSING, 5, "not-those-bytes") });
    await scan(value);
    assert.equal(value.baselineMissing.has("f1"), false);
    assert.deepEqual(value.manifestRuns, []);
    assert.deepEqual(value.created, []);
    assert.ok(value.scans.some((delay) => delay > 0), "a follow-up scan is asked for");
  });

  test("a file of another size does not hold it", async () => {
    const root = tempRoot();
    const other = put(root, "other.bin", "1234567890");
    const value = rig(root, [other], { f1: blobRecord(MISSING, 5) });
    fairness(value).failed("path:other.bin");
    await scan(value);
    assert.equal(value.baselineMissing.has("f1"), true);
  });
});

describe("M19: a file that sits out a scan schedules the retry", () => {
  test("a tracked file skipped after failed reads", async () => {
    const root = tempRoot();
    const entry = put(root, "tracked.bin", "changed");
    const value = rig(root, [entry], { f1: blobRecord("tracked.bin", entry.size, "stale") });
    fairness(value).failed("f1");
    await scan(value);
    assert.ok(value.scans.length > 0, "a follow-up scan is scheduled");
  });

  test("a new file skipped after failed reads", async () => {
    const root = tempRoot();
    const entry = put(root, "new.bin", "fresh");
    const value = rig(root, [entry]);
    fairness(value).failed("path:new.bin");
    await scan(value);
    assert.ok(value.scans.length > 0, "a follow-up scan is scheduled");
  });
});

describe("M8: nothing is uploaded when the location details could not be removed", () => {
  test("scan: a failed rewrite of a changed photo", async () => {
    const root = tempRoot();
    const entry = put(root, "photo.jpg", "new photo bytes");
    const value = rig(root, [entry], { f1: blobRecord("photo.jpg", 3, "h-old") }, {
      stripForUpload: async () => { throw Object.assign(new Error("no space"), { code: "ENOSPC" }); },
      entries: new Map([["f1", { fileId: "f1", kind: "blob", path: "photo.jpg", blobHash: "h-old" }]]),
    });
    await scan(value);
    assert.deepEqual(value.uploads, []);
    assert.ok(value.scans.includes(-1));
  });

  test("createFromDisk: a failed rewrite of a new photo", async () => {
    const root = tempRoot();
    const entry = put(root, "photo.jpg", "photo bytes");
    const uploads: number[] = [];
    const project = Object.create(SharedProject.prototype) as unknown as Record<string, unknown>;
    Object.assign(project, {
      ctx: { timings: { ...DEFAULT_TIMINGS }, logger: { warn() {}, error() {} }, host: { api: { uploadBlob: async (_p: string, bytes: Uint8Array) => { uploads.push(bytes.byteLength); } }, store: { putBlob() {} } } },
      info: { projectId: "prj", notebook: "N", root, album: true, role: "owner", follower: false },
      state: { layout: {} },
      importAttempts: new Map(),
      stripForUpload: async () => { throw Object.assign(new Error("read-only"), { code: "EROFS" }); },
    });
    const created = await (project as unknown as { createFromDisk(...args: unknown[]): Promise<unknown> }).createFromDisk(entry, Buffer.from("photo bytes"), "hash", "acc", Date.now());
    assert.equal(created, null);
    assert.deepEqual(uploads, []);
  });
});

describe("L2: empty files", () => {
  const now = 1_700_000_000_000;
  test("a 0-byte file with a future mtime is not copying for ever", () => {
    assert.equal(mayStillBeCopying({ size: 0, mtimeMs: now + 3_600_000 }, now), false);
  });
  test("a 0-byte file written a moment ago may still be copying", () => {
    assert.equal(mayStillBeCopying({ size: 0, mtimeMs: now - 500 }, now), true);
    assert.equal(mayStillBeCopying({ size: 0, mtimeMs: now - 10_000 }, now), false);
  });

  test("a new empty file asks for a follow-up scan at the end of its settle time", async () => {
    const root = tempRoot();
    const entry = put(root, "empty.md", "", { mtimeMs: Date.now() - 500, ctimeMs: Date.now() - 500 });
    const value = rig(root, [entry]);
    await scan(value);
    assert.deepEqual(value.created, []);
    const wait = value.scans.find((delay) => delay > 0);
    assert.ok(wait !== undefined && wait < 3500, `a scan is scheduled (${wait})`);
  });
});
