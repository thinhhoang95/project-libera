import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractMarkdownLinkOccurrences } from "@/lib/markdown-link-occurrences";
import { resolveMarkdownFileLink } from "@/lib/markdown-file-links";
import { filePathFromParts, notebookSystemDirectoryPath } from "@/lib/storage/paths";
import type { LiberaFileNode, LiberaNotebookNode, LiberaTreeNode } from "@/lib/types";

// Parse only on the server, when a saved file's fingerprint changes. The links
// panel extracts occurrences the same way, so both agree on what is a link.
export function extractNotebookLinkDestinations(content: string): string[] {
  return [...new Set(extractMarkdownLinkOccurrences(content).map((occurrence) => occurrence.href))];
}

type LinkEntry = { updatedAt: string; size: number; destinations: string[] };
type LinkIndex = { version: 1; files: Record<string, LinkEntry> };

function collectFiles(nodes: LiberaTreeNode[]): LiberaFileNode[] {
  return nodes.flatMap((node) => node.kind === "file" ? [node] : collectFiles(node.children));
}

async function readLinkIndex(indexPath: string): Promise<LinkIndex> {
  try {
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    if (index.version === 1 && index.files && typeof index.files === "object") return index;
  } catch {
    // Missing, old or partially synced indexes can be rebuilt from saved files.
  }
  return { version: 1, files: {} };
}

async function notebookDestinations(notebook: LiberaNotebookNode, files: LiberaFileNode[]) {
  // Linked folders keep this index in the data folder, never in the user's folder.
  const directory = notebookSystemDirectoryPath(notebook.name);
  const indexPath = path.join(directory, "notebook-links.json");
  const previous = await readLinkIndex(indexPath);
  const next: LinkIndex = { version: 1, files: {} };
  for (const file of files) {
    if (file.fileType !== "markdown") continue;
    const cached = previous.files[file.path];
    if (cached?.updatedAt === file.updatedAt && cached.size === file.size &&
        Array.isArray(cached.destinations) && cached.destinations.every((href) => typeof href === "string")) {
      next.files[file.path] = cached;
    } else {
      const content = await readFile(filePathFromParts(notebook.name, file.path.split("/").slice(1)), "utf8");
      next.files[file.path] = {
        updatedAt: file.updatedAt, size: file.size,
        destinations: extractNotebookLinkDestinations(content),
      };
    }
  }
  if (JSON.stringify(previous) !== JSON.stringify(next)) {
    // Atomic replacement keeps readers and sync clients from seeing partial JSON.
    const temporaryPath = `${indexPath}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(next)}\n`, "utf8");
      await rename(temporaryPath, indexPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
  return next.files;
}

export async function populateRelatedNotebooks(notebooks: LiberaNotebookNode[]) {
  const filesByNotebook = notebooks.map((notebook) => collectFiles(notebook.children));
  const allFiles = new Map(filesByNotebook.flat().map((file) => [file.path, file]));
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
