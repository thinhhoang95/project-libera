// Audit 2026-11-12, the read side of a notebook scan:
// - SYNC-1: no file is read before the adoption fence, the upload size limit
//   and a per-scan budget have been consulted;
// - DATA-16: a file changed in the last moments is judged on a later scan;
// - SYNC-2: a read given up on is joined, not repeated;
// - DL-8: a walk over its cap backs off instead of retrying hot.
//
// The scans run on a SharedProject with no server behind it (Object.create
// on the prototype, only the members scan() uses), over real files.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, test } from "node:test";

import { walkNotebook, type NotebookWalk, type WalkEntry } from "../../electron/collab/notebooks/fs-ops";
import { DEFAULT_TIMINGS, SharedProject } from "../../electron/collab/notebooks/project";
import { MAX_OUTSTANDING_READS, MAX_UPLOAD_BYTES, quietWaitMs, readShared, scanReadState } from "../../electron/collab/notebooks/scan-reads";

const roots: string[] = [];
const tempRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "libera-scan-reads-"));
  roots.push(root);
  return root;
};
// readShared's timer is unref'd, as in production; keep the test process alive.
const keepAlive = setInterval(() => {}, 1000);
after(() => { clearInterval(keepAlive); for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const OLD = Date.now() - 60_000;

/** Records the paths read through fs.promises.readFile. */
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

interface Rig {
  project: SharedProject;
  created: string[];
  warnings: string[];
  scans: number[];
  walks: { count: number };
}

function rig(root: string, entries: WalkEntry[], options: { fence?: boolean; walk?: Partial<NotebookWalk> } = {}): Rig {
  const created: string[] = [];
  const warnings: string[] = [];
  const scans: number[] = [];
  const walks = { count: 0 };
  const project = Object.create(SharedProject.prototype) as unknown as Record<string, unknown>;
  Object.assign(project, {
    ctx: {
      timings: { ...DEFAULT_TIMINGS },
      logger: { warn: (message: string) => warnings.push(message), error() {} },
      accountId: async () => "acc",
      host: { api: {} },
    },
    info: { projectId: "prj", notebook: "N", root, album: false, role: "editor", follower: false },
    state: { layout: {}, externalAdoptionRequired: options.fence === true },
    stopped: false,
    missingSince: new Map(),
    baselineMissing: new Set(),
    verified: new Map(),
    entries: new Map(),
    docs: new Map(),
    retired: new Map(),
    dirtyPaths: new Set(),
    verifyAll: false,
    manifestReady: () => true,
    rootAvailable: async () => true,
    noticeMissedEvents: () => {},
    readEntries: () => new Map(),
    walk: async () => { walks.count += 1; return { entries, skipped: [], complete: true, ...options.walk }; },
    scheduleScan: (delay: number) => { scans.push(delay); },
    scheduleRetry: () => { scans.push(-1); },
    createFromDisk: async (entry: WalkEntry) => { created.push(entry.relative); return null; },
  });
  return { project: project as unknown as SharedProject, created, warnings, scans, walks };
}

const runScan = (value: Rig) => (value.project as unknown as { scan(): Promise<void> }).scan();

function put(root: string, relative: string, text: string, times: { mtimeMs: number; ctimeMs: number }): WalkEntry {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), text);
  return { relative, kind: "file", size: Buffer.byteLength(text), mtimeMs: times.mtimeMs, ctimeMs: times.ctimeMs, birthtimeMs: times.mtimeMs };
}

let spy: ReturnType<typeof spyReads> | null = null;
afterEach(() => { spy?.restore(); spy = null; });

describe("SYNC-1: policy before reading", () => {
  test("with the adoption fence up an unrelated new file is never read", async () => {
    const root = tempRoot();
    const entry = put(root, "new.bin", "hello", { mtimeMs: OLD, ctimeMs: OLD });
    spy = spyReads();
    const value = rig(root, [entry], { fence: true });
    await runScan(value);
    assert.deepEqual(spy.reads, []);
    assert.deepEqual(value.created, []);
  });

  test("without the fence a quiet new file is read and shared", async () => {
    const root = tempRoot();
    const entry = put(root, "new.bin", "hello", { mtimeMs: OLD, ctimeMs: OLD });
    spy = spyReads();
    const value = rig(root, [entry]);
    await runScan(value);
    assert.equal(spy.reads.length, 1);
    assert.deepEqual(value.created, ["new.bin"]);
  });

  test("a file above the upload limit is refused from its stat, once", async () => {
    const root = tempRoot();
    const entry = put(root, "huge.bin", "x", { mtimeMs: OLD, ctimeMs: OLD });
    entry.size = MAX_UPLOAD_BYTES + 1;
    spy = spyReads();
    const value = rig(root, [entry]);
    await runScan(value);
    await runScan(value);
    assert.deepEqual(spy.reads, []);
    assert.deepEqual(value.created, []);
    assert.equal(value.warnings.filter((line) => line.includes("huge.bin")).length, 1);
    assert.ok(!value.scans.includes(-1), "refusal is not a retry");
  });
});

describe("DATA-16: a changing file waits", () => {
  test("quietWaitMs looks at ctime as well as mtime", () => {
    const now = Date.now();
    assert.equal(quietWaitMs({ mtimeMs: now - 60_000, ctimeMs: now - 60_000 }, now), 0);
    assert.ok(quietWaitMs({ mtimeMs: now - 60_000, ctimeMs: now - 500 }, now) > 2000, "a restored old mtime does not hide a recent change");
    assert.equal(quietWaitMs({ mtimeMs: now + 3_600_000, ctimeMs: now - 60_000 }, now), 0, "a future mtime says nothing");
  });

  test("a recently changed new file is not read; a scan is asked for after the wait", async () => {
    const root = tempRoot();
    const now = Date.now();
    const entry = put(root, "partial.bin", "half", { mtimeMs: OLD, ctimeMs: now - 500 });
    spy = spyReads();
    const value = rig(root, [entry]);
    await runScan(value);
    assert.deepEqual(spy.reads, []);
    assert.deepEqual(value.created, []);
    const wait = value.scans.find((delay) => delay > 0);
    assert.ok(wait !== undefined && wait > 2000 && wait < 4000, `scan scheduled for the end of the quiet time (${wait})`);
  });
});

describe("SYNC-2: one read per path", () => {
  test("a read given up on is joined by the next attempt", async () => {
    const root = tempRoot();
    const entry = put(root, "slow.bin", "bytes", { mtimeMs: OLD, ctimeMs: OLD });
    const target = path.join(root, entry.relative);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    spy = spyReads(() => gate);
    const first = await readShared(target, 20, entry);
    assert.equal(typeof first, "symbol", "timed out");
    const second = await readShared(target, 20, entry);
    assert.equal(typeof second, "symbol");
    assert.equal(spy.reads.length, 1, "no second read was started");
    release();
    const third = await readShared(target, 1000, entry);
    assert.equal(Buffer.isBuffer(third) && third.toString(), "bytes");
    assert.equal(spy.reads.length, 1);
  });

  test("the late result is not used for a file that changed since the read began", async () => {
    const root = tempRoot();
    const entry = put(root, "moved.bin", "bytes", { mtimeMs: OLD, ctimeMs: OLD });
    const target = path.join(root, entry.relative);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    spy = spyReads(() => gate);
    await readShared(target, 10, entry);
    const answer = await readShared(target, 10, { ...entry, mtimeMs: OLD + 5000 });
    assert.equal(typeof answer, "symbol");
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const fresh = await readShared(target, 1000, { ...entry, mtimeMs: OLD + 5000 });
    assert.ok(Buffer.isBuffer(fresh), "a new read starts once the old one has ended");
    assert.equal(spy.reads.length, 2);
  });

  test("outstanding reads are bounded", async () => {
    const root = tempRoot();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    spy = spyReads(() => gate);
    const names: WalkEntry[] = [];
    for (let index = 0; index < MAX_OUTSTANDING_READS + 2; index += 1) names.push(put(root, `f${index}.bin`, "b", { mtimeMs: OLD, ctimeMs: OLD }));
    for (const entry of names) await readShared(path.join(root, entry.relative), 5, entry);
    assert.equal(spy.reads.length, MAX_OUTSTANDING_READS);
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
});

describe("DL-8: an oversized tree backs off", () => {
  test("walkNotebook reports that it stopped at the cap", async () => {
    const root = tempRoot();
    for (const name of ["a", "b", "c", "d"]) writeFileSync(path.join(root, `${name}.txt`), name);
    const walked = await walkNotebook(root, 2);
    assert.equal(walked.complete, false);
    assert.equal(walked.truncated, true);
    assert.equal((await walkNotebook(root)).truncated, undefined);
  });

  test("a truncated walk is not retried hot and warns once", async () => {
    const root = tempRoot();
    const value = rig(root, [], { walk: { complete: false, truncated: true } });
    await runScan(value);
    assert.equal(value.walks.count, 1);
    assert.ok(!value.scans.includes(-1), "no fixed-interval retry");
    const first = value.scans.find((delay) => delay > 0) ?? 0;
    assert.ok(first > DEFAULT_TIMINGS.retryMs, "the delay is longer than the old retry");
    await runScan(value);
    assert.equal(value.walks.count, 1, "no walk while backed off");
    scanReadState(value.project).blockedUntil = 0;
    await runScan(value);
    assert.equal(value.walks.count, 2);
    assert.ok(Math.max(...value.scans) > first, "the delay grows");
    assert.equal(value.warnings.filter((line) => line.includes("50000")).length, 1);
  });
});
