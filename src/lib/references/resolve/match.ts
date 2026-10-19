import { normalizeTitleForMatch, titleSimilarity } from "../dedupe";
import type { CslItem, CslName } from "../types";

// Scoring search results against what is known about a work (docs/references/
// plan.md §4.4 step 3), and checking that a resolved title really is the
// title printed on a PDF's first page.
//
// Titles are compared with `titleScore`: the mean of dedupe's
// `titleSimilarity` (word and bigram overlap, robust to reordering and OCR
// noise) and an edit-distance ratio (which keeps word order, so a different
// paper built from the same words does not pass). A title that is a whole-word
// prefix of the other, at least four words long (a dropped subtitle), scores
// at least 0.9.
//
// Thresholds:
// - MATCH_THRESHOLD (0.85): a search result at or above it is taken as the
//   work (the entry is still only `needs-review`); below it the entry stays
//   `unresolved`. Reaching it takes a matching title plus a matching first
//   author or year: an identical title with unknown authors and year scores
//   0.8. Titles scoring below TITLE_FLOOR (0.8) cap the score below 0.8.
// - TITLE_IN_TEXT_THRESHOLD (0.8): the best window of first-page text must
//   score this against the resolved title for an identifier found on the
//   page to count as the PDF's own, not a cited work's.

export const MATCH_THRESHOLD = 0.85;
export const TITLE_IN_TEXT_THRESHOLD = 0.8;
const TITLE_FLOOR = 0.8;
const WEIGHTS = { title: 0.6, authors: 0.25, year: 0.15 };
const MAX_EDIT_CHARS = 300;

/** What is known about the work being looked for. Any part may be missing. */
export type MatchQuery = { title?: string; authors?: (string | CslName)[]; year?: number };

function editDistance(a: string, b: string) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/** 1 − edit distance / longer length, on normalized titles. */
export function editSimilarity(a: string | undefined, b: string | undefined) {
  const x = normalizeTitleForMatch(a).slice(0, MAX_EDIT_CHARS);
  const y = normalizeTitleForMatch(b).slice(0, MAX_EDIT_CHARS);
  if (!x || !y) return 0;
  return 1 - editDistance(x, y) / Math.max(x.length, y.length);
}

/** Title agreement in 0..1 (see the header). */
export function titleScore(a: string | undefined, b: string | undefined) {
  const x = normalizeTitleForMatch(a);
  const y = normalizeTitleForMatch(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const score = (titleSimilarity(x, y) + editSimilarity(x, y)) / 2;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  if (shorter.split(" ").length >= 4 && longer.startsWith(`${shorter} `)) return Math.max(score, 0.9);
  return score;
}

export function familyKey(name: string | CslName) {
  const text = typeof name === "string" ? lastWordOfName(name) : name.family ?? lastWordOfName(name.literal ?? "");
  return normalizeTitleForMatch(text).replace(/ /g, "");
}

function lastWordOfName(name: string) {
  const trimmed = name.trim();
  // "Smith, John" → Smith; "John Smith" → Smith; "Smith J" (initials last) → Smith.
  if (trimmed.includes(",")) return trimmed.split(",")[0];
  const words = trimmed.split(/\s+/);
  if (words.length > 1 && /^[A-Z]{1,3}\.?$/.test(words[words.length - 1])) return words[0];
  return words[words.length - 1] ?? "";
}

export function cslYear(csl: CslItem) {
  const value = csl.issued?.["date-parts"]?.[0]?.[0];
  if (typeof value === "number") return value;
  const match = (csl.issued?.literal ?? csl.issued?.raw ?? "").match(/\b(1\d{3}|2\d{3})\b/);
  return match ? Number(match[1]) : undefined;
}

/** Share of the query's author family names found among the candidate's, or undefined when either side has none. */
export function authorOverlap(query: (string | CslName)[] | undefined, candidate: CslName[] | undefined) {
  const wanted = (query ?? []).map(familyKey).filter(Boolean);
  const have = new Set((candidate ?? []).map(familyKey).filter(Boolean));
  if (!wanted.length || !have.size) return undefined;
  return wanted.filter((family) => have.has(family)).length / wanted.length;
}

function yearScore(query: number | undefined, candidate: number | undefined) {
  if (query === undefined || candidate === undefined) return undefined;
  const gap = Math.abs(query - candidate);
  return gap === 0 ? 1 : gap === 1 ? 0.8 : 0;
}

function combine(title: number, authors: number | undefined, year: number | undefined) {
  const score = WEIGHTS.title * title + WEIGHTS.authors * (authors ?? 0.5) + WEIGHTS.year * (year ?? 0.5);
  return title < TITLE_FLOOR ? Math.min(score, TITLE_FLOOR * 0.99) : score;
}

/**
 * How well a candidate matches the query, 0..1: 0.6 × title score + 0.25 ×
 * author overlap + 0.15 × year (1 for the same year, 0.8 for ±1, 0
 * otherwise). A missing part counts at half weight.
 */
export function scoreMatch(query: MatchQuery, candidate: CslItem) {
  if (!query.title) return 0;
  return combine(
    titleScore(query.title, candidate.title),
    authorOverlap(query.authors, candidate.author ?? candidate.editor),
    yearScore(query.year, cslYear(candidate)),
  );
}

/** The highest-scoring candidate and its score, or undefined when there is none. */
export function bestMatch<T extends { csl: CslItem }>(query: MatchQuery, candidates: T[]) {
  let best: { candidate: T; score: number } | undefined;
  for (const candidate of candidates) {
    const score = scoreMatch(query, candidate.csl);
    if (!best || score > best.score) best = { candidate, score };
  }
  return best;
}

/**
 * The best `titleScore` between `title` and any run of words in `text` of
 * about the title's length (±2 words), over the first `maxWords` words.
 * Hyphenation across line breaks is undone first.
 */
export function titleSimilarityInText(title: string | undefined, text: string, maxWords = 600) {
  const titleWords = normalizeTitleForMatch(title).split(" ").filter(Boolean);
  if (!titleWords.length) return 0;
  const words = normalizeTitleForMatch(text.replace(/(\p{L})-\s*\n\s*(\p{Ll})/gu, "$1$2")).split(" ").filter(Boolean).slice(0, maxWords);
  if (!words.length) return 0;
  const target = titleWords.join(" ");
  const anchors = new Set(titleWords);
  let best = 0;
  for (let start = 0; start < words.length; start += 1) {
    // Only windows that start on (or just after) a word of the title can match well.
    if (!anchors.has(words[start]) && (start === 0 || !anchors.has(words[start - 1]))) continue;
    for (let length = Math.max(1, titleWords.length - 2); length <= titleWords.length + 2 && start + length <= words.length; length += 1) {
      const score = titleScore(target, words.slice(start, start + length).join(" "));
      if (score > best) best = score;
      if (best === 1) return 1;
    }
  }
  return best;
}

export function titleAppearsInText(title: string | undefined, text: string) {
  return titleSimilarityInText(title, text) >= TITLE_IN_TEXT_THRESHOLD;
}

/**
 * How well a candidate matches a free-text reference string: its title must
 * appear in the string; its first authors' family names and its year count
 * as for `scoreMatch`.
 */
export function scoreReferenceText(text: string, candidate: CslItem) {
  const title = titleSimilarityInText(candidate.title, text, 400);
  const normalized = ` ${normalizeTitleForMatch(text)} `;
  // "Smith et al." names only the first author; otherwise up to three are compared.
  const families = (candidate.author ?? candidate.editor ?? []).slice(0, /\bet\s+al\b/i.test(text) ? 1 : 3).map(familyKey).filter(Boolean);
  const authors = families.length ? families.filter((family) => normalized.includes(` ${family} `) || normalized.replace(/ /g, "").includes(family)).length / families.length : undefined;
  const year = cslYear(candidate);
  const years = [...text.matchAll(/\b(1[5-9]\d{2}|20\d{2})\b/g)].map((match) => Number(match[1]));
  return combine(title, authors, year === undefined || !years.length ? undefined : Math.max(...years.map((value) => yearScore(value, year) ?? 0)));
}
