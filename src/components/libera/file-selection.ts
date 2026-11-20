import type { LiberaFileNode, LiberaTree, LiberaTreeNode } from "@/lib/types";

/**
 * The files picked in the notebook rail (Ctrl/Cmd+Click, Shift+Click). Pure, so
 * the rules live apart from the rows: files only, all in one notebook (a
 * Ctrl+Click on a file of another notebook starts over there), and paths that
 * leave the tree are dropped when it refreshes. Paths, not nodes, are kept: a
 * node is replaced by every refresh.
 */
export type FileSelection = {
  /** The notebook all the files are in; "" when nothing is selected. */
  notebook: string;
  paths: readonly string[];
  /** The file a Shift+Click range starts from: the last one toggled on. */
  anchor: string;
};

export const NO_SELECTION: FileSelection = { notebook: "", paths: [], anchor: "" };

export function isSelected(selection: FileSelection, path: string) {
  return selection.paths.includes(path);
}

/** Ctrl+Click: adds the file, or takes it out when it is already in. Another notebook's file starts a new selection. */
export function toggleFile(selection: FileSelection, file: LiberaFileNode): FileSelection {
  if (selection.notebook !== file.notebook) return { notebook: file.notebook, paths: [file.path], anchor: file.path };
  if (selection.paths.includes(file.path)) {
    const paths = selection.paths.filter((path) => path !== file.path);
    return paths.length ? { notebook: selection.notebook, paths, anchor: selection.anchor === file.path ? paths[paths.length - 1] : selection.anchor } : NO_SELECTION;
  }
  return { notebook: file.notebook, paths: [...selection.paths, file.path], anchor: file.path };
}

/**
 * Shift+Click: the visible files from the anchor to this one. `visible` is the
 * notebook's file rows in the order they are shown. Without an anchor in the
 * same notebook (or one that is no longer shown) it selects just this file.
 */
export function selectRange(selection: FileSelection, file: LiberaFileNode, visible: readonly LiberaFileNode[]): FileSelection {
  const from = selection.notebook === file.notebook ? visible.findIndex((item) => item.path === selection.anchor) : -1;
  const to = visible.findIndex((item) => item.path === file.path);
  if (from < 0 || to < 0) return { notebook: file.notebook, paths: [file.path], anchor: file.path };
  const [start, end] = from <= to ? [from, to] : [to, from];
  return { notebook: file.notebook, paths: visible.slice(start, end + 1).map((item) => item.path), anchor: selection.anchor };
}

/** The file nodes of a notebook's children in the order the rail shows them: folders only count when expanded, and "show more" limits apply. */
export function visibleFiles(
  children: readonly LiberaTreeNode[],
  isExpanded: (folderPath: string) => boolean,
  limitFor: (folderPath: string) => number,
  parentPath: string,
): LiberaFileNode[] {
  const files: LiberaFileNode[] = [];
  for (const node of children.slice(0, limitFor(parentPath))) {
    if (node.kind === "file") files.push(node);
    else if (isExpanded(node.path)) files.push(...visibleFiles(node.children, isExpanded, limitFor, node.path));
  }
  return files;
}

function collectFiles(nodes: readonly LiberaTreeNode[], into: Map<string, LiberaFileNode>) {
  for (const node of nodes) {
    if (node.kind === "file") into.set(node.path, node);
    else collectFiles(node.children, into);
  }
}

function filesByPath(tree: LiberaTree) {
  const files = new Map<string, LiberaFileNode>();
  for (const notebook of tree.notebooks) collectFiles(notebook.children, files);
  return files;
}

/** After a refresh: drops the paths that are no longer files of the tree. Returns the same object when nothing changed. */
export function pruneSelection(selection: FileSelection, tree: LiberaTree): FileSelection {
  if (!selection.paths.length) return selection;
  const files = filesByPath(tree);
  const paths = selection.paths.filter((path) => files.has(path));
  if (paths.length === selection.paths.length) return selection;
  if (!paths.length) return NO_SELECTION;
  return { notebook: selection.notebook, paths, anchor: paths.includes(selection.anchor) ? selection.anchor : paths[paths.length - 1] };
}

/** The selected files as the tree now has them, in selection order. */
export function selectedFiles(selection: FileSelection, tree: LiberaTree): LiberaFileNode[] {
  const files = filesByPath(tree);
  return selection.paths.flatMap((path) => { const file = files.get(path); return file ? [file] : []; });
}

/** Whether the context menu of `file` is the batch menu: it is one of two or more selected files. */
export function usesBatchMenu(selection: FileSelection, file: LiberaFileNode) {
  return selection.paths.length >= 2 && selection.paths.includes(file.path);
}

/** What a drag that starts on `file` carries: the whole selection when the file is in one of two or more, else just the file. */
export function draggedFiles(selection: FileSelection, file: LiberaFileNode, tree: LiberaTree): LiberaFileNode[] {
  if (!usesBatchMenu(selection, file)) return [file];
  const files = selectedFiles(selection, tree);
  return files.some((item) => item.path === file.path) ? files : [file];
}
