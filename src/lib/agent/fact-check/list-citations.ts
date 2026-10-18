import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { getFileType } from "@/lib/storage/file-types";
import { readFreshPdfTextCache, readPdfTextCache } from "@/lib/storage/pdf-text-cache";
import { getConfiguredMarkdownPreferences } from "@/lib/markdown-preferences-config";
import { resolvedCitationOccurrences, scanCitations } from "@/lib/references/citation-syntax";
import { entryForKey, libraryEntriesByKey } from "@/lib/references/format";
import { loadDocumentStyle } from "@/lib/references/bibliography-export";
import { documentStyleOverride } from "@/lib/references/document-style";
import type { CitationItem, ReferenceEntry, ReferenceLibrary } from "@/lib/references/types";
import type { PdfTextPage } from "@/lib/types";
import { lineOfOffset, missingFileError, ok, readCurrentText, requireString, resolve, ToolError, type AgentTool, type ToolContext } from "../tools";
import { statLibraryPath } from "../library";
import { entryAuthors, entryYear, formatReferences, readNotebookLibrary } from "../references-tool";

// ListCitations: every citation in a Markdown draft, with the claim it
// supports, the works it cites and what is wrong with it before anything is
// read. Deterministic: no model is involved, and the occurrence ids (c1, c2, …)
// are stable for an unchanged document, so a later CheckCitations call (or a
// "Continue" in the next turn) can name them. Narrative citations (`@key`
// in prose) are listed when the library knows the key; an unknown `@word` is
// prose, not a citation (see citation-syntax.ts).
//
// Locators and page numbers. A citation's page locator is a printed page
// number (CSL locators are), while a PDF attachment is read by page index
// (1 … page count, as Read shows "--- Page N ---"). When the entry's CSL
// `page` field gives the work's printed range (say 340–360), printed page p is
// taken to be PDF page p − 340 + 1, assuming the PDF starts at the work's
// first page. A locator counts as in range when it is either a printed page
// within that range or a page index of the PDF; it is flagged
// (`locator-out-of-range`) only when it is neither. Non-page locators
// (chapter, section, figure…) are not checked.

export const CLAIM_SENTENCE_CHARS = 600;
export const CLAIM_PARAGRAPH_CHARS = 1_500;

export type CitationProblemKind = "unknown-key" | "entry-without-attachment" | "locator-out-of-range" | "entry-unresolved" | "entry-retracted";
export type CitationProblem = { kind: CitationProblemKind; key: string; message: string };

export type SourceFile = {
  path: string;
  kind: "pdf" | "markdown";
  /** The file exists in the library. */
  exists: boolean;
  /** PDFs: number of pages, when the text could be extracted. */
  pageCount?: number;
  /** PDFs with pages but no text layer (scanned). */
  noText?: boolean;
};

export type PrintedRange = { first: number; last: number };

export type SourceSummary = {
  entryId: string;
  key: string;
  aliases: string[];
  reference: string;
  title?: string;
  authors: string;
  year?: number;
  status: ReferenceEntry["status"];
  retracted: boolean;
  files: SourceFile[];
  /** Printed page range from the entry's CSL `page`, when it is numeric. */
  printed?: PrintedRange;
};

export type OccurrenceItem = CitationItem & { entryId?: string };

export type CitationOccurrenceInfo = {
  id: string;
  raw: string;
  start: number;
  end: number;
  line: number;
  /** The sentence holding the citation, bounded to CLAIM_SENTENCE_CHARS. */
  claim: string;
  /** Offsets of the full sentence in the document, for suggested rewrites. */
  claimRange: { start: number; end: number };
  /** The block (paragraph, list item, table…) holding the citation, bounded to CLAIM_PARAGRAPH_CHARS. */
  paragraph: string;
  /** Offsets of that block; review comments go after its end. */
  blockRange: { start: number; end: number };
  items: OccurrenceItem[];
  problems: CitationProblem[];
};

export type CitationListing = {
  path: string;
  notebook: string;
  /** The text that was analyzed (an unsaved draft when the file is open with changes). */
  text: string;
  library: ReferenceLibrary;
  occurrences: CitationOccurrenceInfo[];
  /** Cited entries by id. */
  sources: Map<string, SourceSummary>;
};

// ---------------------------------------------------------------------------
// Blocks and sentences
// ---------------------------------------------------------------------------

type Range = { start: number; end: number };
type MarkdownNode = { type: string; children?: MarkdownNode[]; position?: { start?: { offset?: number }; end?: { offset?: number } } };

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const LEAVES = new Set(["paragraph", "heading", "code", "math", "table", "html", "definition"]);

/** The innermost leaf blocks of a Markdown text (paragraphs, headings, tables…), in order. */
export function leafBlocks(text: string): Range[] {
  const blocks: Range[] = [];
  const visit = (node: MarkdownNode) => {
    for (const child of node.children ?? []) {
      const start = child.position?.start?.offset;
      const end = child.position?.end?.offset;
      if (start === undefined || end === undefined) continue;
      if (LEAVES.has(child.type)) blocks.push({ start, end });
      else visit(child);
    }
  };
  visit(parser.parse(text) as MarkdownNode);
  return blocks;
}

function blockAt(blocks: Range[], text: string, offset: number): Range {
  const found = blocks.find((block) => block.start <= offset && offset < block.end);
  if (found) return found;
  // Outside any parsed block (rare): the surrounding line.
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const end = text.indexOf("\n", offset);
  return { start, end: end < 0 ? text.length : end };
}

const ABBREVIATIONS = new Set(["e.g", "i.e", "al", "cf", "fig", "figs", "eq", "eqs", "p", "pp", "vs", "no", "nos", "vol", "vols", "ch", "sec", "dr", "mr", "mrs", "ms", "prof", "ed", "eds", "approx", "ca", "resp", "ref", "refs", "st", "jr", "sr", "tab", "viz"]);

/** Ends of sentences in `text` (offsets just past the closing punctuation), skipping abbreviations, initials and `skip` ranges. */
function sentenceEnds(text: string, skip: Range[]) {
  const ends: number[] = [];
  for (const match of text.matchAll(/[.!?]+["'”’)\]]*(?=\s|$)/g)) {
    const at = match.index;
    if (skip.some((range) => range.start <= at && at < range.end)) continue;
    if (text[at] === ".") {
      const word = /([\p{L}.]+)$/u.exec(text.slice(Math.max(0, at - 12), at))?.[1] ?? "";
      if (ABBREVIATIONS.has(word.toLowerCase()) || /^\p{Lu}$/u.test(word)) continue;
    }
    ends.push(at + match[0].length);
  }
  return ends;
}

function hasWords(text: string) {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length >= 3;
}

function bounded(text: string, focusStart: number, focusEnd: number, limit: number) {
  if (text.length <= limit) return text.trim();
  const room = Math.max(0, limit - (focusEnd - focusStart));
  const start = Math.max(0, Math.min(focusStart - Math.floor(room / 2), text.length - limit));
  const end = Math.min(text.length, start + limit);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/** The sentence around [start, end) within `block`; a citation standing alone after a full stop belongs to the sentence before it. */
export function sentenceRange(text: string, block: Range, citation: Range, citations: Range[]): Range {
  const body = text.slice(block.start, block.end);
  const skip = citations.filter((range) => range.start >= block.start && range.end <= block.end).map((range) => ({ start: range.start - block.start, end: range.end - block.start }));
  const ends = sentenceEnds(body, skip);
  const relativeStart = citation.start - block.start;
  const relativeEnd = citation.end - block.start;
  let startIndex = ends.filter((end) => end <= relativeStart).length;
  const sentenceStart = (index: number) => {
    let offset = index === 0 ? 0 : ends[index - 1];
    while (offset < body.length && /\s/.test(body[offset])) offset++;
    return offset;
  };
  let start = sentenceStart(startIndex);
  const end = ends.find((value) => value >= relativeEnd) ?? body.length;
  // "Claim. [@key]": the citation's own "sentence" has no words besides citations.
  const own = body.slice(start, end);
  const withoutCitations = skip.reduce((value, range) => range.start >= start && range.end <= end ? value.replace(body.slice(range.start, range.end), " ") : value, own);
  if (!hasWords(withoutCitations) && startIndex > 0) {
    startIndex--;
    start = sentenceStart(startIndex);
  }
  return { start: block.start + start, end: block.start + end };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export function printedRange(entry: ReferenceEntry): PrintedRange | undefined {
  const page = typeof entry.csl.page === "string" ? entry.csl.page : typeof entry.csl.page === "number" ? String(entry.csl.page) : "";
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

/** The PDF page index for printed page `page`, when the entry's printed range maps it inside the PDF. */
export function pdfPageForPrinted(source: Pick<SourceSummary, "printed">, pageCount: number | undefined, page: number) {
  if (!source.printed || page < source.printed.first || page > source.printed.last) return undefined;
  const index = page - source.printed.first + 1;
  return pageCount === undefined || index <= pageCount ? index : undefined;
}

/** Whether a locator page fits the source: a printed page in its range, or a page index of its PDF. */
export function locatorPageInRange(source: SourceSummary, page: number) {
  const pdf = source.files.find((file) => file.kind === "pdf" && file.pageCount);
  if (source.printed && page >= source.printed.first && page <= source.printed.last) return true;
  if (!pdf?.pageCount) return true;
  return page >= 1 && page <= pdf.pageCount;
}

async function pdfPages(path: string): Promise<PdfTextPage[] | null> {
  const cached = await readFreshPdfTextCache(path).catch(() => null);
  if (cached) return cached.pages;
  try { return (await readPdfTextCache(path)).pages; }
  catch { return null; }
}

async function sourceFile(context: ToolContext, kind: "pdf" | "markdown", filePath: string): Promise<SourceFile> {
  let resolved;
  try { resolved = await resolve(context, filePath); }
  catch { return { path: filePath, kind, exists: false }; }
  const exists = (await statLibraryPath(resolved).catch(() => null))?.isFile();
  if (!exists) return { path: resolved.path, kind, exists: false };
  if (kind !== "pdf" || getFileType(resolved.path) !== "pdf") return { path: resolved.path, kind: "markdown", exists: true };
  const pages = await pdfPages(resolved.path);
  if (!pages) return { path: resolved.path, kind, exists: true };
  return { path: resolved.path, kind, exists: true, pageCount: pages.length, ...(pages.length && !pages.some((page) => page.text.trim()) ? { noText: true } : {}) };
}

export async function summarizeSources(context: ToolContext, library: ReferenceLibrary, entries: ReferenceEntry[], { styleXml }: { styleXml?: string | null } = {}): Promise<Map<string, SourceSummary>> {
  const references = await formatReferences(library, entries, { styleXml });
  const summaries = new Map<string, SourceSummary>();
  for (const entry of entries) {
    const files: SourceFile[] = [];
    for (const attachment of entry.attachments) {
      if (attachment.kind === "url") continue;
      files.push(await sourceFile(context, attachment.kind, attachment.path));
    }
    const state = entry.retraction?.state;
    summaries.set(entry.id, {
      entryId: entry.id, key: entry.key, aliases: entry.aliases, reference: references.get(entry.id)!,
      ...(entry.csl.title ? { title: entry.csl.title } : {}),
      authors: entryAuthors(entry), ...(entryYear(entry) ? { year: entryYear(entry) } : {}),
      status: entry.status, retracted: state === "retracted" || state === "withdrawn", files,
      ...(printedRange(entry) ? { printed: printedRange(entry) } : {}),
    });
  }
  return summaries;
}

/** Files of a source the checker can read: existing PDFs with a text layer, and Markdown files. */
export function readableFiles(source: SourceSummary) {
  return source.files.filter((file) => file.exists && !file.noText && (file.kind === "markdown" || file.pageCount));
}

// ---------------------------------------------------------------------------
// The listing
// ---------------------------------------------------------------------------

function problemsFor(item: OccurrenceItem, source: SourceSummary | undefined): CitationProblem[] {
  if (!source) return [{ kind: "unknown-key", key: item.key, message: `@${item.key} is not in the notebook's References library.` }];
  const problems: CitationProblem[] = [];
  const readable = readableFiles(source);
  if (!readable.length) {
    const missing = source.files.filter((file) => !file.exists);
    const scanned = source.files.filter((file) => file.noText);
    problems.push({
      kind: "entry-without-attachment", key: item.key,
      message: missing.length ? `@${item.key}'s attached file is missing (${missing.map((file) => file.path).join(", ")}).`
        : scanned.length ? `@${item.key}'s attached PDF has no text layer (${scanned.map((file) => file.path).join(", ")}), so it cannot be read.`
        : `@${item.key} has no attached PDF or Markdown file to check against.`,
    });
  }
  const pdf = source.files.find((file) => file.kind === "pdf" && file.pageCount);
  const outside = locatorPages(item).filter((page) => !locatorPageInRange(source, page));
  if (outside.length && pdf?.pageCount) {
    problems.push({
      kind: "locator-out-of-range", key: item.key,
      message: `p. ${item.locator} is beyond the attached PDF's last page (${pdf.pageCount})${source.printed ? ` and outside the work's printed pages (${source.printed.first}–${source.printed.last})` : ""}.`,
    });
  }
  if (source.status === "unresolved") problems.push({ kind: "entry-unresolved", key: item.key, message: `@${item.key} is unresolved: its metadata was never confirmed against a source.` });
  if (source.retracted) problems.push({ kind: "entry-retracted", key: item.key, message: `@${item.key} has been retracted or withdrawn.` });
  return problems;
}

/** Parses the document (its unsaved draft when open) and lists its citation occurrences. */
export async function listCitations(context: ToolContext, inputPath: string): Promise<CitationListing> {
  const resolved = await resolve(context, inputPath);
  const fileType = getFileType(resolved.path);
  if (fileType !== "markdown") throw new ToolError(`${resolved.path} is not a Markdown file. Citation checks work on Markdown documents that cite with [@key].`);
  const current = await readCurrentText(context, resolved);
  if (!current) return missingFileError(context, resolved);
  const text = current.content;
  const library = await readNotebookLibrary(context, resolved.notebook);
  const byKey = libraryEntriesByKey(library);
  const { inlineMathMarkers, blockMathMarkers } = getConfiguredMarkdownPreferences();
  const found = resolvedCitationOccurrences(scanCitations(text, { mathMarkers: { inlineMathMarkers, blockMathMarkers } }), (key) => Boolean(entryForKey(byKey, key)));
  const cited = new Map<string, ReferenceEntry>();
  for (const occurrence of found) {
    for (const item of occurrence.citation.items) {
      const entry = Object.prototype.hasOwnProperty.call(byKey, item.key) ? byKey[item.key] : undefined;
      if (entry) cited.set(entry.id, entry);
    }
  }
  // References are shown in the document's own style (`citation-style` in its front matter) when it has one.
  const styleXml = documentStyleOverride(text) && cited.size ? (await loadDocumentStyle(resolved.notebook, text, library.style)).xml : null;
  const sources = await summarizeSources(context, library, [...cited.values()], { styleXml });
  const blocks = leafBlocks(text);
  const ranges = found.map((occurrence) => ({ start: occurrence.start, end: occurrence.end }));
  const occurrences = found.map((occurrence, index): CitationOccurrenceInfo => {
    const block = blockAt(blocks, text, occurrence.start);
    const sentence = sentenceRange(text, block, occurrence, ranges);
    const items = occurrence.citation.items.map((item): OccurrenceItem => {
      const entry = Object.prototype.hasOwnProperty.call(byKey, item.key) ? byKey[item.key] : undefined;
      return { ...item, ...(entry ? { entryId: entry.id } : {}) };
    });
    const problems = items.flatMap((item) => problemsFor(item, item.entryId ? sources.get(item.entryId) : undefined));
    return {
      id: `c${index + 1}`, raw: occurrence.citation.raw, start: occurrence.start, end: occurrence.end, line: lineOfOffset(text, occurrence.start),
      claim: bounded(text.slice(sentence.start, sentence.end), occurrence.start - sentence.start, occurrence.end - sentence.start, CLAIM_SENTENCE_CHARS),
      claimRange: sentence,
      paragraph: bounded(text.slice(block.start, block.end), occurrence.start - block.start, occurrence.end - block.start, CLAIM_PARAGRAPH_CHARS),
      blockRange: block, items, problems,
    };
  });
  return { path: resolved.path, notebook: resolved.notebook, text, library, occurrences, sources };
}

export function describeFile(file: SourceFile, source?: SourceSummary) {
  if (!file.exists) return `${file.path} (missing)`;
  if (file.kind === "markdown") return file.path;
  if (file.noText) return `${file.path} (${file.pageCount} pages, no text layer)`;
  if (!file.pageCount) return `${file.path} (text not extractable)`;
  const printed = source?.printed && source.printed.last - source.printed.first + 1 <= file.pageCount + 2
    ? `; printed pages ${source.printed.first}–${source.printed.last} are PDF pages 1–${source.printed.last - source.printed.first + 1}` : "";
  return `${file.path} (${file.pageCount} page${file.pageCount === 1 ? "" : "s"}${printed})`;
}

function describeItem(item: OccurrenceItem, listing: CitationListing) {
  const source = item.entryId ? listing.sources.get(item.entryId) : undefined;
  const locator = item.locator ? ` (${item.label && item.label !== "page" ? `${item.label} ` : "p. "}${item.locator})` : "";
  if (!source) return `@${item.key}${locator} → not in the library`;
  const files = source.files.length ? source.files.map((file) => describeFile(file, source)).join(", ") : "no attached file";
  return `@${item.key}${locator} → ${source.reference} · ${source.status} · ${files}`;
}

/** The ListCitations result text. */
export function formatListing(listing: CitationListing, only?: Set<string>) {
  const occurrences = only ? listing.occurrences.filter((occurrence) => only.has(occurrence.id)) : listing.occurrences;
  const works = new Set(listing.occurrences.flatMap((occurrence) => occurrence.items.map((item) => item.entryId ?? `?${item.key}`)));
  const problems = listing.occurrences.reduce((sum, occurrence) => sum + occurrence.problems.length, 0);
  const header = `Citations in ${listing.path}: ${listing.occurrences.length} occurrence${listing.occurrences.length === 1 ? "" : "s"} citing ${works.size} work${works.size === 1 ? "" : "s"}; ${problems} static problem${problems === 1 ? "" : "s"}. The library of "${listing.notebook}" has ${Object.keys(listing.library.entries).length} entries.`;
  if (!listing.occurrences.length) return `${header}\nThere is nothing to fact-check: the document has no [@key] citations.`;
  const body = occurrences.map((occurrence) => [
    `${occurrence.id} · line ${occurrence.line} · ${occurrence.raw}`,
    `  Claim: “${occurrence.claim}”`,
    ...occurrence.items.map((item) => `  - ${describeItem(item, listing)}`),
    ...occurrence.problems.map((problem) => `  ! ${problem.kind}: ${problem.message}`),
  ].join("\n"));
  return [header, ...body].join("\n\n");
}

export const listCitationsTool: AgentTool = {
  name: "ListCitations",
  kind: "read",
  description: `Lists every citation in a Markdown document, for the fact-check-citations skill. Deterministic and fast; nothing is checked against the sources yet.

Usage:
- path is the document's library path. Its unsaved draft is used when it is open with changes.
- Bracketed citations ([@key, p. 3]) are listed, and narrative ones (@key or @key [p. 3] in the text) when the key is in the library.
- Each occurrence gets an id (c1, c2, …), stable while the document is unchanged; pass these ids to CheckCitations.
- For each: the line, the claim (the sentence holding the citation), the cited works with their formatted reference, status and attached files (page counts for PDFs), and static problems: unknown-key, entry-without-attachment, locator-out-of-range, entry-unresolved, entry-retracted.`,
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Library path of the Markdown document." } },
    required: ["path"],
    additionalProperties: false,
  },
  describe: (args) => `Listing the citations in ${String(args.path ?? "the document")}`,
  async run(args, context) {
    const listing = await listCitations(context, requireString(args, "path"));
    const text = formatListing(listing);
    const problems = listing.occurrences.reduce((sum, occurrence) => sum + occurrence.problems.length, 0);
    return ok(text, `${listing.occurrences.length} citation${listing.occurrences.length === 1 ? "" : "s"}${problems ? `, ${problems} problem${problems === 1 ? "" : "s"}` : ""}`, text.slice(0, 1_500));
  },
};
