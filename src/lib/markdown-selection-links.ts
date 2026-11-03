export type MarkdownSourceRange = { start: number; end: number };

/** A text-quote anchor: survives edits elsewhere in the target document. */
export type MarkdownLinkQuote = {
  length: number;
  prefix: string;
  suffix: string;
  text: string;
};

const QUOTE_CONTEXT_LENGTH = 32;
const MAX_QUOTE_TEXT_LENGTH = 1000;
const MAX_LABEL_LENGTH = 60;

export function isMarkdownSourceRange(
  range: MarkdownSourceRange | undefined,
  markdown: string,
): range is MarkdownSourceRange {
  return Boolean(
    range &&
      Number.isInteger(range.start) &&
      Number.isInteger(range.end) &&
      range.start >= 0 &&
      range.end > range.start &&
      range.end <= markdown.length,
  );
}

export function createMarkdownLinkQuote(markdown: string, range: MarkdownSourceRange): MarkdownLinkQuote {
  const length = range.end - range.start;
  const text = markdown.slice(range.start, range.start + Math.min(length, MAX_QUOTE_TEXT_LENGTH));

  return {
    length,
    prefix: markdown.slice(Math.max(0, range.start - QUOTE_CONTEXT_LENGTH), range.start),
    suffix: length <= MAX_QUOTE_TEXT_LENGTH
      ? markdown.slice(range.end, range.end + QUOTE_CONTEXT_LENGTH)
      : "",
    text,
  };
}

/**
 * Finds the quoted passage in the current document. Context-matching
 * occurrences win; ties go to the one nearest the offset recorded in the link.
 */
export function resolveMarkdownLinkQuote(
  markdown: string,
  quote: MarkdownLinkQuote,
  hintOffset = 0,
): MarkdownSourceRange | null {
  if (!quote.text) {
    return null;
  }

  const matches: number[] = [];

  for (let pos = markdown.indexOf(quote.text); pos >= 0; pos = markdown.indexOf(quote.text, pos + 1)) {
    matches.push(pos);
  }

  const contextual = matches.filter((pos) => {
    const prefixMatches = markdown.slice(Math.max(0, pos - quote.prefix.length), pos) === quote.prefix;
    const end = pos + quote.length;
    const suffixMatches = !quote.suffix || markdown.slice(end, end + quote.suffix.length) === quote.suffix;

    return prefixMatches && suffixMatches;
  });
  const candidates = contextual.length ? contextual : matches;

  if (!candidates.length) {
    return null;
  }

  const start = candidates.reduce((best, pos) =>
    Math.abs(pos - hintOffset) < Math.abs(best - hintOffset) ? pos : best,
  );

  return { start, end: Math.min(markdown.length, start + quote.length) };
}

/** Approximates the rendered text of a Markdown passage, whitespace collapsed. */
export function plainTextOfMarkdown(text: string) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/[*_~`=\\]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A short single-line label for a link made from a selection. */
export function markdownLinkQuoteLabel(text: string) {
  const plain = plainTextOfMarkdown(text);

  return plain.length > MAX_LABEL_LENGTH ? `${plain.slice(0, MAX_LABEL_LENGTH - 1).trimEnd()}…` : plain;
}
