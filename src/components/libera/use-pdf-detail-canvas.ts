"use client";

import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist/types/src/display/api";
import { useEffect, type RefObject } from "react";
import { pdfDetailRegion, pdfRectContains, type PdfRect } from "@/components/libera/pdf-rendering";

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
// page exactly; it is re-rendered shortly after scrolling, resizing or zooming.
export function usePdfDetailCanvas({
  hostRef,
  pdfDocument,
  pageNumber,
  scale,
  active = true,
}: {
  hostRef: RefObject<HTMLElement | null>;
  pdfDocument: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  active?: boolean;
}) {
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!active) {
      releaseCanvases(host);
      return;
    }

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
      const visible = visibleElementRect(host, viewport.width, viewport.height);
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
      if (!canvasContext) return;
      const scaleX = region.width / rect.width;
      const scaleY = region.height / rect.height;
      const task = page.render({
        canvasContext,
        viewport,
        transform: [scaleX, 0, 0, scaleY, -rect.x * scaleX, -rect.y * scaleY],
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
      if (disposed || renderTask !== task) return;
      releaseCanvases(host);
      host.append(canvas);
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

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      renderTask?.cancel();
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      // The current detail stays (stretched) until the next render replaces it.
    };
  }, [active, hostRef, pageNumber, pdfDocument, scale]);

  useEffect(() => {
    const host = hostRef.current;
    return () => {
      if (host) releaseCanvases(host);
    };
  }, [hostRef]);
}
