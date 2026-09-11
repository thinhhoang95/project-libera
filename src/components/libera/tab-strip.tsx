"use client";

import { ReviewToggle } from "./markdown-review-ui";
import { useState } from "react";
import type { MouseEvent } from "react";
import { Plus, Sparkles, Download, MoveRight, Pencil, Save, Trash2, X } from "lucide-react";
import type { MarkdownEditorMode, OpenTab } from "@/components/libera/types";
import { FileTypeIcon } from "./file-type";
import { WindowControls } from "@/components/libera/window-controls";
import { isMarkdownSlidesPath } from "@/lib/markdown-slides";

type TabStripProps = {
  chatOpen: boolean;
  onToggleChat: () => void;
  onCreateUntitled: () => void;
  markdownEditorMode: MarkdownEditorMode;
  onMarkdownEditorModeChange: (mode: MarkdownEditorMode) => void;
  activeTab?: OpenTab;
  activeTabId: string;
  notebookColors: Record<string, string>;
  tabs: OpenTab[];
  onActivateTab: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onDeleteFile: (tab: OpenTab) => Promise<void>;
  onDownloadFile: (file: OpenTab["file"], content?: string) => void;
  onDownloadMarkdownPdf: (tab: OpenTab) => Promise<void>;
  onMoveFile: (tab: OpenTab) => Promise<void>;
  onRenameFile: (tab: OpenTab) => Promise<void>;
  onSave: () => Promise<void>;
  onSwapTabs: (sourceTabId: string, targetTabId: string) => void;
};

type ActiveFileActionsProps = Pick<
  TabStripProps,
  | "activeTab"
  | "markdownEditorMode"
  | "onMarkdownEditorModeChange"
  | "onDeleteFile"
  | "onDownloadFile"
  | "onDownloadMarkdownPdf"
  | "onMoveFile"
  | "onRenameFile"
  | "onSave"
>;

function nativeMenuPointFromButton(button: HTMLElement) {
  const rect = button.getBoundingClientRect();

  return {
    x: Math.round(rect.left),
    y: Math.round(rect.bottom),
  };
}

function nativeMenuPointFromMouseEvent(event: MouseEvent<HTMLElement>) {
  return {
    x: Math.round(event.clientX),
    y: Math.round(event.clientY),
  };
}

export function TabStrip({
  chatOpen,
  onToggleChat,
  onCreateUntitled,
  markdownEditorMode,
  onMarkdownEditorModeChange,
  activeTab,
  activeTabId,
  tabs,
  onActivateTab,
  onCloseOtherTabs,
  onCloseTab,
  onDeleteFile,
  onDownloadFile,
  onDownloadMarkdownPdf,
  onMoveFile,
  onRenameFile,
  onSave,
  onSwapTabs,
}: TabStripProps) {
  const [draggingTabId, setDraggingTabId] = useState("");
  const [dragOverTabId, setDragOverTabId] = useState("");

  function clearDragState() {
    setDraggingTabId("");
    setDragOverTabId("");
  }

  async function openTabContextMenu(event: MouseEvent<HTMLButtonElement>, tab: OpenTab) {
    event.preventDefault();
    event.stopPropagation();

    const menu = window.liberaMenu;

    if (!menu) {
      return;
    }

    const selectedItemId = await menu
      .popup({
        ...nativeMenuPointFromMouseEvent(event),
        items: [
          { id: "close-tab", label: "Close Tab" },
          {
            id: "close-others",
            label: "Close Others",
            enabled: tabs.length > 1,
          },
        ],
      })
      .catch(() => null);

    if (selectedItemId === "close-tab") {
      onCloseTab(tab.id);
    } else if (selectedItemId === "close-others") {
      onCloseOtherTabs(tab.id);
    }
  }

  return (
    <div className="libera-tab-strip libera-window-drag-region border-b border-border bg-card">
      <div className="flex min-h-12 items-center gap-2 px-3 py-2">
        <button type="button" aria-label="New untitled file" title="New untitled file" onClick={onCreateUntitled} className="libera-window-no-drag-region rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"><Plus aria-hidden className="h-4 w-4" /></button>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((tab) => {
            const isActive = activeTabId === tab.id;
            const isDragging = draggingTabId === tab.id;
            const isDragTarget = dragOverTabId === tab.id && draggingTabId !== tab.id;
            const isDirty = tab.status === "dirty";

            return (
              <button
                key={tab.id}
                className={`libera-document-tab group relative flex min-w-0 max-w-56 shrink-0 cursor-grab items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors active:cursor-grabbing ${
                  isActive
                    ? "text-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                } ${
                  isDragTarget ? "ring-2 ring-inset ring-accent/60" : ""
                } ${isDragging ? "opacity-40" : ""}`}
                draggable
                data-tab-id={tab.id}
                aria-label={`Open ${tab.file.name}`}
                aria-current={isActive ? "page" : undefined}
                aria-describedby={isDragTarget ? `${tab.id}-drop-target` : undefined}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("application/x-libera-tab-id", tab.id);
                  setDraggingTabId(tab.id);
                }}
                onDragOver={(event) => {
                  if (!draggingTabId || draggingTabId === tab.id) {
                    return;
                  }

                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDragOverTabId(tab.id);
                }}
                onDragLeave={() => {
                  setDragOverTabId((current) => (current === tab.id ? "" : current));
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const sourceTabId =
                    event.dataTransfer.getData("application/x-libera-tab-id") ||
                    draggingTabId;

                  if (sourceTabId && sourceTabId !== tab.id) {
                    onSwapTabs(sourceTabId, tab.id);
                  }

                  clearDragState();
                }}
                onDragEnd={clearDragState}
                type="button"
                onClick={() => onActivateTab(tab.id)}
                onContextMenu={(event) => void openTabContextMenu(event, tab)}
                onMouseDown={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                  }
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1) {
                    return;
                  }

                  event.preventDefault();
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                <span aria-hidden className="libera-tab-file-icon" data-type={tab.file.fileType}>
                  <FileTypeIcon fileType={tab.file.fileType} />
                </span>
                <span className="truncate">{tab.file.name}</span>
                {isDragTarget ? (
                  <span id={`${tab.id}-drop-target`} className="sr-only">
                    Drop to swap tabs
                  </span>
                ) : null}
                <span className="ml-0.5 flex shrink-0 items-center gap-2">
                  {isDirty ? (
                    <span
                      aria-label="Unsaved"
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70"
                    />
                  ) : null}
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded transition-opacity hover:bg-foreground/10 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      isActive ? "opacity-60 hover:opacity-100" : "opacity-0"
                    } group-hover:opacity-100`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Close ${tab.file.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onCloseTab(tab.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        onCloseTab(tab.id);
                      }
                    }}
                  >
                    <X aria-hidden className="h-3.5 w-3.5" />
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <ActiveFileActions
          markdownEditorMode={markdownEditorMode}
          onMarkdownEditorModeChange={onMarkdownEditorModeChange}
          activeTab={activeTab}
          onDeleteFile={onDeleteFile}
          onDownloadFile={onDownloadFile}
          onDownloadMarkdownPdf={onDownloadMarkdownPdf}
          onMoveFile={onMoveFile}
          onRenameFile={onRenameFile}
          onSave={onSave}
        />
        <button
          type="button"
          aria-label="Toggle document chat"
          aria-expanded={chatOpen}
          aria-controls="document-chat-panel"
          aria-keyshortcuts="Meta+Shift+B Control+Shift+B"
          title="Toggle document chat (⌘/Ctrl+Shift+B)"
          onClick={onToggleChat}
          className={`libera-window-no-drag shrink-0 rounded-lg p-2 hover:bg-muted hover:text-foreground ${chatOpen ? "bg-muted text-foreground" : "text-muted-foreground"}`}
        >
          <Sparkles aria-hidden className="h-4 w-4" />
        </button>
        <WindowControls />
      </div>
    </div>
  );
}

function ActiveFileActions({
  markdownEditorMode,
  onMarkdownEditorModeChange,
  activeTab,
  onDeleteFile,
  onDownloadFile,
  onDownloadMarkdownPdf,
  onMoveFile,
  onRenameFile,
  onSave,
}: ActiveFileActionsProps) {
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);

  if (!activeTab) {
    return null;
  }

  const isMarkdown = activeTab.file.fileType === "markdown";
  const downloadContent = isMarkdown ? activeTab.draft : undefined;

  async function openDownloadMenu(event: MouseEvent<HTMLButtonElement>) {
    if (!activeTab) {
      return;
    }

    const menu = window.liberaMenu;

    if (!menu) {
      return;
    }

    const point = nativeMenuPointFromButton(event.currentTarget);

    setDownloadMenuOpen(true);

    const selectedItemId = await menu
      .popup({
        ...point,
        items: [
          { id: "markdown-file", label: "Markdown file" },
          { id: "pdf-file", label: "PDF file" },
        ],
      })
      .catch(() => null);

    setDownloadMenuOpen(false);

    if (selectedItemId === "markdown-file") {
      onDownloadFile(activeTab.file, downloadContent);
    } else if (selectedItemId === "pdf-file") {
      await onDownloadMarkdownPdf(activeTab);
    }
  }

  return (
    <div className="libera-file-actions libera-window-no-drag flex shrink-0 items-center gap-1">
      {isMarkdown && !isMarkdownSlidesPath(activeTab.file.path) ? (
        <div role="group" aria-label="Markdown editing mode" className="libera-editor-mode mr-1 inline-flex h-8 shrink-0 items-center rounded-lg border border-border p-0.5">
          {(["visual", "source"] as const).map((mode) => (
            <button key={mode} type="button" aria-pressed={markdownEditorMode === mode}
              className="h-full rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted aria-pressed:bg-muted aria-pressed:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => onMarkdownEditorModeChange(mode)}>
              {mode === "visual" ? "Visual" : "Source"}
            </button>
          ))}
        </div>
      ) : null}
      {isMarkdown ? <ReviewToggle /> : null}
      {isMarkdown ? (
        <button
          aria-label="Save"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-accent/10 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
          disabled={activeTab.status === "saving" || (!activeTab.untitled && activeTab.status === "clean")}
          title="Save"
          type="button"
          onClick={onSave}
        >
          <Save aria-hidden className="h-4 w-4" />
        </button>
      ) : null}
      {isMarkdown ? (
        <button
          aria-expanded={downloadMenuOpen}
          aria-haspopup="menu"
          aria-label="Download"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-accent/10 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          title="Download"
          type="button"
          onClick={(event) => void openDownloadMenu(event)}
        >
          <Download aria-hidden className="h-4 w-4" />
        </button>
      ) : (
        <button
          aria-label="Download"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-accent/10 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          title="Download"
          type="button"
          onClick={() => onDownloadFile(activeTab.file)}
        >
          <Download aria-hidden className="h-4 w-4" />
        </button>
      )}
      <button
        aria-label="Rename"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-accent/10 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        title="Rename"
        type="button"
        onClick={() => onRenameFile(activeTab)}
      >
        <Pencil aria-hidden className="h-4 w-4" />
      </button>
      <button
        aria-label="Move"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-accent/10 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        title="Move"
        type="button"
        onClick={() => onMoveFile(activeTab)}
      >
        <MoveRight aria-hidden className="h-4 w-4" />
      </button>
      <button
        aria-label="Delete"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-destructive"
        title="Delete"
        type="button"
        onClick={() => onDeleteFile(activeTab)}
      >
        <Trash2 aria-hidden className="h-4 w-4" />
      </button>
    </div>
  );
}
