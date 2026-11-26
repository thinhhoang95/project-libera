"use client";

import { ReviewToggle } from "./markdown-review-ui";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { MouseEvent } from "react";
import { Code, Download, Eye, FolderInput, MoreHorizontal, Plus, Sparkles, TextCursorInput, X } from "lucide-react";
import { usePaletteCommands } from "./command-palette/commands";
import type { LatexTabViewState, MarkdownEditorMode, OpenTab } from "@/components/libera/types";

import { TAB_DRAG_MIME } from "@/lib/canvas-layout";
import { FileTypeIcon } from "./file-type";
import { chromeTabKind, type ChromeTab } from "./tab-chrome";
import { announceImageSaved, imageSaveMenuItems, runImageSaveMenuAction } from "./image-save";
import { PAGES } from "./page-tabs";
import { useTabName } from "./use-tab-name";
import { WindowControls } from "@/components/libera/window-controls";
import { isMarkdownSlidesPath } from "@/lib/markdown-slides";
import { isCompilableLatexPath } from "@/lib/latex/project";
import { DocumentHistoryHost, HISTORY_MENU_ID, historyMenuItems, openDocumentHistory } from "./collab/history";
import { RequestReviewButton } from "./collab/reviews";
import { pendingSaves, usePendingSavesDirty } from "./pending-saves";
import { useAppMenuFileActions, useAppMenuItems, withMenuActions } from "./app-menu";

/** Switches the active file between the Visual and Source editors. */
const EDITOR_MODE_SHORTCUT = "Ctrl/⌘+Shift+Y";

type LatexEditorMode = NonNullable<LatexTabViewState["editorMode"]>;

type TabStripProps = {
  chatOpen: boolean;
  onToggleChat: () => void;
  onCreateUntitled: () => void;
  onCreateUntitledText: () => void;
  markdownEditorMode: MarkdownEditorMode;
  onMarkdownEditorModeChange: (mode: MarkdownEditorMode) => void;
  /** The active .tex tab's editor mode (LaTeX opens in Source). */
  latexEditorMode: LatexEditorMode;
  onLatexEditorModeChange: (mode: LatexEditorMode) => void;
  activeTab?: ChromeTab;
  activeTabId: string;
  notebookColors: Record<string, string>;
  tabs: readonly ChromeTab[];
  onActivateTab: (tabId: string) => void;
  onAddToAiChat: (tab: ChromeTab) => void;
  onDuplicateMarkdown: (file: OpenTab["file"]) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onDeleteFile: (tab: ChromeTab) => Promise<void>;
  onDownloadAnnotatedPdf: (tab: ChromeTab) => Promise<void>;
  onDownloadFile: (file: OpenTab["file"], content?: string) => void;
  /** The published text of an open tab, read when the user downloads it. */
  readTabDraft: (tabId: string) => string | undefined;
  onDownloadMarkdownPdf: (tab: ChromeTab) => Promise<void>;
  onMoveFile: (tab: ChromeTab) => Promise<void>;
  onRenameFile: (tab: ChromeTab) => Promise<void>;
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

/** A message translator from `useTranslations("tabStrip")`, for the menu builders outside components. */
type Translator = (key: string, values?: Record<string, string | number>) => string;

/** The sides a panel can open on, for the macOS View menu. */
const SPLIT_SIDES: Array<{ zone: CanvasSplitZone; labelKey: string }> = [
  { zone: "right", labelKey: "sideRight" },
  { zone: "left", labelKey: "sideLeft" },
  { zone: "top", labelKey: "sideAbove" },
  { zone: "bottom", labelKey: "sideBelow" },
];
type NativeMenuItems = Parameters<NonNullable<Window["liberaMenu"]>["popup"]>[0]["items"];
const { gallery: isGalleryTab, recording: isRecordingTab, page: isPageTab } = chromeTabKind;

type ActiveFileActionsProps = Pick<
  TabStripProps,
  | "activeTab"
  | "markdownEditorMode"
  | "onMarkdownEditorModeChange"
  | "latexEditorMode"
  | "onLatexEditorModeChange"
  | "onDeleteFile"
  | "onDownloadAnnotatedPdf"
  | "onDownloadFile"
  | "readTabDraft"
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
  t: Translator,
  panelCount: number,
  { onSplitCanvas, onCloseCanvasPanel, onCloseOtherCanvasPanels }: Pick<ActiveFileActionsProps, "onSplitCanvas" | "onCloseCanvasPanel" | "onCloseOtherCanvasPanels">,
): NativeMenuItems {
  if (!onSplitCanvas) {
    return [];
  }

  return [
    { id: "split-right", label: t("splitRight") },
    { id: "split-down", label: t("splitDown") },
    ...(onCloseCanvasPanel ? [{ id: "close-panel", label: t("closePanel"), enabled: panelCount > 1 }] : []),
    ...(onCloseOtherCanvasPanels ? [{ id: "close-other-panels", label: t("closeOtherPanels"), enabled: panelCount > 1 }] : []),
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

/** A narrow window clips the tab row; let a vertical mouse wheel scroll it sideways.
 *  React's onWheel is passive, so the listener is attached natively to call preventDefault. */
function useWheelScrollsSideways() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || el.scrollWidth <= el.clientWidth) return;
      // Trackpads already send horizontal deltas; only remap a mostly-vertical wheel.
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 40 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? el.clientWidth : 1;
      const before = el.scrollLeft;
      el.scrollLeft += event.deltaY * unit;
      if (el.scrollLeft !== before) event.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  return ref;
}

export const TabStrip = memo(function TabStrip({
  chatOpen,
  onToggleChat,
  onCreateUntitled,
  onCreateUntitledText,
  markdownEditorMode,
  onMarkdownEditorModeChange,
  latexEditorMode,
  onLatexEditorModeChange,
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
  readTabDraft,
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
  // Wakes only when a shown tab's unsaved state changes (the dots and Save below read it).
  usePendingSavesDirty(tabs.map((tab) => tab.file.path));
  const t = useTranslations("tabStrip");
  const tabName = useTabName();
  const [draggingTabId, setDraggingTabId] = useState("");
  const [dragOverTabId, setDragOverTabId] = useState("");

  function clearDragState() {
    setDraggingTabId("");
    setDragOverTabId("");
  }

  /** A tab's context menu; the macOS Tab menu leaves out the split items, which are in View. */
  function tabMenuItems(tab: ChromeTab, splitItems = true): NativeMenuItems {
    return [
      // A recording in progress has no file for AI Chat or another window to open.
      ...(isRecordingTab(tab) || isPageTab(tab) ? [] : [{ id: "add-to-ai-chat", label: t("addToAiChat") }, { type: "separator" as const }]),
      ...(onOpenTabInSplit && splitItems
        ? [
            { id: "open-split-right", label: t("openToTheRight") },
            { id: "open-split-down", label: t("openBelow") },
            { type: "separator" as const },
          ]
        : []),
      // Gallery photos have no notebook file for another window to open.
      ...(isGalleryTab(tab) || isRecordingTab(tab) || isPageTab(tab) ? [] : [{ id: "duplicate-markdown", label: t("duplicateTabInNewWindow") }]),
      { id: "close-tab", label: t("closeTab") },
      {
        id: "close-others",
        label: t("closeOthers"),
        enabled: tabs.length > 1,
      },
    ];
  }

  async function openTabContextMenu(event: MouseEvent<HTMLButtonElement>, tab: ChromeTab) {
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

  function runTabMenuAction(tab: ChromeTab, selectedItemId: string | null) {
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

  const tabRowRef = useWheelScrollsSideways();

  /** The + button: a native menu to pick the new file's kind (the browser build makes a note). */
  async function openNewFileMenu(event: MouseEvent<HTMLButtonElement>) {
    const menu = window.liberaMenu;
    if (!menu) {
      onCreateUntitled();
      return;
    }
    const selectedItemId = await menu
      .popup({
        ...nativeMenuPointFromButton(event.currentTarget),
        items: [
          { id: "new-markdown", label: t("newMarkdown") },
          { id: "new-text", label: t("newTextFile") },
        ],
      })
      .catch(() => null);
    if (selectedItemId === "new-markdown") onCreateUntitled();
    else if (selectedItemId === "new-text") onCreateUntitledText();
  }

  function showTabAt(step: number) {
    const index = tabs.findIndex((tab) => tab.id === activeTabId);
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (next) onActivateTab(next.id);
  }

  // The macOS Tab menu: new and switch tabs, then the active tab's context menu.
  useAppMenuItems("tab", 0, () => [
    { id: "new", label: t("newUntitledNote"), onSelect: onCreateUntitled },
    { id: "new-text", label: t("newTextFile"), onSelect: onCreateUntitledText },
    { type: "separator" },
    { id: "previous", label: t("showPreviousTab"), enabled: tabs.length > 1, onSelect: () => showTabAt(-1) },
    { id: "next", label: t("showNextTab"), enabled: tabs.length > 1, onSelect: () => showTabAt(1) },
    {
      id: "go-to",
      label: t("goToTab"),
      enabled: tabs.length > 0,
      submenu: tabs.map((tab, index) => ({ id: `go-to:${index}`, label: tabName(tab), type: "radio", checked: tab.id === activeTabId, onSelect: () => onActivateTab(tab.id) })),
    },
    ...(activeTab ? [{ type: "separator" as const }, ...withMenuActions(tabMenuItems(activeTab, false), (id) => runTabMenuAction(activeTab, id))] : []),
  ]);

  // The macOS View menu's panel items: split the focused panel, or open another tab beside it.
  const otherTabs = tabs.filter((tab) => tab.id !== activeTabId);
  useAppMenuItems("view", 0, () => onSplitCanvas ? [
    {
      id: "split",
      label: t("splitPanel"),
      submenu: SPLIT_SIDES.map(({ zone, labelKey }) => ({ id: `split:${zone}`, label: t(labelKey), onSelect: () => onSplitCanvas(zone) })),
    },
    ...(onOpenTabInSplit ? [{
      id: "open-in-panel",
      label: t("openTabInNewPanel"),
      enabled: otherTabs.length > 0,
      submenu: otherTabs.map((tab, index) => ({
        id: `open:${index}`,
        label: tabName(tab),
        submenu: SPLIT_SIDES.map(({ zone, labelKey }) => ({ id: `open:${index}:${zone}`, label: t(labelKey), onSelect: () => onOpenTabInSplit(tab.id, zone) })),
      })),
    }] : []),
    ...(onCloseCanvasPanel ? [{ id: "close-panel", label: t("closePanel"), enabled: canvasPanelCount > 1, onSelect: onCloseCanvasPanel }] : []),
    ...(onCloseOtherCanvasPanels ? [{ id: "close-other-panels", label: t("closeOtherPanels"), enabled: canvasPanelCount > 1, onSelect: onCloseOtherCanvasPanels }] : []),
  ] : []);

  return (
    <div className="libera-tab-strip libera-window-drag-region border-b border-border bg-card">
      <div className="flex min-h-12 items-center gap-2 px-3 py-2">
        <button type="button" aria-label={t("newUntitledFile")} title={t("newUntitledFile")} aria-haspopup="menu" onClick={openNewFileMenu} className="libera-window-no-drag-region rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"><Plus aria-hidden className="h-4 w-4" /></button>
        <div ref={tabRowRef} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
                title={isOnCanvas && !isActive ? t("shownInAnotherPanel", { name: tabName(tab) }) : undefined}
                aria-label={t("openTab", { name: tabName(tab) })}
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
                  {tab.page ? <PageTabIcon kind={tab.page.kind} /> : <FileTypeIcon fileType={tab.file.fileType} name={tab.file.name} />}
                </span>
                <span className="truncate">{tabName(tab)}</span>
                {isDragTarget ? (
                  <span id={`${tab.id}-drop-target`} className="sr-only">
                    {t("dropToSwapTabs")}
                  </span>
                ) : null}
                <span className="ml-0.5 flex shrink-0 items-center gap-2">
                  {isDirty ? (
                    <span
                      aria-label={t("unsaved")}
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70"
                    />
                  ) : null}
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded transition-opacity hover:bg-foreground/10 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      isActive ? "opacity-60 hover:opacity-100" : "opacity-0"
                    } group-hover:opacity-100`}
                    role="button"
                    tabIndex={0}
                    aria-label={t("closeNamed", { name: tabName(tab) })}
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
          latexEditorMode={latexEditorMode}
          onLatexEditorModeChange={onLatexEditorModeChange}
          activeTab={activeTab}
          onDeleteFile={onDeleteFile}
          onDownloadAnnotatedPdf={onDownloadAnnotatedPdf}
          onDownloadFile={onDownloadFile}
          readTabDraft={readTabDraft}
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
          aria-label={t("toggleDocumentChat")}
          aria-expanded={chatOpen}
          aria-controls="document-chat-panel"
          data-libera-chat-toggle=""
          aria-keyshortcuts="Meta+Shift+B Control+Shift+B"
          title={t("toggleDocumentChatTitle")}
          onClick={onToggleChat}
          className={`libera-window-no-drag shrink-0 rounded-lg p-2 hover:bg-muted hover:text-foreground ${chatOpen ? "bg-muted text-foreground" : "text-muted-foreground"}`}
        >
          <Sparkles aria-hidden className="h-4 w-4" />
        </button>
        <WindowControls />
      </div>
    </div>
  );
});

function ActiveFileActions({
  markdownEditorMode,
  onMarkdownEditorModeChange,
  latexEditorMode,
  onLatexEditorModeChange,
  activeTab,
  onDeleteFile,
  onDownloadAnnotatedPdf,
  onDownloadFile,
  readTabDraft,
  onDownloadMarkdownPdf,
  onMoveFile,
  onRenameFile,
  onSave,
  canvasPanelCount = 1,
  onSplitCanvas,
  onCloseCanvasPanel,
  onCloseOtherCanvasPanels,
}: ActiveFileActionsProps) {
  const t = useTranslations("tabStrip");
  const tHistory = useTranslations("collab.history.index");
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const canvasActions = { onSplitCanvas, onCloseCanvasPanel, onCloseOtherCanvasPanels };
  const canvasItems = canvasMenuItems(t, canvasPanelCount, canvasActions);
  const fileTab = activeTab && !isRecordingTab(activeTab) && !isPageTab(activeTab) ? activeTab : undefined;
  const isMarkdown = fileTab?.file.fileType === "markdown";
  const isLatex = fileTab?.file.fileType === "latex";
  const isPdf = fileTab?.file.fileType === "pdf";
  const isImage = fileTab?.file.fileType === "image";
  const isText = fileTab?.file.fileType === "text";
  // Gallery photos are renamed, moved and deleted from the gallery itself.
  const isGalleryPhoto = fileTab ? isGalleryTab(fileTab) : false;
  const supportsEditorMode = isMarkdown && !isMarkdownSlidesPath(fileTab?.file.path ?? "");
  // Visual mode is for .tex files; .bib, .sty and .cls files stay source.
  const supportsLatexEditorMode = isLatex && isCompilableLatexPath(fileTab?.file.path ?? "");

  // The macOS menu bar's File menu lists the same actions as this button's menu.
  useAppMenuFileActions(async () => fileTab
    ? withMenuActions(await actionMenuItems(fileTab), (id) => void runAction(fileTab, id))
    : withMenuActions(canvasPanelCount < 2 ? [] : canvasItems, (id) => runCanvasMenuAction(id, canvasActions)));

  // The active file's editor mode, as shown in the menu, and the id that switches it.
  const editorMode = supportsEditorMode ? markdownEditorMode : supportsLatexEditorMode ? latexEditorMode : null;
  const editorModeAction = (mode: "visual" | "source") => `${supportsEditorMode ? "editor" : "latex-editor"}-${mode}`;
  const canRenameOrMove = Boolean(fileTab) && !isGalleryPhoto;

  // The same actions in the command palette (⌘/Ctrl+Shift+P), for the active file.
  usePaletteCommands(null, () => {
    if (!fileTab) return [];
    const group = t("fileGroup");
    const run = (id: string) => () => void runAction(fileTab, id);
    const downloads: Array<[id: string, title: string]> = isMarkdown
      ? [["download-markdown", t("downloadAsMarkdownFile")], ["download-pdf", t("downloadAsPdfFile")]]
      : isLatex || isText
        ? [["download-markdown", t("download")]]
        : isPdf
          ? [["download-pdf-annotated", t("downloadPdfWithAnnotations")], ["download-original", t("downloadOriginalPdf")]]
          : isImage ? [] : [["download-original", t("download")]];
    return [
      ...(editorMode
        ? (["visual", "source"] as const).map((mode) => ({
            id: `file:editor-${mode}`,
            title: mode === "visual" ? t("switchToVisualEditor") : t("switchToSourceEditor"),
            group,
            icon: mode === "visual" ? Eye : Code,
            shortcut: EDITOR_MODE_SHORTCUT,
            keywords: "editor mode toggle wysiwyg markdown latex raw",
            checked: editorMode === mode,
            run: run(editorModeAction(mode)),
          }))
        : []),
      ...downloads.map(([id, title]) => ({ id: `file:${id}`, title, group, icon: Download, keywords: "export save copy", run: run(id) })),
      ...(canRenameOrMove
        ? [
            { id: "file:rename", title: t("renameFile"), group, icon: TextCursorInput, shortcut: "F2", run: run("rename") },
            { id: "file:move", title: t("moveFile"), group, icon: FolderInput, keywords: "notebook folder relocate", run: run("move") },
          ]
        : []),
    ];
  });

  // ⌘/Ctrl+Shift+Y toggles Visual and Source (⌘/Ctrl+Shift+M is the LaTeX
  // editor's problems panel); F2 renames the active file. Listened for before
  // the editors see it: CodeMirror would otherwise take Shift+Mod-y as Redo.
  useEffect(() => {
    if (!fileTab) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.repeat || event.isComposing || event.defaultPrevented || !fileTab) return;
      const modifier = event.metaKey || event.ctrlKey;
      if (editorMode && modifier && event.shiftKey && !event.altKey && event.code === "KeyY") {
        event.preventDefault();
        event.stopPropagation();
        void runAction(fileTab, editorModeAction(editorMode === "visual" ? "source" : "visual"));
      } else if (canRenameOrMove && event.key === "F2" && !modifier && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        void runAction(fileTab, "rename");
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

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
  async function actionMenuItems(tab: ChromeTab): Promise<NativeMenuItems> {
    // Shared files have a version history.
    const historyItems = historyMenuItems(tab.id, tHistory("menuHistory"));
    // PDFs and images: their unsaved annotations and ink (pending-saves.ts).
    const viewerSaveItem = {
      id: "save",
      label: t("save"),
      enabled: tab.status !== "saving" && pendingSaves.isDirty(tab.file.path),
    };

    return [
      ...(isMarkdown
        ? [
            ...(supportsEditorMode
              ? [
                  {
                    id: "editor-mode",
                    label: t("editorMode"),
                    submenu: [
                      {
                        id: "editor-visual",
                        label: t("visual"),
                        type: "radio" as const,
                        checked: markdownEditorMode === "visual",
                      },
                      {
                        id: "editor-source",
                        label: t("source"),
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
              label: t("save"),
              enabled:
                tab.status !== "saving" &&
                (tab.untitled || tab.status !== "clean"),
            },
            {
              id: "download",
              label: t("download"),
              submenu: [
                { id: "download-markdown", label: t("markdownFile") },
                { id: "download-pdf", label: t("pdfFile") },
              ],
            },
          ]
        : isLatex || isText
          ? [
              ...(supportsLatexEditorMode
                ? [
                    {
                      id: "latex-editor-mode",
                      label: t("editorMode"),
                      submenu: [
                        { id: "latex-editor-visual", label: t("visual"), type: "radio" as const, checked: latexEditorMode === "visual" },
                        { id: "latex-editor-source", label: t("source"), type: "radio" as const, checked: latexEditorMode === "source" },
                      ],
                    },
                    { type: "separator" as const },
                  ]
                : []),
              {
                id: "save",
                label: t("save"),
                enabled: tab.status !== "saving" && tab.status !== "clean",
              },
              { id: "download-markdown", label: t("download") },
            ]
          : isPdf
            ? [
                viewerSaveItem,
                {
                  id: "download",
                  label: t("download"),
                  submenu: [
                    { id: "download-pdf-annotated", label: t("pdfWithAnnotations") },
                    { id: "download-original", label: t("originalPdf") },
                  ],
                },
              ]
            : isImage
              ? [viewerSaveItem, { id: "save-image", label: t("saveACopy"), submenu: await imageSaveMenuItems(isGalleryPhoto ? "notebook" : "gallery") }]
              : [{ id: "download-original", label: t("download") }]),
      ...(isGalleryPhoto
        ? (canvasItems.length ? [{ type: "separator" as const }, ...canvasItems] : [])
        : [
            { type: "separator" as const },
            ...(historyItems.length ? [...historyItems, { type: "separator" as const }] : []),
            ...(canvasItems.length ? [...canvasItems, { type: "separator" as const }] : []),
            { id: "rename", label: t("rename") },
            { id: "move", label: t("move") },
            { type: "separator" as const },
            { id: "delete", label: t("delete") },
          ]),
    ];
  }

  /** Runs a choice from actionMenuItems(tab). */
  async function runAction(tab: ChromeTab, selectedItemId: string | null) {
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
    } else if (selectedItemId === "latex-editor-visual") {
      onLatexEditorModeChange("visual");
    } else if (selectedItemId === "latex-editor-source") {
      onLatexEditorModeChange("source");
    } else if (selectedItemId === "save") {
      await onSave();
    } else if (selectedItemId === "download-markdown") {
      onDownloadFile(tab.file, tab.file.fileType === "markdown" || tab.file.fileType === "latex" || tab.file.fileType === "text" ? readTabDraft(tab.id) : undefined);
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
      {isMarkdown || isLatex || isText ? <><ReviewToggle /><RequestReviewButton tabId={fileTab.id} /></> : null}
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
  const t = useTranslations("tabStrip");
  const button = (
    <button
      aria-expanded={open}
      aria-haspopup="menu"
      aria-label={t("fileActions")}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-accent/10 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      title={t("fileActions")}
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
