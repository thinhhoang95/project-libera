import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Root } from "mdast";
import { markdownRemarkPlugins } from "@/lib/markdown-rendering";
import { normalizeMarkdownHighlightDelimiters } from "@/lib/markdown-highlights";
import type { MathMarkerSettings } from "@/lib/math-markers";
import { pasteMathMarkers, pasteMathPairs } from "./markers";

/* The pasted Markdown is read with the preview's own grammar
 * (markdownRemarkPlugins), so Libera's syntax (math markers, citations,
 * highlights, colors, boxes, macros) means the same here as in a note. Math
 * markers are the user's own plus the common conventions (markers.ts). */

export { pasteMathMarkers };

function processorFor(mathMarkers?: MathMarkerSettings) {
  return unified().use(remarkParse).use(markdownRemarkPlugins(pasteMathMarkers(mathMarkers)));
}

const processors = new Map<string, ReturnType<typeof processorFor>>();

export type ParsedMarkdown = {
  tree: Root;
  /** The text the tree's positions refer to (line endings normalised). */
  source: string;
  /** The user's math markers it was read with (captions typed in the dialog are read with them too). */
  mathMarkers?: MathMarkerSettings;
};

export function normalizePastedMarkdown(markdown: string) {
  return markdown.replace(/\r\n?/g, "\n").replace(/^﻿/, "");
}

export function parseMarkdown(markdown: string, mathMarkers?: MathMarkerSettings): ParsedMarkdown {
  const key = JSON.stringify(mathMarkers ? [mathMarkers.inlineMathMarkers, mathMarkers.blockMathMarkers] : null);
  let processor = processors.get(key);
  if (!processor) {
    processor = processorFor(mathMarkers);
    processors.set(key, processor);
    if (processors.size > 4) processors.delete(processors.keys().next().value!);
  }
  const source = normalizeMarkdownHighlightDelimiters(normalizePastedMarkdown(markdown));
  const protectedSource = protectTablePipes(source, pasteMathPairs(mathMarkers));
  const tree = processor.runSync(processor.parse(protectedSource)) as Root;
  if (protectedSource !== source) restorePipes(tree);
  return { tree, source, mathMarkers };
}

/* ---- Pipes inside formulas and code in table rows --------------------------------
 * GFM splits a table row at every unescaped `|`, even inside `$P(A|B)$` or
 * `` `a|b` ``, which AI answers write all the time. Those pipes are swapped
 * for a placeholder before parsing and put back in the tree afterwards; the
 * placeholder is one UTF-16 unit, like `|`, so source offsets stay right. */

const PIPE_PLACEHOLDER = "";
const DELIMITER_ROW = /^[ \t>]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** The row with its formulas' and code spans' unescaped pipes replaced. */
function protectRow(line: string, pairs: Array<{ open: string; close: string }>) {
  let out = "";
  let index = 0;
  const unescapedPipes = (text: string) => text.replace(/(^|[^\\])\|/g, (_, before: string) => before + PIPE_PLACEHOLDER).replace(/(^|[^\\])\|/g, (_, before: string) => before + PIPE_PLACEHOLDER);
  while (index < line.length) {
    const char = line[index];
    // Formulas first: `\(` opens one; any other backslash escapes the character after it.
    const pair = pairs.find((candidate) => line.startsWith(candidate.open, index));
    if (pair) {
      const close = line.indexOf(pair.close, index + pair.open.length);
      // `$5 | $10`: a `$` before a digit, or after a space when the formula began with one, is a price, as the parser reads it.
      const price = pair.open === "$" && pair.close === "$"
        && (/\d/.test(line[close + 1] ?? "") || (/^\d/.test(line.slice(index + 1)) && /\s/.test(line[close - 1] ?? "")));
      if (close > index + pair.open.length && !price) {
        out += pair.open + unescapedPipes(line.slice(index + pair.open.length, close)) + pair.close;
        index = close + pair.close.length;
        continue;
      }
    }
    if (char === "\\") { out += line.slice(index, index + 2); index += 2; continue; }
    if (char === "`") {
      const run = /^`+/.exec(line.slice(index))![0];
      const close = line.indexOf(run, index + run.length);
      if (close > 0 && line[close + run.length] !== "`") {
        out += run + unescapedPipes(line.slice(index + run.length, close)) + run;
        index = close + run.length;
        continue;
      }
      out += run;
      index += run.length;
      continue;
    }
    out += char;
    index++;
  }
  return out;
}

export function protectTablePipes(text: string, pairs: Array<{ open: string; close: string }>) {
  if (!text.includes("|") || text.includes(PIPE_PLACEHOLDER)) return text;
  const lines = text.split("\n");
  let changed = false;
  for (let index = 1; index < lines.length; index++) {
    if (!DELIMITER_ROW.test(lines[index]) || !lines[index].includes("-") || !lines[index - 1].includes("|")) continue;
    // The header row, then the body rows up to a blank line or a line without a pipe.
    const rows = [index - 1];
    for (let row = index + 1; row < lines.length && lines[row].trim() && lines[row].includes("|"); row++) rows.push(row);
    for (const row of rows) {
      const protectedRow = protectRow(lines[row], pairs);
      if (protectedRow !== lines[row]) { lines[row] = protectedRow; changed = true; }
    }
    index = rows[rows.length - 1];
  }
  return changed ? lines.join("\n") : text;
}

function restorePipes(node: { value?: unknown; children?: unknown[] }) {
  if (typeof node.value === "string" && node.value.includes(PIPE_PLACEHOLDER)) node.value = node.value.replaceAll(PIPE_PLACEHOLDER, "|");
  for (const child of node.children ?? []) restorePipes(child as { value?: unknown; children?: unknown[] });
}
