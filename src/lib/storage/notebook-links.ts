import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractMarkdownLinkOccurrences } from "@/lib/markdown-link-occurrences";
import { resolveMarkdownFileLink } from "@/lib/markdown-file-links";
import { filePathFromParts, notebookPath, notebookSystemDirectoryPath } from "@/lib/storage/paths";
import { assertDirectorySignature, readDirectorySignature, readFileSignature, readTextSnapshot } from "@/lib/storage/file-signature";
import { writeJsonAtomically } from "@/lib/storage/fs-utils";
import type { LiberaFileNode, LiberaNotebookNode, LiberaTreeNode } from "@/lib/types";

// Parse only on the server, when a saved file's fingerprint changes. The links
// panel extracts occurrences the same way, so both agree on what is a link.
export function extractNotebookLinkDestinations(content: string): string[] {
  return [...new Set(extractMarkdownLinkOccurrences(content).map((occurrence) => occurrence.href))];
}

// Entries hold only what follows from a file's bytes, never its timestamps or
// size, and paths are sorted: a touched, re-downloaded or reordered file does
// not rewrite the index, and computers sharing a synced notebook write the same one.
type LinkEntry = { contentHash: string; destinations: string[] };
export type LinkIndex = { version: 2; files: Record<string, LinkEntry> };

function collectFiles(nodes: LiberaTreeNode[]): LiberaFileNode[] {
  return nodes.flatMap((node) => node.kind === "file" ? [node] : collectFiles(node.children));
}

/** Where a notebook's link index is kept: the data folder, never a linked folder itself. */
export function linkIndexPath(notebook: string) {
  return path.join(notebookSystemDirectoryPath(notebook), "notebook-links.json");
}

/** The index as saved (empty when missing or unreadable); reads only. The notebook check compares it with the notes. */
export async function readLinkIndex(indexPath: string): Promise<LinkIndex> {
  try {
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    if (index.version === 2 && index.files && typeof index.files === "object") {
      // Older entries also held updatedAt and size: ignored, and dropped when the index next changes.
      const files: LinkIndex["files"] = {};
      for (const [file, entry] of Object.entries(index.files as Record<string, Partial<LinkEntry>>)) {
        if (typeof entry?.contentHash === "string" && Array.isArray(entry.destinations) && entry.destinations.every((href) => typeof href === "string")) {
          files[file] = { contentHash: entry.contentHash, destinations: entry.destinations };
        }
      }
      return { version: 2, files };
    }
  } catch {
    // Missing, old or partially synced indexes can be rebuilt from saved files.
  }
  return { version: 2, files: {} };
}

const rebuilds = new Map<string, Promise<LinkIndex["files"]>>();
async function notebookDestinations(notebook: LiberaNotebookNode, files: LiberaFileNode[]) {
  if (notebook.folder?.missing) return {};
  // Linked folders keep this index in the data folder, never in the user's folder.
  const indexPath = linkIndexPath(notebook.name);
  const root = notebookPath(notebook.name);
  const task = (rebuilds.get(indexPath) ?? Promise.resolve()).catch(() => undefined)
    .then(() => rebuildDestinations(notebook, files, indexPath, root));
  rebuilds.set(indexPath, task);
  void task.finally(() => { if (rebuilds.get(indexPath) === task) rebuilds.delete(indexPath); }).catch(() => undefined);
  return task;
}

/**
 * Files read for the index in this process, per index: an unchanged signature
 * (size, mtime, ctime, inode) skips reading and hashing the file again, so a
 * tree refresh costs one stat per note instead of reading every note. Some
 * writes keep all of those (see readFileContentHash), so an entry is trusted
 * only for a while before the file is read again: LINK_RECHECK_MS plus up to as
 * much again, fixed per path, so notes do not all come due in the same refresh.
 * Three to six minutes keeps that cost small (a thousand notes is about four
 * reads a second, spread out, against a thousand per refresh before) and bounds
 * stale links; a saved index that disagrees is never overruled meanwhile.
 * Kept in memory only: the saved index holds nothing but what follows from the bytes.
 */
type ReadEntry = LinkEntry & { signature: string; checkedAt: number };
const LINK_RECHECK_MS = 3 * 60_000;
const readCache = new Map<string, Map<string, ReadEntry>>();
let clock = () => Date.now();

function recheckAfter(filePath: string) {
  let hash = 2166136261;
  for (let i = 0; i < filePath.length; i += 1) hash = Math.imul(hash ^ filePath.charCodeAt(i), 16777619) >>> 0;
  return LINK_RECHECK_MS * (1 + hash / 2 ** 32);
}

/** Tests: forget what was read, and use the real clock again. */
export function resetNotebookLinkReadCache() {
  readCache.clear();
  clock = () => Date.now();
}

/** Tests: the time the recheck window is measured against. */
export function setNotebookLinkClock(now: () => number) {
  clock = now;
}

/** For a caller that knows a note was rewritten (even keeping its size and times): read it again on the next refresh. Without a path, the whole notebook. */
export function forgetNotebookLinkReads(notebook: string, filePath?: string) {
  const indexPath = linkIndexPath(notebook);
  if (filePath === undefined) readCache.delete(indexPath);
  else readCache.get(indexPath)?.delete(filePath);
}

async function rebuildDestinations(notebook: LiberaNotebookNode, files: LiberaFileNode[], indexPath: string, root: string) {
  let identity;
  try { identity = await readDirectorySignature(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  const previous = await readLinkIndex(indexPath);
  const next: LinkIndex = { version: 2, files: {} };
  const known = readCache.get(indexPath);
  const seen = new Map<string, ReadEntry>();
  const now = clock();
  for (const file of files) {
    if (file.fileType !== "markdown") continue;
    const absolute = filePathFromParts(notebook.name, file.path.split("/").slice(1));
    let entry: ReadEntry;
    try {
      const signature = await readFileSignature(absolute);
      const read = known?.get(file.path);
      // The saved index wins: another process or computer that read newer bytes may have written it.
      const saved = previous.files[file.path];
      if (read && read.signature === signature && now >= read.checkedAt && now - read.checkedAt < recheckAfter(file.path) && (!saved || saved.contentHash === read.contentHash)) {
        entry = read;
      } else {
        const snapshot = await readTextSnapshot(absolute);
        const cached = previous.files[file.path];
        const destinations = cached?.contentHash === snapshot.contentHash ? cached.destinations : extractNotebookLinkDestinations(snapshot.content);
        // The signature from before the read: a change during it differs next time and is read again.
        entry = { contentHash: snapshot.contentHash, destinations, signature, checkedAt: now };
      }
    } catch (error) {
      // A file may disappear, become unreadable, or change during a tree scan.
      if (["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "") || (error as { status?: number }).status === 409) continue;
      throw error;
    }
    seen.set(file.path, entry);
    const cached = previous.files[file.path];
    next.files[file.path] = cached?.contentHash === entry.contentHash ? cached
      : { contentHash: entry.contentHash, destinations: entry.destinations };
  }
  readCache.set(indexPath, seen);
  const sorted = (files: LinkIndex["files"]) => Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  next.files = sorted(next.files);
  if (JSON.stringify(sorted(previous.files)) !== JSON.stringify(next.files)) {
    // Do not recreate a notebook deleted while this derived index was built.
    try { await writeJsonAtomically(indexPath, next, () => assertDirectorySignature(root, identity)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  }
  return next.files;
}

export async function populateRelatedNotebooks(notebooks: LiberaNotebookNode[]) {
  const filesByNotebook = notebooks.map((notebook) => collectFiles(notebook.children));
  const allFiles = new Map(filesByNotebook.flat().map((file) => [file.path, file]));
  for (const file of allFiles.values()) delete file.linkedFilePaths;
  for (const [index, notebook] of notebooks.entries()) {
    const entries = await notebookDestinations(notebook, filesByNotebook[index]);
    const related = new Set<string>();
    for (const [sourcePath, entry] of Object.entries(entries)) {
      const linked = new Set<string>();
      for (const href of entry.destinations) {
        const target = resolveMarkdownFileLink(href, sourcePath, allFiles)?.file;
        if (!target || target.path === sourcePath) continue;
        linked.add(target.path);
        if (target.notebook !== notebook.name) related.add(target.notebook);
      }
      // The panel inverts these to highlight files that link to the open one.
      const source = allFiles.get(sourcePath);
      if (source && linked.size) source.linkedFilePaths = [...linked].sort();
    }
    notebook.relatedNotebookNames = [...related].sort();
  }
}
