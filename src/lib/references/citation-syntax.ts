// Citation syntax: Pandoc-compatible bracketed citations in Markdown source
// (docs/references/plan.md §1.3, §4.2, decision D1).
//
//   [@smith2020sparse]                 parenthetical
//   [@smith2020sparse, p. 12]          with locator
//   [see @a, ch. 3; -@b, emphasis]     prefix, suppressed author, suffix
//
// One grammar serves every editor. This module owns the token grammar
// (`parseCitationToken`), a fast whole-document scanner that knows which
// parts of a Markdown source are prose (`scanCitations`), and the helpers the
// editors and the library build on. `remark-citations.ts` implements the same
// grammar as a micromark construct for the preview; `CITATION_SYNTAX_CASES`
// is the shared table every parser layer is tested against.
//
// Narrative citations (decision D4), Pandoc's in-text form:
//
//   @smith2020sparse says …            "Smith (2020) says …"
//   @smith2020sparse [p. 33] says …    "Smith (2020, p. 33) says …"
//
// - A bare `@key` is a narrative citation when its `@` starts the text or
//   follows whitespace, `[` or `(`: never after a letter, digit, `.`, `_` or
//   any other character, so emails (`me@example.com`) and handles in URLs
//   (`example.com/@alice`) are not misread. Trailing punctuation is not part
//   of the key (`CITATION_KEY_SOURCE`): `@smith2020.` cites `smith2020`.
// - Only prose counts: not code, math, HTML, autolinks, link destinations or
//   titles, front matter, link or image text, or the inside of a bracketed
//   citation (where `@key` is an item).
// - A bracket right after the key, or after one space, is its locator when it
//   holds only a locator part (`[p. 33]`, `[ch. 3, emphasis added]`): no `@`,
//   no nested brackets, one line, and not followed by `(` or `[` (a link).
//   Anything else (`@alice [the user]`) is left as text after the citation.
// - The occurrence has `citation.narrative = true`, one item, and the source
//   text as `raw` (`@smith2020sparse [p. 33]`).
//
// Parsing never depends on the library: the scanner reports every narrative
// candidate. What a candidate means does: `@someone` in prose is often not a
// citation, so renderers show an unresolved narrative candidate as plain text
// (no red chip), and only a key the library resolves renders as a citation.
// `citedKeys` and the fact-check list count narrative occurrences only when
// they resolve (`resolves`), unless asked for all (`allNarrative`).

import { CITATION_KEY_SOURCE } from "./keys";
import type { Citation, CitationItem, CitationLocatorLabel, CitationOccurrence } from "./types";
import { escapedAt, mathMarkerPairs, type MathMarkerPair, type MathMarkerSettings } from "../math-markers";
import { MARKDOWN_BOX_SHORTCUTS } from "../markdown-boxes";

/** Options for the document-level functions; pass the same math markers the preview uses. */
export type CitationSyntaxOptions = {
  /** The notebook's math markers. Defaults to the app defaults (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`). */
  mathMarkers?: MathMarkerSettings;
};

/** Maximum length of a citation token in the source, brackets included. */
export const CITATION_MAX_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Token grammar
// ---------------------------------------------------------------------------

const KEY = new RegExp(CITATION_KEY_SOURCE, "uy");
const KEY_CHARACTERS = new RegExp(String.raw`[\p{L}\p{N}_:.#$%&\-+?<>~/]*$`, "u");
const QUERY = new RegExp(String.raw`^(?:[\p{L}\p{N}_][\p{L}\p{N}_:.#$%&\-+?<>~/]*)?$`, "u");
const WHITESPACE = /\s/;

function isAsciiPunctuation(code: number) {
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}

function collapse(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Locator terms, longest first when matched. Every CSL label name is also
 * accepted as its own term, so that the canonical form of any label (see
 * `serializeCitation`) parses back to the same label.
 */
const LOCATOR_TERMS: ReadonlyArray<readonly [CitationLocatorLabel, readonly string[]]> = [
  ["page", ["p.", "pp.", "page", "pages", "pg."]],
  ["chapter", ["ch.", "chap.", "chapter", "chapters"]],
  ["section", ["sec.", "§", "§§", "section", "sections"]],
  ["figure", ["fig.", "figs.", "figure", "figures"]],
  ["table", ["tbl.", "tab.", "table", "tables"]],
  ["paragraph", ["para.", "paras.", "¶", "¶¶", "paragraph", "paragraphs"]],
  ["line", ["l.", "ll.", "line", "lines"]],
  ["volume", ["vol.", "vols.", "volume", "volumes"]],
  ["note", ["n.", "nn.", "note", "notes"]],
  ["verse", ["v.", "vv.", "verse", "verses"]],
  ["column", ["col.", "cols.", "column", "columns"]],
  ["part", ["pt.", "part", "parts"]],
  ["book", ["bk.", "book", "books"]],
  ["opus", ["op.", "opus", "opera"]],
  ["sub-verbo", ["s.v.", "s.vv.", "sub-verbo", "sub verbo"]],
  ["appendix", ["app.", "appendix", "appendices"]],
  ["equation", ["eq.", "eqs.", "equation", "equations"]],
  ["folio", ["fol.", "folio", "folios"]],
  ["issue", ["no.", "issue", "issues"]],
  ["act", ["act", "acts"]],
  ["article-locator", ["article-locator"]],
  ["canon", ["canon", "canons"]],
  ["elocation", ["elocation"]],
  ["rule", ["rule", "rules"]],
  ["scene", ["scene", "scenes"]],
  ["supplement", ["supplement", "supplements"]],
  ["timestamp", ["timestamp", "timestamps"]],
  ["title-locator", ["title-locator"]],
];

const TERMS = LOCATOR_TERMS.flatMap(([label, terms]) => terms.map((term) => ({ label, term })))
  .sort((a, b) => b.term.length - a.term.length);
const LETTER_OR_DIGIT = new RegExp(String.raw`[\p{L}\p{N}]`, "u");

/** Canonical abbreviations; labels without one are written out in full. */
const LABEL_ABBREVIATIONS: Partial<Record<CitationLocatorLabel, string>> = {
  page: "p.", chapter: "ch.", section: "sec.", figure: "fig.", table: "tbl.", paragraph: "para.", line: "l.",
  volume: "vol.", note: "n.", verse: "v.", column: "col.", part: "pt.", book: "bk.", "sub-verbo": "s.v.",
  equation: "eq.", appendix: "app.", folio: "fol.", issue: "no.", opus: "op.",
};

// Locator values: numbers with attached letters (12a, S3, e1234, 3.2, 3:16),
// roman numerals, ranges (12-14, 12–14, 12—14) and ,/& lists of those.
const ROMAN = String.raw`(?:(?=[ivxlcdm])m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})|(?=[IVXLCDM])M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3}))`;
const NUMBER = String.raw`(?:[A-Za-z]{1,3})?\d+(?:[.:]\d+)*[A-Za-z]{0,3}`;
const ATOM = String.raw`(?:${NUMBER}(?![\p{L}\p{N}])|${ROMAN}(?![\p{L}\p{N}.'’]))`;
const RANGE = String.raw`${ATOM}(?: ?[-–—] ?${ATOM})?`;
const LOCATOR_VALUE = new RegExp(String.raw`${RANGE}(?: ?[,&] ?${RANGE})*`, "uy");
const WHOLE_LOCATOR_VALUE = new RegExp(String.raw`^${RANGE}(?: ?[,&] ?${RANGE})*$`, "u");

const LONGEST_TERM = Math.max(...TERMS.map(({ term }) => term.length));

function matchLocatorTerm(text: string) {
  const lower = text.slice(0, LONGEST_TERM).toLowerCase();
  for (const { label, term } of TERMS) {
    if (!lower.startsWith(term)) continue;
    if (LETTER_OR_DIGIT.test(term[term.length - 1]) && LETTER_OR_DIGIT.test(text.charAt(term.length))) continue;
    return { label, length: term.length };
  }
  return null;
}

/** A locator value at the start of `text`: a `{literal}` or a number/roman/range/list. */
function matchLocatorValue(text: string) {
  if (text.startsWith("{")) {
    let depth = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "{") depth += 1;
      else if (text[index] === "}" && --depth === 0) {
        const locator = text.slice(1, index);
        return locator.trim() ? { locator, length: index + 1 } : null;
      }
    }
    return null;
  }
  LOCATOR_VALUE.lastIndex = 0;
  const match = LOCATOR_VALUE.exec(text);
  return match && match[0] ? { locator: match[0], length: match[0].length } : null;
}

function parseLocatorPart(part: string): Pick<CitationItem, "label" | "locator" | "suffix"> {
  if (!part) return {};
  const finish = (label: CitationLocatorLabel, locator: string, rest: string) => {
    let suffix = rest.trim();
    if (suffix.startsWith(",")) suffix = suffix.slice(1).trim();
    return suffix ? { label, locator, suffix } : { label, locator };
  };
  const term = matchLocatorTerm(part);
  if (term) {
    const after = part.slice(term.length).trimStart();
    const value = matchLocatorValue(after);
    return value ? finish(term.label, value.locator, after.slice(value.length)) : { suffix: part };
  }
  const value = matchLocatorValue(part);
  return value ? finish("page", value.locator, part.slice(value.length)) : { suffix: part };
}

type ParsedContent = { items: CitationItem[]; keys: Array<[number, number]> };

/**
 * Parse one item, `content.slice(start, end)`. It needs exactly one `@key`
 * at the top level (not inside nested brackets, not escaped), where the `@`
 * starts the item or follows whitespace, optionally after a `-` that does.
 */
function parseItem(content: string, start: number, end: number) {
  let depth = 0;
  let marker = -1;
  let keyStart = -1;
  let keyEnd = -1;
  for (let index = start; index < end; index += 1) {
    const char = content[index];
    if (char === "\\") {
      if (index + 1 < end && isAsciiPunctuation(content.charCodeAt(index + 1))) index += 1;
      continue;
    }
    if (char === "[" || char === "{") { depth += 1; continue; }
    if (char === "]" || char === "}") { if (depth > 0) depth -= 1; continue; }
    if (char !== "@" || depth > 0) continue;
    let markerStart = index;
    const before = index > start ? content[index - 1] : "";
    if (before === "-") {
      const beforeDash = index - 1 > start ? content[index - 2] : "";
      if (beforeDash && !WHITESPACE.test(beforeDash)) continue;
      markerStart = index - 1;
    } else if (before && !WHITESPACE.test(before)) continue;
    KEY.lastIndex = index + 1;
    const match = KEY.exec(content);
    if (!match || index + 1 + match[0].length > end) continue;
    if (marker >= 0) return null;
    marker = markerStart;
    keyStart = index + 1;
    keyEnd = keyStart + match[0].length;
    index = keyEnd - 1;
  }
  if (marker < 0) return null;
  const item: CitationItem = { key: content.slice(keyStart, keyEnd) };
  const prefix = collapse(content.slice(start, marker));
  if (prefix) item.prefix = prefix;
  if (marker !== keyStart - 1) item.suppressAuthor = true;
  let rest = content.slice(keyEnd, end).trim();
  if (rest.startsWith(",")) rest = rest.slice(1);
  Object.assign(item, parseLocatorPart(collapse(rest)));
  return { item, key: [keyStart, keyEnd] as [number, number] };
}

/**
 * Parse the text between a citation's brackets into items, or null when it is
 * not citation content. Key ranges are offsets into `content`. Shared with
 * remark-citations.ts.
 */
export function parseCitationContent(content: string): ParsedContent | null {
  const items: CitationItem[] = [];
  const keys: Array<[number, number]> = [];
  let depth = 0;
  let itemStart = 0;
  for (let index = 0; index <= content.length; index += 1) {
    const char = content[index];
    if (char === "\\") {
      if (isAsciiPunctuation(content.charCodeAt(index + 1))) index += 1;
      continue;
    }
    if (char === "[" || char === "{") depth += 1;
    else if ((char === "]" || char === "}") && depth > 0) depth -= 1;
    else if (index === content.length || (char === ";" && depth === 0)) {
      const parsed = parseItem(content, itemStart, index);
      if (!parsed) return null;
      items.push(parsed.item);
      keys.push(parsed.key);
      itemStart = index + 1;
    }
  }
  return { items, keys };
}

/**
 * The end (exclusive) of the bracketed token starting at `text[start] === "["`,
 * or -1. Brackets nest, backslash escapes are honoured, the token may contain
 * one line break but not a blank line, and is at most CITATION_MAX_LENGTH long.
 */
function matchBracket(text: string, start: number) {
  let depth = 0;
  let lineBreaks = 0;
  const end = Math.min(text.length, start + CITATION_MAX_LENGTH);
  for (let index = start + 1; index < end; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 92) {
      if (index + 1 < end && isAsciiPunctuation(text.charCodeAt(index + 1))) index += 1;
    } else if (code === 10 || code === 13) {
      if (code === 13 && text.charCodeAt(index + 1) === 10) index += 1;
      if (++lineBreaks > 1) return -1;
    } else if (code === 91) depth += 1;
    else if (code === 93) {
      if (depth === 0) return index + 1;
      depth -= 1;
    }
  }
  return -1;
}

/** Parse a complete token such as `[see @a, p. 12]`; null when `raw` is not exactly one citation. */
export function parseCitationToken(raw: string): Citation | null {
  if (!raw.startsWith("[") || matchBracket(raw, 0) !== raw.length) return null;
  const parsed = parseCitationContent(raw.slice(1, -1));
  return parsed ? { items: parsed.items, raw } : null;
}

// ---------------------------------------------------------------------------
// Narrative citations
// ---------------------------------------------------------------------------

/** Whether a narrative `@` may follow `previous` (undefined or "": the start of the text). */
export function narrativeMayFollow(previous: string | undefined) {
  return !previous || previous === "[" || previous === "(" || WHITESPACE.test(previous);
}

/** Characters a key may contain (its run, before trailing punctuation is dropped). */
export const KEY_RUN_CHARACTER = new RegExp(String.raw`[\p{L}\p{N}_:.#$%&\-+?<>~/]`, "u");

export type NarrativeMatch = {
  /** End (exclusive) of the token, locator bracket included. */
  end: number;
  /** The key's range in `text`. */
  key: [number, number];
  item: CitationItem;
};

/**
 * The locator bracket of a narrative citation whose key ends at `keyEnd`:
 * `[…]` right after the key or after one space, holding a locator part (see
 * the header). Returns the end of the bracket and the parsed locator, or null.
 * Stops at the first `[`, `@`, unescaped `]` or line break, so a scan is
 * bounded by the next `@`.
 */
export function narrativeLocatorAt(text: string, keyEnd: number) {
  let open = keyEnd;
  if (text[open] === " ") open += 1;
  if (text[open] !== "[") return null;
  const limit = Math.min(text.length, open + CITATION_MAX_LENGTH);
  for (let index = open + 1; index < limit; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 92) {
      if (index + 1 < limit && isAsciiPunctuation(text.charCodeAt(index + 1))) index += 1;
      continue;
    }
    if (code === 10 || code === 13 || code === 64 || code === 91) return null;
    if (code !== 93) continue;
    const next = text.charCodeAt(index + 1);
    if (next === 40 || next === 91) return null;
    const part = parseLocatorPart(collapse(text.slice(open + 1, index)));
    return part.locator ? { end: index + 1, part } : null;
  }
  return null;
}

/**
 * The narrative citation whose `@` is at `text[index]`, or null. `previous` is
 * the character before it when that is not in `text` (undefined: the start).
 * Only the grammar is checked here; whether the `@` is in prose is the
 * scanner's business.
 */
export function narrativeCitationAt(text: string, index: number, previous = index > 0 ? text[index - 1] : undefined): NarrativeMatch | null {
  if (text.charCodeAt(index) !== 64 || !narrativeMayFollow(previous)) return null;
  KEY.lastIndex = index + 1;
  const match = KEY.exec(text);
  if (!match) return null;
  const keyEnd = index + 1 + match[0].length;
  const item: CitationItem = { key: match[0] };
  const locator = narrativeLocatorAt(text, keyEnd);
  if (locator) Object.assign(item, locator.part);
  return { end: locator?.end ?? keyEnd, key: [index + 1, keyEnd], item };
}

/** Parse a complete narrative token such as `@a` or `@a [p. 12]`; null when `raw` is not exactly one. */
export function parseNarrativeCitation(raw: string): Citation | null {
  const match = narrativeCitationAt(raw, 0, undefined);
  return match && match.end === raw.length ? { items: [match.item], raw, narrative: true } : null;
}

/** Parse either form: a bracketed token or a narrative one. */
export function parseAnyCitation(raw: string): Citation | null {
  return raw.startsWith("@") ? parseNarrativeCitation(raw) : parseCitationToken(raw);
}

/** Whether a citation can be written in the narrative form: one item, no prefix, no suppressed author, no suffix without a locator. */
export function canBeNarrative(citation: Pick<Citation, "items">) {
  const [item] = citation.items;
  if (citation.items.length !== 1 || item.prefix || item.suppressAuthor || (item.suffix && !item.locator)) return false;
  // The locator bracket holds no `@`, no line break and no unescaped bracket.
  return [item.locator ?? "", item.suffix ?? ""].every((text) => !/[@\r\n]|(?:^|[^\\])(?:\\\\)*[[\]]/.test(text));
}

function serializeLocator(item: CitationItem) {
  if (!item.locator) return "";
  const label = item.label ?? "page";
  let term = LABEL_ABBREVIATIONS[label] ?? label;
  if (label === "page" && /[-–—,&]/.test(item.locator)) term = "pp.";
  const locator = WHOLE_LOCATOR_VALUE.test(item.locator) ? item.locator : `{${item.locator}}`;
  return `, ${term} ${locator}`;
}

/**
 * Canonical text of a citation: items joined by `; `, each written as
 * `prefix -@key, p. 12 suffix` (or `@key, suffix` without a locator).
 * `parseCitationToken(serializeCitation(c))` equals `c` apart from `raw`.
 * A narrative citation is written `@key` or `@key [p. 12 suffix]` (and
 * `parseNarrativeCitation` reads it back); one the narrative form cannot hold
 * (see `canBeNarrative`) is written bracketed.
 */
export function serializeCitation(citation: Pick<Citation, "items" | "narrative">) {
  if (citation.narrative && canBeNarrative(citation)) {
    // `@key` or `@key [p. 12, suffix]`.
    const [item] = citation.items;
    const locator = serializeLocator(item).slice(2);
    return `@${item.key}${locator ? ` [${locator}${item.suffix ? ` ${item.suffix}` : ""}]` : ""}`;
  }
  const items = citation.items.map((item) => {
    const locator = serializeLocator(item);
    const suffix = item.suffix ? `${locator ? " " : ", "}${item.suffix}` : "";
    return `${item.prefix ? `${item.prefix} ` : ""}${item.suppressAuthor ? "-" : ""}@${item.key}${locator}${suffix}`;
  });
  return `[${items.join("; ")}]`;
}

// ---------------------------------------------------------------------------
// Document analysis: which parts of the source are prose
// ---------------------------------------------------------------------------

/** Inline text of one paragraph, heading or table cell, with container prefixes removed. */
type Segment = {
  text: string;
  /** Index in `text` where each source piece starts, and the piece's source offset. */
  starts: number[];
  sources: number[];
  start: number;
  end: number;
};

type ScannedCitation = CitationOccurrence & { keys: Array<[number, number]> };

type Analysis = {
  citations: ScannedCitation[];
  /** Sorted, merged [start, end) source ranges that are not prose: code, math, HTML, link destinations, front matter. */
  skips: number[];
  segments: Segment[];
};

function sourceAt(segment: Segment, index: number) {
  let low = 0;
  let high = segment.starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if (segment.starts[mid] <= index) low = mid; else high = mid - 1;
  }
  return segment.sources[low] + index - segment.starts[low];
}

function sortRanges(ranges: number[]) {
  const pairs: Array<[number, number]> = [];
  for (let index = 0; index < ranges.length; index += 2) pairs.push([ranges[index], ranges[index + 1]]);
  return pairs.sort((a, b) => a[0] - b[0]).flat();
}

/** Merge two sorted flat [start, end, …] range lists into one sorted list of disjoint ranges. */
function mergeRanges(first: number[], second: number[]) {
  const merged: number[] = [];
  let a = 0;
  let b = 0;
  while (a < first.length || b < second.length) {
    let start: number;
    let end: number;
    if (b >= second.length || (a < first.length && first[a] <= second[b])) { start = first[a]; end = first[a + 1]; a += 2; }
    else { start = second[b]; end = second[b + 1]; b += 2; }
    if (merged.length && merged[merged.length - 1] >= start) merged[merged.length - 1] = Math.max(merged[merged.length - 1], end);
    else merged.push(start, end);
  }
  return merged;
}

/** Index of the source line (piece) containing `index` in the segment's text. */
function pieceIndex(segment: Segment, index: number) {
  let low = 0;
  let high = segment.starts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (segment.starts[mid] <= index) low = mid + 1; else high = mid;
  }
  return low - 1;
}

/** End of the source line (piece) containing `index` in the segment's text. */
function pieceEnd(segment: Segment, index: number) {
  const next = pieceIndex(segment, index) + 1;
  return next < segment.starts.length ? segment.starts[next] - 1 : segment.text.length;
}

/**
 * For every unescaped `[`, the index of its matching unescaped `]` (brackets
 * nest), or -1. One pass, so scanning stays linear on unbalanced input.
 */
function bracketCloses(text: string) {
  const closes = new Int32Array(text.length).fill(-1);
  const open: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 92) {
      if (isAsciiPunctuation(text.charCodeAt(index + 1))) index += 1;
    } else if (code === 91) open.push(index);
    else if (code === 93 && open.length) closes[open.pop()!] = index;
  }
  return closes;
}

/** Memoized `indexOf` searches in one text, per needle. */
class Finder {
  private readonly finders = new Map<string, (from: number) => number>();
  constructor(private readonly text: string) {}
  find(needle: string, from: number) {
    let finder = this.finders.get(needle);
    if (!finder) this.finders.set(needle, finder = memoizedIndexOf(this.text, needle));
    return finder(from);
  }
}

/** `text.indexOf(needle, from)` for non-decreasing `from`, without rescanning. */
function memoizedIndexOf(text: string, needle: string) {
  let searched = -1;
  let found = -1;
  return (from: number) => {
    if (searched < 0 || from < searched || (found >= 0 && found < from)) {
      found = text.indexOf(needle, from);
      searched = from;
    }
    return found;
  };
}

/** End of an autolink or inline HTML (tag, comment, instruction, declaration, CDATA) at `text[index] === "<"`, or -1. */
function inlineHtmlEnd(text: string, index: number, finder: Finder | null) {
  AUTOLINK.lastIndex = index;
  const autolink = AUTOLINK.exec(text);
  if (autolink) return index + autolink[0].length;
  HTML_TAG.lastIndex = index;
  const tag = HTML_TAG.exec(text);
  if (tag) return index + tag[0].length;
  let close = -1;
  let size = 0;
  if (text.startsWith("<!--", index)) {
    if (text[index + 4] === ">") return index + 5;
    if (text.startsWith("->", index + 4)) return index + 6;
    close = finder!.find("-->", index + 4);
    size = 3;
  } else if (text.startsWith("<?", index)) {
    close = finder!.find("?>", index + 2);
    size = 2;
  } else if (text.startsWith("<![CDATA[", index)) {
    close = finder!.find("]]>", index + 9);
    size = 3;
  } else if (text[index + 1] === "!" && ASCII_ALPHA.test(text[index + 2] ?? "")) {
    close = finder!.find(">", index + 3);
    size = 1;
  }
  return close >= 0 ? close + size : -1;
}

type Container =
  | { kind: "quote" }
  | { kind: "box"; letter: string }
  /** A list item or footnote definition; `initialBlank`: an item that started with a blank line. */
  | { kind: "item"; column: number; initialBlank?: boolean; furtherBlank?: boolean };

type Leaf =
  /** A content block: link reference definitions, then paragraph lines (`pieces`). */
  | { kind: "paragraph"; depth: number; pieces: Array<[number, number]> }
  | { kind: "table"; depth: number }
  | { kind: "fence"; depth: number; char: string; length: number }
  | { kind: "indented"; depth: number }
  | { kind: "html"; depth: number; end: RegExp | null };

const BOX_LETTERS = new Set(MARKDOWN_BOX_SHORTCUTS.toLowerCase().split(""));
/** First characters of interrupting flow blocks and of containers, for quick rejection. */
const FLOW_STARTS = new Set([..."#-*_`~<"]);
const CONTAINER_STARTS = new Set([...">[-+*0123456789", ...BOX_LETTERS]);
const ATX_HEADING = /^#{1,6}(?=[ \t]|$)/;
const THEMATIC_BREAK = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT_UNDERLINE = /^(?:=+|-+)[ \t]*$/;
const FENCE = /^(`{3,}|~{3,})/;
/** An opening code fence: a backtick fence's info string cannot contain backticks. */
const OPENING_FENCE = /^(?:(`{3,})[^`]*$|(~{3,}))/;
const LIST_MARKER = /^(?:([-+*])|(\d{1,9})([.)]))(?=[ \t]|$)/;
const FOOTNOTE_DEFINITION = /^\[\^(?:[^\][\s\\]|\\[\s\S])+\]:/;
const DELIMITER_ROW = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const HTML_BLOCK_NAMES = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const ATTRIBUTE = String.raw`(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>\x60]+|'[^']*'|"[^"]*"))?)`;
/** HTML flow starts: start, end condition (null: a blank line), whether it interrupts a paragraph, where the end search starts on the first line. */
const HTML_BLOCK_STARTS: Array<[RegExp, RegExp | null, boolean, number | null]> = [
  [/^<(?:script|pre|style|textarea)(?=[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i, true, null],
  [/^<!--/, /-->/, true, 2], // `<!-->` and `<!--->` close at once
  [/^<\?/, /\?>/, true, 1], // so does `<?>`
  [/^<![A-Za-z]/, />/, true, null],
  [/^<!\[CDATA\[/, /\]\]>/, true, null],
  [new RegExp(`^</?(?:${HTML_BLOCK_NAMES})(?=[\\s>]|/>|$)`, "i"), null, true, null],
  [new RegExp(String.raw`^(?:<(?!(?:script|pre|style|textarea)\b)[A-Za-z][A-Za-z0-9-]*${ATTRIBUTE}*\s*/?>|</[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$`, "i"), null, false, null],
];
const HTML_TAG = new RegExp(String.raw`<(?:[A-Za-z][A-Za-z0-9-]*${ATTRIBUTE}*\s*/?>|/[A-Za-z][A-Za-z0-9-]*\s*>)`, "y");
const AUTOLINK = /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>\x00-\x1f]*|[#-'*+\--9=?A-Z^-~]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/y;

/**
 * End offset of YAML front matter (`---` … `---` or `...`) at the very start
 * of a source, closing line included but not its line ending; 0 when absent.
 */
export function citationFrontMatterEnd(markdown: string) {
  const open = /^---[ \t]*(?:\r\n|\r|\n)/.exec(markdown);
  if (!open) return 0;
  const line = /([^\r\n]*)(\r\n|\r|\n|$)/y;
  line.lastIndex = open[0].length;
  for (;;) {
    const start = line.lastIndex;
    const match = line.exec(markdown)!;
    if (/^(?:---|\.\.\.)[ \t]*$/.test(match[1])) return start + match[1].length;
    if (!match[2]) return 0;
  }
}

function normalizeLabel(label: string) {
  return label.replace(/[\t\n\r ]+/g, " ").trim().toLowerCase().toUpperCase();
}

class Analyzer {
  readonly source: string;
  readonly pairs: MathMarkerPair[];
  readonly inlinePairs: MathMarkerPair[];
  readonly displayPairs: MathMarkerPair[];
  readonly mathStarts: Set<number>;
  readonly displayStarts: Set<string>;
  readonly lineStarts: number[] = [];
  readonly lineEnds: number[] = [];
  readonly segments: Segment[] = [];
  readonly defined = new Set<string>();
  private ranges: number[] = [];
  private rangesSorted = true;
  readonly citations: ScannedCitation[] = [];
  private stack: Container[] = [];
  private leaf: Leaf | null = null;
  private readonly mathFailsBefore = new Map<MathMarkerPair, number>();
  private readonly closerFinders = new Map<MathMarkerPair, (from: number) => number>();
  /**
   * Lines a failed display-math attempt has already fed to the flow: micromark
   * checks no new containers there (the construct is concrete) and re-parses
   * them as flow content of the current containers.
   */
  private flowOnlyThrough = -1;

  constructor(source: string, options: CitationSyntaxOptions) {
    this.source = source;
    this.pairs = mathMarkerPairs(options.mathMarkers ?? {});
    this.inlinePairs = this.pairs.filter((pair) => !pair.display);
    this.displayPairs = this.pairs.filter((pair) => pair.display);
    this.mathStarts = new Set(this.inlinePairs.map((pair) => pair.open.charCodeAt(0)));
    this.displayStarts = new Set(this.displayPairs.map((pair) => pair.open[0]));
    let start = 0;
    const length = source.length;
    while (start <= length) {
      let end = start;
      while (end < length && source.charCodeAt(end) !== 10 && source.charCodeAt(end) !== 13) end += 1;
      this.lineStarts.push(start);
      this.lineEnds.push(end);
      if (end >= length) break;
      start = end + (source.charCodeAt(end) === 13 && source.charCodeAt(end + 1) === 10 ? 2 : 1);
    }
  }

  private skip(start: number, end: number) {
    if (end <= start) return;
    const ranges = this.ranges;
    if (ranges.length && ranges[ranges.length - 1] >= start && ranges[ranges.length - 2] <= start) {
      ranges[ranges.length - 1] = Math.max(ranges[ranges.length - 1], end);
      return;
    }
    if (ranges.length && start < ranges[ranges.length - 2]) this.rangesSorted = false;
    ranges.push(start, end);
  }

  private skipLines(first: number, last: number) {
    this.skip(this.lineStarts[first], this.lineEnds[last]);
  }

  run(): Analysis {
    let line = this.frontMatterEnd();
    if (line > 0) this.skipLines(0, line - 1);
    for (; line < this.lineStarts.length; line += 1) line = this.blockLine(line);
    this.closeLeaf();
    // Block and inline ranges are each in document order; merge them.
    const blockRanges = this.ranges;
    const blockSorted = this.rangesSorted;
    this.ranges = [];
    this.rangesSorted = true;
    for (const segment of this.segments) this.scanInline(segment);
    const skips = blockSorted && this.rangesSorted ? mergeRanges(blockRanges, this.ranges) : mergeRanges(sortRanges(blockRanges.concat(this.ranges)), []);
    return { citations: this.citations, skips, segments: this.segments };
  }

  /** Index of the first line after YAML front matter, or 0. */
  private frontMatterEnd() {
    const end = citationFrontMatterEnd(this.source);
    if (!end) return 0;
    let line = 0;
    while (this.lineEnds[line] < end) line += 1;
    return line + 1;
  }

  /** Whitespace from `pos`: the first non-blank position and its column. */
  private leading(pos: number, end: number, column: number) {
    const { source } = this;
    while (pos < end) {
      const code = source.charCodeAt(pos);
      if (code === 32) column += 1;
      else if (code === 9) column += 4 - (column % 4);
      else break;
      pos += 1;
    }
    return { pos, column };
  }

  /** Advance over whitespace up to `target` columns (a tab may overshoot). */
  private advanceTo(pos: number, end: number, column: number, target: number) {
    const { source } = this;
    while (pos < end && column < target) {
      const code = source.charCodeAt(pos);
      if (code === 32) column += 1;
      else if (code === 9) column += 4 - (column % 4);
      else break;
      pos += 1;
    }
    return { pos, column };
  }

  /** Match the open containers' prefixes on a line. */
  private matchContainers(line: number, stack: Container[], commit = false) {
    const { source } = this;
    const end = this.lineEnds[line];
    let pos = this.lineStarts[line];
    let column = 0;
    let base = 0;
    let matched = 0;
    for (const container of stack) {
      const space = this.leading(pos, end, column);
      const blank = space.pos >= end;
      if (container.kind === "item") {
        if (blank) {
          if (commit) container.furtherBlank ||= container.initialBlank;
        } else {
          // An item that started blank ends at its second blank line (micromark's furtherBlankLines).
          const ended = container.furtherBlank;
          if (commit) container.initialBlank = container.furtherBlank = false;
          if (ended || space.column < container.column) break;
          ({ pos, column } = this.advanceTo(pos, end, column, container.column));
        }
        base = container.column;
      } else {
        if (blank || space.column - base > 3) break;
        const char = source[space.pos];
        let after: number;
        if (container.kind === "quote") {
          if (char !== ">") break;
          after = space.pos + 1;
        } else {
          if (char?.toLowerCase() !== container.letter || source[space.pos + 1] !== ">" || source[space.pos + 2] === ">") break;
          after = space.pos + 2;
        }
        column = space.column + (after - space.pos);
        pos = after;
        if (source[pos] === " ") { pos += 1; column += 1; } else if (source[pos] === "\t") column += 1;
        base = column;
      }
      matched += 1;
    }
    return { pos, column, base, matched };
  }

  private closeLeaf() {
    const leaf = this.leaf;
    this.leaf = null;
    if (leaf?.kind === "paragraph") this.addSegment(leaf.pieces);
  }

  private addSegment(pieces: Array<[number, number]>) {
    if (!pieces.length) return;
    let text = "";
    const starts: number[] = [];
    const sources: number[] = [];
    pieces.forEach(([start, end], index) => {
      if (index) text += "\n";
      starts.push(text.length);
      sources.push(start);
      text += this.source.slice(start, end);
    });
    this.segments.push({ text, starts, sources, start: pieces[0][0], end: pieces[pieces.length - 1][1] });
  }

  private tableRow(start: number, end: number) {
    const { source } = this;
    while (start < end && (source[start] === " " || source[start] === "\t")) start += 1;
    while (end > start && (source[end - 1] === " " || source[end - 1] === "\t")) end -= 1;
    if (source[start] === "|") start += 1;
    if (end > start && source[end - 1] === "|" && !escapedAt(source, end - 1)) end -= 1;
    const cells: Array<[number, number]> = [];
    let cellStart = start;
    for (let index = start; index <= end; index += 1) {
      if (index < end && (source[index] !== "|" || escapedAt(source, index))) continue;
      let from = cellStart;
      let to = index;
      while (from < to && (source[from] === " " || source[from] === "\t")) from += 1;
      while (to > from && (source[to - 1] === " " || source[to - 1] === "\t")) to -= 1;
      cells.push([from, to]);
      cellStart = index + 1;
    }
    return cells;
  }

  /** Whether the text at `pos` starts a flow block that interrupts a paragraph (containers are checked separately). */
  private interrupts(pos: number, end: number, indent: number) {
    if (indent >= 4 || (!FLOW_STARTS.has(this.source[pos]) && !this.displayStarts.has(this.source[pos]))) return false;
    const text = this.source.slice(pos, end);
    if (ATX_HEADING.test(text) || THEMATIC_BREAK.test(text) || OPENING_FENCE.test(text)) return true;
    if (this.displayPairs.some((pair) => text.startsWith(pair.open))) return true;
    return HTML_BLOCK_STARTS.some(([start, , interrupt]) => interrupt && start.test(text));
  }

  /**
   * Whether a line ends an open table rather than adding a row: any flow
   * block start, but display math only when it parses (a failed attempt still
   * leaves its lines flow-only).
   */
  private endsTable(line: number, pos: number, end: number, indent: number) {
    if (indent >= 4) return true;
    const text = this.source.slice(pos, end);
    if (ATX_HEADING.test(text) || THEMATIC_BREAK.test(text) || OPENING_FENCE.test(text)) return true;
    if (HTML_BLOCK_STARTS.some(([start]) => start.test(text))) return true;
    const pair = this.displayPairs.find((candidate) => text.startsWith(candidate.open));
    if (!pair) return false;
    const { failed } = this.displayMath(line, pos, pair);
    if (failed < 0) return true;
    this.flowOnlyThrough = Math.max(this.flowOnlyThrough, failed);
    return false;
  }

  /**
   * A container start at `pos`: block quote, box, footnote definition or list
   * item. With `interrupt` (a paragraph is open), empty items and ordered
   * items not starting at 1 do not count.
   */
  private containerStart(pos: number, end: number, column: number, base: number, interrupt: boolean) {
    const { source } = this;
    const space = this.leading(pos, end, column);
    if (space.pos >= end || space.column - base >= 4 || !CONTAINER_STARTS.has(source[space.pos].toLowerCase())) return null;
    const text = source.slice(space.pos, end);
    const char = text[0];
    if (char === ">" || (BOX_LETTERS.has(char.toLowerCase()) && text[1] === ">" && text[2] !== ">")) {
      const container: Container = char === ">" ? { kind: "quote" } : { kind: "box", letter: char.toLowerCase() };
      let at = space.pos + (char === ">" ? 1 : 2);
      let next = space.column + (at - space.pos);
      if (source[at] === " ") { at += 1; next += 1; } else if (source[at] === "\t") next += 1;
      return { container, pos: at, column: next, base: next };
    }
    const footnote = FOOTNOTE_DEFINITION.exec(text);
    if (footnote) {
      const after = this.leading(space.pos + footnote[0].length, end, space.column + footnote[0].length);
      return { container: { kind: "item", column: base + 4 } as Container, pos: after.pos, column: after.column, base: after.column };
    }
    if (THEMATIC_BREAK.test(text)) return null;
    const marker = LIST_MARKER.exec(text);
    if (!marker) return null;
    const markerEnd = space.pos + marker[0].length;
    const markerColumn = space.column + marker[0].length;
    const after = this.leading(markerEnd, end, markerColumn);
    const empty = after.pos >= end;
    if (interrupt && (empty || (marker[2] && marker[2] !== "1"))) return null;
    const narrow = empty || after.column - markerColumn > 4;
    const contentColumn = narrow ? markerColumn + 1 : after.column;
    const at = narrow ? this.advanceTo(markerEnd, end, markerColumn, markerColumn + 1) : after;
    return { container: { kind: "item", column: contentColumn, initialBlank: empty } as Container, pos: at.pos, column: at.column, base: contentColumn };
  }

  /**
   * A link reference definition starting at `pos` on `line`. Its label, title
   * and the whitespace before the destination may continue on following lines
   * of the same content block. Returns its label and last line, or null.
   */
  private definitionAt(line: number, pos: number) {
    const { source } = this;
    if (source[pos] !== "[") return null;
    let text = source.slice(pos, this.lineEnds[line]);
    const ends = [text.length];
    for (let next = line + 1; next < this.lineStarts.length && next <= line + 8; next += 1) {
      const containers = this.matchContainers(next, this.stack);
      const end = this.lineEnds[next];
      const space = this.leading(containers.pos, end, containers.column);
      if (space.pos >= end) break;
      const lazy = containers.matched < this.stack.length;
      if (this.containerStart(containers.pos, end, containers.column, containers.base, !lazy)) break;
      if (this.interrupts(space.pos, end, space.column - containers.base)) break;
      text += `\n${source.slice(space.pos, end)}`;
      ends.push(text.length);
    }
    const definition = parseDefinition(text);
    if (!definition) return null;
    return { label: definition.label, last: line + ends.findIndex((end) => end >= definition.end) };
  }

  /** A line of a content block: definitions while no paragraph text has started, then paragraph text. */
  private contentLine(leaf: Extract<Leaf, { kind: "paragraph" }>, line: number, pos: number) {
    if (!leaf.pieces.length) {
      const definition = this.definitionAt(line, pos);
      if (definition) {
        this.defined.add(normalizeLabel(definition.label));
        this.skipLines(line, definition.last);
        return definition.last;
      }
    }
    leaf.pieces.push([pos, this.lineEnds[line]]);
    return line;
  }

  /** Process one line; returns the last line it consumed. */
  private blockLine(line: number): number {
    const { source } = this;
    const lineEnd = this.lineEnds[line];
    const flowOnly = line <= this.flowOnlyThrough;
    const containers = this.matchContainers(line, this.stack, true);
    let { pos, column, base } = containers;
    const { matched } = containers;
    const allMatched = matched === this.stack.length;
    let leaf = this.leaf;
    // micromark lets an open paragraph or indented code (not a table) restrict which containers may start.
    const interruptible = leaf?.kind === "paragraph" || leaf?.kind === "indented";

    // Fenced code, HTML and indented code continue only on non-lazy lines.
    if (leaf && (leaf.kind === "fence" || leaf.kind === "html" || leaf.kind === "indented")) {
      if (allMatched) {
        const space = this.leading(pos, lineEnd, column);
        const blank = space.pos >= lineEnd;
        if (leaf.kind === "fence") {
          const text = source.slice(space.pos, lineEnd);
          const fence = FENCE.exec(text);
          if (space.column - base < 4 && fence && fence[1][0] === leaf.char && fence[1].length >= leaf.length && !text.slice(fence[1].length).trim()) {
            this.leaf = null;
          }
          this.skipLines(line, line);
          return line;
        }
        if (leaf.kind === "html") {
          if (!(leaf.end === null && blank)) {
            this.skipLines(line, line);
            if (leaf.end?.test(source.slice(pos, lineEnd))) this.leaf = null;
            return line;
          }
          this.leaf = null;
        } else if (blank || space.column - base >= 4) {
          if (!blank) this.skipLines(line, line);
          return line;
        } else this.leaf = null;
      } else this.leaf = null;
      leaf = this.leaf;
    }

    let space = this.leading(pos, lineEnd, column);
    let blank = space.pos >= lineEnd;

    if (!allMatched && !flowOnly) {
      // A lazy line continues an open paragraph unless it starts a container
      // (without interrupt restrictions) or a block that interrupts it.
      if (leaf?.kind === "paragraph" && !blank && !this.containerStart(pos, lineEnd, column, base, false) && !this.interrupts(space.pos, lineEnd, space.column - base)) {
        // On a lazy line even a lone HTML tag interrupts; that block stays in
        // the containers and ends at the next lazy line.
        const [start] = HTML_BLOCK_STARTS[HTML_BLOCK_STARTS.length - 1];
        if (space.column - base < 4 && start.test(source.slice(space.pos, lineEnd))) {
          this.closeLeaf();
          this.leaf = { kind: "html", depth: this.stack.length, end: null };
          this.skipLines(line, line);
          return line;
        }
        return this.contentLine(leaf, line, space.pos);
      }
      this.stack.length = matched;
      if (leaf && leaf.depth > matched) this.closeLeaf();
      leaf = this.leaf;
    }

    // A lazy line: not every open container continued and none started.
    let lazy = !allMatched;
    if (!flowOnly) {
      const interrupt = allMatched && interruptible;
      for (;;) {
        const start = this.containerStart(pos, lineEnd, column, base, interrupt);
        if (!start) break;
        this.closeLeaf();
        leaf = null;
        lazy = false;
        this.stack.push(start.container);
        ({ pos, column, base } = start);
      }
    }

    const depth = this.stack.length;
    space = this.leading(pos, lineEnd, column);
    blank = space.pos >= lineEnd;
    const indent = space.column - base;
    const text = source.slice(space.pos, lineEnd);

    if (blank) {
      if (leaf?.kind === "paragraph" || leaf?.kind === "table") this.closeLeaf();
      return line;
    }

    if (leaf?.kind === "table") {
      if (!this.endsTable(line, space.pos, lineEnd, indent)) {
        for (const [from, to] of this.tableRow(space.pos, lineEnd)) this.addSegment([[from, to]]);
        return line;
      }
      this.closeLeaf();
      leaf = null;
    }

    if (leaf?.kind === "paragraph") {
      if (indent < 4 && allMatched && leaf.pieces.length && SETEXT_UNDERLINE.test(text)) {
        this.closeLeaf();
        return line;
      }
      if (indent < 4 && allMatched && leaf.pieces.length && text.includes("|") && DELIMITER_ROW.test(text)) {
        // A table's header row may be the last line of an open paragraph.
        const [start, end] = leaf.pieces[leaf.pieces.length - 1];
        const header = this.tableRow(start, end);
        if (header.length === this.tableRow(space.pos, lineEnd).length) {
          leaf.pieces.pop();
          this.closeLeaf();
          for (const cell of header) this.addSegment([cell]);
          this.leaf = { kind: "table", depth };
          return line;
        }
      }
      if (indent >= 4 || !this.interrupts(space.pos, lineEnd, indent)) return this.contentLine(leaf, line, space.pos);
      this.closeLeaf();
      leaf = null;
    }

    if (indent >= 4) {
      // Indented code that starts on a lazy line ends with that line.
      this.leaf = lazy ? null : { kind: "indented", depth };
      this.skipLines(line, line);
      return line;
    }

    const fence = FENCE.exec(text);
    if (fence && !(fence[1][0] === "`" && text.slice(fence[1].length).includes("`"))) {
      this.leaf = { kind: "fence", depth, char: fence[1][0], length: fence[1].length };
      this.skipLines(line, line);
      return line;
    }

    for (const pair of this.displayPairs) {
      if (!text.startsWith(pair.open)) continue;
      const { last, failed } = this.displayMath(line, space.pos, pair);
      if (failed < 0) {
        this.skip(space.pos, this.lineEnds[last]);
        return last;
      }
      this.flowOnlyThrough = Math.max(this.flowOnlyThrough, failed);
      break;
    }

    for (const [start, end, , endFrom] of HTML_BLOCK_STARTS) {
      const match = start.exec(text);
      if (!match) continue;
      this.skipLines(line, line);
      if (!end || !end.test(text.slice(endFrom ?? match[0].length))) this.leaf = { kind: "html", depth, end };
      return line;
    }

    const heading = ATX_HEADING.exec(text);
    if (heading) {
      let from = space.pos + heading[0].length;
      let to = lineEnd;
      while (from < to && (source[from] === " " || source[from] === "\t")) from += 1;
      while (to > from && (source[to - 1] === " " || source[to - 1] === "\t")) to -= 1;
      let close = to;
      while (close > from && source[close - 1] === "#") close -= 1;
      if (close < to && (close === from || source[close - 1] === " " || source[close - 1] === "\t")) {
        to = close;
        while (to > from && (source[to - 1] === " " || source[to - 1] === "\t")) to -= 1;
      }
      if (to > from) this.addSegment([[from, to]]);
      return line;
    }

    if (THEMATIC_BREAK.test(text)) return line;

    const content: Extract<Leaf, { kind: "paragraph" }> = { kind: "paragraph", depth, pieces: [] };
    this.leaf = content;
    return this.contentLine(content, line, space.pos);
  }

  /**
   * Display math from `pos` on `line`, mirroring remark-math-markers: the
   * first closer must end its line. The construct is concrete, so following
   * lines are fed to it without checking for new containers (lazy lines
   * included) until a container closes. Returns the closing line, or when
   * the construct fails, the last line it consumed (`failed`, -1 on success).
   */
  private displayMath(line: number, pos: number, pair: MathMarkerPair) {
    const failsAt = this.mathFailsBefore.get(pair) ?? -1;
    if (line <= failsAt) return { last: -1, failed: failsAt };
    const { source } = this;
    const stack = this.stack;
    let current = line;
    let index = pos + pair.open.length;
    let content = false;
    const first = index < this.lineEnds[line] ? source.charCodeAt(index) : -1;
    if (this.pairs.some((other) => other.open.length > pair.open.length && other.open.startsWith(pair.open) && other.open.charCodeAt(pair.open.length) === first)) return { last: -1, failed: line };
    for (;;) {
      // The body on this line is source[index, end); line breaks separate escapes.
      const end = this.lineEnds[current];
      for (let search = index; ;) {
        const close = this.closerFinder(pair)(search);
        if (close < 0 || close + pair.close.length > end) break;
        let backslashes = 0;
        while (close - backslashes > index && source.charCodeAt(close - backslashes - 1) === 92) backslashes += 1;
        if (backslashes % 2 === 1) { search = close + 1; continue; }
        // Text after the closer fails every opener up to this line too (they
        // all meet this closer first); an empty body fails only this opener.
        if (source.slice(close + pair.close.length, end).trim()) {
          this.mathFailsBefore.set(pair, current);
          return { last: -1, failed: current };
        }
        if (!content && !source.slice(index, close).trim()) return { last: -1, failed: current };
        return { last: current, failed: -1 };
      }
      content ||= source.slice(index, end).trim() !== "";
      current += 1;
      if (current >= this.lineStarts.length) break;
      const next = this.matchContainers(current, stack);
      if (next.matched < stack.length && this.containerStart(next.pos, this.lineEnds[current], next.column, next.base, false)) break;
      index = next.pos;
    }
    this.mathFailsBefore.set(pair, current - 1);
    return { last: -1, failed: current - 1 };
  }

  private closerFinder(pair: MathMarkerPair) {
    let finder = this.closerFinders.get(pair);
    if (!finder) this.closerFinders.set(pair, finder = memoizedIndexOf(this.source, pair.close));
    return finder;
  }

  // -------------------------------------------------------------------------
  // Inline

  private scanInline(segment: Segment) {
    const text = segment.text;
    const length = text.length;
    const brackets: Array<{ index: number; image: boolean; citations: number }> = [];
    const citations: Array<ScannedCitation & { demoted?: boolean }> = [];
    const closers = new Map<MathMarkerPair, { from: number; at: number }>();
    let finder: Finder | null = null;
    let runs: Map<number, number[]> | null = null;
    let closes: Int32Array | null = null;
    const hasAt = text.includes("@");
    // Links cannot contain links: brackets below this stack height are inactive.
    let inactiveBelow = 0;
    let index = 0;
    while (index < length) {
      const code = text.charCodeAt(index);
      if (this.mathStarts.has(code)) {
        const end = this.inlineMath(segment, index, closers);
        if (end > 0) {
          this.skipText(segment, index, end);
          index = end;
          continue;
        }
      }
      if (code === 92) {
        index += index + 1 < length && isAsciiPunctuation(text.charCodeAt(index + 1)) ? 2 : 1;
        continue;
      }
      if (code === 96) {
        let size = 1;
        while (text.charCodeAt(index + size) === 96) size += 1;
        runs ??= backtickRuns(text);
        const close = nextRun(runs.get(size), index + size);
        if (close >= 0) {
          this.skipText(segment, index, close + size);
          index = close + size;
        } else index += size;
        continue;
      }
      // GFM literal autolinks, which cannot start inside an open bracket. An
      // email cannot contain a bracket, but can cover a would-be `www.` or `http`.
      if (!brackets.length && code < 128 && EMAIL_START[code]) {
        const end = (hasAt ? literalEmailEnd(text, index) : undefined)
          ?? (code === 104 || code === 72 || code === 119 || code === 87 ? literalAutolinkEnd(text, index) : -1);
        if (end > 0) {
          this.skipText(segment, index, end);
          index = end;
          continue;
        }
      }
      if (code === 64) {
        const narrative = this.narrativeToken(segment, index);
        if (narrative) {
          citations.push(narrative.occurrence);
          index = narrative.end;
          continue;
        }
      }
      if (code === 60) {
        const next = text[index + 1];
        if (next === "!" || next === "?") finder ??= new Finder(text);
        const end = inlineHtmlEnd(text, index, finder);
        if (end > 0) {
          this.skipText(segment, index, end);
          index = end;
        } else index += 1;
        continue;
      }
      if (code === 33 && text.charCodeAt(index + 1) === 91) {
        brackets.push({ index: index + 1, image: true, citations: citations.length });
        index += 2;
        continue;
      }
      if (code === 91) {
        closes ??= bracketCloses(text);
        const citation = text.charCodeAt(index - 1) === 33 ? null : this.citationToken(segment, index, closes[index]);
        if (citation) {
          citations.push(citation.occurrence);
          index = citation.end;
        } else {
          brackets.push({ index, image: false, citations: citations.length });
          index += 1;
        }
        continue;
      }
      if (code === 93) {
        const opener = brackets.pop();
        const inactive = opener && !opener.image && brackets.length < inactiveBelow;
        inactiveBelow = Math.min(inactiveBelow, brackets.length);
        const end = opener && !inactive ? this.linkEnd(segment, opener.index, index) : -1;
        if (opener && end > 0) {
          for (let cited = opener.citations; cited < citations.length; cited += 1) citations[cited].demoted = true;
          if (!opener.image) inactiveBelow = brackets.length;
          index = end;
        } else index += 1;
        continue;
      }
      index += 1;
    }
    for (const citation of citations) if (!citation.demoted) this.citations.push({ citation: citation.citation, start: citation.start, end: citation.end, keys: citation.keys });
  }

  private skipText(segment: Segment, start: number, end: number) {
    this.skip(sourceAt(segment, start), sourceAt(segment, end - 1) + 1);
  }

  private inlineMath(segment: Segment, index: number, closers: Map<MathMarkerPair, { from: number; at: number }>) {
    const text = segment.text;
    for (const pair of this.inlinePairs) {
      if (!text.startsWith(pair.open, index)) continue;
      const from = index + pair.open.length;
      const first = text.charCodeAt(from);
      if (this.pairs.some((other) => other.open.length > pair.open.length && other.open.startsWith(pair.open) && other.open.charCodeAt(pair.open.length) === first)) continue;
      const lineEnd = pieceEnd(segment, from);
      let search = from;
      for (;;) {
        const memo = closers.get(pair);
        let at: number;
        if (memo && memo.from <= search && (memo.at >= search || memo.at < 0)) at = memo.at;
        else {
          at = text.indexOf(pair.close, search);
          closers.set(pair, { from: search, at });
        }
        if (at < 0 || at + pair.close.length > lineEnd) break;
        // escapedAt counts backslashes inside the body only, as the construct does.
        let backslashes = 0;
        for (let back = at - 1; back >= from && text.charCodeAt(back) === 92; back -= 1) backslashes += 1;
        if (backslashes % 2 === 1) { search = at + 1; continue; }
        if (!text.slice(from, at).trim()) break;
        return at + pair.close.length;
      }
    }
    return -1;
  }

  /** The citation token starting at `segment.text[index] === "["`, whose matching `]` is at `close`, if any. */
  private citationToken(segment: Segment, index: number, close: number) {
    const text = segment.text;
    // At most one line break, and at most CITATION_MAX_LENGTH long (checked on the source below).
    if (close < 0 || close - index >= CITATION_MAX_LENGTH || pieceIndex(segment, close) - pieceIndex(segment, index) > 1) return null;
    const end = close + 1;
    const next = text.charCodeAt(end);
    if (next === 40 || next === 91) return null;
    if (next === 58) {
      let lineStart = index;
      while (lineStart > 0 && (text[lineStart - 1] === " " || text[lineStart - 1] === "\t")) lineStart -= 1;
      if (lineStart === 0 || text[lineStart - 1] === "\n") return null;
    }
    const start = sourceAt(segment, index);
    const stop = sourceAt(segment, end - 1) + 1;
    if (stop - start > CITATION_MAX_LENGTH) return null;
    const parsed = parseCitationContent(text.slice(index + 1, end - 1));
    if (!parsed) return null;
    const keys = parsed.keys.map(([from, to]) => [sourceAt(segment, index + 1 + from), sourceAt(segment, index + 1 + to - 1) + 1] as [number, number]);
    return {
      end,
      occurrence: { citation: { items: parsed.items, raw: this.source.slice(start, stop) }, start, end: stop, keys },
    };
  }

  /** The narrative citation whose `@` is at `segment.text[index]`, if any (link text demotes it later). */
  private narrativeToken(segment: Segment, index: number) {
    const match = narrativeCitationAt(segment.text, index);
    if (!match) return null;
    const start = sourceAt(segment, index);
    const stop = sourceAt(segment, match.end - 1) + 1;
    const key: [number, number] = [sourceAt(segment, match.key[0]), sourceAt(segment, match.key[1] - 1) + 1];
    return {
      end: match.end,
      occurrence: { citation: { items: [match.item], raw: this.source.slice(start, stop), narrative: true }, start, end: stop, keys: [key] },
    };
  }

  /** End of the link or image whose label closes at `close`, or -1 (micromark's label end rules). */
  private linkEnd(segment: Segment, open: number, close: number) {
    const text = segment.text;
    const defined = this.defined.has(normalizeLabel(text.slice(open + 1, close)));
    const next = text.charCodeAt(close + 1);
    if (next === 40) {
      const end = matchResource(text, close + 1);
      if (end > 0) {
        this.skipText(segment, close + 1, end);
        return end;
      }
      return defined ? close + 1 : -1;
    }
    if (next === 91) {
      const end = matchReferenceLabel(text, close + 1);
      if (end > 0 && this.defined.has(normalizeLabel(text.slice(close + 2, end - 1)))) return end;
      if (defined && text.charCodeAt(close + 2) === 93) return close + 3;
      return -1;
    }
    return defined ? close + 1 : -1;
  }
}

const UNICODE_PUNCTUATION = new RegExp(String.raw`[\p{P}\p{S}]`, "u");
const ASCII_ALPHA = /[A-Za-z]/;
const PROTOCOL = /https?:\/\//iy;
const WWW = /www\./iy;
const PATH_PUNCTUATION = new Set([..."!\"&')*,.:;<?]_~"]);
const TRAIL_PUNCTUATION = new Set([..."!\"')*,.:;?_~"]);

function isSpace(char: string | undefined) {
  return char !== undefined && WHITESPACE.test(char);
}

/** Whether trailing punctuation from `index` ends a literal autolink (micromark's `trail`). */
function autolinkTrail(text: string, index: number) {
  for (;;) {
    const char = text[index];
    if (char !== undefined && TRAIL_PUNCTUATION.has(char)) { index += 1; continue; }
    if (char === "&") {
      index += 1;
      if (!ASCII_ALPHA.test(text[index] ?? "")) return false;
      while (ASCII_ALPHA.test(text[index] ?? "")) index += 1;
      if (text[index] !== ";") return false;
      index += 1;
      continue;
    }
    if (char === "]") {
      index += 1;
      const next = text[index];
      if (next === undefined || next === "(" || next === "[" || isSpace(next)) return true;
      continue;
    }
    return char === undefined || char === "<" || isSpace(char);
  }
}

const EMAIL_ATEXT = /[A-Za-z0-9+\-._]/;
/** Characters that may start a GFM literal email or URL, by char code. */
const EMAIL_START = Array.from({ length: 128 }, (_, code) => EMAIL_ATEXT.test(String.fromCharCode(code)));
const ASCII_ALPHANUMERIC = /[A-Za-z0-9]/;

/** End of a GFM literal email autolink starting at `index`, or undefined. */
function literalEmailEnd(text: string, index: number) {
  const previous = text[index - 1];
  if (previous === "/" || (previous !== undefined && EMAIL_ATEXT.test(previous))) return undefined;
  let at = index;
  while (at < text.length && EMAIL_ATEXT.test(text[at])) at += 1;
  if (text[at] !== "@") return undefined;
  at += 1;
  let dot = false;
  let data = false;
  for (;;) {
    const char = text[at];
    if (char === ".") {
      if (!ASCII_ALPHANUMERIC.test(text[at + 1] ?? "")) break;
      dot = true;
    } else if (char === "-" || char === "_" || ASCII_ALPHANUMERIC.test(char ?? "")) data = true;
    else break;
    at += 1;
  }
  return data && dot && ASCII_ALPHA.test(text[at - 1]) ? at : undefined;
}

/** End of a GFM literal autolink (`www.…`, `http://…`, `https://…`) starting at `index`, or -1. */
function literalAutolinkEnd(text: string, index: number) {
  const previous = text[index - 1];
  let from: number;
  if (text[index] === "w" || text[index] === "W") {
    if (!(previous === undefined || "(*_[]~".includes(previous) || isSpace(previous))) return -1;
    WWW.lastIndex = index;
    if (!WWW.test(text) || index + 4 >= text.length) return -1;
    from = index;
  } else {
    if (previous !== undefined && ASCII_ALPHA.test(previous)) return -1;
    PROTOCOL.lastIndex = index;
    if (!PROTOCOL.test(text)) return -1;
    from = PROTOCOL.lastIndex;
    const next = text[from];
    if (next === undefined || next.charCodeAt(0) < 32 || next.charCodeAt(0) === 127 || isSpace(next) || UNICODE_PUNCTUATION.test(next)) return -1;
  }
  // Domain.
  let seen = false;
  let underscoreInLast = false;
  let underscoreInLastButOne = false;
  for (;;) {
    const char = text[from];
    if (char === "." || char === "_") {
      if (autolinkTrail(text, from)) break;
      if (char === "_") underscoreInLast = true;
      else { underscoreInLastButOne = underscoreInLast; underscoreInLast = false; }
      from += 1;
      continue;
    }
    if (char === undefined || isSpace(char) || (char !== "-" && UNICODE_PUNCTUATION.test(char))) break;
    seen = true;
    from += 1;
  }
  if (underscoreInLast || underscoreInLastButOne || !seen) return -1;
  // Path.
  let open = 0;
  let close = 0;
  for (;;) {
    const char = text[from];
    if (char === "(") { open += 1; from += 1; continue; }
    if (char === ")" && close < open) { close += 1; from += 1; continue; }
    if (char !== undefined && PATH_PUNCTUATION.has(char)) {
      if (autolinkTrail(text, from)) return from;
      if (char === ")") close += 1;
      from += 1;
      continue;
    }
    if (char === undefined || isSpace(char)) return from;
    from += 1;
  }
}

function backtickRuns(text: string) {
  const runs = new Map<number, number[]>();
  for (let index = text.indexOf("`"); index >= 0; index = text.indexOf("`", index)) {
    let size = 1;
    while (text.charCodeAt(index + size) === 96) size += 1;
    let list = runs.get(size);
    if (!list) runs.set(size, list = []);
    list.push(index);
    index += size;
  }
  return runs;
}

function nextRun(list: number[] | undefined, from: number) {
  if (!list) return -1;
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (list[mid] < from) low = mid + 1; else high = mid;
  }
  return low < list.length ? list[low] : -1;
}

function skipLinkWhitespace(text: string, index: number) {
  let lineBreaks = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "\n") { if (++lineBreaks > 1) break; } else if (char !== " " && char !== "\t") break;
    index += 1;
  }
  return index;
}

/** End of an inline link resource `(dest "title")` starting at `text[start] === "("`, or -1. */
function matchResource(text: string, start: number) {
  let index = skipLinkWhitespace(text, start + 1);
  if (text[index] === ")") return index + 1;
  if (text[index] === "<") {
    index += 1;
    for (;;) {
      const char = text[index];
      if (char === undefined || char === "\n" || char === "<") return -1;
      if (char === ">") { index += 1; break; }
      index += char === "\\" && isAsciiPunctuation(text.charCodeAt(index + 1)) ? 2 : 1;
    }
  } else {
    let depth = 0;
    const from = index;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code <= 32 || code === 127) break;
      if (code === 92 && isAsciiPunctuation(text.charCodeAt(index + 1))) { index += 2; continue; }
      if (code === 40) { if (++depth > 32) return -1; } else if (code === 41) { if (depth === 0) break; depth -= 1; }
      index += 1;
    }
    if (depth !== 0 || index === from) return -1;
  }
  const beforeTitle = index;
  index = skipLinkWhitespace(text, index);
  const quote = text[index];
  if (index > beforeTitle && (quote === '"' || quote === "'" || quote === "(")) {
    const closing = quote === "(" ? ")" : quote;
    index += 1;
    for (;;) {
      const char = text[index];
      if (char === undefined) return -1;
      if (char === closing) { index += 1; break; }
      index += char === "\\" && isAsciiPunctuation(text.charCodeAt(index + 1)) ? 2 : 1;
    }
    index = skipLinkWhitespace(text, index);
  }
  return text[index] === ")" ? index + 1 : -1;
}

function skipSpaces(text: string, index: number) {
  while (text[index] === " " || text[index] === "\t") index += 1;
  return index;
}

/**
 * A link reference definition at the start of `text` (lines joined by "\n"),
 * as micromark parses it: its label and the end offset of its last line.
 */
function parseDefinition(text: string) {
  const labelEnd = matchReferenceLabel(text, 0);
  if (labelEnd < 0 || text[labelEnd] !== ":") return null;
  let index = skipSpaces(text, labelEnd + 1);
  if (text[index] === "\n") index = skipSpaces(text, index + 1);
  if (text[index] === "<") {
    index += 1;
    for (;;) {
      const char = text[index];
      if (char === undefined || char === "\n" || char === "<") return null;
      if (char === ">") { index += 1; break; }
      index += char === "\\" && isAsciiPunctuation(text.charCodeAt(index + 1)) ? 2 : 1;
    }
  } else {
    let depth = 0;
    const from = index;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code <= 32 || code === 127) break;
      if (code === 92 && isAsciiPunctuation(text.charCodeAt(index + 1))) { index += 2; continue; }
      if (code === 40) depth += 1; else if (code === 41) { if (depth === 0) break; depth -= 1; }
      index += 1;
    }
    if (depth !== 0 || index === from) return null;
  }
  const label = text.slice(1, labelEnd - 1);
  const destinationEnd = index;
  // An optional title, after whitespace that may include a line ending.
  let title = skipSpaces(text, index);
  if (text[title] === "\n") title = skipSpaces(text, title + 1);
  const quote = text[title];
  if (title > destinationEnd && (quote === '"' || quote === "'" || quote === "(")) {
    const closing = quote === "(" ? ")" : quote;
    let at = title + 1;
    for (;;) {
      const char = text[at];
      if (char === undefined) { at = -1; break; }
      if (char === closing) { at += 1; break; }
      at += char === "\\" && isAsciiPunctuation(text.charCodeAt(at + 1)) ? 2 : 1;
    }
    if (at > 0) {
      at = skipSpaces(text, at);
      if (at === text.length || text[at] === "\n") return { label, end: at };
    }
  }
  const end = skipSpaces(text, destinationEnd);
  return end === text.length || text[end] === "\n" ? { label, end } : null;
}

/** End of a reference label `[label]` starting at `text[start] === "["`, or -1. */
function matchReferenceLabel(text: string, start: number) {
  let seen = false;
  for (let index = start + 1; index < text.length && index - start <= 1000; index += 1) {
    const char = text[index];
    if (char === "[") return -1;
    if (char === "]") return seen ? index + 1 : -1;
    if (char === "\\" && isAsciiPunctuation(text.charCodeAt(index + 1))) index += 1;
    if (!WHITESPACE.test(char)) seen = true;
  }
  return -1;
}

let cached: { source: string; key: string; analysis: Analysis } | null = null;

function analyze(markdown: string, options: CitationSyntaxOptions = {}) {
  const key = `${options.mathMarkers?.inlineMathMarkers ?? ""}\u0000${options.mathMarkers?.blockMathMarkers ?? ""}\u0000${options.mathMarkers ? 1 : 0}`;
  if (cached && cached.source === markdown && cached.key === key) return cached.analysis;
  const analysis = new Analyzer(markdown, options).run();
  cached = { source: markdown, key, analysis };
  return analysis;
}

function inSkip(skips: number[], offset: number) {
  let low = 0;
  let high = skips.length / 2;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (skips[mid * 2 + 1] <= offset) low = mid + 1; else high = mid;
  }
  return low < skips.length / 2 && skips[low * 2] <= offset;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Every citation in a Markdown source, in document order, with UTF-16
 * offsets. `citation.raw` is the exact source slice. Front matter, code
 * (fenced, indented, spans), math, HTML, autolinks and link destinations are
 * skipped, as are bracketed tokens that turn out to be link or image text.
 */
export function scanCitations(markdown: string, options?: CitationSyntaxOptions): CitationOccurrence[] {
  return analyze(markdown, options).citations.map(({ citation, start, end }) => ({ citation: copyCitation(citation), start, end }));
}

function copyCitation(citation: Citation): Citation {
  const copy: Citation = { items: citation.items.map((item) => ({ ...item })), raw: citation.raw };
  if (citation.narrative) copy.narrative = true;
  return copy;
}

/**
 * The occurrences that are citations given the library: every bracketed one,
 * and a narrative one only when `resolves` knows its key (none without
 * `resolves`). See the header: an unresolved `@word` is plain text.
 */
export function resolvedCitationOccurrences<T extends { citation: Citation }>(occurrences: readonly T[], resolves?: ((key: string) => boolean) | null): T[] {
  return occurrences.filter(({ citation }) => !citation.narrative || Boolean(resolves && citation.items.every((item) => resolves(item.key))));
}

/** The citation containing `offset` (`start <= offset < end`), or null. For hover and click. */
export function citationAt(markdown: string, offset: number, options?: CitationSyntaxOptions): CitationOccurrence | null {
  const citations = analyze(markdown, options).citations;
  let low = 0;
  let high = citations.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (citations[mid].end <= offset) low = mid + 1; else high = mid;
  }
  const found = citations[low];
  if (!found || found.start > offset) return null;
  return { citation: copyCitation(found.citation), start: found.start, end: found.end };
}

export type CitedKeysOptions = CitationSyntaxOptions & {
  /** Whether a key is in the library: a narrative citation counts only when its key resolves. */
  resolves?: ((key: string) => boolean) | null;
  /** Count every narrative candidate, resolved or not. */
  allNarrative?: boolean;
};

/**
 * Unique cited keys in document order: the keys of bracketed citations, and
 * of narrative ones that resolve (or all of them with `allNarrative`).
 */
export function citedKeys(markdown: string, options?: CitedKeysOptions) {
  const keys = new Set<string>();
  const resolves = options?.resolves;
  for (const { citation } of analyze(markdown, options).citations) {
    if (citation.narrative && !options?.allNarrative && !(resolves && resolves(citation.items[0].key))) continue;
    for (const item of citation.items) keys.add(item.key);
  }
  return [...keys];
}

/**
 * Replace keys inside real citation tokens (`map` is old key → new key).
 * Every other byte is preserved. `count` is the number of keys replaced.
 */
export function rewriteCitationKeys(markdown: string, map: Map<string, string>, options?: CitationSyntaxOptions) {
  let text = "";
  let last = 0;
  let count = 0;
  for (const { keys } of analyze(markdown, options).citations) {
    for (const [start, end] of keys) {
      const replacement = map.get(markdown.slice(start, end));
      if (replacement === undefined || replacement === markdown.slice(start, end)) continue;
      text += markdown.slice(last, start) + replacement;
      last = end;
      count += 1;
    }
  }
  return { text: count ? text + markdown.slice(last) : markdown, count };
}

export type CitationTrigger = {
  /** Index of the `@`. */
  from: number;
  /** Key characters typed after the `@`. */
  query: string;
  /** The `@` is inside a bracketed citation, existing or being typed: insert just the key. */
  insideCitation: boolean;
};

const TRIGGER_BEFORE = new Set(["", " ", "\t", "\n", "\r", "[", "(", ";"]);

/**
 * The `@` autocomplete trigger ending at `offset`: `@` plus key characters,
 * where the `@` starts the text or a line, or follows whitespace, `[`, `(`,
 * `;` or a `-` that does. Never inside a word (emails), code, math, link
 * destinations, HTML or front matter.
 */
export function citationTriggerAt(text: string, offset: number, options?: CitationSyntaxOptions): CitationTrigger | null {
  if (offset < 1 || offset > text.length) return null;
  const window = text.slice(Math.max(0, offset - 256), offset);
  const typed = KEY_CHARACTERS.exec(window)?.[0] ?? "";
  const at = offset - typed.length - 1;
  if (at < 0 || text[at] !== "@") return null;
  const query = typed;
  if (!QUERY.test(query)) return null;
  const before = at > 0 ? text[at - 1] : "";
  if (before === "-") {
    const beforeDash = at > 1 ? text[at - 2] : "";
    if (!TRIGGER_BEFORE.has(beforeDash) && !WHITESPACE.test(beforeDash)) return null;
  } else if (!TRIGGER_BEFORE.has(before) && !WHITESPACE.test(before)) return null;
  const analysis = analyze(text, options);
  if (inSkip(analysis.skips, at)) return null;
  const segment = analysis.segments.find((candidate) => candidate.start <= at && at < candidate.end);
  if (!segment) return null;
  if (analysis.citations.some((citation) => !citation.citation.narrative && citation.start < at && at < citation.end)) return { from: at, query, insideCitation: true };
  return { from: at, query, insideCitation: openCitationBefore(segment, at) };
}

/** Whether an unclosed `[` before `at` in the segment opens citation items, e.g. `[see @a; @`. */
function openCitationBefore(segment: Segment, at: number) {
  const text = segment.text;
  let index = -1;
  for (let piece = segment.starts.length - 1; piece >= 0; piece -= 1) {
    if (segment.sources[piece] <= at) { index = segment.starts[piece] + at - segment.sources[piece]; break; }
  }
  let depth = 0;
  for (let open = index - 1; open >= 0 && index - open <= CITATION_MAX_LENGTH; open -= 1) {
    const char = text[open];
    if (escapedAt(text, open)) continue;
    if (char === "]") depth += 1;
    else if (char === "[") {
      if (depth > 0) { depth -= 1; continue; }
      if (text[open - 1] === "!") return false;
      // The items so far must parse, with the `@` being typed as the last key.
      const content = text.slice(open + 1, index);
      if ((content.match(/\n/g)?.length ?? 0) > 1) return false;
      return parseCitationContent(`${content}@x`) !== null;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shared cases
// ---------------------------------------------------------------------------

export type CitationSyntaxCase = {
  name: string;
  /** Markdown source. */
  source: string;
  /** Every citation in the source, in order: its exact source text, parsed items, and whether it is narrative. */
  expected: Array<{ raw: string; items: CitationItem[]; narrative?: true }>;
};

const cite = (raw: string, ...items: CitationItem[]) => ({ raw, items });
/** A narrative candidate: `@key`, or `@key [locator]` with the item's locator. */
const narr = (raw: string, item?: Partial<CitationItem>) => ({ raw, items: [{ key: /^@([^\s[]+)/.exec(raw)![1], ...item }], narrative: true as const });

/**
 * The grammar as Markdown source → citations. Every parser layer (this
 * scanner, remark-citations, the TipTap and CodeMirror parsers) runs this
 * table, so it describes source text only.
 */
export const CITATION_SYNTAX_CASES: CitationSyntaxCase[] = [
  // Tokens and items
  { name: "single key", source: "See [@smith2020sparse].", expected: [cite("[@smith2020sparse]", { key: "smith2020sparse" })] },
  { name: "page locator", source: "[@smith2020sparse, p. 12]", expected: [cite("[@smith2020sparse, p. 12]", { key: "smith2020sparse", label: "page", locator: "12" })] },
  { name: "page range", source: "[@a, pp. 12-14]", expected: [cite("[@a, pp. 12-14]", { key: "a", label: "page", locator: "12-14" })] },
  { name: "en-dash range and list", source: "[@a, pp. 12–14, 18]", expected: [cite("[@a, pp. 12–14, 18]", { key: "a", label: "page", locator: "12–14, 18" })] },
  { name: "ampersand list", source: "[@a, pp. 3 & 7]", expected: [cite("[@a, pp. 3 & 7]", { key: "a", label: "page", locator: "3 & 7" })] },
  { name: "several works", source: "[@a; @b]", expected: [cite("[@a; @b]", { key: "a" }, { key: "b" })] },
  { name: "prefix and chapter", source: "[see @a, ch. 3]", expected: [cite("[see @a, ch. 3]", { key: "a", prefix: "see", label: "chapter", locator: "3" })] },
  { name: "suppress author", source: "Smith says [-@a].", expected: [cite("[-@a]", { key: "a", suppressAuthor: true })] },
  { name: "suppress author with prefix and locator", source: "[see -@a, p. 4]", expected: [cite("[see -@a, p. 4]", { key: "a", prefix: "see", suppressAuthor: true, label: "page", locator: "4" })] },
  { name: "several items with prefixes", source: "[see @a, p. 1; also @b, ch. 2; cf. @c]", expected: [cite("[see @a, p. 1; also @b, ch. 2; cf. @c]", { key: "a", prefix: "see", label: "page", locator: "1" }, { key: "b", prefix: "also", label: "chapter", locator: "2" }, { key: "c", prefix: "cf." })] },
  { name: "suffix only", source: "[@a, emphasis added]", expected: [cite("[@a, emphasis added]", { key: "a", suffix: "emphasis added" })] },
  { name: "locator and suffix", source: "[@a, p. 33, emphasis added]", expected: [cite("[@a, p. 33, emphasis added]", { key: "a", label: "page", locator: "33", suffix: "emphasis added" })] },
  { name: "locator and suffix without comma", source: "[@a, pp. 33-35 and passim]", expected: [cite("[@a, pp. 33-35 and passim]", { key: "a", label: "page", locator: "33-35", suffix: "and passim" })] },
  { name: "unlabeled number is a page", source: "[@a, 33]", expected: [cite("[@a, 33]", { key: "a", label: "page", locator: "33" })] },
  { name: "unlabeled roman numeral is a page", source: "[@a, xiv]", expected: [cite("[@a, xiv]", { key: "a", label: "page", locator: "xiv" })] },
  { name: "letters attached to digits", source: "[@a, e1234; @b, fig. 2b; @c, tbl. S3]", expected: [cite("[@a, e1234; @b, fig. 2b; @c, tbl. S3]", { key: "a", label: "page", locator: "e1234" }, { key: "b", label: "figure", locator: "2b" }, { key: "c", label: "table", locator: "S3" })] },
  { name: "braced literal locator", source: "[@a, chap. {iv-ix}; @b, {A.3}]", expected: [cite("[@a, chap. {iv-ix}; @b, {A.3}]", { key: "a", label: "chapter", locator: "iv-ix" }, { key: "b", label: "page", locator: "A.3" })] },
  { name: "section signs", source: "[@a, § 4.2; @b, §§ 4–6]", expected: [cite("[@a, § 4.2; @b, §§ 4–6]", { key: "a", label: "section", locator: "4.2" }, { key: "b", label: "section", locator: "4–6" })] },
  { name: "paragraph, line and volume labels", source: "[@a, ¶ 7; @b, ll. 10-12; @c, vol. 2]", expected: [cite("[@a, ¶ 7; @b, ll. 10-12; @c, vol. 2]", { key: "a", label: "paragraph", locator: "7" }, { key: "b", label: "line", locator: "10-12" }, { key: "c", label: "volume", locator: "2" })] },
  { name: "note, verse and column labels", source: "[@a, n. 14; @b, vv. 3:16-18; @c, col. 4]", expected: [cite("[@a, n. 14; @b, vv. 3:16-18; @c, col. 4]", { key: "a", label: "note", locator: "14" }, { key: "b", label: "verse", locator: "3:16-18" }, { key: "c", label: "column", locator: "4" })] },
  { name: "part, book and opus labels", source: "[@a, pt. II; @b, bk. 3; @c, op. 27]", expected: [cite("[@a, pt. II; @b, bk. 3; @c, op. 27]", { key: "a", label: "part", locator: "II" }, { key: "b", label: "book", locator: "3" }, { key: "c", label: "opus", locator: "27" })] },
  { name: "sub verbo, appendix and equation labels", source: "[@a, s.v. {sparse}; @b, app. 2; @c, eqs. 3-4]", expected: [cite("[@a, s.v. {sparse}; @b, app. 2; @c, eqs. 3-4]", { key: "a", label: "sub-verbo", locator: "sparse" }, { key: "b", label: "appendix", locator: "2" }, { key: "c", label: "equation", locator: "3-4" })] },
  { name: "folio and issue labels", source: "[@a, fol. 12r; @b, no. 4]", expected: [cite("[@a, fol. 12r; @b, no. 4]", { key: "a", label: "folio", locator: "12r" }, { key: "b", label: "issue", locator: "4" })] },
  { name: "labels are case-insensitive", source: "[@a, P. 12; @b, Chapter 3; @c, SEC. 2]", expected: [cite("[@a, P. 12; @b, Chapter 3; @c, SEC. 2]", { key: "a", label: "page", locator: "12" }, { key: "b", label: "chapter", locator: "3" }, { key: "c", label: "section", locator: "2" })] },
  { name: "label without a value is a suffix", source: "[@a, chapter one]", expected: [cite("[@a, chapter one]", { key: "a", suffix: "chapter one" })] },
  { name: "Unicode keys", source: "[@müller2020; @黄2021学习]", expected: [cite("[@müller2020; @黄2021学习]", { key: "müller2020" }, { key: "黄2021学习" })] },
  { name: "internal key punctuation", source: "[@doe:2020.a/b; @x-y_z]", expected: [cite("[@doe:2020.a/b; @x-y_z]", { key: "doe:2020.a/b" }, { key: "x-y_z" })] },
  { name: "trailing key punctuation is not part of the key", source: "[@doe99.]", expected: [cite("[@doe99.]", { key: "doe99", suffix: "." })] },
  { name: "keys are case-sensitive", source: "[@Smith2020] and [@smith2020]", expected: [cite("[@Smith2020]", { key: "Smith2020" }), cite("[@smith2020]", { key: "smith2020" })] },
  { name: "nested brackets in the prefix", source: "[see [the appendix] of @a]", expected: [cite("[see [the appendix] of @a]", { key: "a", prefix: "see [the appendix] of" })] },
  { name: "escaped brackets in the suffix", source: "[@a, p. 3 \\[sic\\]]", expected: [cite("[@a, p. 3 \\[sic\\]]", { key: "a", label: "page", locator: "3", suffix: "\\[sic\\]" })] },
  { name: "Markdown in the prefix", source: "[*see* @a]", expected: [cite("[*see* @a]", { key: "a", prefix: "*see*" })] },
  { name: "soft line break", source: "As argued [see\n@a, p. 3].", expected: [cite("[see\n@a, p. 3]", { key: "a", prefix: "see", label: "page", locator: "3" })] },
  { name: "CRLF line break", source: "[see\r\n@a]", expected: [cite("[see\r\n@a]", { key: "a", prefix: "see" })] },
  // Not citations
  { name: "bracket without a key", source: "[see above] and [1]", expected: [] },
  { name: "two keys in one item", source: "[@a and @b]", expected: [narr("@a"), narr("@b")] },
  { name: "empty item", source: "[@a;] [@b; ]", expected: [narr("@a"), narr("@b")] },
  { name: "@ inside a word", source: "[a-@b] [me@example.com] [*@c*]", expected: [] },
  { name: "bare @key is a narrative candidate", source: "As @smith2020 shows, thanks to @alice.", expected: [narr("@smith2020"), narr("@alice")] },
  { name: "email addresses", source: "Write to me@example.com or <me@example.com>.", expected: [] },
  { name: "handles beside a citation", source: "Thanks @alice for [@bob].", expected: [narr("@alice"), cite("[@bob]", { key: "bob" })] },
  { name: "blank line inside", source: "[see\n\n@a]", expected: [narr("@a")] },
  { name: "two line breaks", source: "[see\nalso\n@a]", expected: [narr("@a")] },
  { name: "longer than 2000 characters", source: `[@a, ${"x".repeat(2000)}]`, expected: [narr("@a")] },
  // Links, images, references, definitions
  { name: "inline link", source: "[@x](https://example.com) [@y](<a b>)", expected: [] },
  { name: "full and collapsed references", source: "[@x][ref] [@y][]\n\n[ref]: https://example.com", expected: [narr("@y")] },
  { name: "link reference definition", source: "[@x]: https://example.com\n   [@y]: /y", expected: [] },
  { name: "bracket colon outside line start", source: "Note [@a]: it holds.", expected: [cite("[@a]", { key: "a" })] },
  { name: "defined label still cites", source: "[@x]\n\n[@x]: https://example.com", expected: [cite("[@x]", { key: "x" })] },
  { name: "images", source: "![@x](a.png) ![@y] ![see @z]", expected: [narr("@y"), narr("@z")] },
  { name: "escaped brackets", source: "\\[@x] and \\[@y\\]", expected: [] },
  { name: "after an escaped exclamation mark", source: "\\![@x]", expected: [narr("@x")] },
  { name: "escaped at sign", source: "[\\@x]", expected: [] },
  { name: "inside link text", source: "[see [@x] here](https://example.com)", expected: [] },
  { name: "inside image alt text", source: "![chart [@x]](chart.png)", expected: [] },
  { name: "citation then reference label", source: "[@a][@b]", expected: [narr("@a"), cite("[@b]", { key: "b" })] },
  { name: "link destination and title", source: "[link](https://example.com/[@x] \"[@t]\") [@y]", expected: [cite("[@y]", { key: "y" })] },
  { name: "autolinks", source: "<https://example.com/[@x]> https://example.com/[@z] [@y]", expected: [cite("[@y]", { key: "y" })] },
  { name: "literal www link", source: "www.example.com/[@x] [@y]", expected: [cite("[@y]", { key: "y" })] },
  { name: "literal email covering a URL", source: "Mail me@x.org.https://example.com/[@a] or [@b]", expected: [cite("[@a]", { key: "a" }), cite("[@b]", { key: "b" })] },
  { name: "multi-line definition", source: "[ref]:\n  /url\n  \"[@x]\"\n\n[@y]", expected: [cite("[@y]", { key: "y" })] },
  { name: "footnotes", source: "Claim[^1].\n\n[^1]: See [@a].", expected: [cite("[@a]", { key: "a" })] },
  // Code, math, HTML, front matter
  { name: "code span", source: "`[@x]` and [@y]", expected: [cite("[@y]", { key: "y" })] },
  { name: "longer code span", source: "``a ` [@x]`` [@y]", expected: [cite("[@y]", { key: "y" })] },
  { name: "fenced code", source: "```\n[@x]\n```\n\n[@y]", expected: [cite("[@y]", { key: "y" })] },
  { name: "long tilde fence", source: "~~~~md\n[@x]\n~~~\n[@z]\n~~~~\n[@y]", expected: [cite("[@y]", { key: "y" })] },
  { name: "fence in a list", source: "- item\n\n  ```\n  [@x]\n  ```\n- [@y]", expected: [cite("[@y]", { key: "y" })] },
  { name: "fence in a blockquote", source: "> ```\n> [@x]\n> ```\n> [@y]", expected: [cite("[@y]", { key: "y" })] },
  { name: "fence in a box", source: "y> ```\ny> [@x]\ny> ```\ny> [@y]", expected: [cite("[@y]", { key: "y" })] },
  { name: "indented code", source: "Para\n\n    [@x]\n\n[@y]", expected: [cite("[@y]", { key: "y" })] },
  { name: "indented text in a list is not code", source: "- one\n\n    [@a]", expected: [cite("[@a]", { key: "a" })] },
  { name: "an empty list item ends at a blank line", source: "-\n\n    [@x]", expected: [] },
  { name: "inline math", source: "$[@x]$ and [@y]", expected: [cite("[@y]", { key: "y" })] },
  { name: "double-dollar math", source: "$$[@x]$$ [@y]", expected: [cite("[@y]", { key: "y" })] },
  { name: "parenthesis math", source: "\\([@x]\\) [@y]", expected: [cite("[@y]", { key: "y" })] },
  { name: "display math", source: "\\[\n[@x]\n\\]\n\n[@y]", expected: [cite("[@y]", { key: "y" })] },
  { name: "unbalanced dollar", source: "It costs $5 [@a].", expected: [cite("[@a]", { key: "a" })] },
  { name: "citation containing a dollar key", source: "[@a$b]", expected: [cite("[@a$b]", { key: "a$b" })] },
  { name: "HTML comment", source: "Text <!-- [@x] --> [@y]", expected: [cite("[@y]", { key: "y" })] },
  { name: "HTML comment block", source: "<!-- [@x] --> [@y]\n\n[@z]", expected: [cite("[@z]", { key: "z" })] },
  { name: "raw HTML attribute", source: "<span title=\"[@x]\">t</span> [@y]", expected: [cite("[@y]", { key: "y" })] },
  { name: "HTML block", source: "<div>\n[@x]\n</div>\n\n[@y]", expected: [cite("[@y]", { key: "y" })] },
  { name: "front matter", source: "---\ntitle: \"[@x]\"\n---\n\n[@y]", expected: [cite("[@y]", { key: "y" })] },
  // Blocks
  { name: "blockquote", source: "> As shown [@a].", expected: [cite("[@a]", { key: "a" })] },
  { name: "multi-line citation in a blockquote", source: "> [see\n> @a]", expected: [cite("[see\n> @a]", { key: "a", prefix: "see" })] },
  { name: "box", source: "y> Boxed [@a]", expected: [cite("[@a]", { key: "a" })] },
  { name: "list items", source: "- one [@a]\n- two [@b]\n1. three [@c]", expected: [cite("[@a]", { key: "a" }), cite("[@b]", { key: "b" }), cite("[@c]", { key: "c" })] },
  { name: "table cells", source: "| Claim | Source |\n| --- | --- |\n| Sparse | [@a] |", expected: [cite("[@a]", { key: "a" })] },
  { name: "headings", source: "## Results [@a]\n\nMethods [@b]\n===", expected: [cite("[@a]", { key: "a" }), cite("[@b]", { key: "b" })] },
  { name: "adjacent punctuation", source: "Shown [@a]. Also ([@b]), [@c]; [@d]!", expected: [cite("[@a]", { key: "a" }), cite("[@b]", { key: "b" }), cite("[@c]", { key: "c" }), cite("[@d]", { key: "d" })] },
  { name: "emphasis around a citation", source: "*[@a]* **[@b]**", expected: [cite("[@a]", { key: "a" }), cite("[@b]", { key: "b" })] },
  // Narrative citations
  { name: "narrative citation", source: "As @smith2020sparse says, it holds.", expected: [narr("@smith2020sparse")] },
  { name: "sentence-initial narrative", source: "@lee2019 argues the opposite.\nThen @doe2001 agrees.", expected: [narr("@lee2019"), narr("@doe2001")] },
  { name: "narrative with a locator", source: "@smith2020 [p. 33] says so.", expected: [narr("@smith2020 [p. 33]", { label: "page", locator: "33" })] },
  { name: "narrative locators with and without a space", source: "@a[ch. 3] and @b [pp. 3-4, emphasis added] and @c [33]", expected: [
    narr("@a[ch. 3]", { label: "chapter", locator: "3" }),
    narr("@b [pp. 3-4, emphasis added]", { label: "page", locator: "3-4", suffix: "emphasis added" }),
    narr("@c [33]", { label: "page", locator: "33" }),
  ] },
  { name: "narrative locator with escaped brackets", source: "@a [p. 3 \\[sic\\]] wrote", expected: [narr("@a [p. 3 \\[sic\\]]", { label: "page", locator: "3", suffix: "\\[sic\\]" })] },
  { name: "a bracket that is not a locator stays text", source: "@alice [the user] said @b [see @c] and @d [p. 3](u) and @e  [p. 4] and @f\n[p. 5]", expected: [
    narr("@alice"), narr("@b"), cite("[see @c]", { key: "c", prefix: "see" }), narr("@d"), narr("@e"), narr("@f"),
  ] },
  { name: "narrative trailing punctuation", source: "By @smith2020. Also @lee2019, @doe:2020; @x-y! @z?", expected: [narr("@smith2020"), narr("@lee2019"), narr("@doe:2020"), narr("@x-y"), narr("@z")] },
  { name: "narrative after brackets and parentheses", source: "(@a) and (see @b, 2020) and [see @c and @d]", expected: [narr("@a"), narr("@b"), narr("@c"), narr("@d")] },
  { name: "narrative not after other characters", source: "*@a* **@b** \"@c\" -@d x@e _@f_ .@g 3@h ~@i", expected: [] },
  { name: "narrative Unicode and internal punctuation", source: "@müller2020 and @黄2021学习 and @doe:2020.a/b.", expected: [narr("@müller2020"), narr("@黄2021学习"), narr("@doe:2020.a/b")] },
  { name: "emails and handles", source: "me@example.com, first.last@uni.edu, https://x.com/@alice, www.example.com/@bob and <mailto:a@b.co>", expected: [] },
  { name: "@ without a key", source: "@ @- @. @[p. 3] a @", expected: [] },
  { name: "escaped narrative", source: "\\@a and \\\\@b", expected: [] },
  { name: "narrative in code and math", source: "`@a` $@b$ \\(@c\\) @d", expected: [narr("@d")] },
  { name: "narrative in link text", source: "[see @a](https://example.com) and [@b text](u) and ![@c](i.png)", expected: [] },
  { name: "narrative in a link destination and title", source: "[x](https://e.com/@a \"@t\") (@y)", expected: [narr("@y")] },
  { name: "narrative in HTML", source: "<span title=\"@a\">@b</span> <!-- @c --> @d", expected: [narr("@d")] },
  { name: "narrative in front matter", source: "---\nauthor: @a\n---\n\n@b", expected: [narr("@b")] },
  { name: "narrative in fenced and indented code", source: "```\n@a\n```\n\n    @b\n\n@c", expected: [narr("@c")] },
  { name: "narrative in blocks", source: "# @a heading\n\n> @b\n\n- @c\n\n| @d | x |\n| --- | --- |\n| y | @e |", expected: [narr("@a"), narr("@b"), narr("@c"), narr("@d"), narr("@e")] },
  { name: "narrative beside citations", source: "@a [@b] and [@c] @d, [see @e] @f [p. 2]", expected: [
    narr("@a"), cite("[@b]", { key: "b" }), cite("[@c]", { key: "c" }), narr("@d"), cite("[see @e]", { key: "e", prefix: "see" }), narr("@f [p. 2]", { label: "page", locator: "2" }),
  ] },
];
