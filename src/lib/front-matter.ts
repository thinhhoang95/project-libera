import { citationFrontMatterEnd } from "./references/citation-syntax";

// Single-line fields of a document's YAML front matter (`---` … `---` at the
// very start), such as `citation-style:` (references/document-style.ts) and
// `table-widths:` (table-widths.ts). This is a small reader and writer for
// one top-level `key: value` line at a time, not a YAML parser: the writer
// changes only that line (or adds the front matter), so everything else in
// the document keeps its bytes.

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

const fieldLine = (field: string) => new RegExp(`^${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*:(.*)$`);

export function lineBreakOf(markdown: string) {
  return /\r\n/.exec(markdown)?.[0] ?? (/\r(?!\n)/.test(markdown) ? "\r" : "\n");
}

/** The text after `field:` on its front matter line, untrimmed; null when the document has no such line. */
export function readFrontMatterField(markdown: string | null | undefined, field: string): string | null {
  if (!markdown?.startsWith("---")) return null;
  const front = frontMatterLines(markdown);
  if (!front) return null;
  const pattern = fieldLine(field);
  for (const line of front.lines) {
    const match = pattern.exec(line.text);
    if (match) return match[1];
  }
  return null;
}

/**
 * Set `field` to `value` (YAML text, written as given), or with null remove
 * it. Only that line changes: an existing one is replaced, a new one goes
 * last in the front matter, and a document without front matter gets one.
 * Removing the only key removes front matter this would leave empty.
 */
export function writeFrontMatterField(markdown: string, field: string, value: string | null): string {
  const front = markdown.startsWith("---") ? frontMatterLines(markdown) : null;
  const newline = lineBreakOf(markdown);
  if (!front) {
    if (value === null) return markdown;
    const rest = markdown.replace(/^(?:\r\n|\r|\n)+/, "");
    return `---${newline}${field}: ${value}${newline}---${newline}${rest ? newline : ""}${rest}`;
  }
  const pattern = fieldLine(field);
  const existing = front.lines.find((line) => pattern.test(line.text));
  if (existing) {
    if (value !== null) return `${markdown.slice(0, existing.start)}${field}: ${value}${markdown.slice(existing.end)}`;
    const others = front.lines.filter((line) => line !== existing && line.text.trim());
    if (!others.length) {
      // The front matter held only this field: remove it, and the blank line after it.
      return markdown.slice(front.end).replace(/^(?:\r\n|\r|\n)(?:[ \t]*(?:\r\n|\r|\n))?/, "");
    }
    const lineEnd = /^(?:\r\n|\r|\n)/.exec(markdown.slice(existing.end))?.[0].length ?? 0;
    return markdown.slice(0, existing.start) + markdown.slice(existing.end + lineEnd);
  }
  if (value === null) return markdown;
  return `${markdown.slice(0, front.closing.start)}${field}: ${value}${newline}${markdown.slice(front.closing.start)}`;
}
