import {
  BookPlus,
  Download,
  FilePlus2,
  MoveRight,
  Pencil,
  Save,
  Trash2,
} from "lucide-react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import { useEffect, useRef, useState } from "react";
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
  onDownloadFile: (file: LiberaFileNode, content?: string) => void;
  onInsertExistingImage: (file: LiberaFileNode) => Promise<void>;
  onInsertImage: (file: File) => Promise<void>;
  onInsertMarkdown: (before: string, after?: string, placeholder?: string) => void;
  onMoveFile: (tab: OpenTab) => Promise<void>;
  onOpenFile: (file: LiberaFileNode) => Promise<void>;
  onRenameFile: (tab: OpenTab) => Promise<void>;
  onSave: () => Promise<void>;
  onSetDraft: (value: string) => void;
};

const DEFAULT_MARKDOWN_SPLIT_PERCENT = 50;
const MARKDOWN_SPLIT_STORAGE_KEY = "libera.markdownEditorPreviewSplitPercent";
const MAX_MARKDOWN_SPLIT_PERCENT = 76;
const MIN_MARKDOWN_SPLIT_PERCENT = 24;

function clampMarkdownSplitPercent(value: number) {
  return Math.min(
    MAX_MARKDOWN_SPLIT_PERCENT,
    Math.max(MIN_MARKDOWN_SPLIT_PERCENT, value),
  );
}

function fixChatGptEquationBlocks(value: string) {
  return value.replace(
    /(^|\n)[ \t]*\[[ \t]*\n([\s\S]*?)\n[ \t]*\][ \t]*(?=\n|$)/g,
    (_, prefix: string, equation: string) => `${prefix}$$\n${equation.trim()}\n$$`,
  );
}

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
  onDownloadFile,
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
  const [markdownZoom, setMarkdownZoom] = useState(100);
  const [markdownSplitDragging, setMarkdownSplitDragging] = useState(false);
  const [markdownSplitPercent, setMarkdownSplitPercent] = useState(
    DEFAULT_MARKDOWN_SPLIT_PERCENT,
  );
  const [activePreviewTabId, setActivePreviewTabId] = useState<string | null>(null);
  const markdownSplitContainerRef = useRef<HTMLDivElement | null>(null);
  const previewFullscreen =
    activeTab?.file.fileType === "markdown" && activePreviewTabId === activeTab.id;

  useEffect(() => {
    const savedSplit = window.localStorage.getItem(MARKDOWN_SPLIT_STORAGE_KEY);
    const parsedSplit = savedSplit ? Number(savedSplit) : Number.NaN;

    if (Number.isFinite(parsedSplit)) {
      const animationFrame = window.requestAnimationFrame(() => {
        setMarkdownSplitPercent(clampMarkdownSplitPercent(parsedSplit));
      });

      return () => window.cancelAnimationFrame(animationFrame);
    }
  }, []);

  useEffect(() => {
    if (!previewFullscreen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      setActivePreviewTabId(null);

      window.requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [previewFullscreen, textareaRef]);

  useEffect(() => {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    const markdownTab = activeTab;

    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") {
        return;
      }

      event.preventDefault();

      if (markdownTab.status === "saving" || markdownTab.status === "clean") {
        return;
      }

      void onSave();
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeTab, onSave]);

  function saveMarkdownSplitPercent(value: number) {
    const clampedValue = clampMarkdownSplitPercent(value);

    setMarkdownSplitPercent(clampedValue);
    window.localStorage.setItem(MARKDOWN_SPLIT_STORAGE_KEY, String(clampedValue));
  }

  function updateMarkdownSplitFromPointer(clientX: number, clientY: number) {
    const container = markdownSplitContainerRef.current;

    if (!container) {
      return;
    }

    const rect = container.getBoundingClientRect();
    const isDesktopSplit = window.matchMedia("(min-width: 1024px)").matches;
    const size = isDesktopSplit ? rect.width : rect.height;

    if (size <= 0) {
      return;
    }

    const offset = isDesktopSplit ? clientX - rect.left : clientY - rect.top;
    saveMarkdownSplitPercent((offset / size) * 100);
  }

  function handleMarkdownSplitPointerDown(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setMarkdownSplitDragging(true);
    updateMarkdownSplitFromPointer(event.clientX, event.clientY);

    function handlePointerMove(pointerEvent: PointerEvent) {
      updateMarkdownSplitFromPointer(pointerEvent.clientX, pointerEvent.clientY);
    }

    function stopDragging() {
      setMarkdownSplitDragging(false);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);
  }

  function handleMarkdownSplitKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    const step = event.shiftKey ? 10 : 5;

    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      saveMarkdownSplitPercent(markdownSplitPercent - step);
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      saveMarkdownSplitPercent(markdownSplitPercent + step);
    } else if (event.key === "Home") {
      event.preventDefault();
      saveMarkdownSplitPercent(MIN_MARKDOWN_SPLIT_PERCENT);
    } else if (event.key === "End") {
      event.preventDefault();
      saveMarkdownSplitPercent(MAX_MARKDOWN_SPLIT_PERCENT);
    }
  }

  function fixActiveChatGptEquations() {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    onSetDraft(fixChatGptEquationBlocks(activeTab.draft));

    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }

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
      <div className="flex h-full min-h-0 items-center justify-center overflow-auto px-6">
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <WorkspaceFileHeader
        activeTab={activeTab}
        onDeleteFile={onDeleteFile}
        onDownloadFile={onDownloadFile}
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
            markdownZoom={markdownZoom}
            onFixChatGptEquations={fixActiveChatGptEquations}
            onInsert={onInsertMarkdown}
            onInsertExistingImage={() => setExistingImageDialogOpen(true)}
            onInsertImage={onInsertImage}
            onMarkdownZoomChange={setMarkdownZoom}
            onTogglePreviewFullscreen={() =>
              setActivePreviewTabId((current) =>
                current === activeTab.id ? null : activeTab.id,
              )
            }
            previewFullscreen={previewFullscreen}
          />
          {previewFullscreen ? (
            <article className="min-h-0 flex-1 overflow-auto bg-white p-6">
              <MarkdownRenderer
                content={activeTab.draft}
                documentPath={activeTab.file.path}
                textScale={markdownZoom / 100}
              />
            </article>
          ) : (
            <div
              ref={markdownSplitContainerRef}
              className={`markdown-split-grid min-h-0 flex-1 overflow-hidden ${
                markdownSplitDragging ? "select-none" : ""
              }`}
              style={
                {
                  "--markdown-split": `${markdownSplitPercent}%`,
                } as CSSProperties
              }
            >
              <MarkdownEditor
                formatting={aiFormatting}
                imageConverting={imageMarkdownConverting}
                textScale={markdownZoom / 100}
                textareaRef={textareaRef}
                value={activeTab.draft}
                onAiFormatSelection={onAiFormatSelection}
                onAiImageToMarkdown={onAiImageToMarkdown}
                onChange={onSetDraft}
                onInsertImageFile={onInsertImage}
              />
              <div
                aria-label="Resize Markdown editor and preview"
                aria-orientation="vertical"
                aria-valuemax={MAX_MARKDOWN_SPLIT_PERCENT}
                aria-valuemin={MIN_MARKDOWN_SPLIT_PERCENT}
                aria-valuenow={Math.round(markdownSplitPercent)}
                className="markdown-split-resizer group flex cursor-row-resize items-center justify-center bg-zinc-100 outline-none hover:bg-zinc-200 focus-visible:bg-zinc-200 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-900 lg:cursor-col-resize"
                role="separator"
                tabIndex={0}
                title="Drag to resize editor and preview"
                onKeyDown={handleMarkdownSplitKeyDown}
                onPointerDown={handleMarkdownSplitPointerDown}
              >
                <span className="h-1 w-10 rounded-full bg-zinc-400 transition group-hover:bg-zinc-700 group-focus-visible:bg-zinc-700 lg:h-10 lg:w-1" />
              </div>
              <article className="min-h-0 min-w-0 overflow-auto bg-white p-6">
                <MarkdownRenderer
                  content={activeTab.draft}
                  documentPath={activeTab.file.path}
                  textScale={markdownZoom / 100}
                />
              </article>
            </div>
          )}
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
          className="min-h-0 flex-1 bg-white"
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
  onDownloadFile,
  onMoveFile,
  onRenameFile,
  onSave,
}: {
  activeTab: OpenTab;
  onDeleteFile: (tab: OpenTab) => Promise<void>;
  onDownloadFile: (file: LiberaFileNode, content?: string) => void;
  onMoveFile: (tab: OpenTab) => Promise<void>;
  onRenameFile: (tab: OpenTab) => Promise<void>;
  onSave: () => Promise<void>;
}) {
  const downloadContent =
    activeTab.file.fileType === "markdown" ? activeTab.draft : undefined;

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
          onClick={() => onDownloadFile(activeTab.file, downloadContent)}
        >
          <Download aria-hidden className="h-4 w-4" />
          Download
        </button>
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
