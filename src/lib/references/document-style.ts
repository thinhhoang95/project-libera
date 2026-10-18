import { citationFrontMatterEnd } from "./citation-syntax";
import { BUNDLED_CSL_STYLES, DEFAULT_CSL_STYLE } from "./types";

// A per-document citation style (docs/references/plan.md §1.3 "Styles"): a
// line in the document's YAML front matter,
//
//   ---
//   citation-style: ieee
//   ---
//
// naming a bundled style id or a notebook-relative `.csl` file
// (`citation-style: styles/journal.csl`). It overrides the notebook's style
// for that document wherever its citations are formatted: the preview, PDF
// export, slides, the formatted bibliography export and the LaTeX export.
//
// This is a small reader and writer for that one top-level key, not a YAML
// parser: the value is a plain scalar, optionally quoted, optionally followed
// by a ` # comment`. The writer changes only that line (or adds the front
// matter), so everything else in the document keeps its bytes.

export const DOCUMENT_STYLE_FIELD = "citation-style";

const FIELD_LINE = new RegExp(`^${DOCUMENT_STYLE_FIELD}[ \\t]*:(.*)$`);

/** Whether `value` names a bundled style or a `.csl` file. */
export function isDocumentStyleSetting(value: string | null | undefined): value is string {
  if (!value) return false;
  return BUNDLED_CSL_STYLES.some((style) => style.id === value) || /\.csl$/i.test(value);
}

type FrontMatterLine = { start: number; end: number; text: string };

/** The lines between the front matter's fences (ends exclude line breaks), or null without front matter. */
function frontMatterLines(markdown: string) {
  const end = citationFrontMatterEnd(markdown);
  if (!end) return null;
  const lines: FrontMatterLine[] = [];
  const pattern = /([^\r\n]*)(\r\n|\r|\n|$)/y;
  pattern.lastIndex = /^---[ \t]*(?:\r\n|\r|\n)/.exec(markdown)![0].length;
  for (;;) {
    const start = pattern.lastIndex;
    const match = pattern.exec(markdown);
    if (!match || start >= end) break;
    lines.push({ start, end: start + match[1].length, text: match[1] });
    if (!match[2]) break;
  }
  // The last line read is the closing fence.
  const closing = lines.pop()!;
  return { lines, closing, end };
}

/** A YAML plain or quoted scalar, without a trailing comment. */
function scalar(raw: string) {
  const value = raw.trim();
  const quoted = /^(["'])(.*)\1(?:[ \t]+#.*)?$/.exec(value);
  if (quoted) return quoted[1] === '"' ? quoted[2].replace(/\\(["\\])/g, "$1") : quoted[2].replace(/''/g, "'");
  return value.replace(/(?:^|[ \t]+)#.*$/, "").trim();
}

/** The document's `citation-style` value as written (trimmed, unquoted), or null when there is none. */
export function readDocumentStyle(markdown: string | null | undefined): string | null {
  if (!markdown?.startsWith("---")) return null;
  const front = frontMatterLines(markdown);
  if (!front) return null;
  for (const line of front.lines) {
    const match = FIELD_LINE.exec(line.text);
    if (match) return scalar(match[1]) || null;
  }
  return null;
}

/** The style setting a document is formatted with: its own valid `citation-style`, else the notebook's. */
export function effectiveStyleSetting(markdown: string | null | undefined, notebookSetting: string | null | undefined) {
  const own = readDocumentStyle(markdown);
  return isDocumentStyleSetting(own) ? own : (notebookSetting || DEFAULT_CSL_STYLE);
}

/** The document's own valid style setting, or null (use the notebook's). */
export function documentStyleOverride(markdown: string | null | undefined) {
  const own = readDocumentStyle(markdown);
  return isDocumentStyleSetting(own) ? own : null;
}

function yamlValue(style: string) {
  return /^[\w./-]+$/.test(style) && !/^[-.]/.test(style) ? style : JSON.stringify(style);
}

function lineBreakOf(markdown: string) {
  return /\r\n/.exec(markdown)?.[0] ?? (/\r(?!\n)/.test(markdown) ? "\r" : "\n");
}

/**
 * Set (or with null, remove) the document's `citation-style`. Only that
 * line changes: an existing one is replaced, a new one goes last in the
 * front matter, and a document without front matter gets one. Removing the
 * only key removes front matter this would leave empty.
 */
export function writeDocumentStyle(markdown: string, style: string | null): string {
  const value = style?.trim() || null;
  const front = markdown.startsWith("---") ? frontMatterLines(markdown) : null;
  const newline = lineBreakOf(markdown);
  if (!front) {
    if (!value) return markdown;
    const rest = markdown.replace(/^(?:\r\n|\r|\n)+/, "");
    return `---${newline}${DOCUMENT_STYLE_FIELD}: ${yamlValue(value)}${newline}---${newline}${rest ? newline : ""}${rest}`;
  }
  const existing = front.lines.find((line) => FIELD_LINE.test(line.text));
  if (existing) {
    if (value) return `${markdown.slice(0, existing.start)}${DOCUMENT_STYLE_FIELD}: ${yamlValue(value)}${markdown.slice(existing.end)}`;
    const others = front.lines.filter((line) => line !== existing && line.text.trim());
    if (!others.length) {
      // The front matter held only the style: remove it, and the blank line after it.
      return markdown.slice(front.end).replace(/^(?:\r\n|\r|\n)(?:[ \t]*(?:\r\n|\r|\n))?/, "");
    }
    const lineEnd = /^(?:\r\n|\r|\n)/.exec(markdown.slice(existing.end))?.[0].length ?? 0;
    return markdown.slice(0, existing.start) + markdown.slice(existing.end + lineEnd);
  }
  if (!value) return markdown;
  return `${markdown.slice(0, front.closing.start)}${DOCUMENT_STYLE_FIELD}: ${yamlValue(value)}${newline}${markdown.slice(front.closing.start)}`;
}
