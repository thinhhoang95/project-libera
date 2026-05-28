"use client";

import { AppHeader } from "@/components/libera/app-header";
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
    <main className="flex min-h-screen flex-col bg-zinc-100 text-zinc-950">
      <AppHeader
        query={workspace.query}
        searchResults={workspace.searchResults}
        onLogout={workspace.handleLogout}
        onQueryChange={workspace.setQuery}
        onSelectSearchResult={workspace.selectSearchResult}
      />

      <div className="grid min-h-0 flex-1 lg:grid-cols-[320px_1fr]">
        <NotebookSidebar
          activeTabId={workspace.activeTabId}
          expanded={workspace.expanded}
          selectedNotebookName={workspace.selectedNotebookName}
          tree={workspace.tree}
          uploadInputRef={workspace.uploadInputRef}
          onCopyFile={workspace.copyFileFromPrompt}
          onCreateFolder={workspace.createFolderFromPrompt}
          onCreateMarkdown={workspace.createMarkdownFromPrompt}
          onCreateNotebook={workspace.openCreateNotebookDialog}
          onDeleteFile={workspace.deleteFileNodeFromPrompt}
          onDeleteFolder={workspace.deleteFolderFromPrompt}
          onDeleteNotebook={workspace.deleteNotebookFromPrompt}
          onDownloadNotebook={workspace.downloadNotebook}
          onEditNotebook={workspace.openEditNotebookDialog}
          onMoveFile={workspace.moveFileToFolder}
          onOpenFile={workspace.openFile}
          onRenameFolder={workspace.renameFolderFromPrompt}
          onRenameFile={workspace.renameFileNodeFromPrompt}
          onSelectNotebook={workspace.selectNotebook}
          onStartUpload={workspace.startUpload}
          onToggleNotebook={workspace.toggleNotebook}
          onUploadChange={workspace.handleUploadChange}
        />

        <section className="min-w-0">
          <TabStrip
            activeTabId={workspace.activeTabId}
            tabs={workspace.tabs}
            onActivateTab={workspace.setActiveTabId}
            onCloseTab={workspace.closeTab}
          />

          {workspace.workspaceError ? (
            <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {workspace.workspaceError}
            </div>
          ) : null}

          <WorkspacePanel
            activeTab={workspace.activeTab}
            aiFormatting={workspace.aiFormatting}
            firstNotebook={workspace.firstNotebook}
            imageMarkdownConverting={workspace.imageMarkdownConverting}
            selectedNotebook={workspace.selectedNotebook}
            textareaRef={workspace.textareaRef}
            onAiFormatSelection={workspace.formatSelectionWithAi}
            onAiImageToMarkdown={workspace.convertImageToMarkdownWithAi}
            onCreateMarkdown={workspace.createMarkdownFromPrompt}
            onCreateNotebook={workspace.openCreateNotebookDialog}
            onDeleteFile={workspace.deleteFileFromPrompt}
            onInsertExistingImage={workspace.insertExistingMarkdownImage}
            onInsertImage={workspace.insertMarkdownImage}
            onInsertMarkdown={workspace.insertMarkdown}
            onMoveFile={workspace.moveFileFromPrompt}
            onOpenFile={workspace.openFile}
            onRenameFile={workspace.renameFileFromPrompt}
            onSave={workspace.saveActiveTab}
            onSetDraft={workspace.setActiveDraft}
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
