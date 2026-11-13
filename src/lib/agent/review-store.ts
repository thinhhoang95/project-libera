import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertNotSharedPath, isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { LIBERA_SYSTEM_DIR } from "@/lib/storage/constants";
import { getStateRoot } from "@/lib/storage/paths";
import { getFileType } from "@/lib/storage/file-types";
import { StorageError } from "@/lib/storage/errors";
import { isTextFileType } from "@/lib/types";
import { writeJsonState } from "@/lib/storage/json-state";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { isPathMigrating } from "@/lib/storage/migration-fence";
import { resolveLibraryPath } from "./library";
import type { AgentReviewFile, AgentReviewRevertResult } from "./types";

// Manual review: the agent's edits are applied as usual, and each file it
// changes keeps a baseline, the text before the changes the user has not
// reviewed yet. Pending changes are the difference between the baseline and
// the file's current text. Accepting a change moves it into the baseline;
// rejecting one puts the baseline's text back. A file is reviewed once it is
// back to its baseline, and its entry is then dropped.
//
// One file per reviewed path in the app's state folder, never inside a
// notebook. Baselines carry across runs: a second run changing a file that
// is still under review keeps the first run's baseline.

type ReviewEntry = {
  version: 1;
  path: string;
  /** The text without the agent's unreviewed changes (the user's own edits included). */
  baseline: string;
  /** The agent created the file: rejecting everything removes it. */
  created: boolean;
  runIds: string[];
  updatedAt: string;
  revision?: string;
};

export type ReviewExpectation = { revision: string; current: string };

const revisionOf = (entry: ReviewEntry) => entry.revision ?? entry.updatedAt;
const conflict = (filePath: string) => new StorageError(`${filePath} changed while you were reviewing it. Refresh the review and try again.`, 409);

const MAX_RUN_IDS = 50;
const QUEUES_KEY = Symbol.for("libera.agentReviewQueues");
const holder = globalThis as { [QUEUES_KEY]?: Map<string, Promise<unknown>> };
const queues = holder[QUEUES_KEY] ??= new Map<string, Promise<unknown>>();

function reviewDirectory() {
  return path.join(getStateRoot(), LIBERA_SYSTEM_DIR, "agent-review");
}

function entryPath(filePath: string) {
  return path.join(reviewDirectory(), `${createHash("sha256").update(filePath).digest("hex").slice(0, 40)}.json`);
}

/** Runs `task` after earlier tasks on the same file, so reads and writes of one entry never interleave. */
function serialized<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const key = entryPath(filePath);
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(task);
  queues.set(key, run);
  void run.finally(() => { if (queues.get(key) === run) queues.delete(key); }).catch(() => undefined);
  return run;
}

/** Run Undo takes the same locks as agent writes and review decisions. */
export function withReviewFiles<T>(paths: string[], task: () => Promise<T>): Promise<T> {
  const targets = [...new Set(paths)].sort();
  const next = (index: number): Promise<T> => index === targets.length ? task() : serialized(targets[index], () => next(index + 1));
  return next(0);
}

function isEntry(value: unknown): value is ReviewEntry {
  const entry = value as ReviewEntry;
  return !!entry && entry.version === 1 && typeof entry.path === "string" && typeof entry.baseline === "string" &&
    typeof entry.created === "boolean" && typeof entry.updatedAt === "string" && Array.isArray(entry.runIds) && entry.runIds.every((id) => typeof id === "string");
}

async function readEntry(filePath: string): Promise<ReviewEntry | null> {
  try {
    const entry = JSON.parse(await readFile(entryPath(filePath), "utf8"));
    return isEntry(entry) && entry.path === filePath ? entry : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function removeEntry(filePath: string) {
  return rm(entryPath(filePath), { force: true });
}

async function resolveReviewPath(filePath: string) {
  const resolved = await resolveLibraryPath(filePath);
  if (resolved.path !== filePath || !resolved.pathParts.length || !isTextFileType(getFileType(resolved.path) ?? undefined)) {
    throw new StorageError("Review paths must name a text file in the library.");
  }
  return resolved;
}

/** The file's text on disk, or null when it or its notebook no longer exists. */
async function readDisk(filePath: string): Promise<string | null> {
  try {
    const resolved = await resolveReviewPath(filePath);
    if (!(await stat(resolved.absolutePath)).isFile()) return null;
    const text = await readFile(resolved.absolutePath, "utf8");
    if (text.includes("\0")) return null;
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error instanceof StorageError && error.status === 404)) return null;
    throw error;
  }
}

async function checkExpected(entry: ReviewEntry, expected?: ReviewExpectation) {
  if (expected && (revisionOf(entry) !== expected.revision || await readDisk(entry.path) !== expected.current)) throw conflict(entry.path);
}

/** Drops an entry whose file is back to its baseline, or was removed. Returns the file's text while it is still pending. */
async function settle(entry: ReviewEntry): Promise<string | null> {
  const current = isSharedNotebookPath(entry.path) ? null : await readDisk(entry.path);
  // A file half way through a notebook migration is not gone: keep its review for the migration to move.
  if (current === null && await isPathMigrating(entry.path)) return null;
  if (current === null || (current === entry.baseline && !(entry.created && current === ""))) {
    await removeEntry(entry.path);
    return null;
  }
  return current;
}

/**
 * Serializes an agent write with review reads and decisions. `before` is
 * the text the agent started from (the open tab's draft, or the disk), or
 * null when it creates the file. A file already under review keeps its baseline.
 */
export function withReviewWrite(filePath: string, before: string | null, runId: string | null, write: () => Promise<void>, verify?: () => Promise<void>) {
  return serialized(filePath, async () => {
    await resolveReviewPath(filePath);
    assertNotSharedPath(filePath);
    await verify?.();
    if (runId) {
      let existing = await readEntry(filePath);
      if (existing && await settle(existing) === null) existing = null;
      const entry: ReviewEntry = existing
        ? { ...existing, runIds: [...new Set([...existing.runIds, runId])].slice(-MAX_RUN_IDS), updatedAt: new Date().toISOString() }
        : { version: 1, path: filePath, baseline: before ?? "", created: before === null, runIds: [runId], updatedAt: new Date().toISOString(), revision: randomUUID() };
      await writeJsonState(entryPath(filePath), entry);
    }
    // Listing and decisions use this same queue: none can settle a baseline
    // between recording it and the write (including creation of a new file).
    try { await write(); }
    catch (error) {
      const entry = await readEntry(filePath);
      if (entry) await settle(entry);
      throw error;
    }
  });
}

/** The paths with a pending review, read without settling (or dropping) any of them, and how many entries can't be read: for checks. */
export async function listReviewEntryPaths(): Promise<{ paths: string[]; unreadable: number }> {
  let names: string[];
  try { names = (await readdir(reviewDirectory())).filter((name) => name.endsWith(".json")); }
  catch { return { paths: [], unreadable: 0 }; }
  const paths: string[] = [];
  let unreadable = 0;
  for (const name of names) {
    try {
      const entry = JSON.parse(await readFile(path.join(reviewDirectory(), name), "utf8"));
      if (isEntry(entry)) paths.push(entry.path);
      else unreadable += 1;
    } catch { unreadable += 1; }
  }
  return { paths: paths.sort(), unreadable };
}

/** Every file with changes to review, with its baseline and its text on disk. Settled entries are dropped on the way. */
export async function listPendingReviews(): Promise<AgentReviewFile[]> {
  let names: string[];
  try { names = (await readdir(reviewDirectory())).filter((name) => name.endsWith(".json")); }
  catch { return []; }
  const files: AgentReviewFile[] = [];
  for (const name of names) {
    let entry: unknown;
    try { entry = JSON.parse(await readFile(path.join(reviewDirectory(), name), "utf8")); }
    catch { continue; }
    if (!isEntry(entry)) continue;
    const pending = entry;
    const current = await serialized(pending.path, async () => {
      const latest = await readEntry(pending.path);
      return latest ? { entry: latest, text: await settle(latest) } : null;
    });
    if (current?.text != null) files.push({ path: current.entry.path, baseline: current.entry.baseline, current: current.text, created: current.entry.created, revision: revisionOf(current.entry) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The editor's review of a file moved its baseline: accepted changes joined
 * it, and so did the user's own edits outside the agent's changes. Only a
 * file already under review is updated. Returns whether it is still pending.
 */
export function setReviewBaseline(filePath: string, baseline: string, revision?: string) {
  return serialized(filePath, async () => {
    await resolveReviewPath(filePath);
    assertNotSharedPath(filePath);
    const entry = await readEntry(filePath);
    if (revision !== undefined && (!entry || revisionOf(entry) !== revision)) throw conflict(filePath);
    if (!entry) return { pending: false };
    const next = { ...entry, baseline, created: entry.created && baseline === "", updatedAt: new Date().toISOString(), revision: randomUUID() };
    await writeJsonState(entryPath(filePath), next);
    return { pending: (await settle(next)) !== null, revision: next.revision };
  });
}

/** Accept everything: the files stay as they are and leave review. */
export async function keepReviews(paths: string[], expected?: Record<string, ReviewExpectation>) {
  for (const filePath of paths) await serialized(filePath, async () => {
    await resolveReviewPath(filePath);
    const entry = await readEntry(filePath);
    if (expected && !entry) throw conflict(filePath);
    if (entry) await checkExpected(entry, expected?.[filePath]);
    await removeEntry(filePath);
  });
}

/**
 * Reject everything: each file gets its baseline back (a file the agent
 * created is removed while nothing else was written into it). `baselines`
 * carries the editors' latest baselines, which may be newer than the stored ones.
 */
export async function revertReviews(paths: string[], baselines: Record<string, string> = {}, expected?: Record<string, ReviewExpectation>): Promise<AgentReviewRevertResult[]> {
  const results: AgentReviewRevertResult[] = [];
  for (const filePath of paths) {
    results.push(await serialized(filePath, async (): Promise<AgentReviewRevertResult> => {
      const entry = await readEntry(filePath);
      if (!entry) return { path: filePath, status: "missing", message: `${filePath} has no changes to review.` };
      if (isSharedNotebookPath(filePath)) {
        await removeEntry(filePath);
        return { path: filePath, status: "missing", message: `${filePath} is in a shared notebook now, so it was not reverted.` };
      }
      if (await readDisk(filePath) === null) {
        await removeEntry(filePath);
        return { path: filePath, status: "missing", message: `${filePath} is no longer available.` };
      }
      await checkExpected(entry, expected?.[filePath]);
      const { absolutePath } = await resolveReviewPath(filePath);
      const baseline = typeof baselines[filePath] === "string" ? baselines[filePath] : entry.baseline;
      assertNotSharedPath(filePath);
      const deleted = entry.created && baseline === "";
      if (deleted) await rm(absolutePath, { force: true });
      else await writeFile(absolutePath, baseline, "utf8");
      await removeEntry(filePath);
      notifySearchChanges([filePath]);
      return deleted ? { path: filePath, status: "deleted" } : { path: filePath, status: "restored", content: baseline };
    }).catch((error): AgentReviewRevertResult => ({ path: filePath, status: "conflict", message: error instanceof Error ? error.message : `Could not revert ${filePath}.` })));
  }
  return results;
}

/** After the files changed some other way (Undo of a run), drop entries that are settled now. */
export async function pruneReviews(paths: string[]) {
  for (const filePath of paths) {
    await serialized(filePath, async () => {
      const entry = await readEntry(filePath);
      if (entry) await settle(entry);
    });
  }
}

/**
 * A file moving to a new path in a notebook migration: its pending review is
 * written at the new path (with `transform` applied to its baseline, as the
 * migration applies it to the file) before `move` runs, under both paths'
 * locks, and removed from the old path after. At no point is the review only
 * at a path whose file is missing.
 */
export function withMovedReview<T>(from: string, to: string, transform: (text: string) => string, move: () => Promise<T>): Promise<T> {
  return withReviewFiles([from, to], async () => {
    const entry = await readEntry(from);
    if (entry) await writeJsonState(entryPath(to), { ...entry, path: to, baseline: transform(entry.baseline), updatedAt: new Date().toISOString(), revision: randomUUID() });
    let result: T;
    try { result = await move(); }
    catch (error) {
      if (entry) await removeEntry(to);
      throw error;
    }
    if (entry) await removeEntry(from);
    return result;
  });
}

/** Whether a file has a pending review stored, settled or not: a move onto its path would take it over. */
export async function hasReviewEntry(filePath: string) {
  return (await readEntry(filePath)) !== null;
}

/**
 * A folder moving (rename, archive): the pending reviews of every file under
 * it follow, by the same rule as withMovedReview. At no point is a review only
 * at a path whose file is missing.
 */
export async function withMovedReviewsUnder<T>(from: string, to: string, move: () => Promise<T>): Promise<T> {
  const moved = (filePath: string) => to + filePath.slice(from.length);
  let names: string[] = [];
  try { names = (await readdir(reviewDirectory())).filter((name) => name.endsWith(".json")); } catch { /* No reviews. */ }
  const paths: string[] = [];
  for (const name of names) {
    try {
      const entry = JSON.parse(await readFile(path.join(reviewDirectory(), name), "utf8"));
      if (isEntry(entry) && entry.path.startsWith(`${from}/`)) paths.push(entry.path);
    } catch { /* Unreadable entries are the check's to report. */ }
  }
  return withReviewFiles([...paths, ...paths.map(moved)], async () => {
    const carried: ReviewEntry[] = [];
    for (const filePath of paths) {
      const entry = await readEntry(filePath);
      if (!entry) continue;
      carried.push(entry);
      await writeJsonState(entryPath(moved(filePath)), { ...entry, path: moved(filePath), updatedAt: new Date().toISOString(), revision: randomUUID() });
    }
    let result: T;
    try { result = await move(); }
    catch (error) {
      for (const entry of carried) await removeEntry(moved(entry.path));
      throw error;
    }
    for (const entry of carried) await removeEntry(entry.path);
    return result;
  });
}

/** Rewrite the baselines of these files' pending reviews (citation keys a migration changed in the files). */
export async function transformReviewBaselines(transforms: ReadonlyMap<string, (text: string) => string>) {
  for (const [filePath, transform] of transforms) {
    await serialized(filePath, async () => {
      const entry = await readEntry(filePath);
      if (!entry) return;
      const baseline = transform(entry.baseline);
      if (baseline !== entry.baseline) await writeJsonState(entryPath(filePath), { ...entry, baseline, updatedAt: new Date().toISOString(), revision: randomUUID() });
    });
  }
}
