"use client";

import {
  Highlighter,
  Loader2,
  MousePointer2,
  RotateCcw,
  Trash2,
  Type,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  type UIEvent as ReactUIEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { GlobalWorkerOptions, TextLayer, getDocument } from "pdfjs-dist";
import type {
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist/types/src/display/api";
import type { PageViewport } from "pdfjs-dist/types/src/display/display_utils";
import { apiRequest } from "@/components/libera/api-client";
import { dispatchPdfAnnotationsUpdated } from "@/components/libera/pdf-annotation-events";
import {
  canvasToPngBlob,
  pngFileFromBlob,
} from "@/components/libera/screenshot-capture";
import { ScreenshotSnipLayer } from "@/components/libera/screenshot-snip-layer";
import {
  DEFAULT_TEXT_ANNOTATION_FONT_SIZE,
  MAX_TEXT_ANNOTATION_FONT_SIZE,
  MIN_TEXT_ANNOTATION_FONT_SIZE,
  TextAnnotationLayer,
  clamp,
  createAnnotationId,
  normalizeRect,
  nowIso,
  rectStyle,
  type AnnotationSurfaceSize,
} from "@/components/libera/text-annotation-layer";
import type {
  PdfAnnotation,
  PdfAnnotationRect,
  PdfHighlightAnnotation,
  PdfAnnotationsPayload,
  PdfTextAnnotation,
} from "@/lib/types";
import type { PdfTabViewState } from "@/components/libera/types";

GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url,
).toString();

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;
const HIGHLIGHT_COLOR = "#fde047";
const PDF_PAGE_RENDER_ROOT_MARGIN = "1200px 0px";
const PDF_PAGE_RENDER_FALLBACK_COUNT = 2;
const PDF_PAGE_RENDER_CONCURRENCY = 2;

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

  const outputScale = window.devicePixelRatio || 1;

  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
  context.clearRect(0, 0, viewport.width, viewport.height);
}

async function readPdfBasePageLayouts(pdfDocument: PDFDocumentProxy) {
  const layouts: PdfPageLayout[] = [];

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
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
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pendingScrollRestoreRef = useRef<PdfScrollPosition | null>({
    scrollLeft: initialViewState?.scrollLeft ?? 0,
    scrollTop: initialViewState?.scrollTop ?? 0,
  });
  const pageElementRefs = useRef<Map<number, HTMLElement>>(new Map());
  const pendingScrollViewStateRef = useRef<PdfScrollPosition | null>(null);
  const scrollViewStateFrameRef = useRef<number | null>(null);
  const onViewStateChangeRef = useRef(onViewStateChange);
  const initialViewStateRef = useRef(initialViewState);
  const annotationScrollStateRef = useRef<PdfAnnotationScrollState>({
    allowInitialScroll:
      Boolean(initialViewState?.selectedAnnotationId) &&
      !hasExplicitScrollPosition(initialViewState),
    lastSelectedAnnotationId: initialViewState?.selectedAnnotationId ?? "",
  });
  const requestRenderSlot = usePdfRenderQueue(PDF_PAGE_RENDER_CONCURRENCY);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [basePageLayouts, setBasePageLayouts] = useState<PdfPageLayout[]>([]);
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
  const annotationsByPage = useMemo(() => {
    const groupedAnnotations = new Map<number, PdfAnnotation[]>();

    for (const annotation of annotations) {
      const pageAnnotations = groupedAnnotations.get(annotation.pageNumber) ?? [];
      pageAnnotations.push(annotation);
      groupedAnnotations.set(annotation.pageNumber, pageAnnotations);
    }

    return groupedAnnotations;
  }, [annotations]);

  const selectedTextAnnotation =
    selectedAnnotation?.type === "text" ? selectedAnnotation : null;

  useEffect(() => {
    onViewStateChangeRef.current = onViewStateChange;
  }, [onViewStateChange]);

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

  const flushPendingScrollViewState = useCallback(() => {
    if (scrollViewStateFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollViewStateFrameRef.current);
      scrollViewStateFrameRef.current = null;
    }

    if (!pendingScrollViewStateRef.current) {
      return;
    }

    updateViewState(pendingScrollViewStateRef.current);
    pendingScrollViewStateRef.current = null;
  }, [updateViewState]);

  const handleScroll = useCallback(
    (event: ReactUIEvent<HTMLDivElement>) => {
      pendingScrollViewStateRef.current = {
        scrollLeft: event.currentTarget.scrollLeft,
        scrollTop: event.currentTarget.scrollTop,
      };

      if (scrollViewStateFrameRef.current !== null) {
        return;
      }

      scrollViewStateFrameRef.current = window.requestAnimationFrame(() => {
        scrollViewStateFrameRef.current = null;

        if (!pendingScrollViewStateRef.current) {
          return;
        }

        updateViewState(pendingScrollViewStateRef.current);
        pendingScrollViewStateRef.current = null;
      });
    },
    [updateViewState],
  );

  useEffect(() => {
    let active = true;
    let loadedDocument: PDFDocumentProxy | null = null;

    async function loadPdf() {
      if (!src) {
        setError("PDF preview is unavailable.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");
      setPdfDocument(null);
      setBasePageLayouts([]);
      setRenderWindowPages(new Set());
      pageElementRefs.current.clear();
      const restoreViewState = initialViewStateRef.current;
      pendingScrollRestoreRef.current = {
        scrollLeft: restoreViewState?.scrollLeft ?? 0,
        scrollTop: restoreViewState?.scrollTop ?? 0,
      };

      try {
        const [pdfResponse, annotationsPayload] = await Promise.all([
          fetch(src).then(async (response) => {
            if (!response.ok) {
              throw new Error("Could not load PDF file.");
            }

            return response.arrayBuffer();
          }),
          apiRequest<PdfAnnotationsPayload>(
            `/api/pdf-annotations?path=${encodeURIComponent(filePath)}`,
          ),
        ]);
        const loadingTask = getDocument({ data: new Uint8Array(pdfResponse) });
        loadedDocument = await loadingTask.promise;
        const loadedPageLayouts = await readPdfBasePageLayouts(loadedDocument);

        if (!active) {
          await loadedDocument.destroy();
          return;
        }

        setPdfDocument(loadedDocument);
        setBasePageLayouts(loadedPageLayouts);
        latestAnnotationsRef.current = annotationsPayload.annotations;
        setAnnotations(annotationsPayload.annotations);
      } catch (loadError) {
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
      setPdfDocument(null);
      loadedDocument?.destroy();

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
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [loading, pageLayouts.length, pdfDocument]);

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

  const saveAnnotations = useCallback(
    (nextAnnotations: PdfAnnotation[]) => {
      latestAnnotationsRef.current = nextAnnotations;
      setAnnotations(nextAnnotations);
      dispatchPdfAnnotationsUpdated({ path: filePath, annotations: nextAnnotations });
      setSaveStatus("saving");

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
            latestAnnotationsRef.current = payload.annotations;
            setAnnotations(payload.annotations);
            dispatchPdfAnnotationsUpdated({
              path: filePath,
              annotations: payload.annotations,
            });
            setSaveStatus("saved");
          })
          .catch((saveError) => {
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

  function changeZoom(delta: number) {
    const nextZoom = clamp(zoom + delta, MIN_ZOOM, MAX_ZOOM);

    if (nextZoom === zoom) {
      return;
    }

    setZoom(nextZoom);
    updateViewState({ zoom: nextZoom });
  }

  async function captureScreenshotSnip(pageNumber: number, rect: PdfAnnotationRect) {
    if (!pdfDocument || !onCompleteScreenshotSnip) {
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

      await onCompleteScreenshotSnip(
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
  }

  function selectAnnotation(annotation: PdfAnnotation) {
    setSelectedAnnotationId(annotation.id);
    updateViewState({ selectedAnnotationId: annotation.id });

    if (annotation.type === "text") {
      setFontSize(annotation.fontSize);
      updateViewState({ fontSize: annotation.fontSize });
    }
  }

  function addHighlight(pageNumber: number, rects: PdfAnnotationRect[]) {
    const timestamp = nowIso();

    saveAnnotations([
      ...annotations,
      {
        id: createAnnotationId(),
        type: "highlight",
        pageNumber,
        color: HIGHLIGHT_COLOR,
        rects,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]);
  }

  function addTextAnnotation(pageNumber: number, rect: PdfAnnotationRect) {
    const timestamp = nowIso();
    const annotation: PdfTextAnnotation = {
      id: createAnnotationId(),
      type: "text",
      pageNumber,
      text: "",
      fontSize,
      rect,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    setSelectedAnnotationId(annotation.id);
    updateViewState({ selectedAnnotationId: annotation.id });
    saveAnnotations([...annotations, annotation]);
  }

  function updateTextAnnotation(id: string, patch: Partial<PdfTextAnnotation>) {
    saveAnnotations(
      annotations.map((annotation) =>
        annotation.id === id && annotation.type === "text"
          ? {
              ...annotation,
              ...patch,
              updatedAt: nowIso(),
            }
          : annotation,
      ),
    );
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

  const deleteSelectedAnnotation = useCallback(() => {
    if (!activeSelectedAnnotationId) {
      return;
    }

    saveAnnotations(
      annotations.filter((annotation) => annotation.id !== activeSelectedAnnotationId),
    );
    setSelectedAnnotationId("");
    updateViewState({ selectedAnnotationId: "" });
  }, [activeSelectedAnnotationId, annotations, saveAnnotations, updateViewState]);

  useEffect(() => {
    function handleDeleteKey(event: KeyboardEvent) {
      if (
        !activeSelectedAnnotationId ||
        (event.key !== "Delete" && event.key !== "Backspace")
      ) {
        return;
      }

      const activeElement = document.activeElement;

      if (
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement
      ) {
        return;
      }

      event.preventDefault();
      deleteSelectedAnnotation();
    }

    window.addEventListener("keydown", handleDeleteKey);
    return () => window.removeEventListener("keydown", handleDeleteKey);
  }, [activeSelectedAnnotationId, deleteSelectedAnnotation]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-muted">
      <div className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-input bg-card px-4 py-2 shadow-sm">
        <div className="flex min-w-0 items-center gap-1">
          <button
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-sm font-medium ${
              tool === "select"
                ? "border-foreground bg-primary text-primary-foreground"
                : "border-input hover:bg-muted"
            }`}
            type="button"
            onClick={() => {
              setTool("select");
              updateViewState({ tool: "select" });
            }}
          >
            <MousePointer2 aria-hidden className="h-4 w-4" />
            Select
          </button>
          <button
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-sm font-medium ${
              tool === "highlight"
                ? "border-yellow-500 bg-yellow-100 text-yellow-950"
                : "border-input hover:bg-muted"
            }`}
            type="button"
            onClick={() => {
              setTool("highlight");
              updateViewState({ tool: "highlight" });
            }}
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
            onClick={() => {
              setTool("text");
              updateViewState({ tool: "text" });
            }}
          >
            <Type aria-hidden className="h-4 w-4" />
            Text
          </button>
          <label className="ml-2 inline-flex h-8 items-center gap-2 rounded-lg border border-input px-2 text-sm">
            Size
            <input
              className="w-14 border-0 bg-transparent text-sm outline-none"
              min={MIN_TEXT_ANNOTATION_FONT_SIZE}
              max={MAX_TEXT_ANNOTATION_FONT_SIZE}
              type="number"
              value={fontSize}
              onChange={(event) => updateFontSize(Number(event.target.value))}
            />
          </label>
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

        <div className="flex items-center gap-1">
          <span className="mr-2 text-xs text-muted-foreground">
            {saveStatus === "saving"
              ? "Saving"
              : saveStatus === "saved"
                ? "Saved"
                : saveStatus === "error"
                  ? "Save failed"
                  : ""}
          </span>
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
              setZoom(1);
              updateViewState({ zoom: 1 });
            }}
            title="Reset zoom"
          >
            <RotateCcw aria-hidden className="h-4 w-4" />
          </button>
        </div>
      </div>

      {error ? (
        <div className="border-b border-destructive/40 bg-destructive-muted px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div
        ref={scrollContainerRef}
        className="min-h-0 flex-1 overflow-auto px-4 py-6"
        onScroll={handleScroll}
      >
        {loading ? (
          <div className="flex min-h-80 items-center justify-center text-sm text-foreground">
            <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />
            Loading PDF
          </div>
        ) : null}

        {!loading && pdfDocument ? (
          <div className="mx-auto flex w-max flex-col gap-5">
            {pageLayouts.map((layout) => (
              <PdfPageView
                key={`${filePath}-${layout.pageNumber}`}
                annotations={annotationsByPage.get(layout.pageNumber) ?? []}
                pageLayout={layout}
                pdfDocument={pdfDocument}
                renderActive={
                  renderWindowPages.has(layout.pageNumber) ||
                  selectedAnnotation?.pageNumber === layout.pageNumber ||
                  (!renderWindowPages.size &&
                    layout.pageNumber <= PDF_PAGE_RENDER_FALLBACK_COUNT)
                }
                requestRenderSlot={requestRenderSlot}
                selectedAnnotationId={activeSelectedAnnotationId}
                screenshotSnipping={screenshotSnipping}
                tool={tool}
                zoom={zoom}
                onAddHighlight={addHighlight}
                onAddTextAnnotation={addTextAnnotation}
                onCancelScreenshotSnip={onCancelScreenshotSnip ?? (() => undefined)}
                onExitTextEditing={() => {
                  setTool("select");
                  updateViewState({ tool: "select" });
                }}
                onPageElement={setPageElement}
                onScreenshotSnip={captureScreenshotSnip}
                onSelectAnnotation={selectAnnotation}
                onUpdateTextAnnotation={updateTextAnnotation}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PdfPageView({
  annotations,
  pageLayout,
  pdfDocument,
  renderActive,
  requestRenderSlot,
  selectedAnnotationId,
  screenshotSnipping,
  tool,
  zoom,
  onAddHighlight,
  onAddTextAnnotation,
  onCancelScreenshotSnip,
  onExitTextEditing,
  onPageElement,
  onScreenshotSnip,
  onSelectAnnotation,
  onUpdateTextAnnotation,
}: {
  annotations: PdfAnnotation[];
  pageLayout: PdfPageLayout;
  pdfDocument: PDFDocumentProxy;
  renderActive: boolean;
  requestRenderSlot: RequestRenderSlot;
  selectedAnnotationId: string;
  screenshotSnipping: boolean;
  tool: PdfTool;
  zoom: number;
  onAddHighlight: (pageNumber: number, rects: PdfAnnotationRect[]) => void;
  onAddTextAnnotation: (pageNumber: number, rect: PdfAnnotationRect) => void;
  onCancelScreenshotSnip: () => void;
  onExitTextEditing: () => void;
  onPageElement: (pageNumber: number, element: HTMLElement | null) => void;
  onScreenshotSnip: (pageNumber: number, rect: PdfAnnotationRect) => Promise<void>;
  onSelectAnnotation: (annotation: PdfAnnotation) => void;
  onUpdateTextAnnotation: (id: string, patch: Partial<PdfTextAnnotation>) => void;
}) {
  const pageNumber = pageLayout.pageNumber;

  return (
    <div
      ref={(element) => onPageElement(pageNumber, element)}
      className="relative bg-card shadow-sm"
      data-pdf-page-number={pageNumber}
    >
      <div
        className="relative overflow-hidden bg-card"
        style={{ width: pageLayout.width, height: pageLayout.height }}
      >
        {renderActive ? (
          <PdfPageContent
            annotations={annotations}
            pageLayout={pageLayout}
            pageNumber={pageNumber}
            pdfDocument={pdfDocument}
            requestRenderSlot={requestRenderSlot}
            selectedAnnotationId={selectedAnnotationId}
            screenshotSnipping={screenshotSnipping}
            tool={tool}
            zoom={zoom}
            onAddHighlight={onAddHighlight}
            onAddTextAnnotation={onAddTextAnnotation}
            onCancelScreenshotSnip={onCancelScreenshotSnip}
            onExitTextEditing={onExitTextEditing}
            onScreenshotSnip={onScreenshotSnip}
            onSelectAnnotation={onSelectAnnotation}
            onUpdateTextAnnotation={onUpdateTextAnnotation}
          />
        ) : (
          <PdfAnnotationScrollAnchors annotations={annotations} pageSize={pageLayout} />
        )}
      </div>
      <div className="absolute bottom-2 right-2 rounded bg-zinc-950/75 px-2 py-1 text-xs font-medium text-white">
        {pageNumber}
      </div>
    </div>
  );
}

function PdfPageContent({
  annotations,
  pageLayout,
  pageNumber,
  pdfDocument,
  requestRenderSlot,
  selectedAnnotationId,
  screenshotSnipping,
  tool,
  zoom,
  onAddHighlight,
  onAddTextAnnotation,
  onCancelScreenshotSnip,
  onExitTextEditing,
  onScreenshotSnip,
  onSelectAnnotation,
  onUpdateTextAnnotation,
}: {
  annotations: PdfAnnotation[];
  pageLayout: PdfPageLayout;
  pageNumber: number;
  pdfDocument: PDFDocumentProxy;
  requestRenderSlot: RequestRenderSlot;
  selectedAnnotationId: string;
  screenshotSnipping: boolean;
  tool: PdfTool;
  zoom: number;
  onAddHighlight: (pageNumber: number, rects: PdfAnnotationRect[]) => void;
  onAddTextAnnotation: (pageNumber: number, rect: PdfAnnotationRect) => void;
  onCancelScreenshotSnip: () => void;
  onExitTextEditing: () => void;
  onScreenshotSnip: (pageNumber: number, rect: PdfAnnotationRect) => Promise<void>;
  onSelectAnnotation: (annotation: PdfAnnotation) => void;
  onUpdateTextAnnotation: (id: string, patch: Partial<PdfTextAnnotation>) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [rendering, setRendering] = useState(true);

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

      renderCanvas(viewport, canvas);
      const canvasContext = canvas.getContext("2d");

      if (!canvasContext) {
        throw new Error("Could not create PDF page canvas.");
      }

      renderTask = page.render({
        canvasContext,
        viewport,
      });

      textLayerElement.replaceChildren();
      textLayerElement.style.setProperty("--scale-factor", String(viewport.scale));
      const textContent = await page.getTextContent();

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
  }, [pageNumber, pdfDocument, requestRenderSlot, zoom]);

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

  function createHighlightFromSelection() {
    if (tool !== "highlight" || !pageRef.current) {
      return;
    }

    const selection = window.getSelection();

    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return;
    }

    const pageBounds = pageRef.current.getBoundingClientRect();
    const rects = Array.from(selection.getRangeAt(0).getClientRects())
      .map((rect) => intersectClientRect(rect, pageBounds))
      .filter((rect): rect is PdfAnnotationRect => Boolean(rect));

    if (rects.length) {
      onAddHighlight(pageNumber, rects.map(normalizeRect));
    }

    selection.removeAllRanges();
  }

  return (
    <div
      ref={pageRef}
      className="absolute inset-0 overflow-hidden bg-card"
      onMouseUp={createHighlightFromSelection}
    >
      <canvas ref={canvasRef} className="absolute inset-0 z-0" />
      <div
        ref={textLayerRef}
        className="pdf-text-layer"
        style={{ pointerEvents: tool === "highlight" ? "auto" : "none" }}
      />

      <div className="pointer-events-none absolute inset-0 z-20">
        {annotations.map((annotation) =>
          annotation.type === "highlight" ? (
            <PdfHighlightAnnotationView
              key={annotation.id}
              annotation={annotation}
              interactive={tool === "select"}
              pageSize={pageLayout}
              selected={selectedAnnotationId === annotation.id}
              onSelect={onSelectAnnotation}
            />
          ) : null,
        )}
      </div>

      <TextAnnotationLayer
        annotations={annotations.filter(
          (annotation): annotation is PdfTextAnnotation => annotation.type === "text",
        )}
        drawing={tool === "text"}
        interactive={tool === "select"}
        pageSize={pageLayout}
        selectedAnnotationId={selectedAnnotationId}
        textScale={zoom}
        onAddAnnotation={(rect) => onAddTextAnnotation(pageNumber, rect)}
        onExitTextEditing={onExitTextEditing}
        onSelectAnnotation={onSelectAnnotation}
        onUpdateAnnotation={onUpdateTextAnnotation}
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

function PdfHighlightAnnotationView({
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
  return (
    <>
      {annotation.rects.map((rect, index) => (
        <button
          key={`${annotation.id}-${index}`}
          className={`absolute border-0 p-0 ${
            interactive ? "pointer-events-auto" : "pointer-events-none"
          } ${selected ? "ring-2 ring-yellow-600" : ""}`}
          type="button"
          aria-label="Select highlight"
          data-pdf-annotation-id={annotation.id}
          style={{
            ...rectStyle(rect, pageSize),
            background: annotation.color,
            opacity: 0.38,
          }}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(annotation);
          }}
        />
      ))}
    </>
  );
}
