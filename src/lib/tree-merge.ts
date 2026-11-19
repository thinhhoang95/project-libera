import { resolveMarkdownFileLink } from "@/lib/markdown-file-links";
import type { LiberaFileNode, LiberaTree, LiberaTreeNode } from "@/lib/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tree nodes keep their place by path, so one added file does not make every later sibling look changed. */
function nodeKey(value: unknown): string | null {
  return isRecord(value) && typeof value.path === "string" && typeof value.kind === "string" ? `${value.kind}:${value.path}` : null;
}

/**
 * `next` with every part that equals `previous` replaced by the previous
 * object itself. Returns `previous` when nothing differs. Plain JSON values only.
 */
function share(previous: unknown, next: unknown): unknown {
  if (previous === next) return previous;
  if (Array.isArray(previous) && Array.isArray(next)) {
    const byKey = new Map<string, unknown>();
    for (const item of previous) { const key = nodeKey(item); if (key) byKey.set(key, item); }
    const merged = next.map((item, index) => {
      const key = nodeKey(item);
      return share(key ? byKey.get(key) : previous[index], item);
    });
    return merged.length === previous.length && merged.every((item, index) => item === previous[index]) ? previous : merged;
  }
  if (isRecord(previous) && isRecord(next)) {
    const keys = Object.keys(next);
    const merged: Record<string, unknown> = {};
    for (const key of keys) merged[key] = key in previous ? share(previous[key], next[key]) : next[key];
    const same = keys.length === Object.keys(previous).length && keys.every((key) => key in previous && merged[key] === previous[key]);
    return same ? previous : merged;
  }
  return next;
}

/**
 * The tree to show after reading `next`: `previous` itself when the content is
 * the same, otherwise `next` with every unchanged notebook, folder and file
 * keeping its old object, so memoized sidebar rows skip them.
 */
export function mergeTree(previous: LiberaTree | null | undefined, next: LiberaTree): LiberaTree {
  return previous ? share(previous, next) as LiberaTree : next;
}

function newerDate(left: string, right: string) {
  return new Date(right).getTime() > new Date(left).getTime() ? right : left;
}

function patchNodes(nodes: LiberaTreeNode[], file: LiberaFileNode): LiberaTreeNode[] | null {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    let replacement: LiberaTreeNode | null = null;
    if (node.kind === "file") {
      if (node.path === file.path) replacement = share(node, file) as LiberaFileNode;
    } else if (file.path.startsWith(`${node.path}/`)) {
      const children = patchNodes(node.children, file);
      if (!children) return null;
      const updatedAt = newerDate(node.updatedAt, file.updatedAt);
      replacement = children === node.children && updatedAt === node.updatedAt ? node : { ...node, updatedAt, children };
    }
    if (replacement) return replacement === node ? nodes : nodes.map((entry, at) => (at === index ? replacement! : entry));
  }
  return null;
}

/**
 * The tree with these files' nodes replaced. The ancestors of a changed file
 * are new objects, everything else is kept, and a file that did not change
 * returns `tree` itself. Null when a file is not in the tree (it was added or
 * removed), which needs the full read.
 */
export function patchFileNodes(tree: LiberaTree, files: readonly LiberaFileNode[]): LiberaTree | null {
  let current = tree;
  for (const file of files) {
    const notebookName = file.path.split("/")[0];
    const index = current.notebooks.findIndex((notebook) => notebook.name === notebookName);
    if (index < 0) return null;
    const notebook = current.notebooks[index];
    const children = patchNodes(notebook.children, file);
    if (!children) return null;
    if (children === notebook.children) continue;
    const patched = { ...notebook, updatedAt: newerDate(notebook.updatedAt, file.updatedAt), children };
    current = { ...current, notebooks: current.notebooks.map((entry, at) => (at === index ? patched : entry)) };
  }
  return current;
}

/** One file's metadata as the server's by-path read returns it. */
export type FileMetadataResult = {
  path: string;
  metadata: { node: LiberaFileNode; linkDestinations?: string[] } | null;
};

function collectFiles(nodes: readonly LiberaTreeNode[], into: Map<string, LiberaFileNode>) {
  for (const node of nodes) {
    if (node.kind === "file") into.set(node.path, node);
    else collectFiles(node.children, into);
  }
}

/**
 * The shown tree with these files' fresh metadata, or null when the light read
 * cannot settle it and the whole tree must be read: a file the server could
 * not find or the tree does not show, or a note whose links now point
 * elsewhere (links, and the notebooks they relate, are worked out on the full read).
 */
export function applyFileMetadata(tree: LiberaTree, results: readonly FileMetadataResult[]): LiberaTree | null {
  const files = new Map<string, LiberaFileNode>();
  for (const notebook of tree.notebooks) collectFiles(notebook.children, files);
  const nodes: LiberaFileNode[] = [];
  for (const { path, metadata } of results) {
    const shown = files.get(path);
    if (!metadata || !shown) return null;
    const { linkDestinations } = metadata;
    const { linkedFilePaths: _fresh, ...bare } = metadata.node;
    void _fresh;
    let node: LiberaFileNode = bare;
    if (linkDestinations) {
      const linked = new Set<string>();
      for (const href of linkDestinations) {
        const target = resolveMarkdownFileLink(href, path, files)?.file;
        if (target && target.path !== path) linked.add(target.path);
      }
      const resolved = [...linked].sort();
      const before = shown.linkedFilePaths ?? [];
      if (resolved.length !== before.length || resolved.some((entry, index) => entry !== before[index])) return null;
      if (resolved.length) node = { ...bare, linkedFilePaths: shown.linkedFilePaths };
    }
    nodes.push(node);
  }
  return patchFileNodes(tree, nodes);
}
