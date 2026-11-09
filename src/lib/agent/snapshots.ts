import { notifySearchChanges } from "@/lib/storage/search-updates";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { readSharedText, withdrawSharedRun, writeSharedText } from "@/lib/collab/shared-writes";
import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStateRoot } from "@/lib/storage/paths";
import { LIBERA_SYSTEM_DIR } from "@/lib/storage/constants";
import { writeJsonState } from "@/lib/storage/json-state";
import { resolveLibraryPath } from "./library";
import { withReviewFiles } from "./review-store";
import type { UndoResult } from "./types";

// Before an agent run first writes a file, its original content is kept here
// so the run, or any single file in it, can be undone. Manifests live in the
// app's state folder, never inside a notebook.
//
// Files in a shared notebook are recorded with `shared`. Since Phase 3 the
// agent's changes there are suggestions (`mode: "suggest"`): undo withdraws
// the run's pending suggestions on the document. Runs from before recorded
// direct edits (no mode); their undo still sends inverse edits through the
// host (provenance "undo") instead of writing the working copy. That is the
// only use left of the direct-edit path.

type SnapshotFile = {
  /** False when the run created the file. */
  existed: boolean;
  /** Content on disk before the run touched it. */
  original: string | null;
  /** Unsaved editor draft the agent started from, when it differed from disk. */
  draft?: string;
  /** Hash of the content the agent last wrote, to detect later edits. */
  written: string;
  reverted?: boolean;
  /** Where the file is now, when a notebook migration moved it after the run (recordMovedRunFiles). */
  movedTo?: string;
  /**
   * Set when the file is a shared document: undo goes through the collab
   * host. "suggest": the run made suggestions (`suggestions` lists them);
   * without a mode, an older run's direct edits.
   */
  shared?: { docId: string; mode?: "suggest"; suggestions?: string[] };
};

type Manifest = { version: 1; runId: string; createdAt: string; files: Record<string, SnapshotFile> };

const MAX_MANIFESTS = 200;
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
const RUN_ID_PATTERN = /^[a-z0-9-]{8,64}$/i;

export function hashContent(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

export function isRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

function runsDirectory() {
  return path.join(getStateRoot(), LIBERA_SYSTEM_DIR, "agent-runs");
}

function manifestPath(runId: string) {
  if (!isRunId(runId)) throw new Error("Invalid run id.");
  return path.join(runsDirectory(), `${runId}.json`);
}

async function writeManifest(manifest: Manifest) {
  await writeJsonState(manifestPath(manifest.runId), manifest);
}

async function readManifest(runId: string): Promise<Manifest | null> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath(runId), "utf8")) as Manifest;
    return manifest?.version === 1 && manifest.files && typeof manifest.files === "object" ? manifest : null;
  } catch { return null; }
}

/** Removes old manifests so the folder cannot grow without bound. */
async function pruneManifests(keep: string) {
  let names: string[];
  try { names = (await readdir(runsDirectory())).filter((name) => name.endsWith(".json")); }
  catch { return; }
  const entries = await Promise.all(names.map(async (name) => {
    try { return { name, mtime: (await stat(path.join(runsDirectory(), name))).mtimeMs }; }
    catch { return null; }
  }));
  const sorted = entries.filter((entry): entry is { name: string; mtime: number } => !!entry && entry.name !== `${keep}.json`)
    .sort((left, right) => right.mtime - left.mtime);
  const cutoff = Date.now() - MAX_AGE_MS;
  await Promise.all(sorted.filter((entry, index) => index >= MAX_MANIFESTS - 1 || entry.mtime < cutoff)
    .map((entry) => rm(path.join(runsDirectory(), entry.name), { force: true })));
}

/** Runs started in this process keep their manifest in memory; a migration updates it there (recordMovedRunFiles). */
const ACTIVE_RUNS = Symbol.for("libera.activeRunSnapshots");
const MAX_ACTIVE_RUNS = 20;
function activeRuns() {
  const holder = globalThis as { [ACTIVE_RUNS]?: Map<string, RunSnapshots> };
  return holder[ACTIVE_RUNS] ??= new Map();
}

export class RunSnapshots {
  private manifest: Manifest;
  private queue = Promise.resolve();

  constructor(readonly runId: string) {
    this.manifest = { version: 1, runId, createdAt: new Date().toISOString(), files: {} };
    const runs = activeRuns();
    runs.set(runId, this);
    for (const id of [...runs.keys()].slice(0, Math.max(0, runs.size - MAX_ACTIVE_RUNS))) runs.delete(id);
  }

  /** Apply a change to the live manifest and save it, in order with the run's own saves. */
  async update(change: (manifest: Manifest) => boolean) {
    if (!Object.keys(this.manifest.files).length) return;
    if (change(this.manifest)) await this.flush();
  }

  has(filePath: string) {
    return filePath in this.manifest.files;
  }

  /** Call before the first write to a file in this run. */
  async recordOriginal(filePath: string, original: string | null, draft?: string, shared?: { docId: string; mode?: "suggest" }) {
    if (this.has(filePath)) return;
    this.manifest.files[filePath] = {
      existed: original !== null,
      original,
      ...(draft !== undefined && draft !== original ? { draft } : {}),
      written: "",
      ...(shared ? { shared: { docId: shared.docId, ...(shared.mode ? { mode: shared.mode, suggestions: [] } : {}) } } : {}),
    };
    await this.flush();
    if (Object.keys(this.manifest.files).length === 1) void pruneManifests(this.runId).catch(() => undefined);
  }

  /** The suggestions a write to a shared file created, so the run's summary and undo know them. */
  async recordSuggestions(filePath: string, suggestionIds: string[]) {
    const shared = this.manifest.files[filePath]?.shared;
    if (!shared || shared.mode !== "suggest") return;
    shared.suggestions = [...new Set([...(shared.suggestions ?? []), ...suggestionIds])];
    await this.flush();
  }

  async recordWritten(filePath: string, content: string) {
    const file = this.manifest.files[filePath];
    if (!file) return;
    file.written = hashContent(content);
    await this.flush();
  }

  private flush() {
    const snapshot = structuredClone(this.manifest);
    this.queue = this.queue.then(() => writeManifest(snapshot));
    return this.queue;
  }
}

async function readCurrent(absolutePath: string) {
  try { return await readFile(absolutePath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Undo of the run's suggestions on one shared document: the pending ones are
 * withdrawn. One already accepted changed the text through a decision, which
 * only "Undo acceptance" in the Suggestions panel reverts; it is reported.
 */
async function withdrawSharedSuggestions(runId: string, filePath: string, file: SnapshotFile): Promise<UndoResult> {
  const docId = file.shared!.docId;
  try {
    const result = await withdrawSharedRun(filePath, docId, runId);
    const decided = result.skipped.filter((item) => item.status === "accepted" || item.status === "rejected");
    const accepted = decided.filter((item) => item.status === "accepted").length;
    if (accepted) {
      return {
        path: filePath,
        status: "conflict",
        shared: true,
        withdrawn: result.withdrawn.length,
        message: `${accepted === 1 ? "A suggestion" : `${accepted} suggestions`} the agent made in ${filePath} ${accepted === 1 ? "was" : "were"} already accepted, so ${accepted === 1 ? "it was" : "they were"} not undone; use Undo acceptance in the Suggestions panel.${result.withdrawn.length ? ` ${result.withdrawn.length} pending ${result.withdrawn.length === 1 ? "suggestion was" : "suggestions were"} withdrawn.` : ""}`,
      };
    }
    return { path: filePath, status: "restored", shared: true, withdrawn: result.withdrawn.length };
  } catch (error) {
    return { path: filePath, status: "conflict", shared: true, message: error instanceof Error ? error.message : `The agent's suggestions in ${filePath} could not be withdrawn.` };
  }
}

/** Undo of an older run's direct edits to one shared document: inverse edits through the host, only while it still holds exactly what the agent wrote. */
async function undoSharedFile(runId: string, filePath: string, file: SnapshotFile): Promise<UndoResult> {
  if (!isSharedNotebookPath(filePath)) {
    return { path: filePath, status: "conflict", message: `${filePath} is no longer in a shared notebook on this computer, so it was not undone.` };
  }
  let current: string;
  try { current = (await readSharedText(filePath)).text; }
  catch (error) { return { path: filePath, status: "conflict", message: error instanceof Error ? error.message : `${filePath} could not be read from the shared notebook.` }; }
  if (file.written && hashContent(current) !== file.written) {
    return { path: filePath, status: "conflict", message: `${filePath} changed after the agent edited it (in the shared notebook), so it was not undone.` };
  }
  try {
    // expectedBefore: a collaborator's edit between the read and the write
    // makes this a conflict instead of reverting their text too.
    const result = await writeSharedText(filePath, file.original ?? "", { source: "undo", feature: "agent", runId }, { expectedBefore: current });
    if (result.conflict) return { path: filePath, status: "conflict", message: `${filePath} changed while undoing (in the shared notebook), so it was not undone.` };
    return { path: filePath, status: "restored", content: result.text, shared: true };
  } catch (error) {
    return { path: filePath, status: "conflict", message: error instanceof Error ? error.message : `${filePath} could not be undone in the shared notebook.` };
  }
}

/** Restore files changed by a run: all of them, or only `paths`. Files edited after the run are left alone. */
export async function undoRun(runId: string, paths?: string[]): Promise<UndoResult[]> {
  const manifest = await readManifest(runId);
  if (!manifest) throw new Error("This run's undo history is no longer available.");
  const targets = Object.keys(manifest.files).filter((filePath) => !paths || paths.includes(filePath));
  return withReviewFiles(targets.map((filePath) => manifest.files[filePath].movedTo ?? filePath), () => undoFiles(runId, manifest, targets));
}

async function undoFiles(runId: string, manifest: Manifest, targets: string[]): Promise<UndoResult[]> {
  const results: UndoResult[] = [];
  for (const filePath of targets) {
    const file = manifest.files[filePath];
    if (file.reverted) { results.push({ path: filePath, status: "already-reverted" }); continue; }
    if (file.shared) {
      const result = file.shared.mode === "suggest" ? await withdrawSharedSuggestions(runId, filePath, file) : await undoSharedFile(runId, filePath, file);
      results.push(result);
      if (result.status === "restored") file.reverted = true;
      continue;
    }
    // A file migrated to another notebook after the run is undone where it is now.
    const diskPath = file.movedTo ?? filePath;
    const moved = file.movedTo ? { currentPath: file.movedTo } : {};
    let absolutePath: string;
    try { absolutePath = (await resolveLibraryPath(diskPath)).absolutePath; }
    catch (error) { results.push({ path: filePath, ...moved, status: "missing", message: error instanceof Error ? error.message : "The file's notebook is unavailable." }); continue; }
    if (isSharedNotebookPath(diskPath)) {
      // The notebook was shared after the run; undoing would bypass the collab host.
      results.push({ path: filePath, ...moved, status: "conflict", message: `${diskPath} is in a shared notebook now, so it was not undone.` });
      continue;
    }
    const current = await readCurrent(absolutePath);
    if (current === null && file.existed) {
      results.push({ path: filePath, ...moved, status: "missing", message: `${diskPath} no longer exists.` });
      continue;
    }
    if (current !== null && file.written && hashContent(current) !== file.written) {
      results.push({ path: filePath, ...moved, status: "conflict", message: `${diskPath} changed after the agent edited it, so it was not undone.` });
      continue;
    }
    if (!file.existed) {
      await rm(absolutePath, { force: true });
      results.push({ path: filePath, ...moved, status: "deleted" });
    } else {
      await writeFile(absolutePath, file.original ?? "", "utf8");
      results.push({ path: filePath, ...moved, status: "restored", content: file.original ?? "", ...(file.draft !== undefined ? { draft: file.draft } : {}) });
    }
    file.reverted = true;
    notifySearchChanges([diskPath]);
  }
  await writeManifest(manifest);
  return results;
}

/** How a notebook migration changed a file a run may have edited (recordMovedRunFiles). */
export type MovedRunFile = {
  to: string;
  /** Rewrites applied to the file (image paths, citation keys): applied to the original and draft, so Undo restores text that works where the file is now. */
  transform?: (text: string) => string;
  /** The file's hash before and after those rewrites: a run that wrote `before` counts as having written `after`. */
  hashes?: { before: string; after: string };
};

function applyMoves(manifest: Manifest, moves: ReadonlyMap<string, MovedRunFile>) {
  let changed = false;
  for (const [key, file] of Object.entries(manifest.files)) {
    if (file.shared) continue;
    const move = moves.get(file.movedTo ?? key);
    if (!move) continue;
    if (move.to === key) delete file.movedTo;
    else file.movedTo = move.to;
    if (move.transform) {
      if (file.original !== null) file.original = move.transform(file.original);
      if (file.draft !== undefined) file.draft = move.transform(file.draft);
    }
    if (move.hashes && file.written === move.hashes.before) file.written = move.hashes.after;
    changed = true;
  }
  return changed;
}

/**
 * Files moved to new paths by a notebook migration: a run that changed them
 * can still be undone, where they are now. Manifests keep the recorded path
 * as the key, since the run's changes list (in chat history) names it. Runs
 * of this process are updated in memory, so their next save keeps the change.
 */
export async function recordMovedRunFiles(moves: ReadonlyMap<string, MovedRunFile>) {
  if (!moves.size) return;
  const live = activeRuns();
  for (const run of live.values()) await run.update((manifest: Manifest) => applyMoves(manifest, moves));
  let names: string[];
  try { names = (await readdir(runsDirectory())).filter((name) => name.endsWith(".json")); }
  catch { return; }
  for (const name of names) {
    const runId = name.slice(0, -".json".length);
    if (!isRunId(runId) || live.has(runId)) continue;
    const manifest = await readManifest(runId);
    if (manifest && applyMoves(manifest, moves)) await writeManifest(manifest);
  }
}

/** The files undo history can restore, where each is now: for checks. Read only. */
export async function listRunFiles(): Promise<{ files: { runId: string; path: string; recordedPath: string; reverted: boolean; shared: boolean }[]; unreadable: number }> {
  let names: string[];
  try { names = (await readdir(runsDirectory())).filter((name) => name.endsWith(".json")); }
  catch { return { files: [], unreadable: 0 }; }
  const files: { runId: string; path: string; recordedPath: string; reverted: boolean; shared: boolean }[] = [];
  let unreadable = 0;
  for (const name of names) {
    const runId = name.slice(0, -".json".length);
    const manifest = isRunId(runId) ? await readManifest(runId) : null;
    if (!manifest) { unreadable += 1; continue; }
    for (const [key, file] of Object.entries(manifest.files)) {
      files.push({ runId, path: file.movedTo ?? key, recordedPath: key, reverted: !!file.reverted, shared: !!file.shared });
    }
  }
  return { files, unreadable };
}
