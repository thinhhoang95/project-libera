"use client";

import { MarkdownReviewProvider } from "@/components/libera/markdown-review-context";
import { ReviewPopover } from "@/components/libera/markdown-review-ui";
import { MarkdownDisplayPreferencesProvider } from "@/components/libera/markdown-display-preferences";
import { QuickPromptsContext } from "@/components/libera/quick-prompt-input";
import type { MarkdownDisplayPreferences } from "@/lib/markdown-display-preferences";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { apiRequest } from "@/components/libera/api-client";
import { createDeferredSave, registerStateFlusher } from "@/components/libera/deferred-save";
import { DocumentChatPanel, type AgentWorkspaceBridge, type ChatViewedPhoto } from "@/components/libera/document-chat-panel";
import { ImageGalleryView } from "@/components/libera/image-gallery-view";
import { SearchView } from "@/components/libera/global-search/search-view";
import { galleryPhotoFromSearch, searchRevealViewState } from "@/components/libera/global-search/reveal";
import type { SearchEntry } from "@/components/libera/global-search/search-results";
import { LeftPanel, type LeftPanelReferences, type LeftPanelTab } from "@/components/libera/left-panel";
import { useReferencesPanelRequests } from "@/components/libera/references/references-panel";
import { PdfQuoteCiteHost } from "@/components/libera/references/pdf-quote-cite";
import { CollabProvider } from "@/components/libera/collab/collab-provider";
import { LoginScreen } from "@/components/libera/login-screen";
import { NoteDialog } from "@/components/libera/note-dialog";
import { NotebookDialog } from "@/components/libera/notebook-dialog";
import { WorkspaceViewContext } from "@/components/libera/workspace-view-context";
import { NotebookGroupDialog } from "@/components/libera/notebook-group-dialog";
import { SaveDraftDialog } from "@/components/libera/save-draft-dialog";
import { useAiActivity } from "@/lib/ai-activity";
import { TabStrip } from "@/components/libera/tab-strip";
import type { OpenTab } from "@/components/libera/types";
import type { GalleryTabPlacement } from "@/components/libera/gallery-tabs";
import { galleryRawUrl, type GalleryPhoto } from "@/lib/image-generation";
import { useLiberaWorkspace } from "@/components/libera/use-libera-workspace";
import { WorkspaceConfirmDialog } from "@/components/libera/workspace-confirm-dialog";
import { FileTagsDialog } from "@/components/libera/file-tags-dialog";
import { DocumentOcrModelDialog } from "@/components/libera/document-ocr/document-ocr-model-dialog";
import { SnipReadingCard } from "@/components/libera/document-ocr/snip-reading-card";
import { WorkspaceInputDialog } from "@/components/libera/workspace-input-dialog";
import { WorkspacePanel } from "@/components/libera/workspace-panel";
import { CanvasSplitView } from "@/components/libera/canvas-split-view";
import { visibleCanvasTabIds as visibleCanvasTabIdsOf, type CanvasPaneNode } from "@/lib/canvas-layout";
import type { MarkdownPreferences } from "@/lib/markdown-preferences";
import type { QuickPrompt } from "@/lib/quick-prompts";
import { type LiberaFileNode, type LiberaFilePayload, type LiberaTreeNode } from "@/lib/types";
import { dirtyDocumentCount } from "@/lib/collab/client/workspace";

type LiberaAppProps = {
  yourName?: string;
  initialAuthenticated: boolean;
  markdownPreferences: MarkdownPreferences;
  markdownDisplayPreferences?: Partial<MarkdownDisplayPreferences>;
  quickPrompts?: QuickPrompt[];
};

const SIDEBAR_WIDTH_STORAGE_KEY = "libera.sidebarWidth";
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
  const { authenticated, workspace } = useLiberaWorkspace(initialAuthenticated);
  const [notebooksCollapsed, setNotebooksCollapsed] = useState(false);
  const [activeLeftPanel, setActiveLeftPanel] = useState<LeftPanelTab>("notebook");
  // Opening a gallery photo or a search result in the canvas returns to the
  // panel used before the gallery or the Search page covered it.
  const lastCanvasPanelRef = useRef<Exclude<LeftPanelTab, "gallery" | "search">>("notebook");
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const changeLeftPanel = useCallback((panel: LeftPanelTab) => {
    if (panel === "search") setSearchFocusRequest((request) => request + 1);
    else if (panel !== "gallery") lastCanvasPanelRef.current = panel;
    setActiveLeftPanel(panel);
  }, []);
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
    onOpenPath: agentWorkspace.openFile,
    onUploadFiles: workspace.uploadFiles,
    request: referenceRequests.request,
    onRequestHandled: referenceRequests.handled,
  };

  const canvas = workspace.canvas;
  // Leaving the gallery uncovers the canvas, so the photo opens where it can be seen.
  function openGalleryPhoto(photo: GalleryPhoto, placement: GalleryTabPlacement) {
    setActiveLeftPanel(lastCanvasPanelRef.current);
    workspace.openGalleryPhoto(photo, placement);
  }

  // Global Search opens a hit at its passage: the page, section or lines.
  function openSearchResult({ result, hit }: SearchEntry, placement: "tab" | "right") {
    setActiveLeftPanel(lastCanvasPanelRef.current);
    if (result.source === "gallery") {
      if (result.photo) workspace.openGalleryPhoto(galleryPhotoFromSearch(result.photo), placement);
      return;
    }
    const file = workspace.files.find((candidate) => candidate.path === result.path) ?? result.file;
    if (!file) return;
    const target = result.hits[hit] ?? result.hits[0];
    void workspace.openFile(file, { viewState: searchRevealViewState(result.kind, target), placement });
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
        onInsertExistingImage={workspace.insertExistingMarkdownImage}
        onInsertFileLink={workspace.insertMarkdownFileLink}
        onInsertFileLinkPlaceholder={workspace.insertMarkdownFileLinkPlaceholder}
        onInsertImage={workspace.insertMarkdownImage}
        onInsertMarkdown={workspace.insertMarkdown}
        onOpenFile={workspace.openFile}
        onShowImage={(file) => {
          if (tab) workspace.showImageInTab(tab.id, file);
        }}
        onSaveEditedImageCopy={workspace.saveEditedImageCopy}
        onOpenMarkdownFileLink={workspace.openMarkdownFileLink}
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
    <CollabProvider
      onNotebookJoined={async (notebook) => {
        await workspace.refreshTree(notebook).catch(() => undefined);
        workspace.selectNotebook(notebook);
        changeLeftPanel("notebook");
      }}
      onOpenPath={agentWorkspace.openFile}
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
            <div className="absolute inset-0 z-[45] flex min-h-0 flex-col">
              <ImageGalleryView onOpenInCanvas={openGalleryPhoto} chat={galleryChat} onViewingPhotoChange={setGalleryViewingPhoto} />
            </div>
          ) : activeLeftPanel === "search" ? (
            <div className="absolute inset-0 z-[45] flex min-h-0 flex-col">
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
      <DocumentOcrModelDialog />
      <SnipReadingCard session={workspace.screenshotSnipSession} onCancel={workspace.cancelScreenshotSnip} />
      {workspace.saveDraftTab ? <SaveDraftDialog key={workspace.saveDraftTab.id} tab={workspace.saveDraftTab} tree={workspace.fullTree} error={workspace.saveDraftError} submitting={workspace.saveDraftSubmitting} onClose={workspace.closeSaveDraftDialog} onSubmit={workspace.submitSaveDraft} /> : null}
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
      <ReviewPopover />
      <PdfQuoteCiteHost />
    </main>
    </CollabProvider>
    </MarkdownReviewProvider>
    </WorkspaceViewContext.Provider>
    </QuickPromptsContext.Provider>
    </MarkdownDisplayPreferencesProvider>
  );
}
