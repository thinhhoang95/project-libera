import type { MathMarkerSettings } from "@/lib/math-markers";
import {
  BookPlus,
  CalendarPlus,
  FileText,
  FilePlus2,
  History,
} from "lucide-react";
import type {
  CSSProperties,
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
  SetStateAction,
  UIEvent as ReactUIEvent,
} from "react";
import {
  memo,
  startTransition,
  useLayoutEffect,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { MarkdownWorkerPreview } from "./markdown-worker-preview";
import { ExistingImageDialog } from "@/components/libera/existing-image-dialog";
import { GalleryPhotoPicker, galleryPhotoFile } from "@/components/libera/gallery-photo-picker";
import { apiRequest, encodeFilePath } from "@/components/libera/api-client";
import {
  ReferenceRenderProvider,
  referenceNotebookForPath,
  type ReferenceAttachmentLocator,
} from "@/components/libera/references/reference-render-context";
import type { ReferenceAttachment } from "@/lib/references/types";
import { useCanvasViewStateCapture } from "./canvas-view-state";
import { ImageViewer } from "@/components/libera/image-viewer";
import { VoiceMemoViewer } from "@/components/libera/audio/voice-memo-viewer";
import { isGalleryTab } from "@/components/libera/gallery-tabs";
import { NoteMathMarkersProvider } from "@/components/libera/note-math-context";
import { MarkdownEditor } from "@/components/libera/markdown-editor";
import { MarkdownSourceEditor } from "@/components/libera/markdown-source/markdown-source-editor";
import type { RegisterEditorDraft } from "./use-tiptap-draft";
import { TiptapMarkdownEditor } from "@/components/libera/tiptap-markdown-editor";
import { sharedCodeMirrorSource } from "@/lib/collab/bindings/react-codemirror";
import { SharedMarkdownSourceEditor } from "@/lib/collab/bindings/react-markdown-source";
import { SharedTabChrome } from "@/lib/collab/bindings/react-shared-chrome";
import { useSharedTab } from "@/lib/collab/bindings/react-shared-tabs";
import { sharedVisualSource } from "@/lib/collab/bindings/react-visual";
import type { DraftWriteOptions } from "@/lib/collab/client/workspace";
import {
  MarkdownSlidesPresenter,
  MarkdownSlidesPreview,
} from "@/components/libera/markdown-slides-viewer";
import { MarkdownToolbar } from "@/components/libera/markdown-toolbar";
import { MarkdownTextWidth } from "./markdown-text-width";
import { useMarkdownDisplayPreferences } from "./markdown-display-preferences";
import { MarkdownStatusBar } from "@/components/libera/markdown-status-bar";
import { NotebookHome } from "@/components/libera/notebook-home";
import { PdfViewer } from "@/components/libera/pdf-viewer";
import { normalizeChatGptCopiedMarkdown } from "@/lib/chatgpt-markdown-normalizer";
import type { PhotoEdits } from "@/lib/photo-edits";
import type {
  AudioTabViewState,
  ImageTabViewState,
  LatexTabViewState,
  MarkdownFileLinkRange,
  MarkdownFileLinkSelection,
  MarkdownEditorMode,
  MarkdownTabViewState,
  MarkdownScreenshotSnipMode,
  MarkdownScreenshotSnipSession,
  PendingVisualInsertion,
  OpenTab,
  OpenTabViewState,
  PdfTabViewState,
  TextTabViewState,
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
  getMarkdownEditorFontStack,
  getRenderedMarkdownFontStack,
  getWysiwygEditorFontStack,
  type MarkdownPreferences,
} from "@/lib/markdown-preferences";
import {
  getTextareaOffsetAtVisualProgress,
  getTextareaViewportAnchorOffset,
  getTextareaVisualProgressForRange,
  scrollTextareaToOffset,
} from "@/lib/textarea-position";
import type { LiberaFileNode, LiberaFilePayload, LiberaNotebookNode } from "@/lib/types";

type WorkspacePanelProps = {
  // False for background panes of a split canvas: they render their tab but
  // leave window shortcuts and the shared textarea ref to the focused pane.
  focused?: boolean;
  markdownEditorMode: MarkdownEditorMode;
  activePreviewTabId: string | null;
  onActivePreviewTabIdChange: Dispatch<SetStateAction<string | null>>;
  activeTab?: OpenTab;
  files: LiberaFileNode[];
  aiFormatting: boolean;
  canStartScreenshotSnip: boolean;
  firstNotebook: string;
  imageMarkdownConverting: boolean;
  yourName: string;
  markdownPreferences: MarkdownPreferences;
  recentFiles: LiberaFileNode[];
  screenshotSnipSession: MarkdownScreenshotSnipSession | null;
  selectedNotebook?: LiberaNotebookNode;
  isFolder?: boolean;
  fileTags: Record<string, string[]>;
  onEditFileTags: (file: LiberaFileNode) => void;
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
  onAiWriteAt: (offset: number, prompt: string) => Promise<void>;
  onCreateMarkdown: (notebook: string) => Promise<void>;
  onCreateSlides: (notebook: string) => Promise<void>;
  onCreateLatex?: (notebook: string) => Promise<void>;
  onCreateNotebook: () => void;
  onCancelScreenshotSnip: () => void;
  onCompleteScreenshotSnip: (file: File, mathMarkers?: MathMarkerSettings) => Promise<void>;
  /** Markdown the visual editor of this tab should insert at its selection. */
  pendingVisualInsertion?: PendingVisualInsertion;
  onFinishVisualInsertion: (tabId: string, id: string) => void;
  /** Convert PDF to Markdown: create the file beside the PDF, then save pages into it. */
  onCreateMarkdownBesidePdf: (pdfPath: string) => Promise<LiberaFileNode>;
  onWriteConvertedMarkdown: (path: string, content: string) => Promise<void>;
  /** An unsaved Markdown tab with this content, saved into `directory` by default. */
  onCreateUntitledMarkdown?: (fileName: string, content: string, directory: string) => void;
  onInsertExistingImage: (file: LiberaFileNode) => Promise<void>;
  onInsertFileLink: (
    selection: MarkdownFileLinkSelection,
    range?: MarkdownFileLinkRange,
  ) => void;
  onInsertFileLinkPlaceholder: () => void;
  onInsertImage: (file: File) => Promise<void>;
  onInsertMarkdown: (before: string, after?: string, placeholder?: string) => void;
  onOpenFile: (file: LiberaFileNode, options?: { viewState?: OpenTabViewState }) => Promise<void>;
  /** Shows another image from the same folder in this image tab. */
  onShowImage?: (file: LiberaFileNode) => void;
  onSaveEditedImageCopy?: (sourcePath: string, edits: PhotoEdits) => Promise<void>;
  onSave: () => Promise<void>;
  /** `options` describes programmatic writes for shared tabs (provenance, the text they started from). */
  onSetDraft: (value: string, options?: DraftWriteOptions) => void;
  onRegisterEditorDraft?: RegisterEditorDraft;
  onSetViewState: (viewState: OpenTabViewState, tabId?: string) => void;
  onOpenMarkdownFileLink: (sourcePath: string, href: string) => Promise<boolean>;
  onStartScreenshotSnip: (mode?: MarkdownScreenshotSnipMode, editor?: "source" | "visual") => void;
};

// CodeMirror and the PDF pane load only when a LaTeX file is opened.
const LatexWorkspace = dynamic(
  () => import("@/components/libera/latex/latex-workspace").then((module) => module.LatexWorkspace),
  { ssr: false, loading: () => <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">Loading LaTeX editor…</div> },
);

const CodeEditor = dynamic(
  () => import("@/components/libera/code-editor").then((module) => module.CodeEditor),
  { ssr: false, loading: () => <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">Loading editor…</div> },
);

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

type PendingMarkdownScrollState = {
  tabId: string;
  viewState: MarkdownTabViewState;
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

function markdownFileDisplayName(fileName: string) {
  return fileName.replace(/\.(?:md|markdown)$/i, "");
}

function formatFileMetadataDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function MarkdownPreviewMetadata({ file }: { file: LiberaFileNode }) {
  const createdDate = formatFileMetadataDate(file.createdAt);
  const updatedDate = formatFileMetadataDate(file.updatedAt);

  return (
    <div
      className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
      data-markdown-preview-metadata
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div
        className="flex min-w-0 items-center gap-1.5 font-medium text-foreground"
        title={markdownFileDisplayName(file.name)}
      >
        <FileText aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{markdownFileDisplayName(file.name)}</span>
      </div>
      <div className="flex items-center gap-1.5" title={`Created ${createdDate}`}>
        <CalendarPlus aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <span>Created</span>
        <time dateTime={file.createdAt}>{createdDate}</time>
      </div>
      <div className="flex items-center gap-1.5" title={`Last changed ${updatedDate}`}>
        <History aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <span>Changed</span>
        <time dateTime={file.updatedAt}>{updatedDate}</time>
      </div>
    </div>
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
  const [preview, setPreview] = useState({ content, resetKey });
  const updateSequenceRef = useRef(0);

  useEffect(() => {
    updateSequenceRef.current += 1;
    const updateSequence = updateSequenceRef.current;

    const timeout = window.setTimeout(() => {
      startTransition(() => {
        setPreview((currentPreview) =>
          updateSequenceRef.current === updateSequence
            ? currentPreview.content === content && currentPreview.resetKey === resetKey
              ? currentPreview
              : { content, resetKey }
            : currentPreview,
        );
      });
    }, MARKDOWN_PREVIEW_RENDER_DELAY_MS);

    return () => window.clearTimeout(timeout);
  }, [content, resetKey]);

  // Reset before children mount their effects: otherwise a new tab's worker
  // starts parsing the old tab before the reset effect can publish its content.
  if (preview.resetKey !== resetKey) {
    setPreview({ content, resetKey });
    return content;
  }
  return preview.content;
}

const PANEL_CALLBACKS = [
  "onActivePreviewTabIdChange",
  "onAiFormatSelection",
  "onAiImageToMarkdown",
  "onAiRewriteSelection",
  "onAiWriteAt",
  "onCreateMarkdown",
  "onCreateSlides",
  "onCreateLatex",
  "onCreateNotebook",
  "onEditFileTags",
  "onCancelScreenshotSnip",
  "onCompleteScreenshotSnip",
  "onFinishVisualInsertion",
  "onCreateMarkdownBesidePdf",
  "onWriteConvertedMarkdown",
  "onCreateUntitledMarkdown",
  "onInsertExistingImage",
  "onInsertFileLink",
  "onInsertFileLinkPlaceholder",
  "onInsertImage",
  "onInsertMarkdown",
  "onOpenFile",
  "onShowImage",
  "onSaveEditedImageCopy",
  "onSave",
  "onSetDraft",
  "onRegisterEditorDraft",
  "onSetViewState",
  "onOpenMarkdownFileLink",
  "onStartScreenshotSnip",
] as const;

type PanelContentProps = Omit<WorkspacePanelProps, "tabs"> & { readOpenTabs: () => OpenTab[] };

export function WorkspacePanel(props: WorkspacePanelProps) {
  // Keep callbacks and cleanup scoped to their document when a pane changes tabs.
  return <WorkspacePanelScope key={props.activeTab?.id ?? "empty"} {...props} />;
}

function WorkspacePanelScope(props: WorkspacePanelProps) {
  const paneTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { textareaRef: activeTextareaRef } = props;
  const { tabs, ...contentProps } = props;
  const scope = useRef(props);
  useLayoutEffect(() => { scope.current = { ...contentProps, tabs }; });
  const callbacks = useMemo(() => Object.fromEntries(PANEL_CALLBACKS.map((key) => [
    key,
    (...args: never[]) => {
      const callback = scope.current[key] as ((...args: never[]) => unknown) | undefined;
      return callback?.(...args);
    },
  ])) as Pick<WorkspacePanelProps, typeof PANEL_CALLBACKS[number]>, [scope]);
  const readOpenTabs = useCallback(() => scope.current.tabs, [scope]);

  // Focus changes the target of global commands, never the pane's own ref.
  useLayoutEffect(() => {
    if (props.focused === false) return;
    const textarea = paneTextareaRef.current;
    activeTextareaRef.current = textarea;
    return () => {
      if (activeTextareaRef.current === textarea) activeTextareaRef.current = null;
    };
  }, [props.focused, activeTextareaRef, props.markdownEditorMode, props.activePreviewTabId]);

  // Only data for this document crosses the memo boundary. Link suggestions
  // read the latest open-tab positions when invoked, without subscribing the
  // whole editor to every other tab's scrolling and draft publications.
  return (
    <MemoizedWorkspacePanelContent
      {...contentProps}
      {...callbacks}
      readOpenTabs={readOpenTabs}
      textareaRef={paneTextareaRef}
    />
  );
}

const MemoizedWorkspacePanelContent = memo(WorkspacePanelContent);

// Shared editors publish nothing: the workspace reads the Y.Text itself.
const ignoreSharedDraft = () => {};

function WorkspacePanelContent({
  focused = true,
  markdownEditorMode,
  activePreviewTabId,
  onActivePreviewTabIdChange: setActivePreviewTabId,
  activeTab,
  files,
  aiFormatting,
  canStartScreenshotSnip,
  firstNotebook,
  imageMarkdownConverting,
  yourName,
  markdownPreferences,
  recentFiles,
  screenshotSnipSession,
  selectedNotebook,
  isFolder,
  fileTags,
  onEditFileTags,
  readOpenTabs,
  textareaRef,
  onAiFormatSelection,
  onAiImageToMarkdown,
  onAiRewriteSelection,
  onAiWriteAt,
  onCreateMarkdown,
  onCreateSlides,
  onCreateLatex,
  onCreateNotebook,
  onCancelScreenshotSnip,
  onCompleteScreenshotSnip,
  pendingVisualInsertion,
  onFinishVisualInsertion,
  onCreateMarkdownBesidePdf,
  onWriteConvertedMarkdown,
  onCreateUntitledMarkdown,
  onInsertExistingImage,
  onInsertFileLink,
  onInsertImage,
  onInsertMarkdown,
  onOpenFile,
  onShowImage,
  onSaveEditedImageCopy,
  onSave,
  onSetDraft,
  onRegisterEditorDraft,
  onSetViewState,
  onOpenMarkdownFileLink,
  onStartScreenshotSnip,
}: PanelContentProps) {
  const [existingImageDialogOpen, setExistingImageDialogOpen] = useState(false);
  const [galleryPickerOpen, setGalleryPickerOpen] = useState(false);
  const [markdownSplitDragging, setMarkdownSplitDragging] = useState(false);
  const [markdownSplitPercent, setMarkdownSplitPercent] = useState(
    DEFAULT_MARKDOWN_SPLIT_PERCENT,
  );
  const markdownSplitContainerRef = useRef<HTMLDivElement | null>(null);
  const latestMarkdownSplit = useRef(markdownSplitPercent);
  useLayoutEffect(() => { latestMarkdownSplit.current = markdownSplitPercent; }, [markdownSplitPercent]);
  const stopMarkdownSplitDragRef = useRef<(() => void) | null>(null);
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
  const pendingStaleEditorScrollStateRef = useRef<PendingMarkdownScrollState | null>(null);
  const markdownRestoreViewStateRef = useRef<MarkdownTabViewState | undefined>(undefined);
  const pendingPreviewRestoreRef = useRef<MarkdownTabViewState | null>(null);
  const sourceRestoredRef = useRef(false);
  const pendingMarkdownViewportRef = useRef<MarkdownTabViewState>({});
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
  const { preferences: displayPreferences, updatePreferences: updateDisplayPreferences } = useMarkdownDisplayPreferences();
  const markdownZoom = displayPreferences.textScale;
  const markdownZoomScale = markdownZoom / 100;
  const markdownFontSizePx = markdownPreferences.baseFontSize * markdownZoomScale;
  const markdownEditorFontFamily = getMarkdownEditorFontStack(
    markdownPreferences.editorFontFamily,
  );
  const wysiwygEditorFontFamily = getWysiwygEditorFontStack(
    markdownPreferences.wysiwygEditorFontFamily,
  );
  const renderedMarkdownFontFamily = getRenderedMarkdownFontStack(
    markdownPreferences.renderedMarkdownFontFamily,
  );
  const markdownLineHeightPx =
    markdownPreferences.baseFontSize *
    markdownPreferences.baseLineHeight *
    markdownZoomScale;
  const markdownSlideIndex = activeMarkdownViewState?.slideIndex ?? 0;
  const activePdfViewState =
    activeTab?.file.fileType === "pdf" ? activeTab.viewState?.pdf : undefined;
  const activeImageViewState =
    activeTab?.file.fileType === "image" ? activeTab.viewState?.image : undefined;
  // The images beside this one in its folder, for stepping through them.
  const activeImageFile = activeTab?.file.fileType === "image" && !isGalleryTab(activeTab) ? activeTab.file : undefined;
  const imageSiblings = useMemo(() => {
    if (!activeImageFile) {
      return undefined;
    }

    const folder = activeImageFile.path.slice(0, activeImageFile.path.lastIndexOf("/"));
    return files
      .filter((file) => file.fileType === "image" && file.path.slice(0, file.path.lastIndexOf("/")) === folder)
      .sort((first, second) => first.name.localeCompare(second.name, undefined, { numeric: true, sensitivity: "base" }))
      .map((file) => ({ path: file.path, src: `/api/files/raw/${encodeFilePath(file.path)}` }));
  }, [activeImageFile, files]);
  const imageFileByPath = useMemo(
    () => new Map(files.map((file) => [file.path, file])),
    [files],
  );
  // The recordings beside this one in its folder, for previous and next.
  const activeAudioFile = activeTab?.file.fileType === "audio" ? activeTab.file : undefined;
  const audioSiblings = useMemo(() => {
    if (!activeAudioFile) return [];
    const folder = activeAudioFile.path.slice(0, activeAudioFile.path.lastIndexOf("/"));
    return files
      .filter((file) => file.fileType === "audio" && file.path.slice(0, file.path.lastIndexOf("/")) === folder)
      .sort((first, second) => first.name.localeCompare(second.name, undefined, { numeric: true, sensitivity: "base" }));
  }, [activeAudioFile, files]);
  const previewMarkdownDraft = useDebouncedPreviewContent(
    activeMarkdownDraft,
    activeTabId,
  );
  const [renderedPreview, setRenderedPreview] = useState<{ tabId: string | undefined; content: string } | null>(null);
  const handlePreviewContentReady = useCallback((content: string) => {
    setRenderedPreview({ tabId: activeTabId, content });
  }, [activeTabId]);
  const previewContentStale = markdownEditorMode === "source" && !activeMarkdownIsSlides
    ? renderedPreview?.tabId !== activeTabId || renderedPreview?.content !== activeMarkdownDraft
    : previewMarkdownDraft !== activeMarkdownDraft;
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

  useEffect(() => () => {
    stopMarkdownSplitDragRef.current?.();
  }, [activeTabId, markdownEditorMode, previewFullscreen, markdownSlidesPresenting]);

  const registerMarkdownDraft = useCallback((read: () => string) => {
    return (activeTabId && onRegisterEditorDraft?.(activeTabId, read)) || (() => {});
  }, [activeTabId, onRegisterEditorDraft]);

  // Shared tabs (plan M1.4): the editor binds the tab's replica, which lives
  // in the registry; this panel holds it while it shows the tab.
  const panelHolder = useId();
  const sharedTab = useSharedTab(activeTabId, panelHolder);
  const sharedSession = sharedTab.session;
  const sharedAttached = !!sharedTab.snapshot?.attached;
  const sharedGeneration = sharedTab.snapshot?.generation ?? 0;
  const sharedPending = sharedTab.state.kind === "pending" || (sharedTab.state.kind === "shared" && !sharedAttached);
  const sharedCodeMirror = useMemo(
    () => (sharedSession && sharedAttached ? sharedCodeMirrorSource(sharedSession) : null),
    // A rebuilt content document needs a new source (and a remount, by key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sharedSession, sharedAttached, sharedGeneration],
  );
  const sharedVisual = useMemo(
    () => (sharedSession && sharedAttached ? sharedVisualSource(sharedSession) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sharedSession, sharedAttached, sharedGeneration],
  );
  const editorKey = sharedCodeMirror ? `${activeTabId}:shared:${sharedGeneration}` : activeTabId;

  const updateMarkdownViewState = useCallback(
    (patch: MarkdownTabViewState) => {
      if (!activeTabId) {
        return;
      }

      onSetViewState({ markdown: patch }, activeTabId);
    },
    [activeTabId, onSetViewState],
  );

  // A one-shot request (Global Search) to select a passage. The visual editor
  // handles its own; in the source editor, select the passage in the textarea
  // after the tab's scroll and selection are restored.
  const markdownReveal = activeMarkdownViewState?.reveal;
  const markdownUsesSourceEditor = markdownEditorMode !== "visual" || activeMarkdownIsSlides;
  useEffect(() => {
    if (!markdownReveal || !markdownUsesSourceEditor) return;
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          const start = Math.min(markdownReveal.start, textarea.value.length);
          const end = Math.min(markdownReveal.end, textarea.value.length);
          textarea.focus({ preventScroll: true });
          textarea.setSelectionRange(start, end);
          scrollTextareaToOffset(textarea, start, { block: "center" });
        }
        updateMarkdownViewState({ reveal: undefined, selectionStart: markdownReveal.start, selectionEnd: markdownReveal.end });
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [markdownReveal, markdownUsesSourceEditor, textareaRef, updateMarkdownViewState]);

  const updateLatexViewState = useCallback(
    (patch: LatexTabViewState) => {
      if (!activeTabId) {
        return;
      }

      onSetViewState({ latex: patch }, activeTabId);
    },
    [activeTabId, onSetViewState],
  );

  const updateTextViewState = useCallback(
    (patch: TextTabViewState) => {
      if (!activeTabId) {
        return;
      }

      onSetViewState({ text: patch }, activeTabId);
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

  const updateAudioViewState = useCallback(
    (patch: AudioTabViewState) => {
      if (!activeTabId) {
        return;
      }

      onSetViewState({ audio: patch }, activeTabId);
    },
    [activeTabId, onSetViewState],
  );

  const captureMarkdownViewState = useCallback(() => {
    if (markdownEditorMode !== "source" || !sourceRestoredRef.current) return;
    const textarea = textareaRef.current;
    const preview = markdownPreviewRef.current;
    updateMarkdownViewState({
      ...pendingMarkdownViewportRef.current,
      ...(textarea?.isConnected ? {
        editorScrollLeft: textarea.scrollLeft, editorScrollTop: textarea.scrollTop,
        selectionStart: textarea.selectionStart, selectionEnd: textarea.selectionEnd,
      } : {}),
      ...(preview?.isConnected && !pendingPreviewRestoreRef.current ? {
        previewScrollLeft: preview.scrollLeft, previewScrollTop: preview.scrollTop,
      } : {}),
    });
  }, [markdownEditorMode, textareaRef, updateMarkdownViewState]);
  useCanvasViewStateCapture(captureMarkdownViewState);
  useLayoutEffect(() => () => captureMarkdownViewState(), [captureMarkdownViewState, previewFullscreen, markdownSlidesPresenting]);

  useEffect(() => {
    previewContentStaleRef.current = previewContentStale;

    if (previewContentStale) {
      return;
    }

    const pendingScrollState = pendingStaleEditorScrollStateRef.current;

    if (!pendingScrollState) {
      return;
    }

    pendingStaleEditorScrollStateRef.current = null;

    if (pendingScrollState.tabId !== activeTabId) {
      return;
    }

    updateMarkdownViewState(pendingScrollState.viewState);
  }, [activeTabId, previewContentStale, updateMarkdownViewState]);

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

  // Citation hover cards open an entry's attachment: a PDF at the cited page
  // (the viewState.pdf.reveal request Global Search uses), or the file.
  const openFileRef = useRef(onOpenFile);
  useEffect(() => {
    openFileRef.current = onOpenFile;
  }, [onOpenFile]);
  const openReferenceAttachment = useCallback((attachment: ReferenceAttachment, locator?: ReferenceAttachmentLocator) => {
    if (attachment.kind === "url") {
      window.open(attachment.url, "_blank", "noopener,noreferrer");
      return;
    }
    void apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(attachment.path)}`)
      .then(({ file }) => openFileRef.current(file, attachment.kind === "pdf" && locator?.page
        ? { viewState: { pdf: { reveal: { page: locator.page, nonce: Date.now() } } } }
        : undefined))
      .catch(() => undefined);
  }, []);

  useLayoutEffect(() => {
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

  const syncTextareaToMarkdownPreview = useCallback((measuredPosition?: PreviewSourcePosition) => {
    const textarea = textareaRef.current;
    const preview = markdownPreviewRef.current;

    if (!textarea || !preview) {
      return;
    }

    const sourcePosition = measuredPosition ?? getPreviewViewportAnchorPosition(
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
      // accurately. Keep scroll position in a ref and let the post-render
      // re-sync align the panes once the preview catches up.
      if (previewContentStaleRef.current) {
        if (activeTabId) {
          pendingStaleEditorScrollStateRef.current = {
            tabId: activeTabId,
            viewState: {
              editorScrollLeft: editor.scrollLeft,
              editorScrollTop: editor.scrollTop,
              previewScrollLeft: previewPane.scrollLeft,
              previewScrollTop: previewPane.scrollTop,
            },
          };
        }

        return;
      }

      pendingStaleEditorScrollStateRef.current = null;

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
      if (now <= programmaticPreviewScrollUntilRef.current) {
        updateMarkdownViewState({ editorScrollLeft: editor.scrollLeft, editorScrollTop: editor.scrollTop,
          previewScrollLeft: previewPane.scrollLeft, previewScrollTop: previewPane.scrollTop });
        return;
      }
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
        syncTextareaToMarkdownPreview(sourcePosition ?? undefined);
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
      pendingMarkdownViewportRef.current = { ...pendingMarkdownViewportRef.current,
        editorScrollLeft: editor.scrollLeft, editorScrollTop: editor.scrollTop };
      if (editorScrollFrame) {
        return;
      }

      editorScrollFrame = window.requestAnimationFrame(runEditorScrollSync);
    }

    function handlePreviewScroll() {
      if (!pendingPreviewRestoreRef.current) pendingMarkdownViewportRef.current = { ...pendingMarkdownViewportRef.current,
        previewScrollLeft: previewPane.scrollLeft, previewScrollTop: previewPane.scrollTop };
      if (previewScrollFrame) {
        return;
      }

      previewScrollFrame = window.requestAnimationFrame(runPreviewScrollSync);
    }

    // Source drafts publish after a pause, but the preview map becomes stale at
    // the first native input. Avoid measuring the full mirror while typing.
    const markSourceInput = () => { previewContentStaleRef.current = true; };
    editor.addEventListener("input", markSourceInput);
    editor.addEventListener("scroll", handleEditorScroll, { passive: true });
    previewPane.addEventListener("scroll", handlePreviewScroll, { passive: true });

    return () => {
      editor.removeEventListener("input", markSourceInput);
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
    markdownEditorMode,
    previewFullscreen,
    syncMarkdownPreviewToTextarea,
    syncTextareaToMarkdownPreview,
    textareaRef,
    updateMarkdownViewState,
  ]);

  const lastSyncedMarkdownRef = useRef(activeMarkdownDraft);
  useEffect(() => {
    if (
      activeFileType !== "markdown" ||
      !activeTabId ||
      previewFullscreen ||
      activeMarkdownIsSlides ||
      previewContentStale ||
      pendingPreviewRestoreRef.current ||
      lastSyncedMarkdownRef.current === previewMarkdownDraft
    ) {
      return;
    }

    lastSyncedMarkdownRef.current = previewMarkdownDraft;
    const animationFrame = window.requestAnimationFrame(
      syncMarkdownPreviewToActiveEditorPosition,
    );

    return () => window.cancelAnimationFrame(animationFrame);
  }, [
    activeFileType,
    activeTabId,
    activeMarkdownIsSlides,
    previewMarkdownDraft,
    renderedPreview,
    previewContentStale,
    previewFullscreen,
    markdownZoom,
    syncMarkdownPreviewToActiveEditorPosition,
  ]);

  useLayoutEffect(() => {
    if (activeFileType !== "markdown" || !activeTabId) {
      return;
    }

    sourceRestoredRef.current = false;
    const viewState = markdownRestoreViewStateRef.current;
    pendingPreviewRestoreRef.current = viewState ?? {};
    const animationFrame = window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;

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

      sourceRestoredRef.current = true;
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [
    activeFileType,
    activeTabId,
    markProgrammaticEditorScroll,
    markProgrammaticPreviewScroll,
    markdownSlidesPresenting,
    markdownEditorMode,
    previewFullscreen,
    textareaRef,
  ]);

  // The worker must mount matching content before a scroll offset can fit.
  useLayoutEffect(() => {
    const restore = pendingPreviewRestoreRef.current;
    const preview = markdownPreviewRef.current;
    if (!restore || !preview || (!previewFullscreen && !activeMarkdownIsSlides && previewContentStale)) return;
    markProgrammaticPreviewScroll();
    preview.scrollLeft = restore.previewScrollLeft ?? 0;
    preview.scrollTop = restore.previewScrollTop ?? 0;
    pendingPreviewRestoreRef.current = null;
  }, [renderedPreview, previewContentStale, previewFullscreen, activeMarkdownIsSlides, markdownEditorMode, markProgrammaticPreviewScroll]);

  useEffect(() => {
    if (!previewFullscreen || !focused) {
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
  }, [focused, previewFullscreen, setActivePreviewTabId, textareaRef]);

  useLayoutEffect(() => {
    if (activeFileType !== "markdown" || !activeTabId) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (!focused || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") {
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
  }, [activeFileType, activeTabId, activeTabStatus, focused, onSave]);

  function saveMarkdownSplitPercent(value: number, persist = true) {
    const clampedValue = clampMarkdownSplitPercent(value);

    latestMarkdownSplit.current = clampedValue;
    setMarkdownSplitPercent(clampedValue);
    if (persist) {
      try {
        if (window.localStorage.getItem(MARKDOWN_SPLIT_STORAGE_KEY) !== String(clampedValue)) {
          window.localStorage.setItem(MARKDOWN_SPLIT_STORAGE_KEY, String(clampedValue));
        }
      } catch { /* Storage may be unavailable. */ }
    }
  }

  function handleMarkdownZoomChange(value: number) {
    updateDisplayPreferences({ textScale: value });
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
    previewContentStaleRef.current = value !== (markdownEditorMode === "source" && !activeMarkdownIsSlides ? renderedPreview?.content : previewMarkdownDraft);
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
    saveMarkdownSplitPercent((offset / size) * 100, false);
  }

  function handleMarkdownSplitPointerDown(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    event.preventDefault();
    stopMarkdownSplitDragRef.current?.();
    event.currentTarget.setPointerCapture(event.pointerId);
    setMarkdownSplitDragging(true);
    updateMarkdownSplitFromPointer(event.clientX, event.clientY);

    function handlePointerMove(pointerEvent: PointerEvent) {
      updateMarkdownSplitFromPointer(pointerEvent.clientX, pointerEvent.clientY);
    }

    function stopDragging() {
      stopMarkdownSplitDragRef.current = null;
      setMarkdownSplitDragging(false);
      saveMarkdownSplitPercent(latestMarkdownSplit.current);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    }

    stopMarkdownSplitDragRef.current = stopDragging;
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

    onSetDraft(normalizeChatGptCopiedMarkdown(draft, markdownPreferences), { base: draft });

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

    onSetDraft(nextDraft, { base: draft });

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

  const SourceEditor = markdownPreferences.sourceEditor === "codemirror" ? MarkdownSourceEditor : MarkdownEditor;
  const isTextTab = activeTab?.file.fileType === "markdown" || activeTab?.file.fileType === "latex" || activeTab?.file.fileType === "text";

  if (!activeTab) {
    if (selectedNotebook) {
      return (
        <NotebookHome
          yourName={yourName}
          notebook={selectedNotebook}
          isFolder={isFolder}
          fileTags={fileTags}
          onEditFileTags={onEditFileTags}
          onCreateMarkdown={onCreateMarkdown}
          onCreateSlides={onCreateSlides}
          onCreateLatex={onCreateLatex}
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
    <div className="libera-document-workspace flex h-full min-h-0 flex-col overflow-hidden">
      {activeTab.error ? (
        <div className="border-b border-destructive/40 bg-destructive-muted px-4 py-2 text-sm text-destructive">
          {activeTab.error}
        </div>
      ) : null}
      {sharedTab.state.kind === "error" && isTextTab ? (
        <div className="border-b border-destructive/40 bg-destructive-muted px-4 py-2 text-sm text-destructive">
          This file is in a shared notebook, but its live copy could not be opened: {sharedTab.state.message}
        </div>
      ) : null}
      {sharedSession && sharedAttached && isTextTab ? (
        <SharedTabChrome
          tabId={activeTab.id}
          fileName={activeTab.file.name}
          session={sharedSession}
          snapshot={sharedTab.snapshot}
        />
      ) : null}

      {sharedPending && isTextTab ? (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-card text-sm text-muted-foreground" role="status">
          Opening shared document…
        </div>
      ) : activeTab.file.fileType === "latex" ? (
        <LatexWorkspace
          key={editorKey}
          tab={activeTab}
          collab={sharedCodeMirror ?? undefined}
          files={files}
          fontFamily={markdownEditorFontFamily}
          fontSizePx={markdownFontSizePx}
          lineHeight={markdownPreferences.baseLineHeight}
          readOpenTabs={readOpenTabs}
          onSetDraft={onSetDraft}
          onRegisterDraft={sharedCodeMirror ? undefined : registerMarkdownDraft}
          onSave={onSave}
          onSetViewState={updateLatexViewState}
          onOpenFile={onOpenFile}
        />
      ) : activeTab.file.fileType === "text" ? (
        <CodeEditor
          key={editorKey}
          collab={sharedCodeMirror ?? undefined}
          fileName={activeTab.file.name}
          value={activeTab.draft}
          fontFamily={markdownEditorFontFamily}
          fontSizePx={markdownFontSizePx}
          lineHeight={markdownPreferences.baseLineHeight}
          initialViewState={activeTab.viewState?.text}
          saving={activeTab.status === "saving"}
          onChange={sharedCodeMirror ? ignoreSharedDraft : onSetDraft}
          onRegisterDraft={sharedCodeMirror ? undefined : registerMarkdownDraft}
          onViewStateChange={updateTextViewState}
          onSave={() => void onSave()}
        />
      ) : activeTab.file.fileType === "markdown" ? (
        <ReferenceRenderProvider
          notebook={activeTab.untitled
            ? referenceNotebookForPath(activeTab.saveDirectory) ?? selectedNotebook?.name ?? null
            : referenceNotebookForPath(activeTab.file.path)}
          onOpenAttachment={openReferenceAttachment}
        >
          {markdownEditorMode === "visual" && !activeMarkdownIsSlides ? (
            <TiptapMarkdownEditor
              collab={sharedVisual ?? undefined}
              files={files}
              mathMarkers={markdownPreferences}
              smartPaste={markdownPreferences.smartPaste}
                untitled={activeTab.untitled} key={editorKey} documentPath={activeTab.file.path}
              value={activeTab.draft} fontSizePx={markdownFontSizePx}
              fontFamily={wysiwygEditorFontFamily}
              lineHeight={markdownPreferences.baseLineHeight}
              markdownZoom={markdownZoom} onMarkdownZoomChange={handleMarkdownZoomChange}
              initialViewState={activeMarkdownViewState}
              onViewStateChange={updateMarkdownViewState}
              onChange={sharedVisual ? ignoreSharedDraft : handleMarkdownDraftChange} onSave={onSave}
              onRegisterDraft={sharedVisual ? undefined : registerMarkdownDraft}
              onOpenFileLink={handleOpenMarkdownFileLink}
              canStartScreenshotSnip={canStartScreenshotSnip}
              onStartScreenshotSnip={(mode) => onStartScreenshotSnip(mode, "visual")}
              pendingInsertion={pendingVisualInsertion}
              onPendingInsertionHandled={(id) => onFinishVisualInsertion(activeTab.id, id)} />
          ) : <>
          <MarkdownToolbar
            key={`${activeTab.id}-toolbar`}
            files={files}
            documentPath={activeTab.file.path}
            untitled={activeTab.untitled}
            canStartScreenshotSnip={canStartScreenshotSnip}
            isSlideDeck={activeMarkdownIsSlides}
            markdownBaseFontSize={markdownPreferences.baseFontSize}
            markdownContent={activeTab.draft}
            markdownZoom={markdownZoom}
            onEnumerateHeadings={enumerateActiveMarkdownHeadings}
            onFixChatGptEquations={fixActiveChatGptEquations}
            onInsert={onInsertMarkdown}
            onInsertExistingImage={() => setExistingImageDialogOpen(true)}
            onInsertFromGallery={() => setGalleryPickerOpen(true)}
            onInsertImage={onInsertImage}
            onMarkdownZoomChange={handleMarkdownZoomChange}
            onStartScreenshotSnip={(mode) => onStartScreenshotSnip(mode, "source")}
            onOpenFileLink={handleOpenMarkdownFileLink}
            onTogglePreviewFullscreen={() =>
              setActivePreviewTabId((current) =>
                current === activeTab.id ? null : activeTab.id,
              )
            }
            previewFullscreen={previewFullscreen || markdownSlidesPresenting}
          />
          {previewFullscreen ? (
            <div
              key={`${activeTab.id}-fullscreen-preview`}
              className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card"
            >
              <MarkdownTextWidth canvasRef={markdownPreviewRef} />
              <article
                ref={markdownPreviewRef}
                className="markdown-preview-pane libera-text-width-page min-h-0 flex-1 overflow-auto bg-card p-6"
                onPointerDown={handleMarkdownPreviewPointerDown}
                onScroll={handleMarkdownPreviewScroll}
                onTouchStart={markPreviewUserScrollIntent}
                onWheel={markPreviewUserScrollIntent}
              >
                <div className="libera-text-width-content">
                  <MarkdownPreviewMetadata file={activeTab.file} />
                  <MarkdownRenderer
                    mathMarkers={markdownPreferences}
                    content={activeTab.draft}
                    baseFontSize={markdownPreferences.baseFontSize}
                    baseLineHeight={markdownPreferences.baseLineHeight}
                    documentPath={activeTab.file.path}
                    fontFamily={renderedMarkdownFontFamily}
                    onOpenFileLink={handleOpenMarkdownFileLink}
                    textScale={markdownZoomScale}
                  />
                </div>
              </article>
            </div>
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
              {/* Preferences → Source editor: the textarea (default) or CodeMirror (beta, D8).
                  Shared tabs always use CodeMirror: the textarea cannot carry a binding. */}
              {sharedCodeMirror ? (
                <SharedMarkdownSourceEditor
                  key={editorKey}
                  collab={sharedCodeMirror}
                  activeFilePath={activeTab.file.path}
                  files={files}
                  formatting={aiFormatting}
                  imageConverting={imageMarkdownConverting}
                  readOpenTabs={readOpenTabs}
                  recentFiles={recentFiles}
                  fontFamily={markdownEditorFontFamily}
                  fontSizePx={markdownFontSizePx}
                  lineHeightPx={markdownLineHeightPx}
                  mathMarkers={markdownPreferences}
                  smartPaste={markdownPreferences.smartPaste}
                  textareaRef={textareaRef}
                  onAiFormatSelection={onAiFormatSelection}
                  onAiImageToMarkdown={onAiImageToMarkdown}
                  onAiRewriteSelection={onAiRewriteSelection}
                  onAiWriteAt={onAiWriteAt}
                  onInsertFileLink={onInsertFileLink}
                  onInsertImageFile={onInsertImage}
                  onSelectionChange={handleMarkdownSelectionChange}
                />
              ) : (
              <SourceEditor
                key={activeTab.id}
                activeFilePath={activeTab.file.path}
                files={files}
                formatting={aiFormatting}
                imageConverting={imageMarkdownConverting}
                readOpenTabs={readOpenTabs}
                recentFiles={recentFiles}
                fontFamily={markdownEditorFontFamily}
                fontSizePx={markdownFontSizePx}
                lineHeightPx={markdownLineHeightPx}
                mathMarkers={markdownPreferences}
                smartPaste={markdownPreferences.smartPaste}
                textareaRef={textareaRef}
                value={activeTab.draft}
                onAiFormatSelection={onAiFormatSelection}
                onAiImageToMarkdown={onAiImageToMarkdown}
                onAiRewriteSelection={onAiRewriteSelection}
                onAiWriteAt={onAiWriteAt}
                onChange={handleMarkdownDraftChange}
                onRegisterDraft={registerMarkdownDraft}
                onInsertFileLink={onInsertFileLink}
                onInsertImageFile={onInsertImage}
                onSelectionChange={handleMarkdownSelectionChange}
              />
              )}
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
              <div
                key={`${activeTab.id}-preview`}
                className={`flex min-h-0 min-w-0 flex-col overflow-hidden ${
                  activeMarkdownIsSlides ? "bg-zinc-100" : "bg-card"
                }`}
              >
                {!activeMarkdownIsSlides && <MarkdownTextWidth canvasRef={markdownPreviewRef} />}
                <article
                  ref={markdownPreviewRef}
                  className={`min-h-0 min-w-0 flex-1 overflow-auto ${
                    activeMarkdownIsSlides
                      ? "bg-zinc-100"
                      : "markdown-preview-pane libera-text-width-page bg-card p-6"
                  }`}
                  onDoubleClick={
                    activeMarkdownIsSlides
                      ? undefined
                      : handleMarkdownPreviewDoubleClick
                  }
                  onPointerDown={handleMarkdownPreviewPointerDown}
                  onScroll={
                    activeMarkdownIsSlides ? handleMarkdownPreviewScroll : undefined
                  }
                  onTouchStart={markPreviewUserScrollIntent}
                  onWheel={markPreviewUserScrollIntent}
                >
                  {activeMarkdownIsSlides && activeMarkdownSlidesDeck ? (
                    <MarkdownSlidesPreview
                      activeSlideIndex={markdownSlideIndex}
                      baseLineHeight={markdownPreferences.baseLineHeight}
                      deck={activeMarkdownSlidesDeck}
                      documentPath={activeTab.file.path}
                      onOpenFileLink={(href) =>
                        onOpenMarkdownFileLink(activeTab.file.path, href)
                      }
                      textScale={markdownZoomScale}
                    />
                  ) : (
                    <div className="libera-text-width-content">
                      {!activeMarkdownIsSlides && <MarkdownPreviewMetadata file={activeTab.file} />}
                      <MarkdownWorkerPreview
                        key={activeTab.id}
                        onContentReady={handlePreviewContentReady}
                        mathMarkers={markdownPreferences}
                        content={previewMarkdownDraft}
                        baseFontSize={markdownPreferences.baseFontSize}
                        baseLineHeight={markdownPreferences.baseLineHeight}
                        documentPath={activeTab.file.path}
                        fontFamily={renderedMarkdownFontFamily}
                        onOpenFileLink={handleOpenMarkdownFileLink}
                        textScale={markdownZoomScale}
                      />
                    </div>
                  )}
                </article>
              </div>
            </div>
          )}
          <MarkdownStatusBar key={activeTab.id} content={activeTab.draft} />
          {markdownSlidesPresenting && activeMarkdownSlidesDeck ? (
            <MarkdownSlidesPresenter
              baseLineHeight={markdownPreferences.baseLineHeight}
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
              textScale={markdownZoomScale}
            />
          ) : null}
          <GalleryPhotoPicker
            open={galleryPickerOpen}
            onClose={() => setGalleryPickerOpen(false)}
            onInsert={async (photos) => {
              const photoFiles = await Promise.all(photos.map(galleryPhotoFile));
              setGalleryPickerOpen(false);
              // One at a time: each lands after the previous one, in the order picked.
              for (const file of photoFiles) await onInsertImage(file);
            }}
          />
          <ExistingImageDialog
            notebook={selectedNotebook}
            isFolder={isFolder}
            open={existingImageDialogOpen}
            onClose={() => setExistingImageDialogOpen(false)}
            onSelect={async (file) => {
              await onInsertExistingImage(file);
              setExistingImageDialogOpen(false);
            }}
          />
          </>}
        </ReferenceRenderProvider>
      ) : activeTab.file.fileType === "image" ? (
        <NoteMathMarkersProvider value={markdownPreferences}>
          <ImageViewer
            key={activeTab.id}
            src={activeTab.rawUrl}
            alt={activeTab.file.name}
            // Gallery photos are not notebook files: annotations have nowhere to
            // live, and screenshots take their name from the photo.
            annotatable={!isGalleryTab(activeTab)}
            filePath={isGalleryTab(activeTab) ? activeTab.file.name : activeTab.file.path}
            details={{
              createdAt: activeTab.file.createdAt,
              location: isGalleryTab(activeTab) ? "Gallery" : activeTab.file.path,
              size: activeTab.file.size,
              updatedAt: activeTab.file.updatedAt,
            }}
            siblings={imageSiblings}
            onShowSibling={(path) => {
              const file = imageFileByPath.get(path);
              if (file) onShowImage?.(file);
            }}
            onSaveEditedCopy={isGalleryTab(activeTab) ? undefined : async (edits) => { await onSaveEditedImageCopy?.(activeTab.file.path, edits); }}
            initialViewState={activeImageViewState}
            screenshotSnipping={screenshotSnipSession?.sourceTabId === activeTab.id && !screenshotSnipSession.converting}
            onViewStateChange={updateImageViewState}
            onCancelScreenshotSnip={onCancelScreenshotSnip}
            onCompleteScreenshotSnip={(file) => onCompleteScreenshotSnip(file, markdownPreferences)}
          />
        </NoteMathMarkersProvider>
      ) : activeTab.file.fileType === "pdf" ? (
        <NoteMathMarkersProvider value={markdownPreferences}>
          <PdfViewer
            key={activeTab.id}
            src={activeTab.rawUrl}
            filePath={activeTab.file.path}
            initialViewState={activePdfViewState}
            screenshotSnipping={screenshotSnipSession?.sourceTabId === activeTab.id && !screenshotSnipSession.converting}
            screenshotSnipMode={screenshotSnipSession?.mode}
            mathMarkers={markdownPreferences}
            markdownConversion={isGalleryTab(activeTab) ? undefined : {
              createFile: onCreateMarkdownBesidePdf,
              writeFile: onWriteConvertedMarkdown,
              openFile: (file) => void onOpenFile(file),
            }}
            onViewStateChange={updatePdfViewState}
            onCancelScreenshotSnip={onCancelScreenshotSnip}
            onCompleteScreenshotSnip={(file) => onCompleteScreenshotSnip(file, markdownPreferences)}
          />
        </NoteMathMarkersProvider>
      ) : activeTab.file.fileType === "audio" ? (
        <VoiceMemoViewer
          key={activeTab.id}
          file={activeTab.file}
          src={activeTab.rawUrl}
          siblings={audioSiblings}
          // Steps the tab to the other recording in place, as images do.
          onShowSibling={(file) => onShowImage?.(file)}
          initialViewState={activeTab.viewState?.audio}
          onViewStateChange={updateAudioViewState}
          notes={{
            openUnsaved: (fileName, content) => onCreateUntitledMarkdown?.(fileName, content, activeTab.file.path.slice(0, activeTab.file.path.lastIndexOf("/"))),
            saveBeside: async (content) => {
              const file = await onCreateMarkdownBesidePdf(activeTab.file.path);
              await onWriteConvertedMarkdown(file.path, content);
              await onOpenFile({ ...file, size: content.length });
            },
          }}
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
