import type { PDFPageProxy, TextContent } from "pdfjs-dist/types/src/display/api";

// About 32 MiB of RGBA pixels per displayed page, independent of zoom/DPR.
export const PDF_MAX_CANVAS_PIXELS = 8 * 1024 * 1024;
export const PDF_MAX_CANVAS_DIMENSION = 8192;
// Detail canvases only cover the visible part of the page, so together they
// stay about one window in size; this fits a full-screen 6K display.
export const PDF_MAX_DETAIL_PIXELS = 3 * PDF_MAX_CANVAS_PIXELS;

export function pdfCanvasSize(width: number, height: number, devicePixelRatio: number, maxPixels = PDF_MAX_CANVAS_PIXELS) {
  const scale = Math.min(
    devicePixelRatio || 1,
    Math.sqrt(maxPixels / (width * height)),
    PDF_MAX_CANVAS_DIMENSION / width,
    PDF_MAX_CANVAS_DIMENSION / height,
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

export type PdfRect = { x: number; y: number; width: number; height: number };

// CSS pixels rendered past each edge of the visible area, so short scrolls
// stay sharp without waiting for a new detail render.
export const PDF_DETAIL_MARGIN = 256;

// When the page canvas is capped below the device pixel ratio, returns the
// region (page CSS pixels) and bitmap size of a sharper canvas covering the
// visible part of the page. Null when the page canvas is already sharp.
export function pdfDetailRegion(
  pageWidth: number,
  pageHeight: number,
  visible: PdfRect,
  devicePixelRatio: number,
): { rect: PdfRect; width: number; height: number } | null {
  const ratio = devicePixelRatio || 1;
  if (visible.width <= 0 || visible.height <= 0) return null;
  if (pdfCanvasSize(pageWidth, pageHeight, ratio).width >= Math.floor(pageWidth * ratio)) return null;

  for (const margin of [PDF_DETAIL_MARGIN, 0]) {
    const left = Math.max(0, Math.floor(visible.x - margin));
    const top = Math.max(0, Math.floor(visible.y - margin));
    const right = Math.min(pageWidth, Math.ceil(visible.x + visible.width + margin));
    const bottom = Math.min(pageHeight, Math.ceil(visible.y + visible.height + margin));
    if (right <= left || bottom <= top) return null;
    const rect = { x: left, y: top, width: right - left, height: bottom - top };
    const size = pdfCanvasSize(rect.width, rect.height, ratio, PDF_MAX_DETAIL_PIXELS);
    // Drop the margin before giving up resolution on a very large window.
    if (margin === 0 || size.width >= Math.floor(rect.width * ratio)) return { rect, ...size };
  }
  return null;
}

export function pdfRectContains(outer: PdfRect, inner: PdfRect) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

// Owned by one document. Cache text rather than canvases, with LRU eviction so
// scrolling through a long PDF does not retain every page's extracted text.
export class PdfTextContentCache {
  private readonly entries = new Map<PDFPageProxy, Promise<TextContent>>();

  constructor(private readonly maxPages = 24) {}

  get(page: PDFPageProxy): Promise<TextContent> {
    let content = this.entries.get(page);
    if (content) {
      this.entries.delete(page);
    } else {
      content = page.getTextContent().catch((error: unknown) => {
        if (this.entries.get(page) === content) this.entries.delete(page);
        throw error;
      });
    }
    this.entries.set(page, content);
    while (this.entries.size > this.maxPages) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    return content;
  }

  clear() {
    this.entries.clear();
  }
}
