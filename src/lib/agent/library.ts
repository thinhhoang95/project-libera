import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ARCHIVE_DIR, MARKDOWN_ASSETS_DIR } from "@/lib/storage/constants";
import { getFileType } from "@/lib/storage/file-types";
import { StorageError } from "@/lib/storage/errors";
import { getAdminRoot, getLinkedFolders, itemPath, notebookPath, splitStoragePath } from "@/lib/storage/paths";
import type { LiberaFileType } from "@/lib/types";

// The agent addresses files the way the rest of Libera does: by library path,
// "Notebook/folder/note.md", where a linked folder counts as a notebook. Every
// path a model supplies goes through resolveLibraryPath before it is touched.

export type LibraryEntry = {
  path: string;
  absolutePath: string;
  fileType: LiberaFileType;
  size: number;
  mtimeMs: number;
};

export type ResolvedPath = {
  /** Library path, "Notebook/…"; just the notebook name for a notebook root. */
  path: string;
  notebook: string;
  pathParts: string[];
  absolutePath: string;
};

// Dependency and build folders hold no notes and can be enormous.
const SKIPPED_ENTRIES = new Set(["node_modules", "__pycache__", "bower_components", "__MACOSX", MARKDOWN_ASSETS_DIR]);
const MAX_WALK_ENTRIES = 50_000;

export async function listNotebookNames(): Promise<string[]> {
  const linked = getLinkedFolders().map((folder) => folder.name);
  const linkedNames = new Set(linked);
  let entries: { name: string; isDirectory(): boolean }[] = [];
  try { entries = await readdir(getAdminRoot(), { withFileTypes: true }); }
  catch { entries = []; }
  const notebooks = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !linkedNames.has(entry.name))
    .map((entry) => entry.name);
  return [...notebooks, ...linked].sort((left, right) => left.localeCompare(right));
}

function isInside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sameFileSystemPath(left: string, right: string) {
  // macOS and Windows volumes are usually case-insensitive.
  return process.platform === "linux" ? left === right : left.toLowerCase() === right.toLowerCase();
}

/** Convert an absolute path inside a notebook or linked folder to a library path. */
async function libraryPathFromAbsolute(input: string, notebooks: string[]) {
  const normalized = path.resolve(input);
  for (const notebook of notebooks) {
    const root = notebookPath(notebook);
    const relative = path.relative(root, normalized);
    if (relative === "" ) return notebook;
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) return [notebook, ...relative.split(path.sep)].join("/");
  }
  return null;
}

/**
 * Resolve a model-supplied path to a library path inside a notebook. Accepts
 * "Notebook/a.md", an absolute path inside a notebook, or a path relative to
 * `defaultNotebook` ("folder/a.md"). Hidden entries, `_assets` and anything
 * outside the library are rejected, including through symlinks.
 */
export async function resolveLibraryPath(input: string, { defaultNotebook, notebooks }: { defaultNotebook?: string; notebooks?: string[] } = {}): Promise<ResolvedPath> {
  const raw = input.trim();
  if (!raw || raw.includes("\0")) throw new StorageError("Path is empty.");
  const names = notebooks ?? await listNotebookNames();
  let candidate: string | null = raw.replace(/\\/g, "/");

  if (path.isAbsolute(raw) && !names.includes(candidate.replace(/^\/+/, "").split("/")[0])) {
    candidate = await libraryPathFromAbsolute(raw, names);
    if (candidate === null) throw new StorageError("Path is outside the library. Use library paths such as \"Notebook/note.md\".");
  }

  candidate = candidate.replace(/^\.\/+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  const segments = candidate.split("/").filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === "..")) throw new StorageError("Path may not contain \"..\". Use library paths such as \"Notebook/note.md\".");
  if (!segments.length) throw new StorageError("Path is empty.");
  if (!names.includes(segments[0])) {
    if (!defaultNotebook) throw new StorageError(`"${segments[0]}" is not a notebook. Paths start with a notebook name: ${names.slice(0, 20).map((name) => `"${name}"`).join(", ")}.`);
    segments.unshift(defaultNotebook);
  }

  const { notebook, pathParts } = splitStoragePath(segments.join("/"));
  const absolutePath = pathParts.length ? itemPath(notebook, pathParts) : notebookPath(notebook);
  await assertRealPathInside(notebookPath(notebook), absolutePath);
  return { path: [notebook, ...pathParts].join("/"), notebook, pathParts, absolutePath };
}

/** Follow symlinks for the deepest existing ancestor and require it to stay inside `root`. */
async function assertRealPathInside(root: string, target: string) {
  let realRoot: string;
  try { realRoot = await realpath(root); }
  catch { throw new StorageError("Notebook was not found.", 404); }
  let existing = target;
  while (true) {
    try {
      const real = await realpath(existing);
      if (!isInside(realRoot, real) && !sameFileSystemPath(realRoot, real)) {
        throw new StorageError("Path is outside the notebook folder. Use paths inside the notebook.");
      }
      return;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      const parent = path.dirname(existing);
      if (parent === existing || !isInside(root, parent)) return;
      existing = parent;
    }
  }
}

export function isSkippedEntry(name: string) {
  return name.startsWith(".") || SKIPPED_ENTRIES.has(name);
}

/**
 * Walk supported files under a library folder ("" for every notebook). The
 * archive folder is skipped unless the walk starts inside it.
 */
export async function* walkLibraryFiles(root: ResolvedPath | null, signal?: AbortSignal): AsyncGenerator<LibraryEntry> {
  const starts = root ? [root] : await Promise.all((await listNotebookNames()).map((notebook) => resolveLibraryPath(notebook)));
  let visited = 0;
  for (const start of starts) {
    const insideArchive = start.pathParts[0] === ARCHIVE_DIR;
    const queue: { absolute: string; relative: string; depth: number }[] = [{ absolute: start.absolutePath, relative: start.path, depth: start.pathParts.length }];
    while (queue.length) {
      signal?.throwIfAborted();
      const directory = queue.shift()!;
      let entries;
      try { entries = await readdir(directory.absolute, { withFileTypes: true }); }
      catch { continue; }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (++visited > MAX_WALK_ENTRIES) return;
        if (isSkippedEntry(entry.name) || (entry.name === ARCHIVE_DIR && directory.depth === 0 && !insideArchive)) continue;
        const absolute = path.join(directory.absolute, entry.name);
        const relative = `${directory.relative}/${entry.name}`;
        if (entry.isDirectory()) {
          queue.push({ absolute, relative, depth: directory.depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        const fileType = getFileType(entry.name);
        if (!fileType) continue;
        try {
          const stats = await stat(absolute);
          yield { path: relative, absolutePath: absolute, fileType, size: stats.size, mtimeMs: stats.mtimeMs };
        } catch { /* Removed while walking. */ }
      }
    }
  }
}

export async function statLibraryPath(resolved: ResolvedPath) {
  try { return await stat(resolved.absolutePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Suggest a similarly named file for a path that does not exist. */
export async function suggestSimilarPath(resolved: ResolvedPath, signal?: AbortSignal) {
  const wanted = resolved.pathParts.at(-1)?.toLowerCase() ?? "";
  if (!wanted) return null;
  let parent: ResolvedPath | null = null;
  try { parent = await resolveLibraryPath(resolved.notebook); } catch { return null; }
  let best: { path: string; score: number } | null = null;
  let checked = 0;
  for await (const entry of walkLibraryFiles(parent, signal)) {
    if (++checked > 5_000) break;
    const name = entry.path.split("/").at(-1)!.toLowerCase();
    const score = similarity(wanted, name);
    if (score > 0.6 && (!best || score > best.score)) best = { path: entry.path, score };
  }
  return best?.path ?? null;
}

function similarity(left: string, right: string) {
  if (left === right) return 1;
  const distance = editDistance(left, right);
  return 1 - distance / Math.max(left.length, right.length, 1);
}

function editDistance(left: string, right: string) {
  if (Math.abs(left.length - right.length) > 8) return Math.max(left.length, right.length);
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length];
}
