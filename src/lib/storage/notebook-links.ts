import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractMarkdownLinkOccurrences } from "@/lib/markdown-link-occurrences";
import { resolveMarkdownFileLink } from "@/lib/markdown-file-links";
import { filePathFromParts, notebookPath, notebookSystemDirectoryPath } from "@/lib/storage/paths";
import { assertDirectorySignature, readDirectorySignature, readTextSnapshot } from "@/lib/storage/file-signature";
import { writeJsonAtomically } from "@/lib/storage/fs-utils";
import type { LiberaFileNode, LiberaNotebookNode, LiberaTreeNode } from "@/lib/types";

// Parse only on the server, when a saved file's fingerprint changes. The links
// panel extracts occurrences the same way, so both agree on what is a link.
export function extractNotebookLinkDestinations(content: string): string[] {
  return [...new Set(extractMarkdownLinkOccurrences(content).map((occurrence) => occurrence.href))];
}

type LinkEntry = { updatedAt: string; size: number; contentHash: string; destinations: string[] };
type LinkIndex = { version: 2; files: Record<string, LinkEntry> };

function collectFiles(nodes: LiberaTreeNode[]): LiberaFileNode[] {
  return nodes.flatMap((node) => node.kind === "file" ? [node] : collectFiles(node.children));
}

async function readLinkIndex(indexPath: string): Promise<LinkIndex> {
  try {
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    if (index.version === 2 && index.files && typeof index.files === "object") return index;
  } catch {
    // Missing, old or partially synced indexes can be rebuilt from saved files.
  }
  return { version: 2, files: {} };
}

const rebuilds = new Map<string, Promise<LinkIndex["files"]>>();
async function notebookDestinations(notebook: LiberaNotebookNode, files: LiberaFileNode[]) {
  if (notebook.folder?.missing) return {};
  // Linked folders keep this index in the data folder, never in the user's folder.
  const directory = notebookSystemDirectoryPath(notebook.name);
  const indexPath = path.join(directory, "notebook-links.json");
  const root = notebookPath(notebook.name);
  const task = (rebuilds.get(indexPath) ?? Promise.resolve()).catch(() => undefined)
    .then(() => rebuildDestinations(notebook, files, indexPath, root));
  rebuilds.set(indexPath, task);
  void task.finally(() => { if (rebuilds.get(indexPath) === task) rebuilds.delete(indexPath); }).catch(() => undefined);
  return task;
}

async function rebuildDestinations(notebook: LiberaNotebookNode, files: LiberaFileNode[], indexPath: string, root: string) {
  let identity;
  try { identity = await readDirectorySignature(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  const previous = await readLinkIndex(indexPath);
  const next: LinkIndex = { version: 2, files: {} };
  for (const file of files) {
    if (file.fileType !== "markdown") continue;
    let snapshot;
    try { snapshot = await readTextSnapshot(filePathFromParts(notebook.name, file.path.split("/").slice(1))); }
    catch (error) {
      // A file may disappear, become unreadable, or change during a tree scan.
      if (["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "") || (error as { status?: number }).status === 409) continue;
      throw error;
    }
    const cached = previous.files[file.path];
    if (cached?.contentHash === snapshot.contentHash &&
        Array.isArray(cached.destinations) && cached.destinations.every((href) => typeof href === "string")) {
      next.files[file.path] = { ...cached, updatedAt: file.updatedAt, size: file.size };
    } else {
      next.files[file.path] = {
        updatedAt: file.updatedAt, size: file.size, contentHash: snapshot.contentHash,
        destinations: extractNotebookLinkDestinations(snapshot.content),
      };
    }
  }
  if (JSON.stringify(previous) !== JSON.stringify(next)) {
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
