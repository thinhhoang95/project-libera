import { ARCHIVE_DIR } from "@/lib/storage/constants";
import type { OpenTab } from "@/components/libera/types";
import type { LiberaNotebookGroup, LiberaNotebookViewOptions, LiberaTree, LiberaTreeNode } from "@/lib/types";

export type WorkspaceScope = { mode: "all" | "include" | "exclude"; paths: string[]; includedPaths?: string[] };
export type WorkspaceFileChange = { paths?: string[]; moved?: { from: string; to: string }; removed?: string[]; notebookGroup?: { notebook: string; groupId: string | null } };
export type WorkspaceView = {
  sidebarSort: string;
  fileSort: "updated" | "name";
  fileView: "list" | "grid";
  notebookGroups: LiberaNotebookGroup[];
  notebookGroupIds: Record<string, string | null>;
  notebookViewOptions: LiberaNotebookViewOptions;
};

export function createWorkspaceView(tree: LiberaTree): WorkspaceView {
  return {
    sidebarSort: "updatedAt:desc", fileSort: "updated", fileView: "list",
    notebookGroups: tree.notebookGroups.map((group) => ({ ...group })),
    notebookGroupIds: Object.fromEntries(tree.notebooks.map((notebook) => [notebook.name, notebook.groupId])),
    notebookViewOptions: { hiddenGroupIds: [], hiddenNotebookNames: [], showArchive: tree.notebookViewOptions.showArchive },
  };
}

export function applyWorkspaceView(tree: LiberaTree, view?: WorkspaceView): LiberaTree {
  const notebookViewOptions = view?.notebookViewOptions ?? tree.notebookViewOptions;
  function visibleChildren(nodes: LiberaTreeNode[]): LiberaTreeNode[] {
    if (notebookViewOptions.showArchive) return nodes;
    return nodes.filter((node) => node.kind !== "folder" || node.name !== ARCHIVE_DIR)
      .map((node) => node.kind === "folder" ? { ...node, children: visibleChildren(node.children) } : node);
  }
  return { ...tree, notebookGroups: view?.notebookGroups ?? tree.notebookGroups, notebookViewOptions,
    notebooks: tree.notebooks.map((notebook) => ({ ...notebook,
      children: visibleChildren(notebook.children),
      groupId: view ? Object.hasOwn(view.notebookGroupIds, notebook.name) ? view.notebookGroupIds[notebook.name] : null : notebook.groupId,
    })) };
}

export function saveWorkspaceGroup(view: WorkspaceView, group: LiberaNotebookGroup, notebookNames: string[]): WorkspaceView {
  if (!group.title.trim()) throw new Error("Group title is required.");
  if (view.notebookGroups.some((item) => item.id !== group.id && item.title.toLowerCase() === group.title.trim().toLowerCase())) throw new Error("Group title already exists.");
  const selected = new Set(notebookNames);
  return { ...view,
    notebookGroups: view.notebookGroups.some((item) => item.id === group.id)
      ? view.notebookGroups.map((item) => item.id === group.id ? group : item) : [...view.notebookGroups, group],
    notebookGroupIds: Object.fromEntries([...new Set([...Object.keys(view.notebookGroupIds), ...notebookNames])].map((name) =>
      [name, selected.has(name) ? group.id : view.notebookGroupIds[name] === group.id ? null : view.notebookGroupIds[name]])),
  };
}

export function removeWorkspaceGroup(view: WorkspaceView, id: string): WorkspaceView {
  return { ...view, notebookGroups: view.notebookGroups.filter((group) => group.id !== id),
    notebookGroupIds: Object.fromEntries(Object.entries(view.notebookGroupIds).map(([name, groupId]) => [name, groupId === id ? null : groupId])),
    notebookViewOptions: { ...view.notebookViewOptions, hiddenGroupIds: view.notebookViewOptions.hiddenGroupIds.filter((groupId) => groupId !== id) },
  };
}
export type WorkspaceSession = {
  tabs: OpenTab[];
  activeTabId: string;
  selectedNotebookName: string;
  expandedPaths: string[];
};
export type SavedWorkspace = {
  id: string;
  name: string;
  color: string;
  scope: WorkspaceScope;
  view?: WorkspaceView;
  session: WorkspaceSession;
};
export type WorkspaceLibrary = {
  version: 1;
  updatedAt: number;
  activeWorkspaceId: string | null;
  workspaces: SavedWorkspace[];
  librarySession: WorkspaceSession | null;
};
export const emptyWorkspaceSession = (): WorkspaceSession => ({ tabs: [], activeTabId: "", selectedNotebookName: "", expandedPaths: [] });
export const emptyWorkspaceLibrary = (): WorkspaceLibrary => ({ version: 1, updatedAt: 0, activeWorkspaceId: null, workspaces: [], librarySession: null });
export const withinPath = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`);

export function workspaceIncludesPath(scope: WorkspaceScope, path: string) {
  if (scope.includedPaths?.some((parent) => withinPath(path, parent))) return true;
  const selected = scope.paths.some((parent) => withinPath(path, parent));
  return scope.mode === "all" || (scope.mode === "include" ? selected : !selected);
}

// Keep exceptions narrow: creating a file in an excluded folder must not reveal
// the folder's other contents or change how future files are filtered.
export function trackWorkspaceFileChange(library: WorkspaceLibrary, workspaceId: string | null, change: WorkspaceFileChange): WorkspaceLibrary {
  const next = change.moved ? remapWorkspacePaths(library, change.moved.from, change.moved.to) : library;
  const additions = change.paths ?? [];
  const keep = (path: string) => !change.removed?.some((parent) => withinPath(path, parent));
  return { ...next, updatedAt: Math.max(Date.now(), next.updatedAt + 1), workspaces: next.workspaces.map((workspace) => {
    let scope = { ...workspace.scope, paths: workspace.scope.paths.filter(keep),
      ...(workspace.scope.includedPaths ? { includedPaths: workspace.scope.includedPaths.filter(keep) } : {}) };
    if (workspace.id === workspaceId) {
      for (const path of additions) {
        if (workspaceIncludesPath(scope, path)) continue;
        if (scope.mode === "include") scope = { ...scope, paths: [...scope.paths.filter((item) => !withinPath(item, path)), path] };
        else scope = { ...scope, includedPaths: [...(scope.includedPaths ?? []).filter((item) => !withinPath(item, path)), path] };
      }
    }
    let view = workspace.view;
    if (view && (change.removed?.length || (workspace.id === workspaceId && change.notebookGroup))) {
      view = { ...view, notebookGroupIds: Object.fromEntries(Object.entries(view.notebookGroupIds).filter(([name]) => keep(name))),
        notebookViewOptions: { ...view.notebookViewOptions, hiddenNotebookNames: view.notebookViewOptions.hiddenNotebookNames.filter(keep) } };
      if (workspace.id === workspaceId && change.notebookGroup) {
        view.notebookGroupIds[change.notebookGroup.notebook] = change.notebookGroup.groupId;
      }
    }
    return { ...workspace, scope, ...(view ? { view } : {}) };
  }) };
}

export function filterWorkspaceTree(tree: LiberaTree, scope?: WorkspaceScope, view?: WorkspaceView): LiberaTree {
  tree = applyWorkspaceView(tree, view);
  if (!scope) return tree;
  function filter(nodes: LiberaTreeNode[]): LiberaTreeNode[] {
    return nodes.flatMap((node): LiberaTreeNode[] => {
      if (node.kind === "file") return workspaceIncludesPath(scope!, node.path) ? [node] : [];
      const children = filter(node.children);
      return children.length || workspaceIncludesPath(scope!, node.path) ? [{ ...node, children }] : [];
    });
  }
  const notebooks = tree.notebooks.flatMap((notebook) => {
    const children = filter(notebook.children);
    return children.length || workspaceIncludesPath(scope, notebook.path) ? [{ ...notebook, children }] : [];
  });
  const groups = new Set(notebooks.map((notebook) => notebook.groupId));
  return {
    ...tree,
    notebookGroups: view ? tree.notebookGroups : tree.notebookGroups.filter((group) => groups.has(group.id)),
    // Workspace selection is authoritative, independent of library view preferences.
    notebookViewOptions: view ? tree.notebookViewOptions : { ...tree.notebookViewOptions, hiddenGroupIds: [], hiddenNotebookNames: [] },
    notebooks,
  };
}

export function captureWorkspaceSession(session: WorkspaceSession, readDraft: (tab: OpenTab) => string): WorkspaceSession {
  return { ...session, tabs: session.tabs.map((tab) => {
    const draft = readDraft(tab);
    return { ...tab, draft, status: draft === tab.saved ? "clean" : "dirty", error: undefined };
  }) };
}

export function saveWorkspaceSession(library: WorkspaceLibrary, session: WorkspaceSession): WorkspaceLibrary {
  return {
    ...library, updatedAt: Math.max(Date.now(), library.updatedAt + 1),
    librarySession: library.activeWorkspaceId ? library.librarySession : session,
    workspaces: library.workspaces.map((workspace) => workspace.id === library.activeWorkspaceId ? { ...workspace, session } : workspace),
  };
}

// Validate persisted data at both boundaries. Invalid data must never silently replace a library.
export function parseWorkspaceLibrary(value: unknown): WorkspaceLibrary {
  const library = value as WorkspaceLibrary;
  const strings = (values: unknown): values is string[] => Array.isArray(values) && values.every((v) => typeof v === "string");
  function validView(view: WorkspaceView | undefined) {
    if (view === undefined) return true; // Older snapshots inherit library settings once on load.
    return view && /^(name|createdAt|updatedAt|interactedAt):(asc|desc)$/.test(view.sidebarSort) &&
      ["updated", "name"].includes(view.fileSort) && ["list", "grid"].includes(view.fileView) &&
      Array.isArray(view.notebookGroups) && view.notebookGroups.every((group) => group && typeof group.id === "string" && group.id.length > 0 && typeof group.title === "string" && group.title.trim().length > 0 && typeof group.description === "string" && typeof group.createdAt === "string" && typeof group.updatedAt === "string") &&
      new Set(view.notebookGroups.map((group) => group.id)).size === view.notebookGroups.length &&
      view.notebookGroupIds && typeof view.notebookGroupIds === "object" && !Array.isArray(view.notebookGroupIds) && Object.values(view.notebookGroupIds).every((id) => id === null || view.notebookGroups.some((group) => group.id === id)) &&
      view.notebookViewOptions && strings(view.notebookViewOptions.hiddenGroupIds) && strings(view.notebookViewOptions.hiddenNotebookNames) && typeof view.notebookViewOptions.showArchive === "boolean";
  }
  function validSession(session: WorkspaceSession) {
    return session && typeof session.activeTabId === "string" && typeof session.selectedNotebookName === "string" && strings(session.expandedPaths) && Array.isArray(session.tabs) && session.tabs.every((tab) =>
      tab && typeof tab.id === "string" && typeof tab.draft === "string" && typeof tab.saved === "string" && tab.file && typeof tab.file.path === "string" && typeof tab.file.name === "string" && typeof tab.file.notebook === "string" && ["markdown", "pdf", "image"].includes(tab.file.fileType));
  }
  if (!library || library.version !== 1 || !Number.isFinite(library.updatedAt) || !Array.isArray(library.workspaces) ||
    !(library.activeWorkspaceId === null || typeof library.activeWorkspaceId === "string") ||
    !(library.librarySession === null || validSession(library.librarySession)) ||
    !library.workspaces.every((workspace) => workspace && typeof workspace.id === "string" && workspace.id.length > 0 && typeof workspace.name === "string" && workspace.name.trim().length > 0 && workspace.name.length <= 100 && /^#[0-9a-f]{6}$/i.test(workspace.color) && workspace.scope && ["all", "include", "exclude"].includes(workspace.scope.mode) && strings(workspace.scope.paths) && (workspace.scope.includedPaths === undefined || strings(workspace.scope.includedPaths)) && validSession(workspace.session) && validView(workspace.view)) ||
    new Set(library.workspaces.map((workspace) => workspace.id)).size !== library.workspaces.length ||
    (library.activeWorkspaceId !== null && !library.workspaces.some((workspace) => workspace.id === library.activeWorkspaceId))) {
    throw new Error("Workspace data is invalid. Your saved workspaces have not been replaced.");
  }
  return library;
}

export function remapWorkspacePaths(library: WorkspaceLibrary, from: string, to: string): WorkspaceLibrary {
  const remap = (value: string) => withinPath(value, from) ? `${to}${value.slice(from.length)}` : value;
  const session = (value: WorkspaceSession): WorkspaceSession => ({
    ...value, activeTabId: remap(value.activeTabId), selectedNotebookName: remap(value.selectedNotebookName),
    expandedPaths: value.expandedPaths.map(remap),
    tabs: value.tabs.map((tab) => {
      const path = remap(tab.file.path);
      return path === tab.file.path ? tab : { ...tab, id: remap(tab.id), file: { ...tab.file, path, name: path.split("/").at(-1)!, notebook: path.split("/")[0] }, rawUrl: `/api/files/raw/${path.split("/").map(encodeURIComponent).join("/")}` };
    }),
  });
  return { ...library, updatedAt: Math.max(Date.now(), library.updatedAt + 1), librarySession: library.librarySession ? session(library.librarySession) : null,
    workspaces: library.workspaces.map((workspace) => ({ ...workspace,
      ...(workspace.view ? { view: { ...workspace.view,
        notebookGroupIds: Object.fromEntries(Object.entries(workspace.view.notebookGroupIds).map(([name, id]) => [remap(name), id])),
        notebookViewOptions: { ...workspace.view.notebookViewOptions, hiddenNotebookNames: workspace.view.notebookViewOptions.hiddenNotebookNames.map(remap) },
      } } : {}), scope: { ...workspace.scope, paths: workspace.scope.paths.map(remap), ...(workspace.scope.includedPaths ? { includedPaths: workspace.scope.includedPaths.map(remap) } : {}) }, session: session(workspace.session) })) };
}
