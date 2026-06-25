import {
  BookPlus,
  FilePlus2,
} from "lucide-react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
  UIEvent as ReactUIEvent,
} from "react";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { ExistingImageDialog } from "@/components/libera/existing-image-dialog";
import { ImageViewer } from "@/components/libera/image-viewer";
import { MarkdownEditor } from "@/components/libera/markdown-editor";
import {
  MarkdownSlidesPresenter,
  MarkdownSlidesPreview,
} from "@/components/libera/markdown-slides-viewer";
import { MarkdownToolbar } from "@/components/libera/markdown-toolbar";
import { NotebookHome } from "@/components/libera/notebook-home";
import { PdfViewer } from "@/components/libera/pdf-viewer";
import { normalizeChatGptCopiedMarkdown } from "@/lib/chatgpt-markdown-normalizer";
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
import { enumerateMarkdownHeadings } from "@/lib/markdown-heading-enumeration";
import type {
  MarkdownHeadingEnumerationScope,
} from "@/lib/markdown-heading-enumeration";
import {
  findMarkdownSourceElementForOffset,
  getMarkdownSourceRange,
  MARKDOWN_SOURCE_BLOCK_SELECTOR,
  MARKDOWN_SOURCE_SELECTOR,
  type MarkdownSourceRange,
} from "@/lib/markdown-source-map";
import {
  isMarkdownSlidesPath,
  parseMarkdownSlides,
} from "@/lib/markdown-slides";
import {
  getTextareaOffsetAtVisualProgress,
  getTextareaViewportAnchorOffset,
  getTextareaVisualProgressForRange,
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
  onCreateSlides: (notebook: string) => Promise<void>;
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
  onSetViewState: (viewState: OpenTabViewState, tabId?: string) => void;
  onOpenMarkdownFileLink: (sourcePath: string, href: string) => Promise<boolean>;
  onStartScreenshotSnip: () => void;
};

const DEFAULT_MARKDOWN_SPLIT_PERCENT = 50;
const MARKDOWN_PROGRAMMATIC_SCROLL_GRACE_MS = 250;
const MARKDOWN_PREVIEW_RENDER_DELAY_MS = 250;
const MARKDOWN_PREVIEW_USER_SCROLL_GRACE_MS = 1000;
const MARKDOWN_SCROLL_SYNC_ANCHOR_PROGRESS = 0.6;
const MARKDOWN_SPLIT_STORAGE_KEY = "libera.markdownEditorPreviewSplitPercent";
const MAX_MARKDOWN_SPLIT_PERCENT = 76;
const MIN_MARKDOWN_SPLIT_PERCENT = 24;

type PreviewScrollBlock = "nearest" | "start";

type PreviewSourcePosition = {
  progress: number;
  range: MarkdownSourceRange;
};

type VisibleRect = {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
};

function clampMarkdownSplitPercent(value: number) {
  return Math.min(
    MAX_MARKDOWN_SPLIT_PERCENT,
    Math.max(MIN_MARKDOWN_SPLIT_PERCENT, value),
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

function visibleRectFromEdges(left: number, top: number, right: number, bottom: number) {
  return {
    bottom,
    height: Math.max(0, bottom - top),
    left,
    right,
    top,
    width: Math.max(0, right - left),
  };
}

function getElementVisibleRect(element: HTMLElement): VisibleRect {
  const rect = element.getBoundingClientRect();
  let left = Math.max(0, rect.left);
  let right = Math.min(window.innerWidth, rect.right);
  let top = Math.max(0, rect.top);
  let bottom = Math.min(window.innerHeight, rect.bottom);
  let ancestor = element.parentElement;

  while (ancestor) {
    const styles = window.getComputedStyle(ancestor);
    const clipsX = styles.overflowX !== "visible";
    const clipsY = styles.overflowY !== "visible";

    if (clipsX || clipsY) {
      const ancestorRect = ancestor.getBoundingClientRect();

      if (clipsX) {
        left = Math.max(left, ancestorRect.left);
        right = Math.min(right, ancestorRect.right);
      }

      if (clipsY) {
        top = Math.max(top, ancestorRect.top);
        bottom = Math.min(bottom, ancestorRect.bottom);
      }
    }

    ancestor = ancestor.parentElement;
  }

  return visibleRectFromEdges(left, top, right, bottom);
}

function findPreviewSourceElementAtY(
  preview: HTMLElement,
  clientY: number,
  selector = MARKDOWN_SOURCE_BLOCK_SELECTOR,
) {
  const previewRect = preview.getBoundingClientRect();
  const visibleRect = getElementVisibleRect(preview);
  const padding = getPreviewPadding(preview);
  const clientX = Math.min(
    visibleRect.right - 1,
    Math.max(
      visibleRect.left + 1,
      Math.min(previewRect.right - 1, previewRect.left + padding.left + 8),
    ),
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

function getPreviewSourceProgressAtY(element: HTMLElement, clientY: number) {
  const rect = element.getBoundingClientRect();
  const height = Math.max(1, rect.height);

  return Math.min(1, Math.max(0, (clientY - rect.top) / height));
}

function getPreviewSourcePositionAtY(
  preview: HTMLElement,
  clientY: number,
): PreviewSourcePosition | null {
  const sourceElement = findPreviewSourceElementAtY(preview, clientY);

  if (!sourceElement) {
    return null;
  }

  const range = getMarkdownSourceRange(sourceElement);

  if (!range) {
    return null;
  }

  const progress = getPreviewSourceProgressAtY(sourceElement, clientY);

  return {
    progress,
    range,
  };
}

function getPreviewViewportAnchorPosition(
  preview: HTMLElement,
  viewportProgress: number,
): PreviewSourcePosition | null {
  const previewRect = preview.getBoundingClientRect();
  const visibleRect = getElementVisibleRect(preview);
  const padding = getPreviewPadding(preview);
  const contentTop = Math.max(previewRect.top + padding.top, visibleRect.top);
  const contentHeight = Math.max(1, visibleRect.bottom - contentTop);
  const clientY = Math.min(
    visibleRect.bottom - 1,
    Math.max(
      contentTop + 1,
      contentTop +
        contentHeight * Math.min(1, Math.max(0, viewportProgress)),
    ),
  );

  if (visibleRect.height <= 1) {
    return null;
  }

  return getPreviewSourcePositionAtY(preview, clientY);
}

function getMarkdownLineForOffset(value: string, offset: number) {
  const clampedOffset = Math.max(0, Math.min(offset, value.length));

  return value.slice(0, clampedOffset).split("\n").length;
}

function scrollPreviewToSourceOffset(
  preview: HTMLElement,
  offset: number,
  options: {
    block?: PreviewScrollBlock;
    sourceElement?: HTMLElement | null;
    sourceProgress?: number;
    viewportProgress?: number;
  } = {},
) {
  const sourceElement =
    options.sourceElement ?? findMarkdownSourceElementForOffset(preview, offset);
  const sourceRange = getMarkdownSourceRange(sourceElement);

  if (!sourceElement || !sourceRange) {
    return;
  }

  const previewRect = preview.getBoundingClientRect();
  const visibleRect = getElementVisibleRect(preview);
  const sourceRect = sourceElement.getBoundingClientRect();
  const padding = getPreviewPadding(preview);
  const sourceSpan = Math.max(1, sourceRange.end - sourceRange.start);
  const progress =
    typeof options.sourceProgress === "number"
      ? Math.min(1, Math.max(0, options.sourceProgress))
      : Math.min(1, Math.max(0, (offset - sourceRange.start) / sourceSpan));
  const offsetWithinElement = sourceRect.height * progress;
  const block = options.block ?? "start";

  if (typeof options.viewportProgress === "number") {
    const targetClientY = sourceRect.top + offsetWithinElement;
    const contentTop = Math.max(previewRect.top + padding.top, visibleRect.top);
    const contentHeight = Math.max(1, visibleRect.bottom - contentTop);
    const targetViewportY =
      contentTop +
      contentHeight * Math.min(1, Math.max(0, options.viewportProgress));

    preview.scrollTop = Math.max(
      0,
      preview.scrollTop + targetClientY - targetViewportY,
    );
    return;
  }

  if (block === "nearest") {
    const targetClientY = sourceRect.top + offsetWithinElement;
    const margin = Math.min(96, Math.max(24, visibleRect.height * 0.2));
    const topLimit = Math.max(previewRect.top + padding.top, visibleRect.top) + margin;
    const bottomLimit = visibleRect.bottom - margin;

    if (targetClientY < topLimit) {
      preview.scrollTop = Math.max(0, preview.scrollTop + targetClientY - topLimit);
    } else if (targetClientY > bottomLimit) {
      preview.scrollTop = Math.max(
        0,
        preview.scrollTop + targetClientY - bottomLimit,
      );
    }

    return;
  }

  preview.scrollTop = Math.max(
    0,
    preview.scrollTop +
      sourceRect.top +
      offsetWithinElement -
      Math.max(previewRect.top + padding.top, visibleRect.top),
  );
}

function useDebouncedPreviewContent(content: string, resetKey: string | undefined) {
  const [previewContent, setPreviewContent] = useState(content);
  const resetKeyRef = useRef(resetKey);
  const updateSequenceRef = useRef(0);

  useEffect(() => {
    updateSequenceRef.current += 1;
    const updateSequence = updateSequenceRef.current;

    if (resetKeyRef.current !== resetKey) {
      resetKeyRef.current = resetKey;
      setPreviewContent(content);
      return;
    }

    const timeout = window.setTimeout(() => {
      startTransition(() => {
        setPreviewContent((currentPreviewContent) =>
          updateSequenceRef.current === updateSequence
            ? content
            : currentPreviewContent,
        );
      });
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
  onCreateSlides,
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
  const activeMarkdownPathRef = useRef<string | undefined>(undefined);
  const openMarkdownFileLinkRef = useRef(onOpenMarkdownFileLink);
  const previewUserScrollUntilRef = useRef(0);
  const programmaticEditorScrollUntilRef = useRef(0);
  const programmaticPreviewScrollUntilRef = useRef(0);
  // True while the editor has unsaved keystrokes the debounced preview has not
  // rendered yet. The preview's source map is stale during this window, so
  // syncing scroll against it is both wasteful and inaccurate — skip it and let
  // the post-render re-sync (keyed on previewMarkdownDraft) catch up.
  const previewContentStaleRef = useRef(false);
  const markdownRestoreViewStateRef = useRef<MarkdownTabViewState | undefined>(undefined);
  const activeFileType = activeTab?.file.fileType;
  const activeMarkdownDraft = activeFileType === "markdown" ? activeTab?.draft ?? "" : "";
  const activeTabStatus = activeTab?.status;
  const activeTabId = activeTab?.id;
  const activeMarkdownPath =
    activeFileType === "markdown" ? activeTab?.file.path : undefined;
  const activeMarkdownIsSlides =
    activeTab?.file.fileType === "markdown" && isMarkdownSlidesPath(activeTab.file.path);
  const activeMarkdownViewState =
    activeTab?.file.fileType === "markdown" ? activeTab.viewState?.markdown : undefined;
  const markdownZoom = activeMarkdownViewState?.zoom ?? 100;
  const markdownSlideIndex = activeMarkdownViewState?.slideIndex ?? 0;
  const activePdfViewState =
    activeTab?.file.fileType === "pdf" ? activeTab.viewState?.pdf : undefined;
  const activeImageViewState =
    activeTab?.file.fileType === "image" ? activeTab.viewState?.image : undefined;
  const previewMarkdownDraft = useDebouncedPreviewContent(
    activeMarkdownDraft,
    activeTabId,
  );
  const previewContentStale = previewMarkdownDraft !== activeMarkdownDraft;
  const activeMarkdownSlidesDeck = useMemo(
    () => (activeMarkdownIsSlides ? parseMarkdownSlides(activeMarkdownDraft) : undefined),
    [activeMarkdownDraft, activeMarkdownIsSlides],
  );
  const previewFullscreen =
    activeTab?.file.fileType === "markdown" &&
    !activeMarkdownIsSlides &&
    activePreviewTabId === activeTab.id;
  const markdownSlidesPresenting =
    activeTab?.file.fileType === "markdown" &&
    activeMarkdownIsSlides &&
    activePreviewTabId === activeTab.id;

  const updateMarkdownViewState = useCallback(
    (patch: MarkdownTabViewState) => {
      if (!activeTabId) {
        return;
      }

      onSetViewState({ markdown: patch }, activeTabId);
    },
    [activeTabId, onSetViewState],
  );

  const updatePdfViewState = useCallback(
    (patch: PdfTabViewState) => {
      if (!activeTabId) {
        return;
      }

      onSetViewState({ pdf: patch }, activeTabId);
    },
    [activeTabId, onSetViewState],
  );

  const updateImageViewState = useCallback(
    (patch: ImageTabViewState) => {
      if (!activeTabId) {
        return;
      }

      onSetViewState({ image: patch }, activeTabId);
    },
    [activeTabId, onSetViewState],
  );

  useEffect(() => {
    previewContentStaleRef.current = previewContentStale;
  }, [previewContentStale]);

  useEffect(() => {
    activeMarkdownPathRef.current = activeMarkdownPath;
  }, [activeMarkdownPath]);

  useEffect(() => {
    openMarkdownFileLinkRef.current = onOpenMarkdownFileLink;
  }, [onOpenMarkdownFileLink]);

  const handleOpenMarkdownFileLink = useCallback((href: string) => {
    const sourcePath = activeMarkdownPathRef.current;

    if (!sourcePath) {
      return Promise.resolve(false);
    }

    return openMarkdownFileLinkRef.current(sourcePath, href);
  }, []);

  useEffect(() => {
    markdownRestoreViewStateRef.current = activeMarkdownViewState;
  }, [activeMarkdownViewState]);

  const markPreviewUserScrollIntent = useCallback(() => {
    previewUserScrollUntilRef.current =
      window.performance.now() + MARKDOWN_PREVIEW_USER_SCROLL_GRACE_MS;
  }, []);

  const markProgrammaticEditorScroll = useCallback(() => {
    programmaticEditorScrollUntilRef.current =
      window.performance.now() + MARKDOWN_PROGRAMMATIC_SCROLL_GRACE_MS;
  }, []);

  const markProgrammaticPreviewScroll = useCallback(() => {
    programmaticPreviewScrollUntilRef.current =
      window.performance.now() + MARKDOWN_PROGRAMMATIC_SCROLL_GRACE_MS;
  }, []);

  const syncMarkdownPreviewToTextarea = useCallback((options: {
    block?: PreviewScrollBlock;
    offset?: number;
    viewportProgress?: number;
  } = {}) => {
    const textarea = textareaRef.current;
    const preview = markdownPreviewRef.current;

    if (!textarea || !preview) {
      return;
    }

    const viewportProgress =
      options.viewportProgress ?? MARKDOWN_SCROLL_SYNC_ANCHOR_PROGRESS;
    const sourceOffset =
      options.offset ?? getTextareaViewportAnchorOffset(textarea, viewportProgress);
    const sourceElement = findMarkdownSourceElementForOffset(preview, sourceOffset);
    const sourceRange = getMarkdownSourceRange(sourceElement);
    const sourceProgress = sourceRange
      ? getTextareaVisualProgressForRange(textarea, sourceOffset, sourceRange)
      : undefined;

    markProgrammaticPreviewScroll();
    scrollPreviewToSourceOffset(preview, sourceOffset, {
      block: options.block,
      sourceElement,
      sourceProgress,
      viewportProgress,
    });
  }, [markProgrammaticPreviewScroll, textareaRef]);

  const syncMarkdownPreviewToActiveEditorPosition = useCallback(() => {
    const now = window.performance.now();

    if (now <= previewUserScrollUntilRef.current) {
      return;
    }

    syncMarkdownPreviewToTextarea({
      viewportProgress: MARKDOWN_SCROLL_SYNC_ANCHOR_PROGRESS,
    });
  }, [syncMarkdownPreviewToTextarea]);

  const syncTextareaToMarkdownPreview = useCallback(() => {
    const textarea = textareaRef.current;
    const preview = markdownPreviewRef.current;

    if (!textarea || !preview) {
      return;
    }

    const sourcePosition = getPreviewViewportAnchorPosition(
      preview,
      MARKDOWN_SCROLL_SYNC_ANCHOR_PROGRESS,
    );

    if (!sourcePosition) {
      return;
    }

    const sourceOffset = getTextareaOffsetAtVisualProgress(
      textarea,
      sourcePosition.range,
      sourcePosition.progress,
    );

    markProgrammaticEditorScroll();
    scrollTextareaToOffset(textarea, sourceOffset, {
      viewportProgress: MARKDOWN_SCROLL_SYNC_ANCHOR_PROGRESS,
    });
  }, [markProgrammaticEditorScroll, textareaRef]);

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
    if (
      activeFileType !== "markdown" ||
      !activeTabId ||
      previewFullscreen ||
      activeMarkdownIsSlides
    ) {
      return;
    }

    const textarea = textareaRef.current;
    const preview = markdownPreviewRef.current;

    if (!textarea || !preview) {
      return;
    }

    const editor = textarea;
    const previewPane = preview;

    // Scroll events fire faster than once per frame, and each editor sync forces
    // a full-document mirror reflow plus preview source-map queries. Coalesce
    // bursts into a single rAF so the work runs at most once per frame and off
    // the input's critical path.
    let editorScrollFrame = 0;
    let previewScrollFrame = 0;

    function runEditorScrollSync() {
      editorScrollFrame = 0;

      const now = window.performance.now();

      if (now <= programmaticEditorScrollUntilRef.current) {
        return;
      }

      // While the user is actively typing, the debounced preview has not
      // rendered the latest text yet, so its source map cannot be measured
      // accurately. Persist scroll position only and let the post-render
      // re-sync align the panes once the preview catches up.
      if (previewContentStaleRef.current) {
        updateMarkdownViewState({
          editorScrollLeft: editor.scrollLeft,
          editorScrollTop: editor.scrollTop,
          previewScrollLeft: previewPane.scrollLeft,
          previewScrollTop: previewPane.scrollTop,
        });
        return;
      }

      const syncAnchorOffset = getTextareaViewportAnchorOffset(
        editor,
        MARKDOWN_SCROLL_SYNC_ANCHOR_PROGRESS,
      );

      syncMarkdownPreviewToTextarea({
        offset: syncAnchorOffset,
        viewportProgress: MARKDOWN_SCROLL_SYNC_ANCHOR_PROGRESS,
      });
      updateMarkdownViewState({
        editorScrollLeft: editor.scrollLeft,
        editorScrollTop: editor.scrollTop,
        line: getMarkdownLineForOffset(editor.value, syncAnchorOffset),
        previewScrollLeft: previewPane.scrollLeft,
        previewScrollTop: previewPane.scrollTop,
      });
    }

    function runPreviewScrollSync() {
      previewScrollFrame = 0;

      const now = window.performance.now();
      const sourcePosition = getPreviewViewportAnchorPosition(
        previewPane,
        MARKDOWN_SCROLL_SYNC_ANCHOR_PROGRESS,
      );
      const sourceOffset = sourcePosition
        ? getTextareaOffsetAtVisualProgress(
            editor,
            sourcePosition.range,
            sourcePosition.progress,
          )
        : null;
      const hasPreviewUserIntent =
        now > programmaticPreviewScrollUntilRef.current &&
        now <= previewUserScrollUntilRef.current;

      if (hasPreviewUserIntent) {
        syncTextareaToMarkdownPreview();
      }

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

    function handleEditorScroll() {
      if (editorScrollFrame) {
        return;
      }

      editorScrollFrame = window.requestAnimationFrame(runEditorScrollSync);
    }

    function handlePreviewScroll() {
      if (previewScrollFrame) {
        return;
      }

      previewScrollFrame = window.requestAnimationFrame(runPreviewScrollSync);
    }

    editor.addEventListener("scroll", handleEditorScroll, { passive: true });
    previewPane.addEventListener("scroll", handlePreviewScroll, { passive: true });

    return () => {
      editor.removeEventListener("scroll", handleEditorScroll);
      previewPane.removeEventListener("scroll", handlePreviewScroll);

      if (editorScrollFrame) {
        window.cancelAnimationFrame(editorScrollFrame);
      }

      if (previewScrollFrame) {
        window.cancelAnimationFrame(previewScrollFrame);
      }
    };
  }, [
    activeFileType,
    activeTabId,
    activeMarkdownIsSlides,
    previewFullscreen,
    syncMarkdownPreviewToTextarea,
    syncTextareaToMarkdownPreview,
    textareaRef,
    updateMarkdownViewState,
  ]);

  useEffect(() => {
    if (
      activeFileType !== "markdown" ||
      !activeTabId ||
      previewFullscreen ||
      activeMarkdownIsSlides
    ) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(
      syncMarkdownPreviewToActiveEditorPosition,
    );

    return () => window.cancelAnimationFrame(animationFrame);
  }, [
    activeFileType,
    activeTabId,
    activeMarkdownIsSlides,
    previewMarkdownDraft,
    previewFullscreen,
    markdownZoom,
    syncMarkdownPreviewToActiveEditorPosition,
  ]);

  useEffect(() => {
    if (activeFileType !== "markdown" || !activeTabId) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      const preview = markdownPreviewRef.current;
      const viewState = markdownRestoreViewStateRef.current;

      if (textarea && !previewFullscreen && !markdownSlidesPresenting) {
        markProgrammaticEditorScroll();
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
        markProgrammaticPreviewScroll();
        preview.scrollLeft = viewState?.previewScrollLeft ?? 0;
        preview.scrollTop = viewState?.previewScrollTop ?? 0;
      }
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [
    activeFileType,
    activeTabId,
    markProgrammaticEditorScroll,
    markProgrammaticPreviewScroll,
    markdownSlidesPresenting,
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

      if (activeTabStatus === "saving") {
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
    const markdownDraft = textareaRef.current?.value ?? activeMarkdownDraft;

    updateMarkdownViewState({
      line: getMarkdownLineForOffset(markdownDraft, selection.start),
      selectionEnd: selection.end,
      selectionStart: selection.start,
    });
  }

  function handleMarkdownDraftChange(value: string) {
    onSetDraft(value);
  }

  function handleMarkdownPreviewScroll(event: ReactUIEvent<HTMLElement>) {
    const preview = event.currentTarget;

    updateMarkdownViewState({
      previewScrollLeft: preview.scrollLeft,
      previewScrollTop: preview.scrollTop,
    });
  }

  function handleMarkdownPreviewPointerDown(event: ReactPointerEvent<HTMLElement>) {
    const preview = event.currentTarget;
    const rect = preview.getBoundingClientRect();
    const scrollbarGutter = 18;
    const inScrollbarGutter =
      event.clientX >= rect.right - scrollbarGutter ||
      event.clientY >= rect.bottom - scrollbarGutter;

    if (event.target === preview || inScrollbarGutter) {
      markPreviewUserScrollIntent();
    }
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
    const draft = textarea?.value ?? activeTab.draft;
    const scrollLeft = textarea?.scrollLeft ?? 0;
    const scrollTop = textarea?.scrollTop ?? 0;
    const selectionStart = textarea?.selectionStart ?? 0;
    const selectionEnd = textarea?.selectionEnd ?? selectionStart;

    onSetDraft(normalizeChatGptCopiedMarkdown(draft));

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

  function enumerateActiveMarkdownHeadings(
    scope: MarkdownHeadingEnumerationScope,
    startAt = 1,
  ) {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    const textarea = textareaRef.current;
    const draft = textarea?.value ?? activeTab.draft;
    const scrollLeft = textarea?.scrollLeft ?? 0;
    const scrollTop = textarea?.scrollTop ?? 0;
    const selectionStart =
      textarea?.selectionStart ?? activeMarkdownViewState?.selectionStart ?? 0;
    const selectionEnd =
      textarea?.selectionEnd ?? activeMarkdownViewState?.selectionEnd ?? selectionStart;
    const nextDraft = enumerateMarkdownHeadings(draft, {
      scope,
      selection: {
        end: selectionEnd,
        start: selectionStart,
      },
      startAt,
    });

    if (nextDraft === draft) {
      window.requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
      return;
    }

    onSetDraft(nextDraft);

    const nextSelectionStart = Math.min(selectionStart, nextDraft.length);
    const nextSelectionEnd = Math.min(selectionEnd, nextDraft.length);

    updateMarkdownViewState({
      line: getMarkdownLineForOffset(nextDraft, nextSelectionStart),
      selectionEnd: nextSelectionEnd,
      selectionStart: nextSelectionStart,
    });

    window.requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current;

      if (!nextTextarea) {
        return;
      }

      nextTextarea.focus();
      nextTextarea.setSelectionRange(nextSelectionStart, nextSelectionEnd);
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

    const sourceRange = getMarkdownSourceRange(sourceElement);

    if (!sourceRange) {
      return;
    }

    const sourceOffset = getTextareaOffsetAtVisualProgress(
      textarea,
      sourceRange,
      getPreviewSourceProgressAtY(sourceElement, event.clientY),
    );
    const clampedOffset = Math.max(0, Math.min(sourceOffset, textarea.value.length));

    event.preventDefault();
    markProgrammaticEditorScroll();
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
          onCreateSlides={onCreateSlides}
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
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <button
                className="inline-flex items-center gap-2 rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50"
                type="button"
                onClick={() => onCreateMarkdown(firstNotebook)}
              >
                <FilePlus2 aria-hidden className="h-4 w-4" />
                New note
              </button>
              <button
                className="inline-flex items-center gap-2 rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
                type="button"
                onClick={() => onCreateSlides(firstNotebook)}
              >
                <FilePlus2 aria-hidden className="h-4 w-4" />
                New slides
              </button>
            </div>
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
            isSlideDeck={activeMarkdownIsSlides}
            markdownZoom={markdownZoom}
            onEnumerateHeadings={enumerateActiveMarkdownHeadings}
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
            previewFullscreen={previewFullscreen || markdownSlidesPresenting}
          />
          {previewFullscreen ? (
            <article
              key={`${activeTab.id}-fullscreen-preview`}
              ref={markdownPreviewRef}
              className="markdown-preview-pane min-h-0 flex-1 overflow-auto bg-card p-6"
              onPointerDown={handleMarkdownPreviewPointerDown}
              onScroll={handleMarkdownPreviewScroll}
              onTouchStart={markPreviewUserScrollIntent}
              onWheel={markPreviewUserScrollIntent}
            >
              <MarkdownRenderer
                content={activeTab.draft}
                documentPath={activeTab.file.path}
                onOpenFileLink={handleOpenMarkdownFileLink}
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
                key={activeTab.id}
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
                onChange={handleMarkdownDraftChange}
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
                key={`${activeTab.id}-preview`}
                ref={markdownPreviewRef}
                className={`min-h-0 min-w-0 overflow-auto ${
                  activeMarkdownIsSlides
                    ? "bg-zinc-100"
                    : "markdown-preview-pane bg-card p-6"
                }`}
                onDoubleClick={
                  activeMarkdownIsSlides ? undefined : handleMarkdownPreviewDoubleClick
                }
                onPointerDown={handleMarkdownPreviewPointerDown}
                onScroll={handleMarkdownPreviewScroll}
                onTouchStart={markPreviewUserScrollIntent}
                onWheel={markPreviewUserScrollIntent}
              >
                {activeMarkdownIsSlides && activeMarkdownSlidesDeck ? (
                  <MarkdownSlidesPreview
                    activeSlideIndex={markdownSlideIndex}
                    deck={activeMarkdownSlidesDeck}
                    documentPath={activeTab.file.path}
                    onOpenFileLink={(href) =>
                      onOpenMarkdownFileLink(activeTab.file.path, href)
                    }
                    textScale={markdownZoom / 100}
                  />
                ) : (
                  <MarkdownRenderer
                    content={previewMarkdownDraft}
                    documentPath={activeTab.file.path}
                    onOpenFileLink={(href) =>
                      onOpenMarkdownFileLink(activeTab.file.path, href)
                    }
                    textScale={markdownZoom / 100}
                  />
                )}
              </article>
            </div>
          )}
          {markdownSlidesPresenting && activeMarkdownSlidesDeck ? (
            <MarkdownSlidesPresenter
              deck={activeMarkdownSlidesDeck}
              documentPath={activeTab.file.path}
              initialSlideIndex={markdownSlideIndex}
              onExit={() => setActivePreviewTabId(null)}
              onOpenFileLink={(href) =>
                onOpenMarkdownFileLink(activeTab.file.path, href)
              }
              onSlideIndexChange={(slideIndex) =>
                updateMarkdownViewState({ slideIndex })
              }
              textScale={markdownZoom / 100}
            />
          ) : null}
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
          key={activeTab.id}
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
