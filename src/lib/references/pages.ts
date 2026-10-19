import type { CitationItem, CslItem } from "@/lib/references/types";

// Printed pages and PDF pages (docs/references/plan.md §1.3, §4.5). A page
// locator names a printed page (CSL locators do), while a PDF is addressed by
// page index (1 … page count). When an entry's CSL `page` field gives the
// work's printed range (say 340–360), and the PDF starts at the work's first
// page, printed page p is PDF page p − 340 + 1 and PDF page i is printed page
// 340 + i − 1. Fact-check maps locators to PDF pages with this; quoting from
// the PDF viewer maps PDF pages back to printed pages when the PDF has no page
// labels of its own.

export type PrintedRange = { first: number; last: number };

/** The work's printed page range from its CSL `page` ("340-360", "345–52"), when it is numeric. */
export function printedRange(entry: { csl: Pick<CslItem, "page"> }): PrintedRange | undefined {
  const value = entry.csl.page as unknown;
  const page = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  const match = page.match(/^\s*(\d+)\s*[-–—]+\s*(\d+)\s*$/);
  if (!match) return undefined;
  let first = Number(match[1]);
  let last = Number(match[2]);
  // "345-52" style abbreviations.
  if (last < first && match[2].length < match[1].length) last = Number(match[1].slice(0, match[1].length - match[2].length) + match[2]);
  if (last < first) [first, last] = [last, first];
  return { first, last };
}

/** Page numbers named by a page locator ("12", "12-14" → 12, 13, 14; "12, 15"; "12f"); empty for non-numeric or non-page locators. */
export function locatorPages(item: Pick<CitationItem, "locator" | "label">): number[] {
  if (!item.locator || (item.label && item.label !== "page")) return [];
  const pages: number[] = [];
  for (const part of item.locator.split(/[,;&]|\band\b/)) {
    const range = part.match(/^\s*(\d+)\s*(?:f{1,2}\.?)?\s*(?:[-–—]+\s*(\d+))?\s*$/);
    if (!range) continue;
    const start = Number(range[1]);
    let end = range[2] ? Number(range[2]) : start;
    if (end < start && range[2] && range[2].length < range[1].length) end = Number(range[1].slice(0, range[1].length - range[2].length) + range[2]);
    for (let page = start; page <= Math.min(end, start + 200); page++) pages.push(page);
  }
  return pages;
}

/** The PDF page index for printed page `page`, when the printed range maps it inside the PDF. */
export function pdfPageForPrinted(source: { printed?: PrintedRange }, pageCount: number | undefined, page: number) {
  if (!source.printed || page < source.printed.first || page > source.printed.last) return undefined;
  const index = page - source.printed.first + 1;
  return pageCount === undefined || index <= pageCount ? index : undefined;
}

/** The printed page shown on PDF page `pdfPage`, when the printed range covers it. */
export function printedPageForPdf(printed: PrintedRange | undefined, pdfPage: number) {
  if (!printed || !Number.isInteger(pdfPage) || pdfPage < 1) return undefined;
  const page = printed.first + pdfPage - 1;
  return page <= printed.last ? page : undefined;
}

/**
 * The printed page label of PDF page `pdfPage` (1-based):
 * 1. the PDF's own page labels (pdf.js `getPageLabels`), when it has them;
 * 2. else the entry's printed range (first printed page + index − 1);
 * 3. else the page index itself.
 */
export function printedPageLabel(pdfPage: number, { labels, printed }: { labels?: readonly (string | null | undefined)[] | null; printed?: PrintedRange }) {
  const label = labels?.[pdfPage - 1]?.trim();
  if (label) return label;
  const mapped = printedPageForPdf(printed, pdfPage);
  return String(mapped ?? pdfPage);
}

/** The locator for PDF pages `start`…`end`: "12", or "12–13" across pages (one label when both pages print the same). */
export function pdfPagesLocator(start: number, end: number, options: Parameters<typeof printedPageLabel>[1]) {
  const first = printedPageLabel(Math.min(start, end), options);
  const last = printedPageLabel(Math.max(start, end), options);
  return first === last ? first : `${first}–${last}`;
}
