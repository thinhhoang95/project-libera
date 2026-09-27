import type { PDFDocumentProxy, TextContent } from "pdfjs-dist/types/src/display/api";
import type { PdfTextContentCache } from "./pdf-rendering";

export type PdfSearchPage = {
  text: string;
  items: { start: number; end: number }[];
};
export type PdfSearchMatch = { pageNumber: number; start: number; end: number };

export class PdfSearchIndex {
  private readonly pages: PdfSearchPage[] = [];
  constructor(private readonly document: PDFDocumentProxy, private readonly cache: PdfTextContentCache) {}

  async read(signal: AbortSignal): Promise<PdfSearchPage[]> {
    for (let number = this.pages.length + 1; number <= this.document.numPages; number++) {
      signal.throwIfAborted();
      const page = await this.document.getPage(number);
      signal.throwIfAborted();
      const content = await this.cache.get(page);
      signal.throwIfAborted();
      this.pages.push(buildPdfSearchPage(content));
    }
    return this.pages.slice();
  }
}

// Keep offsets into PDF.js's textDivs, including empty items. A line break is
// searchable as a space, while adjacent runs can form a single word.
export function buildPdfSearchPage(content: TextContent): PdfSearchPage {
  let text = "";
  const items: PdfSearchPage["items"] = [];
  for (const item of content.items) {
    if (!("str" in item)) continue;
    const start = text.length;
    text += item.str.replace(/\s/g, " ");
    items.push({ start, end: text.length });
    if (item.hasEOL) text += " ";
  }
  return { text, items };
}

export function findPdfMatches(pages: PdfSearchPage[], query: string): PdfSearchMatch[] {
  const normalized = query.trim().replace(/\s+/g, " ");
  if (!normalized) return [];
  // RegExp returns original UTF-16 offsets even when case folding changes size.
  const pattern = new RegExp(normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"), "giu");
  return pages.flatMap((page, index) => Array.from(page.text.matchAll(pattern), (match) => ({
    pageNumber: index + 1, start: match.index, end: match.index + match[0].length,
  })));
}

export function highlightPdfMatches(
  textDivs: HTMLElement[],
  page: PdfSearchPage,
  matches: PdfSearchMatch[],
  activeMatch: PdfSearchMatch | undefined,
) {
  let activeElement: HTMLElement | undefined;
  textDivs.forEach((div, index) => {
    const item = page.items[index];
    if (!item) return;
    const text = div.textContent ?? "";
    const fragments: (string | HTMLElement)[] = [];
    let offset = 0;
    for (const match of matches) {
      const start = Math.max(item.start, match.start) - item.start;
      const end = Math.min(item.end, match.end) - item.start;
      if (end <= start) continue;
      fragments.push(text.slice(offset, start));
      const mark = div.ownerDocument.createElement("mark");
      mark.className = match === activeMatch ? "pdf-find-match pdf-find-match-active" : "pdf-find-match";
      mark.textContent = text.slice(start, end);
      fragments.push(mark);
      if (match === activeMatch && !activeElement) activeElement = mark;
      offset = end;
    }
    fragments.push(text.slice(offset));
    div.replaceChildren(...fragments);
  });
  return activeElement;
}
