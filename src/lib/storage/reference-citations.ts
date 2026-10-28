import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { citedKeys } from "@/lib/references/citation-syntax";
import { ARCHIVE_DIR } from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { getFileType } from "@/lib/storage/file-types";
import { writeJsonAtomically } from "@/lib/storage/fs-utils";
import { assertDirectorySignature, readDirectorySignature, readTextSnapshot } from "@/lib/storage/file-signature";
import { assertSafeSegment, getLinkedFolder, notebookPath, notebookSystemDirectoryPath } from "@/lib/storage/paths";
import { isVisibleTreeEntry } from "@/lib/storage/tree";
import { readWorkspaceMetadata } from "@/lib/storage/workspace-metadata";

// The citation index (the "Citation index" contract in
// docs/references/lanes.md): the keys each saved Markdown file in a notebook
// cites, kept at `<notebook system dir>/references/citations.json` and keyed
// by content identity. A rebuild checks saved bytes, parses only new or changed
// files, drops deleted ones, and writes the index only when it changed.
// Keys are stored as written (aliases and unknown keys included); the client
// resolves them against the library and merges in its open drafts.
//
// Entries hold only what follows from a file's bytes, never its timestamps or
// size: a touched, re-downloaded or checked-out file does not rewrite the
// index, and computers sharing a synced notebook write the same index.
// Metadata cannot replace the byte check (see readTextSnapshot).

// Version 3 verifies content identity; version 2 added narrative `@key` candidates.
export const CITATION_INDEX_VERSION = 3;

type CitationIndexFile = { contentHash: string; keys: string[] };
type CitationIndex = { version: typeof CITATION_INDEX_VERSION; files: Record<string, CitationIndexFile> };

export type NotebookCitations = {
  /** Library-relative path → keys in document order. Files without citations are left out. */
  byFile: Record<string, string[]>;
  /** Every written key → the files citing it, sorted. */
  byKey: Record<string, string[]>;
};

/** `read` counts files parsed for citations, excluding byte checks of cached entries. */
export type CitationIndexStats = { files: number; read: number; written: boolean };

/** The tree's cap for linked folders, which may be large projects rather than notebooks. */
const LINKED_FOLDER_ENTRY_LIMIT = 20_000;
/** Files read at once. */
const CONCURRENCY = 32;

export function citationIndexPath(notebook: string) {
  return path.join(notebookSystemDirectoryPath(notebook), "references", "citations.json");
}

function isIndexFile(value: unknown): value is CitationIndexFile {
  const file = value as CitationIndexFile;
  return Boolean(file) && typeof file === "object" &&
    typeof file.contentHash === "string" && Array.isArray(file.keys) && file.keys.every((key) => typeof key === "string");
}

async function readCitationIndex(indexPath: string): Promise<CitationIndex> {
  try {
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    if (index?.version === CITATION_INDEX_VERSION && index.files && typeof index.files === "object") {
      const files: Record<string, CitationIndexFile> = {};
      // Older entries also held mtimeMs and size: ignored, and dropped when the index next changes.
      for (const [file, entry] of Object.entries(index.files)) if (isIndexFile(entry)) files[file] = { contentHash: entry.contentHash, keys: entry.keys };
      return { version: CITATION_INDEX_VERSION, files };
    }
  } catch {
    // Missing, old or partially synced indexes are rebuilt from the saved files.
  }
  return { version: CITATION_INDEX_VERSION, files: {} };
}

function isArchived(relativePath: string) {
  return relativePath.split("/").slice(1, -1).includes(ARCHIVE_DIR);
}

/** Library-relative paths of the notebook's Markdown files, with the tree's visibility rules. */
async function markdownFiles(notebook: string, includeArchive: boolean) {
  const root = notebookPath(notebook);
  const linked = Boolean(getLinkedFolder(notebook));
  const budget = { remaining: LINKED_FOLDER_ENTRY_LIMIT };
  const files: { relativePath: string; absolutePath: string }[] = [];
  const walk = async (directory: string, parts: string[]) => {
    let entries: Dirent[];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!parts.length && code === "ENOENT") throw new StorageError("Notebook was not found.", 404);
      // A folder deleted or locked during the walk is skipped, as the tree does.
      if (parts.length && ["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(code)) return;
      throw error;
    }
    for (const entry of entries) {
      if (!isVisibleTreeEntry(entry.name, linked) || (entry.name === ARCHIVE_DIR && !includeArchive)) continue;
      if (linked && --budget.remaining < 0) return;
      const entryParts = [...parts, entry.name];
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), entryParts);
      else if (entry.isFile() && getFileType(entry.name) === "markdown") {
        files.push({ relativePath: [notebook, ...entryParts].join("/"), absolutePath: path.join(directory, entry.name) });
      }
    }
  };
  await walk(root, []);
  return files;
}

async function forEachLimited<T>(items: T[], fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

async function rebuild(notebook: string, includeArchive: boolean) {
  const indexPath = citationIndexPath(notebook);
  const root = notebookPath(notebook);
  const identity = await readDirectorySignature(root);
  const previous = await readCitationIndex(indexPath);
  const files = await markdownFiles(notebook, includeArchive);
  const next: CitationIndex = { version: CITATION_INDEX_VERSION, files: {} };
  // Without the archive in the walk, its files are neither checked nor dropped.
  if (!includeArchive) {
    for (const [file, entry] of Object.entries(previous.files)) if (isArchived(file)) next.files[file] = entry;
  }
  let read = 0;
  await forEachLimited(files, async ({ relativePath, absolutePath }) => {
    let snapshot;
    try { snapshot = await readTextSnapshot(absolutePath); } catch { return; }
    const cached = previous.files[relativePath];
    if (cached && cached.contentHash === snapshot.contentHash) {
      next.files[relativePath] = cached;
      return;
    }
    read += 1;
    next.files[relativePath] = { contentHash: snapshot.contentHash, keys: citedKeys(snapshot.content, { allNarrative: true }) };
  });
  // Stable order keeps the comparison and the file independent of read timing.
  next.files = Object.fromEntries(Object.entries(next.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const sortedPrevious = Object.fromEntries(Object.entries(previous.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const changed = JSON.stringify(sortedPrevious) !== JSON.stringify(next.files);
  if (changed) await writeJsonAtomically(indexPath, next, () => assertDirectorySignature(root, identity));
  const visible = Object.entries(next.files).filter(([file]) => includeArchive || !isArchived(file));
  return { visible, stats: { files: files.length, read, written: changed } satisfies CitationIndexStats };
}

const IN_FLIGHT = Symbol.for("libera.referenceCitationRebuilds");
type Flight = { includeArchive: boolean; task: ReturnType<typeof rebuild> };
const inFlightState = globalThis as { [IN_FLIGHT]?: Map<string, Flight> };
const inFlight = inFlightState[IN_FLIGHT] ??= new Map();

/**
 * Bring the notebook's citation index up to date and return it. One rebuild
 * runs per notebook at a time: callers that arrive while one is running
 * share it, or queue behind it when they ask for a different archive
 * setting. The archive is included when asked, or when the library shows it.
 */
export async function refreshNotebookCitations(
  notebook: string,
  options: { includeArchive?: boolean } = {},
): Promise<NotebookCitations & { stats: CitationIndexStats }> {
  const safeNotebook = assertSafeSegment(notebook, "Notebook name");
  const includeArchive = options.includeArchive ?? (await readWorkspaceMetadata()).notebookViewOptions.showArchive;
  const running = inFlight.get(safeNotebook);
  let task = running?.includeArchive === includeArchive ? running.task : undefined;
  if (!task) {
    const flight: Flight = {
      includeArchive,
      task: running ? running.task.catch(() => undefined).then(() => rebuild(safeNotebook, includeArchive)) : rebuild(safeNotebook, includeArchive),
    };
    inFlight.set(safeNotebook, flight);
    void flight.task.finally(() => { if (inFlight.get(safeNotebook) === flight) inFlight.delete(safeNotebook); }).catch(() => undefined);
    task = flight.task;
  }
  const { visible, stats } = await task;
  const byFile: Record<string, string[]> = {};
  const byKey: Record<string, string[]> = {};
  for (const [file, entry] of visible) {
    if (!entry.keys.length) continue;
    byFile[file] = [...entry.keys];
    for (const key of entry.keys) (byKey[key] ??= []).push(file);
  }
  return { byFile, byKey, stats };
}
