import { normalizePdfHighlightQuote } from "@/lib/pdf-highlight-quote";
import type { PdfAnnotationRect, PdfCommentAnchor, PdfCommentMessage, PdfCommentSegment, PdfCommentThread } from "@/lib/types";

// Review comments on PDFs: threads anchored to a text selection's boxes on
// each page it spans. They live in the PDF's annotation sidecar beside its
// markup, so every move, copy, archive and deletion of the PDF carries them
// (src/lib/storage/annotations.ts); this module only validates and orders them.

export const MAX_PDF_COMMENT_CHARS = 20_000;
const MAX_THREADS = 2_000;
const MAX_MESSAGES = 500;
const MAX_SEGMENTS = 50;
const MAX_RECTS = 200;
const MAX_QUOTE_CHARS = 4_000;

const finite = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const isoOr = (value: unknown, fallback: string) => typeof value === "string" && value.trim() ? value : fallback;
const idOr = (value: unknown, makeId: () => string) => typeof value === "string" && value.trim() ? value.slice(0, 120) : makeId();

function normalizeRect(input: unknown): PdfAnnotationRect | null {
  if (!input || typeof input !== "object") return null;
  const rect = input as Partial<PdfAnnotationRect>;
  const x = finite(rect.x, 0, 0.999, 0);
  const y = finite(rect.y, 0, 0.999, 0);
  return { x, y, width: finite(rect.width, 0.001, 1 - x, 0.001), height: finite(rect.height, 0.001, 1 - y, 0.001) };
}

/** A comment anchor as the client sent it, or null when it has no box on any page. */
export function normalizePdfCommentAnchor(input: unknown): PdfCommentAnchor | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as { segments?: unknown; quote?: unknown };
  const segments: PdfCommentSegment[] = [];
  for (const raw of Array.isArray(candidate.segments) ? candidate.segments.slice(0, MAX_SEGMENTS) : []) {
    if (!raw || typeof raw !== "object") continue;
    const segment = raw as { pageNumber?: unknown; rects?: unknown };
    const rects = (Array.isArray(segment.rects) ? segment.rects.slice(0, MAX_RECTS) : []).map(normalizeRect).filter((rect): rect is PdfAnnotationRect => !!rect);
    if (rects.length) segments.push({ pageNumber: Math.floor(finite(segment.pageNumber, 1, 10_000, 1)), rects });
  }
  if (!segments.length) return null;
  segments.sort((left, right) => left.pageNumber - right.pageNumber);
  const quote = typeof candidate.quote === "string" ? normalizePdfHighlightQuote(candidate.quote).slice(0, MAX_QUOTE_CHARS) : "";
  return { segments, quote };
}

function normalizeMessage(input: unknown, makeId: () => string, now: string): PdfCommentMessage | null {
  if (!input || typeof input !== "object") return null;
  const message = input as Partial<PdfCommentMessage>;
  if (typeof message.text !== "string" || !message.text.trim()) return null;
  return {
    id: idOr(message.id, makeId),
    text: message.text.slice(0, MAX_PDF_COMMENT_CHARS),
    createdAt: isoOr(message.createdAt, now),
    ...(typeof message.editedAt === "string" && message.editedAt.trim() ? { editedAt: message.editedAt } : {}),
    ...(message.author === "agent" ? { author: "agent" as const } : {}),
  };
}

/** Threads read from a sidecar: malformed ones are dropped, never guessed at. */
export function normalizePdfCommentThreads(input: unknown, makeId: () => string, now = new Date().toISOString()): PdfCommentThread[] {
  if (!Array.isArray(input)) return [];
  const threads: PdfCommentThread[] = [];
  for (const raw of input.slice(0, MAX_THREADS)) {
    if (!raw || typeof raw !== "object") continue;
    const thread = raw as Partial<PdfCommentThread>;
    const anchor = normalizePdfCommentAnchor(thread.anchor);
    const messages = (Array.isArray(thread.messages) ? thread.messages.slice(0, MAX_MESSAGES) : [])
      .map((message) => normalizeMessage(message, makeId, now))
      .filter((message): message is PdfCommentMessage => !!message);
    if (!anchor || !messages.length) continue;
    const createdAt = isoOr(thread.createdAt, messages[0].createdAt);
    threads.push({
      id: idOr(thread.id, makeId),
      anchor,
      status: thread.status === "resolved" ? "resolved" : "open",
      messages,
      createdAt,
      updatedAt: isoOr(thread.updatedAt, createdAt),
    });
  }
  return threads;
}

/** Reading order: by page, then down the page, then across. */
export function comparePdfCommentThreads(left: PdfCommentThread, right: PdfCommentThread) {
  const a = left.anchor.segments[0], b = right.anchor.segments[0];
  const ar = a.rects[0], br = b.rects[0];
  return a.pageNumber - b.pageNumber || ar.y - br.y || ar.x - br.x || left.createdAt.localeCompare(right.createdAt);
}

export function sortPdfCommentThreads(threads: PdfCommentThread[]) {
  return [...threads].sort(comparePdfCommentThreads);
}

/** "page 3" or "pages 3-4", as Read numbers a PDF's pages. */
export function pdfCommentPages(anchor: PdfCommentAnchor) {
  const first = anchor.segments[0].pageNumber;
  const last = anchor.segments.at(-1)!.pageNumber;
  return first === last ? `page ${first}` : `pages ${first}-${last}`;
}
