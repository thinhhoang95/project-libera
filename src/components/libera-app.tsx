"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { LeftPanel } from "@/components/libera/left-panel";
import { LoginScreen } from "@/components/libera/login-screen";
import { NoteDialog } from "@/components/libera/note-dialog";
import { NotebookDialog } from "@/components/libera/notebook-dialog";
import { NotebookGroupDialog } from "@/components/libera/notebook-group-dialog";
import { SaveDraftDialog } from "@/components/libera/save-draft-dialog";
import { TabStrip } from "@/components/libera/tab-strip";
import { useLiberaWorkspace } from "@/components/libera/use-libera-workspace";
import { WorkspaceConfirmDialog } from "@/components/libera/workspace-confirm-dialog";
import { WorkspaceInputDialog } from "@/components/libera/workspace-input-dialog";
import { WorkspacePanel } from "@/components/libera/workspace-panel";
import type { MarkdownPreferences } from "@/lib/markdown-preferences";

type LiberaAppProps = {
  initialAuthenticated: boolean;
  markdownPreferences: MarkdownPreferences;
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

export function LiberaApp({
  initialAuthenticated,
  markdownPreferences,
}: LiberaAppProps) {
  const { authenticated, workspace } = useLiberaWorkspace(initialAuthenticated);
  const [notebooksCollapsed, setNotebooksCollapsed] = useState(false);
  const markdownEditorMode = workspace.activeTab?.viewState?.markdown?.editorMode ?? "visual";
  const [activePreviewTabId, setActivePreviewTabId] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [sidebarResizing, setSidebarResizing] = useState(false);
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
    const unsavedDocumentCount = workspace.tabs.filter(
      (tab) => tab.file.fileType === "markdown" && tab.draft !== tab.saved,
    ).length;

    void window.liberaUpdater?.setDirtyDocumentCount(unsavedDocumentCount).catch(() => undefined);
  }, [workspace.tabs]);

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
    if (!sidebarResizing) {
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
  }, [sidebarResizing]);

  function sidebarWidthFromPointer(clientX: number) {
    const layoutBounds = mainLayoutRef.current?.getBoundingClientRect();

    return clampSidebarWidth(
      clientX - (layoutBounds?.left ?? 0),
      layoutBounds?.width,
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

  if (!authenticated) {
    return (
      <LoginScreen
        authError={workspace.authError}
        busy={workspace.busy}
        password={workspace.password}
        onLogin={workspace.handleLogin}
        onPasswordChange={workspace.setPassword}
      />
    );
  }

  return (
    <main className="libera-app-shell flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <div
        ref={mainLayoutRef}
        className="relative grid min-h-0 flex-1 overflow-hidden lg:grid-cols-[var(--libera-sidebar-width)_minmax(0,1fr)]"
        style={
          {
            "--libera-sidebar-width": `${notebooksCollapsed ? 48 : sidebarWidth}px`,
          } as CSSProperties
        }
      >
        <LeftPanel
          activeTab={workspace.activeTab}
          activeTabId={workspace.activeTabId}
          collapsed={notebooksCollapsed}
          expanded={workspace.expanded}
          fileInteractions={workspace.fileInteractions}
          query={workspace.query}
          searchResults={workspace.searchResults}
          selectedNotebookName={workspace.selectedNotebookName}
          tree={workspace.tree}
          textareaRef={workspace.textareaRef}
          uploadInputRef={workspace.uploadInputRef}
          onArchiveFile={workspace.archiveFileNode}
          onArchiveFolder={workspace.archiveFolderNode}
          onCopyFile={workspace.copyFileFromPrompt}
          onCreateFolder={workspace.createFolderFromPrompt}
          onCreateMarkdown={workspace.createMarkdownFromPrompt}
          onCreateSlides={workspace.createMarkdownSlidesFromPrompt}
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
          onToggleCollapsed={() => setNotebooksCollapsed((current) => !current)}
          onToggleNotebook={workspace.toggleNotebook}
          onUploadChange={workspace.handleUploadChange}
          onUploadFiles={workspace.uploadFilesToNotebook}
          onUpdateNotebookViewOptions={workspace.updateNotebookViewOptions}
        />

        <section className="libera-workspace-region flex min-h-0 min-w-0 flex-col overflow-hidden">
          <TabStrip
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
            onCloseOtherTabs={workspace.closeOtherTabs}
            onCloseTab={workspace.closeTab}
            onDeleteFile={workspace.deleteFileFromPrompt}
            onDownloadFile={workspace.downloadFile}
            onDownloadMarkdownPdf={workspace.downloadMarkdownPdf}
            onMoveFile={workspace.moveFileFromPrompt}
            onRenameFile={workspace.renameFileFromPrompt}
            onSave={workspace.saveActiveTab}
            onSwapTabs={workspace.swapTabs}
          />

          {workspace.workspaceError ? (
            <div className="border-b border-destructive/40 bg-destructive-muted px-4 py-2 text-sm text-destructive">
              {workspace.workspaceError}
            </div>
          ) : null}

          <WorkspacePanel
            markdownEditorMode={markdownEditorMode}
            activePreviewTabId={activePreviewTabId}
            onActivePreviewTabIdChange={setActivePreviewTabId}
            activeTab={workspace.activeTab}
            aiFormatting={workspace.aiFormatting}
            canStartScreenshotSnip={workspace.canStartScreenshotSnip}
            files={workspace.files}
            firstNotebook={workspace.firstNotebook}
            imageMarkdownConverting={workspace.imageMarkdownConverting}
            markdownPreferences={markdownPreferences}
            recentFiles={workspace.recentFiles}
            screenshotSnipSession={workspace.screenshotSnipSession}
            selectedNotebook={workspace.selectedNotebook}
            tabs={workspace.tabs}
            textareaRef={workspace.textareaRef}
            onAiFormatSelection={workspace.formatSelectionWithAi}
            onAiImageToMarkdown={workspace.convertImageToMarkdownWithAi}
            onAiRewriteSelection={workspace.rewriteSelectionWithAi}
            onCreateMarkdown={workspace.createMarkdownFromPrompt}
            onCreateSlides={workspace.createMarkdownSlidesFromPrompt}
            onCreateNotebook={workspace.openCreateNotebookDialog}
            onCancelScreenshotSnip={workspace.cancelScreenshotSnip}
            onCompleteScreenshotSnip={workspace.completeScreenshotSnip}
            onInsertExistingImage={workspace.insertExistingMarkdownImage}
            onInsertFileLink={workspace.insertMarkdownFileLink}
            onInsertFileLinkPlaceholder={workspace.insertMarkdownFileLinkPlaceholder}
            onInsertImage={workspace.insertMarkdownImage}
            onInsertMarkdown={workspace.insertMarkdown}
            onOpenFile={workspace.openFile}
            onOpenMarkdownFileLink={workspace.openMarkdownFileLink}
            onSave={workspace.saveActiveTab}
            onSetDraft={workspace.setActiveDraft}
            onSetViewState={workspace.setActiveTabViewState}
            onStartScreenshotSnip={workspace.startScreenshotSnip}
          />
        </section>

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
        tree={workspace.tree}
        onClose={workspace.closeNotebookGroupDialog}
        onSubmit={workspace.submitNotebookGroupDialog}
      />
      {workspace.saveDraftTab ? <SaveDraftDialog key={workspace.saveDraftTab.id} tab={workspace.saveDraftTab} tree={workspace.tree} error={workspace.saveDraftError} submitting={workspace.saveDraftSubmitting} onClose={workspace.closeSaveDraftDialog} onSubmit={workspace.submitSaveDraft} /> : null}
      <NoteDialog
        dialog={workspace.noteDialog}
        submitting={workspace.noteDialogSubmitting}
        onClose={workspace.closeNoteDialog}
        onSubmit={workspace.submitNoteDialog}
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
    </main>
  );
}
