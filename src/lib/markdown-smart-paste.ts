import { parseMarkdownHeadingLines } from "./markdown-heading-enumeration";
import { getSmartPasteTargetLevel, type SmartPasteMode } from "./markdown-heading-numbering";

export type { SmartPasteMode } from "./markdown-heading-numbering";

const MAX_HEADING_LEVEL = 6;

/** How far pasted headings move so the pasted text's highest heading lands one
 * level below the closest heading before the insertion point ("child", the
 * normal paste) or at that heading's level ("peer"). Level 1 without one. */
export function getSmartPasteLevelShift(
  previousLevel: number | undefined,
  pastedLevels: number[],
  mode: SmartPasteMode = "child",
) {
  if (!pastedLevels.length) return 0;
  return getSmartPasteTargetLevel(previousLevel, mode) - Math.min(...pastedLevels);
}

export function shiftHeadingLevel(level: number, shift: number) {
  return Math.max(1, Math.min(MAX_HEADING_LEVEL, level + shift));
}

/**
 * Paste Markdown into a source document, moving the pasted headings under (or
 * beside, for "peer") the closest heading before the insertion point. Heading
 * numbers are left to the editor's structural numbering. Returns null when
 * the pasted text has no headings (the normal paste applies).
 */
export function smartPasteMarkdown(
  value: string,
  selection: { end: number; start: number },
  pasted: string,
  mode: SmartPasteMode = "child",
) {
  const start = Math.max(0, Math.min(selection.start, selection.end, value.length));
  const end = Math.min(value.length, Math.max(selection.start, selection.end));
  const pastedEnd = start + pasted.length;
  const combined = `${value.slice(0, start)}${pasted}${value.slice(end)}`;
  // Parse in context so `#` lines pasted inside a fenced code block stay code.
  const lines = parseMarkdownHeadingLines(combined);
  // Shifting only rewrites heading markers and keeps the line count, so the
  // caret is restored by its distance from the end of its line.
  const caretLine = combined.slice(0, pastedEnd).split("\n").length - 1;
  const caretFromLineEnd = lines[caretLine].lineEnd - pastedEnd;
  const isPasted = (lineStart: number) => lineStart >= start && lineStart < pastedEnd;
  const pastedHeadings = lines.filter((line) => line.heading && isPasted(line.lineStart));
  if (!pastedHeadings.length) return null;

  const previous = lines.filter((line) => line.heading && line.lineStart < start).at(-1);
  const shift = getSmartPasteLevelShift(
    previous?.heading?.level,
    pastedHeadings.map((line) => line.heading!.level),
    mode,
  );
  const shifted = new Set(pastedHeadings.map((line) => line.index));
  const nextLines = lines.map((line) => shift && shifted.has(line.index)
    ? line.line.replace(/^( {0,3})#{1,6}/, (_match, indent: string) =>
        `${indent}${"#".repeat(shiftHeadingLevel(line.heading!.level, shift))}`)
    : line.line);
  const nextValue = nextLines.join("\n");
  const caretLineEnd = nextLines.slice(0, caretLine + 1).reduce((total, line) => total + line.length + 1, -1);
  const caret = Math.max(caretLineEnd - nextLines[caretLine].length, caretLineEnd - caretFromLineEnd);
  return { value: nextValue, selection: { end: caret, start: caret } };
}
