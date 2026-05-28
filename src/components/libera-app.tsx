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
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-zinc-100 text-zinc-950">
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
            activeTabId={workspace.activeTabId}
            notebookColors={notebookColors}
            tabs={workspace.tabs}
            onActivateTab={workspace.setActiveTabId}
            onCloseTab={workspace.closeTab}
            onSwapTabs={workspace.swapTabs}
          />

          {workspace.workspaceError ? (
            <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {workspace.workspaceError}
            </div>
          ) : null}

          <WorkspacePanel
            activeTab={workspace.activeTab}
            aiFormatting={workspace.aiFormatting}
            canStartScreenshotSnip={workspace.canStartScreenshotSnip}
            firstNotebook={workspace.firstNotebook}
            imageMarkdownConverting={workspace.imageMarkdownConverting}
            screenshotSnipSession={workspace.screenshotSnipSession}
            selectedNotebook={workspace.selectedNotebook}
            textareaRef={workspace.textareaRef}
            onAiFormatSelection={workspace.formatSelectionWithAi}
            onAiImageToMarkdown={workspace.convertImageToMarkdownWithAi}
            onCreateMarkdown={workspace.createMarkdownFromPrompt}
            onCreateNotebook={workspace.openCreateNotebookDialog}
            onCancelScreenshotSnip={workspace.cancelScreenshotSnip}
            onCompleteScreenshotSnip={workspace.completeScreenshotSnip}
            onDeleteFile={workspace.deleteFileFromPrompt}
            onDownloadFile={workspace.downloadFile}
            onInsertExistingImage={workspace.insertExistingMarkdownImage}
            onInsertImage={workspace.insertMarkdownImage}
            onInsertMarkdown={workspace.insertMarkdown}
            onMoveFile={workspace.moveFileFromPrompt}
            onOpenFile={workspace.openFile}
            onRenameFile={workspace.renameFileFromPrompt}
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
