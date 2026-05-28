"use client";

import { useEffect, useState } from "react";
import type { MouseEvent, ReactNode, RefObject } from "react";
import {
  BookPlus,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FilePlus2,
  Folder,
  FolderPlus,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react";
import { FileTypeIcon, fileTypeLabel } from "@/components/libera/file-type";
import type {
  LiberaFileNode,
  LiberaFolderNode,
  LiberaNotebookNode,
  LiberaTree,
  LiberaTreeNode,
} from "@/lib/types";

type SidebarMenuTarget =
  | { kind: "file"; file: LiberaFileNode }
  | { kind: "folder"; folder: LiberaFolderNode };

type NotebookSidebarProps = {
  activeTabId: string;
  expanded: Set<string>;
  tree: LiberaTree;
  uploadInputRef: RefObject<HTMLInputElement | null>;
  onCopyFile: (file: LiberaFileNode) => Promise<void>;
  onCreateFolder: (parentPath: string) => Promise<void>;
  onCreateMarkdown: (notebook: string) => Promise<void>;
  onCreateNotebook: () => void;
  onDeleteNotebook: (notebook: string) => Promise<void>;
  onDeleteFile: (file: LiberaFileNode) => Promise<void>;
  onDeleteFolder: (folder: LiberaFolderNode) => Promise<void>;
  onDownloadNotebook: (notebook: string) => void;
  onEditNotebook: (notebook: LiberaNotebookNode) => void;
  onMoveFile: (file: LiberaFileNode, destinationPath: string) => Promise<void>;
  onOpenFile: (file: LiberaFileNode) => Promise<void>;
  onRenameFolder: (folder: LiberaFolderNode) => Promise<void>;
  onRenameFile: (file: LiberaFileNode) => Promise<void>;
  onStartUpload: (notebook: string) => void;
  onToggleNotebook: (notebook: string) => void;
  onUploadChange: () => Promise<void>;
};

export function NotebookSidebar({
  activeTabId,
  expanded,
  tree,
  uploadInputRef,
  onCopyFile,
  onCreateFolder,
  onCreateMarkdown,
  onCreateNotebook,
  onDeleteFile,
  onDeleteFolder,
  onDeleteNotebook,
  onDownloadNotebook,
  onEditNotebook,
  onMoveFile,
  onOpenFile,
  onRenameFolder,
  onRenameFile,
  onStartUpload,
  onToggleNotebook,
  onUploadChange,
}: NotebookSidebarProps) {
  const [contextMenu, setContextMenu] = useState<{
    target: SidebarMenuTarget;
    x: number;
    y: number;
  } | null>(null);
  const [draggingFile, setDraggingFile] = useState<LiberaFileNode | null>(null);
  const [dragOverPath, setDragOverPath] = useState("");

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    function closeMenu() {
      setContextMenu(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    }

    window.addEventListener("click", closeMenu);
    window.addEventListener("contextmenu", closeMenu);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);

    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("contextmenu", closeMenu);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [contextMenu]);

  function openContextMenu(event: MouseEvent, target: SidebarMenuTarget) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      target,
      x: event.clientX,
      y: event.clientY,
    });
  }

  async function dropFileOnPath(destinationPath: string) {
    if (!draggingFile) {
      return;
    }

    await onMoveFile(draggingFile, destinationPath);
    setDraggingFile(null);
    setDragOverPath("");
  }

  return (
    <aside className="border-b border-zinc-200 bg-white lg:border-b-0 lg:border-r">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Notebooks
        </h2>
        <button
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs font-medium hover:bg-zinc-50"
          type="button"
          onClick={onCreateNotebook}
        >
          <BookPlus aria-hidden className="h-3.5 w-3.5" />
          New
        </button>
      </div>

      <input
        ref={uploadInputRef}
        className="hidden"
        type="file"
        multiple
        accept=".md,.markdown,.png,.jpg,.jpeg,.gif,.webp,.pdf"
        onChange={onUploadChange}
      />

      <div className="max-h-[40vh] overflow-auto px-3 py-3 lg:max-h-[calc(100vh-116px)]">
        {!tree.notebooks.length ? (
          <div className="rounded-md border border-dashed border-zinc-300 p-4 text-sm text-zinc-500">
            No notebooks yet.
          </div>
        ) : null}

        <div className="space-y-2">
          {tree.notebooks.map((notebook) => (
            <NotebookSection
              key={notebook.name}
              activeTabId={activeTabId}
              dragOverPath={dragOverPath}
              draggingFile={draggingFile}
              expanded={expanded}
              isExpanded={expanded.has(notebook.name)}
              notebook={notebook}
              onCreateFolder={onCreateFolder}
              onCreateMarkdown={onCreateMarkdown}
              onContextMenu={openContextMenu}
              onDeleteNotebook={onDeleteNotebook}
              onDropFile={dropFileOnPath}
              onDownloadNotebook={onDownloadNotebook}
              onEditNotebook={onEditNotebook}
              onOpenFile={onOpenFile}
              onSetDragOverPath={setDragOverPath}
              onSetDraggingFile={setDraggingFile}
              onStartUpload={onStartUpload}
              onToggleNotebook={onToggleNotebook}
            />
          ))}
        </div>
      </div>

      {contextMenu ? (
        <SidebarContextMenu
          target={contextMenu.target}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onCopyFile={onCopyFile}
          onCreateFolder={onCreateFolder}
          onDelete={onDeleteFile}
          onDeleteFolder={onDeleteFolder}
          onRenameFolder={onRenameFolder}
          onRename={onRenameFile}
        />
      ) : null}
    </aside>
  );
}

function NotebookSection({
  activeTabId,
  dragOverPath,
  draggingFile,
  expanded,
  isExpanded,
  notebook,
  onCreateFolder,
  onCreateMarkdown,
  onContextMenu,
  onDeleteNotebook,
  onDropFile,
  onDownloadNotebook,
  onEditNotebook,
  onOpenFile,
  onSetDragOverPath,
  onSetDraggingFile,
  onStartUpload,
  onToggleNotebook,
}: {
  activeTabId: string;
  dragOverPath: string;
  draggingFile: LiberaFileNode | null;
  expanded: Set<string>;
  isExpanded: boolean;
  notebook: LiberaTree["notebooks"][number];
  onCreateFolder: (parentPath: string) => Promise<void>;
  onCreateMarkdown: (notebook: string) => Promise<void>;
  onContextMenu: (event: MouseEvent, target: SidebarMenuTarget) => void;
  onDeleteNotebook: (notebook: string) => Promise<void>;
  onDropFile: (destinationPath: string) => Promise<void>;
  onDownloadNotebook: (notebook: string) => void;
  onEditNotebook: (notebook: LiberaNotebookNode) => void;
  onOpenFile: (file: LiberaFileNode) => Promise<void>;
  onSetDragOverPath: (path: string) => void;
  onSetDraggingFile: (file: LiberaFileNode | null) => void;
  onStartUpload: (notebook: string) => void;
  onToggleNotebook: (notebook: string) => void;
}) {
  const isDragTarget = draggingFile && dragOverPath === notebook.path;

  return (
    <section className="rounded-md border border-zinc-200">
      <div
        className={`flex items-center gap-2 border-b px-2 py-2 ${
          isDragTarget ? "border-teal-300 bg-teal-50" : "border-zinc-100"
        }`}
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
          className="h-7 w-7 rounded text-sm hover:bg-zinc-100"
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
          onClick={() => onToggleNotebook(notebook.name)}
        >
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sm"
            style={{ backgroundColor: notebook.color, color: "#ffffff" }}
          >
            {notebook.emoji}
          </span>
          <span className="min-w-0">
            <span className="block truncate">{notebook.name}</span>
            <span className="block truncate text-xs font-normal text-zinc-500">
              Created {new Date(notebook.createdAt).toLocaleDateString()}
            </span>
          </span>
        </button>
      </div>
      {isExpanded ? (
        <div className="px-2 py-2">
          <div className="mb-2 flex flex-wrap gap-1.5">
            <NotebookActionButton onClick={() => onCreateMarkdown(notebook.name)}>
              <FilePlus2 aria-hidden className="h-3.5 w-3.5" />
              New note
            </NotebookActionButton>
            <NotebookActionButton onClick={() => onCreateFolder(notebook.path)}>
              <FolderPlus aria-hidden className="h-3.5 w-3.5" />
              New folder
            </NotebookActionButton>
            <NotebookActionButton onClick={() => onStartUpload(notebook.name)}>
              <Upload aria-hidden className="h-3.5 w-3.5" />
              Upload
            </NotebookActionButton>
            <NotebookActionButton onClick={() => onEditNotebook(notebook)}>
              <Pencil aria-hidden className="h-3.5 w-3.5" />
              Edit
            </NotebookActionButton>
            <NotebookActionButton onClick={() => onDownloadNotebook(notebook.name)}>
              <Download aria-hidden className="h-3.5 w-3.5" />
              Download
            </NotebookActionButton>
            <button
              className="inline-flex items-center gap-1.5 rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
              type="button"
              onClick={() => onDeleteNotebook(notebook.name)}
            >
              <Trash2 aria-hidden className="h-3.5 w-3.5" />
              Delete
            </button>
          </div>

          <div className="space-y-1">
            {notebook.children.map((node) => (
              <TreeNodeRow
                key={node.path}
                activeTabId={activeTabId}
                depth={0}
                dragOverPath={dragOverPath}
                draggingFile={draggingFile}
                expanded={expanded}
                node={node}
                onContextMenu={onContextMenu}
                onDropFile={onDropFile}
                onOpenFile={onOpenFile}
                onSetDragOverPath={onSetDragOverPath}
                onSetDraggingFile={onSetDraggingFile}
                onTogglePath={onToggleNotebook}
              />
            ))}
            {!notebook.children.length ? (
              <p className="px-2 py-2 text-sm text-zinc-500">No files.</p>
            ) : null}
          </div>
        </div>
      ) : null}
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
  onSetDragOverPath,
  onSetDraggingFile,
  onTogglePath,
}: {
  activeTabId: string;
  depth: number;
  dragOverPath: string;
  draggingFile: LiberaFileNode | null;
  expanded: Set<string>;
  node: LiberaTreeNode;
  onContextMenu: (event: MouseEvent, target: SidebarMenuTarget) => void;
  onDropFile: (destinationPath: string) => Promise<void>;
  onOpenFile: (file: LiberaFileNode) => Promise<void>;
  onSetDragOverPath: (path: string) => void;
  onSetDraggingFile: (file: LiberaFileNode | null) => void;
  onTogglePath: (path: string) => void;
}) {
  if (node.kind === "folder") {
    const isExpanded = expanded.has(node.path);
    const isDragTarget = draggingFile && dragOverPath === node.path;

    return (
      <div>
        <button
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-zinc-100 ${
            isDragTarget ? "bg-teal-50 ring-1 ring-teal-300" : ""
          }`}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
          type="button"
          onClick={() => onTogglePath(node.path)}
          onContextMenu={(event) => onContextMenu(event, { kind: "folder", folder: node })}
          onDragOver={(event) => {
            if (!draggingFile) {
              return;
            }

            event.preventDefault();
            onSetDragOverPath(node.path);
          }}
          onDragLeave={() => onSetDragOverPath("")}
          onDrop={(event) => {
            event.preventDefault();
            onDropFile(node.path);
          }}
        >
          {isExpanded ? (
            <ChevronDown aria-hidden className="h-4 w-4 shrink-0 text-zinc-500" />
          ) : (
            <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-zinc-500" />
          )}
          <Folder aria-hidden className="h-4 w-4 shrink-0 text-teal-600" />
          <span className="min-w-0 truncate">{node.name}</span>
        </button>

        {isExpanded ? (
          <div className="mt-1 space-y-1">
            {node.children.map((child) => (
              <TreeNodeRow
                key={child.path}
                activeTabId={activeTabId}
                depth={depth + 1}
                dragOverPath={dragOverPath}
                draggingFile={draggingFile}
                expanded={expanded}
                node={child}
                onContextMenu={onContextMenu}
                onDropFile={onDropFile}
                onOpenFile={onOpenFile}
                onSetDragOverPath={onSetDragOverPath}
                onSetDraggingFile={onSetDraggingFile}
                onTogglePath={onTogglePath}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <button
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-zinc-100 ${
        activeTabId === node.path ? "bg-zinc-100" : ""
      }`}
      draggable
      style={{ paddingLeft: `${8 + depth * 16}px` }}
      type="button"
      onClick={() => onOpenFile(node)}
      onContextMenu={(event) => onContextMenu(event, { kind: "file", file: node })}
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
      <span className="w-9 shrink-0 rounded bg-zinc-200 px-1.5 py-0.5 text-center text-[10px] font-semibold text-zinc-700">
        {fileTypeLabel(node.fileType)}
      </span>
      <FileTypeIcon fileType={node.fileType} />
      <span className="min-w-0 truncate">{node.name}</span>
    </button>
  );
}

function SidebarContextMenu({
  target,
  x,
  y,
  onClose,
  onCopyFile,
  onCreateFolder,
  onDelete,
  onDeleteFolder,
  onRenameFolder,
  onRename,
}: {
  target: SidebarMenuTarget;
  x: number;
  y: number;
  onClose: () => void;
  onCopyFile: (file: LiberaFileNode) => Promise<void>;
  onCreateFolder: (parentPath: string) => Promise<void>;
  onDelete: (file: LiberaFileNode) => Promise<void>;
  onDeleteFolder: (folder: LiberaFolderNode) => Promise<void>;
  onRenameFolder: (folder: LiberaFolderNode) => Promise<void>;
  onRename: (file: LiberaFileNode) => Promise<void>;
}) {
  async function runAction(action: () => Promise<void>) {
    onClose();
    await action();
  }

  return (
    <div
      className="fixed z-50 min-w-40 overflow-hidden rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg"
      style={{ left: x, top: y }}
      role="menu"
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {target.kind === "file" ? (
        <>
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-100"
            type="button"
            role="menuitem"
            onClick={() => runAction(() => onCopyFile(target.file))}
          >
            <Copy aria-hidden className="h-4 w-4 text-zinc-500" />
            Copy
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-100"
            type="button"
            role="menuitem"
            onClick={() => runAction(() => onRename(target.file))}
          >
            <Pencil aria-hidden className="h-4 w-4 text-zinc-500" />
            Rename
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-700 hover:bg-red-50"
            type="button"
            role="menuitem"
            onClick={() => runAction(() => onDelete(target.file))}
          >
            <Trash2 aria-hidden className="h-4 w-4" />
            Delete
          </button>
        </>
      ) : (
        <>
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-100"
            type="button"
            role="menuitem"
            onClick={() => runAction(() => onCreateFolder(target.folder.path))}
          >
            <FolderPlus aria-hidden className="h-4 w-4 text-zinc-500" />
            New folder
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-100"
            type="button"
            role="menuitem"
            onClick={() => runAction(() => onRenameFolder(target.folder))}
          >
            <Pencil aria-hidden className="h-4 w-4 text-zinc-500" />
            Rename
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-700 hover:bg-red-50"
            type="button"
            role="menuitem"
            onClick={() => runAction(() => onDeleteFolder(target.folder))}
          >
            <Trash2 aria-hidden className="h-4 w-4" />
            Delete
          </button>
        </>
      )}
    </div>
  );
}

function NotebookActionButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className="inline-flex items-center gap-1.5 rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50"
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
