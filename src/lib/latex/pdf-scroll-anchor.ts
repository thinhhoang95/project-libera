/**
 * Where a PDF is scrolled, independent of its scale: the page at the top of the
 * viewport and how far down that page the edge sits, as a fraction of its
 * height. When the preview fits the page width, a pixel offset means a
 * different page at every pane width.
 */
export type PdfPageAnchor = { page: number; offset: number };

/** `tops` and `heights` are the scaled layout of the pages, in order. */
export function pdfPageAnchorAt(scrollTop: number, tops: number[], heights: number[]): PdfPageAnchor | null {
  if (!tops.length) return null;
  let page = 0;
  for (let index = 1; index < tops.length && tops[index] <= scrollTop; index++) page = index;
  return { page, offset: Math.max(0, (scrollTop - tops[page]) / (heights[page] || 1)) };
}

export function pdfAnchorScrollTop(anchor: PdfPageAnchor, tops: number[], heights: number[]) {
  if (!tops.length) return 0;
  const page = Math.min(anchor.page, tops.length - 1);
  // The start of the document is above the first page's margin.
  if (page === 0 && anchor.offset === 0) return 0;
  return tops[page] + anchor.offset * heights[page];
}
