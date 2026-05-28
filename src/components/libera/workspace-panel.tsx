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
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { ExistingImageDialog } from "@/components/libera/existing-image-dialog";
import { ImageViewer } from "@/components/libera/image-viewer";
import { MarkdownEditor } from "@/components/libera/markdown-editor";
import { MarkdownToolbar } from "@/components/libera/markdown-toolbar";
import { NotebookHome } from "@/components/libera/notebook-home";
import { PdfViewer } from "@/components/libera/pdf-viewer";
import type {
  MarkdownScreenshotSnipSession,
  OpenTab,
} from "@/components/libera/types";
import {
  findMarkdownSourceElementForOffset,
  getMarkdownSourceOffsetAtPoint,
  getMarkdownSourceRange,
  MARKDOWN_SOURCE_BLOCK_SELECTOR,
  MARKDOWN_SOURCE_SELECTOR,
} from "@/lib/markdown-source-map";
import {
  getTextareaVisibleStartOffset,
  scrollTextareaToOffset,
} from "@/lib/textarea-position";
import type { LiberaFileNode, LiberaNotebookNode } from "@/lib/types";

type WorkspacePanelProps = {
  activeTab?: OpenTab;
  aiFormatting: boolean;
  canStartScreenshotSnip: boolean;
  firstNotebook: string;
  imageMarkdownConverting: boolean;
  screenshotSnipSession: MarkdownScreenshotSnipSession | null;
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
  onCancelScreenshotSnip: () => void;
  onCompleteScreenshotSnip: (file: File) => Promise<void>;
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
  onStartScreenshotSnip: () => void;
};

const DEFAULT_MARKDOWN_SPLIT_PERCENT = 50;
const MARKDOWN_PREVIEW_RENDER_DELAY_MS = 250;
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

function parseCssPixels(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getPreviewPadding(preview: HTMLElement) {
  const styles = window.getComputedStyle(preview);

  return {
    left: parseCssPixels(styles.paddingLeft),
    top: parseCssPixels(styles.paddingTop),
  };
}

function findPreviewSourceElementAtY(
  preview: HTMLElement,
  clientY: number,
  selector = MARKDOWN_SOURCE_BLOCK_SELECTOR,
) {
  const previewRect = preview.getBoundingClientRect();
  const padding = getPreviewPadding(preview);
  const clientX = Math.min(
    previewRect.right - 1,
    Math.max(previewRect.left + 1, previewRect.left + padding.left + 8),
  );

  for (const element of document.elementsFromPoint(clientX, clientY)) {
    const sourceElement = element.closest(selector);

    if (sourceElement instanceof HTMLElement && preview.contains(sourceElement)) {
      return sourceElement;
    }
  }

  const sourceElements = Array.from(preview.querySelectorAll<HTMLElement>(selector));
  let previousElement: HTMLElement | null = null;

  for (const sourceElement of sourceElements) {
    const sourceRect = sourceElement.getBoundingClientRect();

    if (sourceRect.bottom < clientY) {
      previousElement = sourceElement;
      continue;
    }

    return sourceElement;
  }

  return previousElement;
}

function getPreviewSourceOffsetAtY(preview: HTMLElement, clientY: number) {
  const sourceElement = findPreviewSourceElementAtY(preview, clientY);

  if (!sourceElement) {
    return null;
  }

  return (
    getMarkdownSourceOffsetAtPoint(sourceElement, clientY) ??
    getMarkdownSourceRange(sourceElement)?.start ??
    null
  );
}

function getPreviewVisibleStartOffset(preview: HTMLElement) {
  const previewRect = preview.getBoundingClientRect();
  const padding = getPreviewPadding(preview);

  return getPreviewSourceOffsetAtY(preview, previewRect.top + padding.top + 1);
}

function scrollPreviewToSourceOffset(preview: HTMLElement, offset: number) {
  const sourceElement = findMarkdownSourceElementForOffset(preview, offset);
  const sourceRange = getMarkdownSourceRange(sourceElement);

  if (!sourceElement || !sourceRange) {
    return;
  }

  const previewRect = preview.getBoundingClientRect();
  const sourceRect = sourceElement.getBoundingClientRect();
  const padding = getPreviewPadding(preview);
  const sourceSpan = Math.max(1, sourceRange.end - sourceRange.start);
  const progress = Math.min(
    1,
    Math.max(0, (offset - sourceRange.start) / sourceSpan),
  );
  const offsetWithinElement = sourceRect.height * progress;

  preview.scrollTop = Math.max(
    0,
    preview.scrollTop + sourceRect.top - previewRect.top + offsetWithinElement - padding.top,
  );
}

function useDebouncedPreviewContent(content: string, resetKey: string | undefined) {
  const [previewContent, setPreviewContent] = useState(content);
  const resetKeyRef = useRef(resetKey);

  useEffect(() => {
    if (resetKeyRef.current !== resetKey) {
      resetKeyRef.current = resetKey;
      setPreviewContent(content);
      return;
    }

    const timeout = window.setTimeout(() => {
      setPreviewContent(content);
    }, MARKDOWN_PREVIEW_RENDER_DELAY_MS);

    return () => window.clearTimeout(timeout);
  }, [content, resetKey]);

  return previewContent;
}

export function WorkspacePanel({
  activeTab,
  aiFormatting,
  canStartScreenshotSnip,
  firstNotebook,
  imageMarkdownConverting,
  screenshotSnipSession,
  selectedNotebook,
  textareaRef,
  onAiFormatSelection,
  onAiImageToMarkdown,
  onCreateMarkdown,
  onCreateNotebook,
  onCancelScreenshotSnip,
  onCompleteScreenshotSnip,
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
  onStartScreenshotSnip,
}: WorkspacePanelProps) {
  const [existingImageDialogOpen, setExistingImageDialogOpen] = useState(false);
  const [markdownZoom, setMarkdownZoom] = useState(100);
  const [markdownSplitDragging, setMarkdownSplitDragging] = useState(false);
  const [markdownSplitPercent, setMarkdownSplitPercent] = useState(
    DEFAULT_MARKDOWN_SPLIT_PERCENT,
  );
  const [activePreviewTabId, setActivePreviewTabId] = useState<string | null>(null);
  const markdownSplitContainerRef = useRef<HTMLDivElement | null>(null);
  const markdownPreviewRef = useRef<HTMLElement | null>(null);
  const suppressEditorScrollRef = useRef(false);
  const suppressEditorScrollTimeoutRef = useRef<number | null>(null);
  const suppressPreviewScrollRef = useRef(false);
  const suppressPreviewScrollTimeoutRef = useRef<number | null>(null);
  const activeFileType = activeTab?.file.fileType;
  const activeMarkdownDraft = activeFileType === "markdown" ? activeTab?.draft ?? "" : "";
  const activeTabStatus = activeTab?.status;
  const activeTabId = activeTab?.id;
  const previewMarkdownDraft = useDebouncedPreviewContent(
    activeMarkdownDraft,
    activeTabId,
  );
  const previewFullscreen =
    activeTab?.file.fileType === "markdown" && activePreviewTabId === activeTab.id;

  const markScrollSuppressed = useCallback(
    (
      suppressedRef: MutableRefObject<boolean>,
      timeoutRef: MutableRefObject<number | null>,
    ) => {
      suppressedRef.current = true;

      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = window.setTimeout(() => {
        suppressedRef.current = false;
        timeoutRef.current = null;
      }, 80);
    },
    [],
  );

  const suppressEditorScroll = useCallback(() => {
    markScrollSuppressed(suppressEditorScrollRef, suppressEditorScrollTimeoutRef);
  }, [markScrollSuppressed]);

  const suppressPreviewScroll = useCallback(() => {
    markScrollSuppressed(suppressPreviewScrollRef, suppressPreviewScrollTimeoutRef);
  }, [markScrollSuppressed]);

  const syncMarkdownPreviewToTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    const preview = markdownPreviewRef.current;

    if (!textarea || !preview) {
      return;
    }

    suppressPreviewScroll();
    scrollPreviewToSourceOffset(preview, getTextareaVisibleStartOffset(textarea));
  }, [suppressPreviewScroll, textareaRef]);

  const syncTextareaToMarkdownPreview = useCallback(() => {
    const textarea = textareaRef.current;
    const preview = markdownPreviewRef.current;

    if (!textarea || !preview) {
      return;
    }

    const sourceOffset = getPreviewVisibleStartOffset(preview);

    if (sourceOffset === null) {
      return;
    }

    suppressEditorScroll();
    scrollTextareaToOffset(textarea, sourceOffset, { block: "start" });
  }, [suppressEditorScroll, textareaRef]);

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
    if (activeFileType !== "markdown" || !activeTabId || previewFullscreen) {
      return;
    }

    const textarea = textareaRef.current;
    const preview = markdownPreviewRef.current;

    if (!textarea || !preview) {
      return;
    }

    function handleEditorScroll() {
      if (suppressEditorScrollRef.current) {
        return;
      }

      syncMarkdownPreviewToTextarea();
    }

    function handlePreviewScroll() {
      if (suppressPreviewScrollRef.current) {
        return;
      }

      syncTextareaToMarkdownPreview();
    }

    textarea.addEventListener("scroll", handleEditorScroll, { passive: true });
    preview.addEventListener("scroll", handlePreviewScroll, { passive: true });

    return () => {
      textarea.removeEventListener("scroll", handleEditorScroll);
      preview.removeEventListener("scroll", handlePreviewScroll);
    };
  }, [
    activeFileType,
    activeTabId,
    previewFullscreen,
    syncMarkdownPreviewToTextarea,
    syncTextareaToMarkdownPreview,
    textareaRef,
  ]);

  useEffect(() => {
    if (activeFileType !== "markdown" || !activeTabId || previewFullscreen) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(syncMarkdownPreviewToTextarea);

    return () => window.cancelAnimationFrame(animationFrame);
  }, [
    activeFileType,
    activeTabId,
    previewMarkdownDraft,
    previewFullscreen,
    syncMarkdownPreviewToTextarea,
  ]);

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
    if (activeFileType !== "markdown" || !activeTabId) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") {
        return;
      }

      event.preventDefault();

      if (activeTabStatus === "saving" || activeTabStatus === "clean") {
        return;
      }

      void onSave();
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeFileType, activeTabId, activeTabStatus, onSave]);

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

  function handleMarkdownPreviewDoubleClick(
    event: ReactMouseEvent<HTMLElement>,
  ) {
    const textarea = textareaRef.current;

    if (!textarea) {
      return;
    }

    const preview = event.currentTarget;
    const clickedSourceElement =
      event.target instanceof Element
        ? event.target.closest(MARKDOWN_SOURCE_SELECTOR)
        : null;
    const sourceElement =
      clickedSourceElement instanceof HTMLElement &&
      preview.contains(clickedSourceElement)
        ? clickedSourceElement
        : findPreviewSourceElementAtY(
            preview,
            event.clientY,
            MARKDOWN_SOURCE_SELECTOR,
          );

    if (!sourceElement) {
      return;
    }

    const sourceOffset =
      getMarkdownSourceOffsetAtPoint(sourceElement, event.clientY) ??
      getMarkdownSourceRange(sourceElement)?.start;

    if (sourceOffset === undefined) {
      return;
    }

    const clampedOffset = Math.max(0, Math.min(sourceOffset, textarea.value.length));

    event.preventDefault();
    suppressEditorScroll();
    textarea.focus();
    textarea.setSelectionRange(clampedOffset, clampedOffset);
    scrollTextareaToOffset(textarea, clampedOffset);
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
            canStartScreenshotSnip={canStartScreenshotSnip}
            markdownZoom={markdownZoom}
            onFixChatGptEquations={fixActiveChatGptEquations}
            onInsert={onInsertMarkdown}
            onInsertExistingImage={() => setExistingImageDialogOpen(true)}
            onInsertImage={onInsertImage}
            onMarkdownZoomChange={setMarkdownZoom}
            onStartScreenshotSnip={onStartScreenshotSnip}
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
              <article
                ref={markdownPreviewRef}
                className="min-h-0 min-w-0 overflow-auto bg-white p-6"
                onDoubleClick={handleMarkdownPreviewDoubleClick}
              >
                <MarkdownRenderer
                  content={previewMarkdownDraft}
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
          screenshotSnipping={screenshotSnipSession?.sourceTabId === activeTab.id}
          onCancelScreenshotSnip={onCancelScreenshotSnip}
          onCompleteScreenshotSnip={onCompleteScreenshotSnip}
        />
      ) : activeTab.file.fileType === "pdf" ? (
        <PdfViewer
          src={activeTab.rawUrl}
          filePath={activeTab.file.path}
          screenshotSnipping={screenshotSnipSession?.sourceTabId === activeTab.id}
          onCancelScreenshotSnip={onCancelScreenshotSnip}
          onCompleteScreenshotSnip={onCompleteScreenshotSnip}
        />
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
