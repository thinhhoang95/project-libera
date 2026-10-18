import { findMarkdownBlockInsertionOffset, insertMarkdownBlock } from "@/lib/ai-write";
import { serializeCitation } from "@/lib/references/citation-syntax";
import { pdfPagesLocator, printedRange } from "@/lib/references/pages";
import type { ReferenceEntry, ReferenceLibrary } from "@/lib/references/types";

// Quote and cite from a PDF (docs/references/plan.md §1.3, §5 Phase 5): the
// PDF viewer's selection menu, a highlight's actions, the PDF outline and a
// drag into an editor all produce
//
//   > quote text
//   >
//   > [@key, p. 12]
//
// The locator is the printed page: the PDF's own page labels when it has
// them, else the entry's CSL page range mapped onto the PDF, else the PDF page
// index (see pages.ts). Pure; shared by the client and the tests.

/** Drag data a PDF text selection carries into the editors (with text/plain). */
export const PDF_CITATION_MIME = "application/x-libera-citation";

/**
 * A quote taken from a PDF: its Markdown text, the PDF (library-relative), and
 * the PDF pages it spans (1-based). `pageLabel`/`endPageLabel` are the PDF's
 * own labels for those pages, when it has any.
 */
export type PdfQuoteSource = {
  quote: string;
  path: string;
  page: number;
  pageLabel?: string;
  endPage?: number;
  endPageLabel?: string;
};

/** Window event asking the workspace to quote and cite into the target note. */
export const PDF_QUOTE_CITE_EVENT = "libera:pdf-quote-cite";
export type PdfQuoteCiteDetail = PdfQuoteSource;

function positivePage(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function optionalLabel(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A quote source from untrusted data (a drop, an event); null when it is malformed. */
export function parsePdfQuoteSource(value: unknown): PdfQuoteSource | null {
  let data = value;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { return null; }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const page = positivePage(record.page);
  if (typeof record.quote !== "string" || !record.quote.trim() || typeof record.path !== "string" || !/\.pdf$/i.test(record.path) || !page) return null;
  const endPage = positivePage(record.endPage);
  const source: PdfQuoteSource = { quote: record.quote, path: record.path, page };
  const pageLabel = optionalLabel(record.pageLabel);
  if (pageLabel) source.pageLabel = pageLabel;
  if (endPage && endPage !== page) {
    source.endPage = endPage;
    const endPageLabel = optionalLabel(record.endPageLabel);
    if (endPageLabel) source.endPageLabel = endPageLabel;
  }
  return source;
}

/** The page locator for a quote: "12", or "12–13" when it spans pages. */
export function pdfQuoteLocator(source: Pick<PdfQuoteSource, "page" | "pageLabel" | "endPage" | "endPageLabel">, entry?: Pick<ReferenceEntry, "csl"> | null) {
  const start = source.page;
  const end = source.endPage ?? source.page;
  const labels: (string | undefined)[] = [];
  labels[start - 1] = source.pageLabel;
  labels[end - 1] = end === start ? source.pageLabel : source.endPageLabel;
  // Labels count only when every page of the quote has one; mixing a label
  // with a page index would read as a range of the wrong pages.
  const labelled = Boolean(labels[start - 1] && labels[end - 1]);
  return pdfPagesLocator(start, end, { labels: labelled ? labels : null, printed: entry ? printedRange(entry) : undefined });
}

/** The citation token for a quote: `[@key, p. 12]` or `[@key, pp. 12–13]`. */
export function pdfQuoteCitation(key: string, locator: string) {
  return serializeCitation({ items: [{ key, locator, label: "page" }] });
}

/** Each line of `text` as a blockquote line; blank lines become `>`. */
export function blockquoteLines(text: string) {
  const body = text.replace(/\r\n?/g, "\n").trim();
  return body ? body.split("\n").map((line) => line.trim() ? `> ${line}` : ">").join("\n") : "";
}

/** The quote-and-cite Markdown: the quote as a blockquote, then the citation on its own quoted line. */
export function pdfQuoteMarkdown(quote: string, citation: string) {
  const body = blockquoteLines(quote);
  return body ? `${body}\n>\n> ${citation}` : `> ${citation}`;
}

/** Quote and cite in one step, for `key` (the entry's key in the target notebook). */
export function buildPdfQuoteMarkdown(source: PdfQuoteSource, key: string, entry?: Pick<ReferenceEntry, "csl"> | null) {
  return pdfQuoteMarkdown(source.quote, pdfQuoteCitation(key, pdfQuoteLocator(source, entry)));
}

/** The library entry that has `path` as an attachment; the most recently updated one when several do. */
export function entryForAttachment(library: Pick<ReferenceLibrary, "entries"> | null | undefined, path: string): ReferenceEntry | null {
  if (!library) return null;
  const matches = Object.values(library.entries).filter((entry) => entry.attachments.some((attachment) => attachment.kind !== "url" && attachment.path === path));
  if (!matches.length) return null;
  return matches.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

/** The notebook of a library-relative path. */
export function notebookOfPath(path: string) {
  return path.split("/")[0] ?? "";
}

/**
 * Where a quote goes for a caret or drop point at `offset` in a Markdown
 * source: as its own block, after the paragraph holding the offset. `text` is
 * inserted at `from`; `caret` is the end of the quote in the new text.
 */
export function quoteBlockInsertion(value: string, offset: number, markdown: string) {
  const from = findMarkdownBlockInsertionOffset(value, Math.min(Math.max(0, offset), value.length));
  const insertion = insertMarkdownBlock(value, from, markdown);
  return { from, text: insertion.value.slice(from, insertion.value.length - (value.length - from)), caret: insertion.end, value: insertion.value };
}
