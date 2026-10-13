"use client";

import { GlobalWorkerOptions, TextLayer, getDocument } from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist/types/src/display/api";
import { Download, Loader2, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PdfTextContentCache, pdfCanvasSize } from "@/components/libera/pdf-rendering";
import { usePdfDetailCanvas } from "@/components/libera/use-pdf-detail-canvas";
import type { SynctexPdfLocation } from "@/lib/latex/synctex";
import { textHintAt, type SynctexTextHint } from "@/lib/latex/synctex-text";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();

export type PdfZoom = number | "width";
export type PdfHighlightRequest = { locations: SynctexPdfLocation[]; nonce: number };

type PageSize = { width: number; height: number };

const PAGE_GAP = 14;
const PAGE_PADDING = 16;
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const RENDER_MARGIN = "900px 0px";

function clampScale(scale: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

async function readPageSizes(pdf: PDFDocumentProxy) {
  const sizes: PageSize[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    sizes.push({ width: viewport.width, height: viewport.height });
  }
  return sizes;
}

type LatexPdfPreviewProps = {
  url: string | null;
  zoom: PdfZoom;
  initialScrollTop?: number;
  highlight: PdfHighlightRequest | null;
  busy: boolean;
  downloadUrl: string | null;
  emptyState: ReactNode;
  onZoomChange: (zoom: PdfZoom) => void;
  onScrollChange: (scrollTop: number, scrollLeft: number) => void;
  onInverseSync: (location: { page: number; x: number; y: number; hint?: SynctexTextHint }) => void;
};

export function LatexPdfPreview({ url, zoom, initialScrollTop, highlight, busy, downloadUrl, emptyState, onZoomChange, onScrollChange, onInverseSync }: LatexPdfPreviewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<{ url: string; pdf: PDFDocumentProxy; sizes: PageSize[]; textCache: PdfTextContentCache } | null>(null);
  const [failure, setFailure] = useState<{ url: string; message: string } | null>(null);
  const pdf = loaded?.pdf ?? null;
  const sizes = useMemo(() => loaded?.sizes ?? [], [loaded]);
  const error = url && failure?.url === url ? failure.message : "";
  const loading = Boolean(url) && loaded?.url !== url && failure?.url !== url;
  const [containerWidth, setContainerWidth] = useState(0);
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set([1, 2]));
  const [currentPage, setCurrentPage] = useState(1);
  const [flash, setFlash] = useState<{ page: number; rects: SynctexPdfLocation[]; nonce: number } | null>(null);
  const restoredScrollRef = useRef(false);
  const pageElementsRef = useRef(new Map<number, HTMLDivElement>());
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load each new build, keeping the previous PDF on screen until it is ready.
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const controller = new AbortController();
    let document: PDFDocumentProxy | null = null;

    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "The PDF could not be loaded.");
        }
        const data = new Uint8Array(await response.arrayBuffer());
        document = await getDocument({ data }).promise;
        const pageSizes = await readPageSizes(document);
        if (cancelled) {
          void document.destroy();
          return;
        }
        const next = { url, pdf: document, sizes: pageSizes, textCache: new PdfTextContentCache() };
        setLoaded((previous) => {
          if (previous && previous.pdf !== next.pdf) window.setTimeout(() => void previous.pdf.destroy(), 1000);
          return next;
        });
        setFailure(null);
      } catch (loadError) {
        if (cancelled) {
          if (document) void document.destroy();
          return;
        }
        setFailure({ url, message: loadError instanceof Error ? loadError.message : "The PDF could not be loaded." });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url]);

  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  useEffect(() => { pdfRef.current = pdf; }, [pdf]);
  useEffect(() => () => { void pdfRef.current?.destroy(); }, []);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setContainerWidth(element.clientWidth));
    observer.observe(element);
    setContainerWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const maxPageWidth = sizes.reduce((max, size) => Math.max(max, size.width), 0) || 612;
  const scale = clampScale(zoom === "width" ? (containerWidth ? (containerWidth - PAGE_PADDING * 2) / maxPageWidth : 1) : zoom);

  const offsets = useMemo(() => {
    const tops: number[] = [];
    let top = PAGE_PADDING;
    for (const size of sizes) {
      tops.push(top);
      top += size.height * scale + PAGE_GAP;
    }
    return tops;
  }, [scale, sizes]);

  // Restore the saved scroll position once, when the first PDF has a layout.
  useLayoutEffect(() => {
    if (restoredScrollRef.current || !sizes.length || !containerWidth) return;
    restoredScrollRef.current = true;
    if (initialScrollTop && scrollRef.current) scrollRef.current.scrollTop = initialScrollTop;
  }, [containerWidth, initialScrollTop, sizes.length]);

  // Track which pages are near the viewport; only those keep a canvas.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !sizes.length) return;
    const observer = new IntersectionObserver((entries) => {
      setVisiblePages((current) => {
        const next = new Set(current);
        for (const entry of entries) {
          const pageNumber = Number((entry.target as HTMLElement).dataset.pageNumber);
          if (entry.isIntersecting) next.add(pageNumber);
          else next.delete(pageNumber);
        }
        return next.size === current.size && [...next].every((page) => current.has(page)) ? current : next;
      });
    }, { root, rootMargin: RENDER_MARGIN });
    for (const element of pageElementsRef.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [sizes, scale]);

  const updateCurrentPage = useCallback(() => {
    const element = scrollRef.current;
    if (!element || !offsets.length) return;
    const middle = element.scrollTop + element.clientHeight / 3;
    let page = 1;
    for (let index = 0; index < offsets.length; index++) if (offsets[index] <= middle) page = index + 1;
    setCurrentPage(page);
  }, [offsets]);

  useEffect(() => { updateCurrentPage(); }, [updateCurrentPage]);

  // Forward search: bring the box into view and flash it. Only scroll
  // vertically — the reader's horizontal position is theirs to keep.
  useEffect(() => {
    if (!highlight || !highlight.locations.length || !sizes.length) return;
    const first = highlight.locations[0];
    const element = scrollRef.current;
    const pageTop = offsets[first.page - 1];
    if (!element || pageTop === undefined) return;
    const top = pageTop + Math.max(0, first.top) * scale;
    element.scrollTo({ top: Math.max(0, top - element.clientHeight * 0.35), behavior: "smooth" });
    setFlash({ page: first.page, rects: highlight.locations.filter((location) => location.page === first.page), nonce: highlight.nonce });
    const timer = window.setTimeout(() => setFlash((current) => (current?.nonce === highlight.nonce ? null : current)), 2600);
    return () => window.clearTimeout(timer);
    // Only a new request should scroll; layout changes must not re-trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight?.nonce]);

  function handleScroll() {
    updateCurrentPage();
    const element = scrollRef.current;
    if (!element) return;
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => onScrollChange(element.scrollTop, element.scrollLeft), 200);
  }

  function zoomBy(factor: number) {
    const element = scrollRef.current;
    const next = clampScale(Math.round(scale * factor * 20) / 20);
    if (element) {
      // Keep the point at the top of the viewport in place.
      const ratio = next / scale;
      requestAnimationFrame(() => { element.scrollTop *= ratio; });
    }
    onZoomChange(next);
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
  }

  const registerPage = useCallback((pageNumber: number, element: HTMLDivElement | null) => {
    if (element) pageElementsRef.current.set(pageNumber, element);
    else pageElementsRef.current.delete(pageNumber);
  }, []);

  return (
    <div className="libera-latex-pdf flex min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-card px-2 text-xs text-muted-foreground">
        <span className="tabular-nums" aria-live="polite">{sizes.length ? `Page ${currentPage} of ${sizes.length}` : "PDF"}</span>
        {busy || loading ? <Loader2 aria-label="Updating PDF" className="ml-1 h-3.5 w-3.5 animate-spin text-accent" /> : null}
        <div className="ml-auto flex items-center gap-0.5">
          <button type="button" className="libera-latex-icon-button" aria-label="Zoom out" title="Zoom out" disabled={!sizes.length} onClick={() => zoomBy(1 / 1.15)}><ZoomOut aria-hidden className="h-4 w-4" /></button>
          <button type="button" className="min-w-12 rounded px-1 py-1 tabular-nums hover:bg-muted" title="Reset to 100%" disabled={!sizes.length} onClick={() => onZoomChange(1)}>{Math.round(scale * 100)}%</button>
          <button type="button" className="libera-latex-icon-button" aria-label="Zoom in" title="Zoom in" disabled={!sizes.length} onClick={() => zoomBy(1.15)}><ZoomIn aria-hidden className="h-4 w-4" /></button>
          <button type="button" className="libera-latex-icon-button" aria-label="Fit page width" title="Fit page width" aria-pressed={zoom === "width"} disabled={!sizes.length} onClick={() => onZoomChange("width")}><Maximize2 aria-hidden className="h-4 w-4" /></button>
          {downloadUrl ? <a className="libera-latex-icon-button" aria-label="Download PDF" title="Download PDF" href={downloadUrl} download><Download aria-hidden className="h-4 w-4" /></a> : null}
        </div>
      </div>
      <div
        ref={scrollRef}
        className="libera-latex-pdf-scroll relative min-h-0 flex-1 overflow-auto"
        // Focusable so keyboard shortcuts reach the workspace after clicking the PDF.
        tabIndex={-1}
        onScroll={handleScroll}
        onWheel={handleWheel}
      >
        {!url && !pdf ? <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">{emptyState}</div> : null}
        {error && !pdf ? <div className="m-4 rounded-lg border border-destructive/40 bg-destructive-muted p-3 text-sm text-destructive">{error}</div> : null}
        {pdf ? (
          <div className="relative mx-auto" style={{ width: Math.max(...sizes.map((size) => size.width * scale)) + PAGE_PADDING * 2, height: (offsets.at(-1) ?? 0) + (sizes.at(-1)?.height ?? 0) * scale + PAGE_PADDING }}>
            {sizes.map((size, index) => (
              <LatexPdfPage
                key={index + 1}
                pdf={pdf}
                pageNumber={index + 1}
                scale={scale}
                width={size.width * scale}
                height={size.height * scale}
                top={offsets[index]}
                active={visiblePages.has(index + 1)}
                textCache={loaded!.textCache}
                flash={flash?.page === index + 1 ? flash : null}
                registerPage={registerPage}
                onInverseSync={onInverseSync}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const LatexPdfPage = memo(function LatexPdfPage({ pdf, pageNumber, scale, width, height, top, active, textCache, flash, registerPage, onInverseSync }: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  width: number;
  height: number;
  top: number;
  active: boolean;
  textCache: PdfTextContentCache;
  flash: { rects: SynctexPdfLocation[]; nonce: number } | null;
  registerPage: (pageNumber: number, element: HTMLDivElement | null) => void;
  onInverseSync: (location: { page: number; x: number; y: number; hint?: SynctexTextHint }) => void;
}) {
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const detailHostRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    registerPage(pageNumber, pageRef.current);
    return () => registerPage(pageNumber, null);
  }, [pageNumber, registerPage]);

  useEffect(() => {
    const host = canvasHostRef.current;
    const textLayerElement = textLayerRef.current;
    if (!active || !host || !textLayerElement) {
      host?.replaceChildren();
      textLayerElement?.replaceChildren();
      return;
    }
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;

    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        // Render into a fresh canvas and swap it in when done, so a rebuild or
        // zoom never flashes a blank page.
        const canvas = document.createElement("canvas");
        const size = pdfCanvasSize(viewport.width, viewport.height, window.devicePixelRatio);
        canvas.width = size.width;
        canvas.height = size.height;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const context = canvas.getContext("2d");
        if (!context) return;
        renderTask = page.render({ canvasContext: context, viewport, transform: [size.width / viewport.width, 0, 0, size.height / viewport.height, 0, 0] });
        await renderTask.promise;
        if (cancelled) return;
        host.replaceChildren(canvas);

        const textContent = await textCache.get(page);
        if (cancelled) return;
        const layer = document.createElement("div");
        layer.className = "pdf-text-layer";
        layer.style.setProperty("--scale-factor", String(viewport.scale));
        textLayer = new TextLayer({ textContentSource: textContent, container: layer, viewport });
        await textLayer.render();
        if (!cancelled) textLayerElement.replaceChildren(layer);
      } catch (error) {
        if (!(error instanceof Error && error.name === "RenderingCancelledException")) {
          // A destroyed document cancels pending renders; nothing to show.
        }
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [active, pageNumber, pdf, scale, textCache]);

  usePdfDetailCanvas({ hostRef: detailHostRef, pdfDocument: pdf, pageNumber, scale, active });

  return (
    <div
      ref={pageRef}
      data-page-number={pageNumber}
      className="libera-latex-pdf-page absolute left-1/2 -translate-x-1/2 bg-white"
      style={{ top, width, height }}
      onDoubleClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const hint = textLayerRef.current ? textHintAtPoint(textLayerRef.current, event.clientX, event.clientY) : null;
        onInverseSync({ page: pageNumber, x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale, hint: hint ?? undefined });
      }}
    >
      <div ref={canvasHostRef} className="absolute inset-0" />
      <div ref={detailHostRef} className="pointer-events-none absolute inset-0" aria-hidden />
      <div ref={textLayerRef} className="absolute inset-0" />
      {flash ? flash.rects.map((rect, index) => (
        <div
          key={`${flash.nonce}-${index}`}
          aria-hidden
          className="libera-latex-sync-highlight pointer-events-none absolute"
          style={{
            left: (rect.width > 0 ? rect.left : 0) * scale - 2,
            top: (rect.height > 0 ? rect.top : rect.y - 10) * scale - 2,
            width: (rect.width > 0 ? rect.width : width / scale) * scale + 4,
            height: Math.max(rect.height > 0 ? rect.height : 12, 8) * scale + 4,
          }}
        />
      )) : null}
      <div className="pointer-events-none absolute bottom-1.5 right-2 rounded bg-zinc-950/60 px-1.5 py-0.5 text-[10px] font-medium text-white opacity-0 transition-opacity [.libera-latex-pdf-page:hover_&]:opacity-100">{pageNumber}</div>
    </div>
  );
});

/** The caret under a point, in whichever form this browser supports. */
function caretAtPoint(x: number, y: number): { node: Node; offset: number } | null {
  const withPosition = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  if (withPosition.caretPositionFromPoint) {
    const caret = withPosition.caretPositionFromPoint(x, y);
    return caret ? { node: caret.offsetNode, offset: caret.offset } : null;
  }
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/** The PDF word under a point, with the page text around it, to refine inverse search. */
function textHintAtPoint(layer: HTMLElement, x: number, y: number) {
  const caret = caretAtPoint(x, y);
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE || !layer.contains(caret.node)) return null;
  // Read the text layer in order; its runs are separate spans, one per line piece.
  let text = "";
  let offset = -1;
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if ((node as Element).tagName === "BR") text += " ";
      continue;
    }
    if (node === caret.node) offset = text.length + caret.offset;
    text += node.textContent ?? "";
  }
  return offset < 0 ? null : textHintAt(text, offset);
}
