// Pure display helpers for the References panel and the Manage references
// dialog: "Author et al. (Year)" labels, row text, a plain formatted
// reference, accent- and case-insensitive search with match ranges, sorting,
// key and alias resolution, duplicate group labels and friendly names for CSL
// types, fields and provenance sources. No React, no I/O.

import { isPreprint, isPreprintPublishedPair, normalizeTitleForMatch } from "@/lib/references/dedupe";
import type { ReferenceInputKind } from "@/lib/references/identifiers";
import { formatNameForDisplay } from "@/lib/references/names";
import type {
  CslDate,
  CslItem,
  CslItemType,
  CslName,
  ProvenanceSource,
  ReferenceEntry,
  ReferenceLibrary,
} from "@/lib/references/types";

// ---------------------------------------------------------------------------
// Names, years, rows
// ---------------------------------------------------------------------------

function familyName(name: CslName) {
  if (name.literal && !name.family) return name.literal;
  return [name["non-dropping-particle"], name.family].filter(Boolean).join(" ") || name.given || "";
}

/** The entry's creators for labels: authors, else editors, else translators. */
export function entryCreators(csl: CslItem): CslName[] {
  for (const field of ["author", "editor", "translator", "container-author"] as const) {
    const names = csl[field];
    if (Array.isArray(names) && names.length) return names;
  }
  return [];
}

/** "Smith", "Smith & Lee" or "Smith et al.". Empty when the entry has no creator. */
export function authorsLabel(csl: CslItem) {
  const names = entryCreators(csl).map(familyName).filter(Boolean);
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} et al.`;
}

/** The first year of a CSL date, from date-parts or a literal/raw string. */
export function dateYear(date: CslDate | undefined): number | undefined {
  const year = date?.["date-parts"]?.[0]?.[0];
  if (typeof year === "number" && Number.isFinite(year)) return year;
  const match = (date?.literal ?? date?.raw ?? "").match(/\b(1\d{3}|2\d{3})\b/);
  return match ? Number(match[1]) : undefined;
}

/** "2020", or "n.d." without a date. */
export function yearLabel(csl: CslItem) {
  const year = dateYear(csl.issued);
  if (year !== undefined) return String(year);
  if (csl.issued?.literal) return csl.issued.literal;
  return "n.d.";
}

/** "Smith et al. (2020)"; "Untitled (2020)" style fallbacks use the title's first words. */
export function authorYearLabel(csl: CslItem) {
  const authors = authorsLabel(csl);
  return `${authors || "No author"} (${yearLabel(csl)})`;
}

/** The title, or the free text of an entry that has none yet (an unresolved pasted reference). */
export function entryTitle(entry: Pick<ReferenceEntry, "csl">) {
  const title = typeof entry.csl.title === "string" ? entry.csl.title.trim() : "";
  if (title) return title;
  const note = typeof entry.csl.note === "string" ? entry.csl.note.trim() : "";
  return note ? note.replace(/\s+/g, " ") : "Untitled";
}

/** Where the work appeared: journal or book title, event, else publisher. */
export function entryVenue(csl: CslItem) {
  for (const field of ["container-title", "event-title", "collection-title", "publisher"] as const) {
    const value = csl[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** The CSL field `entryVenue` reads, for editing the venue cell. */
export function venueField(csl: CslItem): string {
  for (const field of ["container-title", "event-title", "collection-title", "publisher"] as const) {
    const value = csl[field];
    if (typeof value === "string" && value.trim()) return field;
  }
  return csl.type === "book" || csl.type === "report" || csl.type === "thesis" ? "publisher" : "container-title";
}

function initials(given: string) {
  return given.split(/[\s.]+/).filter(Boolean).map((part) => part.split("-").map((piece) => `${piece[0]}.`).join("-")).join(" ");
}

/** "Smith, J. A." for a person, the literal for an institution. */
export function shortNameForReference(name: CslName) {
  if (name.literal && !name.family) return name.literal;
  const family = familyName(name);
  const given = [name.given, name["dropping-particle"]].filter(Boolean).join(" ");
  return given ? `${family}, ${initials(given)}` : family;
}

function joinNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length > 20) return `${names.slice(0, 19).join(", ")}, … ${names.at(-1)}`;
  return `${names.slice(0, -1).join(", ")}, & ${names.at(-1)}`;
}

function withPeriod(text: string) {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * A plain formatted reference: "Authors (Year). Title. Venue." Used by Copy
 * formatted reference and the card summary until style-aware formatting is
 * wired in.
 */
export function formatPlainReference(csl: CslItem) {
  const names = entryCreators(csl).map(shortNameForReference).filter(Boolean);
  const authors = joinNames(names);
  const parts = [`${authors ? `${authors} ` : ""}(${yearLabel(csl)}).`];
  const title = typeof csl.title === "string" ? csl.title.trim() : "";
  if (title) parts.push(withPeriod(title));
  const venue = entryVenue(csl);
  if (venue) {
    const details = [
      typeof csl.volume === "string" && csl.volume ? csl.volume : "",
      typeof csl.issue === "string" && csl.issue ? `(${csl.issue})` : "",
    ].join("");
    const page = typeof csl.page === "string" && csl.page ? csl.page : "";
    parts.push(withPeriod([venue, details, page].filter(Boolean).join(", ")));
  }
  return parts.join(" ");
}

/** Every author for a table cell or tooltip: "Jane Smith, Kim Lee". */
export function fullAuthorList(csl: CslItem) {
  return entryCreators(csl).map((name) => formatNameForDisplay(name)).filter(Boolean).join(", ");
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const SPECIAL_LETTERS: Record<string, string> = {
  ß: "ss", æ: "ae", œ: "oe", ø: "o", ł: "l", đ: "d", ð: "d", þ: "th", ı: "i",
};
const COMBINING_MARK = /\p{M}/u;

/** One character, lowercased and without diacritics (may be empty or longer). */
function foldChar(char: string) {
  const lower = char.toLowerCase();
  if (SPECIAL_LETTERS[lower]) return SPECIAL_LETTERS[lower];
  let folded = "";
  for (const part of lower.normalize("NFD")) if (!COMBINING_MARK.test(part)) folded += part;
  return folded;
}

/** Lowercase, accents removed: "Gödel" → "godel". */
export function foldSearchText(text: string) {
  let folded = "";
  for (const char of text) folded += foldChar(char);
  return folded;
}

/** The words of a search query, folded. Every word must match. */
export function searchWords(query: string) {
  return foldSearchText(query).split(/\s+/).filter(Boolean);
}

/** The text a search looks through: key, aliases, authors, year, title, venue, tags and notes. */
export function entrySearchText(entry: ReferenceEntry) {
  const csl = entry.csl;
  return foldSearchText([
    entry.key,
    ...entry.aliases,
    fullAuthorList(csl),
    authorsLabel(csl),
    yearLabel(csl),
    entryTitle(entry),
    entryVenue(csl),
    typeof csl["container-title-short"] === "string" ? csl["container-title-short"] : "",
    ...(entry.tags ?? []),
    entry.notes ?? "",
  ].join("\n"));
}

/** True when every word occurs in the entry's search text. */
export function entryMatchesWords(searchText: string, words: string[]) {
  return words.every((word) => searchText.includes(word));
}

/** [start, end) ranges of `text` matching any of `words`, accent- and case-insensitively, merged and sorted. */
export function matchRanges(text: string, words: string[]): Array<[number, number]> {
  if (!words.length || !text) return [];
  // Fold character by character, remembering where each folded character came from.
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const char of Array.from(text)) {
    const part = foldChar(char);
    for (let index = 0; index < part.length; index += 1) {
      starts.push(offset);
      ends.push(offset + char.length);
    }
    folded += part;
    offset += char.length;
  }
  const ranges: Array<[number, number]> = [];
  for (const word of words) {
    let from = folded.indexOf(word);
    while (from >= 0) {
      ranges.push([starts[from], ends[from + word.length - 1]]);
      from = folded.indexOf(word, from + word.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/** `text` split into plain and matched segments, for rendering `<mark>`. */
export function highlightSegments(text: string, words: string[]): Array<{ text: string; match: boolean }> {
  const ranges = matchRanges(text, words);
  if (!ranges.length) return [{ text, match: false }];
  const segments: Array<{ text: string; match: boolean }> = [];
  let index = 0;
  for (const [start, end] of ranges) {
    if (start > index) segments.push({ text: text.slice(index, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    index = end;
  }
  if (index < text.length) segments.push({ text: text.slice(index), match: false });
  return segments;
}

// ---------------------------------------------------------------------------
// Sorting and lookup
// ---------------------------------------------------------------------------

export type ReferenceSort = "author" | "year" | "title" | "added" | "cited";

export const REFERENCE_SORTS: Array<{ id: ReferenceSort; label: string }> = [
  { id: "author", label: "Author" },
  { id: "year", label: "Year" },
  { id: "title", label: "Title" },
  { id: "added", label: "Recently added" },
  { id: "cited", label: "Recently cited" },
];

export type SortContext = {
  /** Entry id → when a document citing it was last changed (ISO), for "Recently cited". */
  citedAt?: Map<string, string>;
};

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function firstAuthorSortName(csl: CslItem) {
  const first = entryCreators(csl)[0];
  return first ? familyName(first) : "";
}

/** Entries sorted for the list. Ties fall back to author, year, title, then key, so the order is stable. */
export function sortEntries(entries: ReferenceEntry[], sort: ReferenceSort, context: SortContext = {}) {
  const tieBreak = (a: ReferenceEntry, b: ReferenceEntry) =>
    collator.compare(firstAuthorSortName(a.csl) || "￿", firstAuthorSortName(b.csl) || "￿")
    || (dateYear(a.csl.issued) ?? 99999) - (dateYear(b.csl.issued) ?? 99999)
    || collator.compare(entryTitle(a), entryTitle(b))
    || collator.compare(a.key, b.key);
  const compare: Record<ReferenceSort, (a: ReferenceEntry, b: ReferenceEntry) => number> = {
    author: tieBreak,
    // Newest first, undated last.
    year: (a, b) => (dateYear(b.csl.issued) ?? -99999) - (dateYear(a.csl.issued) ?? -99999) || tieBreak(a, b),
    title: (a, b) => collator.compare(entryTitle(a), entryTitle(b)) || tieBreak(a, b),
    added: (a, b) => b.createdAt.localeCompare(a.createdAt) || tieBreak(a, b),
    // Uncited entries last.
    cited: (a, b) => (context.citedAt?.get(b.id) ?? "").localeCompare(context.citedAt?.get(a.id) ?? "") || tieBreak(a, b),
  };
  return [...entries].sort(compare[sort]);
}

/** Lowercased key and alias → entry, for resolving cited keys. */
export function keyLookup(library: ReferenceLibrary | null) {
  const map = new Map<string, ReferenceEntry>();
  if (!library) return map;
  const entries = Object.values(library.entries);
  // Keys win over aliases when both exist.
  for (const entry of entries) for (const alias of entry.aliases) map.set(alias.toLowerCase(), entry);
  for (const entry of entries) map.set(entry.key.toLowerCase(), entry);
  return map;
}

/** The library-relative paths of documents citing `entry` (by key or alias), given a key → paths map. */
export function citingPaths(entry: ReferenceEntry, byKey: Map<string, Set<string>>) {
  const paths = new Set<string>();
  for (const key of [entry.key, ...entry.aliases]) for (const path of byKey.get(key.toLowerCase()) ?? []) paths.add(path);
  return [...paths].sort(collator.compare);
}

/** Every tag in the library with how many entries carry it, most used first. Tags differing only in case count as one. */
export function libraryTags(entries: ReferenceEntry[]): Array<{ tag: string; count: number }> {
  const tags = new Map<string, { tag: string; count: number }>();
  for (const entry of entries) {
    for (const tag of new Set((entry.tags ?? []).map((item) => item.trim()).filter(Boolean))) {
      const lower = tag.toLowerCase();
      const current = tags.get(lower);
      if (current) current.count += 1;
      else tags.set(lower, { tag, count: 1 });
    }
  }
  return [...tags.values()].sort((a, b) => b.count - a.count || collator.compare(a.tag, b.tag));
}

export function hasTag(entry: ReferenceEntry, tag: string) {
  const lower = tag.toLowerCase();
  return (entry.tags ?? []).some((item) => item.toLowerCase() === lower);
}

/** `entry`'s tags with `add` added and `remove` removed, case-insensitively; null when nothing changes. */
export function changedTags(entry: ReferenceEntry, add: string[], remove: string[]) {
  const current = entry.tags ?? [];
  const removing = new Set(remove.map((tag) => tag.toLowerCase()));
  const next = current.filter((tag) => !removing.has(tag.toLowerCase()));
  for (const tag of add) if (!next.some((item) => item.toLowerCase() === tag.toLowerCase())) next.push(tag);
  return next.length === current.length && next.every((tag, index) => tag === current[index]) ? null : next;
}

/** The undo label and the notice for adding or removing tags on `count` entries. */
export function tagChangeText(count: number, add: string[], remove: string[]) {
  const tags = (add.length ? add : remove).map((tag) => `“${tag}”`).join(", ");
  const entries = `${count} reference${count === 1 ? "" : "s"}`;
  return add.length
    ? { label: `Add ${tags} to ${entries}`, message: `Added ${tags} to ${entries}.` }
    : { label: `Remove ${tags} from ${entries}`, message: `Removed ${tags} from ${entries}.` };
}

export type CitationCopyFormat = "pandoc" | "latex";

/** Keys as a citation to paste: `[@a; @b]` or `\cite{a,b}`. */
export function citationText(keys: string[], format: CitationCopyFormat) {
  return format === "latex" ? `\\cite{${keys.join(",")}}` : `[${keys.map((key) => `@${key}`).join("; ")}]`;
}

export function hasPdf(entry: ReferenceEntry) {
  return entry.attachments.some((attachment) => attachment.kind === "pdf");
}

export function fileBaseName(path: string) {
  return path.split("/").at(-1) ?? path;
}

/** "papers/smith.pdf" → "smith". */
export function fileTitle(path: string) {
  return fileBaseName(path).replace(/\.[^.]+$/, "");
}

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

export type DuplicateGroupKind = "preprint" | "doi" | "identifier" | "title";

function sameValue(entries: ReferenceEntry[], read: (entry: ReferenceEntry) => string | undefined) {
  const values = entries.map(read);
  return values.every((value) => value && value === values[0]);
}

/** Why a group of entries looks like one work. */
export function duplicateGroupKind(group: ReferenceEntry[]): DuplicateGroupKind {
  if (group.some((a, index) => group.slice(index + 1).some((b) => isPreprintPublishedPair(a, b)))) return "preprint";
  if (sameValue(group, (entry) => entry.identifiers.doi ?? (typeof entry.csl.DOI === "string" ? entry.csl.DOI.toLowerCase() : undefined))) return "doi";
  if (sameValue(group, (entry) => entry.identifiers.arxiv) || sameValue(group, (entry) => entry.identifiers.pmid) || sameValue(group, (entry) => entry.identifiers.isbn?.[0])) return "identifier";
  return "title";
}

export const DUPLICATE_GROUP_LABELS: Record<DuplicateGroupKind, string> = {
  preprint: "Preprint and published version",
  doi: "Same DOI",
  identifier: "Same identifier",
  title: "Similar title",
};

/** The entry a merge keeps: the published version, else the oldest. */
export function chooseKeptEntry(group: ReferenceEntry[]) {
  const published = group.filter((entry) => !isPreprint(entry));
  const candidates = published.length && published.length < group.length ? published : group;
  return [...candidates].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key))[0];
}

/** Same title, for matching an imported item back to its source key. */
export function titleMatchKey(csl: CslItem) {
  return `${normalizeTitleForMatch(typeof csl.title === "string" ? csl.title : "")}|${dateYear(csl.issued) ?? ""}`;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const CSL_TYPE_LABELS: Record<CslItemType, string> = {
  article: "Preprint or working paper",
  "article-journal": "Journal article",
  "article-magazine": "Magazine article",
  "article-newspaper": "Newspaper article",
  bill: "Bill",
  book: "Book",
  broadcast: "Broadcast",
  chapter: "Book chapter",
  classic: "Classic work",
  collection: "Collection",
  dataset: "Dataset",
  document: "Document",
  entry: "Entry",
  "entry-dictionary": "Dictionary entry",
  "entry-encyclopedia": "Encyclopedia entry",
  event: "Event",
  figure: "Figure",
  graphic: "Graphic",
  hearing: "Hearing",
  interview: "Interview",
  legal_case: "Legal case",
  legislation: "Legislation",
  manuscript: "Manuscript",
  map: "Map",
  motion_picture: "Film",
  musical_score: "Musical score",
  pamphlet: "Pamphlet",
  "paper-conference": "Conference paper",
  patent: "Patent",
  performance: "Performance",
  periodical: "Periodical",
  personal_communication: "Personal communication",
  post: "Post",
  "post-weblog": "Blog post",
  regulation: "Regulation",
  report: "Report",
  review: "Review",
  "review-book": "Book review",
  software: "Software",
  song: "Song",
  speech: "Speech",
  standard: "Standard",
  thesis: "Thesis",
  treaty: "Treaty",
  webpage: "Web page",
};

export function typeLabel(type: string) {
  return CSL_TYPE_LABELS[type as CslItemType] ?? type;
}

export const CSL_FIELD_LABELS: Record<string, string> = {
  title: "Title",
  "title-short": "Short title",
  author: "Authors",
  editor: "Editors",
  translator: "Translators",
  issued: "Date",
  accessed: "Accessed",
  "container-title": "Published in",
  "container-title-short": "Journal abbreviation",
  "collection-title": "Series",
  "event-title": "Event",
  "event-place": "Event place",
  publisher: "Publisher",
  "publisher-place": "Place",
  volume: "Volume",
  issue: "Issue",
  page: "Pages",
  "number-of-pages": "Number of pages",
  edition: "Edition",
  number: "Number",
  genre: "Genre",
  medium: "Medium",
  language: "Language",
  abstract: "Abstract",
  note: "Note",
  DOI: "DOI",
  URL: "URL",
  ISBN: "ISBN",
  ISSN: "ISSN",
  PMID: "PMID",
  PMCID: "PMCID",
};

export function fieldLabel(field: string) {
  return CSL_FIELD_LABELS[field] ?? field;
}

export const PROVENANCE_LABELS: Record<ProvenanceSource, string> = {
  crossref: "Crossref",
  datacite: "DataCite",
  openalex: "OpenAlex",
  arxiv: "arXiv",
  pubmed: "PubMed",
  isbn: "ISBN",
  "pdf-metadata": "PDF",
  "pdf-text": "PDF",
  llm: "LLM",
  "llm-web": "LLM + web",
  import: "Import",
  user: "You",
};

export const INPUT_KIND_LABELS: Record<ReferenceInputKind, string> = {
  doi: "DOI",
  arxiv: "arXiv ID",
  isbn: "ISBN",
  pmid: "PubMed ID",
  pmcid: "PubMed Central ID",
  url: "Web address",
  bibtex: "BibTeX",
  ris: "RIS",
  "csl-json": "CSL-JSON",
  "reference-text": "Reference text",
  bibliography: "Bibliography",
};

export const READING_LABELS = {
  "to-read": "To read",
  read: "Read",
} as const;

export const STATUS_LABELS = {
  confirmed: "Confirmed",
  "needs-review": "Needs review",
  unresolved: "Unresolved",
} as const;

/** A CSL date as text: "2020-03-14", "2020", or its literal. */
export function formatCslDate(date: CslDate | undefined) {
  if (!date) return "";
  const parts = date["date-parts"]?.[0];
  if (parts?.length) return parts.filter((part) => part !== undefined).map((part, index) => index ? String(part).padStart(2, "0") : String(part)).join("-");
  return date.literal ?? date.raw ?? "";
}

/** A CSL value as one line of text for the card and the table. */
export function formatFieldValue(field: string, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    if (value.every((item) => item && typeof item === "object")) return (value as CslName[]).map((name) => formatNameForDisplay(name)).join("; ");
    return value.join(", ");
  }
  if (typeof value === "object") {
    if (field === "issued" || "date-parts" in value || "literal" in value || "raw" in value) return formatCslDate(value as CslDate);
    return JSON.stringify(value);
  }
  return String(value);
}
