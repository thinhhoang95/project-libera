import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { resolveMarkdownFileLink } from "@/lib/markdown-file-links";
import { LIBERA_SYSTEM_DIR } from "@/lib/storage/constants";
import { filePathFromParts, notebookPath } from "@/lib/storage/paths";
import type { LiberaFileNode, LiberaNotebookNode, LiberaTreeNode } from "@/lib/types";

const parser = unified().use(remarkParse);

// Parse only on the server, when a saved file's fingerprint changes. Using the
// Markdown AST excludes code examples and supports reference-style links.
export function extractNotebookLinkDestinations(content: string): string[] {
  const root = parser.parse(content);
  const definitions = new Map<string, string>();
  const references: string[] = [];
  const destinations = new Set<string>();
  function visit(node: { type: string; url?: string; identifier?: string; children?: typeof root.children }) {
    if (node.type === "definition" && node.identifier && node.url) {
      definitions.set(node.identifier.toUpperCase(), node.url);
    } else if (node.type === "link" && node.url) {
      destinations.add(node.url);
    } else if (node.type === "linkReference" && node.identifier) {
      references.push(node.identifier.toUpperCase());
    }
    node.children?.forEach(visit);
  }
  visit(root);
  for (const reference of references) {
    const destination = definitions.get(reference);
    if (destination) destinations.add(destination);
  }
  return [...destinations];
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
  const directory = path.join(notebookPath(notebook.name), LIBERA_SYSTEM_DIR);
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
      for (const href of entry.destinations) {
        const target = resolveMarkdownFileLink(href, sourcePath, allFiles)?.file;
        if (target && target.notebook !== notebook.name) related.add(target.notebook);
      }
    }
    notebook.relatedNotebookNames = [...related].sort();
  }
}
