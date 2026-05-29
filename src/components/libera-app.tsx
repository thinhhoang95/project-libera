"use client";

import { useMemo, useState } from "react";
import { LoginScreen } from "@/components/libera/login-screen";
import { NoteDialog } from "@/components/libera/note-dialog";
import { NotebookDialog } from "@/components/libera/notebook-dialog";
import { NotebookSidebar } from "@/components/libera/notebook-sidebar";
import { TabStrip } from "@/components/libera/tab-strip";
import { useLiberaWorkspace } from "@/components/libera/use-libera-workspace";
import { WorkspaceConfirmDialog } from "@/components/libera/workspace-confirm-dialog";
import { WorkspaceInputDialog } from "@/components/libera/workspace-input-dialog";
import { WorkspacePanel } from "@/components/libera/workspace-panel";

type LiberaAppProps = {
  initialAuthenticated: boolean;
};

export function LiberaApp({ initialAuthenticated }: LiberaAppProps) {
  const { authenticated, workspace } = useLiberaWorkspace(initialAuthenticated);
  const [notebooksCollapsed, setNotebooksCollapsed] = useState(false);
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
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <div
        className={`grid min-h-0 flex-1 overflow-hidden ${
          notebooksCollapsed ? "lg:grid-cols-[56px_1fr]" : "lg:grid-cols-[320px_1fr]"
        }`}
      >
        <NotebookSidebar
          activeTabId={workspace.activeTabId}
          collapsed={notebooksCollapsed}
          expanded={workspace.expanded}
          fileInteractions={workspace.fileInteractions}
          query={workspace.query}
          searchResults={workspace.searchResults}
          selectedNotebookName={workspace.selectedNotebookName}
          tree={workspace.tree}
          uploadInputRef={workspace.uploadInputRef}
          onCopyFile={workspace.copyFileFromPrompt}
          onCreateFolder={workspace.createFolderFromPrompt}
          onCreateMarkdown={workspace.createMarkdownFromPrompt}
          onCreateNotebook={workspace.openCreateNotebookDialog}
          onDeleteFile={workspace.deleteFileNodeFromPrompt}
          onDeleteFolder={workspace.deleteFolderFromPrompt}
          onDownloadFile={workspace.downloadFile}
          onDeleteNotebook={workspace.deleteNotebookFromPrompt}
          onDownloadNotebook={workspace.downloadNotebook}
          onEditNotebook={workspace.openEditNotebookDialog}
          onMoveFile={workspace.moveFileToFolder}
          onOpenFile={workspace.openFile}
          onLogout={workspace.handleLogout}
          onQueryChange={workspace.setQuery}
          onRenameFolder={workspace.renameFolderFromPrompt}
          onRenameFile={workspace.renameFileNodeFromPrompt}
          onSelectNotebook={workspace.selectNotebook}
          onSelectSearchResult={workspace.selectSearchResult}
          onStartUpload={workspace.startUpload}
          onToggleCollapsed={() => setNotebooksCollapsed((current) => !current)}
          onToggleNotebook={workspace.toggleNotebook}
          onUploadChange={workspace.handleUploadChange}
          onUploadFiles={workspace.uploadFilesToNotebook}
        />

        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <TabStrip
            activeTab={workspace.activeTab}
            activeTabId={workspace.activeTabId}
            notebookColors={notebookColors}
            tabs={workspace.tabs}
            onActivateTab={workspace.setActiveTabId}
            onCloseTab={workspace.closeTab}
            onDeleteFile={workspace.deleteFileFromPrompt}
            onDownloadFile={workspace.downloadFile}
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
            activeTab={workspace.activeTab}
            aiFormatting={workspace.aiFormatting}
            canStartScreenshotSnip={workspace.canStartScreenshotSnip}
            files={workspace.files}
            firstNotebook={workspace.firstNotebook}
            imageMarkdownConverting={workspace.imageMarkdownConverting}
            recentFiles={workspace.recentFiles}
            screenshotSnipSession={workspace.screenshotSnipSession}
            selectedNotebook={workspace.selectedNotebook}
            tabs={workspace.tabs}
            textareaRef={workspace.textareaRef}
            onAiFormatSelection={workspace.formatSelectionWithAi}
            onAiImageToMarkdown={workspace.convertImageToMarkdownWithAi}
            onAiRewriteSelection={workspace.rewriteSelectionWithAi}
            onCreateMarkdown={workspace.createMarkdownFromPrompt}
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
      </div>

      <NotebookDialog
        dialog={workspace.notebookDialog}
        submitting={workspace.notebookDialogSubmitting}
        onClose={workspace.closeNotebookDialog}
        onSubmit={workspace.submitNotebookDialog}
      />
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
