"use client";

import { ReviewToggle } from "./markdown-review-ui";
import { useState } from "react";
import type { MouseEvent } from "react";
import { MoreHorizontal, Plus, Sparkles, X } from "lucide-react";
import type { MarkdownEditorMode, OpenTab } from "@/components/libera/types";
import { TAB_DRAG_MIME } from "@/lib/canvas-layout";
import { FileTypeIcon } from "./file-type";
import { isGalleryTab } from "./gallery-tabs";
import { announceImageSaved, imageSaveMenuItems, runImageSaveMenuAction } from "./image-save";
import { isRecordingTab } from "./recording/recording-tabs";
import { isPageTab, PAGES } from "./page-tabs";
import { WindowControls } from "@/components/libera/window-controls";
import { isMarkdownSlidesPath } from "@/lib/markdown-slides";
import { DocumentHistoryHost, HISTORY_MENU_ID, historyMenuItems, openDocumentHistory } from "./collab/history";
import { RequestReviewButton } from "./collab/reviews";
import { pendingSaves, usePendingSavesVersion } from "./pending-saves";
import { useAppMenuFileActions, useAppMenuItems, withMenuActions } from "./app-menu";

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
  onDownloadAnnotatedPdf: (tab: OpenTab) => Promise<void>;
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

type CanvasSplitZone = "right" | "bottom" | "left" | "top";

/** The sides a panel can open on, for the macOS View menu. */
const SPLIT_SIDES: Array<{ zone: CanvasSplitZone; label: string }> = [
  { zone: "right", label: "To the Right" },
  { zone: "left", label: "To the Left" },
  { zone: "top", label: "Above" },
  { zone: "bottom", label: "Below" },
];
type NativeMenuItems = Parameters<NonNullable<Window["liberaMenu"]>["popup"]>[0]["items"];

type ActiveFileActionsProps = Pick<
  TabStripProps,
  | "activeTab"
  | "markdownEditorMode"
  | "onMarkdownEditorModeChange"
  | "onDeleteFile"
  | "onDownloadAnnotatedPdf"
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
  onDownloadAnnotatedPdf,
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
  usePendingSavesVersion();
  const [draggingTabId, setDraggingTabId] = useState("");
  const [dragOverTabId, setDragOverTabId] = useState("");

  function clearDragState() {
    setDraggingTabId("");
    setDragOverTabId("");
  }

  /** A tab's context menu; the macOS Tab menu leaves out the split items, which are in View. */
  function tabMenuItems(tab: OpenTab, splitItems = true): NativeMenuItems {
    return [
      // A recording in progress has no file for AI Chat or another window to open.
      ...(isRecordingTab(tab) || isPageTab(tab) ? [] : [{ id: "add-to-ai-chat", label: "Add to AI Chat" }, { type: "separator" as const }]),
      ...(onOpenTabInSplit && splitItems
        ? [
            { id: "open-split-right", label: "Open to the Right" },
            { id: "open-split-down", label: "Open Below" },
            { type: "separator" as const },
          ]
        : []),
      // Gallery photos have no notebook file for another window to open.
      ...(isGalleryTab(tab) || isRecordingTab(tab) || isPageTab(tab) ? [] : [{ id: "duplicate-markdown", label: "Duplicate Tab in new Window" }]),
      { id: "close-tab", label: "Close Tab" },
      {
        id: "close-others",
        label: "Close Others",
        enabled: tabs.length > 1,
      },
    ];
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
        items: tabMenuItems(tab),
      })
      .catch(() => null);

    runTabMenuAction(tab, selectedItemId);
  }

  function runTabMenuAction(tab: OpenTab, selectedItemId: string | null) {
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

  function showTabAt(step: number) {
    const index = tabs.findIndex((tab) => tab.id === activeTabId);
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (next) onActivateTab(next.id);
  }

  // The macOS Tab menu: new and switch tabs, then the active tab's context menu.
  useAppMenuItems("tab", 0, () => [
    { id: "new", label: "New Untitled Note", onSelect: onCreateUntitled },
    { type: "separator" },
    { id: "previous", label: "Show Previous Tab", enabled: tabs.length > 1, onSelect: () => showTabAt(-1) },
    { id: "next", label: "Show Next Tab", enabled: tabs.length > 1, onSelect: () => showTabAt(1) },
    {
      id: "go-to",
      label: "Go to Tab",
      enabled: tabs.length > 0,
      submenu: tabs.map((tab, index) => ({ id: `go-to:${index}`, label: tab.file.name, type: "radio", checked: tab.id === activeTabId, onSelect: () => onActivateTab(tab.id) })),
    },
    ...(activeTab ? [{ type: "separator" as const }, ...withMenuActions(tabMenuItems(activeTab, false), (id) => runTabMenuAction(activeTab, id))] : []),
  ]);

  // The macOS View menu's panel items: split the focused panel, or open another tab beside it.
  const otherTabs = tabs.filter((tab) => tab.id !== activeTabId);
  useAppMenuItems("view", 0, () => onSplitCanvas ? [
    {
      id: "split",
      label: "Split Panel",
      submenu: SPLIT_SIDES.map(({ zone, label }) => ({ id: `split:${zone}`, label, onSelect: () => onSplitCanvas(zone) })),
    },
    ...(onOpenTabInSplit ? [{
      id: "open-in-panel",
      label: "Open Tab in New Panel",
      enabled: otherTabs.length > 0,
      submenu: otherTabs.map((tab, index) => ({
        id: `open:${index}`,
        label: tab.file.name,
        submenu: SPLIT_SIDES.map(({ zone, label }) => ({ id: `open:${index}:${zone}`, label, onSelect: () => onOpenTabInSplit(tab.id, zone) })),
      })),
    }] : []),
    ...(onCloseCanvasPanel ? [{ id: "close-panel", label: "Close Panel", enabled: canvasPanelCount > 1, onSelect: onCloseCanvasPanel }] : []),
    ...(onCloseOtherCanvasPanels ? [{ id: "close-other-panels", label: "Close Other Panels", enabled: canvasPanelCount > 1, onSelect: onCloseOtherCanvasPanels }] : []),
  ] : []);

  return (
    <div className="libera-tab-strip libera-window-drag-region border-b border-border bg-card">
      <div className="flex min-h-12 items-center gap-2 px-3 py-2">
        <button type="button" aria-label="New untitled file" title="New untitled file" onClick={onCreateUntitled} className="libera-window-no-drag-region rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"><Plus aria-hidden className="h-4 w-4" /></button>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((tab) => {
            const isActive = activeTabId === tab.id;
            const isDragging = draggingTabId === tab.id;
            const isDragTarget = dragOverTabId === tab.id && draggingTabId !== tab.id;
            // Unsaved text, or unsaved ink and annotations (pending-saves.ts).
            const isDirty = tab.status === "dirty" || pendingSaves.isDirty(tab.file.path);
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
                  {isPageTab(tab) ? <PageTabIcon kind={tab.page.kind} /> : <FileTypeIcon fileType={tab.file.fileType} name={tab.file.name} />}
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
          onDownloadAnnotatedPdf={onDownloadAnnotatedPdf}
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
  onDownloadAnnotatedPdf,
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
  const fileTab = activeTab && !isRecordingTab(activeTab) && !isPageTab(activeTab) ? activeTab : undefined;
  const isMarkdown = fileTab?.file.fileType === "markdown";
  const isLatex = fileTab?.file.fileType === "latex";
  const isPdf = fileTab?.file.fileType === "pdf";
  const isImage = fileTab?.file.fileType === "image";
  const isText = fileTab?.file.fileType === "text";
  // Gallery photos are renamed, moved and deleted from the gallery itself.
  const isGalleryPhoto = fileTab ? isGalleryTab(fileTab) : false;
  const supportsEditorMode = isMarkdown && !isMarkdownSlidesPath(fileTab?.file.path ?? "");

  // The macOS menu bar's File menu lists the same actions as this button's menu.
  useAppMenuFileActions(async () => fileTab
    ? withMenuActions(await actionMenuItems(fileTab), (id) => void runAction(fileTab, id))
    : withMenuActions(canvasPanelCount < 2 ? [] : canvasItems, (id) => runCanvasMenuAction(id, canvasActions)));

  if (!fileTab) {
    // An empty split panel, a recording in progress or an app page has no file, but its layout can still be changed.
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

  /** The file actions of `tab`, the active tab, then the canvas layout. */
  async function actionMenuItems(tab: OpenTab): Promise<NativeMenuItems> {
    // Shared files have a version history.
    const historyItems = historyMenuItems(tab.id);
    // PDFs and images: their unsaved annotations and ink (pending-saves.ts).
    const viewerSaveItem = {
      id: "save",
      label: "Save",
      enabled: tab.status !== "saving" && pendingSaves.isDirty(tab.file.path),
    };

    return [
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
                tab.status !== "saving" &&
                (tab.untitled || tab.status !== "clean"),
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
        : isLatex || isText
          ? [
              {
                id: "save",
                label: "Save",
                enabled: tab.status !== "saving" && tab.status !== "clean",
              },
              { id: "download-markdown", label: "Download" },
            ]
          : isPdf
            ? [
                viewerSaveItem,
                {
                  id: "download",
                  label: "Download",
                  submenu: [
                    { id: "download-pdf-annotated", label: "PDF with Annotations" },
                    { id: "download-original", label: "Original PDF" },
                  ],
                },
              ]
            : isImage
              ? [viewerSaveItem, { id: "save-image", label: "Save a Copy", submenu: await imageSaveMenuItems(isGalleryPhoto ? "notebook" : "gallery") }]
              : [{ id: "download-original", label: "Download" }]),
      ...(isGalleryPhoto
        ? (canvasItems.length ? [{ type: "separator" as const }, ...canvasItems] : [])
        : [
            { type: "separator" as const },
            ...(historyItems.length ? [...historyItems, { type: "separator" as const }] : []),
            ...(canvasItems.length ? [...canvasItems, { type: "separator" as const }] : []),
            { id: "rename", label: "Rename" },
            { id: "move", label: "Move" },
            { type: "separator" as const },
            { id: "delete", label: "Delete" },
          ]),
    ];
  }

  /** Runs a choice from actionMenuItems(tab). */
  async function runAction(tab: OpenTab, selectedItemId: string | null) {
    if (runCanvasMenuAction(selectedItemId, canvasActions)) {
      return;
    }

    if (selectedItemId?.startsWith("save-image:")) {
      const source = { name: tab.file.name, src: tab.rawUrl ?? "" };
      const message = source.src ? await runImageSaveMenuAction(selectedItemId, source) : null;
      if (message) announceImageSaved(source.src, message);
      return;
    }

    if (selectedItemId === "editor-visual") {
      onMarkdownEditorModeChange("visual");
    } else if (selectedItemId === "editor-source") {
      onMarkdownEditorModeChange("source");
    } else if (selectedItemId === "save") {
      await onSave();
    } else if (selectedItemId === "download-markdown") {
      onDownloadFile(tab.file, tab.file.fileType === "markdown" || tab.file.fileType === "latex" || tab.file.fileType === "text" ? tab.draft : undefined);
    } else if (selectedItemId === "download-pdf") {
      await onDownloadMarkdownPdf(tab);
    } else if (selectedItemId === "download-pdf-annotated") {
      await onDownloadAnnotatedPdf(tab);
    } else if (selectedItemId === "download-original") {
      onDownloadFile(tab.file);
    } else if (selectedItemId === "rename") {
      await onRenameFile(tab);
    } else if (selectedItemId === "move") {
      await onMoveFile(tab);
    } else if (selectedItemId === "delete") {
      await onDeleteFile(tab);
    } else if (selectedItemId === HISTORY_MENU_ID) {
      openDocumentHistory(tab.id);
    }
  }

  async function openActionMenu(event: MouseEvent<HTMLButtonElement>) {
    const menu = window.liberaMenu;

    if (!fileTab || !menu) {
      return;
    }

    const point = nativeMenuPointFromButton(event.currentTarget);

    setActionMenuOpen(true);

    const selectedItemId = await menu.popup({ ...point, items: await actionMenuItems(fileTab) }).catch(() => null);

    setActionMenuOpen(false);
    await runAction(fileTab, selectedItemId);
  }

  return (
    <div className="libera-file-actions libera-window-no-drag flex shrink-0 items-center gap-1">
      {isMarkdown || isLatex ? <><ReviewToggle /><RequestReviewButton tabId={fileTab.id} /></> : null}
      <FileActionsMenuButton open={actionMenuOpen} onClick={openActionMenu} bare />
      <DocumentHistoryHost />
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

function PageTabIcon({ kind }: { kind: keyof typeof PAGES }) {
  const Icon = PAGES[kind].icon;
  return <Icon aria-hidden className="h-4 w-4" />;
}
