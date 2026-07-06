"use client";

import { useEffect, useMemo, useState } from "react";
import type { DragEvent, MouseEvent, RefObject } from "react";
import {
  ArrowDownUp,
  BookPlus,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Star,
  Trash2,
} from "lucide-react";
import { DeepSearchDialog } from "@/components/libera/deep-search-dialog";
import { FileTypeIcon, fileTypeLabel } from "@/components/libera/file-type";
import { ModalDialog } from "@/components/libera/modal-dialog";
import { SidebarSearch } from "@/components/libera/sidebar-search";
import { ARCHIVE_DIR } from "@/lib/storage/constants";
import type { OpenTabViewState, SearchResult } from "@/components/libera/types";
import type {
  LiberaFileNode,
  LiberaFolderNode,
  LiberaNotebookGroup,
  LiberaNotebookNode,
  LiberaNotebookViewOptions,
  LiberaTree,
  LiberaTreeNode,
} from "@/lib/types";

type SidebarMenuTarget =
  | { kind: "file"; file: LiberaFileNode }
  | { kind: "folder"; folder: LiberaFolderNode };

type NativeMenuItem =
  | {
      checked?: boolean;
      enabled?: boolean;
      id: string;
      label: string;
      type?: "normal" | "checkbox" | "radio";
    }
  | {
      type: "separator";
    };

type NativeMenuPoint = {
  x: number;
  y: number;
};

export type NotebookPanelProps = {
  activeTabId: string;
  expanded: Set<string>;
  fileInteractions: Record<string, string>;
  query: string;
  searchResults: SearchResult[];
  selectedNotebookName: string;
  tree: LiberaTree;
  uploadInputRef: RefObject<HTMLInputElement | null>;
  onCopyFile: (file: LiberaFileNode) => Promise<void>;
  onArchiveFile: (file: LiberaFileNode) => Promise<void>;
  onArchiveFolder: (folder: LiberaFolderNode) => Promise<void>;
  onCreateFolder: (parentPath: string) => Promise<void>;
  onCreateMarkdown: (notebook: string, parentPath?: string) => Promise<void>;
  onCreateSlides: (notebook: string) => Promise<void>;
  onCreateNotebook: () => void;
  onCreateNotebookGroup: () => void;
  onDeleteNotebook: (notebook: string) => Promise<void>;
  onDeleteNotebookGroup: (group: LiberaNotebookGroup) => Promise<void>;
  onDeleteFile: (file: LiberaFileNode) => Promise<void>;
  onDeleteFolder: (folder: LiberaFolderNode) => Promise<void>;
  onDownloadFile: (file: LiberaFileNode) => void;
  onDownloadNotebook: (notebook: string) => void;
  onEditNotebook: (notebook: LiberaNotebookNode) => void;
  onEditNotebookGroup: (group: LiberaNotebookGroup) => void;
  onMoveFile: (file: LiberaFileNode, destinationPath: string) => Promise<void>;
  onOpenFile: (file: LiberaFileNode, options?: { viewState?: OpenTabViewState }) => Promise<void>;
  onQueryChange: (query: string) => void;
  onRenameFolder: (folder: LiberaFolderNode) => Promise<void>;
  onRenameFile: (file: LiberaFileNode) => Promise<void>;
  onSelectNotebook: (notebook: string) => void;
  onSelectSearchResult: (result: SearchResult) => void;
  onStartUpload: (notebook: string) => void;
  onToggleFileStar: (file: LiberaFileNode, starred: boolean) => Promise<void>;
  onToggleNotebook: (notebook: string) => void;
  onUploadChange: () => Promise<void>;
  onUploadFiles: (
    notebook: string,
    files: File[],
    destinationPath?: string,
  ) => Promise<void>;
  onUpdateNotebookViewOptions: (
    viewOptions: LiberaNotebookViewOptions,
  ) => Promise<void>;
};

type SidebarSortKey = "name" | "createdAt" | "updatedAt" | "interactedAt";
type SidebarSortDirection = "asc" | "desc";

type SidebarSortPreference = {
  key: SidebarSortKey;
  direction: SidebarSortDirection;
};

const SIDEBAR_SORT_STORAGE_KEY = "libera.sidebarSort";
const DEFAULT_SIDEBAR_SORT: SidebarSortPreference = {
  key: "updatedAt",
  direction: "desc",
};
const SIDEBAR_PAGE_SIZE = 20;
const STARRED_FILES_PAGINATION_KEY = "__starred-files__";

const SORT_OPTIONS: Array<{
  direction: SidebarSortDirection;
  key: SidebarSortKey;
  label: string;
}> = [
  { key: "name", direction: "asc", label: "Name, A to Z" },
  { key: "name", direction: "desc", label: "Name, Z to A" },
  { key: "createdAt", direction: "desc", label: "Date created, newest first" },
  { key: "createdAt", direction: "asc", label: "Date created, oldest first" },
  { key: "updatedAt", direction: "desc", label: "Last modified, newest first" },
  { key: "updatedAt", direction: "asc", label: "Last modified, oldest first" },
  { key: "interactedAt", direction: "desc", label: "Last interacted, newest first" },
  { key: "interactedAt", direction: "asc", label: "Last interacted, oldest first" },
];

function parseSortPreference(input: unknown): SidebarSortPreference {
  if (!input || typeof input !== "object") {
    return DEFAULT_SIDEBAR_SORT;
  }

  const candidate = input as Partial<SidebarSortPreference>;

  if (
    (candidate.key === "name" ||
      candidate.key === "createdAt" ||
      candidate.key === "updatedAt" ||
      candidate.key === "interactedAt") &&
    (candidate.direction === "asc" || candidate.direction === "desc")
  ) {
    return {
      key: candidate.key,
      direction: candidate.direction,
    };
  }

  return DEFAULT_SIDEBAR_SORT;
}

function hasExternalFiles(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes("Files");
}

function handleFileDragOverDirectory(
  event: DragEvent<HTMLElement>,
  draggingFile: LiberaFileNode | null,
  destinationPath: string,
  onSetDragOverPath: (path: string) => void,
) {
  if (!draggingFile) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = "move";
  onSetDragOverPath(destinationPath);
}

function handleFileDropOnDirectory(
  event: DragEvent<HTMLElement>,
  draggingFile: LiberaFileNode | null,
  destinationPath: string,
  onDropFile: (destinationPath: string) => Promise<void>,
) {
  if (!draggingFile) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  void onDropFile(destinationPath);
}

function dateValue(value: string | undefined) {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestNodeInteraction(
  node: LiberaTreeNode,
  fileInteractions: Record<string, string>,
): number {
  if (node.kind === "file") {
    return dateValue(fileInteractions[node.path]);
  }

  return Math.max(0, ...node.children.map((child) => latestNodeInteraction(child, fileInteractions)));
}

function latestNotebookInteraction(
  notebook: LiberaNotebookNode,
  fileInteractions: Record<string, string>,
) {
  return Math.max(
    0,
    ...notebook.children.map((child) => latestNodeInteraction(child, fileInteractions)),
  );
}

function nodeSortValue(
  node: LiberaTreeNode,
  sortPreference: SidebarSortPreference,
  fileInteractions: Record<string, string>,
) {
  if (sortPreference.key === "name") {
    return node.name;
  }

  if (sortPreference.key === "interactedAt") {
    return latestNodeInteraction(node, fileInteractions);
  }

  return dateValue(node[sortPreference.key]);
}

function notebookSortValue(
  notebook: LiberaNotebookNode,
  sortPreference: SidebarSortPreference,
  fileInteractions: Record<string, string>,
) {
  if (sortPreference.key === "name") {
    return notebook.name;
  }

  if (sortPreference.key === "interactedAt") {
    return latestNotebookInteraction(notebook, fileInteractions);
  }

  return dateValue(notebook[sortPreference.key]);
}

function compareSortValues(
  leftValue: number | string,
  rightValue: number | string,
  direction: SidebarSortDirection,
) {
  const difference =
    typeof leftValue === "string" && typeof rightValue === "string"
      ? leftValue.localeCompare(rightValue)
      : Number(leftValue) - Number(rightValue);

  return direction === "asc" ? difference : -difference;
}

function sortTreeNodesForSidebar(
  nodes: LiberaTreeNode[],
  sortPreference: SidebarSortPreference,
  fileInteractions: Record<string, string>,
): LiberaTreeNode[] {
  return nodes
    .map((node) =>
      node.kind === "folder"
        ? {
            ...node,
            children: sortTreeNodesForSidebar(
              node.children,
              sortPreference,
              fileInteractions,
            ),
          }
        : node,
    )
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "folder" ? -1 : 1;
      }

      const sortComparison = compareSortValues(
        nodeSortValue(left, sortPreference, fileInteractions),
        nodeSortValue(right, sortPreference, fileInteractions),
        sortPreference.direction,
      );

      return sortComparison || left.name.localeCompare(right.name);
    });
}

function sortTreeForSidebar(
  tree: LiberaTree,
  sortPreference: SidebarSortPreference,
  fileInteractions: Record<string, string>,
): LiberaTree {
  return {
    ...tree,
    notebooks: tree.notebooks
      .map((notebook) => ({
        ...notebook,
        children: sortTreeNodesForSidebar(
          notebook.children,
          sortPreference,
          fileInteractions,
        ),
      }))
      .sort((left, right) => {
        const sortComparison = compareSortValues(
          notebookSortValue(left, sortPreference, fileInteractions),
          notebookSortValue(right, sortPreference, fileInteractions),
          sortPreference.direction,
        );

        return sortComparison || left.name.localeCompare(right.name);
      }),
  };
}

function isNotebookVisibleInPanel(
  notebook: LiberaNotebookNode,
  viewOptions: LiberaNotebookViewOptions,
) {
  if (viewOptions.hiddenNotebookNames.includes(notebook.name)) {
    return false;
  }

  return !notebook.groupId || !viewOptions.hiddenGroupIds.includes(notebook.groupId);
}

function groupNotebookSections(
  tree: LiberaTree,
): {
  groupedSections: Array<{
    group: LiberaNotebookGroup;
    notebooks: LiberaNotebookNode[];
  }>;
  topLevelNotebooks: LiberaNotebookNode[];
} {
  const groupsById = new Map(tree.notebookGroups.map((group) => [group.id, group]));
  const topLevelNotebooks: LiberaNotebookNode[] = [];
  const notebooksByGroupId = new Map<string, LiberaNotebookNode[]>();

  for (const notebook of tree.notebooks) {
    if (!isNotebookVisibleInPanel(notebook, tree.notebookViewOptions)) {
      continue;
    }

    if (!notebook.groupId || !groupsById.has(notebook.groupId)) {
      topLevelNotebooks.push(notebook);
      continue;
    }

    const groupNotebooks = notebooksByGroupId.get(notebook.groupId) ?? [];
    groupNotebooks.push(notebook);
    notebooksByGroupId.set(notebook.groupId, groupNotebooks);
  }

  return {
    topLevelNotebooks,
    groupedSections: [...tree.notebookGroups]
      .filter((group) => !tree.notebookViewOptions.hiddenGroupIds.includes(group.id))
      .sort((left, right) => left.title.localeCompare(right.title))
      .map((group) => ({
        group,
        notebooks: notebooksByGroupId.get(group.id) ?? [],
      })),
  };
}

function collectFilesByPath(nodes: LiberaTreeNode[], filesByPath: Map<string, LiberaFileNode>) {
  for (const node of nodes) {
    if (node.kind === "file") {
      filesByPath.set(node.path, node);
      continue;
    }

    collectFilesByPath(node.children, filesByPath);
  }
}

function collectStarredFilesForPanel(tree: LiberaTree) {
  const filesByPath = new Map<string, LiberaFileNode>();

  for (const notebook of tree.notebooks) {
    if (!isNotebookVisibleInPanel(notebook, tree.notebookViewOptions)) {
      continue;
    }

    collectFilesByPath(notebook.children, filesByPath);
  }

  return tree.starredFilePaths
    .map((filePath) => filesByPath.get(filePath))
    .filter((file): file is LiberaFileNode => Boolean(file));
}

function parentPathForSidebarFile(file: LiberaFileNode) {
  const parts = file.path.split("/");
  return parts.slice(0, -1).join("/") || file.notebook;
}

function isArchivedItemPath(node: LiberaFileNode | LiberaFolderNode) {
  const archivePath = `${node.notebook}/${ARCHIVE_DIR}`;

  return node.path === archivePath || node.path.startsWith(`${archivePath}/`);
}

async function showNativeMenu(items: NativeMenuItem[], point: NativeMenuPoint) {
  const menu = window.liberaMenu;

  if (!menu) {
    return null;
  }

  try {
    return await menu.popup({ items, ...point });
  } catch {
    return null;
  }
}

function nativeMenuPointFromButton(button: HTMLElement): NativeMenuPoint {
  const rect = button.getBoundingClientRect();

  return {
    x: Math.round(rect.left),
    y: Math.round(rect.bottom),
  };
}

function nativeMenuPointFromMouseEvent(event: MouseEvent): NativeMenuPoint {
  return {
    x: Math.round(event.clientX),
    y: Math.round(event.clientY),
  };
}

async function revealNotebookInFileExplorer(notebook: string) {
  const fileExplorer = window.liberaFileExplorer;

  if (!fileExplorer) {
    return;
  }

  await fileExplorer.revealNotebook(notebook);
}

async function revealItemInFileExplorer(relativePath: string) {
  const fileExplorer = window.liberaFileExplorer;

  if (!fileExplorer?.revealItem) {
    return;
  }

  await fileExplorer.revealItem(relativePath);
}

export function NotebookPanel({
  activeTabId,
  expanded,
  fileInteractions,
  query,
  searchResults,
  selectedNotebookName,
  tree,
  uploadInputRef,
  onCopyFile,
  onArchiveFile,
  onArchiveFolder,
  onCreateFolder,
  onCreateMarkdown,
  onCreateSlides,
  onCreateNotebook,
  onCreateNotebookGroup,
  onDeleteFile,
  onDeleteFolder,
  onDeleteNotebook,
  onDeleteNotebookGroup,
  onDownloadFile,
  onDownloadNotebook,
  onEditNotebook,
  onEditNotebookGroup,
  onMoveFile,
  onOpenFile,
  onQueryChange,
  onRenameFolder,
  onRenameFile,
  onSelectNotebook,
  onSelectSearchResult,
  onStartUpload,
  onToggleFileStar,
  onToggleNotebook,
  onUploadChange,
  onUploadFiles,
  onUpdateNotebookViewOptions,
}: NotebookPanelProps) {
  const [draggingFile, setDraggingFile] = useState<LiberaFileNode | null>(null);
  const [dragOverPath, setDragOverPath] = useState("");
  const [deepSearchQuery, setDeepSearchQuery] = useState("");
  const [deepSearchOpen, setDeepSearchOpen] = useState(false);
  const [sortPreference, setSortPreference] =
    useState<SidebarSortPreference>(DEFAULT_SIDEBAR_SORT);
  const [viewOptionsOpen, setViewOptionsOpen] = useState(false);
  const [viewOptionsSubmitting, setViewOptionsSubmitting] = useState(false);
  const [viewOptionsError, setViewOptionsError] = useState("");
  const [visibleNodeLimits, setVisibleNodeLimits] = useState<Record<string, number>>({});
  const sortedTree = useMemo(
    () => sortTreeForSidebar(tree, sortPreference, fileInteractions),
    [fileInteractions, sortPreference, tree],
  );
  const { groupedSections, topLevelNotebooks } = useMemo(
    () => groupNotebookSections(sortedTree),
    [sortedTree],
  );
  const starredFiles = useMemo(
    () => collectStarredFilesForPanel(sortedTree),
    [sortedTree],
  );
  const starredFilePaths = useMemo(
    () => new Set(sortedTree.starredFilePaths),
    [sortedTree.starredFilePaths],
  );
  const hasPanelItems =
    Boolean(sortedTree.notebooks.length) || Boolean(sortedTree.notebookGroups.length);
  const hasVisiblePanelItems =
    Boolean(topLevelNotebooks.length) || Boolean(groupedSections.length);

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => {
      try {
        setSortPreference(
          parseSortPreference(
            JSON.parse(window.localStorage.getItem(SIDEBAR_SORT_STORAGE_KEY) ?? "{}"),
          ),
        );
      } catch {
        setSortPreference(DEFAULT_SIDEBAR_SORT);
      }
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, []);

  function openContextMenu(event: MouseEvent, target: SidebarMenuTarget) {
    event.preventDefault();
    event.stopPropagation();
    void openSidebarNativeMenu(target, nativeMenuPointFromMouseEvent(event));
  }

  async function dropFileOnPath(destinationPath: string) {
    if (!draggingFile) {
      return;
    }

    await onMoveFile(draggingFile, destinationPath);
    setDraggingFile(null);
    setDragOverPath("");
  }

  function openDeepSearch(searchQuery: string) {
    setDeepSearchQuery(searchQuery);
    setDeepSearchOpen(true);
  }

  function applySortPreference(nextSortPreference: SidebarSortPreference) {
    setSortPreference(nextSortPreference);
    window.localStorage.setItem(
      SIDEBAR_SORT_STORAGE_KEY,
      JSON.stringify(nextSortPreference),
    );
  }

  function visibleNodeLimitForPath(path: string) {
    return visibleNodeLimits[path] ?? SIDEBAR_PAGE_SIZE;
  }

  function showMoreNodes(path: string) {
    setVisibleNodeLimits((current) => ({
      ...current,
      [path]: (current[path] ?? SIDEBAR_PAGE_SIZE) + SIDEBAR_PAGE_SIZE,
    }));
  }

  async function saveViewOptions(viewOptions: LiberaNotebookViewOptions) {
    setViewOptionsSubmitting(true);
    setViewOptionsError("");

    try {
      await onUpdateNotebookViewOptions(viewOptions);
      setViewOptionsOpen(false);
    } catch (error) {
      setViewOptionsError(
        error instanceof Error ? error.message : "Could not save view options.",
      );
    } finally {
      setViewOptionsSubmitting(false);
    }
  }

  async function toggleShowArchive() {
    await onUpdateNotebookViewOptions({
      ...tree.notebookViewOptions,
      showArchive: !tree.notebookViewOptions.showArchive,
    });
  }

  async function openSidebarNativeMenu(
    target: SidebarMenuTarget,
    point: NativeMenuPoint,
  ) {
    const fileIsStarred =
      target.kind === "file" ? starredFilePaths.has(target.file.path) : false;
    const isArchivedItem =
      target.kind === "file"
        ? isArchivedItemPath(target.file)
        : isArchivedItemPath(target.folder);
    const selectedItemId = await showNativeMenu(
      target.kind === "file"
        ? [
            {
              id: "toggle-star",
              label: fileIsStarred ? "Unstar" : "Star",
              type: "checkbox",
              checked: fileIsStarred,
            },
            { type: "separator" },
            { id: "download", label: "Download" },
            { id: "copy", label: "Copy" },
            { id: "rename", label: "Rename" },
            { id: "archive", label: "Archive", enabled: !isArchivedItem },
            {
              id: "reveal-in-file-explorer",
              label: "Reveal in File Explorer",
              enabled: Boolean(window.liberaFileExplorer?.revealItem),
            },
            { type: "separator" },
            { id: "delete", label: "Delete" },
          ]
        : [
            { id: "add-note", label: "Add Note" },
            { id: "new-folder", label: "New folder" },
            { type: "separator" },
            { id: "rename", label: "Rename" },
            { id: "archive", label: "Archive", enabled: !isArchivedItem },
            {
              id: "reveal-in-file-explorer",
              label: "Reveal in File Explorer",
              enabled: Boolean(window.liberaFileExplorer?.revealItem),
            },
            { type: "separator" },
            { id: "delete", label: "Delete" },
          ],
      point,
    );

    if (!selectedItemId) {
      return;
    }

    if (target.kind === "file") {
      if (selectedItemId === "toggle-star") {
        await onToggleFileStar(target.file, !fileIsStarred);
      } else if (selectedItemId === "download") {
        onDownloadFile(target.file);
      } else if (selectedItemId === "copy") {
        await onCopyFile(target.file);
      } else if (selectedItemId === "rename") {
        await onRenameFile(target.file);
      } else if (selectedItemId === "archive") {
        await onArchiveFile(target.file);
      } else if (selectedItemId === "reveal-in-file-explorer") {
        await revealItemInFileExplorer(target.file.path);
      } else if (selectedItemId === "delete") {
        await onDeleteFile(target.file);
      }

      return;
    }

    if (selectedItemId === "add-note") {
      await onCreateMarkdown(target.folder.notebook, target.folder.path);
    } else if (selectedItemId === "new-folder") {
      await onCreateFolder(target.folder.path);
    } else if (selectedItemId === "rename") {
      await onRenameFolder(target.folder);
    } else if (selectedItemId === "archive") {
      await onArchiveFolder(target.folder);
    } else if (selectedItemId === "reveal-in-file-explorer") {
      await revealItemInFileExplorer(target.folder.path);
    } else if (selectedItemId === "delete") {
      await onDeleteFolder(target.folder);
    }
  }

  async function openSortMenu(event: MouseEvent<HTMLButtonElement>) {
    const selectedItemId = await showNativeMenu(
      [
        ...SORT_OPTIONS.map((option) => ({
          id: `sort:${option.key}:${option.direction}`,
          label: option.label,
          type: "radio" as const,
          checked:
            option.key === sortPreference.key &&
            option.direction === sortPreference.direction,
        })),
        { type: "separator" as const },
        { id: "view-options", label: "View Options" },
      ],
      nativeMenuPointFromButton(event.currentTarget),
    );

    if (!selectedItemId) {
      return;
    }

    if (selectedItemId === "view-options") {
      setViewOptionsError("");
      setViewOptionsOpen(true);
      return;
    }

    const [, key, direction] = selectedItemId.split(":");

    if (
      (key === "name" ||
        key === "createdAt" ||
        key === "updatedAt" ||
        key === "interactedAt") &&
      (direction === "asc" || direction === "desc")
    ) {
      applySortPreference({ key, direction });
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <SidebarSearch
        query={query}
        searchResults={searchResults}
        onDeepSearch={openDeepSearch}
        onQueryChange={onQueryChange}
        onSelectSearchResult={onSelectSearchResult}
      />

      <div className="flex items-center justify-between border-b border-border px-4 py-2 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Notebook
        </h2>
        <div className="flex items-center gap-2">
          <button
            aria-haspopup="menu"
            aria-label="Sort notebooks and files"
            className="libera-sidebar-icon-button inline-flex h-9 w-9 items-center justify-center rounded-lg"
            title="Sort notebooks and files"
            type="button"
            onClick={(event) => void openSortMenu(event)}
          >
            <ArrowDownUp aria-hidden className="h-4 w-4" />
          </button>
          <button
            aria-label="New group"
            className="libera-sidebar-icon-button inline-flex h-9 w-9 items-center justify-center rounded-lg"
            title="New group"
            type="button"
            onClick={onCreateNotebookGroup}
          >
            <FolderPlus aria-hidden className="h-4 w-4" />
          </button>
          <button
            aria-label="New notebook"
            className="libera-sidebar-icon-button inline-flex h-9 w-9 items-center justify-center rounded-lg"
            title="New notebook"
            type="button"
            onClick={onCreateNotebook}
          >
            <BookPlus aria-hidden className="h-4 w-4" />
          </button>
        </div>
      </div>

      <input
        ref={uploadInputRef}
        className="hidden"
        type="file"
        multiple
        accept=".md,.markdown,.png,.jpg,.jpeg,.gif,.webp,.pdf"
        onChange={onUploadChange}
      />

      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {!hasPanelItems ? (
          <div className="rounded-lg border border-dashed border-input p-4 text-sm text-muted-foreground">
            No notebooks yet.
          </div>
        ) : null}
        {hasPanelItems && !hasVisiblePanelItems ? (
          <div className="rounded-lg border border-dashed border-input p-4 text-sm text-muted-foreground">
            No notebooks are visible.
          </div>
        ) : null}

        <div className="space-y-2">
          <StarredFilesSection
            activeTabId={activeTabId}
            dragOverPath={dragOverPath}
            draggingFile={draggingFile}
            expanded={expanded}
            files={starredFiles}
            starredFilePaths={starredFilePaths}
            onContextMenu={openContextMenu}
            onDropFile={dropFileOnPath}
            onOpenFile={onOpenFile}
            onShowMore={() => showMoreNodes(STARRED_FILES_PAGINATION_KEY)}
            onSetDragOverPath={setDragOverPath}
            onSetDraggingFile={setDraggingFile}
            onUploadFiles={onUploadFiles}
            visibleLimit={visibleNodeLimitForPath(STARRED_FILES_PAGINATION_KEY)}
          />
          {topLevelNotebooks.map((notebook) => (
            <NotebookSection
              key={notebook.name}
              activeTabId={activeTabId}
              dragOverPath={dragOverPath}
              draggingFile={draggingFile}
              expanded={expanded}
              isExpanded={expanded.has(notebook.name)}
              isSelected={selectedNotebookName === notebook.name}
              notebook={notebook}
              showArchive={tree.notebookViewOptions.showArchive}
              starredFilePaths={starredFilePaths}
              onArchiveVisibilityToggle={toggleShowArchive}
              onCreateFolder={onCreateFolder}
              onCreateMarkdown={onCreateMarkdown}
              onCreateSlides={onCreateSlides}
              onContextMenu={openContextMenu}
              onDeleteNotebook={onDeleteNotebook}
              onDropFile={dropFileOnPath}
              onDownloadNotebook={onDownloadNotebook}
              onEditNotebook={onEditNotebook}
              onOpenFile={onOpenFile}
              onSelectNotebook={onSelectNotebook}
              onShowMoreNodes={showMoreNodes}
              onSetDragOverPath={setDragOverPath}
              onSetDraggingFile={setDraggingFile}
              onStartUpload={onStartUpload}
              onToggleNotebook={onToggleNotebook}
              onUploadFiles={onUploadFiles}
              visibleNodeLimitForPath={visibleNodeLimitForPath}
            />
          ))}
          {groupedSections.map(({ group, notebooks }) => (
            <NotebookGroupSection
              key={group.id}
              activeTabId={activeTabId}
              dragOverPath={dragOverPath}
              draggingFile={draggingFile}
              expanded={expanded}
              group={group}
              notebooks={notebooks}
              selectedNotebookName={selectedNotebookName}
              showArchive={tree.notebookViewOptions.showArchive}
              starredFilePaths={starredFilePaths}
              onArchiveVisibilityToggle={toggleShowArchive}
              onCreateFolder={onCreateFolder}
              onCreateMarkdown={onCreateMarkdown}
              onCreateSlides={onCreateSlides}
              onContextMenu={openContextMenu}
              onDeleteGroup={onDeleteNotebookGroup}
              onDeleteNotebook={onDeleteNotebook}
              onDownloadNotebook={onDownloadNotebook}
              onDropFile={dropFileOnPath}
              onEditGroup={onEditNotebookGroup}
              onEditNotebook={onEditNotebook}
              onOpenFile={onOpenFile}
              onSelectNotebook={onSelectNotebook}
              onShowMoreNodes={showMoreNodes}
              onSetDragOverPath={setDragOverPath}
              onSetDraggingFile={setDraggingFile}
              onStartUpload={onStartUpload}
              onToggleNotebook={onToggleNotebook}
              onUploadFiles={onUploadFiles}
              visibleNodeLimitForPath={visibleNodeLimitForPath}
            />
          ))}
        </div>
      </div>

      {deepSearchOpen ? (
        <DeepSearchDialog
          initialQuery={deepSearchQuery}
          onClose={() => setDeepSearchOpen(false)}
          onOpenFile={onOpenFile}
        />
      ) : null}
      {viewOptionsOpen ? (
        <NotebookViewOptionsDialog
          error={viewOptionsError}
          submitting={viewOptionsSubmitting}
          tree={tree}
          onClose={() => setViewOptionsOpen(false)}
          onSubmit={(viewOptions) => void saveViewOptions(viewOptions)}
        />
      ) : null}
    </div>
  );
}

function StarredFilesSection({
  activeTabId,
  dragOverPath,
  draggingFile,
  expanded,
  files,
  starredFilePaths,
  onContextMenu,
  onDropFile,
  onOpenFile,
  onShowMore,
  onSetDragOverPath,
  onSetDraggingFile,
  onUploadFiles,
  visibleLimit,
}: {
  activeTabId: string;
  dragOverPath: string;
  draggingFile: LiberaFileNode | null;
  expanded: Set<string>;
  files: LiberaFileNode[];
  starredFilePaths: Set<string>;
  onContextMenu: (event: MouseEvent, target: SidebarMenuTarget) => void;
  onDropFile: (destinationPath: string) => Promise<void>;
  onOpenFile: (file: LiberaFileNode) => Promise<void>;
  onShowMore: () => void;
  onSetDragOverPath: (path: string) => void;
  onSetDraggingFile: (file: LiberaFileNode | null) => void;
  onUploadFiles: (
    notebook: string,
    files: File[],
    destinationPath?: string,
  ) => Promise<void>;
  visibleLimit: number;
}) {
  if (!files.length) {
    return null;
  }

  const visibleFiles = files.slice(0, visibleLimit);
  const remainingCount = files.length - visibleFiles.length;

  return (
    <section className="space-y-1 pb-2">
      <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Starred
      </h3>
      <div className="space-y-1">
        {visibleFiles.map((file) => (
          <TreeNodeRow
            key={file.path}
            activeTabId={activeTabId}
            depth={0}
            dragOverPath={dragOverPath}
            draggingFile={draggingFile}
            expanded={expanded}
            node={file}
            parentPath={parentPathForSidebarFile(file)}
            showNotebookName
            starredFilePaths={starredFilePaths}
            onContextMenu={onContextMenu}
            onDropFile={onDropFile}
            onOpenFile={onOpenFile}
            onShowMoreNodes={() => undefined}
            onSetDragOverPath={onSetDragOverPath}
            onSetDraggingFile={onSetDraggingFile}
            onTogglePath={() => undefined}
            onUploadFiles={onUploadFiles}
            visibleNodeLimitForPath={() => SIDEBAR_PAGE_SIZE}
          />
        ))}
        {remainingCount > 0 ? (
          <ShowMoreNodesButton
            depth={0}
            remainingCount={remainingCount}
            onClick={onShowMore}
          />
        ) : null}
      </div>
    </section>
  );
}

function ShowMoreNodesButton({
  depth,
  remainingCount,
  onClick,
}: {
  depth: number;
  remainingCount: number;
  onClick: () => void;
}) {
  return (
    <button
      className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs font-medium text-accent hover:bg-muted"
      style={{ paddingLeft: `${8 + depth * 16}px` }}
      type="button"
      onClick={onClick}
    >
      Show more... ({Math.min(SIDEBAR_PAGE_SIZE, remainingCount)} more)
    </button>
  );
}

function NotebookSection({
  activeTabId,
  dragOverPath,
  draggingFile,
  expanded,
  isExpanded,
  isSelected,
  notebook,
  showArchive,
  starredFilePaths,
  onArchiveVisibilityToggle,
  onCreateFolder,
  onCreateMarkdown,
  onCreateSlides,
  onContextMenu,
  onDeleteNotebook,
  onDropFile,
  onDownloadNotebook,
  onEditNotebook,
  onOpenFile,
  onSelectNotebook,
  onShowMoreNodes,
  onSetDragOverPath,
  onSetDraggingFile,
  onStartUpload,
  onToggleNotebook,
  onUploadFiles,
  visibleNodeLimitForPath,
}: {
  activeTabId: string;
  dragOverPath: string;
  draggingFile: LiberaFileNode | null;
  expanded: Set<string>;
  isExpanded: boolean;
  isSelected: boolean;
  notebook: LiberaTree["notebooks"][number];
  showArchive: boolean;
  starredFilePaths: Set<string>;
  onArchiveVisibilityToggle: () => Promise<void>;
  onCreateFolder: (parentPath: string) => Promise<void>;
  onCreateMarkdown: (notebook: string, parentPath?: string) => Promise<void>;
  onCreateSlides: (notebook: string) => Promise<void>;
  onContextMenu: (event: MouseEvent, target: SidebarMenuTarget) => void;
  onDeleteNotebook: (notebook: string) => Promise<void>;
  onDropFile: (destinationPath: string) => Promise<void>;
  onDownloadNotebook: (notebook: string) => void;
  onEditNotebook: (notebook: LiberaNotebookNode) => void;
  onOpenFile: (file: LiberaFileNode) => Promise<void>;
  onSelectNotebook: (notebook: string) => void;
  onShowMoreNodes: (path: string) => void;
  onSetDragOverPath: (path: string) => void;
  onSetDraggingFile: (file: LiberaFileNode | null) => void;
  onStartUpload: (notebook: string) => void;
  onToggleNotebook: (notebook: string) => void;
  onUploadFiles: (
    notebook: string,
    files: File[],
    destinationPath?: string,
  ) => Promise<void>;
  visibleNodeLimitForPath: (path: string) => number;
}) {
  const isDragTarget = draggingFile && dragOverPath === notebook.path;
  const isUploadTarget = !draggingFile && dragOverPath === notebook.path;
  const visibleChildren = notebook.children.slice(
    0,
    visibleNodeLimitForPath(notebook.path),
  );
  const remainingChildrenCount = notebook.children.length - visibleChildren.length;

  async function openNotebookActionsAtPoint(point: NativeMenuPoint) {
    const selectedItemId = await showNativeMenu(
      [
        { id: "new-note", label: "New note" },
        { id: "new-slides", label: "New slides" },
        { id: "new-folder", label: "New folder" },
        { id: "upload", label: "Upload" },
        { type: "separator" },
        {
          id: "show-archive",
          label: "Show Archive",
          type: "checkbox",
          checked: showArchive,
        },
        { type: "separator" },
        { id: "edit", label: "Edit" },
        { id: "download", label: "Download" },
        {
          id: "reveal-in-file-explorer",
          label: "Reveal in File Explorer",
          enabled: Boolean(window.liberaFileExplorer),
        },
        { type: "separator" },
        { id: "delete", label: "Delete" },
      ],
      point,
    );

    if (!selectedItemId) {
      return;
    }

    if (selectedItemId === "new-note") {
      await onCreateMarkdown(notebook.name);
    } else if (selectedItemId === "new-slides") {
      await onCreateSlides(notebook.name);
    } else if (selectedItemId === "new-folder") {
      await onCreateFolder(notebook.path);
    } else if (selectedItemId === "upload") {
      onStartUpload(notebook.name);
    } else if (selectedItemId === "show-archive") {
      await onArchiveVisibilityToggle();
    } else if (selectedItemId === "edit") {
      onEditNotebook(notebook);
    } else if (selectedItemId === "download") {
      onDownloadNotebook(notebook.name);
    } else if (selectedItemId === "reveal-in-file-explorer") {
      await revealNotebookInFileExplorer(notebook.name);
    } else if (selectedItemId === "delete") {
      await onDeleteNotebook(notebook.name);
    }
  }

  function openNotebookActionsMenu(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    void openNotebookActionsAtPoint(nativeMenuPointFromButton(event.currentTarget));
  }

  function openNotebookContextMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    void openNotebookActionsAtPoint(nativeMenuPointFromMouseEvent(event));
  }

  return (
    <section
      className={`libera-glass-card rounded-lg border border-border transition-shadow ${
        isSelected || isUploadTarget ? "shadow-md" : ""
      }`}
      onDragOver={(event) => {
        if (draggingFile || !hasExternalFiles(event.dataTransfer)) {
          return;
        }

        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        onSetDragOverPath(notebook.path);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onSetDragOverPath("");
        }
      }}
      onDrop={(event) => {
        if (draggingFile || !hasExternalFiles(event.dataTransfer)) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        onSetDragOverPath("");
        void onUploadFiles(notebook.name, Array.from(event.dataTransfer.files));
      }}
    >
      <div
        className={`flex items-center gap-2 border-b border-border px-2 py-2 ${
          isDragTarget || isUploadTarget || isSelected ? "bg-accent/8" : ""
        }`}
        onContextMenu={openNotebookContextMenu}
        onDragOver={(event) => {
          if (!draggingFile) {
            return;
          }

          event.preventDefault();
          onSetDragOverPath(notebook.path);
        }}
        onDragLeave={() => onSetDragOverPath("")}
        onDrop={(event) => {
          event.preventDefault();
          onDropFile(notebook.path);
        }}
      >
        <button
          className="libera-sidebar-icon-button h-7 w-7 rounded text-sm"
          type="button"
          onClick={() => onToggleNotebook(notebook.name)}
        >
          {isExpanded ? (
            <ChevronDown aria-hidden className="mx-auto h-4 w-4" />
          ) : (
            <ChevronRight aria-hidden className="mx-auto h-4 w-4" />
          )}
        </button>
        <button
          className="flex min-w-0 flex-1 items-center gap-2 truncate text-left text-sm font-medium"
          type="button"
          onClick={() => onSelectNotebook(notebook.name)}
        >
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sm"
            style={{ backgroundColor: notebook.color, color: "#ffffff" }}
          >
            {notebook.emoji}
          </span>
          <span className="min-w-0">
            <span className="block truncate">{notebook.name}</span>
            <span className="block truncate text-xs font-normal text-muted-foreground">
              Created {new Date(notebook.createdAt).toLocaleDateString()}
            </span>
          </span>
        </button>
        <button
          aria-haspopup="menu"
          aria-label={`Notebook actions for ${notebook.name}`}
          className="libera-sidebar-icon-button inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
          title="Notebook actions"
          type="button"
          onClick={openNotebookActionsMenu}
        >
          <MoreHorizontal aria-hidden className="h-4 w-4" />
        </button>
      </div>
      {isExpanded ? (
        <div
          className={`px-2 py-2 ${isDragTarget ? "bg-accent/10/60" : ""}`}
          onDragOver={(event) =>
            handleFileDragOverDirectory(
              event,
              draggingFile,
              notebook.path,
              onSetDragOverPath,
            )
          }
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              onSetDragOverPath("");
            }
          }}
          onDrop={(event) =>
            handleFileDropOnDirectory(event, draggingFile, notebook.path, onDropFile)
          }
        >
          <div className="space-y-1">
            {visibleChildren.map((node) => (
              <TreeNodeRow
                key={node.path}
                activeTabId={activeTabId}
                depth={0}
                dragOverPath={dragOverPath}
                draggingFile={draggingFile}
                expanded={expanded}
                node={node}
                starredFilePaths={starredFilePaths}
                onContextMenu={onContextMenu}
                onDropFile={onDropFile}
                onOpenFile={onOpenFile}
                onShowMoreNodes={onShowMoreNodes}
                onSetDragOverPath={onSetDragOverPath}
                onSetDraggingFile={onSetDraggingFile}
                onTogglePath={onToggleNotebook}
                onUploadFiles={onUploadFiles}
                parentPath={notebook.path}
                visibleNodeLimitForPath={visibleNodeLimitForPath}
              />
            ))}
            {remainingChildrenCount > 0 ? (
              <ShowMoreNodesButton
                depth={0}
                remainingCount={remainingChildrenCount}
                onClick={() => onShowMoreNodes(notebook.path)}
              />
            ) : null}
            {!notebook.children.length ? (
              <p className="px-2 py-2 text-sm text-muted-foreground">No files.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function NotebookGroupSection({
  activeTabId,
  dragOverPath,
  draggingFile,
  expanded,
  group,
  notebooks,
  selectedNotebookName,
  showArchive,
  starredFilePaths,
  onArchiveVisibilityToggle,
  onCreateFolder,
  onCreateMarkdown,
  onCreateSlides,
  onContextMenu,
  onDeleteGroup,
  onDeleteNotebook,
  onDownloadNotebook,
  onDropFile,
  onEditGroup,
  onEditNotebook,
  onOpenFile,
  onSelectNotebook,
  onShowMoreNodes,
  onSetDragOverPath,
  onSetDraggingFile,
  onStartUpload,
  onToggleNotebook,
  onUploadFiles,
  visibleNodeLimitForPath,
}: {
  activeTabId: string;
  dragOverPath: string;
  draggingFile: LiberaFileNode | null;
  expanded: Set<string>;
  group: LiberaNotebookGroup;
  notebooks: LiberaNotebookNode[];
  selectedNotebookName: string;
  showArchive: boolean;
  starredFilePaths: Set<string>;
  onArchiveVisibilityToggle: () => Promise<void>;
  onCreateFolder: (parentPath: string) => Promise<void>;
  onCreateMarkdown: (notebook: string, parentPath?: string) => Promise<void>;
  onCreateSlides: (notebook: string) => Promise<void>;
  onContextMenu: (event: MouseEvent, target: SidebarMenuTarget) => void;
  onDeleteGroup: (group: LiberaNotebookGroup) => Promise<void>;
  onDeleteNotebook: (notebook: string) => Promise<void>;
  onDownloadNotebook: (notebook: string) => void;
  onDropFile: (destinationPath: string) => Promise<void>;
  onEditGroup: (group: LiberaNotebookGroup) => void;
  onEditNotebook: (notebook: LiberaNotebookNode) => void;
  onOpenFile: (file: LiberaFileNode) => Promise<void>;
  onSelectNotebook: (notebook: string) => void;
  onShowMoreNodes: (path: string) => void;
  onSetDragOverPath: (path: string) => void;
  onSetDraggingFile: (file: LiberaFileNode | null) => void;
  onStartUpload: (notebook: string) => void;
  onToggleNotebook: (notebook: string) => void;
  onUploadFiles: (
    notebook: string,
    files: File[],
    destinationPath?: string,
  ) => Promise<void>;
  visibleNodeLimitForPath: (path: string) => number;
}) {
  return (
    <section className="space-y-2 pt-2">
      <div className="flex items-start justify-between gap-3 px-1">
        <div className="min-w-0">
          <h3 className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {group.title}
          </h3>
          {group.description ? (
            <p className="mt-0.5 max-h-10 overflow-hidden text-xs leading-5 text-muted-foreground">
              {group.description}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            aria-label={`Edit ${group.title}`}
            className="libera-sidebar-icon-button inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground"
            title="Edit group"
            type="button"
            onClick={() => onEditGroup(group)}
          >
            <Pencil aria-hidden className="h-3.5 w-3.5" />
          </button>
          <button
            aria-label={`Delete ${group.title}`}
            className="libera-sidebar-icon-button inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground"
            data-tone="destructive"
            title="Delete group"
            type="button"
            onClick={() => void onDeleteGroup(group)}
          >
            <Trash2 aria-hidden className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {notebooks.length ? (
        <div className="space-y-2">
          {notebooks.map((notebook) => (
            <NotebookSection
              key={notebook.name}
              activeTabId={activeTabId}
              dragOverPath={dragOverPath}
              draggingFile={draggingFile}
              expanded={expanded}
              isExpanded={expanded.has(notebook.name)}
              isSelected={selectedNotebookName === notebook.name}
              notebook={notebook}
              showArchive={showArchive}
              starredFilePaths={starredFilePaths}
              onArchiveVisibilityToggle={onArchiveVisibilityToggle}
              onCreateFolder={onCreateFolder}
              onCreateMarkdown={onCreateMarkdown}
              onCreateSlides={onCreateSlides}
              onContextMenu={onContextMenu}
              onDeleteNotebook={onDeleteNotebook}
              onDownloadNotebook={onDownloadNotebook}
              onDropFile={onDropFile}
              onEditNotebook={onEditNotebook}
              onOpenFile={onOpenFile}
              onSelectNotebook={onSelectNotebook}
              onShowMoreNodes={onShowMoreNodes}
              onSetDragOverPath={onSetDragOverPath}
              onSetDraggingFile={onSetDraggingFile}
              onStartUpload={onStartUpload}
              onToggleNotebook={onToggleNotebook}
              onUploadFiles={onUploadFiles}
              visibleNodeLimitForPath={visibleNodeLimitForPath}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-input px-4 py-3 text-sm text-muted-foreground">
          No notebooks in this group.
        </div>
      )}
    </section>
  );
}

function TreeNodeRow({
  activeTabId,
  depth,
  dragOverPath,
  draggingFile,
  expanded,
  node,
  onContextMenu,
  onDropFile,
  onOpenFile,
  onShowMoreNodes,
  onSetDragOverPath,
  onSetDraggingFile,
  onTogglePath,
  onUploadFiles,
  parentPath,
  showNotebookName = false,
  starredFilePaths,
  visibleNodeLimitForPath,
}: {
  activeTabId: string;
  depth: number;
  dragOverPath: string;
  draggingFile: LiberaFileNode | null;
  expanded: Set<string>;
  node: LiberaTreeNode;
  starredFilePaths: Set<string>;
  onContextMenu: (event: MouseEvent, target: SidebarMenuTarget) => void;
  onDropFile: (destinationPath: string) => Promise<void>;
  onOpenFile: (file: LiberaFileNode) => Promise<void>;
  onShowMoreNodes: (path: string) => void;
  onSetDragOverPath: (path: string) => void;
  onSetDraggingFile: (file: LiberaFileNode | null) => void;
  onTogglePath: (path: string) => void;
  onUploadFiles: (
    notebook: string,
    files: File[],
    destinationPath?: string,
  ) => Promise<void>;
  parentPath: string;
  showNotebookName?: boolean;
  visibleNodeLimitForPath: (path: string) => number;
}) {
  if (node.kind === "folder") {
    const isExpanded = expanded.has(node.path);
    const isDragTarget = draggingFile && dragOverPath === node.path;
    const isUploadTarget = !draggingFile && dragOverPath === node.path;
    const visibleChildren = node.children.slice(0, visibleNodeLimitForPath(node.path));
    const remainingChildrenCount = node.children.length - visibleChildren.length;

    return (
      <div>
        <button
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${
            isDragTarget || isUploadTarget ? "bg-accent/10 ring-1 ring-accent" : ""
          }`}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
          type="button"
          onClick={() => onTogglePath(node.path)}
          onContextMenu={(event) => onContextMenu(event, { kind: "folder", folder: node })}
          onDragOver={(event) => {
            if (!draggingFile && !hasExternalFiles(event.dataTransfer)) {
              return;
            }

            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = draggingFile ? "move" : "copy";
            onSetDragOverPath(node.path);
          }}
          onDragLeave={() => onSetDragOverPath("")}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();

            if (!draggingFile && hasExternalFiles(event.dataTransfer)) {
              onSetDragOverPath("");
              void onUploadFiles(
                node.notebook,
                Array.from(event.dataTransfer.files),
                node.path,
              );
              return;
            }

            onDropFile(node.path);
          }}
        >
          {isExpanded ? (
            <ChevronDown aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <Folder aria-hidden className="h-4 w-4 shrink-0 text-accent" />
          <span className="min-w-0 truncate">{node.name}</span>
        </button>

        {isExpanded ? (
          <div
            className={`mt-1 space-y-1 ${isDragTarget ? "bg-accent/10/50" : ""}`}
            onDragOver={(event) =>
              handleFileDragOverDirectory(
                event,
                draggingFile,
                node.path,
                onSetDragOverPath,
              )
            }
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                onSetDragOverPath("");
              }
            }}
            onDrop={(event) =>
              handleFileDropOnDirectory(event, draggingFile, node.path, onDropFile)
            }
          >
            {visibleChildren.map((child) => (
              <TreeNodeRow
                key={child.path}
                activeTabId={activeTabId}
                depth={depth + 1}
                dragOverPath={dragOverPath}
                draggingFile={draggingFile}
                expanded={expanded}
                node={child}
                showNotebookName={showNotebookName}
                starredFilePaths={starredFilePaths}
                onContextMenu={onContextMenu}
                onDropFile={onDropFile}
                onOpenFile={onOpenFile}
                onShowMoreNodes={onShowMoreNodes}
                onSetDragOverPath={onSetDragOverPath}
                onSetDraggingFile={onSetDraggingFile}
                onTogglePath={onTogglePath}
                onUploadFiles={onUploadFiles}
                parentPath={node.path}
                visibleNodeLimitForPath={visibleNodeLimitForPath}
              />
            ))}
            {remainingChildrenCount > 0 ? (
              <ShowMoreNodesButton
                depth={depth + 1}
                remainingCount={remainingChildrenCount}
                onClick={() => onShowMoreNodes(node.path)}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  const isStarred = starredFilePaths.has(node.path);

  return (
    <button
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${
        activeTabId === node.path ? "bg-muted" : ""
      }`}
      draggable
      style={{ paddingLeft: `${8 + depth * 16}px` }}
      type="button"
      onClick={() => onOpenFile(node)}
      onContextMenu={(event) => onContextMenu(event, { kind: "file", file: node })}
      onDragOver={(event) =>
        handleFileDragOverDirectory(
          event,
          draggingFile,
          parentPath,
          onSetDragOverPath,
        )
      }
      onDragLeave={() => onSetDragOverPath("")}
      onDrop={(event) =>
        handleFileDropOnDirectory(event, draggingFile, parentPath, onDropFile)
      }
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-libera-file-path", node.path);
        onSetDraggingFile(node);
      }}
      onDragEnd={() => {
        onSetDraggingFile(null);
        onSetDragOverPath("");
      }}
    >
      <span className="w-9 shrink-0 rounded bg-muted px-1.5 py-0.5 text-center text-[10px] font-semibold text-foreground">
        {fileTypeLabel(node.fileType)}
      </span>
      <FileTypeIcon fileType={node.fileType} />
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      {showNotebookName ? (
        <span className="max-w-20 shrink-0 truncate text-[11px] text-muted-foreground">
          {node.notebook}
        </span>
      ) : null}
      {isStarred ? (
        <Star
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-500"
        />
      ) : null}
    </button>
  );
}

function NotebookViewOptionsDialog({
  error,
  submitting,
  tree,
  onClose,
  onSubmit,
}: {
  error: string;
  submitting: boolean;
  tree: LiberaTree;
  onClose: () => void;
  onSubmit: (viewOptions: LiberaNotebookViewOptions) => void;
}) {
  const [hiddenGroupIds, setHiddenGroupIds] = useState(
    () => new Set(tree.notebookViewOptions.hiddenGroupIds),
  );
  const [hiddenNotebookNames, setHiddenNotebookNames] = useState(
    () => new Set(tree.notebookViewOptions.hiddenNotebookNames),
  );
  const groupsById = new Map(tree.notebookGroups.map((group) => [group.id, group]));
  const topLevelNotebooks = tree.notebooks
    .filter((notebook) => !notebook.groupId || !groupsById.has(notebook.groupId))
    .sort((left, right) => left.name.localeCompare(right.name));
  const groupedSections = [...tree.notebookGroups]
    .sort((left, right) => left.title.localeCompare(right.title))
    .map((group) => ({
      group,
      notebooks: tree.notebooks
        .filter((notebook) => notebook.groupId === group.id)
        .sort((left, right) => left.name.localeCompare(right.name)),
    }));

  function groupNotebookNames(groupId: string) {
    return tree.notebooks
      .filter((notebook) => notebook.groupId === groupId)
      .map((notebook) => notebook.name);
  }

  function toggleGroup(groupId: string) {
    setHiddenGroupIds((current) => {
      const next = new Set(current);

      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }

      return next;
    });
    setHiddenNotebookNames((current) => {
      const next = new Set(current);

      for (const notebookName of groupNotebookNames(groupId)) {
        next.delete(notebookName);
      }

      return next;
    });
  }

  function toggleNotebook(notebookName: string) {
    setHiddenNotebookNames((current) => {
      const next = new Set(current);

      if (next.has(notebookName)) {
        next.delete(notebookName);
      } else {
        next.add(notebookName);
      }

      return next;
    });
  }

  function submitViewOptions() {
    onSubmit({
      hiddenGroupIds: [...hiddenGroupIds],
      hiddenNotebookNames: [...hiddenNotebookNames],
      showArchive: tree.notebookViewOptions.showArchive,
    });
  }

  return (
    <ModalDialog
      open
      title="View Options"
      description="Choose which notebooks and groups appear in the Notebook panel."
      panelClassName="max-w-lg"
      onClose={onClose}
      footer={
        <>
          <button
            className="rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted"
            type="button"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            disabled={submitting}
            onClick={submitViewOptions}
          >
            {submitting ? "Saving" : "Save options"}
          </button>
        </>
      }
    >
      <div className="max-h-[60vh] space-y-4 overflow-auto pr-1">
        {topLevelNotebooks.length ? (
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Notebooks
            </h3>
            <div className="rounded-lg border border-border">
              {topLevelNotebooks.map((notebook) => (
                <NotebookViewOptionRow
                  key={notebook.name}
                  checked={!hiddenNotebookNames.has(notebook.name)}
                  label={notebook.name}
                  swatchColor={notebook.color}
                  swatchText={notebook.emoji}
                  onChange={() => toggleNotebook(notebook.name)}
                />
              ))}
            </div>
          </div>
        ) : null}

        {groupedSections.map(({ group, notebooks }) => {
          const groupChecked = !hiddenGroupIds.has(group.id);

          return (
            <div key={group.id}>
              <label className="mb-2 flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2 hover:bg-muted">
                <input
                  className="mt-0.5 h-4 w-4 rounded border-input"
                  type="checkbox"
                  checked={groupChecked}
                  onChange={() => toggleGroup(group.id)}
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{group.title}</span>
                  {group.description ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {group.description}
                    </span>
                  ) : null}
                </span>
              </label>
              {notebooks.length ? (
                <div className="ml-6 rounded-lg border border-border">
                  {notebooks.map((notebook) => (
                    <NotebookViewOptionRow
                      key={notebook.name}
                      checked={groupChecked && !hiddenNotebookNames.has(notebook.name)}
                      disabled={!groupChecked}
                      label={notebook.name}
                      swatchColor={notebook.color}
                      swatchText={notebook.emoji}
                      onChange={() => toggleNotebook(notebook.name)}
                    />
                  ))}
                </div>
              ) : (
                <div className="ml-6 rounded-lg border border-dashed border-input px-4 py-3 text-sm text-muted-foreground">
                  No notebooks in this group.
                </div>
              )}
            </div>
          );
        })}

        {!topLevelNotebooks.length && !groupedSections.length ? (
          <div className="rounded-lg border border-dashed border-input px-4 py-8 text-center text-sm text-muted-foreground">
            No notebooks or groups are available.
          </div>
        ) : null}
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
    </ModalDialog>
  );
}

function NotebookViewOptionRow({
  checked,
  disabled,
  label,
  swatchColor,
  swatchText,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  swatchColor: string;
  swatchText: string;
  onChange: () => void;
}) {
  return (
    <label
      className={`flex items-center gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0 ${
        disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer hover:bg-muted"
      }`}
    >
      <input
        className="h-4 w-4 rounded border-input"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-xs"
        style={{ backgroundColor: swatchColor, color: "#ffffff" }}
      >
        {swatchText}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </label>
  );
}
