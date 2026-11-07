import type { PdfAnnotationRect } from "@/lib/types";

/** A PDF.js text item, as much of it as positioning needs. */
export type QuoteTextItem = { str: string; hasEOL?: boolean; width: number; height: number; transform: number[] };

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

function flatten(items: readonly QuoteTextItem[]) {
  let text = "";
  const spans: Array<{ item: QuoteTextItem; start: number; end: number }> = [];
  for (const item of items) {
    const start = text.length;
    text += item.str.replace(/\s/g, " ");
    spans.push({ item, start, end: text.length });
    if (item.hasEOL) text += " ";
  }
  return { text, spans };
}

/** Where `quote` occurs on a page: every match's offsets, spaces matching any run of spaces. */
function occurrences(text: string, quote: string): Array<{ start: number; end: number }> {
  const needle = normalize(quote);
  if (!needle) return [];
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"), "gu");
  return Array.from(text.matchAll(pattern), (match) => ({ start: match.index, end: match.index + match[0].length }));
}

function rectsOf(spans: ReturnType<typeof flatten>["spans"], start: number, end: number, page: QuotePage): PdfAnnotationRect[] {
  const rects: PdfAnnotationRect[] = [];
  for (const span of spans) {
    const from = Math.max(start, span.start);
    const to = Math.min(end, span.end);
    if (from >= to || span.end === span.start) continue;
    const { item } = span;
    const [a, b, c, d, e, f] = item.transform;
    // Text can run in any direction, so the box is built along the item's own axes.
    const along = Math.hypot(a, b) || 1;
    const up = Math.hypot(c, d) || 1;
    const perChar = item.width / (span.end - span.start);
    const height = item.height || up;
    const point = (distance: number, rise: number): [number, number] => page.toViewport(e + (a / along) * distance + (c / up) * rise, f + (b / along) * distance + (d / up) * rise);
    const corners = [point((from - span.start) * perChar, 0), point((to - span.start) * perChar, 0), point((from - span.start) * perChar, height), point((to - span.start) * perChar, height)];
    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    rects.push({ x: left / page.width, y: top / page.height, width: (Math.max(...xs) - left) / page.width, height: (Math.max(...ys) - top) / page.height });
  }
  return rects;
}

export interface QuotePage {
  pageNumber: number;
  items: readonly QuoteTextItem[];
  /** Size of the page as displayed, which rotation and the crop box decide. */
  width: number;
  height: number;
  /** From PDF user space to the displayed page. */
  toViewport(x: number, y: number): [number, number];
}

/**
 * Where a quote is now, across candidate pages. Only a single match counts:
 * a phrase found twice cannot say which one the mark meant, and moving a mark
 * to the wrong place is worse than leaving it flagged.
 */
export function relocateQuote(quote: string, pages: readonly QuotePage[]): { pageNumber: number; rects: PdfAnnotationRect[] } | null {
  const found: Array<{ page: QuotePage; spans: ReturnType<typeof flatten>["spans"]; start: number; end: number }> = [];
  for (const page of pages) {
    const { text, spans } = flatten(page.items);
    for (const match of occurrences(text, quote)) found.push({ page, spans, ...match });
  }
  if (found.length !== 1) return null;
  const [{ page, spans, start, end }] = found;
  const rects = rectsOf(spans, start, end, page);
  return rects.length ? { pageNumber: page.pageNumber, rects } : null;
}
