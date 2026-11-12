// File-system helpers for the shared notebook working copy: atomic writes,
// containment checks, and the walk the watcher and the import share.

import { createHash, randomBytes } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";

import { manifestPathError } from "../../../src/lib/collab/protocol/schema";

/** Marker in a shared notebook's root (read by the Next write guard too). */
export const SHARED_MARKER_FILE = ".libera-shared.json";
/** Share plan, kept until the share finishes so an interrupted share resumes with the same ids. */
export const SHARE_PENDING_FILE = ".libera-share-pending.json";
/** Per-notebook host state lives in Libera's existing per-notebook system folder. */
export const STATE_DIRECTORY = [".libera", "collab"] as const;
/** Libera's archive folder (storage/constants ARCHIVE_DIR). Local-only in shared notebooks. */
export const ARCHIVE_DIRECTORY = "_archive";
/** Prefix of this module's temp files; ".libera" names are never shared. */
const TEMP_PREFIX = ".libera-tmp-";

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("base64url")}`;
}

/**
 * Names the watcher and the import never share: hidden entries (Libera hides
 * them, and .libera* is its own state), editor and OS droppings, and the
 * temp files of atomic writes, Libera's included (`<name>.<pid>.<uuid>.tmp`).
 */
export function isIgnoredName(name: string): boolean {
  if (name.startsWith(".") || name.startsWith("~$")) return true;
  const lower = name.toLowerCase();
  if (lower === "thumbs.db" || lower === "desktop.ini" || lower === "__macosx") return true;
  return /(\.tmp|\.swp|\.swx|\.crdownload|\.part|~)$/i.test(name);
}

/**
 * Build products of LaTeX and its tools, written next to the sources by an
 * external build (latexmk, TeXShop, VS Code): rebuilt on every compile, so
 * importing them would upload a new version each time. Libera's own builds
 * put them outside the notebook.
 */
const GENERATED_EXTENSIONS = new Set([
  "aux", "log", "out", "toc", "lof", "lot", "loa", "lol", "fls", "fdb_latexmk", "synctex", "xdv", "dvi",
  "bbl", "blg", "bcf", "nav", "snm", "vrb", "idx", "ilg", "ind", "glo", "gls", "glg", "ist", "acn", "acr", "alg",
  "thm", "figlist", "auxlock", "ptc", "tdo", "brf", "spl", "soc", "run.xml", "synctex.gz", "synctex(busy)",
]);

/**
 * Whether a new file found on disk is a generated build product (above) or
 * lives in one's output folder (`_minted-*`). The scan does not share these
 * on its own; one added explicitly through Libera, or already shared, stays.
 */
export function isGeneratedPath(relative: string): boolean {
  const segments = relative.split("/");
  if (segments.slice(0, -1).some((segment) => /^_minted/i.test(segment))) return true;
  const name = segments[segments.length - 1].toLowerCase();
  for (let dot = name.indexOf("."); dot > 0; dot = name.indexOf(".", dot + 1)) {
    if (GENERATED_EXTENSIONS.has(name.slice(dot + 1))) return true;
  }
  return false;
}

/** Whether a manifest-style relative path ("a/b.md") may be shared from this notebook. */
export function isShareablePath(relative: string): boolean {
  if (manifestPathError(relative) !== null) return false;
  const segments = relative.split("/");
  if (segments[0].toLowerCase() === ARCHIVE_DIRECTORY) return false;
  return !segments.some(isIgnoredName);
}

export function toRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

/**
 * Resolves a manifest path inside the notebook root, refusing anything that
 * could land outside it: invalid manifest paths, and any existing component
 * that is a symlink or junction (a collaborator's file must never be written
 * through a link the local user created, wherever it points).
 */
export async function resolveInside(root: string, relative: string): Promise<string> {
  const problem = manifestPathError(relative);
  if (problem) throw new PathRefusedError(relative, problem);
  const absolute = path.resolve(root, ...relative.split("/"));
  const inside = path.relative(root, absolute);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new PathRefusedError(relative, "Path escapes the notebook folder.");
  }
  let current = root;
  for (const segment of inside.split(path.sep)) {
    current = path.join(current, segment);
    let stats: Stats;
    try {
      stats = await fs.lstat(current);
    } catch {
      break;
    }
    if (stats.isSymbolicLink()) throw new PathRefusedError(relative, "Path goes through a symbolic link.");
  }
  return absolute;
}

export class PathRefusedError extends Error {
  constructor(
    readonly relative: string,
    reason: string,
  ) {
    super(`${relative}: ${reason}`);
    this.name = "PathRefusedError";
  }
}

export async function readIfExists(absolute: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(absolute);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function statIfExists(absolute: string): Promise<Stats | null> {
  try {
    return await fs.lstat(absolute);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Windows refuses to replace a file another program holds open (antivirus, indexers, viewers). */
function isBusy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

export interface WriteGuard {
  /** Existing notebook root: parent creation must never recreate this directory. */
  root: string;
  canCommit(): Promise<boolean>;
}

export class WriteCancelledError extends Error {
  constructor() { super("The notebook changed or stopped before the disk operation could finish."); }
}

export async function checkWriteGuard(guard?: WriteGuard): Promise<void> {
  if (guard && !(await guard.canCommit())) throw new WriteCancelledError();
}

/** Fence the exact destination observation across IO and busy-file retries. */
export function contentGuard(absolute: string, expected: string | null, guard: WriteGuard): WriteGuard {
  return { root: guard.root, canCommit: async () => {
    if (!(await guard.canCommit())) return false;
    await resolveInside(guard.root, toRelative(guard.root, absolute));
    const bytes = await readIfExists(absolute);
    return (bytes === null ? null : sha256(bytes)) === expected;
  } };
}

/** Create descendants one level at a time, without recursively resurrecting a root. */
export async function ensureDirectory(directory: string, guard?: WriteGuard): Promise<void> {
  await checkWriteGuard(guard);
  if (!guard) { await fs.mkdir(directory, { recursive: true }); return; }
  const relative = path.relative(guard.root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new WriteCancelledError();
  let current = guard.root;
  const root = await statIfExists(current);
  if (!root?.isDirectory() || root.isSymbolicLink()) throw new WriteCancelledError();
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    await checkWriteGuard(guard);
    current = path.join(current, segment);
    try { await fs.mkdir(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stats = await fs.lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new WriteCancelledError();
  }
}

/**
 * Writes bytes atomically: a temp file in the same directory, then rename,
 * so readers (search, latexmk, the PDF viewer) never see a half-written file.
 * The existing file's mode is kept. If the rename keeps failing because the
 * target is held open, the bytes are copied over it in place instead: a
 * non-atomic write beats losing the change.
 */
export async function writeFileAtomic(absolute: string, bytes: Uint8Array, guard?: WriteGuard): Promise<Stats> {
  const directory = path.dirname(absolute);
  await ensureDirectory(directory, guard);
  const previous = await statIfExists(absolute);
  const temporary = path.join(directory, `${TEMP_PREFIX}${randomBytes(6).toString("hex")}`);
  try {
    await checkWriteGuard(guard);
    await fs.writeFile(temporary, bytes, { flag: "wx", ...(previous ? { mode: previous.mode & 0o7777 } : {}) });
    if (previous) await fs.chmod(temporary, previous.mode & 0o7777).catch(() => undefined);
    let renamed = false;
    for (let attempt = 0; attempt < 8 && !renamed; attempt += 1) {
      try {
        await checkWriteGuard(guard);
        await fs.rename(temporary, absolute);
        renamed = true;
      } catch (error) {
        if (!isBusy(error)) throw error;
        await sleep(25 * 2 ** attempt);
      }
    }
    if (!renamed) {
      await checkWriteGuard(guard);
      await fs.copyFile(temporary, absolute);
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
  return fs.lstat(absolute);
}

/** Moves a file or folder, creating the destination's parent. */
export async function movePath(from: string, to: string, guard?: WriteGuard): Promise<void> {
  await ensureDirectory(path.dirname(to), guard);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await checkWriteGuard(guard);
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (!isBusy(error) || attempt >= 6) throw error;
      await sleep(25 * 2 ** attempt);
    }
  }
}

/** A free name in `directory` for `name`: "name.ext", then "name (2).ext", … */
export async function availableName(directory: string, name: string, taken?: (candidate: string) => boolean): Promise<string> {
  const extension = path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = index === 1 ? name : `${stem} (${index})${extension}`;
    if (taken?.(candidate)) continue;
    if (!(await statIfExists(path.join(directory, candidate)))) return candidate;
  }
  throw new Error(`No free name for ${name} in ${directory}`);
}

export interface WalkEntry {
  /** Manifest-style relative path. */
  relative: string;
  kind: "file" | "folder";
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
  birthtimeMs?: number;
  /** An online-only placeholder (see isDataless): reading it downloads it. */
  dataless?: boolean;
}

/**
 * Whether a file is an online-only placeholder of a cloud provider (OneDrive
 * Files On-Demand, iCloud "Optimize Storage"): bytes it claims, none on disk.
 * Reading one waits for a download. Not judged on Windows, where Node reports
 * no block counts.
 */
export function isDataless(stats: { size: number; blocks?: number }): boolean {
  return process.platform !== "win32" && stats.size > 0 && stats.blocks === 0;
}

/** readWithin's answer when the read did not finish in time (a download, a stalled provider). */
export const SLOW_READ = Symbol("slow-read");

/**
 * readIfExists that stops waiting after `ms`. The read itself cannot be
 * cancelled; it carries on (and the provider keeps downloading), so a later
 * attempt usually finds the bytes local. Callers retry rather than hold a
 * queue that other work, stopping, and lease changes wait on.
 */
export async function readWithin(absolute: string, ms: number): Promise<Buffer | null | typeof SLOW_READ> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<typeof SLOW_READ>((resolve) => {
    timer = setTimeout(() => resolve(SLOW_READ), ms);
    timer.unref?.();
  });
  const read = readIfExists(absolute);
  // A read given up on must not surface later as an unhandled rejection.
  read.catch(() => undefined);
  try {
    return await Promise.race([read, slow]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The creation date Finder gives a file while it copies into it (its "busy"
 * date, 24 January 1984). The file keeps its name, starts empty, and gets its
 * real creation and modified dates when the copy ends.
 */
const FINDER_BUSY_BIRTH_MS = Date.UTC(1984, 0, 24, 8);
/** How long a new empty file may still be the start of a copy by another program. */
const EMPTY_FILE_SETTLE_MS = 3000;

/** Whether Finder is still copying into this file. */
export function isFinderCopy(entry: Pick<WalkEntry, "birthtimeMs">): boolean {
  return entry.birthtimeMs !== undefined && Math.abs(entry.birthtimeMs - FINDER_BUSY_BIRTH_MS) < 1000;
}

/** Whether a file not yet shared may still be arriving, so its bytes mean nothing yet. */
export function mayStillBeCopying(entry: Pick<WalkEntry, "size" | "mtimeMs" | "birthtimeMs">, now: number): boolean {
  return isFinderCopy(entry) || (entry.size === 0 && now - entry.mtimeMs < EMPTY_FILE_SETTLE_MS);
}

export interface NotebookWalk {
  entries: WalkEntry[];
  skipped: string[];
  /** False means unvisited paths are unknown, never confirmed deletions. */
  complete: boolean;
}

/**
 * Lists what the notebook folder holds that could be shared. Symlinks are
 * skipped (never followed), as are ignored names and the local archive.
 */
export async function walkNotebook(root: string, limit = 50_000): Promise<NotebookWalk> {
  const entries: WalkEntry[] = [];
  const skipped: string[] = [];
  let complete = true;
  const visit = async (directory: string, prefix: string) => {
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if (isNotFound(error)) { complete = false; return; }
      throw error;
    }
    names.sort();
    for (const name of names) {
      if (entries.length >= limit) { complete = false; return; }
      const relative = prefix ? `${prefix}/${name}` : name;
      if (isIgnoredName(name)) continue;
      if (!prefix && name.toLowerCase() === ARCHIVE_DIRECTORY) continue;
      const absolute = path.join(directory, name);
      const stats = await statIfExists(absolute);
      if (!stats) { complete = false; continue; }
      if (stats.isSymbolicLink()) { skipped.push(relative); continue; }
      if (!isShareablePath(relative)) {
        skipped.push(relative);
        continue;
      }
      if (stats.isDirectory()) {
        entries.push({ relative, kind: "folder", size: 0, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs });
        await visit(absolute, relative);
      } else if (stats.isFile()) {
        entries.push({ relative, kind: "file", size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, birthtimeMs: stats.birthtimeMs, ...(isDataless(stats) ? { dataless: true } : {}) });
      }
    }
  };
  await visit(root, "");
  return { entries, skipped, complete };
}

/** Removes empty directories from `relative` upwards, stopping at the root or a non-empty one. */
export async function pruneEmptyDirectories(root: string, relative: string, keep: (relative: string) => boolean, guard?: WriteGuard): Promise<void> {
  let current = relative;
  while (current && current !== ".") {
    if (keep(current)) return;
    try {
      // Fence each removal: the root may have been replaced since the caller's checks.
      await checkWriteGuard(guard);
      await fs.rmdir(path.join(root, ...current.split("/")));
    } catch {
      return;
    }
    const parent = path.posix.dirname(current);
    current = parent === "." ? "" : parent;
  }
}

/** Text a shared document can hold for these bytes, or null when they are not faithful UTF-8 text. */
export function decodeText(bytes: Uint8Array): string | null {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
  if (text.includes("\u0000")) return null;
  // Invalid sequences decode to U+FFFD; the round trip then differs.
  if (text.includes("�") && !Buffer.from(text, "utf8").equals(Buffer.from(bytes))) return null;
  return text;
}

export function encodeText(text: string): Buffer {
  return Buffer.from(text, "utf8");
}
