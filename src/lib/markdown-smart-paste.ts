import {
  enumerateHeadingLine,
  getContinuedHeadingNumbers,
  headingNumberPrefixLength,
  markdownHeadingLineText,
  parseMarkdownHeadingLines,
} from "./markdown-heading-enumeration";

const MAX_HEADING_LEVEL = 6;

/** How far pasted headings move so the pasted text's highest heading matches
 * the document's highest heading. A numbered document aligns with its highest
 * numbered level, so an unnumbered title does not pull sections up to H1. */
export function getSmartPasteLevelShift(
  existing: { level: number; text: string }[],
  pastedLevels: number[],
) {
  if (!existing.length || !pastedLevels.length) return 0;
  const numberedLevels = existing
    .filter(({ text }) => headingNumberPrefixLength(text) > 0)
    .map(({ level }) => level);
  const target = Math.min(...(numberedLevels.length ? numberedLevels : existing.map(({ level }) => level)));
  return target - Math.min(...pastedLevels);
}

export function shiftHeadingLevel(level: number, shift: number) {
  return Math.max(1, Math.min(MAX_HEADING_LEVEL, level + shift));
}

/**
 * Paste Markdown into a source document, aligning the pasted headings with the
 * document's top heading level and, when any heading is numbered, renumbering
 * every heading so the numbering continues through the pasted text. Returns
 * null when the pasted text has no headings (the normal paste applies).
 */
export function smartPasteMarkdown(
  value: string,
  selection: { end: number; start: number },
  pasted: string,
) {
  const start = Math.max(0, Math.min(selection.start, selection.end, value.length));
  const end = Math.min(value.length, Math.max(selection.start, selection.end));
  const pastedEnd = start + pasted.length;
  let combined = `${value.slice(0, start)}${pasted}${value.slice(end)}`;
  // Parse in context so `#` lines pasted inside a fenced code block stay code.
  const lines = parseMarkdownHeadingLines(combined);
  // Shifting and renumbering only rewrite heading prefixes and keep the line
  // count, so the caret is restored by its distance from the end of its line.
  const caretLine = combined.slice(0, pastedEnd).split("\n").length - 1;
  const caretFromLineEnd = lines[caretLine].lineEnd - pastedEnd;
  const isPasted = (lineStart: number) => lineStart >= start && lineStart < pastedEnd;
  const pastedHeadings = lines.filter((line) => line.heading && isPasted(line.lineStart));
  if (!pastedHeadings.length) return null;

  const existing = lines.flatMap((line) => line.heading && !isPasted(line.lineStart)
    ? [{ level: line.heading.level, text: markdownHeadingLineText(line.line) }]
    : []);
  const shift = getSmartPasteLevelShift(existing, pastedHeadings.map((line) => line.heading!.level));
  if (shift) {
    const shifted = new Set(pastedHeadings.map((line) => line.index));
    combined = lines.map((line) => shifted.has(line.index)
      ? line.line.replace(/^( {0,3})#{1,6}/, (_match, indent: string) =>
          `${indent}${"#".repeat(shiftHeadingLevel(line.heading!.level, shift))}`)
      : line.line).join("\n");
  }

  const shiftedLines = parseMarkdownHeadingLines(combined);
  const headings = shiftedLines.filter((line) => line.heading);
  const numbers = getContinuedHeadingNumbers(headings.map((line) => ({
    level: line.heading!.level,
    text: markdownHeadingLineText(line.line),
  })));
  const numberByLine = new Map(headings.map((line, index) => [line.index, numbers?.get(index)]));
  const nextLines = shiftedLines.map((line) => {
    const number = numberByLine.get(line.index);
    return number ? enumerateHeadingLine(line.line, number) : line.line;
  });
  const nextValue = nextLines.join("\n");
  const caretLineEnd = nextLines.slice(0, caretLine + 1).reduce((total, line) => total + line.length + 1, -1);
  const caret = Math.max(caretLineEnd - nextLines[caretLine].length, caretLineEnd - caretFromLineEnd);
  return { value: nextValue, selection: { end: caret, start: caret } };
}
