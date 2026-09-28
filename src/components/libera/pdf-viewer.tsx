"use client";

import { useCanvasPaneFocused } from "@/components/libera/canvas-pane-context";
import {
  Copy,
  Highlighter,
  Loader2,
  MousePointer2,
  RotateCcw,
  Search,
  Trash2,
  Type,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  type UIEvent as ReactUIEvent,
  memo,
  useCallback,
  useEffect,
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
import { usePdfFind } from "@/components/libera/use-pdf-find";
import { buildPdfSearchPage, highlightPdfMatches, type PdfSearchMatch, type PdfSearchPage } from "@/components/libera/pdf-find";
import { apiRequest } from "@/components/libera/api-client";
import { dispatchPdfAnnotationsUpdated } from "@/components/libera/pdf-annotation-events";
import { broadcastSavedAnnotations, useAnnotationSync } from "@/components/libera/annotation-sync";
import {
  canvasToPngBlob,
  pngFileFromBlob,
} from "@/components/libera/screenshot-capture";
import { ScreenshotSnipLayer } from "@/components/libera/screenshot-snip-layer";
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
  SwatchPicker,
  TextAnnotationStyleControls,
} from "@/components/libera/annotation-style-controls";
import {
  DEFAULT_PDF_HIGHLIGHT_COLOR,
  DEFAULT_PDF_TEXT_COLOR,
  DEFAULT_PDF_TEXT_FONT,
  PDF_HIGHLIGHT_COLORS,
  isHexColor,
  mergeHighlightRects,
  rangeTextClientRects,
} from "@/lib/pdf-annotation-style";
import { pdfHighlightQuote } from "@/lib/pdf-highlight-quote";
import type {
  PdfAnnotation,
  PdfAnnotationRect,
  PdfHighlightAnnotation,
  PdfAnnotationsPayload,
  PdfTextAnnotation,
  PdfTextAnnotationFont,
} from "@/lib/types";
import type { PdfTabViewState } from "@/components/libera/types";

GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url,
).toString();

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;
const PDF_PAGE_RENDER_ROOT_MARGIN = "1200px 0px";
const PDF_PAGE_RENDER_FALLBACK_COUNT = 2;
const PDF_PAGE_RENDER_CONCURRENCY = 2;
const PDF_SCROLL_STATE_INTERVAL_MS = 150;
const EMPTY_ANNOTATIONS: PdfAnnotation[] = [];
const EMPTY_SEARCH_MATCHES: PdfSearchMatch[] = [];

type PdfTool = "select" | "highlight" | "text";
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
type AnnotationUpdater = (annotations: PdfAnnotation[]) => PdfAnnotation[];

type PdfViewerProps = {
  filePath: string;
  initialViewState?: PdfTabViewState;
  screenshotSnipping?: boolean;
  src?: string;
  onCancelScreenshotSnip?: () => void;
  onCompleteScreenshotSnip?: (file: File) => Promise<void>;
  onViewStateChange?: (viewState: PdfTabViewState) => void;
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
}: PdfViewerProps) {
  const paneFocused = useCanvasPaneFocused();
  const viewerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pendingScrollRestoreRef = useRef<PdfScrollPosition | null>({
    scrollLeft: initialViewState?.scrollLeft ?? 0,
    scrollTop: initialViewState?.scrollTop ?? 0,
  });
  const pageElementRefs = useRef<Map<number, HTMLElement>>(new Map());
  const pendingScrollViewStateRef = useRef<PdfScrollPosition | null>(null);
  const scrollViewStateTimeoutRef = useRef<number | null>(null);
  const onViewStateChangeRef = useRef(onViewStateChange);
  const screenshotCallbacksRef = useRef({ onCancelScreenshotSnip, onCompleteScreenshotSnip });
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
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenuPosition | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestAnnotationsRef = useRef<PdfAnnotation[]>([]);
  const viewStateSelectedAnnotationId = initialViewState?.selectedAnnotationId;
  const activeSelectedAnnotationId =
    typeof viewStateSelectedAnnotationId === "string"
      ? viewStateSelectedAnnotationId
      : selectedAnnotationId;
  const activeSelectedAnnotationIdRef = useRef(activeSelectedAnnotationId);
  useEffect(() => {
    activeSelectedAnnotationIdRef.current = activeSelectedAnnotationId;
  }, [activeSelectedAnnotationId]);
  const pageLayouts = useMemo(
    () =>
      basePageLayouts.map((layout) => ({
        ...layout,
        height: layout.height * zoom,
        width: layout.width * zoom,
      })),
    [basePageLayouts, zoom],
  );

  const selectedAnnotation = useMemo(
    () => annotations.find((annotation) => annotation.id === activeSelectedAnnotationId),
    [activeSelectedAnnotationId, annotations],
  );
  const annotationsByPage = useStablePageGroups(annotations);

  const selectedTextAnnotation =
    selectedAnnotation?.type === "text" ? selectedAnnotation : null;
  const selectedHighlight =
    selectedAnnotation?.type === "highlight" ? selectedAnnotation : null;

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
        setAnnotations(annotationsPayload.annotations);
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

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [filePath, src]);

  useEffect(() => {
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

  useEffect(() => flushPendingScrollViewState, [flushPendingScrollViewState]);

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
  useAnnotationSync<PdfAnnotation>("pdf", filePath, (remoteAnnotations) => {
    if (localSavePendingRef.current) {
      return;
    }

    latestAnnotationsRef.current = remoteAnnotations;
    setAnnotations(remoteAnnotations);
    dispatchPdfAnnotationsUpdated({ path: filePath, annotations: remoteAnnotations });
  });

  const saveAnnotations = useCallback(
    (nextAnnotations: PdfAnnotation[]) => {
      latestAnnotationsRef.current = nextAnnotations;
      setAnnotations(nextAnnotations);
      dispatchPdfAnnotationsUpdated({ path: filePath, annotations: nextAnnotations });
      setSaveStatus("saving");
      localSavePendingRef.current = true;

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      saveTimeoutRef.current = setTimeout(() => {
        apiRequest<PdfAnnotationsPayload>("/api/pdf-annotations", {
          method: "PATCH",
          body: JSON.stringify({
            path: filePath,
            annotations: latestAnnotationsRef.current,
          }),
        })
          .then((payload) => {
            localSavePendingRef.current = false;
            latestAnnotationsRef.current = payload.annotations;
            setAnnotations(payload.annotations);
            dispatchPdfAnnotationsUpdated({
              path: filePath,
              annotations: payload.annotations,
            });
            setSaveStatus("saved");
            broadcastSavedAnnotations("pdf", filePath, payload.annotations);
          })
          .catch((saveError) => {
            localSavePendingRef.current = false;
            setSaveStatus("error");
            setError(
              saveError instanceof Error
                ? saveError.message
                : "Could not save PDF annotations.",
            );
          });
      }, 350);
    },
    [filePath],
  );

  function applyZoom(nextValue: number) {
    const nextZoom = clamp(nextValue, MIN_ZOOM, MAX_ZOOM);
    if (nextZoom === zoom) return;
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
      const renderScale = Math.max(1, window.devicePixelRatio || 1);
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
  const commitAnnotations = useCallback((updater: AnnotationUpdater) => {
    const current = latestAnnotationsRef.current;
    const next = updater(current);

    if (next !== current) {
      saveAnnotations(next);
    }
  }, [saveAnnotations]);

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
    });
  }, [commitAnnotations]);

  const deleteAnnotation = useCallback((id: string) => {
    commitAnnotations((current) => {
      const next = current.filter((annotation) => annotation.id !== id);

      return next.length === current.length ? current : next;
    });

    if (activeSelectedAnnotationIdRef.current === id) {
      selectAnnotationId("");
    }
  }, [commitAnnotations, selectAnnotationId]);

  /** Highlights the current text selection, split across every page it spans. */
  const highlightSelection = useCallback((color: string) => {
    const selection = window.getSelection();
    const viewer = viewerRef.current;

    if (!selection || selection.isCollapsed || !selection.rangeCount || !viewer) {
      return false;
    }

    const range = selection.getRangeAt(0);

    if (!viewer.contains(range.commonAncestorContainer)) {
      return false;
    }

    const clientRects = rangeTextClientRects(range, ".pdf-text-layer");
    const timestamp = nowIso();
    const created: PdfHighlightAnnotation[] = [];

    for (const page of viewer.querySelectorAll<HTMLElement>("[data-pdf-page-content]")) {
      const bounds = page.getBoundingClientRect();
      const rects = clientRects
        .map((rect) => intersectClientRect(rect, bounds))
        .filter((rect): rect is PdfAnnotationRect => Boolean(rect));

      if (rects.length) {
        const textLayer = page.querySelector(".pdf-text-layer");
        created.push({
          id: createAnnotationId(),
          type: "highlight",
          pageNumber: Number(page.dataset.pdfPageContent),
          color,
          rects: mergeHighlightRects(rects, bounds.width, bounds.height).map(normalizeRect),
          quote: textLayer ? pdfHighlightQuote(range, textLayer) : undefined,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
    }

    selection.removeAllRanges();
    setSelectionMenu(null);

    if (!created.length) {
      return false;
    }

    commitAnnotations((current) => [...current, ...created]);
    return true;
  }, [commitAnnotations]);

  const newTextStyleRef = useRef({ color: textColor, fontFamily, fontSize });
  useEffect(() => {
    newTextStyleRef.current = { color: textColor, fontFamily, fontSize };
  }, [fontFamily, fontSize, textColor]);

  const addTextAnnotation = useCallback((pageNumber: number, rect: PdfAnnotationRect) => {
    const timestamp = nowIso();
    const style = newTextStyleRef.current;
    const annotation: PdfTextAnnotation = {
      id: createAnnotationId(),
      type: "text",
      pageNumber,
      text: "",
      fontSize: style.fontSize,
      color: style.color,
      fontFamily: style.fontFamily,
      rect,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    selectAnnotationId(annotation.id);
    commitAnnotations((current) => [...current, annotation]);
    return annotation.id;
  }, [commitAnnotations, selectAnnotationId]);

  const updateTextAnnotation = useCallback(
    (id: string, patch: Partial<PdfTextAnnotation>) => updateAnnotation(id, patch),
    [updateAnnotation],
  );

  const exitTextEditing = useCallback(() => {
    setTool("select");
    updateViewState({ tool: "select" });
  }, [updateViewState]);

  function selectTool(nextTool: PdfTool) {
    setTool(nextTool);
    updateViewState({ tool: nextTool });
    setSelectionMenu(null);

    // Choosing Highlight with text already selected highlights it right away.
    if (nextTool === "highlight") {
      highlightSelection(highlightColor);
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

  function applyHighlightColor(nextColor: string) {
    updateHighlightColor(nextColor);

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
  }, [activeSelectedAnnotationId, clearSelection, deleteSelectedAnnotation, paneFocused, selectionMenu]);

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
      highlightSelection(highlightColor);
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

      const rects = rangeTextClientRects(range, ".pdf-text-layer");

      if (!rects.length) {
        return;
      }

      const bounds = scrollContainer.getBoundingClientRect();
      const first = rects.reduce((top, rect) => (rect.top < top.top ? rect : top));
      const last = rects.reduce((bottom, rect) => (rect.bottom > bottom.bottom ? rect : bottom));
      const menuHeight = 40;
      const above = first.top - bounds.top - menuHeight - 6;
      const top = above >= 0 ? above : last.bottom - bounds.top + 6;

      setSelectionMenu({
        left: clamp(
          first.left - bounds.left + scrollContainer.scrollLeft,
          8,
          Math.max(8, scrollContainer.scrollWidth - 280),
        ),
        top: top + scrollContainer.scrollTop,
      });
    });
  }

  function copySelection() {
    const text = window.getSelection()?.toString() ?? "";

    if (text) {
      void navigator.clipboard?.writeText(text).catch(() => undefined);
    }

    setSelectionMenu(null);
  }

  const showHighlightStyle = tool === "highlight" || Boolean(selectedHighlight);
  const showTextStyle = tool === "text" || Boolean(selectedTextAnnotation);
  const textStyleValues = selectedTextAnnotation
    ? {
        color: selectedTextAnnotation.color ?? DEFAULT_PDF_TEXT_COLOR,
        fontFamily: selectedTextAnnotation.fontFamily ?? DEFAULT_PDF_TEXT_FONT,
      }
    : { color: textColor, fontFamily };

  return (
    <div ref={viewerRef} tabIndex={-1} data-pdf-path={filePath} data-pdf-tool={tool} className="libera-media-viewer libera-pdf-viewer flex min-h-0 flex-1 flex-col overflow-hidden bg-muted outline-none"
      style={{ "--pdf-highlight-color": highlightColor } as React.CSSProperties}
      onPointerDown={(event) => {
        if (!(event.target as HTMLElement).closest("button, input, textarea, select, a, [contenteditable]")) {
          event.currentTarget.focus({ preventScroll: true });
        }
      }}>
      <div className="libera-viewer-toolbar sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-input bg-card px-4 py-2">
        {/* Contextual style controls scroll sideways instead of wrapping, so
            selecting an annotation never shifts the page under the pointer. */}
        <div className="libera-annotation-toolbar flex min-w-0 flex-1 items-center gap-1" data-pdf-annotation-ui onMouseDown={keepEditorFocus}>
          <button
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-sm font-medium ${
              tool === "select"
                ? "border-foreground bg-primary text-primary-foreground"
                : "border-input hover:bg-muted"
            }`}
            type="button"
            aria-pressed={tool === "select"}
            data-viewer-tool="select"
            title="Select (V)"
            onClick={() => selectTool("select")}
          >
            <MousePointer2 aria-hidden className="h-4 w-4" />
            Select
          </button>
          <button
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-sm font-medium ${
              tool === "highlight"
                ? "pdf-highlight-tool-active"
                : "border-input hover:bg-muted"
            }`}
            type="button"
            aria-pressed={tool === "highlight"}
            data-viewer-tool="highlight"
            title="Highlight: select text to mark it"
            onClick={() => selectTool("highlight")}
          >
            <Highlighter aria-hidden className="h-4 w-4" />
            Highlight
          </button>
          <button
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-sm font-medium ${
              tool === "text"
                ? "border-foreground bg-primary text-primary-foreground"
                : "border-input hover:bg-muted"
            }`}
            type="button"
            aria-pressed={tool === "text"}
            data-viewer-tool="text"
            title="Text note: click to place, or drag to draw a box"
            onClick={() => selectTool("text")}
          >
            <Type aria-hidden className="h-4 w-4" />
            Text
          </button>

          {showHighlightStyle ? (
            <div className="annotation-style-group">
              <SwatchPicker
                colors={PDF_HIGHLIGHT_COLORS}
                label="Highlight color"
                value={selectedHighlight?.color ?? highlightColor}
                onChange={applyHighlightColor}
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

        <div className="flex shrink-0 items-center gap-1">
          <button type="button" aria-label="Find in PDF" title="Find in PDF (Ctrl/Cmd+F)"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-input hover:bg-muted"
            onClick={pdfFind.openFind}>
            <Search aria-hidden className="h-4 w-4" />
          </button>
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
        onScroll={handleScroll}
        onPointerDown={handleScrollPointerDown}
        onPointerUp={handleScrollPointerUp}
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
                  highlightSelection(color.value);
                }}
              />
            ))}
            <span aria-hidden className="pdf-selection-menu-divider" />
            <button type="button" className="pdf-selection-menu-action" aria-label="Copy selection" title="Copy" onClick={copySelection}>
              <Copy aria-hidden className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}

        {loading ? (
          <div className="flex min-h-80 items-center justify-center text-sm text-foreground">
            <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />
            Loading PDF
          </div>
        ) : null}

        {!loading && pdfDocument && textContentCache ? (
          <div className="mx-auto flex w-max flex-col gap-5">
            {pageLayouts.map((layout) => (
              <PdfPageView
                key={`${filePath}-${layout.pageNumber}`}
                annotations={annotationsByPage.get(layout.pageNumber) ?? EMPTY_ANNOTATIONS}
                documentPath={filePath}
                newAnnotationFontSize={fontSize}
                pageLayout={layout}
                textContentCache={textContentCache}
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
                onAddTextAnnotation={addTextAnnotation}
                onCancelScreenshotSnip={cancelScreenshotSnip}
                onDeleteAnnotation={deleteAnnotation}
                onExitTextEditing={exitTextEditing}
                onPageElement={setPageElement}
                onScreenshotSnip={captureScreenshotSnip}
                onSelectAnnotation={selectAnnotation}
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
  documentPath: string;
  newAnnotationFontSize: number;
  searchMatches: PdfSearchMatch[];
  activeSearchMatch?: PdfSearchMatch;
  pageLayout: PdfPageLayout;
  pdfDocument: PDFDocumentProxy;
  textContentCache: PdfTextContentCache;
  requestRenderSlot: RequestRenderSlot;
  selectedAnnotationId: string;
  screenshotSnipping: boolean;
  tool: PdfTool;
  zoom: number;
  onAddTextAnnotation: (pageNumber: number, rect: PdfAnnotationRect) => string;
  onCancelScreenshotSnip: () => void;
  onDeleteAnnotation: (id: string) => void;
  onExitTextEditing: () => void;
  onScreenshotSnip: (pageNumber: number, rect: PdfAnnotationRect) => Promise<void>;
  onSelectAnnotation: (annotation: PdfAnnotation) => void;
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
          <PdfAnnotationScrollAnchors annotations={annotations} pageSize={pageLayout} />
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
  documentPath,
  newAnnotationFontSize,
  searchMatches,
  activeSearchMatch,
  pageLayout,
  pdfDocument,
  textContentCache,
  requestRenderSlot,
  selectedAnnotationId,
  screenshotSnipping,
  tool,
  zoom,
  onAddTextAnnotation,
  onCancelScreenshotSnip,
  onDeleteAnnotation,
  onExitTextEditing,
  onScreenshotSnip,
  onSelectAnnotation,
  onUpdateAnnotation,
}: PdfPageContentProps) {
  const pageNumber = pageLayout.pageNumber;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [rendering, setRendering] = useState(true);
  const [searchLayer, setSearchLayer] = useState<{ textDivs: HTMLElement[]; page: PdfSearchPage } | null>(null);

  useEffect(() => {
    if (!searchLayer) return;
    const activeElement = highlightPdfMatches(searchLayer.textDivs, searchLayer.page, searchMatches, activeSearchMatch);
    activeElement?.scrollIntoView({ block: "center", inline: "nearest" });
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
        setSearchLayer({ textDivs: textLayer.textDivs, page: buildPdfSearchPage(textContent) });
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
  }, [pageNumber, pdfDocument, requestRenderSlot, textContentCache, zoom]);

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

  const { highlights, textAnnotations } = useMemo(() => {
    const pageHighlights: PdfHighlightAnnotation[] = [];
    const pageTextAnnotations: PdfTextAnnotation[] = [];

    for (const annotation of annotations) {
      if (annotation.type === "highlight") {
        pageHighlights.push(annotation);
      } else {
        pageTextAnnotations.push(annotation);
      }
    }

    return { highlights: pageHighlights, textAnnotations: pageTextAnnotations };
  }, [annotations]);
  const selectedHighlight = highlights.find((highlight) => highlight.id === selectedAnnotationId);
  const addTextAnnotation = useCallback(
    (rect: PdfAnnotationRect) => onAddTextAnnotation(pageNumber, rect),
    [onAddTextAnnotation, pageNumber],
  );

  // Highlights sit under the transparent text layer so text stays selectable
  // through them; clicks are hit-tested here instead.
  function selectHighlightAtPoint(event: React.MouseEvent<HTMLDivElement>) {
    if (tool !== "select" || !pageRef.current || !highlights.length) {
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
    }
  }

  return (
    <div
      ref={pageRef}
      className="absolute inset-0 overflow-hidden bg-card"
      data-pdf-page-content={pageNumber}
      onClick={selectHighlightAtPoint}
    >
      <canvas ref={canvasRef} className="absolute inset-0 z-0" />

      <div className="pdf-highlight-layer" aria-hidden>
        {highlights.map((annotation) => (
          <PdfHighlightMarks key={annotation.id} annotation={annotation} pageSize={pageLayout} />
        ))}
      </div>

      <div
        ref={textLayerRef}
        className="pdf-text-layer"
        style={{ pointerEvents: tool !== "text" && !screenshotSnipping ? "auto" : "none" }}
      />

      <div className="pdf-highlight-ui-layer">
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
            pageSize={pageLayout}
            onDelete={onDeleteAnnotation}
            onUpdate={onUpdateAnnotation}
          />
        ) : null}
      </div>

      <TextAnnotationLayer
        annotations={textAnnotations}
        documentPath={documentPath}
        drawing={tool === "text"}
        interactive={tool !== "highlight" && !screenshotSnipping}
        newAnnotationFontSize={newAnnotationFontSize}
        pageSize={pageLayout}
        selectedAnnotationId={selectedAnnotationId}
        textScale={zoom}
        onAddAnnotation={addTextAnnotation}
        onDeleteAnnotation={onDeleteAnnotation}
        onExitTextEditing={onExitTextEditing}
        onSelectAnnotation={onSelectAnnotation}
        onUpdateAnnotation={onUpdateAnnotation}
      />

      <ScreenshotSnipLayer
        active={screenshotSnipping}
        pageSize={pageLayout}
        onCancel={onCancelScreenshotSnip}
        onCapture={(rect) => onScreenshotSnip(pageNumber, rect)}
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
  pageSize,
}: {
  annotations: PdfAnnotation[];
  pageSize: AnnotationSurfaceSize;
}) {
  return (
    <div className="pointer-events-none absolute inset-0">
      {annotations.map((annotation) => {
        const rect = annotation.type === "highlight" ? annotation.rects[0] : annotation.rect;

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
  // stack into darker patches, and the page's black glyphs stay black.
  return (
    <>
      {bands.map((rect, index) => (
        <span
          key={index}
          className="pdf-highlight-mark"
          data-pdf-highlight-id={annotation.id}
          style={{ ...rectStyle(rect, pageSize), background: annotation.color }}
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
        aria-label="Select highlight"
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
  pageSize,
  onDelete,
  onUpdate,
}: {
  annotation: PdfHighlightAnnotation;
  pageSize: AnnotationSurfaceSize;
  onDelete: (id: string) => void;
  onUpdate: (id: string, patch: Partial<PdfAnnotation>) => void;
}) {
  const bands = useHighlightBands(annotation, pageSize);
  const first = bands[0];
  const last = bands.at(-1);

  if (!first || !last) {
    return null;
  }

  const chipWidth = 232;
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
      {PDF_HIGHLIGHT_COLORS.map((color) => (
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
      <button
        type="button"
        className="pdf-selection-menu-action"
        aria-label="Remove highlight"
        title="Remove highlight"
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
