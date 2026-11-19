// Regressions for the 2026-11-19 sync audit, scanner liveness and battery:
// - 30: a hung provider read blocks neither other notebooks (the read pool is
//   per notebook), nor a content guard, nor stopping;
// - 37: the writer's own atomic write does not start a full walk, and
//   watcher-triggered scans are paced like the poll on battery;
// - 38: tracked files count against the scan's byte budget, a tracked file
//   above the upload limit is not read, an online-only one is not read to verify.
//
// Detached SharedProjects (Object.create on the prototype, only the members
// the methods use) over real files, as in audit-1112-scan-reads.test.ts.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, test } from "node:test";

import { contentGuard, guardTimings, type WalkEntry } from "../../electron/collab/notebooks/fs-ops";
import { DEFAULT_TIMINGS, SharedProject, stopTimings, type Timings } from "../../electron/collab/notebooks/project";
import { MAX_OUTSTANDING_READS, MAX_UPLOAD_BYTES, readShared } from "../../electron/collab/notebooks/scan-reads";
import type { LayoutRecord } from "../../electron/collab/notebooks/state";

const roots: string[] = [];
const tempRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "libera-scan-liveness-"));
  roots.push(root);
  return root;
};
// Timers in the code under test are unref'd, as in production; keep the process alive.
const keepAlive = setInterval(() => {}, 1000);
after(() => { clearInterval(keepAlive); for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const OLD = Math.floor((Date.now() - 60_000) / 1000) * 1000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Records (and optionally stalls) reads through fs.promises.readFile. */
function spyReads(delay?: (file: string) => Promise<void>) {
  const original = fsp.readFile;
  const reads: string[] = [];
  (fsp as { readFile: unknown }).readFile = async (file: unknown, ...rest: unknown[]) => {
    reads.push(String(file));
    if (delay) await delay(String(file));
    return (original as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
  };
  return { reads, restore: () => { (fsp as { readFile: unknown }).readFile = original; } };
}
let spy: ReturnType<typeof spyReads> | null = null;
afterEach(() => { spy?.restore(); spy = null; });

function put(root: string, relative: string, text: string, mtimeMs = OLD): WalkEntry {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), text);
  utimesSync(path.join(root, relative), mtimeMs / 1000, mtimeMs / 1000);
  return { relative, kind: "file", size: Buffer.byteLength(text), mtimeMs, ctimeMs: mtimeMs, birthtimeMs: mtimeMs };
}

describe("finding 30: a stalled provider", () => {
  test("hung reads of one notebook do not defer the reads of another", async () => {
    const root = tempRoot();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const hung = new Set<string>();
    spy = spyReads(async (file) => { if (hung.has(file)) await gate; });
    const first = {};
    const second = {};
    for (let index = 0; index < MAX_OUTSTANDING_READS; index += 1) {
      const entry = put(root, `stuck${index}.bin`, "b");
      hung.add(path.join(root, entry.relative));
      assert.equal(typeof await readShared(path.join(root, entry.relative), 5, entry, first), "symbol");
    }
    const extra = put(root, "extra.bin", "b");
    assert.equal(typeof await readShared(path.join(root, extra.relative), 5, extra, first), "symbol", "the stalled notebook defers");
    const other = put(root, "other.bin", "other");
    const answer = await readShared(path.join(root, other.relative), 1000, other, second);
    assert.ok(Buffer.isBuffer(answer) && answer.toString() === "other", "another notebook still reads");
    release();
    await pause(30);
  });

  test("a content guard whose final read stalls refuses the commit", async () => {
    const root = tempRoot();
    put(root, "a.txt", "text");
    const gate = new Promise<void>(() => {});
    spy = spyReads(() => gate);
    const saved = guardTimings.readMs;
    guardTimings.readMs = 40;
    try {
      const guard = contentGuard(path.join(root, "a.txt"), null, { root, canCommit: async () => true });
      const outcome = await Promise.race([guard.canCommit(), pause(1500).then(() => "hung" as const)]);
      assert.equal(outcome, false);
    } finally { guardTimings.readMs = saved; }
  });

  test("stopping does not wait for ever on a queue held by a stalled read", async () => {
    const root = tempRoot();
    const project = Object.create(SharedProject.prototype) as unknown as Record<string, unknown>;
    Object.assign(project, {
      ctx: { logger: { warn() {}, error() {} } },
      info: { projectId: "prj", notebook: "N", root, manifestDocId: "m", follower: false },
      state: { layout: {} },
      watcher: null, pollTimer: null, manifestTimer: null, scanTimer: null, retryTimer: null,
      timers: new Set(), docs: new Map(), unsubscribe: [], manifestHub: null, saveTimer: null,
      stopAwaitingDisk() {},
      pdfs: { stop: async () => {} },
      queue: new Promise<void>(() => {}),
    });
    const saved = stopTimings.queueWaitMs;
    stopTimings.queueWaitMs = 40;
    try {
      const outcome = await Promise.race([(project as unknown as SharedProject).stop({ persist: false }).then(() => "stopped" as const), pause(1500).then(() => "hung" as const)]);
      assert.equal(outcome, "stopped");
      assert.equal(project.stopped, true);
    } finally { stopTimings.queueWaitMs = saved; }
  });
});

interface Own {
  stopped: boolean;
  dirtyPaths: Set<string>;
  scheduleScan(delay: number): void;
  startWatching(): void;
  scan(): Promise<void>;
  enqueue(task: () => Promise<void>): Promise<void>;
  pollTimer: ReturnType<typeof setTimeout> | null;
  scanTimer: ReturnType<typeof setTimeout> | null;
  watcher: { close(): void } | null;
}

function detached(root: string, layout: Record<string, Partial<LayoutRecord>>, options: { timings?: Partial<Timings>; onBattery?: () => boolean } = {}) {
  const project = Object.create(SharedProject.prototype) as unknown as Own;
  Object.assign(project, {
    ctx: { timings: { ...DEFAULT_TIMINGS, ...options.timings }, logger: { warn() {}, error() {} }, onBattery: options.onBattery },
    info: { projectId: "prj", notebook: "N", root, follower: false },
    state: { layout },
    watcher: null, watcherTrusted: true, watchRetrustAt: null, watchMisses: 0, resumedAt: 0, watchBaseline: null, watchBaselineAt: 0,
    reportedAt: new Map(), dirtyPaths: new Set(), verifyAll: false, stopped: false,
    pollTimer: null, pollArmedAt: 0, scanTimer: null, scanDueAt: 0, scanFirstAt: 0, scanForced: false, scanQueued: false, scanDeferred: false,
  });
  const counts = { scans: 0 };
  project.enqueue = async (task) => task();
  project.scan = async () => { counts.scans += 1; };
  const dispose = () => {
    project.stopped = true;
    project.watcher?.close();
    for (const timer of [project.pollTimer, project.scanTimer]) if (timer) clearTimeout(timer);
  };
  return { project, counts, dispose };
}

describe("finding 37: the writer's own writes", () => {
  test("a reported path that holds what the record says starts no scan", async () => {
    const root = tempRoot();
    const entry = put(root, "note.md", "own bytes");
    const stats = statSync(path.join(root, "note.md"));
    const { project, counts, dispose } = detached(root, { f1: { kind: "doc", path: "note.md", hash: "h", size: stats.size, mtimeMs: stats.mtimeMs } });
    try {
      project.dirtyPaths.add(entry.relative);
      project.scheduleScan(10);
      await pause(120);
      assert.equal(counts.scans, 0);
      assert.equal(project.dirtyPaths.size, 0);
    } finally { dispose(); }
  });

  test("a reported path whose stats differ from the record is scanned", async () => {
    const root = tempRoot();
    put(root, "note.md", "someone else's bytes");
    const { project, counts, dispose } = detached(root, { f1: { kind: "doc", path: "note.md", hash: "h", size: 3, mtimeMs: OLD } });
    try {
      project.dirtyPaths.add("note.md");
      project.scheduleScan(10);
      await pause(120);
      assert.equal(counts.scans, 1);
    } finally { dispose(); }
  });

  test("one foreign path among own writes still scans", async () => {
    const root = tempRoot();
    put(root, "note.md", "own");
    put(root, "new.md", "new");
    const stats = statSync(path.join(root, "note.md"));
    const { project, counts, dispose } = detached(root, { f1: { kind: "doc", path: "note.md", hash: "h", size: stats.size, mtimeMs: stats.mtimeMs } });
    try {
      project.dirtyPaths.add("note.md");
      project.dirtyPaths.add("new.md");
      project.scheduleScan(10);
      await pause(120);
      assert.equal(counts.scans, 1);
    } finally { dispose(); }
  });

  test("watcher-triggered scans wait longer on battery", async () => {
    const root = tempRoot();
    const { project, counts, dispose } = detached(root, {}, { timings: { settleMs: 30, batteryScale: 20, pollMs: 60_000, watchedPollMs: 60_000 }, onBattery: () => true });
    try {
      project.startWatching();
      await pause(100);
      const before = counts.scans;
      put(root, "foreign.md", "arrives");
      await pause(300);
      assert.equal(counts.scans, before, "the debounce is 30 ms x 20, not 30 ms");
      const deadline = Date.now() + 4000;
      while (counts.scans === before && Date.now() < deadline) await pause(25);
      assert.ok(counts.scans > before, "the scan still runs");
    } finally { dispose(); }
  });
});

/** A project whose scan() runs over `entries`, with the tracked records given. */
function scanRig(root: string, entries: WalkEntry[], layout: Record<string, Partial<LayoutRecord>>) {
  const warnings: string[] = [];
  const project = Object.create(SharedProject.prototype) as unknown as Record<string, unknown>;
  Object.assign(project, {
    ctx: { timings: { ...DEFAULT_TIMINGS }, logger: { warn: (message: string) => warnings.push(message), error() {} }, accountId: async () => "acc", host: { api: {} } },
    info: { projectId: "prj", notebook: "N", root, album: false, role: "editor", follower: false },
    state: { layout, externalAdoptionRequired: false },
    stopped: false, missingSince: new Map(), baselineMissing: new Set(), verified: new Map(), entries: new Map(), docs: new Map(), retired: new Map(),
    dirtyPaths: new Set(), verifyAll: true,
    manifestReady: () => true, manifestCaughtUp: () => true, rootAvailable: async () => true, noticeMissedEvents: () => {}, readEntries: () => new Map(),
    walk: async () => ({ entries, skipped: [], complete: true }),
    scheduleScan: () => {}, scheduleRetry: () => {}, saveSoon: () => {}, createFromDisk: async () => null,
  });
  return { project: project as unknown as { scan(): Promise<void> }, warnings };
}

describe("finding 38: tracked files and the scan budget", () => {
  const blob = (relative: string, size: number): Partial<LayoutRecord> => ({ kind: "blob", path: relative, hash: "stale", size, mtimeMs: OLD - 1000 });

  test("a tracked file above the upload limit is neither read nor hashed, and noted once", async () => {
    const root = tempRoot();
    const entry = put(root, "huge.bin", "x");
    entry.size = MAX_UPLOAD_BYTES + 1;
    spy = spyReads();
    const { project, warnings } = scanRig(root, [entry], { f1: blob("huge.bin", 1) });
    await project.scan();
    await project.scan();
    assert.deepEqual(spy.reads, []);
    assert.equal(warnings.filter((line) => line.includes("huge.bin")).length, 1);
  });

  test("tracked reads stop at the scan's byte budget", async () => {
    const root = tempRoot();
    const entries: WalkEntry[] = [];
    const layout: Record<string, Partial<LayoutRecord>> = {};
    // Three files claiming 90 MiB each exceed the 256 MiB budget after two.
    for (let index = 0; index < 3; index += 1) {
      const entry = put(root, `big${index}.bin`, "x");
      entry.size = 90 * 1024 * 1024;
      entries.push(entry);
      layout[`f${index}`] = blob(entry.relative, entry.size);
    }
    spy = spyReads();
    const { project } = scanRig(root, entries, layout);
    await project.scan();
    assert.equal(spy.reads.length, 2);
  });

  test("an online-only file with the recorded stats is not read to verify it", async () => {
    const root = tempRoot();
    const entry = put(root, "cloud.bin", "x");
    entry.dataless = true;
    spy = spyReads();
    const { project } = scanRig(root, [entry], { f1: { kind: "blob", path: "cloud.bin", hash: "stale", size: entry.size, mtimeMs: entry.mtimeMs } });
    await project.scan();
    assert.deepEqual(spy.reads, []);
  });
});
