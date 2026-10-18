// The `@` citation popup's suggestion index (plan.md §1.3 "Typing @", §4.3):
// an in-memory index over one notebook's library, built once per library
// revision. It ranks like file-suggestions.ts, prefix before substring, by
// field: an exact key prefix first, then an author's family name, then a
// title word, then a substring anywhere. Matching ignores case and accents,
// and a query of several words (`smith 2020`, `sparse attention`) must match
// every word in some field. Entries already cited in the document come
// first, then entries cited recently in this session.

import { narrativeMayFollow, serializeCitation } from "./citation-syntax";
import type { CslItem, CslName, ReferenceEntry, ReferenceLibrary } from "./types";

export type ReferenceSuggestionField = "key" | "author" | "year" | "title" | "container" | "tags" | "notes";

export type ReferenceSuggestion = {
  entry: ReferenceEntry;
  /** The key to insert: always the entry's current key, also when an alias matched. */
  key: string;
  /** The field the query (its first word) matched best; null for an empty query. */
  matchedField: ReferenceSuggestionField | null;
  /** The text of that field, as shown to the user (e.g. the matched alias or author). */
  matchedText: string;
  /** Matched ranges in `matchedText`, [start, end) UTF-16 offsets. */
  highlights: Array<[number, number]>;
};

export type ReferenceSuggestionOptions = {
  /** Keys (or aliases) cited in the current document, in document order. */
  citedKeys?: readonly string[];
  /** Keys cited recently in this session, most recent first. */
  recentKeys?: readonly string[];
  /** Default 20. */
  limit?: number;
};

export type ReferenceSuggestionIndex = {
  readonly size: number;
  search(query: string, options?: ReferenceSuggestionOptions): ReferenceSuggestion[];
};

export const REFERENCE_SUGGESTION_LIMIT = 20;

// Field tiers: lower ranks first. A word that matches only inside another
// word (a substring) ranks after every prefix match.
const TIER: Record<ReferenceSuggestionField, number> = { key: 0, author: 1, year: 1.5, title: 2, container: 2.5, tags: 2.5, notes: 2.8 };
const SUBSTRING_TIER = 3;
const CITED_BOOST = 1.5;
const RECENT_BOOST = 0.75;

/** Lower-case and strip accents, one character at a time, keeping a map back to the original offsets. */
export function foldSearchText(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index)!;
    const char = String.fromCodePoint(code);
    const plain = char.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    for (let part = 0; part < plain.length; part += 1) map.push(index);
    folded += plain;
    if (code > 0xffff) index += 1;
  }
  map.push(text.length);
  return { folded, map };
}

function fold(text: string) {
  return foldSearchText(text).folded;
}

const WORD = /[\p{L}\p{N}]+/gu;

/** Start offsets of the words in a folded string (letters and digits; key punctuation splits words). */
function wordStarts(folded: string) {
  const starts: number[] = [];
  for (const match of folded.matchAll(WORD)) starts.push(match.index);
  return starts;
}

type FieldText = { field: ReferenceSuggestionField; text: string; folded: string; starts: number[] };

type IndexedEntry = {
  entry: ReferenceEntry;
  /** Every searchable text, in tier order. */
  fields: FieldText[];
  /** Every folded field, joined: a quick test that a word occurs anywhere. */
  all: string;
  created: number;
};

function names(list: CslName[] | undefined) {
  return (list ?? []).map((name) => [name["non-dropping-particle"], name.family ?? name.literal].filter(Boolean).join(" ")).filter(Boolean);
}

export function referenceYear(csl: CslItem) {
  const year = csl.issued?.["date-parts"]?.[0]?.[0];
  if (typeof year === "number") return String(year);
  return /\b\d{4}\b/.exec(csl.issued?.literal ?? csl.issued?.raw ?? "")?.[0] ?? "";
}

function fieldText(field: ReferenceSuggestionField, text: string): FieldText {
  const folded = fold(text);
  return { field, text, folded, starts: wordStarts(folded) };
}

function indexEntry(entry: ReferenceEntry): IndexedEntry {
  const csl = entry.csl;
  const fields: FieldText[] = [];
  for (const key of [entry.key, ...(entry.aliases ?? [])]) fields.push({ ...fieldText("key", key), starts: [0] });
  for (const name of [...names(csl.author), ...names(csl.editor)]) fields.push(fieldText("author", name));
  const year = referenceYear(csl);
  if (year) fields.push(fieldText("year", year));
  if (typeof csl.title === "string" && csl.title) fields.push(fieldText("title", csl.title));
  for (const container of [csl["container-title"], csl["container-title-short"]]) {
    if (typeof container === "string" && container) fields.push(fieldText("container", container));
  }
  for (const tag of entry.tags ?? []) if (tag) fields.push(fieldText("tags", tag));
  if (entry.notes) fields.push(fieldText("notes", entry.notes));
  const created = Date.parse(entry.createdAt);
  return { entry, fields, all: fields.map((field) => field.folded).join("\u0000"), created: Number.isFinite(created) ? created : 0 };
}

/** Prefix of `folded` (key fields) or of one of its words (the others). */
function prefixAt(field: FieldText, word: string) {
  for (const start of field.starts) {
    if (field.folded.startsWith(word, start)) return start;
  }
  return -1;
}

type WordMatch = { tier: number; field: FieldText; start: number; length: number };

function matchWord(entry: IndexedEntry, word: string): WordMatch | null {
  let best: WordMatch | null = null;
  for (const field of entry.fields) {
    const tier = TIER[field.field];
    if (best && best.tier <= tier) break;
    const start = prefixAt(field, word);
    if (start >= 0) best = { tier, field, start, length: word.length };
  }
  if (best) return best;
  for (const field of entry.fields) {
    const start = field.folded.indexOf(word);
    if (start >= 0) return { tier: SUBSTRING_TIER, field, start, length: word.length };
  }
  return null;
}

function highlightRanges(field: FieldText, matches: WordMatch[]): Array<[number, number]> {
  const { map } = foldSearchText(field.text);
  const ranges = matches
    .filter((match) => match.field === field)
    .map((match): [number, number] => [map[match.start], map[match.start + match.length] ?? field.text.length])
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/** Split a query into folded words. Key punctuation inside a word (`smith2020:a`) stays part of it. */
function queryWords(query: string) {
  return fold(query).split(/\s+/).filter(Boolean);
}

function keyRanks(keys: readonly string[] | undefined, byKey: Map<string, IndexedEntry>) {
  const ranks = new Map<IndexedEntry, number>();
  keys?.forEach((key, index) => {
    const entry = byKey.get(key);
    if (entry && !ranks.has(entry)) ranks.set(entry, index);
  });
  return ranks;
}

function createIndex(library: ReferenceLibrary): ReferenceSuggestionIndex {
  const entries = Object.values(library.entries).map(indexEntry).sort((a, b) => a.entry.key.localeCompare(b.entry.key));
  const byKey = new Map<string, IndexedEntry>();
  for (const entry of entries) {
    byKey.set(entry.entry.key, entry);
    for (const alias of entry.entry.aliases ?? []) if (!byKey.has(alias)) byKey.set(alias, entry);
  }
  const recentlyAdded = [...entries].sort((a, b) => b.created - a.created || a.entry.key.localeCompare(b.entry.key));

  const suggestion = (entry: IndexedEntry, matches: WordMatch[]): ReferenceSuggestion => {
    const first = matches[0];
    if (!first) return { entry: entry.entry, key: entry.entry.key, matchedField: null, matchedText: entry.entry.key, highlights: [] };
    return {
      entry: entry.entry,
      key: entry.entry.key,
      matchedField: first.field.field,
      matchedText: first.field.text,
      highlights: highlightRanges(first.field, matches),
    };
  };

  return {
    size: entries.length,
    search(query, options = {}) {
      const limit = Math.max(1, options.limit ?? REFERENCE_SUGGESTION_LIMIT);
      const cited = keyRanks(options.citedKeys, byKey);
      const recent = keyRanks(options.recentKeys, byKey);
      const words = queryWords(query);

      if (!words.length) {
        const ordered: IndexedEntry[] = [];
        const seen = new Set<IndexedEntry>();
        const push = (entry: IndexedEntry) => {
          if (seen.has(entry) || ordered.length >= limit) return;
          seen.add(entry);
          ordered.push(entry);
        };
        [...cited.keys()].sort((a, b) => cited.get(a)! - cited.get(b)!).forEach(push);
        [...recent.keys()].sort((a, b) => recent.get(a)! - recent.get(b)!).forEach(push);
        for (const entry of recentlyAdded) {
          if (ordered.length >= limit) break;
          push(entry);
        }
        return ordered.map((entry) => suggestion(entry, []));
      }

      type Scored = { entry: IndexedEntry; score: number; matches: WordMatch[] };
      const compare = (a: Scored, b: Scored) =>
        a.score - b.score ||
        (cited.get(a.entry) ?? Infinity) - (cited.get(b.entry) ?? Infinity) ||
        (recent.get(a.entry) ?? Infinity) - (recent.get(b.entry) ?? Infinity) ||
        a.entry.entry.key.length - b.entry.entry.key.length ||
        a.entry.entry.key.localeCompare(b.entry.entry.key);
      // The best `limit` results, kept sorted (no sort of every match).
      const best: Scored[] = [];
      outer: for (const entry of entries) {
        for (const word of words) if (!entry.all.includes(word)) continue outer;
        const matches: WordMatch[] = [];
        let score = 0;
        for (const word of words) {
          const match = matchWord(entry, word);
          if (!match) continue outer;
          matches.push(match);
          score += match.tier;
        }
        // The first word decides the tier; later words refine it a little.
        score = matches[0].tier + (score - matches[0].tier) / (words.length * 10);
        if (cited.has(entry)) score -= CITED_BOOST;
        else if (recent.has(entry)) score -= RECENT_BOOST;
        const item = { entry, score, matches };
        if (best.length === limit && compare(item, best[limit - 1]) >= 0) continue;
        let low = 0;
        let high = best.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (compare(best[mid], item) <= 0) low = mid + 1; else high = mid;
        }
        best.splice(low, 0, item);
        if (best.length > limit) best.pop();
      }
      return best.map(({ entry, matches }) => suggestion(entry, matches));
    },
  };
}

const indexes = new WeakMap<ReferenceLibrary["entries"], { revision: number; index: ReferenceSuggestionIndex }>();

/** The suggestion index for a library, cached by its revision (and entries object). */
export function buildReferenceSuggestionIndex(library: ReferenceLibrary): ReferenceSuggestionIndex {
  const cached = indexes.get(library.entries);
  if (cached && cached.revision === library.revision) return cached.index;
  const index = createIndex(library);
  indexes.set(library.entries, { revision: library.revision, index });
  return index;
}

// Keys cited from the popup in this session, most recent first.
const RECENT_LIMIT = 50;
let recentCitations: string[] = [];

export function recentCitationKeys(): readonly string[] {
  return recentCitations;
}

export function noteRecentCitation(key: string) {
  recentCitations = [key, ...recentCitations.filter((value) => value !== key)].slice(0, RECENT_LIMIT);
}

/** Forget the session's recent citations (tests). */
export function resetRecentCitations() {
  recentCitations = [];
}

// ---------------------------------------------------------------------------
// Opening the popup while typing
// ---------------------------------------------------------------------------

const KEY_CHARACTER = /^[\p{L}\p{N}_:.#$%&\-+?<>~/]$/u;
const MAX_QUERY_LENGTH = 256;

/**
 * Whether the text just before the caret could be a citation trigger: an `@`
 * followed only by key characters. This is the cheap check editors run on
 * every keystroke; only when it passes do they call `citationTriggerAt`,
 * which analyses the whole document. `before` is the text ending at the caret
 * (the last few hundred characters are enough).
 */
export function mayTriggerCitation(before: string) {
  let index = before.length;
  while (index > 0 && before.length - index <= MAX_QUERY_LENGTH) {
    const code = before.charCodeAt(index - 1);
    const width = code >= 0xdc00 && code <= 0xdfff && index > 1 ? 2 : 1;
    const char = before.slice(index - width, index);
    if (char === "@") return true;
    if (!KEY_CHARACTER.test(char)) return false;
    index -= width;
  }
  return false;
}

/** Whether a popup choice at a trigger can insert a narrative citation: outside brackets, where `@key` reads as one. */
export function narrativeInsertionAllowed(insideCitation: boolean, before: string | undefined) {
  return !insideCitation && narrativeMayFollow(before);
}

/**
 * The text a citation popup inserts for `key` at a trigger (see
 * `citationTriggerAt`). With `narrative` (Shift+Enter) it is `@key`, the
 * narrative form, where that is allowed (`before` is the character before the
 * trigger's `@`); otherwise the bracketed form. `pageLocator` cites that page:
 * `[@key, p. 12]`, or `@key [p. 12]` when narrative.
 */
export function citationInsertion(
  key: string,
  insideCitation: boolean,
  locator: boolean,
  { narrative = false, before, pageLocator }: { narrative?: boolean; before?: string; pageLocator?: string } = {},
) {
  if (narrative && narrativeInsertionAllowed(insideCitation, before)) {
    const text = pageLocator ? serializeCitation({ narrative: true, items: [{ key, locator: pageLocator, label: "page" }] }) : `@${key}`;
    return { text, caret: text.length };
  }
  const item = pageLocator ? serializeCitation({ items: [{ key, locator: pageLocator, label: "page" }] }).slice(1, -1) : `@${key}`;
  const text = insideCitation ? `${item}${locator ? ", " : ""}` : `[${item}${locator ? ", " : ""}]`;
  // The caret goes after the key, or at the locator position: `[@key, |]`.
  const caret = text.length - (insideCitation ? 0 : 1);
  return { text, caret: locator || insideCitation ? caret : text.length };
}
