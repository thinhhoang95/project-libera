import {
  getMarkdownEditorLineHighlight,
  initialMarkdownEditorHighlightState,
} from "@/lib/markdown-editor-highlighting";
import type { MarkdownEditorHighlightState } from "@/lib/markdown-editor-highlighting";

export type MarkdownHeadingEnumerationScope = "all" | "selected";

type MarkdownHeadingEnumerationOptions = {
  scope: MarkdownHeadingEnumerationScope;
  selection?: {
    end: number;
    start: number;
  };
  startAt?: number;
};

type MarkdownHeadingLine = {
  heading?: {
    level: number;
  };
  index: number;
  line: string;
  lineEnd: number;
  lineStart: number;
};

const MARKDOWN_HEADING_LINE_REGEX = /^( {0,3})(#{1,6})([ \t]+|$)(.*)$/;
const HEADING_NUMBER_PREFIX_REGEX =
  /^(?:\d+(?:\.\d+)*\.|\d+(?:\.\d+)+)(?:\s+|$)/;
const MAX_HEADING_LEVEL = 6;

function normalizeEnumerationStart(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.floor(value));
}

function normalizeSelection(
  valueLength: number,
  selection: MarkdownHeadingEnumerationOptions["selection"],
) {
  if (!selection) {
    return {
      end: 0,
      start: 0,
    };
  }

  const start = Math.max(0, Math.min(selection.start, valueLength));
  const end = Math.max(0, Math.min(selection.end, valueLength));

  return {
    end: Math.max(start, end),
    start: Math.min(start, end),
  };
}

function isLineSelected(
  line: MarkdownHeadingLine,
  selection: { end: number; start: number },
) {
  return selection.start < line.lineEnd && selection.end > line.lineStart;
}

function parseMarkdownHeadingLines(value: string) {
  const lines = value.split("\n");
  const headingLines: MarkdownHeadingLine[] = [];
  let lineStart = 0;
  let state: MarkdownEditorHighlightState = initialMarkdownEditorHighlightState();

  lines.forEach((line, index) => {
    const lineEnd = lineStart + line.length;
    const highlight = getMarkdownEditorLineHighlight(line, state);
    const headingMatch = highlight.tone
      ? line.match(MARKDOWN_HEADING_LINE_REGEX)
      : null;

    state = highlight.nextState;

    headingLines.push({
      heading: headingMatch
        ? {
            level: (headingMatch[2] ?? "").length,
          }
        : undefined,
      index,
      line,
      lineEnd,
      lineStart,
    });
    lineStart = lineEnd + 1;
  });

  return headingLines;
}

function advanceHeadingCounters(counters: number[], level: number) {
  for (let index = 0; index < level - 1; index += 1) {
    if (counters[index] === 0) {
      counters[index] = 1;
    }
  }

  counters[level - 1] = (counters[level - 1] || 0) + 1;

  for (let index = level; index < counters.length; index += 1) {
    counters[index] = 0;
  }

  return `${counters.slice(0, level).join(".")}.`;
}

export function headingNumberPrefixLength(text: string) {
  return text.match(HEADING_NUMBER_PREFIX_REGEX)?.[0].length ?? 0;
}

/** Shared numbering rules for source lines and rich-text heading nodes. */
export function getHeadingEnumerationNumbers(
  levels: number[],
  options: { scope: MarkdownHeadingEnumerationScope; selectedIndexes?: number[]; startAt?: number },
) {
  const indexes = options.scope === "all"
    ? levels.map((_, index) => index)
    : (options.selectedIndexes ?? []).filter((index) => index >= 0 && index < levels.length);
  const numbers = new Map<number, string>();
  if (!indexes.length) return numbers;
  const firstIndex = indexes[0];
  const baseLevel = options.scope === "selected" ? levels[firstIndex] : 1;
  const counters = Array.from({ length: MAX_HEADING_LEVEL }, () => 0);
  if (options.scope === "selected") {
    levels.slice(0, firstIndex).forEach((level) => advanceHeadingCounters(counters, level));
    for (let index = 0; index < baseLevel - 1; index += 1) {
      if (!counters[index]) counters[index] = 1;
    }
  }
  counters[baseLevel - 1] = normalizeEnumerationStart(options.startAt) - 1;
  for (let index = baseLevel; index < counters.length; index += 1) counters[index] = 0;
  for (const index of indexes) numbers.set(index, advanceHeadingCounters(counters, levels[index]));
  return numbers;
}

function enumerateHeadingLine(line: string, numbering: string) {
  const match = line.match(MARKDOWN_HEADING_LINE_REGEX);

  if (!match) {
    return line;
  }

  const leadingSpaces = match[1] ?? "";
  const headingMarkers = match[2] ?? "";
  const headingText = (match[4] ?? "")
    .replace(HEADING_NUMBER_PREFIX_REGEX, "")
    .trimStart();

  if (!headingText) {
    return `${leadingSpaces}${headingMarkers} ${numbering}`;
  }

  return `${leadingSpaces}${headingMarkers} ${numbering} ${headingText}`;
}

export function enumerateMarkdownHeadings(
  value: string,
  options: MarkdownHeadingEnumerationOptions,
) {
  const selection = normalizeSelection(value.length, options.selection);
  const headingLines = parseMarkdownHeadingLines(value);
  const headings = headingLines.filter((line) => line.heading);
  const numbering = getHeadingEnumerationNumbers(headings.map((line) => line.heading!.level), {
    ...options,
    selectedIndexes: headings.flatMap((line, index) => isLineSelected(line, selection) ? [index] : []),
  });
  const numbersByLine = new Map(headings.map((line, index) => [line.index, numbering.get(index)]));

  const nextLines = headingLines.map((line) => {
    const number = numbersByLine.get(line.index);
    if (!number) {
      return line.line;
    }

    return enumerateHeadingLine(
      line.line,
      number,
    );
  });

  const nextValue = nextLines.join("\n");

  return nextValue === value ? value : nextValue;
}
