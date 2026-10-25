"use client";

import { MarkdownReviewProvider } from "@/components/libera/markdown-review-context";
import { ReviewPaletteCommands, ReviewPopover } from "@/components/libera/markdown-review-ui";
import { DefinitionsPaletteCommands } from "@/components/libera/definitions-panel";
import { PdfOutlinePaletteCommands } from "@/components/libera/pdf-outline-panel";
import { showOutlineView } from "@/components/libera/outline-view";
import { MarkdownDisplayPreferencesProvider } from "@/components/libera/markdown-display-preferences";
import { useMarkdownAccents } from "@/components/libera/use-markdown-accents";
import { QuickPromptsContext } from "@/components/libera/quick-prompt-input";
import type { MarkdownDisplayPreferences } from "@/lib/markdown-display-preferences";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookMarked, BookOpen, ChartColumnStacked, Columns2, FilePlus2, FileSearch, Images, Layers3, ListTree, LogOut, MessageSquare, MessageSquareText, PanelLeft, Rows2, Save, ScanSearch, Settings, X } from "lucide-react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { apiRequest } from "@/components/libera/api-client";
import { createDeferredSave, registerStateFlusher } from "@/components/libera/deferred-save";
import { DocumentChatPanel, type AgentWorkspaceBridge, type ChatViewedPhoto } from "@/components/libera/document-chat-panel";
import { ImageGalleryView } from "@/components/libera/image-gallery-view";
import { requestSharedAlbum } from "@/components/libera/gallery-store";
import { SearchView } from "@/components/libera/global-search/search-view";
import { galleryPhotoFromSearch, searchRevealViewState } from "@/components/libera/global-search/reveal";
import type { SearchEntry } from "@/components/libera/global-search/search-results";
import { LeftPanel, type LeftPanelReferences, type LeftPanelTab } from "@/components/libera/left-panel";
import { useReferencesPanelRequests } from "@/components/libera/references/references-panel";
import { PdfQuoteCiteHost } from "@/components/libera/references/pdf-quote-cite";
import { useReferencePaletteCommands } from "@/components/libera/references/reference-palette-commands";
import { ReferenceMoveNotice } from "@/components/libera/references/reference-move-notice";
import { REFERENCES_REVEAL_EVENT, type ReferencesRevealDetail } from "@/lib/references/types";
import { CollabProvider } from "@/components/libera/collab/collab-provider";
import { LoginScreen } from "@/components/libera/login-screen";
import { NoteDialog } from "@/components/libera/note-dialog";
import { NotebookDialog } from "@/components/libera/notebook-dialog";
import { WorkspaceViewContext } from "@/components/libera/workspace-view-context";
import { NotebookGroupDialog } from "@/components/libera/notebook-group-dialog";
import { SaveDraftDialog } from "@/components/libera/save-draft-dialog";
import { SaveImageToNewAlbumDialog } from "@/components/libera/save-image-to-new-album-dialog";
import { SaveImageToNotebookDialog } from "@/components/libera/save-image-to-notebook-dialog";
import { useAiActivity } from "@/lib/ai-activity";
import { TabStrip } from "@/components/libera/tab-strip";
import type { OpenTab } from "@/components/libera/types";
import type { GalleryTabPlacement } from "@/components/libera/gallery-tabs";
import { galleryRawUrl, type GalleryPhoto } from "@/lib/image-generation";
import { useLiberaWorkspace } from "@/components/libera/use-libera-workspace";
import { WorkspaceConfirmDialog } from "@/components/libera/workspace-confirm-dialog";
import { FileTagsDialog } from "@/components/libera/file-tags-dialog";
import { LocalModelDialog } from "@/components/libera/local-models/local-model-dialog";
import { SnipReadingCard } from "@/components/libera/document-ocr/snip-reading-card";
import { WorkspaceInputDialog } from "@/components/libera/workspace-input-dialog";
import { WorkspacePanel } from "@/components/libera/workspace-panel";
import { CanvasSplitView } from "@/components/libera/canvas-split-view";
import { visibleCanvasTabIds as visibleCanvasTabIdsOf, type CanvasPaneNode } from "@/lib/canvas-layout";
import type { MarkdownPreferences } from "@/lib/markdown-preferences";
import type { QuickPrompt } from "@/lib/quick-prompts";
import { type LiberaFileNode, type LiberaFilePayload, type LiberaTreeNode } from "@/lib/types";
import { dirtyDocumentCount } from "@/lib/collab/client/workspace";
import { ReadAloudBar } from "@/components/libera/read-aloud";
import { MeetingRecorderProvider } from "@/components/libera/recording/meeting-recorder";
import { CommandPalette } from "@/components/libera/command-palette/command-palette";
import { openCommandPalette, usePaletteCommands } from "@/components/libera/command-palette/commands";
import { contextualPanelTabs, isContextualPanelTab, isPageKind, OPEN_PAGE_EVENT, OPEN_RAIL_TAB_EVENT, type ContextualPanelTab, type PageKind } from "@/components/libera/page-tabs";

type LiberaAppProps = {
  yourName?: string;
  initialAuthenticated: boolean;
  markdownPreferences: MarkdownPreferences;
  markdownDisplayPreferences?: Partial<MarkdownDisplayPreferences>;
  quickPrompts?: QuickPrompt[];
};

const SIDEBAR_WIDTH_STORAGE_KEY = "libera.sidebarWidth";

/** The sections of the desktop Preferences window, as palette commands. */
const PREFERENCES_SECTIONS: Array<{ section?: string; title: string; keywords?: string }> = [
  { title: "Open Preferences…" },
  { section: "general", title: "Preferences: General", keywords: "theme dark mode data directory api key password" },
  { section: "markdown", title: "Preferences: Markdown", keywords: "editor heading numbering source accent" },
  { section: "ai", title: "Preferences: AI", keywords: "openrouter model quick prompts chat" },
  { section: "search", title: "Preferences: Search", keywords: "index embedding images" },
  { section: "speech", title: "Preferences: Speech", keywords: "transcription dictation voice" },
  { section: "read-aloud", title: "Preferences: Read Aloud", keywords: "tts text to speech voice" },
  { section: "detection", title: "Preferences: Detection and Segmentation", keywords: "objects photos models" },
  { section: "users", title: "Preferences: Users", keywords: "profiles accounts" },
  { section: "io", title: "Preferences: I/O", keywords: "import export backup" },
];
const DEFAULT_SIDEBAR_WIDTH = 320;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 560;
const MIN_WORKSPACE_WIDTH = 480;

function clampSidebarWidth(width: number, layoutWidth?: number) {
  const maximumWidth = layoutWidth
    ? Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(MAX_SIDEBAR_WIDTH, layoutWidth - MIN_WORKSPACE_WIDTH),
      )
    : MAX_SIDEBAR_WIDTH;

  return Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(maximumWidth, width)));
}

const NO_QUICK_PROMPTS: QuickPrompt[] = [];

export function LiberaApp({
  yourName = "",
  initialAuthenticated,
  markdownPreferences,
  markdownDisplayPreferences,
  quickPrompts = NO_QUICK_PROMPTS,
}: LiberaAppProps) {
  const aiActive = useAiActivity();
  useMarkdownAccents(markdownPreferences);
  const { authenticated, workspace } = useLiberaWorkspace(initialAuthenticated);
  const [notebooksCollapsed, setNotebooksCollapsed] = useState(false);
  const [activeLeftPanel, setActiveLeftPanel] = useState<LeftPanelTab>("notebook");
  // Opening a gallery photo or a search result in the canvas returns to the
  // panel used before the gallery or the Search page covered it.
  // Contextual panels come and go with their page, so they are never returned to.
  const lastCanvasPanelRef = useRef<Exclude<LeftPanelTab, "gallery" | "search" | ContextualPanelTab>>("notebook");
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const changeLeftPanel = useCallback((panel: LeftPanelTab) => {
    if (panel === "search") setSearchFocusRequest((request) => request + 1);
    else if (panel !== "gallery" && !isContextualPanelTab(panel)) lastCanvasPanelRef.current = panel;
    setActiveLeftPanel(panel);
  }, []);
  // A page's contextual rail tab opens with the page, as Word shows Table Design
  // for a new table; a PDF's Annotations tab only appears. Either goes when
  // another tab takes over, returning the panel to the one in use before.
  const contextualRailTabs = contextualPanelTabs(workspace.activeTab);
  const contextualPanelKey = contextualRailTabs.map((tab) => tab.id).join(" ");
  const autoOpenPanel = contextualRailTabs.find((tab) => tab.autoOpen)?.id ?? null;
  useEffect(() => {
    const available = contextualPanelKey ? contextualPanelKey.split(" ") : [];
    setActiveLeftPanel((current) => autoOpenPanel
      ?? (isContextualPanelTab(current) && !available.includes(current) ? lastCanvasPanelRef.current : current));
  }, [contextualPanelKey, autoOpenPanel]);
  // A tab's view asks for its rail tab, for example the voice memo for its transcription controls.
  useEffect(() => {
    const onOpenRailTab = (event: Event) => {
      const panel = (event as CustomEvent<unknown>).detail;
      if (typeof panel !== "string" || !isContextualPanelTab(panel)) return;
      changeLeftPanel(panel);
      setNotebooksCollapsed(false);
    };
    window.addEventListener(OPEN_RAIL_TAB_EVENT, onOpenRailTab);
    return () => window.removeEventListener(OPEN_RAIL_TAB_EVENT, onOpenRailTab);
  }, [changeLeftPanel]);
  const openComments = useCallback(() => {
    changeLeftPanel("comments");
    setNotebooksCollapsed(false);
  }, [changeLeftPanel]);
  const markdownEditorMode = workspace.activeTab?.viewState?.markdown?.editorMode ?? "visual";
  const [activePreviewTabId, setActivePreviewTabId] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [chatWidth, setChatWidth] = useState(360);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [chatAttachmentRequest, setChatAttachmentRequest] = useState<{ id: string; tab: OpenTab } | null>(null);
  const [chatResizing, setChatResizing] = useState(false);
  const mainLayoutRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const platformInfo = window.liberaPlatform;

    if (!platformInfo?.isElectron) {
      return;
    }

    const root = document.documentElement;
    const platformClass = `libera-platform-${platformInfo.platform}`;

    root.classList.add(platformClass);

    if (platformInfo.glass) {
      root.classList.add("libera-glass");
    }

    return () => {
      root.classList.remove(platformClass, "libera-glass");
    };
  }, []);

  useEffect(() => {
    // Shared tabs count as 0: their edits are already in the host's SQLite.
    const sharedTabIds = workspace.sharedTabIds;
    const unsavedDocumentCount = dirtyDocumentCount(workspace.tabs, (tabId) => sharedTabIds.has(tabId));

    void window.liberaUpdater?.setDirtyDocumentCount(unsavedDocumentCount).catch(() => undefined);
  }, [workspace.tabs, workspace.sharedTabIds]);

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => {
      const storedWidth = Number.parseFloat(
        window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) ?? "",
      );

      if (Number.isFinite(storedWidth)) {
        setSidebarWidth(clampSidebarWidth(storedWidth));
      }
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, []);

  useEffect(() => {
    if (!sidebarResizing && !chatResizing) {
      return;
    }

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [sidebarResizing, chatResizing]);

  useEffect(() => {
    if (!authenticated) return;
    let disposed = false;
    void apiRequest<{ panel: { width: number; collapsed: boolean } | null }>("/api/document-chat/state").then(({ panel }) => {
      if (disposed || !panel) return;
      if (Number.isFinite(panel.width)) setChatWidth(Math.max(280, Math.min(560, panel.width)));
      setChatCollapsed(panel.collapsed === true);
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [authenticated]);

  const panelWriter = useMemo(() => createDeferredSave((body) => apiRequest("/api/document-chat/state", {
    method: "PUT", body, keepalive: !window.liberaPersistence,
  })), []);
  useEffect(() => {
    const unregister = registerStateFlusher(panelWriter.flush);
    return () => { unregister(); void panelWriter.flush().catch(() => undefined); };
  }, [panelWriter]);
  const saveChatPanel = useCallback((width: number, collapsed: boolean) => {
    panelWriter.schedule({ kind: "panel", value: { width, collapsed } });
  }, [panelWriter]);

  const changeChatCollapsed = useCallback((collapsed: boolean) => {
    if (collapsed === chatCollapsed) return;
    setChatCollapsed(collapsed);
    saveChatPanel(chatWidth, collapsed);
  }, [chatWidth, chatCollapsed, saveChatPanel]);

  // The photo open in the gallery viewer is the AI chat's context while it is on screen.
  const [galleryViewingPhoto, setGalleryViewingPhoto] = useState<GalleryPhoto | null>(null);
  const viewedPhotoSource = galleryViewingPhoto && activeLeftPanel === "gallery" ? `gallery:${galleryViewingPhoto.id}:${galleryViewingPhoto.updatedAt}-${galleryViewingPhoto.size}` : null;
  const viewedPhotoName = galleryViewingPhoto?.name;
  const viewedPhotoUrl = galleryViewingPhoto ? galleryRawUrl(galleryViewingPhoto) : null;
  const chatViewedPhoto = useMemo<ChatViewedPhoto | null>(() => viewedPhotoSource && viewedPhotoName && viewedPhotoUrl ? { source: viewedPhotoSource, name: viewedPhotoName, url: viewedPhotoUrl } : null, [viewedPhotoSource, viewedPhotoName, viewedPhotoUrl]);
  const galleryChat = useMemo(() => ({ open: !chatCollapsed, onToggle: () => changeChatCollapsed(!chatCollapsed) }), [chatCollapsed, changeChatCollapsed]);
  // Agent mode reads open drafts and puts its file changes back into the editor.
  const agentWorkspace: AgentWorkspaceBridge = {
    notebook: workspace.selectedNotebookName || undefined,
    readTabDraft: workspace.readOpenTabDraft,
    syncTabFromDisk: workspace.syncTabFromDisk,
    restoreTabAfterUndo: workspace.restoreTabAfterUndo,
    refreshAfterChanges: workspace.refreshAfterAgentChanges,
    openFile: (path) => {
      const file = workspace.files.find((item) => item.path === path);
      if (file) { void workspace.openFile(file); return; }
      // A file outside the active workspace's view is still opened by path.
      void apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(path)}`)
        .then((payload) => workspace.openFile(payload.file)).catch(() => undefined);
    },
  };

  // The References panel: reveal/add requests from anywhere switch the rail
  // to it and select their notebook; it cites into the active Markdown editor.
  const referenceRequests = useReferencesPanelRequests((notebook) => {
    changeLeftPanel("references");
    setNotebooksCollapsed(false);
    if (workspace.selectedNotebookName !== notebook) workspace.selectNotebook(notebook);
  });
  const openReferenceDrafts = useMemo(
    () => workspace.tabs
      .filter((tab) => tab.file.fileType === "markdown" && !tab.untitled && tab.draft !== tab.saved)
      .map((tab) => ({ path: tab.file.path, text: tab.draft })),
    [workspace.tabs],
  );
  const references: LeftPanelReferences = {
    activeMarkdownDraft: workspace.activeMarkdownDraft,
    activeDocumentPath: workspace.activeTab?.file.fileType === "markdown" && !workspace.activeTab.untitled ? workspace.activeTab.file.path : null,
    openDrafts: openReferenceDrafts,
    canCite: workspace.activeTab?.file.fileType === "markdown",
    onCite: (key) => { workspace.insertCitation(key); },
    onCiteMany: (keys) => { workspace.insertCitation(keys); },
    onInsertBibliography: () => { workspace.insertBibliographyMarker(); },
    onOpenPath: agentWorkspace.openFile,
    // The citation is selected and revealed, as a Global Search hit is.
    onOpenCitation: (path, { start, end, line }) => {
      const open = (file: LiberaFileNode) => void workspace.openFile(file, { viewState: { markdown: { line, selectionStart: start, selectionEnd: start, reveal: { start, end, nonce: Date.now() } } } });
      const file = workspace.files.find((item) => item.path === path);
      if (file) { open(file); return; }
      void apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(path)}`)
        .then((payload) => open(payload.file)).catch(() => undefined);
    },
    onUploadFiles: workspace.uploadFiles,
    request: referenceRequests.request,
    onRequestHandled: referenceRequests.handled,
    onApplyCitationRewrite: workspace.applyCitationRewriteToTab,
    onRevertCitationRewrite: workspace.revertCitationRewriteInTab,
  };
  useReferencePaletteCommands({
    notebook: (workspace.activeTab && !workspace.activeTab.untitled ? workspace.activeTab.file.notebook : "") || workspace.selectedNotebookName,
    canCite: references.canCite,
    onInsertBibliography: () => { workspace.insertBibliographyMarker(); },
  });

  const canvas = workspace.canvas;
  // Leaving the gallery uncovers the canvas, so the photo opens where it can be seen.
  function openGalleryPhoto(photo: GalleryPhoto, placement: GalleryTabPlacement) {
    setActiveLeftPanel(lastCanvasPanelRef.current);
    workspace.openGalleryPhoto(photo, placement);
  }

  // Global Search opens a hit at its passage: the page, section or lines.
  function openSearchResult({ result, hit, terms }: SearchEntry, placement: "tab" | "right") {
    setActiveLeftPanel(lastCanvasPanelRef.current);
    if (result.source === "gallery") {
      if (result.photo) workspace.openGalleryPhoto(galleryPhotoFromSearch(result.photo), placement);
      return;
    }
    if (result.source === "references") {
      // A References entry opens in the References panel.
      if (result.reference) {
        window.dispatchEvent(new CustomEvent<ReferencesRevealDetail>(REFERENCES_REVEAL_EVENT, {
          detail: { notebook: result.reference.notebook, entryId: result.reference.entryId },
        }));
      }
      return;
    }
    const file = workspace.files.find((candidate) => candidate.path === result.path) ?? result.file;
    if (!file) return;
    const target = result.hits[hit] ?? result.hits[0];
    void workspace.openFile(file, { viewState: searchRevealViewState(result.kind, target, terms), placement });
  }

  // Search only what the active workspace shows. Without a workspace or hidden
  // notebooks everything is visible, and nothing needs to be sent.
  const searchScope = useMemo(() => {
    const collect = (nodes: LiberaTreeNode[], into: LiberaFileNode[]) => {
      for (const node of nodes) {
        if (node.kind === "file") into.push(node);
        else collect(node.children, into);
      }
      return into;
    };
    const everything = workspace.fullTree.notebooks.reduce((count, notebook) => count + collect(notebook.children, []).length, 0);
    return workspace.files.length < everything ? workspace.files.map((file) => file.path) : undefined;
  }, [workspace.files, workspace.fullTree]);
  const searchIncludesArchive = Boolean(workspace.fullTree.archiveIncluded);

  // Keep the search index current in the background; the server skips this
  // when background indexing is off and limits how often it scans.
  useEffect(() => {
    if (!authenticated) return;
    const update = () => {
      void apiRequest("/api/search/index", { method: "POST", body: JSON.stringify({ action: "background" }) }).catch(() => undefined);
    };
    const first = window.setTimeout(update, 20_000);
    const interval = window.setInterval(update, 10 * 60_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, [authenticated]);

  // Python in notes is part of the app: on a new computer its runtime is set
  // up in the background soon after opening (nothing happens once it is ready).
  useEffect(() => {
    if (!authenticated) return;
    const timer = window.setTimeout(() => {
      void apiRequest("/api/python?ensure=1").catch(() => undefined);
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [authenticated]);

  // App pages (Spending) open from the palette, menus and Preferences → AI.
  const openPageRef = useRef<(kind: PageKind) => void>(() => undefined);
  useEffect(() => {
    openPageRef.current = (kind: PageKind) => {
      workspace.openPageTab(kind);
      setNotebooksCollapsed(false);
    };
  });
  useEffect(() => {
    if (!authenticated) return;
    const open = (kind: unknown) => { if (isPageKind(kind)) openPageRef.current(kind); };
    const onEvent = (event: Event) => open((event as CustomEvent<unknown>).detail);
    window.addEventListener(OPEN_PAGE_EVENT, onEvent);
    const stopListening = window.liberaPreferences?.onOpenPage?.(open);
    return () => {
      window.removeEventListener(OPEN_PAGE_EVENT, onEvent);
      stopListening?.();
    };
  }, [authenticated]);

  // Only the desktop app has a Preferences window. The Search page renders on the client only.
  const openSearchPreferences = typeof window !== "undefined" && window.liberaPreferences
    ? () => void window.liberaPreferences?.open("search")
    : undefined;

  // ⌘/Ctrl+\ splits the focused panel to the right, adding Shift splits it down.
  // The gallery and the Search page cover the canvas, so splitting waits until they close.
  const galleryOpen = activeLeftPanel === "gallery" || activeLeftPanel === "search";
  useEffect(() => {
    if (!authenticated || galleryOpen) return;
    function splitCanvas(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.code !== "Backslash" || event.repeat || event.isComposing) return;
      event.preventDefault();
      canvas.splitPane(canvas.layout.focusedPaneId, event.shiftKey ? "bottom" : "right");
    }
    window.addEventListener("keydown", splitCanvas);
    return () => window.removeEventListener("keydown", splitCanvas);
  }, [authenticated, canvas, galleryOpen]);

  useEffect(() => {
    if (!authenticated) return;
    function toggleChat(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.code !== "KeyB" || event.repeat || event.isComposing) return;
      event.preventDefault();
      changeChatCollapsed(!chatCollapsed);
      if (!chatCollapsed) document.querySelector<HTMLButtonElement>('[aria-label="Toggle document chat"]')?.focus();
    }
    window.addEventListener("keydown", toggleChat, true);
    return () => window.removeEventListener("keydown", toggleChat, true);
  }, [authenticated, chatCollapsed, changeChatCollapsed]);

  function chatWidthFromPointer(clientX: number) {
    const bounds = mainLayoutRef.current?.getBoundingClientRect();
    const available = (bounds?.width ?? 1200) - (notebooksCollapsed ? 48 : sidebarWidth) - 320;
    return Math.round(Math.max(280, Math.min(560, available, (bounds?.right ?? clientX + chatWidth) - clientX)));
  }

  function sidebarWidthFromPointer(clientX: number) {
    const layoutBounds = mainLayoutRef.current?.getBoundingClientRect();

    return clampSidebarWidth(
      clientX - (layoutBounds?.left ?? 0),
      layoutBounds ? layoutBounds.width - (chatCollapsed ? 0 : chatWidth) : undefined,
    );
  }

  function resizeSidebar(event: ReactPointerEvent<HTMLDivElement>) {
    setSidebarWidth(sidebarWidthFromPointer(event.clientX));
  }

  function finishSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    const nextWidth = sidebarWidthFromPointer(event.clientX);
    setSidebarWidth(nextWidth);
    setSidebarResizing(false);
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(nextWidth));

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }
  const notebookColors = useMemo(
    () =>
      Object.fromEntries(
        workspace.tree.notebooks.map((notebook) => [notebook.name, notebook.color]),
      ),
    [workspace.tree.notebooks],
  );

  const visibleCanvasTabIds = visibleCanvasTabIdsOf(canvas.layout);

  // App-wide commands in the command palette (⌘/Ctrl+Shift+P), beside the focused editor's tools.
  usePaletteCommands(null, () => {
    const general = "General";
    const showPanel = (panel: LeftPanelTab) => () => {
      changeLeftPanel(panel);
      setNotebooksCollapsed(false);
    };
    return [
      { id: "app:go-to-file", title: "Go to file…", group: general, icon: FileSearch, shortcut: "Ctrl/⌘+P", run: () => openCommandPalette("files") },
      { id: "app:search", title: "Search everything", group: general, icon: ScanSearch, shortcut: "Ctrl/⌘+Shift+F", keywords: "find content global", run: showPanel("search") },
      { id: "app:new-note", title: "New untitled note", group: general, icon: FilePlus2, keywords: "create markdown draft", run: () => workspace.createUntitledFile() },
      { id: "app:save", title: "Save", group: general, icon: Save, shortcut: "Ctrl/⌘+S", disabled: !workspace.activeTab, run: () => void workspace.saveActiveTab() },
      { id: "app:close-tab", title: "Close tab", group: general, icon: X, shortcut: "Ctrl/⌘+W", disabled: !workspace.activeTabId, run: () => workspace.closeTab(workspace.activeTabId) },
      { id: "app:toggle-chat", title: chatCollapsed ? "Show AI chat" : "Hide AI chat", group: general, icon: MessageSquareText, shortcut: "Ctrl/⌘+Shift+B", run: () => changeChatCollapsed(!chatCollapsed) },
      { id: "app:toggle-sidebar", title: notebooksCollapsed ? "Show sidebar" : "Hide sidebar", group: general, icon: PanelLeft, run: () => setNotebooksCollapsed((current) => !current) },
      { id: "app:split-right", title: "Split panel right", group: general, icon: Columns2, shortcut: "Ctrl/⌘+\\", disabled: galleryOpen, run: () => canvas.splitPane(canvas.layout.focusedPaneId, "right") },
      { id: "app:split-down", title: "Split panel down", group: general, icon: Rows2, shortcut: "Ctrl/⌘+Shift+\\", disabled: galleryOpen, run: () => canvas.splitPane(canvas.layout.focusedPaneId, "bottom") },
      { id: "app:panel-notebook", title: "Show notebooks", group: general, icon: BookOpen, shortcut: "Ctrl/⌘+1", run: showPanel("notebook") },
      { id: "app:panel-outlines", title: "Show outlines", group: general, icon: ListTree, shortcut: "Ctrl/⌘+2", run: showPanel("outlines") },
      { id: "app:panel-comments", title: "Show comments", group: general, icon: MessageSquare, shortcut: "Ctrl/⌘+3", run: showPanel("comments") },
      { id: "app:panel-workspaces", title: "Show workspaces", group: general, icon: Layers3, shortcut: "Ctrl/⌘+4", run: showPanel("workspaces") },
      { id: "app:panel-gallery", title: "Show image gallery", group: general, icon: Images, shortcut: "Ctrl/⌘+5", keywords: "photos", run: showPanel("gallery") },
      { id: "app:panel-references", title: "Show references", group: general, icon: BookMarked, shortcut: "Ctrl/⌘+7", keywords: "citations bibliography", run: showPanel("references") },
      { id: "app:page-spending", title: "Show OpenRouter spending", group: general, icon: ChartColumnStacked, detail: "Token use and cost by period, model and component", keywords: "usage cost tokens billing credits statistics money price", run: () => openPageRef.current("spending") },
      { id: "app:logout", title: "Log out", group: general, icon: LogOut, keywords: "logout sign out switch user lock", run: () => void workspace.handleLogout() },
      ...(window.liberaPreferences
        ? PREFERENCES_SECTIONS.map(({ section, title, keywords }) => ({
            id: `app:preferences-${section ?? "open"}`,
            title,
            group: "Preferences",
            icon: Settings,
            keywords: `settings preferences ${keywords ?? ""}`,
            run: () => void window.liberaPreferences?.open(section),
          }))
        : []),
    ];
  });

  function renderCanvasPane(pane: CanvasPaneNode, focused: boolean) {
    const tab = workspace.tabs.find((currentTab) => currentTab.id === pane.tabId);

    return (
      <WorkspacePanel
        focused={focused}
        yourName={yourName}
        markdownEditorMode={tab?.viewState?.markdown?.editorMode ?? "visual"}
        activePreviewTabId={activePreviewTabId}
        onActivePreviewTabIdChange={setActivePreviewTabId}
        activeTab={tab}
        aiFormatting={workspace.aiFormatting}
        canStartScreenshotSnip={workspace.canStartScreenshotSnip}
        files={workspace.files}
        firstNotebook={workspace.firstNotebook}
        imageMarkdownConverting={workspace.imageMarkdownConverting}
        markdownPreferences={markdownPreferences}
        recentFiles={workspace.recentFiles}
        screenshotSnipSession={workspace.screenshotSnipSession}
        selectedNotebook={workspace.selectedNotebook}
        isFolder={Boolean(workspace.selectedNotebook?.folder)}
        fileTags={workspace.tree.fileTags}
        onEditFileTags={workspace.openFileTagsDialog}
        tabs={workspace.tabs}
        textareaRef={workspace.textareaRef}
        onAiFormatSelection={workspace.formatSelectionWithAi}
        onAiImageToMarkdown={workspace.convertImageToMarkdownWithAi}
        onAiRewriteSelection={workspace.rewriteSelectionWithAi}
        onAiWriteAt={workspace.writeWithAiAt}
        onCreateMarkdown={workspace.createMarkdownFromPrompt}
        onCreateSlides={workspace.createMarkdownSlidesFromPrompt}
        onCreateLatex={workspace.createLatexFromPrompt}
        onCreateNotebook={workspace.openCreateNotebookDialog}
        onCancelScreenshotSnip={workspace.cancelScreenshotSnip}
        onCompleteScreenshotSnip={workspace.completeScreenshotSnip}
        pendingVisualInsertion={tab ? workspace.pendingVisualInsertions[tab.id] : undefined}
        onFinishVisualInsertion={workspace.finishVisualInsertion}
        onCreateMarkdownBesidePdf={workspace.createMarkdownBesidePdf}
        onWriteConvertedMarkdown={workspace.writeConvertedMarkdown}
        onCreateUntitledMarkdown={(fileName, content, directory) => workspace.createUntitledFile(directory.split("/")[0], directory, { fileName, content })}
        onInsertExistingImage={workspace.insertExistingMarkdownImage}
        onInsertFileLink={workspace.insertMarkdownFileLink}
        onInsertFileLinkPlaceholder={workspace.insertMarkdownFileLinkPlaceholder}
        onInsertImage={workspace.insertMarkdownImage}
        onInsertMarkdown={workspace.insertMarkdown}
        onInsertMarkdownTable={workspace.insertMarkdownTable}
        onShiftMarkdownList={workspace.shiftMarkdownList}
        onOpenFile={workspace.openFile}
        onShowImage={(file) => {
          if (tab) workspace.showImageInTab(tab.id, file);
        }}
        onSaveEditedImageCopy={workspace.saveEditedImageCopy}
        onOpenMarkdownFileLink={workspace.openMarkdownFileLink}
        onReadMarkdownSelectionLinks={workspace.listMarkdownSelectionLinks}
        onSave={workspace.saveActiveTab}
        onSetDraft={(value, options) => {
          if (tab) workspace.setTabDraft(tab.id, value, options);
        }}
        onRegisterEditorDraft={workspace.registerEditorDraft}
        onSetViewState={workspace.setActiveTabViewState}
        onStartScreenshotSnip={workspace.startScreenshotSnip}
      />
    );
  }

  if (!authenticated) {
    return (
      <LoginScreen
        yourName={yourName}
        authError={workspace.authError}
        busy={workspace.busy}
        password={workspace.password}
        onLogin={workspace.handleLogin}
        onPasswordChange={workspace.setPassword}
      />
    );
  }

  return (
    <MarkdownDisplayPreferencesProvider initialPreferences={markdownDisplayPreferences}>
    <QuickPromptsContext.Provider value={quickPrompts}>
    <WorkspaceViewContext.Provider value={{ view: workspace.workspaceManager.activeWorkspace?.view, updateView: workspace.workspaceManager.updateView }}>
    <MarkdownReviewProvider activeTab={workspace.activeTab} getDraft={workspace.getReviewDraft} applyDraft={workspace.applyReviewDraft} recoverDraft={workspace.recoverReviewDraft} openChat={() => changeChatCollapsed(false)} openComments={openComments}>
    <ReviewPaletteCommands />
    <DefinitionsPaletteCommands activeTab={workspace.activeTab} onShow={() => { changeLeftPanel("outlines"); setNotebooksCollapsed(false); }} />
    <PdfOutlinePaletteCommands
      activeTab={workspace.activeTab}
      onShowOutlines={() => { changeLeftPanel("outlines"); setNotebooksCollapsed(false); showOutlineView("outline"); }}
      onShowAnnotations={() => { changeLeftPanel("pdf-annotations"); setNotebooksCollapsed(false); }}
    />
    <CollabProvider
      onNotebookJoined={async (notebook) => {
        await workspace.refreshTree(notebook).catch(() => undefined);
        workspace.selectNotebook(notebook);
        changeLeftPanel("notebook");
      }}
      onOpenPath={agentWorkspace.openFile}
      onOpenAlbum={(target) => {
        requestSharedAlbum(target);
        changeLeftPanel("gallery");
      }}
    >
    <MeetingRecorderProvider
      visibleTabIds={visibleCanvasTabIds}
      tabs={{
        open: workspace.openRecordingTab,
        rename: workspace.renameRecordingTab,
        close: workspace.closeRecordingTab,
        // The recording's tab becomes the saved voice memo; the recap note opens beside it.
        saved: (recordingId, { path, recapPath }, notebook) => {
          void (async () => {
            await workspace.refreshTree(notebook).catch(() => undefined);
            await workspace.replaceRecordingTab(recordingId, path).catch(() => agentWorkspace.openFile(path));
            if (recapPath) agentWorkspace.openFile(recapPath);
          })();
        },
      }}
    >
    <main className="libera-app-shell flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <div
        inert={workspace.workspaceManager.switching || (Boolean(workspace.fullTree.root) && !workspace.workspaceManager.ready)}
        ref={mainLayoutRef}
        className="relative grid min-h-0 flex-1 overflow-hidden libera-main-layout lg:grid-cols-[var(--libera-sidebar-width)_minmax(0,1fr)_var(--libera-chat-width)]"
        style={
          {
            "--libera-sidebar-width": `${notebooksCollapsed ? 48 : sidebarWidth}px`,
            "--libera-chat-width": `${chatCollapsed ? 0 : chatWidth}px`,
          } as CSSProperties
        }
      >
        <LeftPanel
          workspaceManager={workspace.workspaceManager}
          fullTree={workspace.fullTree}
          activePanel={activeLeftPanel}
          onPanelChange={changeLeftPanel}
          activeTab={workspace.activeTab}
          activeTabId={workspace.activeTabId}
          collapsed={notebooksCollapsed}
          expanded={workspace.expanded}
          fileInteractions={workspace.fileInteractions}
          query={workspace.query}
          searchResults={workspace.searchResults}
          selectedNotebookName={workspace.selectedNotebook?.name ?? ""}
          tree={workspace.tree}
          textareaRef={workspace.textareaRef}
          mathMarkers={markdownPreferences}
          uploadInputRef={workspace.uploadInputRef}
          onArchiveFile={workspace.archiveFileNode}
          onArchiveFolder={workspace.archiveFolderNode}
          onDuplicateMarkdown={workspace.duplicateMarkdown}
          onCopyFile={workspace.copyFileFromPrompt}
          onCreateFolder={workspace.createFolderFromPrompt}
          onCreateMarkdown={workspace.createMarkdownFromPrompt}
          onCreateSlides={workspace.createMarkdownSlidesFromPrompt}
          onCreateLatex={workspace.createLatexFromPrompt}
          onCreateNotebook={workspace.openCreateNotebookDialog}
          onCreateNotebookGroup={workspace.openCreateNotebookGroupDialog}
          onDeleteFile={workspace.deleteFileNodeFromPrompt}
          onDeleteFolder={workspace.deleteFolderFromPrompt}
          onDeleteNotebookGroup={workspace.deleteNotebookGroup}
          onDownloadFile={workspace.downloadFile}
          onDeleteNotebook={workspace.deleteNotebookFromPrompt}
          onDownloadNotebook={workspace.downloadNotebook}
          onEditNotebook={workspace.openEditNotebookDialog}
          onEditNotebookGroup={workspace.openEditNotebookGroupDialog}
          onMoveFile={workspace.moveFileToFolder}
          onOpenFile={workspace.openFile}
          onLogout={workspace.handleLogout}
          onQueryChange={workspace.setQuery}
          onRenameFolder={workspace.renameFolderFromPrompt}
          onRenameFile={workspace.renameFileNodeFromPrompt}
          onSelectNotebook={workspace.selectNotebook}
          onSelectSearchResult={workspace.selectSearchResult}
          onSetDraft={workspace.setActiveDraft}
          onStartUpload={workspace.startUpload}
          onToggleFileStar={workspace.toggleFileStar}
          onEditFileTags={workspace.openFileTagsDialog}
          onToggleCollapsed={() => setNotebooksCollapsed((current) => !current)}
          onGeneratedFilesSaved={(files) => {
            void workspace.refreshTree(files[0]?.notebook).catch(() => undefined);
          }}
          onToggleNotebook={workspace.toggleNotebook}
          onOpenSearchPreferences={openSearchPreferences}
          references={references}
          onUploadChange={workspace.handleUploadChange}
          onUploadFiles={workspace.uploadFilesToNotebook}
          onUpdateNotebookViewOptions={workspace.updateNotebookViewOptions}
          canOpenDirectories={workspace.canOpenDirectories}
          onOpenDirectory={() => void workspace.openDirectory()}
          onCloseDirectory={workspace.closeDirectory}
        />

        <section className="libera-workspace-region relative flex min-h-0 min-w-0 flex-col overflow-hidden" data-ai-active={aiActive}>
          <div aria-hidden className="libera-ai-glow" />
          {/* The gallery and the Search page cover the canvas instead of
              replacing it, so open editors keep their state. They sit above
              the editors' sticky toolbars (up to z-40) and below menus (z-50). */}
          {activeLeftPanel === "gallery" ? (
            <div className="absolute inset-0 z-[45] flex min-h-0 flex-col" data-command-scope="2">
              <ImageGalleryView onOpenInCanvas={openGalleryPhoto} chat={galleryChat} onViewingPhotoChange={setGalleryViewingPhoto} />
            </div>
          ) : activeLeftPanel === "search" ? (
            <div className="absolute inset-0 z-[45] flex min-h-0 flex-col" data-command-scope="2">
              <SearchView
                files={workspace.files}
                scope={searchScope}
                includeArchive={searchIncludesArchive}
                mathMarkers={markdownPreferences}
                focusRequest={searchFocusRequest}
                onOpenResult={openSearchResult}
                onClose={() => setActiveLeftPanel(lastCanvasPanelRef.current)}
                onOpenPreferences={openSearchPreferences}
              />
            </div>
          ) : null}
          <div className="contents" inert={galleryOpen}>
          <TabStrip
            chatOpen={!chatCollapsed}
            onToggleChat={() => changeChatCollapsed(!chatCollapsed)}
            onCreateUntitled={() => workspace.createUntitledFile()}
            markdownEditorMode={markdownEditorMode}
            onMarkdownEditorModeChange={(mode) => {
              workspace.setActiveTabViewState({ markdown: { editorMode: mode } });
              setActivePreviewTabId(null);
            }}
            activeTab={workspace.activeTab}
            activeTabId={workspace.activeTabId}
            notebookColors={notebookColors}
            tabs={workspace.tabs}
            onActivateTab={workspace.setActiveTabId}
            onAddToAiChat={(tab) => {
              setChatAttachmentRequest({ id: crypto.randomUUID(), tab });
              changeChatCollapsed(false);
            }}
            onCloseOtherTabs={workspace.closeOtherTabs}
            onCloseTab={workspace.closeTab}
            onDeleteFile={workspace.deleteFileFromPrompt}
            onDownloadAnnotatedPdf={(tab) => workspace.downloadAnnotatedPdf(tab, markdownPreferences)}
            onDownloadFile={workspace.downloadFile}
            onDuplicateMarkdown={workspace.duplicateMarkdown}
            onDownloadMarkdownPdf={workspace.downloadMarkdownPdf}
            onMoveFile={workspace.moveFileFromPrompt}
            onRenameFile={workspace.renameFileFromPrompt}
            onSave={workspace.saveActiveTab}
            onSwapTabs={workspace.swapTabs}
            visibleTabIds={visibleCanvasTabIds}
            canvasPanelCount={canvas.paneCount}
            onSplitCanvas={(zone) => canvas.splitPane(canvas.layout.focusedPaneId, zone)}
            onOpenTabInSplit={(tabId, zone) => canvas.splitPane(canvas.layout.focusedPaneId, zone, tabId)}
            onCloseCanvasPanel={() => canvas.closePane(canvas.layout.focusedPaneId)}
            onCloseOtherCanvasPanels={() => canvas.closeOtherPanes(canvas.layout.focusedPaneId)}
          />

          {workspace.workspaceError ? (
            <div className="border-b border-destructive/40 bg-destructive-muted px-4 py-2 text-sm text-destructive">
              {workspace.workspaceError}
            </div>
          ) : null}

          <CanvasSplitView
            layout={canvas.layout}
            tabs={workspace.tabs}
            renderPane={renderCanvasPane}
            onFocusPane={canvas.focusPane}
            onSplitPane={canvas.splitPane}
            onClosePane={canvas.closePane}
            onPlaceTab={canvas.placeTab}
            onDropTab={canvas.dropTab}
            onResizeSplit={canvas.resizeSplit}
          />
          </div>
        </section>

        <DocumentChatPanel agentWorkspace={agentWorkspace} viewedPhoto={chatViewedPhoto} files={workspace.files} tabs={workspace.tabs} attachmentRequest={chatAttachmentRequest} onAttachmentHandled={(id) => setChatAttachmentRequest((current) => current?.id === id ? null : current)} quickPrompts={quickPrompts} onCreateDraft={(snapshot) => workspace.createUntitledFile("", undefined, snapshot)} onSaveToNotebook={workspace.saveChatToNotebook} activeTab={workspace.activeTab} collapsed={chatCollapsed} mathMarkers={markdownPreferences} onCollapsedChange={changeChatCollapsed} />
        {!chatCollapsed && <div
          role="separator" aria-label="Resize document chat" aria-orientation="vertical"
          aria-valuemin={280} aria-valuemax={560} aria-valuenow={chatWidth} tabIndex={0}
          className="absolute bottom-0 top-0 z-40 hidden w-1.5 translate-x-1/2 cursor-col-resize touch-none focus-visible:bg-accent lg:block"
          style={{ right: chatWidth }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const width = Math.max(280, Math.min(560, chatWidth + (event.key === "ArrowLeft" ? 16 : -16)));
            setChatWidth(width); saveChatPanel(width, chatCollapsed);
          }}
          onLostPointerCapture={() => setChatResizing(false)} onPointerCancel={() => setChatResizing(false)}
          onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setChatResizing(true); }}
          onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setChatWidth(chatWidthFromPointer(event.clientX)); }}
          onPointerUp={(event) => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const width = chatWidthFromPointer(event.clientX); setChatWidth(width); setChatResizing(false); saveChatPanel(width, chatCollapsed); event.currentTarget.releasePointerCapture(event.pointerId); }}
        />}

        {!notebooksCollapsed ? (
          <div
            aria-hidden
            className="absolute bottom-0 top-0 z-40 hidden w-1.5 -translate-x-1/2 cursor-col-resize touch-none lg:block"
            style={{ left: sidebarWidth }}
            onLostPointerCapture={() => setSidebarResizing(false)}
            onPointerCancel={() => setSidebarResizing(false)}
            onPointerDown={(event) => {
              if (event.button !== 0) {
                return;
              }

              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              setSidebarResizing(true);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                resizeSidebar(event);
              }
            }}
            onPointerUp={finishSidebarResize}
          />
        ) : null}
      </div>

      {workspace.workspaceManager.loadError && <div role="alert" className="border-t border-destructive/30 bg-card px-4 py-2 text-sm text-destructive">{workspace.workspaceManager.loadError} <button className="underline" onClick={workspace.workspaceManager.retry}>Retry loading workspaces</button></div>}
      <ReferenceMoveNotice key={workspace.referenceMoveNotice?.id} notice={workspace.referenceMoveNotice} onDismiss={workspace.dismissReferenceMoveNotice} />
      {(workspace.workspaceManager.switching || (Boolean(workspace.fullTree.root) && !workspace.workspaceManager.ready && !workspace.workspaceManager.loadError)) && <div role="status" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-border bg-card px-5 py-2 text-sm shadow-lg">{workspace.workspaceManager.switching ? "Saving your place…" : "Opening your workspace…"}</div>}
      <NotebookDialog
        dialog={workspace.notebookDialog}
        groups={workspace.tree.notebookGroups}
        submitting={workspace.notebookDialogSubmitting}
        onClose={workspace.closeNotebookDialog}
        onSubmit={workspace.submitNotebookDialog}
      />
      <NotebookGroupDialog
        dialog={workspace.notebookGroupDialog}
        submitting={workspace.notebookGroupDialogSubmitting}
        tree={workspace.workspaceManager.organizedTree}
        onClose={workspace.closeNotebookGroupDialog}
        onSubmit={workspace.submitNotebookGroupDialog}
      />
      <LocalModelDialog />
      <SnipReadingCard session={workspace.screenshotSnipSession} onCancel={workspace.cancelScreenshotSnip} />
      {workspace.saveDraftTab ? <SaveDraftDialog key={workspace.saveDraftTab.id} tab={workspace.saveDraftTab} tree={workspace.fullTree} error={workspace.saveDraftError} submitting={workspace.saveDraftSubmitting} onClose={workspace.closeSaveDraftDialog} onSubmit={workspace.submitSaveDraft} /> : null}
      <SaveImageToNotebookDialog tree={workspace.fullTree} onUpload={workspace.uploadFiles} />
      <SaveImageToNewAlbumDialog />
      <NoteDialog
        dialog={workspace.noteDialog}
        submitting={workspace.noteDialogSubmitting}
        onClose={workspace.closeNoteDialog}
        onSubmit={workspace.submitNoteDialog}
      />
      <FileTagsDialog
        dialog={workspace.fileTagsDialog}
        fileTags={workspace.tree.fileTags}
        onClose={workspace.closeFileTagsDialog}
        onSubmit={workspace.saveFileTags}
      />
      <WorkspaceInputDialog
        dialog={workspace.workspaceInputDialog}
        submitting={workspace.workspaceInputDialogSubmitting}
        onClose={workspace.closeWorkspaceInputDialog}
        onSubmit={workspace.submitWorkspaceInputDialog}
      />
      <WorkspaceConfirmDialog
        dialog={workspace.workspaceConfirmDialog}
        submitting={workspace.workspaceConfirmDialogSubmitting}
        onClose={workspace.closeWorkspaceConfirmDialog}
        onConfirm={workspace.submitWorkspaceConfirmDialog}
      />
      <CommandPalette
        tree={workspace.tree}
        recentFiles={workspace.recentFiles}
        selectedNotebookName={workspace.selectedNotebook?.name}
        onOpenFile={(file, placement) => {
          // The gallery and the Search page cover the canvas; uncover it so the file is seen.
          if (galleryOpen) setActiveLeftPanel(lastCanvasPanelRef.current);
          void workspace.openFile(file, { placement });
        }}
      />
      <ReviewPopover />
      <PdfQuoteCiteHost />
      <ReadAloudBar />
    </main>
    </MeetingRecorderProvider>
    </CollabProvider>
    </MarkdownReviewProvider>
    </WorkspaceViewContext.Provider>
    </QuickPromptsContext.Provider>
    </MarkdownDisplayPreferencesProvider>
  );
}
