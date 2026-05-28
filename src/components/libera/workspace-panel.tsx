import { BookPlus, FilePlus2, MoveRight, Pencil, Save, Trash2 } from "lucide-react";
import type { RefObject } from "react";
import { useState } from "react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { ExistingImageDialog } from "@/components/libera/existing-image-dialog";
import { ImageViewer } from "@/components/libera/image-viewer";
import { MarkdownEditor } from "@/components/libera/markdown-editor";
import { MarkdownToolbar } from "@/components/libera/markdown-toolbar";
import { NotebookHome } from "@/components/libera/notebook-home";
import { PdfViewer } from "@/components/libera/pdf-viewer";
import type { OpenTab } from "@/components/libera/types";
import type { LiberaFileNode, LiberaNotebookNode } from "@/lib/types";

type WorkspacePanelProps = {
  activeTab?: OpenTab;
  aiFormatting: boolean;
  firstNotebook: string;
  imageMarkdownConverting: boolean;
  selectedNotebook?: LiberaNotebookNode;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onAiFormatSelection: (selection: { start: number; end: number }) => Promise<void>;
  onAiImageToMarkdown: (image: {
    alt: string;
    end: number;
    src: string;
    start: number;
  }) => Promise<void>;
  onCreateMarkdown: (notebook: string) => Promise<void>;
  onCreateNotebook: () => void;
  onDeleteFile: (tab: OpenTab) => Promise<void>;
  onInsertExistingImage: (file: LiberaFileNode) => Promise<void>;
  onInsertImage: (file: File) => Promise<void>;
  onInsertMarkdown: (before: string, after?: string, placeholder?: string) => void;
  onMoveFile: (tab: OpenTab) => Promise<void>;
  onOpenFile: (file: LiberaFileNode) => Promise<void>;
  onRenameFile: (tab: OpenTab) => Promise<void>;
  onSave: () => Promise<void>;
  onSetDraft: (value: string) => void;
};

export function WorkspacePanel({
  activeTab,
  aiFormatting,
  firstNotebook,
  imageMarkdownConverting,
  selectedNotebook,
  textareaRef,
  onAiFormatSelection,
  onAiImageToMarkdown,
  onCreateMarkdown,
  onCreateNotebook,
  onDeleteFile,
  onInsertExistingImage,
  onInsertImage,
  onInsertMarkdown,
  onMoveFile,
  onOpenFile,
  onRenameFile,
  onSave,
  onSetDraft,
}: WorkspacePanelProps) {
  const [existingImageDialogOpen, setExistingImageDialogOpen] = useState(false);

  if (!activeTab) {
    if (selectedNotebook) {
      return (
        <NotebookHome
          notebook={selectedNotebook}
          onCreateMarkdown={onCreateMarkdown}
          onOpenFile={onOpenFile}
        />
      );
    }

    return (
      <div className="flex min-h-[calc(100vh-120px)] items-center justify-center px-6">
        <div className="max-w-md text-center">
          <h2 className="text-xl font-semibold tracking-tight">Open a file to begin</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-500">
            Create a notebook, add Markdown notes, or upload images and PDFs from the explorer.
          </p>
          {firstNotebook ? (
            <button
              className="mt-5 inline-flex items-center gap-2 rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
              type="button"
              onClick={() => onCreateMarkdown(firstNotebook)}
            >
              <FilePlus2 aria-hidden className="h-4 w-4" />
              New note in {firstNotebook}
            </button>
          ) : (
            <button
              className="mt-5 inline-flex items-center gap-2 rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
              type="button"
              onClick={onCreateNotebook}
            >
              <BookPlus aria-hidden className="h-4 w-4" />
              Create notebook
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100vh-120px)] flex-col">
      <WorkspaceFileHeader
        activeTab={activeTab}
        onDeleteFile={onDeleteFile}
        onMoveFile={onMoveFile}
        onRenameFile={onRenameFile}
        onSave={onSave}
      />

      {activeTab.error ? (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {activeTab.error}
        </div>
      ) : null}

      {activeTab.file.fileType === "markdown" ? (
        <>
          <MarkdownToolbar
            onInsert={onInsertMarkdown}
            onInsertExistingImage={() => setExistingImageDialogOpen(true)}
            onInsertImage={onInsertImage}
          />
          <div className="grid min-h-0 flex-1 lg:grid-cols-2">
            <MarkdownEditor
              formatting={aiFormatting}
              imageConverting={imageMarkdownConverting}
              textareaRef={textareaRef}
              value={activeTab.draft}
              onAiFormatSelection={onAiFormatSelection}
              onAiImageToMarkdown={onAiImageToMarkdown}
              onChange={onSetDraft}
              onInsertImageFile={onInsertImage}
            />
            <article className="overflow-auto bg-white p-6">
              <MarkdownRenderer
                content={activeTab.draft}
                documentPath={activeTab.file.path}
              />
            </article>
          </div>
          <ExistingImageDialog
            notebook={selectedNotebook}
            open={existingImageDialogOpen}
            onClose={() => setExistingImageDialogOpen(false)}
            onSelect={async (file) => {
              await onInsertExistingImage(file);
              setExistingImageDialogOpen(false);
            }}
          />
        </>
      ) : activeTab.file.fileType === "image" ? (
        <ImageViewer
          src={activeTab.rawUrl}
          alt={activeTab.file.name}
          filePath={activeTab.file.path}
        />
      ) : activeTab.file.fileType === "pdf" ? (
        <PdfViewer src={activeTab.rawUrl} filePath={activeTab.file.path} />
      ) : (
        <iframe
          className="min-h-[calc(100vh-172px)] flex-1 bg-white"
          src={activeTab.rawUrl}
          title={activeTab.file.name}
        />
      )}
    </div>
  );
}

function WorkspaceFileHeader({
  activeTab,
  onDeleteFile,
  onMoveFile,
  onRenameFile,
  onSave,
}: {
  activeTab: OpenTab;
  onDeleteFile: (tab: OpenTab) => Promise<void>;
  onMoveFile: (tab: OpenTab) => Promise<void>;
  onRenameFile: (tab: OpenTab) => Promise<void>;
  onSave: () => Promise<void>;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-white px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{activeTab.file.path}</p>
        <p className="text-xs text-zinc-500">
          {activeTab.file.fileType.toUpperCase()} · {activeTab.status}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {activeTab.file.fileType === "markdown" ? (
          <button
            className="inline-flex items-center gap-2 rounded-md bg-zinc-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            disabled={activeTab.status === "saving" || activeTab.status === "clean"}
            onClick={onSave}
          >
            <Save aria-hidden className="h-4 w-4" />
            Save
          </button>
        ) : null}
        <button
          className="inline-flex items-center gap-2 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50"
          type="button"
          onClick={() => onRenameFile(activeTab)}
        >
          <Pencil aria-hidden className="h-4 w-4" />
          Rename
        </button>
        <button
          className="inline-flex items-center gap-2 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50"
          type="button"
          onClick={() => onMoveFile(activeTab)}
        >
          <MoveRight aria-hidden className="h-4 w-4" />
          Move
        </button>
        <button
          className="inline-flex items-center gap-2 rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
          type="button"
          onClick={() => onDeleteFile(activeTab)}
        >
          <Trash2 aria-hidden className="h-4 w-4" />
          Delete
        </button>
      </div>
    </div>
  );
}
