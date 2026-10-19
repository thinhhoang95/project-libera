import type { PDFDocumentProxy, PDFPageProxy, TextContent } from "pdfjs-dist/types/src/display/api";
import type { PdfTextContentCache } from "@/components/libera/pdf-rendering";
import { pdfLayoutPage, readPdfPageStructure, type PdfPageStructure } from "@/lib/pdf-layout-page";
import { pdfSelectionToMarkdown, type PdfLayoutPage, type PdfTextSelection } from "@/lib/pdf-markdown";

/** Data attribute on TextLayer spans holding their pdf.js text item index. */
export const PDF_TEXT_ITEM_ATTRIBUTE = "data-pdf-item";

/**
 * Page geometry for Markdown copy, owned by one document. Copy events are
 * synchronous, so rendered pages are recorded as they draw and neighbors of
 * a selection are read ahead for running header detection.
 */
export class PdfLayoutStore {
  private readonly pages = new Map<number, PdfLayoutPage>();
  private readonly structures = new Map<number, Promise<PdfPageStructure | null>>();
  private readonly loading = new Map<number, Promise<void>>();
  private readonly tagged: Promise<boolean>;

  constructor(
    private readonly document: PDFDocumentProxy,
    private readonly cache: PdfTextContentCache,
    private readonly maxPages = 48,
  ) {
    // Deferred so a document without mark info never breaks rendering.
    this.tagged = Promise.resolve()
      .then(() => document.getMarkInfo())
      .then((info) => Boolean(info?.Marked))
      .catch(() => false);
  }

  get snapshot(): ReadonlyMap<number, PdfLayoutPage> {
    return this.pages;
  }

  has(pageNumber: number) {
    return this.pages.has(pageNumber);
  }

  /** Records a rendered page, whose fonts are loaded so weights are known. */
  record(page: PDFPageProxy, content: TextContent) {
    // Copy support must never break page rendering.
    try {
      this.set(pdfLayoutPage(page, content));
    } catch {
      return;
    }
    void this.structure(page).then((structure) => {
      if (structure && this.pages.has(page.pageNumber)) this.set(pdfLayoutPage(page, content, structure));
    }).catch(() => undefined);
  }

  /** Loads text geometry for pages that have not been rendered yet. */
  ensure(pageNumbers: Iterable<number>): Promise<void> {
    const work: Promise<void>[] = [];

    for (const pageNumber of pageNumbers) {
      if (pageNumber < 1 || pageNumber > this.document.numPages || this.pages.has(pageNumber)) continue;
      let pending = this.loading.get(pageNumber);
      if (!pending) {
        pending = this.load(pageNumber).finally(() => this.loading.delete(pageNumber));
        this.loading.set(pageNumber, pending);
      }
      work.push(pending);
    }

    return Promise.all(work).then(() => undefined);
  }

  clear() {
    this.pages.clear();
    this.structures.clear();
    this.loading.clear();
  }

  private async load(pageNumber: number) {
    try {
      const page = await this.document.getPage(pageNumber);
      const [content, structure] = await Promise.all([this.cache.get(page), this.structure(page)]);
      // A render may have recorded the page, with its fonts, in the meantime.
      if (!this.pages.has(pageNumber)) this.set(pdfLayoutPage(page, content, structure));
    } catch {
      // Missing neighbors only weaken running header detection.
    }
  }

  private structure(page: PDFPageProxy) {
    let structure = this.structures.get(page.pageNumber);
    if (!structure) {
      structure = this.tagged
        .then((tagged) => (tagged ? readPdfPageStructure(page) : null))
        .catch(() => null);
      this.structures.set(page.pageNumber, structure);
    }
    return structure;
  }

  private set(page: PdfLayoutPage) {
    this.pages.delete(page.pageNumber);
    this.pages.set(page.pageNumber, page);
    while (this.pages.size > this.maxPages) {
      const oldest = this.pages.keys().next().value!;
      this.pages.delete(oldest);
      this.structures.delete(oldest);
    }
  }
}

function textLayers(range: Range, root: ParentNode) {
  return Array.from(root.querySelectorAll<HTMLElement>(".pdf-text-layer")).flatMap((layer) => {
    const pageNumber = Number(layer.closest("[data-pdf-page-content]")?.getAttribute("data-pdf-page-content"));
    return pageNumber && range.intersectsNode(layer) ? [{ layer, pageNumber }] : [];
  });
}

/** Page numbers whose text layer the range touches. */
export function pdfRangePages(range: Range, root: ParentNode): number[] {
  return textLayers(range, root).map(({ pageNumber }) => pageNumber);
}

/** Maps a DOM selection over TextLayer spans to selected characters of text items. */
export function pdfSelectionFromRange(range: Range, root: ParentNode): PdfTextSelection[] {
  const selection: PdfTextSelection[] = [];
  const doc = range.startContainer.ownerDocument ?? document;

  for (const { layer, pageNumber } of textLayers(range, root)) {
    for (const span of layer.querySelectorAll<HTMLElement>(`[${PDF_TEXT_ITEM_ATTRIBUTE}]`)) {
      if (!range.intersectsNode(span)) continue;

      const text = span.textContent ?? "";
      const spanRange = doc.createRange();
      spanRange.selectNodeContents(span);
      let start = 0;
      let end = text.length;

      if (range.compareBoundaryPoints(Range.START_TO_START, spanRange) > 0) {
        const before = doc.createRange();
        before.setStart(span, 0);
        before.setEnd(range.startContainer, range.startOffset);
        start = before.toString().length;
      }

      if (range.compareBoundaryPoints(Range.END_TO_END, spanRange) < 0) {
        const before = doc.createRange();
        before.setStart(span, 0);
        before.setEnd(range.endContainer, range.endOffset);
        end = before.toString().length;
      }

      if (end > start) {
        selection.push({ pageNumber, index: Number(span.getAttribute(PDF_TEXT_ITEM_ATTRIBUTE)), start, end });
      }
    }
  }

  return selection;
}

/**
 * Markdown for the current PDF text selection, or "" when the selection is
 * not PDF text or its pages are not measured yet (the caller then falls back
 * to the browser's plain text).
 */
export function pdfSelectionMarkdown(root: ParentNode, store: PdfLayoutStore): string {
  const selection = root.ownerDocument?.getSelection?.() ?? window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return "";

  const range = selection.getRangeAt(0);
  const items = pdfSelectionFromRange(range, root);
  if (!items.length || items.some((item) => !store.has(item.pageNumber))) return "";

  try {
    return pdfSelectionToMarkdown(store.snapshot, items);
  } catch {
    return "";
  }
}
