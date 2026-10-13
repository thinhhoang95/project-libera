import { readFile } from "node:fs/promises";
import { filePathFromParts, splitFilePath } from "@/lib/storage/paths";
import { getTree } from "@/lib/storage/tree";
import type { LiberaTreeNode } from "@/lib/types";
import { hasDocumentClass, resolveRelativeNotebookPath, stripLatexComments } from "./project";

/* A chapter file has no \documentclass of its own; it is typeset as part of
 * the main file that \input's or \include's it, directly or through other
 * chapters. TeX resolves those paths against the main file's folder. */

const MAX_FILES = 400;
const MAX_FILE_CHARACTERS = 1_000_000;

/** Files a LaTeX source includes, as written (without resolving). */
export function readLatexIncludes(source: string) {
  const references: { path: string; relativeToFile: boolean }[] = [];
  const text = stripLatexComments(source);
  for (const match of text.matchAll(/\\(?:input|include|subfile)\s*\{([^}]+)\}/g)) references.push({ path: match[1].trim(), relativeToFile: false });
  // \import{dir}{file} and \subimport{dir}{file} (import package).
  for (const match of text.matchAll(/\\(sub)?import\*?\s*\{([^}]*)\}\s*\{([^}]+)\}/g)) {
    references.push({ path: `${match[2].trim().replace(/\/?$/, "/")}${match[3].trim()}`, relativeToFile: Boolean(match[1]) });
  }
  return references.map((reference) => ({ ...reference, path: /\.[a-z]+$/i.test(reference.path) ? reference.path : `${reference.path}.tex` }));
}

function collectTexFiles(nodes: LiberaTreeNode[], files: string[]) {
  for (const node of nodes) {
    if (files.length >= MAX_FILES) return;
    if (node.kind === "folder") {
      if (!node.name.startsWith("_")) collectTexFiles(node.children, files);
    } else if (node.fileType === "latex" && /\.tex$/i.test(node.name)) {
      files.push(node.path);
    }
  }
}

async function readSource(notebookPath: string) {
  try {
    const { notebook, pathParts } = splitFilePath(notebookPath);
    const content = await readFile(filePathFromParts(notebook, pathParts), "utf8");
    return content.slice(0, MAX_FILE_CHARACTERS);
  } catch {
    return null;
  }
}

const directoryOf = (notebookPath: string) => notebookPath.split("/").slice(0, -1).join("/");

/** The main file that typesets `filePath`, or null when none includes it. */
export async function findLatexRoot(filePath: string): Promise<string | null> {
  const notebookName = filePath.split("/")[0];
  const tree = await getTree();
  const notebook = tree.notebooks.find((candidate) => candidate.name === notebookName);
  if (!notebook) return null;

  const paths: string[] = [];
  collectTexFiles(notebook.children, paths);
  const sources = new Map<string, string>();
  await Promise.all(paths.map(async (path) => {
    const source = await readSource(path);
    if (source !== null) sources.set(path, source);
  }));

  const own = sources.get(filePath);
  if (own !== undefined && hasDocumentClass(own)) return filePath;

  const fileDirectory = directoryOf(filePath);
  // Prefer main files nearest to the chapter: same folder, then its parents.
  const roots = [...sources.entries()]
    .filter(([path, source]) => path !== filePath && hasDocumentClass(source))
    .map(([path]) => path)
    .sort((left, right) => {
      const score = (path: string) => (fileDirectory.startsWith(directoryOf(path)) ? fileDirectory.length - directoryOf(path).length : 1000);
      return score(left) - score(right) || left.localeCompare(right);
    });

  for (const root of roots) {
    const rootDirectory = `${directoryOf(root)}/`;
    const visited = new Set([root]);
    const queue = [root];
    while (queue.length) {
      const current = queue.shift()!;
      for (const reference of readLatexIncludes(sources.get(current) ?? "")) {
        const base = reference.relativeToFile ? `${directoryOf(current)}/x` : `${rootDirectory}x`;
        const resolved = resolveRelativeNotebookPath(base, reference.path);
        if (!resolved) continue;
        if (resolved === filePath) return root;
        if (sources.has(resolved) && !visited.has(resolved)) {
          visited.add(resolved);
          queue.push(resolved);
        }
      }
    }
  }
  return null;
}
