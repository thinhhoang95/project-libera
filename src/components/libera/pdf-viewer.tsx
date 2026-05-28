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

type PdfTool = "select" | "highlight" | "text";
type PdfScrollPosition = {
  scrollLeft: number;
  scrollTop: number;
};

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
  const laidOutPageNumbersRef = useRef<Set<number>>(new Set());
  const pendingScrollViewStateRef = useRef<PdfScrollPosition | null>(null);
  const scrollViewStateFrameRef = useRef<number | null>(null);
  const onViewStateChangeRef = useRef(onViewStateChange);
  const initialViewStateRef = useRef(initialViewState);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumbers, setPageNumbers] = useState<number[]>([]);
  const [laidOutPageCount, setLaidOutPageCount] = useState(0);
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

  const selectedAnnotation = useMemo(
    () => annotations.find((annotation) => annotation.id === selectedAnnotationId),
    [annotations, selectedAnnotationId],
  );

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

  const handlePageLayout = useCallback((pageNumber: number) => {
    if (laidOutPageNumbersRef.current.has(pageNumber)) {
      return;
    }

    laidOutPageNumbersRef.current.add(pageNumber);
    setLaidOutPageCount(laidOutPageNumbersRef.current.size);
  }, []);

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
      setPageNumbers([]);
      setLaidOutPageCount(0);
      laidOutPageNumbersRef.current.clear();
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

        if (!active) {
          await loadedDocument.destroy();
          return;
        }

        setPdfDocument(loadedDocument);
        setPageNumbers(
          Array.from({ length: loadedDocument.numPages }, (_, index) => index + 1),
        );
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

  function resetPageLayoutTracking() {
    laidOutPageNumbersRef.current.clear();
    setLaidOutPageCount(0);
  }

  useEffect(() => {
    const pendingScrollRestore = pendingScrollRestoreRef.current;

    if (
      loading ||
      !pdfDocument ||
      !pendingScrollRestore ||
      !pageNumbers.length ||
      laidOutPageCount === 0
    ) {
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
      const allPagesLaidOut = laidOutPageCount >= pageNumbers.length;
      const canRestoreHorizontal =
        pendingScrollRestore.scrollLeft === 0 ||
        maxScrollLeft >= pendingScrollRestore.scrollLeft ||
        allPagesLaidOut;
      const canRestoreVertical =
        pendingScrollRestore.scrollTop === 0 ||
        maxScrollTop >= pendingScrollRestore.scrollTop ||
        allPagesLaidOut;

      if (!canRestoreHorizontal || !canRestoreVertical) {
        return;
      }

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
  }, [laidOutPageCount, loading, pageNumbers.length, pdfDocument]);

  useEffect(() => flushPendingScrollViewState, [flushPendingScrollViewState]);

  const saveAnnotations = useCallback(
    (nextAnnotations: PdfAnnotation[]) => {
      latestAnnotationsRef.current = nextAnnotations;
      setAnnotations(nextAnnotations);
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

    resetPageLayoutTracking();
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
    if (!selectedAnnotationId) {
      return;
    }

    saveAnnotations(
      annotations.filter((annotation) => annotation.id !== selectedAnnotationId),
    );
    setSelectedAnnotationId("");
    updateViewState({ selectedAnnotationId: "" });
  }, [annotations, saveAnnotations, selectedAnnotationId, updateViewState]);

  useEffect(() => {
    function handleDeleteKey(event: KeyboardEvent) {
      if (
        !selectedAnnotationId ||
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
  }, [deleteSelectedAnnotation, selectedAnnotationId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-zinc-200">
      <div className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-300 bg-white px-4 py-2 shadow-sm">
        <div className="flex min-w-0 items-center gap-1">
          <button
            className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-sm font-medium ${
              tool === "select"
                ? "border-zinc-950 bg-zinc-950 text-white"
                : "border-zinc-300 hover:bg-zinc-50"
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
            className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-sm font-medium ${
              tool === "highlight"
                ? "border-yellow-500 bg-yellow-100 text-yellow-950"
                : "border-zinc-300 hover:bg-zinc-50"
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
            className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-sm font-medium ${
              tool === "text"
                ? "border-zinc-950 bg-zinc-950 text-white"
                : "border-zinc-300 hover:bg-zinc-50"
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
          <label className="ml-2 inline-flex h-8 items-center gap-2 rounded-md border border-zinc-300 px-2 text-sm">
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
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-red-200 text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            aria-label="Delete selected annotation"
            title="Delete selected annotation"
            disabled={!selectedAnnotationId}
            onClick={deleteSelectedAnnotation}
          >
            <Trash2 aria-hidden className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-1">
          <span className="mr-2 text-xs text-zinc-500">
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
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-300 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => changeZoom(-ZOOM_STEP)}
            title="Zoom out"
          >
            <ZoomOut aria-hidden className="h-4 w-4" />
          </button>
          <span className="min-w-14 text-center text-sm font-medium text-zinc-700">
            {Math.round(zoom * 100)}%
          </span>
          <button
            aria-label="Zoom in"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-300 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => changeZoom(ZOOM_STEP)}
            title="Zoom in"
          >
            <ZoomIn aria-hidden className="h-4 w-4" />
          </button>
          <button
            aria-label="Reset zoom"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-300 hover:bg-zinc-50"
            type="button"
            onClick={() => {
              if (zoom !== 1) {
                resetPageLayoutTracking();
              }

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
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <div
        ref={scrollContainerRef}
        className="min-h-0 flex-1 overflow-auto px-4 py-6"
        onScroll={handleScroll}
      >
        {loading ? (
          <div className="flex min-h-80 items-center justify-center text-sm text-zinc-600">
            <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />
            Loading PDF
          </div>
        ) : null}

        {!loading && pdfDocument ? (
          <div className="mx-auto flex w-max flex-col gap-5">
            {pageNumbers.map((pageNumber) => (
              <PdfPageView
                key={`${filePath}-${pageNumber}`}
                annotations={annotations.filter(
                  (annotation) => annotation.pageNumber === pageNumber,
                )}
                pageNumber={pageNumber}
                pdfDocument={pdfDocument}
                selectedAnnotationId={selectedAnnotationId}
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
                onPageLayout={handlePageLayout}
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
  pageNumber,
  pdfDocument,
  selectedAnnotationId,
  screenshotSnipping,
  tool,
  zoom,
  onAddHighlight,
  onAddTextAnnotation,
  onCancelScreenshotSnip,
  onExitTextEditing,
  onPageLayout,
  onScreenshotSnip,
  onSelectAnnotation,
  onUpdateTextAnnotation,
}: {
  annotations: PdfAnnotation[];
  pageNumber: number;
  pdfDocument: PDFDocumentProxy;
  selectedAnnotationId: string;
  screenshotSnipping: boolean;
  tool: PdfTool;
  zoom: number;
  onAddHighlight: (pageNumber: number, rects: PdfAnnotationRect[]) => void;
  onAddTextAnnotation: (pageNumber: number, rect: PdfAnnotationRect) => void;
  onCancelScreenshotSnip: () => void;
  onExitTextEditing: () => void;
  onPageLayout: (pageNumber: number) => void;
  onScreenshotSnip: (pageNumber: number, rect: PdfAnnotationRect) => Promise<void>;
  onSelectAnnotation: (annotation: PdfAnnotation) => void;
  onUpdateTextAnnotation: (id: string, patch: Partial<PdfTextAnnotation>) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<AnnotationSurfaceSize>({ width: 0, height: 0 });
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    if (size.width > 0 && size.height > 0) {
      onPageLayout(pageNumber);
    }
  }, [onPageLayout, pageNumber, size.height, size.width]);

  useEffect(() => {
    let active = true;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;

    async function renderPage() {
      const canvas = canvasRef.current;
      const textLayerElement = textLayerRef.current;

      if (!canvas || !textLayerElement) {
        return;
      }

      setRendering(true);
      const page: PDFPageProxy = await pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({ scale: zoom });

      if (!active) {
        return;
      }

      setSize({ width: viewport.width, height: viewport.height });
      renderCanvas(viewport, canvas);
      renderTask = page.render({
        canvasContext: canvas.getContext("2d") as CanvasRenderingContext2D,
        viewport,
      });

      textLayerElement.replaceChildren();
      textLayerElement.style.setProperty("--scale-factor", String(viewport.scale));
      textLayer = new TextLayer({
        textContentSource: await page.getTextContent(),
        container: textLayerElement,
        viewport,
      });

      await Promise.all([renderTask.promise, textLayer.render()]);

      if (active) {
        setRendering(false);
      }
    }

    renderPage().catch((renderError: unknown) => {
      if (active && !(renderError instanceof Error && renderError.name === "RenderingCancelledException")) {
        setRendering(false);
      }
    });

    return () => {
      active = false;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [pageNumber, pdfDocument, zoom]);

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
    <div className="relative bg-white shadow-sm">
      <div
        ref={pageRef}
        className="relative overflow-hidden bg-white"
        style={{ width: size.width, height: size.height }}
        onMouseUp={createHighlightFromSelection}
      >
        <canvas ref={canvasRef} className="absolute inset-0 z-0" />
        <div
          ref={textLayerRef}
          className="pdf-text-layer"
          style={{ pointerEvents: tool === "highlight" ? "auto" : "none" }}
        />

        <div className="pointer-events-none absolute inset-0 z-20">
          {annotations.map((annotation) => (
            annotation.type === "highlight" ? (
              <PdfHighlightAnnotationView
                key={annotation.id}
                annotation={annotation}
                interactive={tool === "select"}
                pageSize={size}
                selected={selectedAnnotationId === annotation.id}
                onSelect={onSelectAnnotation}
              />
            ) : null
          ))}
        </div>

        <TextAnnotationLayer
          annotations={annotations.filter(
            (annotation): annotation is PdfTextAnnotation => annotation.type === "text",
          )}
          drawing={tool === "text"}
          interactive={tool === "select"}
          pageSize={size}
          selectedAnnotationId={selectedAnnotationId}
          textScale={zoom}
          onAddAnnotation={(rect) => onAddTextAnnotation(pageNumber, rect)}
          onExitTextEditing={onExitTextEditing}
          onSelectAnnotation={onSelectAnnotation}
          onUpdateAnnotation={onUpdateTextAnnotation}
        />

        <ScreenshotSnipLayer
          active={screenshotSnipping}
          pageSize={size}
          onCancel={onCancelScreenshotSnip}
          onCapture={(rect) => onScreenshotSnip(pageNumber, rect)}
        />

        {rendering ? (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-white/60 text-xs text-zinc-500">
            <Loader2 aria-hidden className="mr-2 h-3.5 w-3.5 animate-spin" />
            Rendering
          </div>
        ) : null}
      </div>
      <div className="absolute bottom-2 right-2 rounded bg-zinc-950/75 px-2 py-1 text-xs font-medium text-white">
        {pageNumber}
      </div>
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
