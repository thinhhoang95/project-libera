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

// ---------------------------------------------------------------------------
// Slide decks
// ---------------------------------------------------------------------------

// A deck (`*.slides.md`) cannot have YAML front matter: `---` separates its
// slides. Its first block holds `$key = JSON` metadata lines instead
// (markdown-slides.ts), so a deck's style is `$citation-style = "ieee"`.

const SLIDES_STYLE_LINE = new RegExp(String.raw`^\$${DOCUMENT_STYLE_FIELD}\s*=\s*(.+?)[ \t]*$`);
const SLIDES_PATH = /\.slides\.(?:md|markdown)$/i;

/** The deck's metadata lines: the blank and `$key = value` lines that start it. */
function slidesMetadataLines(source: string) {
  const lines: Array<{ start: number; end: number; next: number; text: string }> = [];
  const pattern = /([^\r\n]*)(\r\n|\r|\n|$)/y;
  for (let start = 0; start < source.length;) {
    pattern.lastIndex = start;
    const match = pattern.exec(source)!;
    const text = match[1];
    if (text.trim() && !text.trim().startsWith("$")) break;
    const next = start + match[0].length;
    lines.push({ start, end: start + text.length, next, text });
    if (!match[2]) break;
    start = next;
  }
  return lines;
}

/** A deck's `$citation-style` value, or null. */
export function readSlidesDocumentStyle(source: string): string | null {
  for (const line of slidesMetadataLines(source)) {
    const match = SLIDES_STYLE_LINE.exec(line.text.trim());
    if (!match) continue;
    try {
      const value = JSON.parse(match[1]) as unknown;
      return typeof value === "string" && value.trim() ? value.trim() : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Set (or with null, remove) a deck's `$citation-style` line. */
export function writeSlidesDocumentStyle(source: string, style: string | null): string {
  const value = style?.trim() || null;
  const line = slidesMetadataLines(source).find((candidate) => SLIDES_STYLE_LINE.test(candidate.text.trim()));
  const text = value ? `$${DOCUMENT_STYLE_FIELD} = ${JSON.stringify(value)}` : "";
  if (line) return value ? source.slice(0, line.start) + text + source.slice(line.end) : source.slice(0, line.start) + source.slice(line.next);
  return value ? `${text}${lineBreakOf(source)}${source}` : source;
}

/** The style a document names for itself, by its path (decks use their metadata line). */
export function readDocumentStyleForPath(path: string | null | undefined, text: string) {
  return path && SLIDES_PATH.test(path) ? readSlidesDocumentStyle(text) : readDocumentStyle(text);
}

/** Write a document's own style, by its path (see writeDocumentStyle and writeSlidesDocumentStyle). */
export function writeDocumentStyleForPath(path: string | null | undefined, text: string, style: string | null) {
  return path && SLIDES_PATH.test(path) ? writeSlidesDocumentStyle(text, style) : writeDocumentStyle(text, style);
}

/** The smallest change from `before` to `after`: replace `before.slice(from, to)` with `insert`. */
export function textChange(before: string, after: string) {
  let from = 0;
  const limit = Math.min(before.length, after.length);
  while (from < limit && before.charCodeAt(from) === after.charCodeAt(from)) from += 1;
  let tail = 0;
  while (tail < limit - from && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail += 1;
  return { from, to: before.length - tail, insert: after.slice(from, after.length - tail) };
}

// ---------------------------------------------------------------------------
// Changing an open document's style
// ---------------------------------------------------------------------------

/**
 * Asks the editor holding `path` to set (or with null, remove) its document's
 * style, in its draft, as one undoable edit. The editor that applies it sets
 * `handled`. Dispatched by the Document style control (document-style-picker.tsx);
 * the Markdown textarea, CodeMirror and Visual editors listen.
 */
export const DOCUMENT_STYLE_REQUEST_EVENT = "libera:references-document-style";

export type DocumentStyleRequestDetail = { path: string; style: string | null; handled?: boolean };

/** Ask the open editor of `path` to change its document's style; true when an editor applied it. */
export function requestDocumentStyleChange(path: string, style: string | null) {
  const detail: DocumentStyleRequestDetail = { path, style };
  window.dispatchEvent(new CustomEvent<DocumentStyleRequestDetail>(DOCUMENT_STYLE_REQUEST_EVENT, { detail }));
  return Boolean(detail.handled);
}
