import {
  BookPlus,
  FilePlus2,
} from "lucide-react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
  RefObject,
  UIEvent as ReactUIEvent,
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
  ImageTabViewState,
  MarkdownFileLinkRange,
  MarkdownFileLinkSelection,
  MarkdownTabViewState,
  MarkdownScreenshotSnipSession,
  OpenTab,
  OpenTabViewState,
  PdfTabViewState,
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
  files: LiberaFileNode[];
  aiFormatting: boolean;
  canStartScreenshotSnip: boolean;
  firstNotebook: string;
  imageMarkdownConverting: boolean;
  recentFiles: LiberaFileNode[];
  screenshotSnipSession: MarkdownScreenshotSnipSession | null;
  selectedNotebook?: LiberaNotebookNode;
  tabs: OpenTab[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onAiFormatSelection: (selection: { start: number; end: number }) => Promise<void>;
  onAiImageToMarkdown: (image: {
    alt: string;
    end: number;
    src: string;
    start: number;
  }) => Promise<void>;
  onAiRewriteSelection: (
    selection: { start: number; end: number },
    prompt: string,
  ) => Promise<void>;
  onCreateMarkdown: (notebook: string) => Promise<void>;
  onCreateNotebook: () => void;
  onCancelScreenshotSnip: () => void;
  onCompleteScreenshotSnip: (file: File) => Promise<void>;
  onInsertExistingImage: (file: LiberaFileNode) => Promise<void>;
  onInsertFileLink: (
    selection: MarkdownFileLinkSelection,
    range?: MarkdownFileLinkRange,
  ) => void;
  onInsertFileLinkPlaceholder: () => void;
  onInsertImage: (file: File) => Promise<void>;
  onInsertMarkdown: (before: string, after?: string, placeholder?: string) => void;
  onOpenFile: (file: LiberaFileNode) => Promise<void>;
  onSave: () => Promise<void>;
  onSetDraft: (value: string) => void;
  onSetViewState: (viewState: OpenTabViewState) => void;
  onOpenMarkdownFileLink: (sourcePath: string, href: string) => Promise<boolean>;
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

function getMarkdownLineForOffset(value: string, offset: number) {
  const clampedOffset = Math.max(0, Math.min(offset, value.length));

  return value.slice(0, clampedOffset).split("\n").length;
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
  files,
  aiFormatting,
  canStartScreenshotSnip,
  firstNotebook,
  imageMarkdownConverting,
  recentFiles,
  screenshotSnipSession,
  selectedNotebook,
  tabs,
  textareaRef,
  onAiFormatSelection,
  onAiImageToMarkdown,
  onAiRewriteSelection,
  onCreateMarkdown,
  onCreateNotebook,
  onCancelScreenshotSnip,
  onCompleteScreenshotSnip,
  onInsertExistingImage,
  onInsertFileLink,
  onInsertFileLinkPlaceholder,
  onInsertImage,
  onInsertMarkdown,
  onOpenFile,
  onSave,
  onSetDraft,
  onSetViewState,
  onOpenMarkdownFileLink,
  onStartScreenshotSnip,
}: WorkspacePanelProps) {
  const [existingImageDialogOpen, setExistingImageDialogOpen] = useState(false);
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
  const markdownRestoreViewStateRef = useRef<MarkdownTabViewState | undefined>(undefined);
  const activeFileType = activeTab?.file.fileType;
  const activeMarkdownDraft = activeFileType === "markdown" ? activeTab?.draft ?? "" : "";
  const activeTabStatus = activeTab?.status;
  const activeTabId = activeTab?.id;
  const activeMarkdownViewState =
    activeTab?.file.fileType === "markdown" ? activeTab.viewState?.markdown : undefined;
  const markdownZoom = activeMarkdownViewState?.zoom ?? 100;
  const activePdfViewState =
    activeTab?.file.fileType === "pdf" ? activeTab.viewState?.pdf : undefined;
  const activeImageViewState =
    activeTab?.file.fileType === "image" ? activeTab.viewState?.image : undefined;
  const previewMarkdownDraft = useDebouncedPreviewContent(
    activeMarkdownDraft,
    activeTabId,
  );
  const previewFullscreen =
    activeTab?.file.fileType === "markdown" && activePreviewTabId === activeTab.id;

  const updateMarkdownViewState = useCallback(
    (patch: MarkdownTabViewState) => {
      onSetViewState({ markdown: patch });
    },
    [onSetViewState],
  );

  const updatePdfViewState = useCallback(
    (patch: PdfTabViewState) => {
      onSetViewState({ pdf: patch });
    },
    [onSetViewState],
  );

  const updateImageViewState = useCallback(
    (patch: ImageTabViewState) => {
      onSetViewState({ image: patch });
    },
    [onSetViewState],
  );

  useEffect(() => {
    markdownRestoreViewStateRef.current = activeMarkdownViewState;
  }, [activeMarkdownViewState]);

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

    const editor = textarea;
    const previewPane = preview;

    function handleEditorScroll() {
      if (suppressEditorScrollRef.current) {
        return;
      }

      const visibleStartOffset = getTextareaVisibleStartOffset(editor);

      syncMarkdownPreviewToTextarea();
      updateMarkdownViewState({
        editorScrollLeft: editor.scrollLeft,
        editorScrollTop: editor.scrollTop,
        line: getMarkdownLineForOffset(editor.value, visibleStartOffset),
        previewScrollLeft: previewPane.scrollLeft,
        previewScrollTop: previewPane.scrollTop,
      });
    }

    function handlePreviewScroll() {
      if (suppressPreviewScrollRef.current) {
        return;
      }

      const sourceOffset = getPreviewVisibleStartOffset(previewPane);

      syncTextareaToMarkdownPreview();
      updateMarkdownViewState({
        editorScrollLeft: editor.scrollLeft,
        editorScrollTop: editor.scrollTop,
        line:
          sourceOffset === null
            ? undefined
            : getMarkdownLineForOffset(editor.value, sourceOffset),
        previewScrollLeft: previewPane.scrollLeft,
        previewScrollTop: previewPane.scrollTop,
      });
    }

    editor.addEventListener("scroll", handleEditorScroll, { passive: true });
    previewPane.addEventListener("scroll", handlePreviewScroll, { passive: true });

    return () => {
      editor.removeEventListener("scroll", handleEditorScroll);
      previewPane.removeEventListener("scroll", handlePreviewScroll);
    };
  }, [
    activeFileType,
    activeTabId,
    previewFullscreen,
    syncMarkdownPreviewToTextarea,
    syncTextareaToMarkdownPreview,
    textareaRef,
    updateMarkdownViewState,
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
    if (activeFileType !== "markdown" || !activeTabId) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      const preview = markdownPreviewRef.current;
      const viewState = markdownRestoreViewStateRef.current;

      if (textarea && !previewFullscreen) {
        textarea.scrollLeft = viewState?.editorScrollLeft ?? 0;
        textarea.scrollTop = viewState?.editorScrollTop ?? 0;

        const selectionStart = viewState?.selectionStart;
        const selectionEnd = viewState?.selectionEnd;

        if (
          typeof selectionStart === "number" &&
          typeof selectionEnd === "number"
        ) {
          textarea.setSelectionRange(
            Math.max(0, Math.min(selectionStart, textarea.value.length)),
            Math.max(0, Math.min(selectionEnd, textarea.value.length)),
          );
        }
      }

      if (preview) {
        preview.scrollLeft = viewState?.previewScrollLeft ?? 0;
        preview.scrollTop = viewState?.previewScrollTop ?? 0;
      }
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [
    activeFileType,
    activeTabId,
    previewFullscreen,
    textareaRef,
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

  function handleMarkdownZoomChange(value: number) {
    updateMarkdownViewState({ zoom: value });
  }

  function handleMarkdownSelectionChange(selection: { end: number; start: number }) {
    updateMarkdownViewState({
      line: getMarkdownLineForOffset(activeMarkdownDraft, selection.start),
      selectionEnd: selection.end,
      selectionStart: selection.start,
    });
  }

  function handleMarkdownPreviewScroll(event: ReactUIEvent<HTMLElement>) {
    const preview = event.currentTarget;

    updateMarkdownViewState({
      previewScrollLeft: preview.scrollLeft,
      previewScrollTop: preview.scrollTop,
    });
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

    const textarea = textareaRef.current;
    const scrollLeft = textarea?.scrollLeft ?? 0;
    const scrollTop = textarea?.scrollTop ?? 0;
    const selectionStart = textarea?.selectionStart ?? 0;
    const selectionEnd = textarea?.selectionEnd ?? selectionStart;

    onSetDraft(fixChatGptEquationBlocks(activeTab.draft));

    window.requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current;

      if (!nextTextarea) {
        return;
      }

      nextTextarea.focus();
      nextTextarea.setSelectionRange(
        Math.min(selectionStart, nextTextarea.value.length),
        Math.min(selectionEnd, nextTextarea.value.length),
      );
      nextTextarea.scrollLeft = scrollLeft;
      nextTextarea.scrollTop = scrollTop;
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
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Create a notebook, add Markdown notes, or upload images and PDFs from the explorer.
          </p>
          {firstNotebook ? (
            <button
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              type="button"
              onClick={() => onCreateMarkdown(firstNotebook)}
            >
              <FilePlus2 aria-hidden className="h-4 w-4" />
              New note in {firstNotebook}
            </button>
          ) : (
            <button
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
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
      {activeTab.error ? (
        <div className="border-b border-destructive/40 bg-destructive-muted px-4 py-2 text-sm text-destructive">
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
            onInsertFileLink={onInsertFileLinkPlaceholder}
            onInsertImage={onInsertImage}
            onMarkdownZoomChange={handleMarkdownZoomChange}
            onStartScreenshotSnip={onStartScreenshotSnip}
            onTogglePreviewFullscreen={() =>
              setActivePreviewTabId((current) =>
                current === activeTab.id ? null : activeTab.id,
              )
            }
            previewFullscreen={previewFullscreen}
          />
          {previewFullscreen ? (
            <article
              ref={markdownPreviewRef}
              className="min-h-0 flex-1 overflow-auto bg-card p-6"
              onScroll={handleMarkdownPreviewScroll}
            >
              <MarkdownRenderer
                content={activeTab.draft}
                documentPath={activeTab.file.path}
                onOpenFileLink={(href) =>
                  onOpenMarkdownFileLink(activeTab.file.path, href)
                }
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
                activeFilePath={activeTab.file.path}
                files={files}
                formatting={aiFormatting}
                imageConverting={imageMarkdownConverting}
                openTabs={tabs}
                recentFiles={recentFiles}
                textScale={markdownZoom / 100}
                textareaRef={textareaRef}
                value={activeTab.draft}
                onAiFormatSelection={onAiFormatSelection}
                onAiImageToMarkdown={onAiImageToMarkdown}
                onAiRewriteSelection={onAiRewriteSelection}
                onChange={onSetDraft}
                onInsertFileLink={onInsertFileLink}
                onInsertImageFile={onInsertImage}
                onSelectionChange={handleMarkdownSelectionChange}
              />
              <div
                aria-label="Resize Markdown editor and preview"
                aria-orientation="vertical"
                aria-valuemax={MAX_MARKDOWN_SPLIT_PERCENT}
                aria-valuemin={MIN_MARKDOWN_SPLIT_PERCENT}
                aria-valuenow={Math.round(markdownSplitPercent)}
                className="markdown-split-resizer group flex cursor-row-resize items-center justify-center bg-muted outline-none hover:bg-input focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground lg:cursor-col-resize"
                role="separator"
                tabIndex={0}
                title="Drag to resize editor and preview"
                onKeyDown={handleMarkdownSplitKeyDown}
                onPointerDown={handleMarkdownSplitPointerDown}
              >
                <span className="h-1 w-10 rounded-full bg-input transition group-hover:bg-muted-foreground group-focus-visible:bg-muted-foreground lg:h-10 lg:w-1" />
              </div>
              <article
                ref={markdownPreviewRef}
                className="min-h-0 min-w-0 overflow-auto bg-card p-6"
                onDoubleClick={handleMarkdownPreviewDoubleClick}
                onScroll={handleMarkdownPreviewScroll}
              >
                <MarkdownRenderer
                  content={previewMarkdownDraft}
                  documentPath={activeTab.file.path}
                  onOpenFileLink={(href) =>
                    onOpenMarkdownFileLink(activeTab.file.path, href)
                  }
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
          initialViewState={activeImageViewState}
          screenshotSnipping={screenshotSnipSession?.sourceTabId === activeTab.id}
          onViewStateChange={updateImageViewState}
          onCancelScreenshotSnip={onCancelScreenshotSnip}
          onCompleteScreenshotSnip={onCompleteScreenshotSnip}
        />
      ) : activeTab.file.fileType === "pdf" ? (
        <PdfViewer
          key={activeTab.id}
          src={activeTab.rawUrl}
          filePath={activeTab.file.path}
          initialViewState={activePdfViewState}
          screenshotSnipping={screenshotSnipSession?.sourceTabId === activeTab.id}
          onViewStateChange={updatePdfViewState}
          onCancelScreenshotSnip={onCancelScreenshotSnip}
          onCompleteScreenshotSnip={onCompleteScreenshotSnip}
        />
      ) : (
        <iframe
          className="min-h-0 flex-1 bg-card"
          src={activeTab.rawUrl}
          title={activeTab.file.name}
        />
      )}
    </div>
  );
}
