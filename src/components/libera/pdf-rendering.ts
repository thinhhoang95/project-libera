import type { PDFPageProxy, TextContent } from "pdfjs-dist/types/src/display/api";

// About 32 MiB of RGBA pixels per displayed page, independent of zoom/DPR.
export const PDF_MAX_CANVAS_PIXELS = 8 * 1024 * 1024;
export const PDF_MAX_CANVAS_DIMENSION = 8192;

export function pdfCanvasSize(width: number, height: number, devicePixelRatio: number) {
  const scale = Math.min(
    devicePixelRatio || 1,
    Math.sqrt(PDF_MAX_CANVAS_PIXELS / (width * height)),
    PDF_MAX_CANVAS_DIMENSION / width,
    PDF_MAX_CANVAS_DIMENSION / height,
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
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
