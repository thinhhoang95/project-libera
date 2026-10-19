import {
  headingNumberPrefixLength,
  parseMarkdownHeadingLines,
} from "./markdown-heading-enumeration";

/**
 * Structural heading numbering, shared by every Markdown editor (textarea,
 * CodeMirror and the Visual editor).
 *
 * A structurally numbered document numbers every heading from its highest
 * heading level down ("1.", "1.1", "1.1.1"). Optionally the first level-1
 * heading is the document's title and carries no number.
 */
export type HeadingNumberingOptions = {
  /** The first level-1 heading is the title: it is left unnumbered. */
  skipTitle: boolean;
};

export type HeadingNumberingSettings = HeadingNumberingOptions & {
  enabled: boolean;
};

export type TextChange = { from: number; insert: string; to: number };

type HeadingSummary = { level: number; text: string };

const MAX_HEADING_LEVEL = 6;
const MARKDOWN_HEADING_LINE_REGEX = /^( {0,3})(#{1,6})([ \t]+)(.*)$/;
// Digits, dots and the spaces after them: the part of a heading a user is
// editing when they backspace through its number.
const NUMBER_RUN_REGEX = /^[\d.]*[ \t]*/;

function titleIndex(headings: { level: number }[], { skipTitle }: HeadingNumberingOptions) {
  return skipTitle ? headings.findIndex(({ level }) => level === 1) : -1;
}

/** "1.1" or "1.1." for multi-part numbers, following the document's majority;
 * single-part numbers always end with a dot ("1."). */
function usesTrailingDot(headings: HeadingSummary[]) {
  let dotted = 0;
  let plain = 0;
  for (const { text } of headings) {
    const prefix = text.slice(0, headingNumberPrefixLength(text)).trim();
    if (!prefix.replace(/\.$/, "").includes(".")) continue;
    if (prefix.endsWith(".")) dotted += 1;
    else plain += 1;
  }
  return dotted > plain;
}

/**
 * The number each heading should carry: a string such as "2.1", or null for a
 * heading that carries no number (the skipped title).
 */
export function getStructuralHeadingNumbers(
  headings: HeadingSummary[],
  options: HeadingNumberingOptions,
): (string | null)[] {
  const title = titleIndex(headings, options);
  const numbered = headings.filter((_, index) => index !== title);
  if (!numbered.length) return headings.map(() => null);
  const baseLevel = Math.min(...numbered.map(({ level }) => level));
  const trailingDot = usesTrailingDot(numbered);
  const counters = Array.from({ length: MAX_HEADING_LEVEL }, () => 0);
  return headings.map(({ level }, index) => {
    if (index === title) return null;
    const depth = level - baseLevel + 1;
    for (let counter = 0; counter < depth - 1; counter += 1) {
      if (!counters[counter]) counters[counter] = 1;
    }
    counters[depth - 1] += 1;
    for (let counter = depth; counter < counters.length; counter += 1) counters[counter] = 0;
    const parts = counters.slice(0, depth);
    return parts.length === 1 || trailingDot ? `${parts.join(".")}.` : parts.join(".");
  });
}

/** A document opened for the first time counts as structurally numbered when
 * every heading except a possible title already carries a number. */
export function detectStructuralHeadingNumbering(headings: HeadingSummary[]) {
  const title = titleIndex(headings, { skipTitle: true });
  const rest = headings.filter((_, index) => index !== title);
  return rest.length > 0 && rest.every(({ text }) => headingNumberPrefixLength(text) > 0);
}

/** Detection for a Markdown source; null while the document is empty (it may
 * not have loaded yet). */
export function detectMarkdownHeadingNumbering(value: string) {
  return value.trim() ? detectStructuralHeadingNumbering(getNumberableMarkdownHeadings(value)) : null;
}

/** How much of a heading's text is a number run. */
function numberRunLength(text: string) {
  return text.match(NUMBER_RUN_REGEX)?.[0].length ?? 0;
}

/** The ATX heading lines of a Markdown source that numbering applies to.
 * A line of bare `#` markers is not a heading yet: the user may still be
 * typing more markers. Lines in code fences are not headings. */
export function getNumberableMarkdownHeadings(value: string) {
  return parseMarkdownHeadingLines(value).flatMap((line) => {
    if (!line.heading) return [];
    const match = line.line.match(MARKDOWN_HEADING_LINE_REGEX);
    if (!match) return [];
    const textStart = line.lineStart + match[1].length + match[2].length + match[3].length;
    return [{ level: match[2].length, text: match[4] ?? "", textStart }];
  });
}

/**
 * The edits that bring every heading's number in line with the structure.
 *
 * `protectCaret`: after a deletion, the heading whose number the caret is in
 * keeps what the user left, so Backspace can remove a number (and then the
 * heading) instead of the number coming straight back.
 */
export function getMarkdownHeadingNumberingChanges(
  value: string,
  options: HeadingNumberingOptions,
  protectCaret?: number,
): TextChange[] {
  const headings = getNumberableMarkdownHeadings(value);
  const numbers = getStructuralHeadingNumbers(headings, options);
  const changes: TextChange[] = [];
  headings.forEach(({ text, textStart }, index) => {
    const prefixLength = headingNumberPrefixLength(text);
    const number = numbers[index];
    const insert = number === null ? "" : `${number} `;
    if (text.slice(0, prefixLength) === insert) return;
    if (
      protectCaret !== undefined &&
      protectCaret >= textStart &&
      protectCaret <= textStart + numberRunLength(text)
    ) return;
    changes.push({ from: textStart, insert, to: textStart + prefixLength });
  });
  return changes;
}

/** The edits that remove every heading number. */
export function getMarkdownHeadingNumberRemovalChanges(value: string): TextChange[] {
  return getNumberableMarkdownHeadings(value).flatMap(({ text, textStart }) => {
    const prefixLength = headingNumberPrefixLength(text);
    return prefixLength ? [{ from: textStart, insert: "", to: textStart + prefixLength }] : [];
  });
}

/** Apply non-overlapping changes, given in document order. */
export function applyTextChanges(value: string, changes: TextChange[]) {
  let result = "";
  let position = 0;
  for (const { from, insert, to } of changes) {
    result += value.slice(position, from) + insert;
    position = to;
  }
  return result + value.slice(position);
}

/** Where an offset lands after the changes. An offset inside or at either
 * edge of a replaced number moves after the new number, so the caret of a
 * freshly typed `## ` lands after `## 2.1 `. */
export function mapOffsetThroughTextChanges(offset: number, changes: TextChange[]) {
  let delta = 0;
  for (const { from, insert, to } of changes) {
    if (offset < from) break;
    if (offset <= to) return from + delta + insert.length;
    delta += insert.length - (to - from);
  }
  return offset + delta;
}

/** Smart Paste: the level the pasted text's highest heading takes. A normal
 * paste nests under the closest heading before the insertion point; "peer"
 * makes it a sibling of that heading. Without a heading before it, level 1. */
export type SmartPasteMode = "child" | "peer";

export function getSmartPasteTargetLevel(previousLevel: number | undefined, mode: SmartPasteMode) {
  if (!previousLevel) return 1;
  return Math.min(MAX_HEADING_LEVEL, previousLevel + (mode === "child" ? 1 : 0));
}
