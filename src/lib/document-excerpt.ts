import { normalizeForMatch } from "./text-match";

/**
 * Part of a long document instead of all of it. The budget is a number of
 * pages, counted in words: 500 words a page in text files, the document's
 * average page in a PDF, so a page means roughly what the viewer shows.
 *
 * The budget is split evenly between the passages quoted from the document.
 * Their windows merge where they meet, then grow outward until the budget is
 * spent. With no quotes, the one window sits on what the reader is looking at.
 * What earlier messages already sent is left out, so a follow-up adds only the
 * text the model has not seen.
 */
export const WORDS_PER_PAGE = 500;
/** Less new text than this is not worth another copy of the surrounding words. */
const MIN_ADDED_WORDS = 20;
const QUOTE_CHUNK_CHARS = 32;

/** Word indices, end exclusive. */
export type WordRange = { start: number; end: number };
/**
 * What a message sent of a document. `ranges` are in the document as it was
 * then; edits made since shift them slightly, which only moves a window's edge.
 */
export type DocumentExcerpt = { pages: number; wordCount: number; ranges: WordRange[]; pdfPages?: number[] };
/** Where the reader is: a text offset, or a PDF page. */
export type ReaderPosition = { offset?: number; page?: number };

export function wordStarts(text: string) {
  return Array.from(text.matchAll(/\S+/g), (match) => match.index);
}

/** The last word starting at or before `offset`. */
export function wordAt(starts: number[], offset: number) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= offset) low = middle; else high = middle - 1;
  }
  return low;
}

export function documentPageCount(wordCount: number) {
  return Math.ceil(wordCount / WORDS_PER_PAGE);
}

/** Pixels of drag across the whole range, from one page to the whole document. */
const PAGE_DRAG_SPAN = 220;

/** Where a budget sits on the drag: logarithmic, so small windows are easy to pick in a long document. */
export function pagesPosition(pages: number, total: number) {
  return Math.log(pages) / Math.log(total);
}

export function pagesForDrag(startPages: number, total: number, deltaX: number) {
  const position = Math.min(1, Math.max(0, pagesPosition(startPages, total) + deltaX / PAGE_DRAG_SPAN));
  return Math.min(total, Math.max(1, Math.round(total ** position)));
}

function mergeRanges(ranges: WordRange[]) {
  const merged: WordRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

const covered = (ranges: WordRange[]) => ranges.reduce((sum, range) => sum + range.end - range.start, 0);

/** Windows sharing `budget` words evenly around `anchors`, then grown outward until it is spent. */
export function windowsAround(anchors: WordRange[], budget: number, total: number): WordRange[] {
  if (!total || !anchors.length) return [];
  if (budget >= total) return [{ start: 0, end: total }];
  const share = budget / anchors.length;
  let windows = mergeRanges(anchors.map(({ start, end }) => {
    const from = Math.min(Math.max((start + end - share) / 2, 0), total - share);
    return { start: from, end: from + share };
  }));
  // Growing into a neighbor or an end of the document spends less than offered,
  // so the rest goes out again. budget < total, so there is always room.
  for (let spare = budget - covered(windows); spare > 0.5; spare = budget - covered(windows)) {
    const grow = spare / (2 * windows.length);
    windows = mergeRanges(windows.map(({ start, end }) => ({ start: Math.max(0, start - grow), end: Math.min(total, end + grow) })));
  }
  return mergeRanges(windows.map(({ start, end }) => ({ start: Math.round(start), end: Math.round(end) })));
}

export function subtractRanges(ranges: WordRange[], removed: WordRange[]) {
  let remaining = ranges;
  for (const cut of removed) {
    remaining = remaining.flatMap((range) => cut.end <= range.start || cut.start >= range.end ? [range] : [
      ...(range.start < cut.start ? [{ start: range.start, end: cut.start }] : []),
      ...(cut.end < range.end ? [{ start: cut.end, end: range.end }] : []),
    ]);
  }
  return remaining;
}

/**
 * Where a quote sits in the source, by character offset. A passage copied from
 * the Visual editor or a PDF lacks the source's Markdown and line breaks, so
 * when the whole quote is not there, its first piece that is places it. This
 * runs on the UI thread, so it stays with string search; no edit distance.
 */
export function locateQuote(quote: string, source: { text: string; map: number[] }) {
  const needle = normalizeForMatch(quote).text;
  if (!needle) return null;
  const exact = source.text.indexOf(needle);
  if (exact >= 0) return { start: source.map[exact], end: source.map[exact + needle.length - 1] + 1 };
  for (let from = 0; from + QUOTE_CHUNK_CHARS <= needle.length; from += QUOTE_CHUNK_CHARS / 2) {
    const found = source.text.indexOf(needle.slice(from, from + QUOTE_CHUNK_CHARS));
    if (found < 0) continue;
    const start = source.map[Math.max(0, found - from)];
    return { start, end: source.map[Math.min(source.map.length - 1, found - from + needle.length - 1)] + 1 };
  }
  return null;
}

/** Offsets of the "## Page N" headings the PDF chat text is made of. */
function pdfPageOffsets(text: string) {
  return Array.from(text.matchAll(/^## Page (\d+)$/gm), (match) => ({ page: Number(match[1]), offset: match.index }));
}

function isCovered(anchor: WordRange, ranges: WordRange[]) {
  return ranges.some((range) => range.start <= anchor.start && anchor.end <= range.end);
}

/**
 * The next excerpt of a document: its text, with what was cut marked, and what
 * it covers. Null when the budget and the quotes add nothing to `sent`.
 * Without `pages` the budget is the whole document, for a window widened all
 * the way after part of the document went.
 */
export function documentExcerpt({ text, pages, quotes = [], reader = {}, sent = [], pdf = false }: {
  text: string;
  pages?: number;
  quotes?: string[];
  reader?: ReaderPosition;
  sent?: DocumentExcerpt[];
  pdf?: boolean;
}): { text: string; excerpt: DocumentExcerpt } | null {
  const starts = wordStarts(text);
  const total = starts.length;
  if (!total) return null;
  const pdfPages = pdf ? pdfPageOffsets(text) : [];
  const wordsPerPage = pdfPages.length ? total / pdfPages.length : WORDS_PER_PAGE;
  const budget = pages ? Math.round(pages * wordsPerPage) : total;
  const sentRanges = sent.flatMap((excerpt) => excerpt.ranges);

  const source = quotes.length ? normalizeForMatch(text) : null;
  const quoted = quotes.flatMap((quote) => {
    const place = source && locateQuote(quote, source);
    return place ? [{ start: wordAt(starts, place.start), end: wordAt(starts, place.end - 1) + 1 }] : [];
  });
  const viewedPage = reader.page === undefined ? -1 : pdfPages.findIndex((item) => item.page === reader.page);
  const viewed = viewedPage >= 0
    ? { start: wordAt(starts, pdfPages[viewedPage].offset), end: pdfPages[viewedPage + 1] ? wordAt(starts, pdfPages[viewedPage + 1].offset) : total }
    : { start: wordAt(starts, reader.offset ?? 0), end: wordAt(starts, reader.offset ?? 0) + 1 };
  const anchors = quoted.length ? quoted : [viewed];

  // A larger budget than any sent before adds text around anchors already in
  // the conversation. Otherwise those anchors add nothing, and each new one
  // keeps its share of the budget.
  const widened = !sent.length || budget > Math.max(...sent.map((excerpt) => Math.round(excerpt.pages * wordsPerPage)));
  const fresh = widened ? anchors : anchors.filter((anchor) => !isCovered(anchor, sentRanges));
  const windows = windowsAround(fresh, budget * fresh.length / anchors.length, total);
  const ranges = subtractRanges(windows, sentRanges).filter((range) => !sent.length || range.end - range.start >= MIN_ADDED_WORDS);
  if (!ranges.length) return null;

  const offsets = ranges.map(({ start, end }) => ({ start: starts[start], end: end < total ? starts[end] : text.length }));
  const parts = offsets.map(({ start, end }) => {
    const part = text.slice(start, end).trimEnd();
    const page = pdfPages.findLast((item) => item.offset <= start);
    return page && page.offset !== start ? `## Page ${page.page} (continued)\n\n${part}` : part;
  });
  const touched = pdfPages.filter((item, index) => offsets.some(({ start, end }) => item.offset < end && (pdfPages[index + 1]?.offset ?? text.length) > start)).map((item) => item.page);
  return {
    text: `${ranges[0].start ? "[…]\n\n" : ""}${parts.join("\n\n[…]\n\n")}${ranges.at(-1)!.end < total ? "\n\n[…]" : ""}`,
    excerpt: { pages: pages ?? Math.ceil(total / wordsPerPage), wordCount: total, ranges, ...(pdf ? { pdfPages: touched } : {}) },
  };
}

/**
 * Whether the next message would add nothing of this document: the window is no
 * larger than one already sent, what the reader sees went already, and no quote
 * is waiting (a quote's place is only worked out when the message is sent).
 */
export function documentWindowSent(sent: DocumentExcerpt[], { pages, quoted, word, pdfPage }: { pages?: number; quoted: boolean; word?: number; pdfPage?: number }) {
  if (!sent.length || quoted || !pages || pages > Math.max(...sent.map((excerpt) => excerpt.pages))) return false;
  return pdfPage !== undefined
    ? sent.some((excerpt) => excerpt.pdfPages?.includes(pdfPage))
    : isCovered({ start: word ?? 0, end: (word ?? 0) + 1 }, sent.flatMap((excerpt) => excerpt.ranges));
}

export function validateDocumentExcerpt(value: unknown): value is DocumentExcerpt {
  const excerpt = value as DocumentExcerpt | null;
  return !!excerpt && typeof excerpt === "object" && Number.isFinite(excerpt.pages) && Number.isFinite(excerpt.wordCount) && Array.isArray(excerpt.ranges) &&
    excerpt.ranges.every((range) => range && Number.isInteger(range.start) && Number.isInteger(range.end)) &&
    (excerpt.pdfPages === undefined || (Array.isArray(excerpt.pdfPages) && excerpt.pdfPages.every(Number.isInteger)));
}
