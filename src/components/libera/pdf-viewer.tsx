"use client";

import { useCanvasViewStateCapture } from "./canvas-view-state";
import { useCanvasPaneFocused } from "@/components/libera/canvas-pane-context";
import {
  ChevronDown,
  ChevronUp,
  ChevronsDown,
  ChevronsUp,
  Circle,
  Copy,
  Eraser,
  Highlighter,
  Loader2,
  type LucideIcon,
  MessageSquare,
  MessageSquarePlus,
  Minus,
  MousePointer2,
  MoveUpRight,
  PenLine,
  Quote,
  Redo2,
  RotateCcw,
  Search,
  Square,
  Strikethrough,
  Trash2,
  Type,
  Underline,
  Undo2,
  UnfoldVertical,
  Volume2,
  Waves,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  type UIEvent as ReactUIEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { GlobalWorkerOptions, TextLayer, getDocument } from "pdfjs-dist";
import type {
  PDFDocumentProxy,
  PDFDocumentLoadingTask,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist/types/src/display/api";
import type { PageViewport } from "pdfjs-dist/types/src/display/display_utils";
import { PdfTextContentCache, pdfCanvasSize } from "@/components/libera/pdf-rendering";
import { PDF_TEXT_ITEM_ATTRIBUTE, PdfLayoutStore, pdfRangePages, pdfSelectionMarkdown } from "@/components/libera/pdf-copy";
import { writeMarkdownClipboard } from "@/lib/markdown-clipboard";
import { usePdfDetailCanvas } from "@/components/libera/use-pdf-detail-canvas";
import { PdfSpaceLayer } from "@/components/libera/pdf-space-layer";
import { assignTextPieces, pieceShiftStyle, usePdfSpaceRaster } from "@/components/libera/pdf-space-raster";
import {
  IDENTITY_PAGE_GEOMETRY,
  annotationToSurface,
  areaFromSurface,
  patchFromSurface,
  pdfPageGeometry,
  rigidPointsFromSurface,
  rigidRectFromSurface,
  textRectToSurface,
  textRectsFromSurface,
  type PdfPageGeometry,
} from "@/lib/pdf-space-geometry";
import { placeSpaceCut } from "@/lib/pdf-space-layout";
import { PDF_SPACE_MIN_HEIGHT, availableSpaceHeight, columnBounds, isFullWidthBand, sameBand } from "@/lib/pdf-space";
import { usePdfFind } from "@/components/libera/use-pdf-find";
import { buildPdfSearchPage, highlightPdfMatches, type PdfSearchMatch, type PdfSearchPage } from "@/components/libera/pdf-find";
import { apiRequest } from "@/components/libera/api-client";
import { usePaletteCommands } from "@/components/libera/command-palette/commands";
import { useMarkdownReview } from "@/components/libera/markdown-review-context";
import { changePdfComments, onPdfCommentFocus, pdfCommentsState, selectPdfComment, usePdfComments } from "@/components/libera/pdf-comments-store";
import { sortPdfCommentThreads } from "@/lib/pdf-comments";
import { dispatchPdfAnnotationsUpdated, forgetPdfAnnotations } from "@/components/libera/pdf-annotation-events";
import { annotationAnchorRect, rememberFileAnnotations, scrollTopCenteringRect } from "@/lib/annotation-links";
import { useAnnotationWriter } from "./use-annotation-writer";
import { useAnnotationSync } from "@/components/libera/annotation-sync";
import {
  canvasToPngBlob,
  pngFileFromBlob,
} from "@/components/libera/screenshot-capture";
import { ScreenshotSnipLayer } from "@/components/libera/screenshot-snip-layer";
import { PdfMarkdownButton } from "@/components/libera/document-ocr/pdf-markdown-button";
import type { PdfMarkdownConversion } from "@/components/libera/document-ocr/pdf-markdown-jobs";
import type { MathMarkerSettings } from "@/lib/math-markers";
import {
  ANNOTATION_UI_SELECTOR,
  DEFAULT_TEXT_ANNOTATION_FONT_SIZE,
  MAX_TEXT_ANNOTATION_FONT_SIZE,
  MIN_TEXT_ANNOTATION_FONT_SIZE,
  TextAnnotationLayer,
  clamp,
  createAnnotationId,
  keepEditorFocus,
  normalizeRect,
  nowIso,
  rectStyle,
  type AnnotationSurfaceSize,
} from "@/components/libera/text-annotation-layer";
import {
  IconChoiceGroup,
  StrokeWidthPicker,
  SwatchPicker,
  TextAnnotationStyleControls,
  type IconChoice,
} from "@/components/libera/annotation-style-controls";
import {
  PdfDrawingLayer,
  type NewDrawingStyle,
  type PdfDrawingDraft,
  type PdfDrawingMode,
} from "@/components/libera/pdf-drawing-layer";
import {
  DEFAULT_PDF_HIGHLIGHT_COLOR,
  DEFAULT_PDF_INK_COLOR,
  DEFAULT_PDF_STROKE_WIDTH,
  DEFAULT_PDF_TEXT_COLOR,
  DEFAULT_PDF_TEXT_FONT,
  PDF_HIGHLIGHT_COLORS,
  PDF_INK_COLORS,
  PDF_STROKE_WIDTHS,
  PDF_TEXT_COLORS,
  PDF_TEXT_FONTS,
  isHexColor,
  markupPalette,
  mergeHighlightRects,
  rangeTextClientRects,
} from "@/lib/pdf-annotation-style";
import { drawingBounds, isDrawingAnnotation, type PdfDrawingAnnotation } from "@/lib/pdf-drawing";
import { normalizePdfHighlightQuote, pdfHighlightQuote } from "@/lib/pdf-highlight-quote";
import { speakMarkdown } from "@/lib/tts/player";
import { rememberPdfPageLabels } from "@/components/libera/references/pdf-page-labels";
import { PDF_CITATION_MIME, PDF_QUOTE_CITE_EVENT, type PdfQuoteCiteDetail, type PdfQuoteSource } from "@/lib/references/pdf-quote";
import type {
  PdfAnnotation,
  PdfAnnotationRect,
  PdfHighlightAnnotation,
  PdfAnnotationsPayload,
  PdfCommentAnchor,
  PdfCommentSegment,
  PdfMarkupStyle,
  PdfShapeKind,
  PdfSpaceAnnotation,
  PdfTextAnnotation,
  PdfTextAnnotationFont,
} from "@/lib/types";
import type { PdfTabViewState } from "@/components/libera/types";

GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url,
).toString();

// 2.5 × 72 DPI = 180 DPI for snips read into Markdown.
const MARKDOWN_SNIP_RENDER_SCALE = 2.5;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;
const PDF_PAGE_RENDER_ROOT_MARGIN = "1200px 0px";
const PDF_PAGE_RENDER_FALLBACK_COUNT = 2;
const PDF_PAGE_RENDER_CONCURRENCY = 2;
const PDF_SCROLL_STATE_INTERVAL_MS = 150;
const EMPTY_ANNOTATIONS: PdfAnnotation[] = [];
const EMPTY_SEARCH_MATCHES: PdfSearchMatch[] = [];
const EMPTY_PAGE_GEOMETRIES = new Map<number, PdfPageGeometry>();
// A space opened with a click: about three lines of body text, in PDF points.
const DEFAULT_SPACE_HEIGHT_PT = 40;
// Room kept around the note placed in a new space, in page fractions: across
// the page, inside the text margins; in a column, just inside the column.
const SPACE_NOTE_INSET = { page: 0.1, column: 0.015, y: 0.006 };
const EMPTY_HISTORY: { undo: HistoryEntry[]; redo: HistoryEntry[] } = { undo: [], redo: [] };

type PdfTool = NonNullable<PdfTabViewState["tool"]>;
type PdfScrollPosition = {
  scrollLeft: number;
  scrollTop: number;
};
type PdfPageLayout = {
  height: number;
  pageNumber: number;
  width: number;
};
type PdfAnnotationScrollState = {
  allowInitialScroll: boolean;
  lastSelectedAnnotationId: string;
};
type RequestRenderSlot = () => Promise<() => void>;
type SelectionMenuPosition = { left: number; top: number };
/** A review comment's passage on one page; `number` matches its card in the Comments panel. */
type PdfCommentMark = { id: string; number: number; rects: PdfAnnotationRect[]; selected: boolean; badge: boolean };
type PdfCommentDraft = SelectionMenuPosition & { anchor: PdfCommentAnchor };
const DRAFT_COMMENT_ID = "draft";
const COMMENT_BOX_WIDTH = 320;
const EMPTY_COMMENT_MARKS: PdfCommentMark[] = [];
type AnnotationUpdater = (annotations: PdfAnnotation[]) => PdfAnnotation[];
/**
 * Consecutive commits with the same key (one note being typed, one eraser
 * drag) collapse into a single undo step.
 */
type HistoryEntry = { annotations: PdfAnnotation[]; key?: string; time: number };

const MAX_UNDO_STEPS = 100;
const HISTORY_COALESCE_MS = 1500;

const MARKUP_CHOICES: readonly (IconChoice<PdfMarkupStyle> & { tool: string })[] = [
  { value: "highlight", label: "Highlight", icon: Highlighter, tool: "Highlight" },
  { value: "underline", label: "Underline", icon: Underline, tool: "Underline" },
  { value: "strikethrough", label: "Strikethrough", icon: Strikethrough, tool: "Strike" },
  { value: "squiggly", label: "Squiggly underline", icon: Waves, tool: "Squiggly" },
];

const SHAPE_CHOICES: readonly IconChoice<PdfShapeKind>[] = [
  { value: "rectangle", label: "Rectangle", icon: Square },
  { value: "ellipse", label: "Ellipse", icon: Circle },
  { value: "line", label: "Line", icon: Minus },
  { value: "arrow", label: "Arrow", icon: MoveUpRight },
];

const MARKUP_STYLES = MARKUP_CHOICES.map((choice) => choice.value);
const SHAPE_KINDS = SHAPE_CHOICES.map((choice) => choice.value);

function markupStyleOf(annotation: PdfHighlightAnnotation): PdfMarkupStyle {
  return annotation.markup ?? "highlight";
}

/** Keeps a markup's color when it suits the new style, else the style's own ink. */
function convertMarkup(
  annotation: PdfHighlightAnnotation,
  style: PdfMarkupStyle,
  fallbackColor: string,
): Partial<PdfHighlightAnnotation> {
  const palette = markupPalette(style);
  const fits = palette.some((color) => color.value.toLowerCase() === annotation.color.toLowerCase());

  return {
    markup: style === "highlight" ? undefined : style,
    color: fits ? annotation.color : fallbackColor,
  };
}

/** Single-key tool shortcuts, active while the PDF (not a field) has focus. */
const TOOL_SHORTCUTS: Record<string, PdfTool> = {
  v: "select",
  h: "highlight",
  t: "text",
  p: "draw",
  s: "shape",
  e: "eraser",
  g: "space",
};

const TOOL_SHORTCUT_KEYS = Object.fromEntries(
  Object.entries(TOOL_SHORTCUTS).map(([key, tool]) => [tool, key.toUpperCase()]),
) as Record<PdfTool, string>;

function PdfToolButton({
  active,
  className,
  icon: Icon,
  label,
  markup,
  title,
  tool,
  onSelect,
}: {
  active: boolean;
  className?: string;
  icon: LucideIcon;
  label: string;
  markup?: PdfMarkupStyle;
  title: string;
  tool: PdfTool;
  onSelect: (tool: PdfTool) => void;
}) {
  return (
    <button
      className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-sm font-medium ${
        className ?? (active ? "border-foreground bg-primary text-primary-foreground" : "border-input hover:bg-muted")
      }`}
      type="button"
      aria-label={label}
      aria-pressed={active}
      data-markup={markup}
      data-viewer-tool={tool}
      title={`${title} (${TOOL_SHORTCUT_KEYS[tool]})`}
      onClick={() => onSelect(tool)}
    >
      <Icon aria-hidden className="h-4 w-4" />
      <span className="pdf-tool-label">{label}</span>
    </button>
  );
}

function strokeWidthOrDefault(value: unknown) {
  return PDF_STROKE_WIDTHS.some((width) => width.value === value) ? (value as number) : DEFAULT_PDF_STROKE_WIDTH;
}

type PdfViewerProps = {
  filePath: string;
  initialViewState?: PdfTabViewState;
  screenshotSnipping?: boolean;
  src?: string;
  onCancelScreenshotSnip?: () => void;
  onCompleteScreenshotSnip?: (file: File) => Promise<void>;
  onViewStateChange?: (viewState: PdfTabViewState) => void;
  /** "markdown" snips are rendered sharper, since the local model reads them. */
  screenshotSnipMode?: "image" | "markdown";
  mathMarkers?: MathMarkerSettings;
  /** Enables Convert PDF to Markdown: how to create, save and open the result. */
  markdownConversion?: PdfMarkdownConversion;
};

function intersectClientRect(rect: DOMRect, bounds: DOMRect) {
  const left = Math.max(rect.left, bounds.left);
  const top = Math.max(rect.top, bounds.top);
  const right = Math.min(rect.right, bounds.right);
  const bottom = Math.min(rect.bottom, bounds.bottom);

  if (right - left < 2 || bottom - top < 2) {
    return null;
  }

  return {
    x: (left - bounds.left) / bounds.width,
    y: (top - bounds.top) / bounds.height,
    width: (right - left) / bounds.width,
    height: (bottom - top) / bounds.height,
  };
}

/** A text selection inside the viewer, as line boxes and quote on each page it spans; null without one. */
function selectionPageRects(
  selection: Selection | null,
  viewer: HTMLElement | null,
  geometryOf: (pageNumber: number) => PdfPageGeometry = () => IDENTITY_PAGE_GEOMETRY,
) {
  if (!selection || selection.isCollapsed || !selection.rangeCount || !viewer) {
    return null;
  }

  const range = selection.getRangeAt(0);

  if (!viewer.contains(range.commonAncestorContainer)) {
    return null;
  }

  const clientRects = rangeTextClientRects(range, ".pdf-text-layer");
  const pages: (PdfCommentSegment & { quote?: string })[] = [];

  for (const page of viewer.querySelectorAll<HTMLElement>("[data-pdf-page-content]")) {
    const bounds = page.getBoundingClientRect();
    const rects = clientRects
      .map((rect) => intersectClientRect(rect, bounds))
      .filter((rect): rect is PdfAnnotationRect => Boolean(rect));

    if (rects.length) {
      const textLayer = page.querySelector(".pdf-text-layer");
      const pageNumber = Number(page.dataset.pdfPageContent);
      pages.push({
        pageNumber,
        // Measured on the page as displayed; stored on the original page.
        rects: textRectsFromSurface(geometryOf(pageNumber), mergeHighlightRects(rects, bounds.width, bounds.height)).map(normalizeRect),
        quote: textLayer ? pdfHighlightQuote(range, textLayer) : undefined,
      });
    }
  }

  return pages.length ? pages : null;
}

/** Where the selection menu (and the comment box) opens: above the selection, or below it near the top. */
function selectionMenuPosition(range: Range, scrollContainer: HTMLElement): SelectionMenuPosition | null {
  const rects = rangeTextClientRects(range, ".pdf-text-layer");

  if (!rects.length) {
    return null;
  }

  const bounds = scrollContainer.getBoundingClientRect();
  const first = rects.reduce((top, rect) => (rect.top < top.top ? rect : top));
  const last = rects.reduce((bottom, rect) => (rect.bottom > bottom.bottom ? rect : bottom));
  const menuHeight = 40;
  const above = first.top - bounds.top - menuHeight - 6;
  const top = above >= 0 ? above : last.bottom - bounds.top + 6;

  return {
    left: clamp(
      first.left - bounds.left + scrollContainer.scrollLeft,
      8,
      Math.max(8, scrollContainer.scrollWidth - 456),
    ),
    top: top + scrollContainer.scrollTop,
  };
}

/** The comment box opens just below the selection, so the passage stays in view while you write. */
function commentBoxPosition(range: Range, scrollContainer: HTMLElement): SelectionMenuPosition | null {
  const rects = rangeTextClientRects(range, ".pdf-text-layer");

  if (!rects.length) {
    return null;
  }

  const bounds = scrollContainer.getBoundingClientRect();
  const first = rects.reduce((top, rect) => (rect.top < top.top ? rect : top));
  const last = rects.reduce((bottom, rect) => (rect.bottom > bottom.bottom ? rect : bottom));
  return {
    left: first.left - bounds.left + scrollContainer.scrollLeft,
    top: last.bottom - bounds.top + scrollContainer.scrollTop + 8,
  };
}

/** The union of a comment's boxes on one page, to scroll it into view. */
function unionRect([first, ...rest]: PdfAnnotationRect[]): PdfAnnotationRect {
  return rest.reduce((union, rect) => {
    const x = Math.min(union.x, rect.x), y = Math.min(union.y, rect.y);
    return { x, y, width: Math.max(union.x + union.width, rect.x + rect.width) - x, height: Math.max(union.y + union.height, rect.y + rect.height) - y };
  }, first);
}

/**
 * Comment marks grouped by page, reusing a page's previous array while its
 * marks are unchanged, so selecting a comment re-renders only its pages.
 */
function groupCommentMarks(
  threads: ReturnType<typeof usePdfComments>["threads"],
  selectedId: string | null,
  draft: PdfCommentDraft | null,
  previous: Map<number, PdfCommentMark[]>,
) {
  const grouped = new Map<number, PdfCommentMark[]>();
  const add = (pageNumber: number, mark: PdfCommentMark) => {
    const marks = grouped.get(pageNumber);
    if (marks) marks.push(mark); else grouped.set(pageNumber, [mark]);
  };
  sortPdfCommentThreads(threads).forEach((thread, index) => {
    const selected = thread.id === selectedId;
    // Resolved threads leave the page unless their card is open.
    if (thread.status === "resolved" && !selected) return;
    thread.anchor.segments.forEach((segment, segmentIndex) => add(segment.pageNumber, { id: thread.id, number: index + 1, rects: segment.rects, selected, badge: segmentIndex === 0 }));
  });
  draft?.anchor.segments.forEach((segment, segmentIndex) => add(segment.pageNumber, { id: DRAFT_COMMENT_ID, number: 0, rects: segment.rects, selected: true, badge: segmentIndex === 0 }));

  for (const [pageNumber, marks] of grouped) {
    const before = previous.get(pageNumber);
    if (before && JSON.stringify(before) === JSON.stringify(marks)) grouped.set(pageNumber, before);
  }
  return grouped;
}

function useCommentMarksByPage(
  threads: ReturnType<typeof usePdfComments>["threads"],
  selectedId: string | null,
  draft: PdfCommentDraft | null,
) {
  const [cache, setCache] = useState(() => ({ groups: groupCommentMarks(threads, selectedId, draft, new Map()), threads, selectedId, draft }));

  if (cache.threads === threads && cache.selectedId === selectedId && cache.draft === draft) {
    return cache.groups;
  }

  const groups = groupCommentMarks(threads, selectedId, draft, cache.groups);
  setCache({ groups, threads, selectedId, draft });
  return groups;
}

function renderCanvas(viewport: PageViewport, canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");

  if (!context) {
    return;
  }

  const size = pdfCanvasSize(viewport.width, viewport.height, window.devicePixelRatio);

  canvas.width = size.width;
  canvas.height = size.height;
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  // CSS and text/annotation coordinates stay at the requested zoom. Only the
  // backing bitmap is capped; PDF.js applies this transform when rendering.
  return [size.width / viewport.width, 0, 0, size.height / viewport.height, 0, 0];
}

async function readPdfBasePageLayouts(pdfDocument: PDFDocumentProxy, signal: AbortSignal) {
  const layouts: PdfPageLayout[] = [];

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    signal.throwIfAborted();
    const page = await pdfDocument.getPage(pageNumber);
    signal.throwIfAborted();
    const viewport = page.getViewport({ scale: 1 });

    layouts.push({
      height: viewport.height,
      pageNumber,
      width: viewport.width,
    });
  }

  return layouts;
}

// The document point under the viewport centre, as fractions of a page sheet.
// Offsets keep the unscaled remainder when the centre is in padding or a gap.
type PdfZoomAnchor = {
  pageNumber: number;
  pageX: number;
  pageY: number;
  offsetX: number;
  offsetY: number;
  viewportX: number;
  viewportY: number;
};

function readPdfZoomAnchor(scroller: HTMLElement, pages: Map<number, HTMLElement>): PdfZoomAnchor | null {
  const viewport = scroller.getBoundingClientRect();
  const viewportX = scroller.clientWidth / 2;
  const viewportY = scroller.clientHeight / 2;
  const centerX = viewport.left + viewportX;
  const centerY = viewport.top + viewportY;
  let anchor: { pageNumber: number; bounds: DOMRect } | null = null;

  // Map order is registration order, which a re-mounted page can change.
  const pageNumbers = [...pages.keys()].sort((a, b) => a - b);
  let low = 0;
  let high = pageNumbers.length - 1;
  // Space previews capture this every frame; measure logarithmically even
  // when reading near the end of a long document.
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const bounds = pages.get(pageNumbers[middle])!.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) break;
    if (bounds.bottom < centerY) low = middle + 1;
    else high = middle;
  }
  if (low === high && high >= 0) {
    const pageNumber = pageNumbers[low];
    const bounds = pages.get(pageNumber)!.getBoundingClientRect();
    if (bounds.width > 0 && bounds.height > 0) anchor = { pageNumber, bounds };
  }
  if (!anchor) {
    // A hidden or partially mounted viewer may have zero-sized sheets.
    for (const pageNumber of pageNumbers) {
      const bounds = pages.get(pageNumber)!.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) continue;
      anchor = { pageNumber, bounds };
      if (bounds.bottom >= centerY) break;
    }
  }

  if (!anchor) return null;
  const { bounds, pageNumber } = anchor;
  const pageX = clamp((centerX - bounds.left) / bounds.width, 0, 1);
  const pageY = clamp((centerY - bounds.top) / bounds.height, 0, 1);

  return {
    pageNumber,
    pageX,
    pageY,
    offsetX: centerX - bounds.left - bounds.width * pageX,
    offsetY: centerY - bounds.top - bounds.height * pageY,
    viewportX,
    viewportY,
  };
}

function restorePdfZoomAnchor(scroller: HTMLElement, page: HTMLElement, anchor: PdfZoomAnchor) {
  const viewport = scroller.getBoundingClientRect();
  const bounds = page.getBoundingClientRect();
  const deltaX = bounds.left + bounds.width * anchor.pageX + anchor.offsetX - viewport.left - anchor.viewportX;
  const deltaY = bounds.top + bounds.height * anchor.pageY + anchor.offsetY - viewport.top - anchor.viewportY;

  scroller.scrollLeft = clamp(scroller.scrollLeft + deltaX, 0, Math.max(0, scroller.scrollWidth - scroller.clientWidth));
  scroller.scrollTop = clamp(scroller.scrollTop + deltaY, 0, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
}

function pageNumberFromObservedElement(element: Element) {
  const pageNumber = Number((element as HTMLElement).dataset.pdfPageNumber);

  return Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : null;
}

function hasExplicitScrollPosition(viewState: PdfTabViewState | undefined) {
  return (
    typeof viewState?.scrollLeft === "number" ||
    typeof viewState?.scrollTop === "number"
  );
}

function usePdfRenderQueue(maxConcurrentRenders: number): RequestRenderSlot {
  const activeRenderCountRef = useRef(0);
  const pumpRenderQueueRef = useRef<() => void>(() => undefined);
  const renderQueueRef = useRef<Array<(release: () => void) => void>>([]);

  const pumpRenderQueue = useCallback(() => {
    while (
      activeRenderCountRef.current < maxConcurrentRenders &&
      renderQueueRef.current.length
    ) {
      const resolve = renderQueueRef.current.shift();

      if (!resolve) {
        continue;
      }

      activeRenderCountRef.current += 1;
      let released = false;

      resolve(() => {
        if (released) {
          return;
        }

        released = true;
        activeRenderCountRef.current = Math.max(0, activeRenderCountRef.current - 1);
        pumpRenderQueueRef.current();
      });
    }
  }, [maxConcurrentRenders]);

  useEffect(() => {
    pumpRenderQueueRef.current = pumpRenderQueue;
  }, [pumpRenderQueue]);

  useEffect(
    () => () => {
      const queuedResolvers = renderQueueRef.current.splice(0);

      queuedResolvers.forEach((resolve) => resolve(() => undefined));
    },
    [],
  );

  return useCallback(
    () =>
      new Promise<() => void>((resolve) => {
        renderQueueRef.current.push(resolve);
        pumpRenderQueue();
      }),
    [pumpRenderQueue],
  );
}

export function PdfViewer({
  filePath,
  initialViewState,
  screenshotSnipping = false,
  src,
  onCancelScreenshotSnip,
  onCompleteScreenshotSnip,
  onViewStateChange,
  screenshotSnipMode = "image",
  mathMarkers,
  markdownConversion,
}: PdfViewerProps) {
  const paneFocused = useCanvasPaneFocused();
  const viewerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pendingScrollRestoreRef = useRef<PdfScrollPosition | null>({
    scrollLeft: initialViewState?.scrollLeft ?? 0,
    scrollTop: initialViewState?.scrollTop ?? 0,
  });
  const pendingZoomAnchorRef = useRef<PdfZoomAnchor | null>(null);
  const pageElementRefs = useRef<Map<number, HTMLElement>>(new Map());
  const pendingScrollViewStateRef = useRef<PdfScrollPosition | null>(null);
  const scrollViewStateTimeoutRef = useRef<number | null>(null);
  const onViewStateChangeRef = useRef(onViewStateChange);
  const screenshotCallbacksRef = useRef({ onCancelScreenshotSnip, onCompleteScreenshotSnip });
  const screenshotSnipModeRef = useRef(screenshotSnipMode);
  useLayoutEffect(() => {
    screenshotSnipModeRef.current = screenshotSnipMode;
  }, [screenshotSnipMode]);
  const initialViewStateRef = useRef(initialViewState);
  const annotationScrollStateRef = useRef<PdfAnnotationScrollState>({
    allowInitialScroll:
      Boolean(initialViewState?.selectedAnnotationId) &&
      !hasExplicitScrollPosition(initialViewState),
    lastSelectedAnnotationId: initialViewState?.selectedAnnotationId ?? "",
  });
  const requestRenderSlot = usePdfRenderQueue(PDF_PAGE_RENDER_CONCURRENCY);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const textContentCache = useMemo(
    () => pdfDocument ? new PdfTextContentCache() : null,
    [pdfDocument],
  );
  useEffect(() => () => textContentCache?.clear(), [textContentCache]);
  const layoutStore = useMemo(
    () => pdfDocument && textContentCache ? new PdfLayoutStore(pdfDocument, textContentCache) : null,
    [pdfDocument, textContentCache],
  );
  useEffect(() => () => layoutStore?.clear(), [layoutStore]);
  const pdfFind = usePdfFind(pdfDocument, textContentCache, viewerRef);
  const activeSearchMatch = pdfFind.activeMatch;
  useEffect(() => {
    if (activeSearchMatch) {
      pageElementRefs.current.get(activeSearchMatch.pageNumber)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [activeSearchMatch]);
  const [basePageLayouts, setBasePageLayouts] = useState<PdfPageLayout[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [renderWindowPages, setRenderWindowPages] = useState<Set<number>>(new Set());
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState(
    initialViewState?.selectedAnnotationId ?? "",
  );
  const [tool, setTool] = useState<PdfTool>(initialViewState?.tool ?? "select");
  const [zoom, setZoom] = useState(initialViewState?.zoom ?? 1);
  const [fontSize, setFontSize] = useState(
    initialViewState?.fontSize ?? DEFAULT_TEXT_ANNOTATION_FONT_SIZE,
  );
  const [fontFamily, setFontFamily] = useState<PdfTextAnnotationFont>(
    initialViewState?.fontFamily ?? DEFAULT_PDF_TEXT_FONT,
  );
  const [textColor, setTextColor] = useState(
    isHexColor(initialViewState?.textColor) ? initialViewState.textColor : DEFAULT_PDF_TEXT_COLOR,
  );
  const [highlightColor, setHighlightColor] = useState(
    isHexColor(initialViewState?.highlightColor)
      ? initialViewState.highlightColor
      : DEFAULT_PDF_HIGHLIGHT_COLOR,
  );
  const [markupStyle, setMarkupStyle] = useState<PdfMarkupStyle>(
    MARKUP_STYLES.includes(initialViewState?.markupStyle as PdfMarkupStyle)
      ? initialViewState!.markupStyle!
      : "highlight",
  );
  const [markupColor, setMarkupColor] = useState(
    isHexColor(initialViewState?.markupColor) ? initialViewState.markupColor : DEFAULT_PDF_INK_COLOR,
  );
  const [inkColor, setInkColor] = useState(
    isHexColor(initialViewState?.inkColor) ? initialViewState.inkColor : DEFAULT_PDF_INK_COLOR,
  );
  const [strokeWidth, setStrokeWidth] = useState(strokeWidthOrDefault(initialViewState?.strokeWidth));
  const [shapeKind, setShapeKind] = useState<PdfShapeKind>(
    SHAPE_KINDS.includes(initialViewState?.shapeKind as PdfShapeKind) ? initialViewState!.shapeKind! : "rectangle",
  );
  const [history, setHistory] = useState(EMPTY_HISTORY);
  const historyRef = useRef(history);
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenuPosition | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const latestAnnotationsRef = useRef<PdfAnnotation[]>([]);
  const automaticSpaceNotesRef = useRef(new Set<string>());
  const viewStateSelectedAnnotationId = initialViewState?.selectedAnnotationId;
  const activeSelectedAnnotationId =
    typeof viewStateSelectedAnnotationId === "string"
      ? viewStateSelectedAnnotationId
      : selectedAnnotationId;
  const activeSelectedAnnotationIdRef = useRef(activeSelectedAnnotationId);
  useEffect(() => {
    activeSelectedAnnotationIdRef.current = activeSelectedAnnotationId;
  }, [activeSelectedAnnotationId]);
  const annotationsByPage = useStablePageGroups(annotations);
  // While a space is dragged open, its page shows the draft spaces.
  const [spaceDraft, setSpaceDraft] = useState<{ pageNumber: number; spaces: PdfSpaceAnnotation[] } | null>(null);
  const pageGeometries = useStablePageGeometries(annotationsByPage, spaceDraft);
  const pageGeometriesRef = useRef(pageGeometries);
  useLayoutEffect(() => {
    pageGeometriesRef.current = pageGeometries;
  });
  const geometryOf = useCallback(
    (pageNumber: number) => pageGeometriesRef.current.get(pageNumber) ?? IDENTITY_PAGE_GEOMETRY,
    [],
  );
  const pageLayouts = useStablePageLayouts(useMemo(
    () =>
      basePageLayouts.map((layout) => ({
        ...layout,
        // Spaces make a page taller as displayed; the PDF page is unchanged.
        height: layout.height * zoom * (pageGeometries.get(layout.pageNumber)?.scale ?? 1),
        width: layout.width * zoom,
      })),
    [basePageLayouts, pageGeometries, zoom],
  ));

  const selectedAnnotation = useMemo(
    () => annotations.find((annotation) => annotation.id === activeSelectedAnnotationId),
    [activeSelectedAnnotationId, annotations],
  );
  // Review comments live beside the markup in the same sidecar, but have their
  // own store and route: they are outside undo, and the agent replies to them.
  const review = useMarkdownReview();
  const comments = usePdfComments(filePath);
  const [commentDraft, setCommentDraft] = useState<PdfCommentDraft | null>(null);
  const [commentText, setCommentText] = useState("");
  const commentMarksByPage = useCommentMarksByPage(comments.threads, comments.selectedId, commentDraft);
  const openCommentCount = comments.threads.filter((thread) => thread.status === "open").length;
  const showCommentsRef = useRef(review?.showComments);
  useLayoutEffect(() => {
    showCommentsRef.current = review?.showComments;
  });
  // A mark clicked on the page opens its card in the Comments panel.
  const selectComment = useCallback((id: string) => {
    if (id === DRAFT_COMMENT_ID) return;
    selectPdfComment(filePath, id);
    showCommentsRef.current?.();
  }, [filePath]);

  // A card chosen in the Comments panel brings its passage into view.
  useEffect(() => onPdfCommentFocus(filePath, (threadId) => {
    const segment = pdfCommentsState(filePath).threads.find((thread) => thread.id === threadId)?.anchor.segments[0];
    const page = segment && pageElementRefs.current.get(segment.pageNumber);
    const scrollContainer = scrollContainerRef.current;

    if (!segment || !page || !scrollContainer) {
      return;
    }

    const pageBounds = page.getBoundingClientRect();
    const containerBounds = scrollContainer.getBoundingClientRect();
    scrollContainer.scrollTop = scrollTopCenteringRect(
      pageBounds.top - containerBounds.top + scrollContainer.scrollTop,
      pageBounds.height,
      unionRect(segment.rects.map((rect) => textRectToSurface(geometryOf(segment.pageNumber), rect))),
      scrollContainer.clientHeight,
    );
  }), [filePath, geometryOf]);

  const selectedTextAnnotation =
    selectedAnnotation?.type === "text" ? selectedAnnotation : null;
  const selectedHighlight =
    selectedAnnotation?.type === "highlight" ? selectedAnnotation : null;
  const selectedDrawing =
    selectedAnnotation && isDrawingAnnotation(selectedAnnotation) ? selectedAnnotation : null;

  useEffect(() => {
    onViewStateChangeRef.current = onViewStateChange;
  }, [onViewStateChange]);

  useEffect(() => {
    screenshotCallbacksRef.current = { onCancelScreenshotSnip, onCompleteScreenshotSnip };
  }, [onCancelScreenshotSnip, onCompleteScreenshotSnip]);

  const cancelScreenshotSnip = useCallback(() => {
    screenshotCallbacksRef.current.onCancelScreenshotSnip?.();
  }, []);

  useEffect(() => {
    initialViewStateRef.current = initialViewState;
  }, [initialViewState]);

  const updateViewState = useCallback((patch: PdfTabViewState) => {
    onViewStateChangeRef.current?.(patch);
  }, []);

  useEffect(() => {
    const nextSelectedAnnotationId = initialViewState?.selectedAnnotationId ?? "";
    const annotationScrollState = annotationScrollStateRef.current;
    const selectedAnnotationChanged =
      nextSelectedAnnotationId !== annotationScrollState.lastSelectedAnnotationId;

    if (!nextSelectedAnnotationId) {
      if (selectedAnnotationChanged) {
        annotationScrollState.lastSelectedAnnotationId = "";
        annotationScrollState.allowInitialScroll = false;
      }

      return;
    }

    if (
      !annotationScrollState.allowInitialScroll &&
      !selectedAnnotationChanged
    ) {
      return;
    }

    if (
      loading ||
      !pdfDocument ||
      !pageLayouts.length
    ) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      const scrollContainer = scrollContainerRef.current;

      if (!scrollContainer) {
        return;
      }

      annotationScrollState.lastSelectedAnnotationId = nextSelectedAnnotationId;
      annotationScrollState.allowInitialScroll = false;

      const annotationElement = scrollContainer.querySelector<HTMLElement>(
        `[data-pdf-annotation-id="${CSS.escape(nextSelectedAnnotationId)}"]`,
      );

      if (annotationElement) {
        annotationElement.scrollIntoView({ block: "center", inline: "nearest" });
        return;
      }

      const annotation = latestAnnotationsRef.current.find(
        (currentAnnotation) => currentAnnotation.id === nextSelectedAnnotationId,
      );

      if (!annotation) {
        return;
      }

      scrollContainer
        .querySelector<HTMLElement>(`[data-pdf-page-number="${annotation.pageNumber}"]`)
        ?.scrollIntoView({ block: "start", inline: "nearest" });
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [
    initialViewState?.selectedAnnotationId,
    loading,
    pageLayouts.length,
    pdfDocument,
  ]);

  const updateCurrentPage = useCallback((scrollContainer: HTMLDivElement) => {
    const viewport = scrollContainer.getBoundingClientRect();
    const readingLine = viewport.top + Math.min(viewport.height / 3, 160);
    const pages = pageElementRefs.current;
    if (!pages.size) return;
    let first = 1;
    let last = pages.size;

    while (first < last) {
      const middle = Math.floor((first + last) / 2);
      const page = pages.get(middle);
      if (!page) return;
      if (page.getBoundingClientRect().bottom < readingLine) {
        first = middle + 1;
      } else {
        last = middle;
      }
    }

    const page = pages.get(first);
    if (!page) return;
    const previousPage = pages.get(first - 1);
    const pageTop = page.getBoundingClientRect().top;
    if (previousPage && readingLine < pageTop &&
      readingLine - previousPage.getBoundingClientRect().bottom < pageTop - readingLine) {
      setCurrentPage(first - 1);
    } else {
      setCurrentPage(first);
    }
  }, []);

  const flushPendingScrollViewState = useCallback(() => {
    if (scrollViewStateTimeoutRef.current !== null) {
      window.clearTimeout(scrollViewStateTimeoutRef.current);
      scrollViewStateTimeoutRef.current = null;
    }

    if (!pendingScrollViewStateRef.current) {
      return;
    }

    const scroller = scrollContainerRef.current;
    if (scroller) updateCurrentPage(scroller);
    updateViewState(pendingScrollViewStateRef.current);
    pendingScrollViewStateRef.current = null;
  }, [updateCurrentPage, updateViewState]);

  const handleScroll = useCallback(
    (event: ReactUIEvent<HTMLDivElement>) => {
      // Loading temporarily collapses the scroll area. Do not save that zero
      // over the position we are about to restore.
      if (pendingScrollRestoreRef.current) return;
      pendingScrollViewStateRef.current = {
        scrollLeft: event.currentTarget.scrollLeft,
        scrollTop: event.currentTarget.scrollTop,
      };

      if (scrollViewStateTimeoutRef.current !== null) {
        return;
      }

      scrollViewStateTimeoutRef.current = window.setTimeout(
        flushPendingScrollViewState,
        PDF_SCROLL_STATE_INTERVAL_MS,
      );
    },
    [flushPendingScrollViewState],
  );

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let loadingTask: PDFDocumentLoadingTask | null = null;
    function destroyLoadingTask() {
      const task = loadingTask;
      loadingTask = null;
      // Destroying the task also destroys its worker and any loaded document.
      if (task) void task.destroy().catch(() => undefined);
    }

    async function loadPdf() {
      setPdfDocument(null);
      setBasePageLayouts([]);
      setCurrentPage(1);
      setRenderWindowPages(new Set());
      pageElementRefs.current.clear();

      if (!src) {
        setError("PDF preview is unavailable.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");
      const restoreViewState = initialViewStateRef.current;
      pendingScrollRestoreRef.current = {
        scrollLeft: restoreViewState?.scrollLeft ?? 0,
        scrollTop: restoreViewState?.scrollTop ?? 0,
      };

      try {
        const [pdfResponse, annotationsPayload] = await Promise.all([
          fetch(src, { signal: controller.signal }).then(async (response) => {
            if (!response.ok) {
              throw new Error("Could not load PDF file.");
            }

            return response.arrayBuffer();
          }),
          apiRequest<PdfAnnotationsPayload>(
            `/api/pdf-annotations?path=${encodeURIComponent(filePath)}`,
            { signal: controller.signal },
          ),
        ]);
        controller.signal.throwIfAborted();
        loadingTask = getDocument({ data: new Uint8Array(pdfResponse) });
        const loadedDocument = await loadingTask.promise;
        controller.signal.throwIfAborted();
        const loadedPageLayouts = await readPdfBasePageLayouts(loadedDocument, controller.signal);

        if (!active) {
          return;
        }

        setPdfDocument(loadedDocument);
        setBasePageLayouts(loadedPageLayouts);
        latestAnnotationsRef.current = annotationsPayload.annotations;
        automaticSpaceNotesRef.current.clear();
        setAnnotations(annotationsPayload.annotations);
        historyRef.current = EMPTY_HISTORY;
        setHistory(EMPTY_HISTORY);
      } catch (loadError) {
        controller.abort();
        destroyLoadingTask();
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "Could not load PDF.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void loadPdf();

    return () => {
      active = false;
      controller.abort();
      destroyLoadingTask();
      forgetPdfAnnotations(filePath);
    };
  }, [filePath, src]);

  // Quotes cite printed pages: keep the PDF's own page labels, when it has any.
  const pageLabelsRef = useRef<readonly string[] | null>(null);
  useEffect(() => {
    pageLabelsRef.current = null;
    if (!pdfDocument || typeof pdfDocument.getPageLabels !== "function") return;
    let active = true;
    pdfDocument.getPageLabels().then((labels) => {
      if (!active) return;
      pageLabelsRef.current = labels;
      rememberPdfPageLabels(filePath, labels);
    }, () => undefined);
    return () => {
      active = false;
    };
  }, [filePath, pdfDocument]);

  useLayoutEffect(() => {
    const pendingScrollRestore = pendingScrollRestoreRef.current;

    if (loading || !pdfDocument || !pendingScrollRestore || !pageLayouts.length) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      const scrollContainer = scrollContainerRef.current;

      if (!scrollContainer || pendingScrollRestoreRef.current !== pendingScrollRestore) {
        return;
      }

      const maxScrollLeft = Math.max(
        0,
        scrollContainer.scrollWidth - scrollContainer.clientWidth,
      );
      const maxScrollTop = Math.max(
        0,
        scrollContainer.scrollHeight - scrollContainer.clientHeight,
      );
      scrollContainer.scrollLeft = Math.min(
        pendingScrollRestore.scrollLeft,
        maxScrollLeft,
      );
      scrollContainer.scrollTop = Math.min(
        pendingScrollRestore.scrollTop,
        maxScrollTop,
      );
      pendingScrollRestoreRef.current = null;
      updateCurrentPage(scrollContainer);
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [loading, pageLayouts.length, pdfDocument, updateCurrentPage]);

  useLayoutEffect(() => {
    const anchor = pendingZoomAnchorRef.current;
    pendingZoomAnchorRef.current = null;
    const scroller = scrollContainerRef.current;
    const page = anchor && pageElementRefs.current.get(anchor.pageNumber);
    if (!anchor || !scroller || !page || pendingScrollRestoreRef.current) return;

    // Page sizes have committed, but the browser has not painted yet. Keep the
    // point being read at the viewport centre on both axes; anchoring only the
    // top edge still slides the middle of the view by a fraction of a screen.
    restorePdfZoomAnchor(scroller, page, anchor);

    // Replace any pre-zoom debounced position and persist immediately, even if
    // a tab switch captures/unmounts us before the browser emits a scroll event.
    pendingScrollViewStateRef.current = { scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop };
    flushPendingScrollViewState();
  }, [zoom, flushPendingScrollViewState]);

  // A one-shot request (Global Search) to show a page and find a passage on it.
  const reveal = initialViewState?.reveal;
  const findTextRef = useRef(pdfFind.findText);
  useEffect(() => {
    findTextRef.current = pdfFind.findText;
  });
  useEffect(() => {
    if (!reveal || loading || !pdfDocument || !pageLayouts.length) return;
    // After the scroll restore, which also runs in an animation frame.
    const frame = window.requestAnimationFrame(() => {
      pendingScrollRestoreRef.current = null;
      const page = Math.max(1, Math.min(reveal.page, pageLayouts.length));
      const pageElement = pageElementRefs.current.get(page);
      pageElement?.scrollIntoView({ block: "start", inline: "nearest" });
      // A bookmark's spot on the page, a little above it so its line is not at the very edge.
      const scroller = scrollContainerRef.current;
      if (pageElement && scroller && typeof reveal.top === "number" && reveal.top > 0) {
        scroller.scrollTop += Math.max(0, pageElement.offsetHeight * reveal.top - 24);
      }
      if (reveal.text) findTextRef.current(reveal.text, page);
      updateViewState({ reveal: undefined });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loading, pageLayouts.length, pdfDocument, reveal, updateViewState]);
  // Following a link: scroll to its annotation once, in place of (and after)
  // the saved-position restore, then save the new position as this tab's own.
  const revealSelectedAnnotation = initialViewState?.revealSelectedAnnotation;
  useEffect(() => {
    if (!revealSelectedAnnotation || loading || !pdfDocument || !pageLayouts.length) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      const scrollContainer = scrollContainerRef.current;
      const id = initialViewStateRef.current?.selectedAnnotationId ?? "";
      const annotation = latestAnnotationsRef.current.find((current) => current.id === id);
      const page = annotation && pageElementRefs.current.get(annotation.pageNumber);
      const annotationScrollState = annotationScrollStateRef.current;

      annotationScrollState.lastSelectedAnnotationId = id;
      annotationScrollState.allowInitialScroll = false;

      if (!scrollContainer || !annotation || !page) {
        updateViewState({ revealSelectedAnnotation: undefined });
        return;
      }

      const pageBounds = page.getBoundingClientRect();
      const containerBounds = scrollContainer.getBoundingClientRect();
      scrollContainer.scrollTop = scrollTopCenteringRect(
        pageBounds.top - containerBounds.top + scrollContainer.scrollTop,
        pageBounds.height,
        annotationAnchorRect(annotationToSurface(annotation, geometryOf(annotation.pageNumber))),
        scrollContainer.clientHeight,
      );
      pendingScrollRestoreRef.current = null;
      updateCurrentPage(scrollContainer);
      setSelectedAnnotationId(id);
      updateViewState({
        revealSelectedAnnotation: undefined,
        scrollLeft: scrollContainer.scrollLeft,
        scrollTop: scrollContainer.scrollTop,
        selectedAnnotationId: id,
      });
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [geometryOf, loading, pageLayouts.length, pdfDocument, revealSelectedAnnotation, updateCurrentPage, updateViewState]);

  useEffect(() => {
    rememberFileAnnotations(filePath, annotations);
  }, [annotations, filePath]);

  useCanvasViewStateCapture(() => {
    const element = scrollContainerRef.current;
    if (element && !pendingScrollRestoreRef.current) {
      updateViewState({ scrollLeft: element.scrollLeft, scrollTop: element.scrollTop });
    }
  });

  useLayoutEffect(() => () => {
    const element = scrollContainerRef.current;
    if (element && !pendingScrollRestoreRef.current) {
      pendingScrollViewStateRef.current = { scrollLeft: element.scrollLeft, scrollTop: element.scrollTop };
    }
    flushPendingScrollViewState();
  }, [flushPendingScrollViewState]);

  // Changes to spaces on pages above the one being read would slide it; the
  // reading position is captured before such a change and restored after it.
  const readingAnchorRef = useRef<PdfZoomAnchor | null>(null);
  const captureReadingAnchor = useCallback(() => {
    const scroller = scrollContainerRef.current;
    if (scroller && !pendingScrollRestoreRef.current) {
      readingAnchorRef.current = readPdfZoomAnchor(scroller, pageElementRefs.current);
    }
  }, []);
  const shownGeometriesRef = useRef(pageGeometries);
  useLayoutEffect(() => {
    const previous = shownGeometriesRef.current;
    shownGeometriesRef.current = pageGeometries;
    const anchor = readingAnchorRef.current;
    readingAnchorRef.current = null;
    const scroller = scrollContainerRef.current;
    const page = anchor && pageElementRefs.current.get(anchor.pageNumber);
    if (!anchor || !scroller || !page || previous === pageGeometries) return;
    const pages = new Set([...previous.keys(), ...pageGeometries.keys()]);
    if ([...pages].some((pageNumber) => pageNumber < anchor.pageNumber && previous.get(pageNumber) !== pageGeometries.get(pageNumber))) {
      restorePdfZoomAnchor(scroller, page, anchor);
    }
  }, [pageGeometries]);

  const setPageElement = useCallback((pageNumber: number, element: HTMLElement | null) => {
    if (element) {
      pageElementRefs.current.set(pageNumber, element);
      return;
    }

    pageElementRefs.current.delete(pageNumber);
  }, []);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;

    if (!scrollContainer || !pageLayouts.length) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        setRenderWindowPages((currentPages) => {
          const nextPages = new Set(currentPages);
          let changed = false;

          for (const entry of entries) {
            const pageNumber = pageNumberFromObservedElement(entry.target);

            if (!pageNumber) {
              continue;
            }

            if (entry.isIntersecting) {
              if (!nextPages.has(pageNumber)) {
                nextPages.add(pageNumber);
                changed = true;
              }
            } else if (nextPages.delete(pageNumber)) {
              changed = true;
            }
          }

          return changed ? nextPages : currentPages;
        });
      },
      {
        root: scrollContainer,
        rootMargin: PDF_PAGE_RENDER_ROOT_MARGIN,
        threshold: 0,
      },
    );

    pageElementRefs.current.forEach((element) => observer.observe(element));

    return () => observer.disconnect();
  }, [filePath, pageLayouts.length, zoom]);

  // Another window showing this PDF saved annotations: adopt them unless this
  // window has its own edit in flight, which will be saved over them anyway.
  const localSavePendingRef = useRef(false);
  useEffect(() => { localSavePendingRef.current = false; }, [filePath]);
  useAnnotationSync<PdfAnnotation>("pdf", filePath, (remoteAnnotations) => {
    if (localSavePendingRef.current) {
      return;
    }

    captureReadingAnchor();
    latestAnnotationsRef.current = remoteAnnotations;
    automaticSpaceNotesRef.current.clear();
    setAnnotations(remoteAnnotations);
    // Undoing past another window's save would silently revert its edits.
    historyRef.current = EMPTY_HISTORY;
    setHistory(EMPTY_HISTORY);
    dispatchPdfAnnotationsUpdated({ path: filePath, annotations: remoteAnnotations });
  });

  const scheduleAnnotations = useAnnotationWriter<PdfAnnotation>("pdf", filePath, (savedAnnotations) => {
    localSavePendingRef.current = false;
    latestAnnotationsRef.current = savedAnnotations;
    setAnnotations(savedAnnotations);
    dispatchPdfAnnotationsUpdated({ path: filePath, annotations: savedAnnotations });
    setSaveStatus("saved");
  }, (saveError) => {
    setSaveStatus("error");
    setError(saveError instanceof Error ? saveError.message : "Could not save PDF annotations.");
  });
  const saveAnnotations = useCallback(
    (nextAnnotations: PdfAnnotation[]) => {
      latestAnnotationsRef.current = nextAnnotations;
      setAnnotations(nextAnnotations);
      dispatchPdfAnnotationsUpdated({ path: filePath, annotations: nextAnnotations });
      setSaveStatus("saving");
      localSavePendingRef.current = true;
      scheduleAnnotations(nextAnnotations);
    },
    [filePath, scheduleAnnotations],
  );

  function applyZoom(nextValue: number) {
    const nextZoom = clamp(nextValue, MIN_ZOOM, MAX_ZOOM);
    if (nextZoom === zoom) return;
    const scroller = scrollContainerRef.current;
    if (scroller && !pendingScrollRestoreRef.current) {
      pendingZoomAnchorRef.current = readPdfZoomAnchor(scroller, pageElementRefs.current);
    }
    setZoom(nextZoom);
    updateViewState({ zoom: nextZoom });
  }

  function changeZoom(delta: number) {
    applyZoom(zoom + delta);
  }

  // Leave wheel and touch gestures to the browser. Intercepting trackpad pinch
  // requires a blocking wheel listener, including on ordinary scroll events.
  // The toolbar changes PDF resolution explicitly; native pinch only magnifies
  // the existing surface and never restarts PDF.js for each gesture frame.

  const captureScreenshotSnip = useCallback(async (pageNumber: number, rect: PdfAnnotationRect) => {
    const completeScreenshotSnip = screenshotCallbacksRef.current.onCompleteScreenshotSnip;
    if (!pdfDocument || !completeScreenshotSnip) {
      return;
    }

    try {
      const page = await pdfDocument.getPage(pageNumber);
      // The reading model needs small print at least ~180 DPI; pictures follow the screen.
      const renderScale = Math.max(
        screenshotSnipModeRef.current === "markdown" ? MARKDOWN_SNIP_RENDER_SCALE : 1,
        window.devicePixelRatio || 1,
      );
      const viewport = page.getViewport({ scale: renderScale });
      const sourceCanvas = document.createElement("canvas");
      const sourceContext = sourceCanvas.getContext("2d");

      if (!sourceContext) {
        throw new Error("Could not create screenshot canvas.");
      }

      sourceCanvas.width = Math.max(1, Math.ceil(viewport.width));
      sourceCanvas.height = Math.max(1, Math.ceil(viewport.height));

      await page.render({
        canvasContext: sourceContext,
        viewport,
      }).promise;

      const cropX = Math.min(
        sourceCanvas.width - 1,
        Math.round(rect.x * sourceCanvas.width),
      );
      const cropY = Math.min(
        sourceCanvas.height - 1,
        Math.round(rect.y * sourceCanvas.height),
      );
      const cropWidth = Math.max(
        1,
        Math.min(sourceCanvas.width - cropX, Math.round(rect.width * sourceCanvas.width)),
      );
      const cropHeight = Math.max(
        1,
        Math.min(
          sourceCanvas.height - cropY,
          Math.round(rect.height * sourceCanvas.height),
        ),
      );
      const outputCanvas = document.createElement("canvas");
      const outputContext = outputCanvas.getContext("2d");

      if (!outputContext) {
        throw new Error("Could not create screenshot canvas.");
      }

      outputCanvas.width = cropWidth;
      outputCanvas.height = cropHeight;
      outputContext.drawImage(
        sourceCanvas,
        cropX,
        cropY,
        cropWidth,
        cropHeight,
        0,
        0,
        cropWidth,
        cropHeight,
      );

      await completeScreenshotSnip(
        pngFileFromBlob(
          await canvasToPngBlob(outputCanvas),
          filePath,
          `pdf-page-${pageNumber}`,
        ),
      );
    } catch (captureError) {
      setError(
        captureError instanceof Error
          ? captureError.message
          : "Could not capture PDF screenshot.",
      );
    }
  }, [filePath, pdfDocument]);

  // Updaters read the latest list from a ref, so these callbacks stay stable
  // and typing in one note does not re-render every page of the document.
  const replaceHistory = useCallback((next: typeof EMPTY_HISTORY) => {
    historyRef.current = next;
    setHistory(next);
  }, []);

  const commitAnnotations = useCallback((updater: AnnotationUpdater, historyKey?: string) => {
    const current = latestAnnotationsRef.current;
    const next = updater(current);

    if (next === current) {
      return;
    }

    const { undo } = historyRef.current;
    const last = undo.at(-1);
    const time = Date.now();

    replaceHistory({
      undo:
        historyKey && last?.key === historyKey && time - last.time < HISTORY_COALESCE_MS
          ? [...undo.slice(0, -1), { ...last, time }]
          : [...undo, { annotations: current, key: historyKey, time }].slice(-MAX_UNDO_STEPS),
      redo: [],
    });
    saveAnnotations(next);
  }, [replaceHistory, saveAnnotations]);

  const selectAnnotationId = useCallback((id: string) => {
    // Selections made on the page are already in view; only selections from
    // elsewhere (the outline panel) should scroll the document to them.
    annotationScrollStateRef.current.lastSelectedAnnotationId = id;
    annotationScrollStateRef.current.allowInitialScroll = false;
    setSelectedAnnotationId(id);
    updateViewState({ selectedAnnotationId: id });
  }, [updateViewState]);

  const selectAnnotation = useCallback((annotation: PdfAnnotation) => {
    selectAnnotationId(annotation.id);

    if (annotation.type === "text") {
      setFontSize(annotation.fontSize);
      updateViewState({ fontSize: annotation.fontSize });
    }
  }, [selectAnnotationId, updateViewState]);

  const clearSelection = useCallback(() => {
    setSelectionMenu(null);

    if (activeSelectedAnnotationIdRef.current) {
      selectAnnotationId("");
    }
  }, [selectAnnotationId]);

  const updateAnnotation = useCallback((id: string, patch: Partial<PdfAnnotation>) => {
    if ("text" in patch && patch.text?.trim()) automaticSpaceNotesRef.current.delete(id);
    const keys = Object.keys(patch).sort();
    // Typing coalesces with the note's creation; restyling with itself. Each
    // drag stays its own step.
    const historyKey = keys.join() === "text"
      ? `note:${id}`
      : keys.some((key) => ["rect", "from", "to", "points"].includes(key))
        ? undefined
        : `update:${id}:${keys.join()}`;

    commitAnnotations((current) => {
      let changed = false;
      const next = current.map((annotation) => {
        if (annotation.id !== id) {
          return annotation;
        }

        changed = true;
        return { ...annotation, ...patch, updatedAt: nowIso() } as PdfAnnotation;
      });

      return changed ? next : current;
    }, historyKey);
  }, [commitAnnotations]);

  const deleteAnnotations = useCallback((ids: string[], historyKey?: string) => {
    const current = latestAnnotationsRef.current;
    const doomed = new Set(ids);
    // A space goes with everything in it.
    for (const annotation of current) {
      if ("space" in annotation && annotation.space && doomed.has(annotation.space)) doomed.add(annotation.id);
    }
    const next = current.filter((annotation) => !doomed.has(annotation.id));

    if (next.length !== current.length) {
      const [only] = ids;
      const abandoned = ids.length === 1 ? current.find((annotation) => annotation.id === only) : undefined;
      const { undo, redo } = historyRef.current;
      const last = undo.at(-1);

      if (abandoned?.type === "text" && !abandoned.text.trim() && automaticSpaceNotesRef.current.has(only)) {
        // This was only the space's empty editor. Remove the shell from
        // history too, while keeping each space gesture as its own step.
        const withoutNote = (entry: HistoryEntry) => ({ ...entry, annotations: entry.annotations.filter((annotation) => annotation.id !== only) });
        replaceHistory({ undo: undo.map(withoutNote), redo: redo.map(withoutNote) });
        saveAnnotations(next);
      } else if (abandoned?.type === "text" && !abandoned.text.trim() && last?.key === `note:${only}`) {
        // A note abandoned empty leaves no step behind to undo into.
        replaceHistory({ undo: undo.slice(0, -1), redo });
        saveAnnotations(next);
      } else {
        commitAnnotations(() => next, historyKey);
      }
      for (const id of doomed) automaticSpaceNotesRef.current.delete(id);
    }

    if (doomed.has(activeSelectedAnnotationIdRef.current)) {
      selectAnnotationId("");
    }
  }, [commitAnnotations, replaceHistory, saveAnnotations, selectAnnotationId]);

  const deleteAnnotation = useCallback((id: string) => deleteAnnotations([id]), [deleteAnnotations]);

  const stepHistory = useCallback((direction: "undo" | "redo") => {
    const { undo, redo } = historyRef.current;
    const entry = (direction === "undo" ? undo : redo).at(-1);

    if (!entry) {
      return;
    }

    const counterpart: HistoryEntry = { annotations: latestAnnotationsRef.current, time: Date.now() };

    replaceHistory(
      direction === "undo"
        ? { undo: undo.slice(0, -1), redo: [...redo, counterpart] }
        : { undo: [...undo, counterpart], redo: redo.slice(0, -1) },
    );
    captureReadingAnchor();
    saveAnnotations(entry.annotations);

    const selectedId = activeSelectedAnnotationIdRef.current;

    if (selectedId && !entry.annotations.some((annotation) => annotation.id === selectedId)) {
      selectAnnotationId("");
    }
  }, [captureReadingAnchor, replaceHistory, saveAnnotations, selectAnnotationId]);

  /** Marks up the current text selection, split across every page it spans. */
  const markSelection = useCallback((color: string, markup: PdfMarkupStyle) => {
    const selection = window.getSelection();
    const pages = selectionPageRects(selection, viewerRef.current, geometryOf);

    if (!selection || !pages) {
      return false;
    }

    const timestamp = nowIso();
    const created: PdfHighlightAnnotation[] = pages.map(({ pageNumber, rects, quote }) => ({
      id: createAnnotationId(),
      type: "highlight",
      pageNumber,
      color,
      rects,
      quote,
      ...(markup === "highlight" ? {} : { markup }),
      createdAt: timestamp,
      updatedAt: timestamp,
    }));

    selection.removeAllRanges();
    setSelectionMenu(null);

    if (!created.length) {
      return false;
    }

    commitAnnotations((current) => [...current, ...created]);
    return true;
  }, [commitAnnotations, geometryOf]);

  const newTextStyleRef = useRef({ color: textColor, fontFamily, fontSize });
  useEffect(() => {
    newTextStyleRef.current = { color: textColor, fontFamily, fontSize };
  }, [fontFamily, fontSize, textColor]);

  const newNote = useCallback((pageNumber: number, rect: PdfAnnotationRect, space?: string): PdfTextAnnotation => {
    const timestamp = nowIso();
    const style = newTextStyleRef.current;
    return {
      id: createAnnotationId(),
      type: "text",
      pageNumber,
      text: "",
      fontSize: style.fontSize,
      color: style.color,
      fontFamily: style.fontFamily,
      rect,
      ...(space ? { space } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }, []);

  const addTextAnnotation = useCallback((pageNumber: number, rect: PdfAnnotationRect, space?: string) => {
    const annotation = newNote(pageNumber, rect, space);

    selectAnnotationId(annotation.id);
    commitAnnotations((current) => [...current, annotation], `note:${annotation.id}`);
    return annotation.id;
  }, [commitAnnotations, newNote, selectAnnotationId]);

  // The note a new space opens with; its page starts editing it.
  const [noteToEdit, setNoteToEdit] = useState<{ id: string; pageNumber: number } | null>(null);
  const editRequestHandled = useCallback((id: string) => {
    setNoteToEdit((current) => current?.id === id ? null : current);
  }, []);
  // Your own space edits keep what is above them still, on every page; only
  // changes made elsewhere (undo, another window) restore the reading position.
  const previewSpaces = useCallback((pageNumber: number, spaces: PdfSpaceAnnotation[] | null) => {
    setSpaceDraft(spaces ? { pageNumber, spaces } : null);
  }, []);
  const commitSpace = useCallback((space: PdfSpaceAnnotation, created: boolean) => {
    const currentSpaces = latestAnnotationsRef.current.filter((annotation): annotation is PdfSpaceAnnotation =>
      annotation.type === "space" && annotation.pageNumber === space.pageNumber);
    if (!created && !currentSpaces.some((current) => current.id === space.id)) return;
    const maxHeight = availableSpaceHeight(currentSpaces, created ? undefined : space.id);
    if (maxHeight < PDF_SPACE_MIN_HEIGHT) return;
    space = { ...space, height: Math.min(maxHeight, Math.max(PDF_SPACE_MIN_HEIGHT, space.height)) };
    if (!created) {
      commitAnnotations(
        (current) => current.map((annotation) => annotation.id === space.id ? space : annotation),
      );
      return;
    }

    // Typing starts at once in a note filling the new space.
    const { x0, x1 } = columnBounds(space.band, space.column);
    const inset = isFullWidthBand(space.band) ? SPACE_NOTE_INSET.page : SPACE_NOTE_INSET.column;
    const note = newNote(space.pageNumber, {
      x: x0 + inset,
      y: SPACE_NOTE_INSET.y,
      width: Math.max(0.05, x1 - x0 - inset * 2),
      height: Math.max(0.01, space.height - SPACE_NOTE_INSET.y * 2),
    }, space.id);
    automaticSpaceNotesRef.current.add(note.id);
    selectAnnotationId(note.id);
    setNoteToEdit({ id: note.id, pageNumber: note.pageNumber });
    commitAnnotations((current) => [...current, space, note], `space:${space.id}`);
  }, [commitAnnotations, newNote, selectAnnotationId]);
  const deleteSpace = useCallback((id: string) => deleteAnnotations([id]), [deleteAnnotations]);

  const addDrawing = useCallback((pageNumber: number, draft: PdfDrawingDraft) => {
    const timestamp = nowIso();
    const annotation = {
      ...draft,
      id: createAnnotationId(),
      pageNumber,
      createdAt: timestamp,
      updatedAt: timestamp,
    } as PdfDrawingAnnotation;

    commitAnnotations((current) => [...current, annotation]);
  }, [commitAnnotations]);

  const eraseAnnotations = useCallback(
    (ids: string[], gestureKey: string) => deleteAnnotations(ids, gestureKey),
    [deleteAnnotations],
  );

  const updateTextAnnotation = useCallback(
    (id: string, patch: Partial<PdfTextAnnotation>) => updateAnnotation(id, patch),
    [updateAnnotation],
  );

  const exitTextEditing = useCallback(() => {
    setNoteToEdit(null);
    setTool("select");
    updateViewState({ tool: "select" });
  }, [updateViewState]);

  const markupInk = markupStyle === "highlight" ? highlightColor : markupColor;
  const selectToolRef = useRef(selectTool);
  useLayoutEffect(() => {
    selectToolRef.current = selectTool;
  });

  function selectTool(nextTool: PdfTool) {
    setTool(nextTool);
    updateViewState({ tool: nextTool });
    setSelectionMenu(null);

    // Choosing a markup tool with text already selected marks it right away.
    if (nextTool === "highlight") {
      markSelection(markupInk, markupStyle);
    }
  }

  function chooseMarkupStyle(nextStyle: PdfMarkupStyle) {
    if (selectedHighlight) {
      updateAnnotation(
        selectedHighlight.id,
        convertMarkup(selectedHighlight, nextStyle, nextStyle === "highlight" ? highlightColor : markupColor),
      );
      return;
    }

    setMarkupStyle(nextStyle);
    updateViewState({ markupStyle: nextStyle });

    if (tool !== "highlight") {
      selectTool("highlight");
    }
  }

  function updateMarkupColor(nextColor: string) {
    setMarkupColor(nextColor);
    updateViewState({ markupColor: nextColor });
  }

  function applyInkColor(nextColor: string) {
    setInkColor(nextColor);
    updateViewState({ inkColor: nextColor });

    if (selectedDrawing) {
      updateAnnotation(selectedDrawing.id, { color: nextColor });
    }
  }

  function applyStrokeWidth(nextWidth: number) {
    setStrokeWidth(nextWidth);
    updateViewState({ strokeWidth: nextWidth });

    if (selectedDrawing) {
      updateAnnotation(selectedDrawing.id, { strokeWidth: nextWidth });
    }
  }

  function chooseShapeKind(nextShape: PdfShapeKind) {
    if (selectedDrawing?.type === "shape") {
      updateAnnotation(selectedDrawing.id, { shape: nextShape });
      return;
    }

    setShapeKind(nextShape);
    updateViewState({ shapeKind: nextShape });

    if (tool !== "shape") {
      selectTool("shape");
    }
  }

  function updateFontSize(value: number) {
    const nextFontSize = Math.round(
      clamp(value, MIN_TEXT_ANNOTATION_FONT_SIZE, MAX_TEXT_ANNOTATION_FONT_SIZE),
    );
    setFontSize(nextFontSize);
    updateViewState({ fontSize: nextFontSize });

    if (selectedTextAnnotation) {
      updateTextAnnotation(selectedTextAnnotation.id, { fontSize: nextFontSize });
    }
  }

  function updateFontFamily(nextFont: PdfTextAnnotationFont) {
    setFontFamily(nextFont);
    updateViewState({ fontFamily: nextFont });

    if (selectedTextAnnotation) {
      updateTextAnnotation(selectedTextAnnotation.id, { fontFamily: nextFont });
    }
  }

  function updateTextColor(nextColor: string) {
    setTextColor(nextColor);
    updateViewState({ textColor: nextColor });

    if (selectedTextAnnotation) {
      updateTextAnnotation(selectedTextAnnotation.id, { color: nextColor });
    }
  }

  const updateHighlightColor = useCallback((nextColor: string) => {
    setHighlightColor(nextColor);
    updateViewState({ highlightColor: nextColor });
  }, [updateViewState]);

  function applyMarkupColor(nextColor: string) {
    const style = selectedHighlight ? markupStyleOf(selectedHighlight) : markupStyle;

    if (style === "highlight") {
      updateHighlightColor(nextColor);
    } else {
      updateMarkupColor(nextColor);
    }

    if (selectedHighlight) {
      updateAnnotation(selectedHighlight.id, { color: nextColor });
    }
  }

  const deleteSelectedAnnotation = useCallback(() => {
    if (activeSelectedAnnotationId) {
      deleteAnnotation(activeSelectedAnnotationId);
    }
  }, [activeSelectedAnnotationId, deleteAnnotation]);

  useEffect(() => {
    function isEditableTarget(element: Element | null) {
      return (
        element instanceof HTMLElement &&
        (element.isContentEditable || element.matches("input, textarea, select"))
      );
    }

    function handleKeyDown(event: KeyboardEvent) {
      const viewer = viewerRef.current;
      const activeElement = document.activeElement;

      if (
        event.defaultPrevented ||
        !viewer ||
        isEditableTarget(activeElement) ||
        (activeElement === document.body && !paneFocused) ||
        (activeElement !== document.body && !viewer.contains(activeElement))
      ) {
        return;
      }

      const modifier = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (modifier && !event.altKey && (key === "z" || (key === "y" && event.ctrlKey && !event.metaKey))) {
        event.preventDefault();
        stepHistory(key === "y" || event.shiftKey ? "redo" : "undo");
        return;
      }

      // Add comment on the selected text, as in the Markdown editors.
      if (modifier && event.altKey && event.code === "KeyM") {
        if (startCommentRef.current()) event.preventDefault();
        return;
      }

      const shortcutTool = TOOL_SHORTCUTS[key];

      if (shortcutTool && !modifier && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        selectToolRef.current(shortcutTool);
        return;
      }

      if (event.key === "Escape" && tool !== "select") {
        // Put the tool down first; the next Esc clears the selection.
        event.preventDefault();
        setTool("select");
        updateViewState({ tool: "select" });
        return;
      }

      if (event.key === "Escape") {
        const selection = window.getSelection();
        const hadTextSelection = Boolean(
          selection && !selection.isCollapsed && viewer.contains(selection.anchorNode),
        );

        if (hadTextSelection) {
          selection?.removeAllRanges();
        }

        if (hadTextSelection || activeSelectedAnnotationId || selectionMenu) {
          event.preventDefault();
          clearSelection();
        }

        return;
      }

      if (activeSelectedAnnotationId && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        deleteSelectedAnnotation();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activeSelectedAnnotationId,
    clearSelection,
    deleteSelectedAnnotation,
    paneFocused,
    selectionMenu,
    stepHistory,
    tool,
    updateViewState,
  ]);

  // Copy is synchronous, so measure the pages around a selection while it is made.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!layoutStore || !viewer) return;
    let timer = 0;

    function readAhead() {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const selection = window.getSelection();
        if (!viewer || !selection || selection.isCollapsed || !selection.rangeCount) return;
        const pages = pdfRangePages(selection.getRangeAt(0), viewer);
        if (!pages.length) return;
        const first = Math.min(...pages);
        const last = Math.max(...pages);
        const nearby: number[] = [];
        for (let page = first - 2; page <= last + 2; page++) nearby.push(page);
        void layoutStore?.ensure(nearby);
      }, 120);
    }

    document.addEventListener("selectionchange", readAhead);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", readAhead);
    };
  }, [layoutStore]);

  // The quick-highlight menu follows the live selection and disappears with it.
  useEffect(() => {
    if (!selectionMenu) {
      return;
    }

    function handleSelectionChange() {
      const selection = window.getSelection();

      if (!selection || selection.isCollapsed) {
        setSelectionMenu(null);
      }
    }

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [selectionMenu]);

  function handleScrollPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;

    if (event.button !== 0 || target.closest(ANNOTATION_UI_SELECTOR)) {
      return;
    }

    // Clicking empty paper (or the gutter) lets go of the current annotation.
    clearSelection();
  }

  function handleScrollPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest(ANNOTATION_UI_SELECTOR)) {
      return;
    }

    if (tool === "highlight") {
      markSelection(markupInk, markupStyle);
      return;
    }

    if (tool !== "select") {
      return;
    }

    const scrollContainer = event.currentTarget;

    // Let the browser settle the selection before reading it.
    window.requestAnimationFrame(() => {
      const selection = window.getSelection();

      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        return;
      }

      const range = selection.getRangeAt(0);

      if (!scrollContainer.contains(range.commonAncestorContainer)) {
        return;
      }

      const position = selectionMenuPosition(range, scrollContainer);

      if (position) {
        setSelectionMenu(position);
      }
    });
  }

  /** Clean Markdown for a PDF text selection; "" leaves the browser's plain text. */
  function selectionMarkdown() {
    const viewer = viewerRef.current;
    return viewer && layoutStore ? pdfSelectionMarkdown(viewer, layoutStore) : "";
  }

  function handleCopy(event: React.ClipboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable]")) return;
    const markdown = selectionMarkdown();
    if (markdown) writeMarkdownClipboard(event.nativeEvent, markdown);
  }

  /** The current text selection as a quote: its Markdown and the pages it spans. */
  function selectionQuoteSource(): PdfQuoteSource | null {
    const viewer = viewerRef.current;
    const selection = window.getSelection();
    if (!viewer || !selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!viewer.contains(range.commonAncestorContainer)) return null;
    const quote = selectionMarkdown() || normalizePdfHighlightQuote(selection.toString());
    const pages = pdfRangePages(range, viewer);
    if (!quote.trim() || !pages.length) return null;
    const page = Math.min(...pages);
    const endPage = Math.max(...pages);
    const labels = pageLabelsRef.current;
    return {
      quote,
      path: filePath,
      page,
      ...(labels?.[page - 1]?.trim() ? { pageLabel: labels[page - 1].trim() } : {}),
      ...(endPage !== page ? { endPage, ...(labels?.[endPage - 1]?.trim() ? { endPageLabel: labels[endPage - 1].trim() } : {}) } : {}),
    };
  }

  function readSelectionAloud() {
    const viewer = viewerRef.current;
    const selection = window.getSelection();
    const inViewer = !!viewer && !!selection && !selection.isCollapsed && !!selection.rangeCount && viewer.contains(selection.getRangeAt(0).commonAncestorContainer);
    const text = inViewer ? selectionMarkdown() || normalizePdfHighlightQuote(selection!.toString()) : "";
    setSelectionMenu(null);
    if (text.trim()) speakMarkdown(text, { label: "PDF selection" });
  }

  function quoteSelection() {
    const source = selectionQuoteSource();
    setSelectionMenu(null);
    if (!source) return;
    window.getSelection()?.removeAllRanges();
    window.dispatchEvent(new CustomEvent<PdfQuoteCiteDetail>(PDF_QUOTE_CITE_EVENT, { detail: source }));
  }

  // Dragging selected text into an editor quotes and cites it there.
  function handleDragStart(event: React.DragEvent<HTMLDivElement>) {
    if ((event.target as Node).nodeType === Node.ELEMENT_NODE && (event.target as HTMLElement).closest(ANNOTATION_UI_SELECTOR)) return;
    const source = selectionQuoteSource();
    if (!source) return;
    event.dataTransfer.setData(PDF_CITATION_MIME, JSON.stringify(source));
    event.dataTransfer.setData("text/plain", source.quote);
    event.dataTransfer.effectAllowed = "copy";
    setSelectionMenu(null);
  }

  function copySelection() {
    const text = selectionMarkdown() || (window.getSelection()?.toString() ?? "");

    if (text) {
      void navigator.clipboard?.writeText(text).catch(() => undefined);
    }

    setSelectionMenu(null);
  }

  /** Opens the comment box for the current text selection, whose passage stays marked while you write. */
  function startComment() {
    const selection = window.getSelection();
    const pages = selectionPageRects(selection, viewerRef.current, geometryOf);
    const scrollContainer = scrollContainerRef.current;

    if (!selection || !pages || !scrollContainer) {
      return false;
    }

    const position = commentBoxPosition(selection.getRangeAt(0), scrollContainer);
    const quote = pages.map((page) => page.quote ?? "").filter(Boolean).join(" ") || normalizePdfHighlightQuote(selection.toString());
    setCommentDraft({
      anchor: { segments: pages.map(({ pageNumber, rects }) => ({ pageNumber, rects })), quote },
      left: clamp(position?.left ?? 8, 8, Math.max(8, scrollContainer.scrollWidth - COMMENT_BOX_WIDTH - 16)),
      top: position?.top ?? scrollContainer.scrollTop + 8,
    });
    setCommentText("");
    selection.removeAllRanges();
    setSelectionMenu(null);
    return true;
  }
  const startCommentRef = useRef(startComment);
  useLayoutEffect(() => {
    startCommentRef.current = startComment;
  });

  function cancelComment() {
    setCommentDraft(null);
    setCommentText("");
  }

  async function submitComment() {
    const draft = commentDraft;
    const text = commentText.trim();

    if (!draft || !text || comments.busy) {
      return;
    }

    const before = new Set(pdfCommentsState(filePath).threads.map((thread) => thread.id));
    const threads = await changePdfComments(filePath, { action: "comment", anchor: draft.anchor, text });

    if (!threads) {
      return;
    }

    cancelComment();
    const created = threads.find((thread) => !before.has(thread.id));
    if (created) selectPdfComment(filePath, created.id);
    showCommentsRef.current?.();
  }

  const showMarkupStyle = tool === "highlight" || Boolean(selectedHighlight);
  const shownMarkupStyle = selectedHighlight ? markupStyleOf(selectedHighlight) : markupStyle;
  const showTextStyle = tool === "text" || Boolean(selectedTextAnnotation);
  const textStyleValues = selectedTextAnnotation
    ? {
        color: selectedTextAnnotation.color ?? DEFAULT_PDF_TEXT_COLOR,
        fontFamily: selectedTextAnnotation.fontFamily ?? DEFAULT_PDF_TEXT_FONT,
      }
    : { color: textColor, fontFamily };
  const showDrawingStyle = tool === "draw" || tool === "shape" || Boolean(selectedDrawing);
  const drawingStyleValues = selectedDrawing
    ? { color: selectedDrawing.color, strokeWidth: selectedDrawing.strokeWidth }
    : { color: inkColor, strokeWidth };
  const shownShapeKind = selectedDrawing?.type === "shape" ? selectedDrawing.shape : shapeKind;
  const markupChoice = MARKUP_CHOICES.find((choice) => choice.value === markupStyle) ?? MARKUP_CHOICES[0];
  const shapeChoice = SHAPE_CHOICES.find((choice) => choice.value === shapeKind) ?? SHAPE_CHOICES[0];

  // Annotation styles and page moves for the command palette. The toolbar's
  // buttons are read from the page, but its style pickers show only for the
  // tool or annotation in use; these use the same names, so they replace the
  // pickers' entries and are there whatever is selected.
  usePaletteCommands(viewerRef, () => {
    const group = "PDF";
    const pageCount = pageLayouts.length;
    const page = Math.min(currentPage, pageCount);
    const goToPage = (target: number) => pageElementRefs.current.get(clamp(target, 1, pageCount))?.scrollIntoView({ block: "start", inline: "nearest" });
    const highlightSelected = selectedHighlight && markupStyleOf(selectedHighlight) === "highlight";
    const otherMarkupSelected = selectedHighlight && !highlightSelected;
    return [
      ...MARKUP_CHOICES.map((choice) => ({
        id: `pdf:markup:${choice.value}`, title: `Markup style: ${choice.label}`, group, icon: choice.icon, keywords: "annotate text highlighter",
        checked: showMarkupStyle && shownMarkupStyle === choice.value, run: () => chooseMarkupStyle(choice.value),
      })),
      ...PDF_HIGHLIGHT_COLORS.map((color) => ({
        id: `pdf:highlight-color:${color.value}`, title: `Highlight color: ${color.label}`, group, icon: Highlighter, keywords: "annotate markup",
        checked: (highlightSelected ? selectedHighlight.color : highlightColor).toLowerCase() === color.value.toLowerCase(),
        run: () => { if (highlightSelected) applyMarkupColor(color.value); else updateHighlightColor(color.value); },
      })),
      ...markupPalette("underline").map((color) => ({
        id: `pdf:markup-color:${color.value}`, title: `Markup color: ${color.label}`, group, icon: Underline, keywords: "annotate underline strikethrough squiggly",
        checked: (otherMarkupSelected ? selectedHighlight.color : markupColor).toLowerCase() === color.value.toLowerCase(),
        run: () => { if (otherMarkupSelected) applyMarkupColor(color.value); else updateMarkupColor(color.value); },
      })),
      ...SHAPE_CHOICES.map((choice) => ({
        id: `pdf:shape:${choice.value}`, title: `Shape: ${choice.label}`, group, icon: choice.icon, keywords: "draw annotate",
        checked: (tool === "shape" || selectedDrawing?.type === "shape") && shownShapeKind === choice.value, run: () => chooseShapeKind(choice.value),
      })),
      ...PDF_INK_COLORS.map((color) => ({
        id: `pdf:ink-color:${color.value}`, title: `Ink color: ${color.label}`, group, icon: PenLine, keywords: "pen shape draw annotate",
        checked: drawingStyleValues.color.toLowerCase() === color.value.toLowerCase(), run: () => applyInkColor(color.value),
      })),
      ...PDF_STROKE_WIDTHS.map((width) => ({
        id: `pdf:stroke-width:${width.value}`, title: `Stroke width: ${width.label} stroke`, group, icon: PenLine, keywords: "pen shape line thickness",
        checked: drawingStyleValues.strokeWidth === width.value, run: () => applyStrokeWidth(width.value),
      })),
      ...PDF_TEXT_COLORS.map((color) => ({
        id: `pdf:note-color:${color.value}`, title: `Note color: ${color.label}`, group, icon: Type, keywords: "text annotation",
        checked: textStyleValues.color.toLowerCase() === color.value.toLowerCase(), run: () => updateTextColor(color.value),
      })),
      ...PDF_TEXT_FONTS.map((font) => ({
        id: `pdf:note-font:${font.value}`, title: `Note font: ${font.label}`, group, icon: Type, keywords: "text annotation typeface",
        checked: textStyleValues.fontFamily === font.value, run: () => updateFontFamily(font.value),
      })),
      { id: "pdf:note-font-larger", title: "Note font size: larger", group, icon: Type, keywords: "text annotation bigger increase", disabled: fontSize >= MAX_TEXT_ANNOTATION_FONT_SIZE, run: () => updateFontSize(fontSize + 2) },
      { id: "pdf:note-font-smaller", title: "Note font size: smaller", group, icon: Type, keywords: "text annotation decrease", disabled: fontSize <= MIN_TEXT_ANNOTATION_FONT_SIZE, run: () => updateFontSize(fontSize - 2) },
      { id: "pdf:add-comment", title: "Add comment", group, icon: MessageSquarePlus, shortcut: "Ctrl/Cmd+Alt+M", keywords: "review selected text", run: () => { startCommentRef.current(); } },
      { id: "pdf:next-page", title: "Next page", group, icon: ChevronDown, disabled: !pageCount || page >= pageCount, run: () => goToPage(page + 1) },
      { id: "pdf:previous-page", title: "Previous page", group, icon: ChevronUp, disabled: !pageCount || page <= 1, run: () => goToPage(page - 1) },
      { id: "pdf:first-page", title: "First page", group, icon: ChevronsUp, keywords: "top start", disabled: !pageCount || page <= 1, run: () => goToPage(1) },
      { id: "pdf:last-page", title: "Last page", group, icon: ChevronsDown, keywords: "bottom end", disabled: !pageCount || page >= pageCount, run: () => goToPage(pageCount) },
    ];
  });
  const drawingMode: PdfDrawingMode = screenshotSnipping
    ? "idle"
    : tool === "draw" || tool === "shape" || tool === "eraser" || tool === "select"
      ? tool
      : "idle";
  const drawingStyle = useMemo(
    () => ({ color: inkColor, shape: shapeKind, strokeWidth }),
    [inkColor, shapeKind, strokeWidth],
  );

  return (
    <div ref={viewerRef} tabIndex={-1} data-pdf-path={filePath} data-pdf-tool={tool} data-pdf-markup={markupStyle} className="libera-media-viewer libera-pdf-viewer flex min-h-0 flex-1 flex-col overflow-hidden bg-muted outline-none"
      style={{ "--pdf-highlight-color": highlightColor, "--pdf-markup-color": markupColor } as React.CSSProperties}
      onCopy={handleCopy}
      onPointerDown={(event) => {
        if (!(event.target as HTMLElement).closest("button, input, textarea, select, a, [contenteditable]")) {
          event.currentTarget.focus({ preventScroll: true });
        }
      }}>
      <div className="libera-viewer-toolbar sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-input bg-card px-4 py-2" data-command-toolbar="PDF">
        {/* Contextual style controls scroll sideways instead of wrapping, so
            selecting an annotation never shifts the page under the pointer. */}
        <div className="libera-annotation-toolbar flex min-w-0 flex-1 items-center gap-1" data-pdf-annotation-ui onMouseDown={keepEditorFocus}>
          <PdfToolButton
            active={tool === "select"}
            icon={MousePointer2}
            label="Select"
            title="Select"
            tool="select"
            onSelect={selectTool}
          />
          <PdfToolButton
            active={tool === "highlight"}
            className={tool === "highlight" && markupStyle === "highlight" ? "pdf-highlight-tool-active" : undefined}
            icon={markupChoice.icon}
            label={markupChoice.tool}
            markup={markupStyle}
            title={`${markupChoice.label}: select text to mark it`}
            tool="highlight"
            onSelect={selectTool}
          />
          <PdfToolButton
            active={tool === "text"}
            icon={Type}
            label="Text"
            title="Text note: click to place, or drag to draw a box"
            tool="text"
            onSelect={selectTool}
          />
          <PdfToolButton
            active={tool === "draw"}
            icon={PenLine}
            label="Pen"
            title="Pen: draw freehand"
            tool="draw"
            onSelect={selectTool}
          />
          <PdfToolButton
            active={tool === "shape"}
            icon={shapeChoice.icon}
            label="Shape"
            title={`${shapeChoice.label}: drag to draw, Shift to constrain`}
            tool="shape"
            onSelect={selectTool}
          />
          <PdfToolButton
            active={tool === "eraser"}
            icon={Eraser}
            label="Erase"
            title="Eraser: drag across pen strokes, shapes and markup"
            tool="eraser"
            onSelect={selectTool}
          />
          <PdfToolButton
            active={tool === "space"}
            icon={UnfoldVertical}
            label="Space"
            title="Create space: drag down at a line to open room for notes and ink"
            tool="space"
            onSelect={selectTool}
          />

          {showMarkupStyle ? (
            <div className="annotation-style-group">
              <IconChoiceGroup
                choices={MARKUP_CHOICES}
                label="Markup style"
                value={shownMarkupStyle}
                onChange={chooseMarkupStyle}
              />
              <SwatchPicker
                colors={markupPalette(shownMarkupStyle)}
                label={shownMarkupStyle === "highlight" ? "Highlight color" : "Markup color"}
                value={selectedHighlight?.color ?? markupInk}
                onChange={applyMarkupColor}
              />
            </div>
          ) : null}

          {showTextStyle ? (
            <TextAnnotationStyleControls
              color={textStyleValues.color}
              fontFamily={textStyleValues.fontFamily}
              fontSize={fontSize}
              onColorChange={updateTextColor}
              onFontFamilyChange={updateFontFamily}
              onFontSizeChange={updateFontSize}
            />
          ) : null}

          {showDrawingStyle ? (
            <div className="annotation-style-group">
              {tool === "shape" || selectedDrawing?.type === "shape" ? (
                <IconChoiceGroup
                  choices={SHAPE_CHOICES}
                  label="Shape"
                  value={shownShapeKind}
                  onChange={chooseShapeKind}
                />
              ) : null}
              <SwatchPicker
                colors={PDF_INK_COLORS}
                label="Ink color"
                value={drawingStyleValues.color}
                onChange={applyInkColor}
              />
              <StrokeWidthPicker
                color={drawingStyleValues.color}
                value={drawingStyleValues.strokeWidth}
                onChange={applyStrokeWidth}
              />
            </div>
          ) : null}

          <div className="annotation-style-group">
            <button
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-input hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
              aria-label="Undo"
              title="Undo (Ctrl/Cmd+Z)"
              disabled={!history.undo.length}
              onClick={() => stepHistory("undo")}
            >
              <Undo2 aria-hidden className="h-4 w-4" />
            </button>
            <button
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-input hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
              aria-label="Redo"
              title="Redo (Ctrl/Cmd+Shift+Z)"
              disabled={!history.redo.length}
              onClick={() => stepHistory("redo")}
            >
              <Redo2 aria-hidden className="h-4 w-4" />
            </button>
            <button
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-destructive/40 text-destructive hover:bg-destructive-muted disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
              aria-label="Delete selected annotation"
              title="Delete selected annotation"
              disabled={!activeSelectedAnnotationId}
              onClick={deleteSelectedAnnotation}
            >
              <Trash2 aria-hidden className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button type="button" aria-label={openCommentCount ? `Comments, ${openCommentCount} open` : "Comments"} title="Comments: select text and choose Add comment"
            className="relative inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg border border-input px-1.5 hover:bg-muted"
            onClick={() => review?.showComments()}>
            <MessageSquare aria-hidden className="h-4 w-4" />
            {openCommentCount ? <span className="text-xs tabular-nums">{openCommentCount}</span> : null}
          </button>
          <button type="button" aria-label="Find in PDF" title="Find in PDF (Ctrl/Cmd+F)"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-input hover:bg-muted"
            onClick={pdfFind.openFind}>
            <Search aria-hidden className="h-4 w-4" />
          </button>
          {markdownConversion && src ? (
            <PdfMarkdownButton
              pdfPath={filePath}
              src={src}
              pageCount={pdfDocument?.numPages ?? 0}
              mathMarkers={mathMarkers}
              conversion={markdownConversion}
              className="inline-flex h-8 min-w-8 items-center justify-center rounded-lg border border-input px-1.5 hover:bg-muted"
            />
          ) : null}
          <span className="mr-2 text-xs text-muted-foreground">
            {saveStatus === "saving"
              ? "Saving"
              : saveStatus === "saved"
                ? "Saved"
                : saveStatus === "error"
                  ? "Save failed"
                  : ""}
          </span>
          {pageLayouts.length > 0 ? (
            <span className="mr-2 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
              Page {Math.min(currentPage, pageLayouts.length)}/{pageLayouts.length}
            </span>
          ) : null}
          <button
            aria-label="Zoom out"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-input hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => changeZoom(-ZOOM_STEP)}
            title="Zoom out"
          >
            <ZoomOut aria-hidden className="h-4 w-4" />
          </button>
          <span className="min-w-14 text-center text-sm font-medium text-foreground">
            {Math.round(zoom * 100)}%
          </span>
          <button
            aria-label="Zoom in"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-input hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => changeZoom(ZOOM_STEP)}
            title="Zoom in"
          >
            <ZoomIn aria-hidden className="h-4 w-4" />
          </button>
          <button
            aria-label="Reset zoom"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-input hover:bg-muted"
            type="button"
            onClick={() => {
              applyZoom(1);
            }}
            title="Reset zoom"
          >
            <RotateCcw aria-hidden className="h-4 w-4" />
          </button>
        </div>
      </div>

      {pdfFind.bar}

      {error ? (
        <div className="border-b border-destructive/40 bg-destructive-muted px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div
        ref={scrollContainerRef}
        className="relative min-h-0 flex-1 overflow-auto px-4 py-6"
        // Zoom anchoring is handled above; native anchoring would adjust twice.
        style={{ overflowAnchor: "none" }}
        onScroll={handleScroll}
        onPointerDown={handleScrollPointerDown}
        onPointerUp={handleScrollPointerUp}
        onDragStart={handleDragStart}
      >
        {selectionMenu ? (
          <div
            className="pdf-selection-menu"
            data-pdf-annotation-ui
            role="toolbar"
            aria-label="Selection actions"
            style={{ left: selectionMenu.left, top: selectionMenu.top }}
            // Keep the text selection alive while a menu button is pressed.
            onMouseDown={(event) => event.preventDefault()}
          >
            {PDF_HIGHLIGHT_COLORS.map((color) => (
              <button
                key={color.value}
                type="button"
                className="pdf-selection-menu-swatch"
                aria-label={`Highlight ${color.label.toLowerCase()}`}
                title={`Highlight ${color.label.toLowerCase()}`}
                data-active={color.value === highlightColor || undefined}
                style={{ "--swatch": color.value } as React.CSSProperties}
                onClick={() => {
                  updateHighlightColor(color.value);
                  markSelection(color.value, "highlight");
                }}
              />
            ))}
            <span aria-hidden className="pdf-selection-menu-divider" />
            {MARKUP_CHOICES.filter((choice) => choice.value !== "highlight").map(({ icon: Icon, label, value }) => (
              <button
                key={value}
                type="button"
                className="pdf-selection-menu-action"
                aria-label={label}
                title={label}
                style={{ color: markupColor }}
                onClick={() => markSelection(markupColor, value)}
              >
                <Icon aria-hidden className="h-3.5 w-3.5" />
              </button>
            ))}
            <span aria-hidden className="pdf-selection-menu-divider" />
            <button type="button" className="pdf-selection-menu-action" aria-label="Add comment" title="Add comment (Ctrl/Cmd+Alt+M)" onClick={() => startComment()}>
              <MessageSquarePlus aria-hidden className="h-3.5 w-3.5" />
            </button>
            <button type="button" className="pdf-selection-menu-action" aria-label="Copy selection" title="Copy" onClick={copySelection}>
              <Copy aria-hidden className="h-3.5 w-3.5" />
            </button>
            <button type="button" className="pdf-selection-menu-action" aria-label="Quote and cite" title="Quote and cite in the note" onClick={quoteSelection}>
              <Quote aria-hidden className="h-3.5 w-3.5" />
            </button>
            <button type="button" className="pdf-selection-menu-action" aria-label="Read out loud" title="Read out loud" onClick={readSelectionAloud}>
              <Volume2 aria-hidden className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}

        {commentDraft ? (
          <form
            className="pdf-comment-composer"
            data-pdf-annotation-ui
            role="dialog"
            aria-label="New comment"
            style={{ left: commentDraft.left, top: commentDraft.top, width: COMMENT_BOX_WIDTH }}
            onSubmit={(event) => {
              event.preventDefault();
              void submitComment();
            }}
          >
            {commentDraft.anchor.quote ? (
              <blockquote className="pdf-comment-composer-quote">{commentDraft.anchor.quote}</blockquote>
            ) : null}
            <textarea
              autoFocus
              aria-label="New review comment"
              className="review-textarea"
              placeholder="Comment on this passage…"
              rows={3}
              value={commentText}
              onChange={(event) => setCommentText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  cancelComment();
                } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submitComment();
                }
              }}
            />
            {comments.error && comments.busy === "" ? <p role="alert" className="text-xs text-destructive">{comments.error}</p> : null}
            <div className="flex justify-end gap-1">
              <button type="button" className="review-button" onClick={cancelComment}>Cancel</button>
              <button type="submit" className="review-button" disabled={!commentText.trim() || Boolean(comments.busy)}>
                <MessageSquarePlus aria-hidden size={14} /> Comment
              </button>
            </div>
          </form>
        ) : null}

        {loading ? (
          <div className="flex min-h-80 items-center justify-center text-sm text-foreground">
            <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />
            Loading PDF
          </div>
        ) : null}

        {!loading && pdfDocument && textContentCache && layoutStore ? (
          <div className="mx-auto flex w-max flex-col gap-5">
            {pageLayouts.map((layout) => (
              <PdfPageView
                key={`${filePath}-${layout.pageNumber}`}
                annotations={annotationsByPage.get(layout.pageNumber) ?? EMPTY_ANNOTATIONS}
                geometry={pageGeometries.get(layout.pageNumber) ?? IDENTITY_PAGE_GEOMETRY}
                noteToEdit={noteToEdit?.pageNumber === layout.pageNumber ? noteToEdit.id : ""}
                onEditRequestHandled={editRequestHandled}
                commentMarks={commentMarksByPage.get(layout.pageNumber) ?? EMPTY_COMMENT_MARKS}
                documentPath={filePath}
                drawingMode={drawingMode}
                drawingStyle={drawingStyle}
                newAnnotationFontSize={fontSize}
                pageLayout={layout}
                textContentCache={textContentCache}
                layoutStore={layoutStore}
                pdfDocument={pdfDocument}
                searchMatches={pdfFind.matchesByPage.get(layout.pageNumber) ?? EMPTY_SEARCH_MATCHES}
                activeSearchMatch={activeSearchMatch?.pageNumber === layout.pageNumber ? activeSearchMatch : undefined}
                renderActive={
                  renderWindowPages.has(layout.pageNumber) ||
                  activeSearchMatch?.pageNumber === layout.pageNumber ||
                  selectedAnnotation?.pageNumber === layout.pageNumber ||
                  (!renderWindowPages.size &&
                    layout.pageNumber <= PDF_PAGE_RENDER_FALLBACK_COUNT)
                }
                requestRenderSlot={requestRenderSlot}
                // Only the page holding the selection re-renders when it changes.
                selectedAnnotationId={
                  selectedAnnotation?.pageNumber === layout.pageNumber ? activeSelectedAnnotationId : ""
                }
                screenshotSnipping={screenshotSnipping}
                tool={tool}
                zoom={zoom}
                onAddDrawing={addDrawing}
                onAddTextAnnotation={addTextAnnotation}
                onCommitSpace={commitSpace}
                onDeleteSpace={deleteSpace}
                onPreviewSpaces={previewSpaces}
                onCancelScreenshotSnip={cancelScreenshotSnip}
                onDeleteAnnotation={deleteAnnotation}
                onEraseAnnotations={eraseAnnotations}
                onExitTextEditing={exitTextEditing}
                onPageElement={setPageElement}
                onScreenshotSnip={captureScreenshotSnip}
                onSelectAnnotation={selectAnnotation}
                onSelectComment={selectComment}
                onUpdateAnnotation={updateAnnotation}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type PdfPageContentProps = {
  annotations: PdfAnnotation[];
  /** Where things are on this page with its spaces. */
  geometry: PdfPageGeometry;
  /** A note the page should open for typing once it appears. */
  noteToEdit: string;
  onEditRequestHandled: (id: string) => void;
  commentMarks: PdfCommentMark[];
  documentPath: string;
  drawingMode: PdfDrawingMode;
  drawingStyle: NewDrawingStyle;
  newAnnotationFontSize: number;
  searchMatches: PdfSearchMatch[];
  activeSearchMatch?: PdfSearchMatch;
  pageLayout: PdfPageLayout;
  pdfDocument: PDFDocumentProxy;
  textContentCache: PdfTextContentCache;
  layoutStore: PdfLayoutStore;
  requestRenderSlot: RequestRenderSlot;
  selectedAnnotationId: string;
  screenshotSnipping: boolean;
  tool: PdfTool;
  zoom: number;
  onAddDrawing: (pageNumber: number, draft: PdfDrawingDraft) => void;
  onAddTextAnnotation: (pageNumber: number, rect: PdfAnnotationRect, space?: string) => string;
  onCommitSpace: (space: PdfSpaceAnnotation, created: boolean) => void;
  onDeleteSpace: (id: string) => void;
  onPreviewSpaces: (pageNumber: number, spaces: PdfSpaceAnnotation[] | null) => void;
  onCancelScreenshotSnip: () => void;
  onDeleteAnnotation: (id: string) => void;
  onEraseAnnotations: (ids: string[], gestureKey: string) => void;
  onExitTextEditing: () => void;
  onScreenshotSnip: (pageNumber: number, rect: PdfAnnotationRect) => Promise<void>;
  onSelectAnnotation: (annotation: PdfAnnotation) => void;
  onSelectComment: (id: string) => void;
  onUpdateAnnotation: (id: string, patch: Partial<PdfAnnotation>) => void;
};

const PdfPageView = memo(function PdfPageView({
  onPageElement,
  renderActive,
  ...contentProps
}: PdfPageContentProps & {
  renderActive: boolean;
  onPageElement: (pageNumber: number, element: HTMLElement | null) => void;
}) {
  const { annotations, pageLayout } = contentProps;
  const pageNumber = pageLayout.pageNumber;
  const setElement = useCallback(
    (element: HTMLDivElement | null) => onPageElement(pageNumber, element),
    [onPageElement, pageNumber],
  );

  return (
    <div
      ref={setElement}
      className="libera-pdf-sheet relative bg-card shadow-sm"
      data-pdf-page-number={pageNumber}
    >
      <div
        className="relative overflow-hidden bg-card"
        style={{ width: pageLayout.width, height: pageLayout.height }}
      >
        {renderActive ? (
          <PdfPageContent {...contentProps} />
        ) : (
          <PdfAnnotationScrollAnchors annotations={annotations} geometry={contentProps.geometry} pageSize={pageLayout} />
        )}
      </div>
      <div className="absolute bottom-2 right-2 rounded bg-zinc-950/75 px-2 py-1 text-xs font-medium text-white">
        {pageNumber}
      </div>
    </div>
  );
});

function PdfPageContent({
  annotations,
  geometry,
  noteToEdit,
  onEditRequestHandled,
  commentMarks,
  documentPath,
  drawingMode,
  drawingStyle,
  newAnnotationFontSize,
  searchMatches,
  activeSearchMatch,
  pageLayout,
  pdfDocument,
  textContentCache,
  layoutStore,
  requestRenderSlot,
  selectedAnnotationId,
  screenshotSnipping,
  tool,
  zoom,
  onAddDrawing,
  onAddTextAnnotation,
  onCancelScreenshotSnip,
  onCommitSpace,
  onDeleteAnnotation,
  onDeleteSpace,
  onEraseAnnotations,
  onExitTextEditing,
  onPreviewSpaces,
  onScreenshotSnip,
  onSelectAnnotation,
  onSelectComment,
  onUpdateAnnotation,
}: PdfPageContentProps) {
  const pageNumber = pageLayout.pageNumber;
  const spaced = geometry !== IDENTITY_PAGE_GEOMETRY;
  // The original page, in CSS pixels; the sheet is taller by its spaces.
  const sheetHeight = pageLayout.height / geometry.scale;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rasterHostRef = useRef<HTMLDivElement>(null);
  const detailHostRef = useRef<HTMLDivElement>(null);
  const geometryRef = useRef(geometry);
  useLayoutEffect(() => {
    geometryRef.current = geometry;
  });
  const raster = usePdfSpaceRaster({ canvasRef, hostRef: rasterHostRef, geometry });
  const { renderFinished, renderStarted } = raster;
  const pageRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [rendering, setRendering] = useState(true);
  const [searchLayer, setSearchLayer] = useState<{ textDivs: HTMLElement[]; page: PdfSearchPage; size: AnnotationSurfaceSize } | null>(null);
  const revealedSearchMatchRef = useRef<PdfSearchMatch | undefined>(undefined);

  useEffect(() => {
    if (!searchLayer) return;
    const activeElement = highlightPdfMatches(searchLayer.textDivs, searchLayer.page, searchMatches, activeSearchMatch);
    // Zoom rebuilds the text layer, so repaint its highlights without navigating
    // back to the same match after the viewer has restored its reading position.
    if (activeElement?.isConnected && activeSearchMatch !== revealedSearchMatchRef.current) {
      activeElement.scrollIntoView({ block: "center", inline: "nearest" });
      revealedSearchMatchRef.current = activeSearchMatch;
    } else if (!activeSearchMatch) {
      revealedSearchMatchRef.current = undefined;
    }
  }, [searchLayer, searchMatches, activeSearchMatch]);

  useEffect(() => {
    let active = true;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;
    let releaseRenderSlot: (() => void) | null = null;

    function releaseSlot() {
      if (!releaseRenderSlot) {
        return;
      }

      releaseRenderSlot();
      releaseRenderSlot = null;
    }

    async function renderPage() {
      const canvas = canvasRef.current;
      const textLayerElement = textLayerRef.current;

      if (!canvas || !textLayerElement) {
        return;
      }

      setRendering(true);
      releaseRenderSlot = await requestRenderSlot();
      renderStarted();

      if (!active) {
        return;
      }

      const page: PDFPageProxy = await pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({ scale: zoom });

      if (!active) {
        return;
      }

      const transform = renderCanvas(viewport, canvas);
      const canvasContext = canvas.getContext("2d");

      if (!canvasContext) {
        throw new Error("Could not create PDF page canvas.");
      }

      renderTask = page.render({
        canvasContext,
        viewport,
        transform,
      });
      // Cancellation can reject while text extraction is still pending.
      // Observe that rejection immediately; Promise.all below still handles it.
      void renderTask.promise.catch(() => undefined);

      textLayerElement.replaceChildren();
      textLayerElement.style.setProperty("--scale-factor", String(viewport.scale));
      const textContent = await textContentCache.get(page);

      if (!active) {
        return;
      }

      textLayer = new TextLayer({
        textContentSource: textContent,
        container: textLayerElement,
        viewport,
      });

      await Promise.all([renderTask.promise, textLayer.render()]);

      if (active) {
        // Copy maps selected spans back to their text items for Markdown rebuilding.
        textLayer.textDivs.forEach((div, index) => div.setAttribute(PDF_TEXT_ITEM_ATTRIBUTE, String(index)));
        renderFinished();
        layoutStore.record(page, textContent);
        setSearchLayer({ textDivs: textLayer.textDivs, page: buildPdfSearchPage(textContent), size: { width: viewport.width / zoom, height: viewport.height / zoom } });
        setRendering(false);
      }
    }

    renderPage()
      .catch((renderError: unknown) => {
        if (
          active &&
          !(renderError instanceof Error && renderError.name === "RenderingCancelledException")
        ) {
          setRendering(false);
        }
      })
      .finally(() => {
        releaseSlot();
      });

    return () => {
      active = false;
      renderTask?.cancel();
      textLayer?.cancel();
      releaseSlot();
    };
  }, [layoutStore, pageNumber, pdfDocument, renderFinished, renderStarted, requestRenderSlot, textContentCache, zoom]);

  usePdfDetailCanvas({ hostRef: detailHostRef, surfaceRef: pageRef, geometry, pdfDocument, pageNumber, scale: zoom });

  // Text spans move with the piece of the page they sit in.
  const structureKey = geometry.structureKey;
  const textWasSpacedRef = useRef(false);
  useLayoutEffect(() => {
    if (searchLayer && (structureKey || textWasSpacedRef.current)) {
      assignTextPieces(searchLayer.textDivs, geometryRef.current, searchLayer.size);
    }
    textWasSpacedRef.current = !!structureKey;
  }, [searchLayer, structureKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const textLayerElement = textLayerRef.current;

    return () => {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }

      textLayerElement?.replaceChildren();
    };
  }, []);

  const { drawings, highlights, textAnnotations, spaces } = useMemo(() => {
    const pageDrawings: PdfDrawingAnnotation[] = [];
    const pageHighlights: PdfHighlightAnnotation[] = [];
    const pageTextAnnotations: PdfTextAnnotation[] = [];
    const pageSpaces: PdfSpaceAnnotation[] = [];

    for (const annotation of annotations) {
      if (annotation.type === "highlight") {
        pageHighlights.push(annotation);
      } else if (annotation.type === "text") {
        pageTextAnnotations.push(annotation);
      } else if (isDrawingAnnotation(annotation)) {
        pageDrawings.push(annotation);
      } else if (annotation.type === "space") {
        pageSpaces.push(annotation);
      }
    }

    return {
      drawings: pageDrawings.map((annotation) => annotationToSurface(annotation, geometry)),
      highlights: pageHighlights.map((annotation) => annotationToSurface(annotation, geometry)),
      textAnnotations: pageTextAnnotations.map((annotation) => annotationToSurface(annotation, geometry)),
      spaces: pageSpaces,
    };
  }, [annotations, geometry]);
  const surfaceCommentMarks = useMemo(
    () => spaced
      ? commentMarks.map((mark) => ({ ...mark, rects: mark.rects.map((rect) => textRectToSurface(geometry, rect)) }))
      : commentMarks,
    [commentMarks, geometry, spaced],
  );
  // Layers report positions on the page as displayed; the host stores them on the original page.
  const addDrawing = useCallback((draft: PdfDrawingDraft) => {
    const shown = geometryRef.current;
    if (draft.type === "ink") {
      onAddDrawing(pageNumber, { ...draft, ...rigidPointsFromSurface(shown, draft.points) });
      return;
    }
    const { points: [from, to], space } = rigidPointsFromSurface(shown, [draft.from, draft.to]);
    onAddDrawing(pageNumber, { ...draft, from, to, ...(space ? { space } : {}) });
  }, [onAddDrawing, pageNumber]);
  const selectedHighlight = highlights.find((highlight) => highlight.id === selectedAnnotationId);
  const addTextAnnotation = useCallback((rect: PdfAnnotationRect) => {
    const placed = rigidRectFromSurface(geometryRef.current, rect);
    return onAddTextAnnotation(pageNumber, placed.rect, placed.space);
  }, [onAddTextAnnotation, pageNumber]);
  const annotationsRef = useRef(annotations);
  useLayoutEffect(() => {
    annotationsRef.current = annotations;
  });
  const updateAnnotation = useCallback((id: string, patch: Partial<PdfAnnotation>) => {
    const original = annotationsRef.current.find((annotation) => annotation.id === id);
    onUpdateAnnotation(id, original ? patchFromSurface(original, patch, geometryRef.current) : patch);
  }, [onUpdateAnnotation]);
  const placeCut = useCallback((point: { x: number; y: number }, fullWidth: boolean, snap: boolean) => {
    const mask = raster.inkMask(sheetHeight / Math.max(pageLayout.width, 1));
    // The page's stored blocks decide its columns, so its spaces always agree.
    const stored = spaces.reduce<PdfSpaceAnnotation["band"][]>(
      (bands, space) => bands.some((band) => sameBand(band, space.band)) ? bands : [...bands, space.band],
      [],
    );
    return { ...placeSpaceCut(mask, point, stored, { fullWidth, snap }), ...(mask ? { fill: mask.background } : {}) };
  }, [pageLayout.width, raster, sheetHeight, spaces]);
  const spaceContentBottom = useCallback((id: string) => {
    let bottom = 0;
    for (const annotation of annotationsRef.current) {
      if (!("space" in annotation) || annotation.space !== id) continue;
      if (annotation.type === "text") bottom = Math.max(bottom, annotation.rect.y + annotation.rect.height);
      else if (annotation.type === "ink") for (const point of annotation.points) bottom = Math.max(bottom, point.y);
      else if (annotation.type === "shape") bottom = Math.max(bottom, annotation.from.y, annotation.to.y);
    }
    return bottom;
  }, []);
  const previewSpaces = useCallback(
    (spaces: PdfSpaceAnnotation[] | null) => onPreviewSpaces(pageNumber, spaces),
    [onPreviewSpaces, pageNumber],
  );
  const captureSnip = useCallback(
    (rect: PdfAnnotationRect) => onScreenshotSnip(pageNumber, areaFromSurface(geometryRef.current, rect)),
    [onScreenshotSnip, pageNumber],
  );

  // Highlights sit under the transparent text layer so text stays selectable
  // through them; clicks are hit-tested here instead.
  function selectHighlightAtPoint(event: React.MouseEvent<HTMLDivElement>) {
    if (tool !== "select" || !pageRef.current || (!highlights.length && !surfaceCommentMarks.length)) {
      return;
    }

    const selection = window.getSelection();

    if (selection && !selection.isCollapsed) {
      return;
    }

    const bounds = pageRef.current.getBoundingClientRect();

    if (!bounds.width || !bounds.height) {
      return;
    }

    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    const slackX = 1 / bounds.width;
    const slackY = 1 / bounds.height;
    const hit = [...highlights].reverse().find((highlight) =>
      highlight.rects.some(
        (rect) =>
          x >= rect.x - slackX &&
          x <= rect.x + rect.width + slackX &&
          y >= rect.y - slackY &&
          y <= rect.y + rect.height + slackY,
      ),
    );

    if (hit) {
      onSelectAnnotation(hit);
      return;
    }

    // A commented passage opens its card in the Comments panel.
    const comment = [...surfaceCommentMarks].reverse().find((mark) =>
      mark.rects.some(
        (rect) =>
          x >= rect.x - slackX &&
          x <= rect.x + rect.width + slackX &&
          y >= rect.y - slackY &&
          y <= rect.y + rect.height + slackY,
      ),
    );

    if (comment) {
      onSelectComment(comment.id);
    }
  }

  return (
    <div
      ref={pageRef}
      className="absolute inset-0 overflow-hidden bg-card"
      data-pdf-page-content={pageNumber}
      data-pdf-spaced={spaced || undefined}
      style={pieceShiftStyle(geometry, sheetHeight)}
      onClick={selectHighlightAtPoint}
    >
      <canvas ref={canvasRef} className="absolute inset-0 z-0" />
      <div ref={detailHostRef} className="pointer-events-none absolute left-0 top-0 z-[1]" style={{ width: pageLayout.width, height: sheetHeight }} aria-hidden />
      {/* Empty without spaces; with spaces it holds the page's moved pieces, under the detail. */}
      <div ref={rasterHostRef} className="pointer-events-none absolute left-0 top-0 z-0" style={{ width: pageLayout.width, height: sheetHeight }} aria-hidden />

      <div className="pdf-highlight-layer" aria-hidden>
        {highlights.map((annotation) => (
          <PdfHighlightMarks key={annotation.id} annotation={annotation} pageSize={pageLayout} />
        ))}
      </div>

      {surfaceCommentMarks.length ? (
        <div className="pdf-comment-layer" aria-hidden>
          {surfaceCommentMarks.flatMap((mark) => mark.rects.map((rect, index) => (
            <span
              key={`${mark.id}:${index}`}
              className="pdf-comment-mark"
              data-selected={mark.selected || undefined}
              data-pdf-comment-id={mark.id}
              style={rectStyle(rect, pageLayout)}
            />
          )))}
        </div>
      ) : null}

      <div
        ref={textLayerRef}
        className="pdf-text-layer"
        style={{
          pointerEvents: (tool === "select" || tool === "highlight") && !screenshotSnipping ? "auto" : "none",
          // Spans moved below the original page must stay visible.
          overflow: spaced ? "visible" : undefined,
        }}
      />

      {spaced || tool === "space" ? <PdfSpaceLayer
        active={tool === "space" && !screenshotSnipping}
        editable={(tool === "space" || tool === "select") && !screenshotSnipping}
        geometry={geometry}
        pageNumber={pageNumber}
        pageSize={pageLayout}
        selectedId={selectedAnnotationId}
        spaces={spaces}
        defaultHeight={DEFAULT_SPACE_HEIGHT_PT * zoom / Math.max(sheetHeight, 1)}
        contentBottom={spaceContentBottom}
        placeCut={placeCut}
        onPreview={previewSpaces}
        onCommit={onCommitSpace}
        onDelete={onDeleteSpace}
        onSelect={onSelectAnnotation}
      /> : null}

      <div className="pdf-highlight-ui-layer">
        {surfaceCommentMarks.filter((mark) => mark.badge && mark.id !== DRAFT_COMMENT_ID).map((mark) => {
          const first = mark.rects[0];
          return (
            <button
              key={mark.id}
              type="button"
              className="pdf-comment-badge"
              data-pdf-annotation-ui
              data-selected={mark.selected || undefined}
              aria-label={`Comment ${mark.number}`}
              title={`Comment ${mark.number}`}
              style={{ left: Math.min(pageLayout.width - 22, (first.x + first.width) * pageLayout.width + 2), top: Math.max(0, first.y * pageLayout.height - 14) }}
              onClick={(event) => {
                event.stopPropagation();
                onSelectComment(mark.id);
              }}
            >
              <MessageSquare aria-hidden className="h-3 w-3" />
              <span>{mark.number}</span>
            </button>
          );
        })}
        {highlights.map((annotation) => (
          <PdfHighlightControl
            key={annotation.id}
            annotation={annotation}
            interactive={tool === "select"}
            pageSize={pageLayout}
            selected={selectedAnnotationId === annotation.id}
            onSelect={onSelectAnnotation}
          />
        ))}
        {selectedHighlight && tool === "select" ? (
          <PdfHighlightChip
            annotation={selectedHighlight}
            documentPath={documentPath}
            pageSize={pageLayout}
            onDelete={onDeleteAnnotation}
            onUpdate={updateAnnotation}
          />
        ) : null}
      </div>

      <PdfDrawingLayer
        annotations={drawings}
        markups={highlights}
        mode={drawingMode}
        pageSize={pageLayout}
        selectedAnnotationId={selectedAnnotationId}
        style={drawingStyle}
        zoom={zoom}
        onAdd={addDrawing}
        onErase={onEraseAnnotations}
        onSelect={onSelectAnnotation}
        onUpdate={updateAnnotation}
      />

      <TextAnnotationLayer
        annotations={textAnnotations}
        documentPath={documentPath}
        drawing={tool === "text"}
        editRequestId={noteToEdit}
        onEditRequestHandled={onEditRequestHandled}
        interactive={(tool === "select" || tool === "text" || tool === "space") && !screenshotSnipping}
        newAnnotationFontSize={newAnnotationFontSize}
        pageSize={pageLayout}
        selectedAnnotationId={selectedAnnotationId}
        textScale={zoom}
        onAddAnnotation={addTextAnnotation}
        onDeleteAnnotation={onDeleteAnnotation}
        onExitTextEditing={onExitTextEditing}
        onSelectAnnotation={onSelectAnnotation}
        onUpdateAnnotation={updateAnnotation}
      />

      <ScreenshotSnipLayer
        active={screenshotSnipping}
        pageSize={pageLayout}
        onCancel={onCancelScreenshotSnip}
        onCapture={captureSnip}
      />

      {rendering ? (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-white/60 text-xs text-muted-foreground">
          <Loader2 aria-hidden className="mr-2 h-3.5 w-3.5 animate-spin" />
          Rendering
        </div>
      ) : null}
    </div>
  );
}

function PdfAnnotationScrollAnchors({
  annotations,
  geometry,
  pageSize,
}: {
  annotations: PdfAnnotation[];
  geometry: PdfPageGeometry;
  pageSize: AnnotationSurfaceSize;
}) {
  return (
    <div className="pointer-events-none absolute inset-0">
      {annotations.map((shown) => {
        const annotation = annotationToSurface(shown, geometry);
        const rect = annotation.type === "highlight"
          ? annotation.rects[0]
          : annotation.type === "text"
            ? annotation.rect
            : isDrawingAnnotation(annotation)
              ? drawingBounds(annotation)
              : null;

        if (!rect) {
          return null;
        }

        return (
          <span
            key={annotation.id}
            aria-hidden
            className="absolute"
            data-pdf-annotation-id={annotation.id}
            style={rectStyle(rect, pageSize)}
          />
        );
      })}
    </div>
  );
}

/** Display rects for a highlight: one clean band per line run. */
function useHighlightBands(annotation: PdfHighlightAnnotation, pageSize: AnnotationSurfaceSize) {
  return useMemo(
    () => mergeHighlightRects(annotation.rects, pageSize.width, pageSize.height),
    [annotation.rects, pageSize.height, pageSize.width],
  );
}

const PdfHighlightMarks = memo(function PdfHighlightMarks({
  annotation,
  pageSize,
}: {
  annotation: PdfHighlightAnnotation;
  pageSize: AnnotationSurfaceSize;
}) {
  const bands = useHighlightBands(annotation, pageSize);

  // Opaque ink inside one multiply-blended layer: overlapping bands never
  // stack into darker patches, and the page's black glyphs stay black. Line
  // markup draws its stroke in the band's currentColor instead.
  return (
    <>
      {bands.map((rect, index) => (
        <span
          key={index}
          className="pdf-highlight-mark"
          data-markup={annotation.markup}
          data-pdf-highlight-id={annotation.id}
          style={{
            ...rectStyle(rect, pageSize),
            ...(annotation.markup ? { color: annotation.color } : { background: annotation.color }),
          }}
        />
      ))}
    </>
  );
});

const PdfHighlightControl = memo(function PdfHighlightControl({
  annotation,
  interactive,
  pageSize,
  selected,
  onSelect,
}: {
  annotation: PdfHighlightAnnotation;
  interactive: boolean;
  pageSize: AnnotationSurfaceSize;
  selected: boolean;
  onSelect: (annotation: PdfAnnotation) => void;
}) {
  const bands = useHighlightBands(annotation, pageSize);
  const first = bands[0];

  if (!first) {
    return null;
  }

  return (
    <>
      {/* Keyboard/screen-reader handle; pointer clicks are hit-tested by the page. */}
      <button
        className="pdf-highlight-hit"
        type="button"
        aria-label={`Select ${MARKUP_CHOICES.find((choice) => choice.value === markupStyleOf(annotation))?.label.toLowerCase() ?? "highlight"}`}
        aria-pressed={selected}
        data-pdf-annotation-id={annotation.id}
        data-selected={selected || undefined}
        tabIndex={interactive ? 0 : -1}
        style={rectStyle(first, pageSize)}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(annotation);
        }}
      />
      {selected
        ? bands.map((rect, index) => (
            <span
              key={index}
              aria-hidden
              className="pdf-highlight-outline"
              style={{ ...rectStyle(rect, pageSize), color: annotation.color }}
            />
          ))
        : null}
    </>
  );
});

function PdfHighlightChip({
  annotation,
  documentPath,
  pageSize,
  onDelete,
  onUpdate,
}: {
  annotation: PdfHighlightAnnotation;
  documentPath: string;
  pageSize: AnnotationSurfaceSize;
  onDelete: (id: string) => void;
  onUpdate: (id: string, patch: Partial<PdfAnnotation>) => void;
}) {
  const bands = useHighlightBands(annotation, pageSize);
  const first = bands[0];
  const last = bands.at(-1);
  const style = markupStyleOf(annotation);

  if (!first || !last) {
    return null;
  }

  const chipWidth = 376;
  const quote = annotation.quote ? normalizePdfHighlightQuote(annotation.quote) : "";
  const chipHeight = 36;
  const aboveTop = first.y * pageSize.height - chipHeight - 6;
  const top = aboveTop >= 4 ? aboveTop : (last.y + last.height) * pageSize.height + 6;
  const left = clamp(first.x * pageSize.width, 4, Math.max(4, pageSize.width - chipWidth - 4));

  return (
    <div
      className="pdf-selection-menu"
      data-pdf-annotation-ui
      role="toolbar"
      aria-label="Highlight actions"
      style={{ left, top }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {markupPalette(style).map((color) => (
        <button
          key={color.value}
          type="button"
          className="pdf-selection-menu-swatch"
          aria-label={`Change to ${color.label.toLowerCase()}`}
          title={color.label}
          data-active={color.value.toLowerCase() === annotation.color.toLowerCase() || undefined}
          style={{ "--swatch": color.value } as React.CSSProperties}
          onClick={() => onUpdate(annotation.id, { color: color.value })}
        />
      ))}
      <span aria-hidden className="pdf-selection-menu-divider" />
      {MARKUP_CHOICES.map(({ icon: Icon, label, value }) => (
        <button
          key={value}
          type="button"
          className="pdf-selection-menu-action"
          aria-label={`Change to ${label.toLowerCase()}`}
          aria-pressed={value === style}
          title={label}
          onClick={() =>
            onUpdate(
              annotation.id,
              convertMarkup(annotation, value, markupPalette(value)[0].value),
            )
          }
        >
          <Icon aria-hidden className="h-3.5 w-3.5" />
        </button>
      ))}
      <span aria-hidden className="pdf-selection-menu-divider" />
      {quote ? (
        <button
          type="button"
          className="pdf-selection-menu-action"
          aria-label="Quote and cite"
          title="Quote and cite in the note"
          onClick={() => window.dispatchEvent(new CustomEvent<PdfQuoteCiteDetail>(PDF_QUOTE_CITE_EVENT, {
            detail: { quote, path: documentPath, page: annotation.pageNumber },
          }))}
        >
          <Quote aria-hidden className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <button
        type="button"
        className="pdf-selection-menu-action"
        aria-label={style === "highlight" ? "Remove highlight" : "Remove markup"}
        title={style === "highlight" ? "Remove highlight" : "Remove markup"}
        onClick={() => onDelete(annotation.id)}
      >
        <Trash2 aria-hidden className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function groupAnnotationsByPage(
  annotations: PdfAnnotation[],
  previous: Map<number, PdfAnnotation[]>,
) {
  const next = new Map<number, PdfAnnotation[]>();

  for (const annotation of annotations) {
    const pageAnnotations = next.get(annotation.pageNumber) ?? [];
    pageAnnotations.push(annotation);
    next.set(annotation.pageNumber, pageAnnotations);
  }

  for (const [pageNumber, pageAnnotations] of next) {
    const before = previous.get(pageNumber);

    if (
      before &&
      before.length === pageAnnotations.length &&
      before.every((annotation, index) => annotation === pageAnnotations[index])
    ) {
      next.set(pageNumber, before);
    }
  }

  return next;
}

function spacesSignature(spaces: readonly PdfSpaceAnnotation[]) {
  return JSON.stringify(spaces.map((space) => [space.id, space.y, space.height, space.band, space.column, space.fill, space.createdAt]));
}

/**
 * Each page's geometry, kept as the same object while the page's spaces are
 * unchanged, so typing a note or adding a highlight does not re-render pages.
 */
function useStablePageGeometries(
  annotationsByPage: Map<number, PdfAnnotation[]>,
  draft: { pageNumber: number; spaces: PdfSpaceAnnotation[] } | null,
) {
  const [cache, setCache] = useState(() => ({
    byPage: new Map<number, { source: PdfAnnotation[]; draft: PdfSpaceAnnotation[] | undefined; signature: string; geometry: PdfPageGeometry }>(),
    groups: null as Map<number, PdfAnnotation[]> | null,
    draft: null as typeof draft,
    geometries: EMPTY_PAGE_GEOMETRIES,
  }));

  if (cache.groups === annotationsByPage && cache.draft === draft) {
    return cache.geometries;
  }

  const byPage: typeof cache.byPage = new Map();
  const pages = new Set(annotationsByPage.keys());
  if (draft) pages.add(draft.pageNumber);

  for (const pageNumber of pages) {
    const source = annotationsByPage.get(pageNumber) ?? EMPTY_ANNOTATIONS;
    const preview = draft?.pageNumber === pageNumber ? draft.spaces : undefined;
    const before = cache.byPage.get(pageNumber);
    if (before?.source === source && before.draft === preview) {
      byPage.set(pageNumber, before);
      continue;
    }
    const spaces = preview ?? source.filter((annotation): annotation is PdfSpaceAnnotation => annotation.type === "space");
    const signature = spaces.length ? spacesSignature(spaces) : "";
    byPage.set(pageNumber, { source, draft: preview, signature, geometry: before?.signature === signature ? before.geometry : pdfPageGeometry(spaces) });
  }

  const spaced = [...byPage].filter(([, entry]) => entry.geometry !== IDENTITY_PAGE_GEOMETRY);
  const unchanged = spaced.length === cache.geometries.size && spaced.every(([pageNumber, entry]) => cache.geometries.get(pageNumber) === entry.geometry);
  const geometries = unchanged ? cache.geometries : new Map(spaced.map(([pageNumber, entry]) => [pageNumber, entry.geometry]));
  setCache({ byPage, groups: annotationsByPage, draft, geometries });
  return geometries;
}

/** Page layouts, reusing each page's previous object while its size is unchanged. */
function useStablePageLayouts(layouts: PdfPageLayout[]) {
  const [cache, setCache] = useState({ source: layouts, stable: layouts });

  if (cache.source === layouts) {
    return cache.stable;
  }

  const stable = layouts.map((layout, index) => {
    const before = cache.stable[index];
    return before && before.pageNumber === layout.pageNumber && before.width === layout.width && before.height === layout.height
      ? before
      : layout;
  });
  setCache({ source: layouts, stable });
  return stable;
}

/**
 * Groups annotations by page, reusing each page's previous array when its
 * members are unchanged so memoized pages skip re-rendering.
 */
function useStablePageGroups(annotations: PdfAnnotation[]) {
  const [cache, setCache] = useState(() => ({
    groups: groupAnnotationsByPage(annotations, new Map()),
    source: annotations,
  }));

  if (cache.source === annotations) {
    return cache.groups;
  }

  const groups = groupAnnotationsByPage(annotations, cache.groups);
  setCache({ groups, source: annotations });
  return groups;
}
