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
  /^(?:\d+(?:\.\d+)*\.|\d+(?:\.\d+)+)\s+/;
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
  const startAt = normalizeEnumerationStart(options.startAt);
  const selection = normalizeSelection(value.length, options.selection);
  const headingLines = parseMarkdownHeadingLines(value);
  const targetHeadingLines =
    options.scope === "all"
      ? headingLines.filter((line) => line.heading)
      : headingLines.filter((line) => line.heading && isLineSelected(line, selection));

  if (!targetHeadingLines.length) {
    return value;
  }

  const firstTargetHeading = targetHeadingLines[0];
  const baseLevel =
    options.scope === "selected"
      ? firstTargetHeading.heading?.level ?? 1
      : 1;
  const targetIndexes = new Set(targetHeadingLines.map((line) => line.index));
  const counters = Array.from({ length: MAX_HEADING_LEVEL }, () => 0);

  if (options.scope === "selected") {
    for (const line of headingLines.slice(0, firstTargetHeading.index)) {
      if (line.heading) {
        advanceHeadingCounters(counters, line.heading.level);
      }
    }

    for (let index = 0; index < baseLevel - 1; index += 1) {
      if (counters[index] === 0) {
        counters[index] = 1;
      }
    }
  }

  counters[baseLevel - 1] = startAt - 1;

  for (let index = baseLevel; index < counters.length; index += 1) {
    counters[index] = 0;
  }

  const nextLines = headingLines.map((line) => {
    if (!line.heading || !targetIndexes.has(line.index)) {
      return line.line;
    }

    return enumerateHeadingLine(
      line.line,
      advanceHeadingCounters(counters, line.heading.level),
    );
  });

  const nextValue = nextLines.join("\n");

  return nextValue === value ? value : nextValue;
}
