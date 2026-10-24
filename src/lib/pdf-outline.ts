// A PDF's outline: its own bookmarks when it has them, or one the AI Agent
// generates (the generate-pdf-outline skill) into a side-car file. The
// Outlines tab shows either. This module holds what the server and the
// browser share: the entry and file types, the events between the tab and the
// AI panel, and the pure parts of generation — planning page chunks, matching
// titles to page text, stitching chunk results into one outline, and the
// verification whose problems go back to the agent. Keep free of Node imports.

export const PDF_OUTLINE_VERSION = 1;
export const MAX_OUTLINE_ENTRIES = 3_000;
export const MAX_OUTLINE_LEVEL = 6;
export const MAX_OUTLINE_TITLE_CHARS = 300;

export type PdfOutlineEntry = {
  id: string;
  title: string;
  /** 1 is the top level. */
  level: number;
  /** 1-based page. Embedded bookmarks that point nowhere (or to a web page) have none. */
  page?: number;
  /** Embedded bookmarks: where on the page it points, as a fraction of the page height from the top. */
  top?: number;
  /** Generated entries: the heading's number as printed ("2.3", "A.1", "IV"). */
  numbering?: string;
  /** Generated entries: the title was not found in the page's extracted text. */
  unverified?: boolean;
};

export type OutlineProblemCode =
  | "order"
  | "level"
  | "numbering-parent"
  | "numbering-depth"
  | "numbering-order"
  | "duplicate"
  | "page-range"
  | "not-outlined"
  | "title-not-found"
  | "numbering-gap"
  | "sparse";

export type OutlineProblem = {
  code: OutlineProblemCode;
  /** Errors break the outline's order or hierarchy; warnings may be fine. */
  severity: "error" | "warning";
  message: string;
  /** The entry it is about. */
  id?: string;
  /** The pages it is about (missing or sparse ranges). */
  pages?: { from: number; to: number };
};

export type PdfOutlineFile = {
  version: typeof PDF_OUTLINE_VERSION;
  documentPath: string;
  generatedAt: string;
  /** Set when the agent amended the outline after generating it. */
  updatedAt?: string;
  model?: string;
  /** The PDF's identity when the outline was written, to tell when it changed since. */
  source: { size: number; contentHash: string } | null;
  pageCount: number;
  entries: PdfOutlineEntry[];
  /** What the last verification found and the agent left. */
  problems: OutlineProblem[];
};

export type PdfOutlinePayload = {
  path: string;
  /** The PDF's own bookmarks, flattened in order; empty when it has none. */
  embedded: PdfOutlineEntry[];
  /** Why the bookmarks could not be read, when they could not. */
  embeddedError?: string;
  generated: PdfOutlineFile | null;
  /** The PDF changed since the generated outline was written. */
  stale: boolean;
};

/** Ask the AI Agent to generate a PDF's outline. */
export const PDF_OUTLINE_REQUEST_EVENT = "libera:pdf-outline-request";
export type PdfOutlineRequestDetail = { path: string; requestId: string };

/** The agent run a request started has ended; `error` when it did not start or failed. */
export const PDF_OUTLINE_RUN_FINISHED_EVENT = "libera:pdf-outline-run-finished";
export type PdfOutlineRunFinishedDetail = { requestId: string; error?: string };

/** A run saved a PDF's outline. */
export const PDF_OUTLINE_UPDATED_EVENT = "libera:pdf-outline-updated";
export type PdfOutlineUpdatedDetail = { path: string };

/** The first message of a run started from the Outlines tab. */
export function pdfOutlinePrompt(path: string) {
  return `Generate an outline for ${path}.`;
}

// ---------------------------------------------------------------------------
// Reading entries and files
// ---------------------------------------------------------------------------

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** A title as shown: one line, without dot leaders or a trailing page number. */
export function cleanOutlineTitle(value: unknown) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\s+/g, " ")
    .replace(/(?:\s*\.){3,}\s*\d*\s*$/, "")
    .trim()
    .slice(0, MAX_OUTLINE_TITLE_CHARS);
}

export function normalizeOutlineEntry(value: unknown, fallbackId: string): PdfOutlineEntry | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const title = cleanOutlineTitle(input.title);
  if (!title) return null;
  const level = Math.min(MAX_OUTLINE_LEVEL, positiveInteger(input.level) ?? 1);
  const page = positiveInteger(input.page);
  const top = typeof input.top === "number" && Number.isFinite(input.top) ? Math.min(1, Math.max(0, input.top)) : undefined;
  const numbering = typeof input.numbering === "string" && input.numbering.trim() ? input.numbering.trim().slice(0, 24) : undefined;
  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id.trim().slice(0, 32) : fallbackId,
    title,
    level,
    ...(page ? { page } : {}),
    ...(top !== undefined ? { top } : {}),
    ...(numbering ? { numbering } : {}),
    ...(input.unverified === true ? { unverified: true } : {}),
  };
}

const PROBLEM_CODES: readonly OutlineProblemCode[] = ["order", "level", "numbering-parent", "numbering-depth", "numbering-order", "duplicate", "page-range", "not-outlined", "title-not-found", "numbering-gap", "sparse"];

function normalizeProblem(value: unknown): OutlineProblem | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (!PROBLEM_CODES.includes(input.code as OutlineProblemCode) || typeof input.message !== "string") return null;
  const pages = input.pages as { from?: unknown; to?: unknown } | undefined;
  const from = positiveInteger(pages?.from);
  const to = positiveInteger(pages?.to);
  return {
    code: input.code as OutlineProblemCode,
    severity: input.severity === "warning" ? "warning" : "error",
    message: input.message.slice(0, 600),
    ...(typeof input.id === "string" ? { id: input.id.slice(0, 32) } : {}),
    ...(from && to ? { pages: { from, to } } : {}),
  };
}

/** A side-car read from disk; null when it is not an outline file. */
export function parsePdfOutlineFile(value: unknown): PdfOutlineFile | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (input.version !== PDF_OUTLINE_VERSION || !Array.isArray(input.entries)) return null;
  const source = input.source as { size?: unknown; contentHash?: unknown } | null | undefined;
  const entries: PdfOutlineEntry[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of input.entries.slice(0, MAX_OUTLINE_ENTRIES).entries()) {
    const entry = normalizeOutlineEntry(raw, `o${index + 1}`);
    if (!entry) continue;
    if (ids.has(entry.id)) entry.id = `o${index + 1}-${ids.size}`;
    ids.add(entry.id);
    entries.push(entry);
  }
  return {
    version: PDF_OUTLINE_VERSION,
    documentPath: typeof input.documentPath === "string" ? input.documentPath : "",
    generatedAt: typeof input.generatedAt === "string" ? input.generatedAt : "",
    ...(typeof input.updatedAt === "string" ? { updatedAt: input.updatedAt } : {}),
    ...(typeof input.model === "string" ? { model: input.model } : {}),
    source: source && typeof source.size === "number" && typeof source.contentHash === "string" ? { size: source.size, contentHash: source.contentHash } : null,
    pageCount: positiveInteger(input.pageCount) ?? 0,
    entries,
    problems: Array.isArray(input.problems) ? input.problems.map(normalizeProblem).filter((problem): problem is OutlineProblem => !!problem).slice(0, 200) : [],
  };
}

// ---------------------------------------------------------------------------
// Matching titles to page text
// ---------------------------------------------------------------------------

const LIGATURES: Record<string, string> = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" };

/** Letters and digits only, lower-cased, without accents or ligatures: how titles are matched to PDF text. */
export function compactOutlineText(value: string) {
  return value
    .replace(/[ﬀ-ﬆ]/g, (character) => LIGATURES[character] ?? character)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Long titles are matched by their start: PDF text wraps and hyphenates them. */
const MATCHED_PREFIX = 48;

/** Whether a title is in a page's text (given compacted), ignoring spacing, punctuation, case and hyphenation. */
export function titleInCompactText(title: string, compactPage: string) {
  if (!compactPage) return false;
  const candidates = [compactOutlineText(title), compactOutlineText(stripNumbering(title))];
  return candidates.some((candidate) => candidate.length >= 3 && compactPage.includes(candidate.slice(0, MATCHED_PREFIX)));
}

export function titleOnPage(title: string, pageText: string) {
  return titleInCompactText(title, compactOutlineText(pageText));
}

// ---------------------------------------------------------------------------
// Numbering
// ---------------------------------------------------------------------------

export type OutlineNumbering = {
  /** Parts ("Part II") are numbered apart from chapters and sections. */
  scheme: "part" | "section";
  /** "2.3.1" → ["2", "3", "1"]. */
  parts: string[];
};

const ROMAN = /^(?=[ivxlc]+$)c{0,3}(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/i;
const LEAD = /^(part|chapter|chap\.|ch\.|section|sect\.|§|appendix|annex)?\s*([0-9]{1,3}|[ivxlc]{1,7}|[a-z])((?:\.[0-9]{1,3})*)(?=([.:)]|\s|$))/i;

/**
 * A heading's number, from the entry's `numbering` or the start of its title:
 * "2.3 Results", "Chapter 4", "Part II", "Appendix B", "A.1 Proofs",
 * "IV. Discussion". Conservative: a bare capital or Roman numeral counts only
 * when a period or colon follows it ("A Survey…" and "I Think" are titles).
 */
export function parseNumbering(title: string, explicit?: string): OutlineNumbering | null {
  for (const source of explicit ? [explicit, title] : [title]) {
    const match = LEAD.exec(source.trim());
    if (!match) continue;
    const keyword = match[1]?.toLowerCase() ?? "";
    const first = match[2];
    const dotted = match[3] ? match[3].split(".").filter(Boolean) : [];
    const after = match[4] ?? "";
    const rest = source.trim().slice(match[0].length).replace(/^[.:)]/, "").trim();
    const isDigits = /^\d+$/.test(first);
    const isRoman = !isDigits && ROMAN.test(first);
    const isLetter = !isDigits && first.length === 1 && /[a-z]/i.test(first);
    if (!isDigits && !isRoman && !isLetter) continue;
    if (!keyword && source === title) {
      // A bare number needs a title after it; letters and numerals need punctuation or sub-numbers.
      if (!rest && !dotted.length) continue;
      if (!isDigits && !dotted.length && !/[.:]/.test(after)) continue;
      if (isLetter && !dotted.length && first === first.toLowerCase()) continue;
    }
    return { scheme: keyword === "part" ? "part" : "section", parts: [first, ...dotted] };
  }
  return null;
}

/** A title without its leading number ("2.3 Results" → "Results"). */
export function stripNumbering(title: string) {
  const match = LEAD.exec(title.trim());
  if (!match || !parseNumbering(title)) return title.trim();
  return title.trim().slice(match[0].length).replace(/^[.:)\s–—-]+/, "").trim() || title.trim();
}

function romanValue(value: string) {
  const digits: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 };
  let total = 0;
  const lower = value.toLowerCase();
  for (let index = 0; index < lower.length; index++) {
    const current = digits[lower[index]] ?? 0;
    const next = digits[lower[index + 1]] ?? 0;
    total += current < next ? -current : current;
  }
  return total;
}

/** A number part's value and kind, to tell siblings' order. */
function partValue(part: string): { kind: "digit" | "roman" | "letter"; value: number } {
  if (/^\d+$/.test(part)) return { kind: "digit", value: Number(part) };
  if (part.length === 1 && /[a-hj-uw-z]/i.test(part)) return { kind: "letter", value: part.toLowerCase().charCodeAt(0) - 96 };
  if (ROMAN.test(part)) return { kind: "roman", value: romanValue(part) };
  return { kind: "letter", value: part.toLowerCase().charCodeAt(0) - 96 };
}

const sameParts = (left: string[], right: string[]) => left.length === right.length && left.every((part, index) => part.toLowerCase() === right[index].toLowerCase());

// ---------------------------------------------------------------------------
// Planning chunks
// ---------------------------------------------------------------------------

export type OutlinePage = { pageNumber: number; text: string };
export type PageRange = { from: number; to: number };

export const OUTLINE_CHUNK_PAGES = 12;
export const OUTLINE_CHUNK_CHARS = 40_000;

/** Contiguous page ranges of at most `maxPages` pages and about `maxChars` characters. */
export function planOutlineChunks(pages: OutlinePage[], { maxPages = OUTLINE_CHUNK_PAGES, maxChars = OUTLINE_CHUNK_CHARS, range }: { maxPages?: number; maxChars?: number; range?: PageRange } = {}): PageRange[] {
  const chunks: PageRange[] = [];
  let current: (PageRange & { chars: number }) | null = null;
  for (const page of pages) {
    if (range && (page.pageNumber < range.from || page.pageNumber > range.to)) continue;
    const chars = page.text.length;
    if (current && (current.to - current.from + 1 >= maxPages || current.chars + chars > maxChars)) {
      chunks.push({ from: current.from, to: current.to });
      current = null;
    }
    if (!current) current = { from: page.pageNumber, to: page.pageNumber, chars: 0 };
    current.to = page.pageNumber;
    current.chars += chars;
  }
  if (current) chunks.push({ from: current.from, to: current.to });
  return chunks;
}

const TOC_LINE = /\S.*?(?:\.{2,}|…|\s)\s*(?:\d{1,4}|[ivxlc]{1,6})\s*$/i;

/**
 * The printed table of contents, when the first pages have one: a run of at
 * most `limit` pages where most lines end in a page number. Every chunk gets
 * it, so chunks outlined apart agree on titles and levels.
 */
export function tableOfContentsPages(pages: OutlinePage[], limit = 4): number[] {
  const isToc = (page: OutlinePage) => {
    const lines = page.text.split("\n").map((line) => line.trim()).filter(Boolean);
    const entries = lines.filter((line) => TOC_LINE.test(line) && /\p{L}{3}/u.test(line)).length;
    const titled = /^\s*(?:table of )?contents\b/im.test(page.text);
    return entries >= (titled ? 5 : 8) && entries >= lines.length * (titled ? 0.3 : 0.5);
  };
  const result: number[] = [];
  for (const page of pages.slice(0, 30)) {
    if (isToc(page)) result.push(page.pageNumber);
    else if (result.length) break;
    if (result.length >= limit) break;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Stitching
// ---------------------------------------------------------------------------

/** An entry as a chunk's outliner (or the agent) gives it, before ids. */
export type OutlineDraft = { title: string; level: number; page: number; numbering?: string; unverified?: boolean };

/** One chunk's entries. `fixed` chunks (kept from a saved outline) are not re-levelled. */
export type OutlineChunkResult = { range: PageRange; entries: OutlineDraft[]; fixed?: boolean };

function mode(values: number[]) {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: { value: number; count: number } | null = null;
  for (const [value, count] of counts) if (!best || count > best.count) best = { value, count };
  return best;
}

/**
 * How far a kind of number sits from its depth across the outline: offset 0
 * puts "3" at level 1 and "3.2" at level 2; offset 1 puts them one deeper
 * (chapters under parts). Most votes win; a tie goes to the shallower offset.
 */
function numberingOffsets(entries: Array<{ title: string; level: number; numbering?: string }>, weights?: number[]) {
  const votes = new Map<OutlineNumbering["scheme"], Map<number, number>>();
  entries.forEach((entry, index) => {
    const numbering = parseNumbering(entry.title, entry.numbering);
    if (!numbering) return;
    const counts = votes.get(numbering.scheme) ?? new Map<number, number>();
    const offset = entry.level - numbering.parts.length;
    counts.set(offset, (counts.get(offset) ?? 0) + (weights?.[index] ?? 1));
    votes.set(numbering.scheme, counts);
  });
  const offsets = new Map<OutlineNumbering["scheme"], { offset: number; count: number; total: number }>();
  for (const [scheme, counts] of votes) {
    let total = 0;
    let best: { offset: number; count: number } | null = null;
    for (const [offset, count] of counts) {
      total += count;
      if (!best || count > best.count || (count === best.count && offset < best.offset)) best = { offset, count };
    }
    if (best) offsets.set(scheme, { ...best, total });
  }
  return offsets;
}

const clampLevel = (level: number) => Math.min(MAX_OUTLINE_LEVEL, Math.max(1, Math.round(level)));
const describeRange = (range: PageRange) => range.from === range.to ? `page ${range.from}` : `pages ${range.from}–${range.to}`;

/**
 * Joins chunk results, in page order, into one outline: drops repeats at chunk
 * edges, shifts a chunk's levels when its numbered headings disagree with the
 * rest (a chunk that starts mid-chapter cannot know the chapter's level),
 * makes the top level 1 and closes level jumps. Returns what it changed, for
 * the agent to check.
 */
export function stitchOutline(chunks: OutlineChunkResult[]): { entries: OutlineDraft[]; notes: string[] } {
  const notes: string[] = [];
  const ordered = [...chunks].sort((left, right) => left.range.from - right.range.from);

  // Repeats: the same title on the same page (chunk edges, or an outliner listing it twice).
  const flat: Array<{ entry: OutlineDraft; chunk: OutlineChunkResult }> = [];
  const seen = new Set<string>();
  for (const chunk of ordered) {
    for (const raw of chunk.entries) {
      const entry = { ...raw, title: cleanOutlineTitle(raw.title), level: clampLevel(raw.level) };
      const key = `${entry.page}:${compactOutlineText(entry.title)}`;
      if (!entry.title || seen.has(key)) continue;
      seen.add(key);
      flat.push({ entry, chunk });
    }
  }

  // A chunk whose numbered headings sit at another depth than elsewhere is shifted as a whole.
  const offsets = numberingOffsets(flat.map(({ entry }) => entry), flat.map(({ chunk }) => chunk.fixed ? 3 : 1));
  for (const chunk of ordered) {
    if (chunk.fixed) continue;
    const deltas: number[] = [];
    for (const { entry, chunk: owner } of flat) {
      if (owner !== chunk) continue;
      const numbering = parseNumbering(entry.title, entry.numbering);
      const target = numbering && offsets.get(numbering.scheme);
      if (target && target.count >= 2) deltas.push(target.offset - (entry.level - numbering.parts.length));
    }
    const best = mode(deltas);
    if (best && best.value !== 0 && best.count * 2 > deltas.length) {
      for (const item of flat) if (item.chunk === chunk) item.entry.level = clampLevel(item.entry.level + best.value);
      notes.push(`Shifted the levels in ${describeRange(chunk.range)} by ${best.value > 0 ? "+" : ""}${best.value} to match how the same numbering is levelled elsewhere.`);
    }
  }

  const entries = flat.map(({ entry }) => entry).sort((left, right) => left.page - right.page);

  const minimum = entries.reduce((lowest, entry) => Math.min(lowest, entry.level), MAX_OUTLINE_LEVEL);
  if (entries.length && minimum > 1) {
    for (const entry of entries) entry.level -= minimum - 1;
    notes.push(`Raised every entry by ${minimum - 1} level${minimum - 1 === 1 ? "" : "s"} so the top level is 1.`);
  }
  let previous = 0;
  for (const entry of entries) {
    if (entry.level > previous + 1) {
      notes.push(`“${entry.title.slice(0, 80)}” (page ${entry.page}) was level ${entry.level} right after a level-${previous} entry; it is now level ${previous + 1}.`);
      entry.level = previous + 1;
    }
    previous = entry.level;
  }
  return { entries, notes };
}

/** Ids for a stitched outline: "o1", "o2", … */
export function withOutlineIds(entries: OutlineDraft[], first = 1): PdfOutlineEntry[] {
  return entries.map((entry, index) => ({
    id: `o${first + index}`,
    title: entry.title,
    level: entry.level,
    page: entry.page,
    ...(entry.numbering ? { numbering: entry.numbering } : {}),
    ...(entry.unverified ? { unverified: true } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type VerifyOutlineOptions = {
  pageCount: number;
  /** Page texts by page number, to check titles. */
  pageText?: (page: number) => string | undefined;
  /** Pages no outliner covered, and why. */
  notOutlined?: Array<PageRange & { reason: string }>;
};

const label = (entry: PdfOutlineEntry) => `“${entry.title.slice(0, 80)}” (${entry.id}, page ${entry.page ?? "?"})`;

/** The pages without an entry that count as a suspicious gap. */
function sparseThreshold(pageCount: number) {
  return Math.max(25, Math.ceil(pageCount * 0.2));
}

/**
 * Checks a whole outline: order, hierarchy, numbering against hierarchy,
 * repeats, pages, titles against the page text, and coverage. Errors break
 * the outline; warnings are worth a look but may be right.
 */
export function verifyOutline(entries: PdfOutlineEntry[], options: VerifyOutlineOptions): OutlineProblem[] {
  const problems: OutlineProblem[] = [];
  const compactPages = new Map<number, string>();
  const compactPage = (page: number) => {
    if (!compactPages.has(page)) compactPages.set(page, compactOutlineText(options.pageText?.(page) ?? ""));
    return compactPages.get(page)!;
  };

  for (const range of options.notOutlined ?? []) {
    problems.push({ code: "not-outlined", severity: "error", pages: { from: range.from, to: range.to }, message: `${describeRange(range)[0].toUpperCase()}${describeRange(range).slice(1)} were not outlined: ${range.reason}. Call GenerateOutline with pages "${range.from}-${range.to}" to outline them.` });
  }

  const numberings = entries.map((entry) => parseNumbering(entry.title, entry.numbering));
  const offsets = numberingOffsets(entries);
  const seen = new Map<string, PdfOutlineEntry>();
  let previous: PdfOutlineEntry | null = null;

  entries.forEach((entry, index) => {
    if (entry.page === undefined || entry.page < 1 || entry.page > options.pageCount) {
      problems.push({ code: "page-range", severity: "error", id: entry.id, message: `${label(entry)} points outside the PDF, which has ${options.pageCount} pages.` });
    }
    if (!previous && entry.level !== 1) {
      problems.push({ code: "level", severity: "error", id: entry.id, message: `${label(entry)} is the first entry but level ${entry.level}; the outline must start at level 1.` });
    } else if (previous && entry.level > previous.level + 1) {
      problems.push({ code: "level", severity: "error", id: entry.id, message: `${label(entry)} is level ${entry.level} right after ${label(previous)} at level ${previous.level}; a level can only go one deeper at a time.` });
    }
    if (previous?.page !== undefined && entry.page !== undefined && entry.page < previous.page) {
      problems.push({ code: "order", severity: "error", id: entry.id, message: `${label(entry)} comes after ${label(previous)}, which is on a later page. Entries must follow the pages.` });
    }
    const key = `${entry.page}:${compactOutlineText(entry.title)}`;
    const repeat = seen.get(key);
    if (repeat) problems.push({ code: "duplicate", severity: "error", id: entry.id, message: `${label(entry)} repeats ${label(repeat)}.` });
    else seen.set(key, entry);

    if (entry.page !== undefined && options.pageText) {
      const text = compactPage(entry.page);
      if (text && !titleInCompactText(entry.title, text)) {
        problems.push({ code: "title-not-found", severity: "warning", id: entry.id, message: `${label(entry)} is not in page ${entry.page}'s text. Check the page and the exact title, or delete the entry if it is not a heading.` });
      }
    }

    const numbering = numberings[index];
    if (numbering) {
      const expected = offsets.get(numbering.scheme);
      const expectedLevel = expected ? numbering.parts.length + expected.offset : entry.level;
      if (expected && expectedLevel !== entry.level && expectedLevel >= 1 && expected.count >= 2 && expected.count >= expected.total * 0.6) {
        problems.push({ code: "numbering-depth", severity: "error", id: entry.id, message: `${label(entry)} is level ${entry.level}, but elsewhere ${numbering.parts.length}-part numbers like ${numbering.parts.join(".")} are level ${expectedLevel}.` });
      }
      // The parent: the nearest earlier entry one level up.
      let parentIndex = -1;
      for (let candidate = index - 1; candidate >= 0; candidate--) {
        if (entries[candidate].level < entry.level) { parentIndex = candidate; break; }
      }
      const parent = parentIndex >= 0 ? entries[parentIndex] : null;
      const parentNumbering = parentIndex >= 0 ? numberings[parentIndex] : null;
      if (numbering.parts.length > 1 && numbering.scheme === "section" && parent && parentNumbering?.scheme === "section" && !sameParts(parentNumbering.parts, numbering.parts.slice(0, -1))) {
        problems.push({ code: "numbering-parent", severity: "error", id: entry.id, message: `${label(entry)} is numbered ${numbering.parts.join(".")} but sits under ${label(parent)}; it belongs under ${numbering.parts.slice(0, -1).join(".")}.` });
      }
      // The previous sibling with the same kind of number.
      for (let candidate = index - 1; candidate > parentIndex; candidate--) {
        if (entries[candidate].level !== entry.level) continue;
        const sibling = numberings[candidate];
        // Only numbers under the same parent number are a sequence ("2.1", "2.2"); the parent check covers the rest.
        if (!sibling || sibling.scheme !== numbering.scheme || sibling.parts.length !== numbering.parts.length || !sameParts(sibling.parts.slice(0, -1), numbering.parts.slice(0, -1))) break;
        const before = partValue(sibling.parts.at(-1)!);
        const after = partValue(numbering.parts.at(-1)!);
        if (before.kind !== after.kind) break;
        if (after.value <= before.value) {
          problems.push({ code: "numbering-order", severity: "error", id: entry.id, message: `${label(entry)} is numbered ${numbering.parts.join(".")} after ${label(entries[candidate])}, numbered ${sibling.parts.join(".")}.` });
        } else if (after.value > before.value + 1) {
          problems.push({ code: "numbering-gap", severity: "warning", id: entry.id, message: `${label(entry)} follows ${sibling.parts.join(".")}; is a heading between them missing?` });
        }
        break;
      }
    }
    previous = entry;
  });

  // Long stretches without an entry, where headings may have been missed.
  const pages = entries.map((entry) => entry.page).filter((page): page is number => page !== undefined).sort((left, right) => left - right);
  const threshold = sparseThreshold(options.pageCount);
  const uncovered = (from: number, to: number) => (options.notOutlined ?? []).some((range) => range.from <= to && range.to >= from);
  for (let index = 0; index < pages.length; index++) {
    const from = pages[index] + 1;
    const to = (pages[index + 1] ?? options.pageCount + 1) - 1;
    if (to - from + 1 >= threshold && !uncovered(from, to)) {
      problems.push({ code: "sparse", severity: "warning", pages: { from, to }, message: `Pages ${from}–${to} have no outline entry. Check them for missed headings.` });
    }
  }
  return problems;
}

export const outlineErrors = (problems: OutlineProblem[]) => problems.filter((problem) => problem.severity === "error");

// ---------------------------------------------------------------------------
// Showing
// ---------------------------------------------------------------------------

/** One line per entry, as the agent sees the outline: "o3 · L2 · p. 4 · 1.1 Background". */
export function describeOutlineEntry(entry: PdfOutlineEntry) {
  return `${entry.id} · L${entry.level} · p. ${entry.page ?? "?"} · ${"  ".repeat(Math.max(0, entry.level - 1))}${entry.title}${entry.unverified ? " (title not found on the page)" : ""}`;
}

export type OutlineRow = { entry: PdfOutlineEntry; hasChildren: boolean; expanded: boolean };

/**
 * The rows the Outlines tab shows: everything when searching, otherwise the
 * entries whose ancestors are all expanded. `expanded` overrides the default
 * (expanded above `expansionLevel`) per entry id.
 */
export function visibleOutlineRows(entries: PdfOutlineEntry[], { query = "", expansionLevel = 2, expanded = {} }: { query?: string; expansionLevel?: number; expanded?: Record<string, boolean> } = {}): OutlineRow[] {
  const needle = compactOutlineText(query);
  const rows: OutlineRow[] = [];
  let collapsedLevel: number | null = null;
  entries.forEach((entry, index) => {
    const hasChildren = (entries[index + 1]?.level ?? 0) > entry.level;
    const isExpanded = expanded[entry.id] ?? entry.level < expansionLevel;
    if (needle) {
      if (compactOutlineText(entry.title).includes(needle) || String(entry.page ?? "") === query.trim()) rows.push({ entry, hasChildren: false, expanded: isExpanded });
      return;
    }
    if (collapsedLevel !== null && entry.level > collapsedLevel) return;
    collapsedLevel = hasChildren && !isExpanded ? entry.level : null;
    rows.push({ entry, hasChildren, expanded: isExpanded });
  });
  return rows;
}

/** The entry for the page in view: the last one starting on or before it. */
export function currentOutlineEntryId(entries: PdfOutlineEntry[], page: number | undefined) {
  if (!page) return null;
  // Embedded bookmarks need not follow the pages, so look at them all.
  let current: PdfOutlineEntry | null = null;
  for (const entry of entries) {
    if (entry.page === undefined || entry.page > page) continue;
    if (!current || entry.page >= current.page!) current = entry;
  }
  return current?.id ?? null;
}
