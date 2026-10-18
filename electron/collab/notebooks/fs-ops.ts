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

/**
 * Writes bytes atomically: a temp file in the same directory, then rename,
 * so readers (search, latexmk, the PDF viewer) never see a half-written file.
 * The existing file's mode is kept. If the rename keeps failing because the
 * target is held open, the bytes are copied over it in place instead: a
 * non-atomic write beats losing the change.
 */
export async function writeFileAtomic(absolute: string, bytes: Uint8Array): Promise<Stats> {
  const directory = path.dirname(absolute);
  await fs.mkdir(directory, { recursive: true });
  const previous = await statIfExists(absolute);
  const temporary = path.join(directory, `${TEMP_PREFIX}${randomBytes(6).toString("hex")}`);
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", ...(previous ? { mode: previous.mode & 0o7777 } : {}) });
    if (previous) await fs.chmod(temporary, previous.mode & 0o7777).catch(() => undefined);
    let renamed = false;
    for (let attempt = 0; attempt < 8 && !renamed; attempt += 1) {
      try {
        await fs.rename(temporary, absolute);
        renamed = true;
      } catch (error) {
        if (!isBusy(error)) throw error;
        await sleep(25 * 2 ** attempt);
      }
    }
    if (!renamed) await fs.copyFile(temporary, absolute);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
  return fs.lstat(absolute);
}

/** Moves a file or folder, creating the destination's parent. */
export async function movePath(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    try {
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
}

/**
 * Lists what the notebook folder holds that could be shared. Symlinks are
 * skipped (never followed), as are ignored names and the local archive.
 */
export async function walkNotebook(root: string, limit = 50_000): Promise<{ entries: WalkEntry[]; skipped: string[] }> {
  const entries: WalkEntry[] = [];
  const skipped: string[] = [];
  const visit = async (directory: string, prefix: string) => {
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    names.sort();
    for (const name of names) {
      if (entries.length >= limit) return;
      const relative = prefix ? `${prefix}/${name}` : name;
      if (isIgnoredName(name)) continue;
      if (!prefix && name.toLowerCase() === ARCHIVE_DIRECTORY) continue;
      const absolute = path.join(directory, name);
      const stats = await statIfExists(absolute);
      if (!stats || stats.isSymbolicLink()) continue;
      if (!isShareablePath(relative)) {
        skipped.push(relative);
        continue;
      }
      if (stats.isDirectory()) {
        entries.push({ relative, kind: "folder", size: 0, mtimeMs: stats.mtimeMs });
        await visit(absolute, relative);
      } else if (stats.isFile()) {
        entries.push({ relative, kind: "file", size: stats.size, mtimeMs: stats.mtimeMs });
      }
    }
  };
  await visit(root, "");
  return { entries, skipped };
}

/** Removes empty directories from `relative` upwards, stopping at the root or a non-empty one. */
export async function pruneEmptyDirectories(root: string, relative: string, keep: (relative: string) => boolean): Promise<void> {
  let current = relative;
  while (current && current !== ".") {
    if (keep(current)) return;
    try {
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
