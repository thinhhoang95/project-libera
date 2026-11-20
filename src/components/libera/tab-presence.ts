import type { LiberaFileNode, LiberaTree, LiberaTreeNode } from "@/lib/types";

type TabLike = { id: string; file: LiberaFileNode; untitled?: boolean; standaloneSaveId?: string; gallery?: unknown; recording?: unknown; page?: unknown };

function collectPaths(nodes: readonly LiberaTreeNode[], into: Set<string>) {
  for (const node of nodes) {
    if (node.kind === "folder") collectPaths(node.children, into);
    else into.add(node.path);
  }
}

/**
 * The open tabs whose file is no longer in the tree: moved or deleted outside the app.
 * Only tabs of files in a notebook the tree shows in full are judged; a linked folder
 * that is cut short or unplugged proves nothing about its files.
 */
export function missingTabIds(tabs: readonly TabLike[], tree: LiberaTree): Set<string> {
  const present = new Map<string, Set<string>>();
  for (const notebook of tree.notebooks) {
    if (notebook.folder?.truncated || notebook.folder?.missing) continue;
    const paths = new Set<string>();
    collectPaths(notebook.children, paths);
    present.set(notebook.name, paths);
  }
  const missing = new Set<string>();
  for (const tab of tabs) {
    if (tab.untitled || tab.standaloneSaveId || tab.gallery || tab.recording || tab.page) continue;
    const paths = present.get(tab.file.notebook);
    if (paths && !paths.has(tab.file.path)) missing.add(tab.id);
  }
  return missing;
}

/**
 * Names of the tabs under a path (the file itself, or inside it when it is a folder
 * or notebook) that have unsaved edits, for the delete confirmation.
 */
export function unsavedNamesUnder<T extends { file: LiberaFileNode }>(tabs: readonly T[], prefix: string, isUnsaved: (tab: T) => boolean): string[] {
  return tabs
    .filter((tab) => (tab.file.path === prefix || tab.file.path.startsWith(`${prefix}/`)) && isUnsaved(tab))
    .map((tab) => tab.file.name);
}
