import { getFileType } from "@/lib/storage/file-types";
import { readPdfTextCache } from "@/lib/storage/pdf-text-cache";
import type { PdfTextPage } from "@/lib/types";
import { approximateMatch, type QuoteMatch } from "../approximate-match";
import { lineOfOffset, readCurrentText, resolve, type ToolContext } from "../tools";

export type { QuoteMatch };

// Evidence verification (anti-hallucination). A checker's verdict counts only
// with quotes that are really in the cited source, so every quote is looked
// up deterministically before anything reaches the user:
//
// - PDFs: in the page text from the PDF text cache, on the page the checker
//   named. A quote found on the next or previous page, or across a page break
//   (it starts at the end of one page and ends on the next), is kept with its
//   page corrected; found only on another page, or nowhere, it is dropped.
//   Without a page, the quote is located and its page filled in.
// - Markdown and text files: in the file (the user's unsaved draft when it is
//   open); its line is filled in.
// - Matching ignores case, whitespace, curly versus straight quotes, dash
//   variants, ligatures (NFKC), soft hyphens and words hyphenated across a
//   line break ("evi-\ndence" = "evidence"). It then allows small differences
//   such as OCR errors: the quote's best approximate occurrence (edit distance
//   against any substring of the source) must reach QUOTE_MATCH_THRESHOLD,
//   i.e. at most 15% of the quote's characters may differ. Quotes shorter than
//   MIN_FUZZY_CHARS (after normalization) must match exactly. A quote with an
//   ellipsis ("… " or "...") is split there and each part must match.
// - Web quotes are kept only when their URL is one the WebSearch tool returned
//   as a cited page during the check; they are always labelled web evidence.

export const QUOTE_MATCH_THRESHOLD = 0.85;
export const MIN_FUZZY_CHARS = 20;
/** Quotes are compared on at most this many normalized characters (the start of a longer quote). */
const MAX_COMPARED_CHARS = 800;

export type EvidenceQuote = { path: string; page?: number; line?: number; quote: string };
export type VerifiedEvidence = EvidenceQuote & { ratio: number; pageCorrected?: { from: number; to: number } };
export type DroppedEvidence = EvidenceQuote & { reason: string };
export type WebQuote = { url: string; title?: string; quote: string };

const HYPHENS = /[-‐‑‒–—―−­]/;

function isLetter(character: string | undefined) {
  return !!character && /\p{L}/u.test(character);
}

/** Normalized text and, for each of its characters, the offset in the original it came from. */
export function normalizeForMatch(input: string): { text: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  let index = 0;
  while (index < input.length) {
    const code = input.codePointAt(index)!;
    const character = String.fromCodePoint(code);
    const size = character.length;
    if (character === "­") { index += size; continue; }
    // A word hyphenated across a line break: drop the hyphen and the break.
    if (HYPHENS.test(character) && isLetter(out.at(-1))) {
      let next = index + size;
      let newline = false;
      while (next < input.length && /\s/.test(input[next])) { if (input[next] === "\n") newline = true; next++; }
      if (newline && next < input.length && /\p{Ll}/u.test(input[next])) { index = next; continue; }
    }
    if (/\s/.test(character)) {
      if (out.length && out.at(-1) !== " ") { out.push(" "); map.push(index); }
      index += size;
      continue;
    }
    const normalized = character.normalize("NFKC").toLowerCase()
      .replace(/[‘’‚‛′`´]/g, "'").replace(/[“”„‟″«»]/g, "\"").replace(/[‐‑‒–—―−]/g, "-");
    for (const part of normalized) {
      if (/\s/.test(part)) { if (out.length && out.at(-1) !== " ") { out.push(" "); map.push(index); } continue; }
      out.push(part);
      map.push(index);
    }
    index += size;
  }
  while (out.at(-1) === " ") { out.pop(); map.pop(); }
  return { text: out.join(""), map };
}


function parts(quote: string) {
  const pieces = quote.split(/\s*(?:\[\s*(?:\.\s*){3}\]|\[…\]|(?:\.\s*){3}|…)\s*/).map((piece) => piece.trim()).filter(Boolean);
  return pieces.length ? pieces : [quote];
}

/** Normalized source text; `grams` (its character trigrams) is filled in on first use. */
export type Searchable = { text: string; map: number[]; grams?: Set<string> };

function trigrams(text: string) {
  const grams = new Set<string>();
  for (let index = 0; index + 3 <= text.length; index++) grams.add(text.slice(index, index + 3));
  return grams;
}

/**
 * Cheap filter before the edit-distance search: each differing character
 * breaks at most three of the quote's trigrams, so a quote within the
 * threshold keeps well over half of them in the source.
 */
function mayContain(needle: string, source: Searchable) {
  source.grams ??= trigrams(source.text);
  const wanted = trigrams(needle);
  if (!wanted.size) return true;
  let present = 0;
  for (const gram of wanted) if (source.grams.has(gram)) present++;
  return present / wanted.size >= 1 - 3 * (1 - QUOTE_MATCH_THRESHOLD) - 0.05;
}

/** Where `quote` occurs in `source` (both raw), with its match ratio, or null below the threshold. Offsets are in `source`. */
export function findQuote(quote: string, source: string | Searchable): QuoteMatch | null {
  const normalizedSource = typeof source === "string" ? normalizeForMatch(source) as Searchable : source;
  const pieces = parts(quote).map((piece) => normalizeForMatch(piece).text).filter((piece) => piece.length >= 3);
  if (!pieces.length) return null;
  let ratio = 1;
  let start = Infinity;
  let end = -1;
  for (const piece of pieces) {
    const needle = piece.slice(0, MAX_COMPARED_CHARS);
    const exact = normalizedSource.text.indexOf(needle);
    let match: QuoteMatch | null = exact >= 0 ? { ratio: 1, start: exact, end: exact + needle.length } : null;
    if (!match && needle.length >= MIN_FUZZY_CHARS && mayContain(needle, normalizedSource)) match = approximateMatch(needle, normalizedSource.text);
    if (!match || match.ratio < QUOTE_MATCH_THRESHOLD) return null;
    ratio = Math.min(ratio, match.ratio);
    start = Math.min(start, match.start);
    end = Math.max(end, match.end);
  }
  const map = normalizedSource.map;
  return { ratio, start: map[start] ?? 0, end: (map[Math.max(start, end - 1)] ?? 0) + 1 };
}

/** Text of a source file the checker cited, loaded once per verification. */
export type SourceTextLoader = {
  pages(path: string): Promise<PdfTextPage[] | null>;
  text(path: string): Promise<string | null>;
};

export function sourceTextLoader(context: ToolContext): SourceTextLoader {
  const pdfs = new Map<string, Promise<PdfTextPage[] | null>>();
  const texts = new Map<string, Promise<string | null>>();
  return {
    pages(path) {
      if (!pdfs.has(path)) pdfs.set(path, readPdfTextCache(path).then((payload) => payload.pages, () => null));
      return pdfs.get(path)!;
    },
    text(path) {
      if (!texts.has(path)) {
        texts.set(path, (async () => {
          try { return (await readCurrentText(context, await resolve(context, path)))?.content ?? null; }
          catch { return null; }
        })());
      }
      return texts.get(path)!;
    },
  };
}

function samePath(left: string, right: string) {
  return left === right || left.toLowerCase() === right.toLowerCase();
}

type PageText = { page: number; normalized: Searchable };
const normalizedCache = new WeakMap<PdfTextPage[], PageText[]>();

function verifyPdfQuote(item: EvidenceQuote, pages: PdfTextPage[]): VerifiedEvidence | DroppedEvidence {
  let normalizedPages = normalizedCache.get(pages);
  if (!normalizedPages) {
    normalizedPages = pages.map((page) => ({ page: page.pageNumber, normalized: normalizeForMatch(page.text) }));
    normalizedCache.set(pages, normalizedPages);
  }
  const byNumber = new Map(normalizedPages.map((page) => [page.page, page]));
  const onPage = (page: number) => {
    const text = byNumber.get(page);
    return text ? findQuote(item.quote, text.normalized) : null;
  };
  // A quote across a page break starts on `page` and ends on the next one.
  const acrossBreak = (page: number) => {
    const first = pages.find((candidate) => candidate.pageNumber === page);
    const second = pages.find((candidate) => candidate.pageNumber === page + 1);
    if (!first || !second) return null;
    const match = findQuote(item.quote, `${first.text}\n${second.text}`);
    return match && match.start < first.text.length && match.end > first.text.length + 1 ? match : null;
  };
  const keep = (page: number, ratio: number): VerifiedEvidence => ({
    path: item.path, page, quote: item.quote, ratio,
    ...(item.page !== undefined && item.page !== page ? { pageCorrected: { from: item.page, to: page } } : {}),
  });
  const claimed = item.page;
  if (claimed !== undefined && byNumber.has(claimed)) {
    const here = onPage(claimed) ?? acrossBreak(claimed);
    if (here) return keep(claimed, here.ratio);
    for (const page of [claimed + 1, claimed - 1]) {
      const near = onPage(page);
      if (near) return keep(page, near.ratio);
    }
    const before = acrossBreak(claimed - 1);
    if (before) return keep(claimed - 1, before.ratio);
  }
  for (const page of normalizedPages) {
    const elsewhere = findQuote(item.quote, page.normalized);
    if (!elsewhere) continue;
    if (claimed === undefined) return keep(page.page, elsewhere.ratio);
    return { ...item, reason: `the quote is on page ${page.page}, not page ${claimed}` };
  }
  for (const page of normalizedPages) {
    const spanning = acrossBreak(page.page);
    if (!spanning) continue;
    if (claimed === undefined) return keep(page.page, spanning.ratio);
    return { ...item, reason: `the quote is on pages ${page.page}–${page.page + 1}, not page ${claimed}` };
  }
  return { ...item, reason: "evidence not found in source" };
}

/**
 * Checks each quote against `allowed` source files; returns the quotes that
 * were found (with corrected pages or lines) and those dropped, with why.
 */
export async function verifyEvidence(items: EvidenceQuote[], allowed: string[], loader: SourceTextLoader) {
  const kept: VerifiedEvidence[] = [];
  const dropped: DroppedEvidence[] = [];
  for (const item of items) {
    const path = allowed.find((candidate) => samePath(candidate, item.path.trim()));
    if (!path) { dropped.push({ ...item, reason: `${item.path} is not an attached file of the cited work` }); continue; }
    const entry = { ...item, path };
    if (getFileType(path) === "pdf") {
      const pages = await loader.pages(path);
      if (!pages) { dropped.push({ ...entry, reason: "the PDF's text could not be read" }); continue; }
      const result = verifyPdfQuote(entry, pages);
      if ("reason" in result) dropped.push(result); else kept.push(result);
      continue;
    }
    const text = await loader.text(path);
    if (text === null) { dropped.push({ ...entry, reason: "the file could not be read" }); continue; }
    const match = findQuote(entry.quote, text);
    if (!match) { dropped.push({ ...entry, reason: "evidence not found in source" }); continue; }
    const { page: _page, ...rest } = entry;
    void _page;
    kept.push({ ...rest, line: lineOfOffset(text, match.start), ratio: match.ratio });
  }
  return { kept, dropped };
}

/** A URL as compared against WebSearch's cited pages: no fragment, no trailing slash, lowercase host. */
export function normalizeUrl(value: string) {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch { return value.trim().replace(/#.*$/, "").replace(/\/+$/, ""); }
}

/** Web quotes whose URL the check's WebSearch calls returned as cited pages; the rest are dropped. */
export function verifyWebSources(items: WebQuote[], returned: Set<string>) {
  const kept: WebQuote[] = [];
  const dropped: (WebQuote & { reason: string })[] = [];
  for (const item of items) {
    if (returned.has(normalizeUrl(item.url))) kept.push(item);
    else dropped.push({ ...item, reason: "the URL was not among the pages WebSearch returned" });
  }
  return { kept, dropped };
}
