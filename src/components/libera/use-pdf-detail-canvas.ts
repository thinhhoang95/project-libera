"use client";

import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist/types/src/display/api";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { pdfDetailRegion, pdfRectContains, retainPdfPage, type PdfRect } from "@/components/libera/pdf-rendering";
import { pieceVariable } from "@/components/libera/pdf-space-raster";
import { IDENTITY_PAGE_GEOMETRY, type PdfPageGeometry } from "@/lib/pdf-space-geometry";

const DETAIL_RENDER_DELAY_MS = 120;
const CLIPPING_OVERFLOW = /auto|scroll|hidden|clip|overlay/;

// The part of the element not clipped by the window or an overflow ancestor,
// in the element's own (untransformed) CSS pixels.
function visibleElementRect(element: HTMLElement, width: number, height: number): PdfRect | null {
  const bounds = element.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return null;
  let left = Math.max(bounds.left, 0);
  let top = Math.max(bounds.top, 0);
  let right = Math.min(bounds.right, window.innerWidth);
  let bottom = Math.min(bounds.bottom, window.innerHeight);

  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = window.getComputedStyle(ancestor);
    if (!CLIPPING_OVERFLOW.test(`${style.overflowX} ${style.overflowY}`)) continue;
    const clip = ancestor.getBoundingClientRect();
    left = Math.max(left, clip.left);
    top = Math.max(top, clip.top);
    right = Math.min(right, clip.right);
    bottom = Math.min(bottom, clip.bottom);
  }

  if (right <= left || bottom <= top) return null;
  const scaleX = width / bounds.width;
  const scaleY = height / bounds.height;
  return {
    x: (left - bounds.left) * scaleX,
    y: (top - bounds.top) * scaleY,
    width: (right - left) * scaleX,
    height: (bottom - top) * scaleY,
  };
}

function unionRect(a: PdfRect, b: PdfRect): PdfRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/**
 * On a page with spaces: the document area (CSS pixels of the original page)
 * whose pieces show in `view`, the visible part of the displayed page.
 */
function visibleDocumentArea(view: PdfRect, geometry: PdfPageGeometry, width: number, height: number): PdfRect | null {
  let area: PdfRect | null = null;
  for (const { rect, shift } of geometry.pieces) {
    const left = Math.max(rect.x * width, view.x);
    const right = Math.min((rect.x + rect.width) * width, view.x + view.width);
    const top = Math.max((rect.y + shift) * height, view.y);
    const bottom = Math.min((rect.y + rect.height + shift) * height, view.y + view.height);
    if (right <= left || bottom <= top) continue;
    const part = { x: left, y: top - shift * height, width: right - left, height: bottom - top };
    area = area ? unionRect(area, part) : part;
  }
  return area;
}

/** Splits a detail canvas covering `rect` into the pieces it overlaps, each moving with its piece. */
function pieceDetails(detail: HTMLCanvasElement, rect: PdfRect, geometry: PdfPageGeometry, width: number, height: number) {
  const scaleX = detail.width / rect.width;
  const scaleY = detail.height / rect.height;
  return geometry.pieces.flatMap((piece, index) => {
    const left = Math.max(piece.rect.x * width, rect.x);
    const right = Math.min((piece.rect.x + piece.rect.width) * width, rect.x + rect.width);
    const top = Math.max(piece.rect.y * height, rect.y);
    const bottom = Math.min((piece.rect.y + piece.rect.height) * height, rect.y + rect.height);
    if (right <= left || bottom <= top) return [];
    const canvas = document.createElement("canvas");
    const sx = Math.round((left - rect.x) * scaleX);
    const sy = Math.round((top - rect.y) * scaleY);
    canvas.width = Math.max(1, Math.round((right - rect.x) * scaleX) - sx);
    canvas.height = Math.max(1, Math.round((bottom - rect.y) * scaleY) - sy);
    canvas.getContext("2d")?.drawImage(detail, sx, sy, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    Object.assign(canvas.style, {
      position: "absolute",
      left: `${(left / width) * 100}%`,
      top: `${(top / height) * 100}%`,
      width: `${((right - left) / width) * 100}%`,
      height: `${((bottom - top) / height) * 100}%`,
      translate: `0 var(${pieceVariable(index)}, 0px)`,
    });
    return [canvas];
  });
}

function releaseCanvases(host: HTMLElement) {
  for (const canvas of host.querySelectorAll("canvas")) {
    canvas.width = 0;
    canvas.height = 0;
  }
  host.replaceChildren();
}

// The page canvas is capped at PDF_MAX_CANVAS_PIXELS, so at high zoom it is
// drawn below the device pixel ratio. This keeps a second canvas, sized to the
// visible part of the page, at full resolution over it. `host` must cover the
// original page exactly; it is re-rendered shortly after scrolling, resizing or
// zooming. On a page with spaces, `surfaceRef` covers the page as displayed and
// the detail is split into the geometry's pieces.
export function usePdfDetailCanvas({
  hostRef,
  surfaceRef,
  geometry = IDENTITY_PAGE_GEOMETRY,
  pdfDocument,
  pageNumber,
  scale,
  background = "",
  active = true,
}: {
  hostRef: RefObject<HTMLElement | null>;
  surfaceRef?: RefObject<HTMLElement | null>;
  geometry?: PdfPageGeometry;
  pdfDocument: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  /** The page fill, as for the page canvas; "" is white. */
  background?: string;
  active?: boolean;
}) {
  // Keep resources across zooms while displayed. Render leases below also keep
  // them alive during asynchronous cancellation after this owner unmounts.
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let release: (() => void) | undefined;
    void pdfDocument.getPage(pageNumber).then((page) => {
      release = retainPdfPage(page);
      if (disposed) release();
    }).catch(() => undefined);
    return () => { disposed = true; release?.(); };
  }, [active, pdfDocument, pageNumber]);

  // Resizing a space only moves pieces, which the detail follows through CSS.
  const geometryRef = useRef(geometry);
  useLayoutEffect(() => {
    geometryRef.current = geometry;
  });
  const structureKey = geometry.structureKey;
  const shownStructureRef = useRef(structureKey);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!active || shownStructureRef.current !== structureKey) {
      // Details placed for other pieces would show in the wrong places.
      releaseCanvases(host);
      shownStructureRef.current = structureKey;
    }
  }, [active, hostRef, structureKey]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !active) return;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let renderTask: RenderTask | null = null;
    // The region already shown or being rendered at this scale.
    let target: { rect: PdfRect; ratio: number } | null = null;

    async function update() {
      const page = await pdfDocument.getPage(pageNumber);
      if (disposed || !host) return;
      const viewport = page.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      const pageGeometry = geometryRef.current;
      const spaced = pageGeometry !== IDENTITY_PAGE_GEOMETRY;
      const surface = spaced ? surfaceRef?.current ?? host : host;
      const view = visibleElementRect(surface, viewport.width, viewport.height * pageGeometry.scale);
      const visible = view && spaced ? visibleDocumentArea(view, pageGeometry, viewport.width, viewport.height) : view;
      const region = visible && pdfDetailRegion(viewport.width, viewport.height, visible, ratio);

      if (!visible || !region) {
        renderTask?.cancel();
        target = null;
        releaseCanvases(host);
        return;
      }
      if (target && target.ratio === ratio && pdfRectContains(target.rect, visible)) return;

      renderTask?.cancel();
      const { rect } = region;
      target = { rect, ratio };
      const canvas = document.createElement("canvas");
      canvas.width = region.width;
      canvas.height = region.height;
      Object.assign(canvas.style, {
        position: "absolute",
        // Percentages keep the old detail aligned while a new zoom renders.
        left: `${(rect.x / viewport.width) * 100}%`,
        top: `${(rect.y / viewport.height) * 100}%`,
        width: `${(rect.width / viewport.width) * 100}%`,
        height: `${(rect.height / viewport.height) * 100}%`,
      });
      const canvasContext = canvas.getContext("2d");
      if (!canvasContext) {
        target = null;
        canvas.width = 0;
        canvas.height = 0;
        return;
      }
      const releasePage = retainPdfPage(page);
      try {
        const scaleX = region.width / rect.width;
        const scaleY = region.height / rect.height;
        const task = page.render({
          canvasContext,
          viewport,
          transform: [scaleX, 0, 0, scaleY, -rect.x * scaleX, -rect.y * scaleY],
          background: background || undefined,
        });
        renderTask = task;

        try {
          await task.promise;
        } catch {
          // Cancelled by a newer region or a destroyed document.
          if (renderTask === task) target = null;
          canvas.width = 0;
          canvas.height = 0;
          return;
        }
        if (disposed || renderTask !== task || pageGeometry.structureKey !== geometryRef.current.structureKey) {
          canvas.width = 0;
          canvas.height = 0;
          return;
        }
        releaseCanvases(host);
        if (spaced) {
          host.append(...pieceDetails(canvas, rect, pageGeometry, viewport.width, viewport.height));
          canvas.width = 0;
          canvas.height = 0;
        } else {
          host.append(canvas);
        }
      } finally {
        releasePage();
      }
    }

    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void update().catch(() => undefined), DETAIL_RENDER_DELAY_MS);
    }

    schedule();
    // Capture scrolls from whichever ancestor scrolls the page.
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    if (geometryRef.current !== IDENTITY_PAGE_GEOMETRY && surfaceRef?.current && surfaceRef.current !== host) observer.observe(surfaceRef.current);

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      renderTask?.cancel();
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      // The current detail stays (stretched) until the next render replaces it.
    };
  }, [active, background, hostRef, pageNumber, pdfDocument, scale, structureKey, surfaceRef]);

  useEffect(() => {
    const host = hostRef.current;
    return () => {
      if (host) releaseCanvases(host);
    };
  }, [hostRef]);
}
