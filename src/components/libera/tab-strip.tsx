"use client";

import { ReviewToggle } from "./markdown-review-ui";
import { useState } from "react";
import type { MouseEvent } from "react";
import { MoreHorizontal, Plus, Sparkles, X } from "lucide-react";
import type { MarkdownEditorMode, OpenTab } from "@/components/libera/types";
import { TAB_DRAG_MIME } from "@/lib/canvas-layout";
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
  onAddToAiChat: (tab: OpenTab) => void;
  onDuplicateMarkdown: (file: OpenTab["file"]) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onDeleteFile: (tab: OpenTab) => Promise<void>;
  onDownloadFile: (file: OpenTab["file"], content?: string) => void;
  onDownloadMarkdownPdf: (tab: OpenTab) => Promise<void>;
  onMoveFile: (tab: OpenTab) => Promise<void>;
  onRenameFile: (tab: OpenTab) => Promise<void>;
  onSave: () => Promise<void>;
  onSwapTabs: (sourceTabId: string, targetTabId: string) => void;
  // Split canvas. Tabs listed in `visibleTabIds` are on screen in some panel.
  visibleTabIds?: string[];
  canvasPanelCount?: number;
  onSplitCanvas?: (zone: CanvasSplitZone) => void;
  onOpenTabInSplit?: (tabId: string, zone: CanvasSplitZone) => void;
  onCloseCanvasPanel?: () => void;
  onCloseOtherCanvasPanels?: () => void;
};

type CanvasSplitZone = "right" | "bottom";
type NativeMenuItems = Parameters<NonNullable<Window["liberaMenu"]>["popup"]>[0]["items"];

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
  | "canvasPanelCount"
  | "onSplitCanvas"
  | "onCloseCanvasPanel"
  | "onCloseOtherCanvasPanels"
>;

function canvasMenuItems(
  panelCount: number,
  { onSplitCanvas, onCloseCanvasPanel, onCloseOtherCanvasPanels }: Pick<ActiveFileActionsProps, "onSplitCanvas" | "onCloseCanvasPanel" | "onCloseOtherCanvasPanels">,
): NativeMenuItems {
  if (!onSplitCanvas) {
    return [];
  }

  return [
    { id: "split-right", label: "Split Right" },
    { id: "split-down", label: "Split Down" },
    ...(onCloseCanvasPanel ? [{ id: "close-panel", label: "Close Panel", enabled: panelCount > 1 }] : []),
    ...(onCloseOtherCanvasPanels ? [{ id: "close-other-panels", label: "Close Other Panels", enabled: panelCount > 1 }] : []),
  ];
}

function runCanvasMenuAction(
  selectedItemId: string | null,
  { onSplitCanvas, onCloseCanvasPanel, onCloseOtherCanvasPanels }: Pick<ActiveFileActionsProps, "onSplitCanvas" | "onCloseCanvasPanel" | "onCloseOtherCanvasPanels">,
) {
  if (selectedItemId === "split-right") {
    onSplitCanvas?.("right");
  } else if (selectedItemId === "split-down") {
    onSplitCanvas?.("bottom");
  } else if (selectedItemId === "close-panel") {
    onCloseCanvasPanel?.();
  } else if (selectedItemId === "close-other-panels") {
    onCloseOtherCanvasPanels?.();
  } else {
    return false;
  }

  return true;
}

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
  onAddToAiChat,
  onDuplicateMarkdown,
  onCloseOtherTabs,
  onCloseTab,
  onDeleteFile,
  onDownloadFile,
  onDownloadMarkdownPdf,
  onMoveFile,
  onRenameFile,
  onSave,
  onSwapTabs,
  visibleTabIds = [],
  canvasPanelCount = 1,
  onSplitCanvas,
  onOpenTabInSplit,
  onCloseCanvasPanel,
  onCloseOtherCanvasPanels,
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
          { id: "add-to-ai-chat", label: "Add to AI Chat" },
          { type: "separator" },
          ...(onOpenTabInSplit
            ? [
                { id: "open-split-right", label: "Open to the Right" },
                { id: "open-split-down", label: "Open Below" },
                { type: "separator" as const },
              ]
            : []),
          { id: "duplicate-markdown", label: "Duplicate Tab in new Window" },
          { id: "close-tab", label: "Close Tab" },
          {
            id: "close-others",
            label: "Close Others",
            enabled: tabs.length > 1,
          },
        ],
      })
      .catch(() => null);

    if (selectedItemId === "add-to-ai-chat") {
      onAddToAiChat(tab);
    } else if (selectedItemId === "open-split-right") {
      onOpenTabInSplit?.(tab.id, "right");
    } else if (selectedItemId === "open-split-down") {
      onOpenTabInSplit?.(tab.id, "bottom");
    } else if (selectedItemId === "duplicate-markdown") {
      onDuplicateMarkdown(tab.file);
    } else if (selectedItemId === "close-tab") {
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
            const isOnCanvas = canvasPanelCount > 1 && visibleTabIds.includes(tab.id);

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
                data-canvas-visible={isOnCanvas ? "true" : undefined}
                title={isOnCanvas && !isActive ? `${tab.file.name} — shown in another panel` : undefined}
                aria-label={`Open ${tab.file.name}`}
                aria-current={isActive ? "page" : undefined}
                aria-describedby={isDragTarget ? `${tab.id}-drop-target` : undefined}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData(TAB_DRAG_MIME, tab.id);
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
                    event.dataTransfer.getData(TAB_DRAG_MIME) ||
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
          canvasPanelCount={canvasPanelCount}
          onSplitCanvas={onSplitCanvas}
          onCloseCanvasPanel={onCloseCanvasPanel}
          onCloseOtherCanvasPanels={onCloseOtherCanvasPanels}
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
  canvasPanelCount = 1,
  onSplitCanvas,
  onCloseCanvasPanel,
  onCloseOtherCanvasPanels,
}: ActiveFileActionsProps) {
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const canvasActions = { onSplitCanvas, onCloseCanvasPanel, onCloseOtherCanvasPanels };
  const canvasItems = canvasMenuItems(canvasPanelCount, canvasActions);

  if (!activeTab) {
    // An empty split panel has no file, but its layout can still be changed.
    if (canvasPanelCount < 2 || !canvasItems.length) {
      return null;
    }

    return (
      <FileActionsMenuButton
        open={actionMenuOpen}
        onClick={async (event) => {
          const menu = window.liberaMenu;

          if (!menu) {
            return;
          }

          const point = nativeMenuPointFromButton(event.currentTarget);
          setActionMenuOpen(true);
          const selectedItemId = await menu.popup({ ...point, items: canvasItems }).catch(() => null);
          setActionMenuOpen(false);
          runCanvasMenuAction(selectedItemId, canvasActions);
        }}
      />
    );
  }

  const isMarkdown = activeTab.file.fileType === "markdown";
  const supportsEditorMode = isMarkdown && !isMarkdownSlidesPath(activeTab.file.path);
  const downloadContent = isMarkdown ? activeTab.draft : undefined;

  async function openActionMenu(event: MouseEvent<HTMLButtonElement>) {
    if (!activeTab) {
      return;
    }

    const menu = window.liberaMenu;

    if (!menu) {
      return;
    }

    const point = nativeMenuPointFromButton(event.currentTarget);

    setActionMenuOpen(true);

    const selectedItemId = await menu
      .popup({
        ...point,
        items: [
          ...(isMarkdown
            ? [
                ...(supportsEditorMode
                  ? [
                      {
                        id: "editor-mode",
                        label: "Editor Mode",
                        submenu: [
                          {
                            id: "editor-visual",
                            label: "Visual",
                            type: "radio" as const,
                            checked: markdownEditorMode === "visual",
                          },
                          {
                            id: "editor-source",
                            label: "Source",
                            type: "radio" as const,
                            checked: markdownEditorMode === "source",
                          },
                        ],
                      },
                      { type: "separator" as const },
                    ]
                  : []),
                {
                  id: "save",
                  label: "Save",
                  enabled:
                    activeTab.status !== "saving" &&
                    (activeTab.untitled || activeTab.status !== "clean"),
                },
                {
                  id: "download",
                  label: "Download",
                  submenu: [
                    { id: "download-markdown", label: "Markdown file" },
                    { id: "download-pdf", label: "PDF file" },
                  ],
                },
              ]
            : [{ id: "download-original", label: "Download" }]),
          { type: "separator" },
          ...(canvasItems.length ? [...canvasItems, { type: "separator" as const }] : []),
          { id: "rename", label: "Rename" },
          { id: "move", label: "Move" },
          { type: "separator" },
          { id: "delete", label: "Delete" },
        ],
      })
      .catch(() => null);

    setActionMenuOpen(false);

    if (runCanvasMenuAction(selectedItemId, canvasActions)) {
      return;
    }

    if (selectedItemId === "editor-visual") {
      onMarkdownEditorModeChange("visual");
    } else if (selectedItemId === "editor-source") {
      onMarkdownEditorModeChange("source");
    } else if (selectedItemId === "save") {
      await onSave();
    } else if (selectedItemId === "download-markdown") {
      onDownloadFile(activeTab.file, downloadContent);
    } else if (selectedItemId === "download-pdf") {
      await onDownloadMarkdownPdf(activeTab);
    } else if (selectedItemId === "download-original") {
      onDownloadFile(activeTab.file);
    } else if (selectedItemId === "rename") {
      await onRenameFile(activeTab);
    } else if (selectedItemId === "move") {
      await onMoveFile(activeTab);
    } else if (selectedItemId === "delete") {
      await onDeleteFile(activeTab);
    }
  }

  return (
    <div className="libera-file-actions libera-window-no-drag flex shrink-0 items-center gap-1">
      {isMarkdown ? <ReviewToggle /> : null}
      <FileActionsMenuButton open={actionMenuOpen} onClick={openActionMenu} bare />
    </div>
  );
}

function FileActionsMenuButton({
  open,
  onClick,
  bare = false,
}: {
  open: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => Promise<void>;
  bare?: boolean;
}) {
  const button = (
    <button
      aria-expanded={open}
      aria-haspopup="menu"
      aria-label="File actions"
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-accent/10 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      title="File actions"
      type="button"
      onClick={(event) => void onClick(event)}
    >
      <MoreHorizontal aria-hidden className="h-4 w-4" />
    </button>
  );

  return bare ? button : <div className="libera-file-actions libera-window-no-drag flex shrink-0 items-center gap-1">{button}</div>;
}
