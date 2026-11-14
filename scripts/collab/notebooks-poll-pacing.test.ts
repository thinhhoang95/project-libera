// How often a shared folder is checked, and what each check re-reads:
// - the poll is slow while fs.watch works, slower on battery, back to the
//   short interval once fs.watch misses a change, and a run of interval
//   changes never pushes it back;
// - watcher debouncing cannot postpone a forced scan, or a scan forever;
// - large files are verified on a longer, still finite, schedule, and a
//   change that could not be handled yet is retried on the short one;
// - a verification that finds nothing new does not rewrite state.json.
//
// The policy tests run on a SharedProject with no folder or server behind it
// (Object.create on the prototype, only the fields the methods use); the
// rest run against a real server and folder.

import assert from "node:assert/strict";
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import type { WalkEntry } from "../../electron/collab/notebooks/fs-ops";
import { DEFAULT_TIMINGS, LARGE_FILE_BYTES, SharedProject, onWindowsNetworkShare, type Timings } from "../../electron/collab/notebooks/project";
import type { LayoutRecord } from "../../electron/collab/notebooks/state";
import { closePeer, makePeer, register, sleep, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess, type ServerProcess } from "./support/server-process";

/** The private members these tests reach. */
interface Internals {
  watcher: { close(): void } | null;
  watcherTrusted: boolean;
  watchRetrustAt: number | null;
  watchMisses: number;
  resumedAt: number;
  maybeRetrustWatcher(): void;
  resumed(): void;
  watchBaseline: Map<string, unknown> | null;
  reportedAt: Map<string, number>;
  verified: Map<string, { ctimeMs: number | undefined; at: number; pending?: boolean }>;
  state: { layout: Record<string, LayoutRecord> };
  stopped: boolean;
  pollTimer: ReturnType<typeof setTimeout> | null;
  scanTimer: ReturnType<typeof setTimeout> | null;
  scanDeferred: boolean;
  pollInterval(): number;
  schedulePoll(): void;
  scheduleScan(delay: number): void;
  noteReported(relative: string): void;
  noticeMissedEvents(files: Map<string, WalkEntry>, verifyAll: boolean, startedAt: number): void;
  verificationAge(fileId: string, size: number, pending: boolean): number;
  enqueue(task: () => Promise<void>): Promise<void>;
  scan(): Promise<void>;
  placeBlob(...args: unknown[]): Promise<boolean>;
  powerChanged(): void;
  leaseConfirmed(): void;
}

const internals = (project: SharedProject) => project as unknown as Internals;

interface DetachedOptions {
  timings?: Partial<Timings>;
  onBattery?: () => boolean;
  canWriteDisk?: () => boolean;
  follower?: boolean;
}

/** A SharedProject with no folder, server or queue behind it; scans are counted, not run. */
function detached(options: DetachedOptions = {}) {
  const warnings: string[] = [];
  const project = Object.create(SharedProject.prototype) as Internals;
  Object.assign(project, {
    ctx: {
      timings: { ...DEFAULT_TIMINGS, ...options.timings },
      logger: { warn: (message: string) => warnings.push(message), error() {} },
      onBattery: options.onBattery,
      canWriteDisk: options.canWriteDisk,
    },
    info: { projectId: "prj_detached", notebook: "Detached", root: "/detached", follower: options.follower ?? false },
    watcher: { close() {} },
    watcherTrusted: true,
    watchRetrustAt: null,
    watchMisses: 0,
    resumedAt: 0,
    watchBaseline: null,
    watchBaselineAt: 0,
    reportedAt: new Map(),
    stopped: false,
    pollTimer: null,
    pollArmedAt: 0,
    scanTimer: null,
    scanDueAt: 0,
    scanFirstAt: 0,
    scanForced: false,
    scanQueued: false,
    scanDeferred: false,
  });
  const counts = { scans: 0 };
  project.enqueue = async (task) => task();
  project.scan = async () => { counts.scans += 1; };
  const dispose = () => {
    project.stopped = true;
    for (const timer of [project.pollTimer, project.scanTimer]) if (timer) clearTimeout(timer);
  };
  return { project, warnings, counts, dispose };
}

const OLD = Date.now() - 60_000;
const file = (relative: string, size: number): WalkEntry => ({ relative, kind: "file", size, mtimeMs: OLD, ctimeMs: OLD });
const walk = (...entries: WalkEntry[]) => new Map(entries.map((entry) => [entry.relative, entry]));

describe("missed-event detection", () => {
  const GRACE = 80;
  /** Detector only: the follow-up scan it asks for is not needed here. */
  function detector() {
    const value = detached({ timings: { watchGraceMs: GRACE, pollMs: 50, watchedPollMs: 1000 } });
    value.project.scheduleScan = () => {};
    return value;
  }
  const look = (project: Internals, files: Map<string, WalkEntry>, verifyAll = false) => project.noticeMissedEvents(files, verifyAll, performance.now());

  test("a change with its event keeps the watcher trusted", () => {
    const { project } = detector();
    look(project, walk(file("a.md", 1)));
    project.noteReported("a.md");
    look(project, walk(file("a.md", 2)));
    assert.equal(project.watcherTrusted, true);
  });

  test("a change with no event is judged after the grace, on this host's clock", async () => {
    const { project, warnings } = detector();
    look(project, walk(file("a.md", 1)));
    look(project, walk(file("a.md", 2)));
    look(project, walk(file("a.md", 2)));
    assert.equal(project.watcherTrusted, true, "an old file timestamp alone does not end the grace");
    await sleep(GRACE + 40);
    look(project, walk(file("a.md", 2)));
    assert.equal(project.watcherTrusted, false);
    assert.match(warnings.join("\n"), /a\.md changed without a file-watch event/);
    assert.equal(project.pollInterval(), 50, "the poll returns to pollMs");
    assert.equal(project.watchBaseline, null, "no history is kept once it cannot change anything");
    project.noteReported("b.md");
    assert.equal(project.reportedAt.size, 0);
  });

  test("an event that arrives late, within the grace, explains the change", async () => {
    const { project } = detector();
    look(project, walk(file("a.md", 1)));
    look(project, walk(file("a.md", 2)));
    project.noteReported("a.md");
    await sleep(GRACE + 40);
    look(project, walk(file("a.md", 2)));
    assert.equal(project.watcherTrusted, true);
  });

  test("a new file needs an event too; a folder's event covers what is inside", async () => {
    const { project } = detector();
    look(project, walk(file("a.md", 1)));
    project.noteReported("sub");
    look(project, walk(file("a.md", 1), file("sub/new.md", 1)));
    assert.equal(project.watcherTrusted, true, "an event for the folder explains its new file");
    look(project, walk(file("a.md", 1), file("sub/new.md", 1), file("other.md", 1)));
    await sleep(GRACE + 40);
    look(project, walk(file("a.md", 1), file("sub/new.md", 1), file("other.md", 1)));
    assert.equal(project.watcherTrusted, false, "a new file with no event is a miss");
  });

  test("names match across Unicode normalization and case", () => {
    const { project } = detector();
    const decomposed = "Notes/cafe\u0301.md";
    look(project, walk(file(decomposed, 1)));
    project.noteReported("notes/CAF\u00c9.md");
    look(project, walk(file(decomposed, 2)));
    assert.equal(project.watcherTrusted, true);
  });

  test("an event explains one change only, even while another path is pending", async () => {
    const { project, warnings } = detector();
    look(project, walk(file("a.md", 1), file("b.md", 1)));
    project.noteReported("a.md");
    // a.md: explained. b.md: unexplained, so its old baseline and events are kept.
    look(project, walk(file("a.md", 2), file("b.md", 2)));
    // a.md changes again with no event; b.md's event arrives late.
    project.noteReported("b.md");
    look(project, walk(file("a.md", 3), file("b.md", 2)));
    await sleep(GRACE + 40);
    look(project, walk(file("a.md", 3), file("b.md", 2)));
    assert.equal(project.watcherTrusted, false);
    assert.match(warnings.join("\n"), /a\.md changed/);
    assert.doesNotMatch(warnings.join("\n"), /b\.md changed/);
  });

  test("a nameless event (verifyAll) and generated build output are not judged", async () => {
    const { project } = detector();
    look(project, walk(file("a.md", 1), file("main.aux", 1)));
    look(project, walk(file("a.md", 2), file("main.aux", 1)), true);
    look(project, walk(file("a.md", 2), file("main.aux", 2)));
    await sleep(GRACE + 40);
    look(project, walk(file("a.md", 2), file("main.aux", 3)));
    assert.equal(project.watcherTrusted, true);
  });

  test("a flood of events is bounded without dropping the baseline", () => {
    const { project } = detector();
    look(project, walk(file("a.md", 1)));
    for (let index = 0; index < 10_050; index += 1) project.noteReported(`build/f${index}.md`);
    assert.ok(project.reportedAt.size <= 10_001, `kept ${project.reportedAt.size} paths`);
    assert.ok(project.watchBaseline, "the comparison baseline survives");
    project.noteReported("build/f20000.md");
    look(project, walk(file("a.md", 1), file("build/f20000.md", 1)));
    assert.equal(project.watcherTrusted, true, "later paths still count, through their top-level folder");
  });
});

describe("poll pacing", () => {
  test("the interval follows the watcher and the power source", () => {
    let battery = false;
    const { project, dispose } = detached({ timings: { pollMs: 50, watchedPollMs: 1000, batteryScale: 4 }, onBattery: () => battery });
    try {
      assert.equal(project.pollInterval(), 1000);
      battery = true;
      assert.equal(project.pollInterval(), 4000);
      project.watcherTrusted = false;
      assert.equal(project.pollInterval(), 200);
      project.watcher = null;
      project.watcherTrusted = true;
      battery = false;
      assert.equal(project.pollInterval(), 50, "no watcher: the short poll");
    } finally {
      dispose();
    }
  });

  test("power-source changes cannot keep pushing the poll back", async () => {
    let battery = false;
    const { project, counts, dispose } = detached({ timings: { pollMs: 50, watchedPollMs: 300, batteryScale: 4 }, onBattery: () => battery });
    try {
      project.schedulePoll();
      // A loose charger: the source flips every 100 ms for 1.6 s. Restarting
      // the wait at each change would never reach a 300 ms (or 1.2 s) deadline.
      for (let elapsed = 0; elapsed < 1600; elapsed += 100) {
        await sleep(100);
        battery = !battery;
        project.powerChanged();
      }
      assert.ok(counts.scans >= 1, `the poll ran ${counts.scans} times`);
    } finally {
      dispose();
    }
  });

  test("going back to mains power brings the deadline forward", async () => {
    let battery = true;
    const { project, counts, dispose } = detached({ timings: { pollMs: 50, watchedPollMs: 200, batteryScale: 10 }, onBattery: () => battery });
    try {
      project.schedulePoll();
      await sleep(50);
      battery = false;
      project.powerChanged();
      await until(() => counts.scans >= 1, "the poll at the mains-power deadline", 1000);
    } finally {
      dispose();
    }
  });

  test("Windows network shares are recognized; local extended-length paths are not", () => {
    assert.equal(onWindowsNetworkShare("\\\\server\\share\\Notebook", "win32"), true);
    assert.equal(onWindowsNetworkShare("//server/share/Notebook", "win32"), true);
    assert.equal(onWindowsNetworkShare("\\\\?\\UNC\\server\\share\\Notebook", "win32"), true);
    assert.equal(onWindowsNetworkShare("\\\\?\\C:\\Notebook", "win32"), false);
    assert.equal(onWindowsNetworkShare("\\\\.\\C:\\Notebook", "win32"), false);
    assert.equal(onWindowsNetworkShare("C:\\Notebook", "win32"), false);
    assert.equal(onWindowsNetworkShare("//server/share", "linux"), false);
  });
});

describe("scan scheduling", () => {
  test("watcher debouncing does not postpone a forced scan", async () => {
    const { project, counts, dispose } = detached();
    try {
      project.scheduleScan(0);
      for (let index = 0; index < 5; index += 1) project.scheduleScan(200);
      await sleep(40);
      assert.equal(counts.scans, 1);
    } finally {
      dispose();
    }
  });

  test("a long burst of watcher events still gets a scan", { timeout: 15_000 }, async () => {
    const { project, counts, dispose } = detached();
    try {
      const started = performance.now();
      while (counts.scans === 0 && performance.now() - started < 7000) {
        project.scheduleScan(200);
        await sleep(50);
      }
      assert.equal(counts.scans, 1, "debouncing is bounded");
      assert.ok(performance.now() - started < 6500);
    } finally {
      dispose();
    }
  });

  test("only one scan waits in the queue at a time", async () => {
    const { project, dispose } = detached();
    const waiting: Array<() => Promise<void>> = [];
    project.enqueue = async (task) => { waiting.push(task); };
    try {
      project.scheduleScan(0);
      await sleep(15);
      project.scheduleScan(0);
      await sleep(15);
      assert.equal(waiting.length, 1);
      await waiting.shift()!();
      project.scheduleScan(0);
      await sleep(15);
      assert.equal(waiting.length, 1, "a scan is queued again once the last one started");
    } finally {
      dispose();
    }
  });

  test("a scan refused while a writer's lease lapsed runs once the lease is confirmed", async () => {
    let lapsed = true;
    const { project, counts, dispose } = detached({ canWriteDisk: () => !lapsed });
    try {
      project.scheduleScan(0);
      await sleep(15);
      assert.equal(counts.scans, 0);
      assert.equal(project.scanDeferred, true);
      lapsed = false;
      project.leaseConfirmed();
      await until(() => counts.scans === 1, "the deferred scan", 1000);
      assert.equal(project.scanDeferred, false);
    } finally {
      dispose();
    }
    const follower = detached({ follower: true });
    follower.project.scheduleScan(0);
    assert.equal(follower.project.scanDeferred, false, "a real follower never scans");
    follower.dispose();
  });
});

describe("verification age", () => {
  test("large files: longer, spread, finite; pending reads and battery as specified", () => {
    let battery = false;
    const { project, dispose } = detached({ timings: { verifyMs: 1000, trustedVerifyMs: 20_000, largeFileVerifyMs: 100_000, batteryScale: 4 }, onBattery: () => battery });
    try {
      // A trusted watcher reports preserved-stats edits itself: small files wait longer.
      assert.equal(project.verificationAge("fil_a", 10, false), 20_000);
      assert.equal(project.verificationAge("fil_a", 10, true), 1000, "an unhandled change keeps the short age with a trusted watcher");
      project.watcherTrusted = false;
      assert.equal(project.verificationAge("fil_a", 10, false), 1000);
      const ages = ["fil_a", "fil_b", "fil_c", "fil_d"].map((id) => project.verificationAge(id, LARGE_FILE_BYTES, false));
      for (const age of ages) assert.ok(age >= 75_000 && age < 125_000, String(age));
      assert.ok(new Set(ages).size > 1, "spread per file");
      assert.equal(project.verificationAge("fil_a", LARGE_FILE_BYTES, true), 1000, "an unhandled change is retried on the short age");
      battery = true;
      assert.equal(project.verificationAge("fil_a", 10, false), 4000);
    } finally {
      dispose();
    }
  });

  test("a watcher that was caught missing a change gets the short age again, even once trusted", () => {
    const { project, dispose } = detached({ timings: { verifyMs: 1000, trustedVerifyMs: 20_000 } });
    try {
      assert.equal(project.verificationAge("fil_a", 10, false), 20_000);
      // As noticeMissedEvents leaves it, with the wait already over.
      project.watcherTrusted = false;
      project.watchMisses = 1;
      project.watchRetrustAt = performance.now() - 1;
      project.maybeRetrustWatcher();
      assert.equal(project.watcherTrusted, true, "the poll relaxes again");
      assert.equal(project.verificationAge("fil_a", 10, false), 1000, "but small files are still verified on the short age");
    } finally {
      dispose();
    }
  });
});

/** An mtime well in the past, on a 2 s step (FAT), so files count as settled. */
function settledSeconds(): number {
  return Math.floor((Date.now() - 20_000) / 2000) * 2;
}

/** Whether the file holds `expected`; false while it is missing (a write-back moves the old bytes aside first). */
function holds(file: string, expected: Buffer): boolean {
  try {
    return readFileSync(file).equals(expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function fileId(project: SharedProject, relative: string): string {
  const found = Object.entries(internals(project).state.layout).find(([, record]) => record.path === relative);
  assert.ok(found, `${relative} is in the layout`);
  return found[0];
}

describe("against a server and a real folder", () => {
  let server: ServerProcess | undefined;
  let temp: ReturnType<typeof tempRoot> | undefined;
  const peers: Peer[] = [];

  before(async () => {
    temp = tempRoot("libera-poll-pacing-");
    server = await startServerProcess();
  });

  after(async () => {
    for (const peer of peers.splice(0)) await closePeer(peer).catch(() => undefined);
    if (server) {
      await server.stop();
      removeDataDir(server.dataDir);
    }
    temp?.cleanup();
  });

  async function share(name: string, timings: Partial<Timings>, files: Record<string, string | Buffer>) {
    const auth = await register(server!, `Pacing${name}`);
    const peer = await makePeer(temp!.dir, name.toLowerCase(), server!, auth, { timings });
    peers.push(peer);
    const root = path.join(peer.library, name);
    writeTree(root, files);
    const settled = settledSeconds();
    for (const relative of Object.keys(files)) utimesSync(path.join(root, relative), settled, settled);
    const shared = await peer.service.share({ notebook: name });
    const project = peer.service.project(shared.projectId)!;
    await project.whenIdle();
    return { peer, root, project, inner: internals(project) };
  }

  test("a real change fs.watch never reports puts the poll back on its short interval", { timeout: 30_000 }, async () => {
    const { root, inner } = await share("Missed", { pollMs: 50, watchedPollMs: 300, watchGraceMs: 200, watchRetrustMs: 1000 }, { "note.md": "one\n" });
    assert.ok(inner.watcher, "fs.watch runs on this platform");
    // A watcher that hears nothing (a network share, a stream broken by sleep).
    inner.watcher.close();
    inner.watcher = { close() {} };
    await sleep(800);
    assert.equal(inner.watcherTrusted, true, "polls that find nothing new keep the watcher trusted");
    writeFileSync(path.join(root, "added.md"), "new\n");
    await until(() => !inner.watcherTrusted, "the poll to notice the unreported file", 10_000);
    assert.equal(inner.pollInterval(), 50);
    // Not for the rest of the session: after watchRetrustMs it is trusted, and judged, again.
    await until(() => inner.watcherTrusted, "the watcher to be trusted again", 10_000);
    assert.equal(inner.pollInterval(), 300);
  });

  test("a verification that finds nothing new does not rewrite state.json", { timeout: 30_000 }, async () => {
    const { root, project, inner } = await share("Quiet", { pollMs: 40, verifyMs: 100, trustedVerifyMs: 100 }, { "note.md": "steady\n" });
    const stateFile = path.join(root, ".libera", "collab", "state.json");
    await sleep(300);
    const before = { mtimeMs: statSync(stateFile).mtimeMs, text: readFileSync(stateFile, "utf8") };
    const note = fileId(project, "note.md");
    await until(() => inner.verified.has(note), "a first verification", 5000);
    const first = inner.verified.get(note)!.at;
    await until(() => inner.verified.get(note)!.at > first + 250, "several more verifications", 5000);
    assert.equal(statSync(stateFile).mtimeMs, before.mtimeMs, "state.json was not written again");
    assert.equal(readFileSync(stateFile, "utf8"), before.text);
  });

  test("large files are verified on their own, finite schedule", { timeout: 30_000 }, async () => {
    // Large-file age 2.25–3.75 s: well clear of the 600 ms "not yet" window under suite load.
    const { project, inner } = await share("Figures", { pollMs: 40, verifyMs: 150, largeFileVerifyMs: 3000 }, {
      "note.md": "small\n",
      "figure.bin": Buffer.alloc(LARGE_FILE_BYTES + 1024, 7),
    });
    // Only the timers may cause re-reads from here on.
    inner.watcher?.close();
    inner.watcher = null;
    const small = fileId(project, "note.md");
    const figure = fileId(project, "figure.bin");
    await until(() => inner.verified.has(small) && inner.verified.has(figure), "a first verification of both files", 10_000);
    const smallAt = inner.verified.get(small)!.at;
    const figureAt = inner.verified.get(figure)!.at;
    await sleep(600);
    assert.ok(inner.verified.get(small)!.at > smallAt, "a small file is verified again after verifyMs");
    assert.equal(inner.verified.get(figure)!.at, figureAt, "a large file is not, yet");
    await until(() => inner.verified.get(figure)!.at > figureAt, "the large file's own verification", 10_000);
  });

  test("waking up makes small files verify again at once, large files keep their schedule", { timeout: 30_000 }, async () => {
    const { project, inner } = await share("Woken", { pollMs: 40, verifyMs: 600_000, trustedVerifyMs: 600_000, largeFileVerifyMs: 600_000 }, {
      "note.md": "small\n",
      "figure.bin": Buffer.alloc(LARGE_FILE_BYTES + 1024, 7),
    });
    inner.watcher?.close();
    inner.watcher = null;
    const small = fileId(project, "note.md");
    const figure = fileId(project, "figure.bin");
    await until(() => inner.verified.has(small) && inner.verified.has(figure), "a first verification of both files", 10_000);
    const smallAt = inner.verified.get(small)!.at;
    const figureAt = inner.verified.get(figure)!.at;
    await sleep(300);
    assert.equal(inner.verified.get(small)!.at, smallAt, "nothing is read again before the wake");
    inner.resumed();
    await until(() => inner.verified.get(small)!.at > smallAt, "the small file to be read again", 10_000);
    await sleep(300);
    assert.equal(inner.verified.get(figure)!.at, figureAt, "the large file was not");
  });

  test("a file with an mtime in the future is not re-read at every scan", { timeout: 30_000 }, async () => {
    const { root, project, inner } = await share("Skewed", { pollMs: 40, verifyMs: 150, largeFileVerifyMs: 600_000 }, {
      "figure.bin": Buffer.alloc(LARGE_FILE_BYTES + 1024, 7),
    });
    inner.watcher?.close();
    inner.watcher = null;
    // A copy from a computer whose clock is an hour ahead. Restoring the
    // recorded mtime afterwards would hide that, so the record follows it.
    const figure = fileId(project, "figure.bin");
    const before = inner.verified.get(figure)?.at ?? 0;
    const future = Date.now() / 1000 + 3600;
    utimesSync(path.join(root, "figure.bin"), future, future);
    await until(() => (inner.verified.get(figure)?.at ?? 0) > before, "a verification after the change", 10_000);
    // Its ctime (this machine's clock) has to be more than 3 s old first.
    await sleep(3500);
    const at = inner.verified.get(figure)!.at;
    await sleep(600);
    assert.equal(inner.verified.get(figure)!.at, at, "settled by its ctime, the file is not read again");
  });

  test("a large file overwritten with its size and mtime kept is put back", { timeout: 30_000 }, async () => {
    const original = Buffer.alloc(LARGE_FILE_BYTES + 1024, 7);
    const { root, inner } = await share("Restore", { pollMs: 40, verifyMs: 150, largeFileVerifyMs: 600_000 }, { "figure.bin": original });
    inner.watcher?.close();
    inner.watcher = null;
    const file = path.join(root, "figure.bin");
    const before = statSync(file);
    writeFileSync(file, Buffer.alloc(original.length, 9));
    utimesSync(file, before.atimeMs / 1000, before.mtimeMs / 1000);
    const after = statSync(file);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    if (after.ctimeMs === before.ctimeMs) return; // No usable ctime here: only the large-file age would catch it.
    await until(() => holds(file, original), "the shared version to be written back", 10_000);
  });

  test("a large file whose recovery failed is retried, not taken as verified", { timeout: 30_000 }, async () => {
    const original = Buffer.alloc(LARGE_FILE_BYTES + 1024, 7);
    const { root, project, inner } = await share("Retry", { pollMs: 40, verifyMs: 300, largeFileVerifyMs: 600_000, retryMs: 50 }, { "figure.bin": original });
    inner.watcher?.close();
    inner.watcher = null;
    const placeBlob = inner.placeBlob.bind(project);
    let calls = 0;
    inner.placeBlob = async (...args: unknown[]) => {
      calls += 1;
      return calls === 1 ? false : placeBlob(...args);
    };
    const file = path.join(root, "figure.bin");
    const before = statSync(file);
    writeFileSync(file, Buffer.alloc(original.length, 9));
    utimesSync(file, before.atimeMs / 1000, before.mtimeMs / 1000);
    await until(() => calls >= 1, "the first recovery attempt", 10_000);
    const figure = fileId(project, "figure.bin");
    assert.equal(inner.verified.get(figure)?.pending, true, "the failed recovery leaves the read pending");
    await until(() => calls >= 2 && holds(file, original), "a second attempt that writes the shared version back", 10_000);
  });
});
