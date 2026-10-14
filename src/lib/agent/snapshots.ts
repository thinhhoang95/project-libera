import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStateRoot } from "@/lib/storage/paths";
import { LIBERA_SYSTEM_DIR } from "@/lib/storage/constants";
import { resolveLibraryPath } from "./library";
import type { UndoResult } from "./types";

// Before an agent run first writes a file, its original content is kept here
// so the run, or any single file in it, can be undone. Manifests live in the
// app's state folder, never inside a notebook.

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
  const target = manifestPath(manifest.runId);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(manifest), { mode: 0o600 });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
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

export class RunSnapshots {
  private manifest: Manifest;
  private queue = Promise.resolve();

  constructor(readonly runId: string) {
    this.manifest = { version: 1, runId, createdAt: new Date().toISOString(), files: {} };
  }

  has(filePath: string) {
    return filePath in this.manifest.files;
  }

  /** Call before the first write to a file in this run. */
  async recordOriginal(filePath: string, original: string | null, draft?: string) {
    if (this.has(filePath)) return;
    this.manifest.files[filePath] = { existed: original !== null, original, ...(draft !== undefined && draft !== original ? { draft } : {}), written: "" };
    await this.flush();
    if (Object.keys(this.manifest.files).length === 1) void pruneManifests(this.runId).catch(() => undefined);
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

/** Restore files changed by a run: all of them, or only `paths`. Files edited after the run are left alone. */
export async function undoRun(runId: string, paths?: string[]): Promise<UndoResult[]> {
  const manifest = await readManifest(runId);
  if (!manifest) throw new Error("This run's undo history is no longer available.");
  const targets = Object.keys(manifest.files).filter((filePath) => !paths || paths.includes(filePath));
  const results: UndoResult[] = [];
  for (const filePath of targets) {
    const file = manifest.files[filePath];
    if (file.reverted) { results.push({ path: filePath, status: "already-reverted" }); continue; }
    let absolutePath: string;
    try { absolutePath = (await resolveLibraryPath(filePath)).absolutePath; }
    catch (error) { results.push({ path: filePath, status: "missing", message: error instanceof Error ? error.message : "The file's notebook is unavailable." }); continue; }
    const current = await readCurrent(absolutePath);
    if (current === null && file.existed) {
      results.push({ path: filePath, status: "missing", message: `${filePath} no longer exists.` });
      continue;
    }
    if (current !== null && file.written && hashContent(current) !== file.written) {
      results.push({ path: filePath, status: "conflict", message: `${filePath} changed after the agent edited it, so it was not undone.` });
      continue;
    }
    if (!file.existed) {
      await rm(absolutePath, { force: true });
      results.push({ path: filePath, status: "deleted" });
    } else {
      await writeFile(absolutePath, file.original ?? "", "utf8");
      results.push({ path: filePath, status: "restored", content: file.original ?? "", ...(file.draft !== undefined ? { draft: file.draft } : {}) });
    }
    file.reverted = true;
  }
  await writeManifest(manifest);
  return results;
}
