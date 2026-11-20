import type { JSONContent } from "@tiptap/core";
import type { Root, RootContent } from "mdast";
import type { Plugin } from "unified";
import { findMacroBlocks } from "./markdown-macros";

// Custom table column widths, kept in the document's macro block
// (docs/features/markdown-macros.md) as a magic comment, the way TeX keeps
// `% !TEX program = xelatex`:
//
//   ```libera-macro
//   \R = $\mathbb{R}$
//   % !table-widths = [[120, 240, null], [], [80]]
//   ```
//
// One entry per table in document order (pipe tables and the HTML tables
// written for merged cells alike), one width per column in CSS pixels; null
// (or 0) leaves a column to the layout and [] a whole table. The macro parser
// reads `%` lines as comments, so the line is neither a definition nor a
// problem, and the block is hidden wherever macros are expanded. Markdown
// tables have no attributes, so the widths live beside them: the Visual
// editor writes this line as columns are dragged (tiptap-table-widths.ts)
// and reads it back when the document is parsed; the preview gives each
// table its widths (remarkTableWidths). The first macro block with the line
// holds it.

/** Per table, per column: a width in pixels, or null for an automatic column. */
export type TableWidths = Array<Array<number | null>>;

/** The smallest and largest width a column keeps (TipTap's cellMinWidth is 25). */
const MIN_WIDTH = 25;
const MAX_WIDTH = 4000;

/** The magic comment, with its value in group 1. */
const WIDTHS_LINE = /^[ \t]*%[ \t]*!table-widths\b[ \t]*[=:]?[ \t]*(.*)$/m;
/** Cheap test for a document that may hold the line. */
const WIDTHS_MARK = "!table-widths";

function columnWidth(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

/** Widths with trailing automatic columns and tables dropped; [] when nothing is set. */
export function normalizeTableWidths(widths: ReadonlyArray<ReadonlyArray<unknown> | null | undefined>): TableWidths {
  const tables = widths.map((table) => {
    const columns = Array.isArray(table) ? table.map(columnWidth) : [];
    while (columns.length && columns.at(-1) === null) columns.pop();
    return columns;
  });
  while (tables.length && !tables.at(-1)!.length) tables.pop();
  return tables;
}

/** Parse a `table-widths` value; [] when it is missing or unreadable. */
export function parseTableWidths(value: string | null | undefined): TableWidths {
  const text = value?.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? normalizeTableWidths(parsed.map((table) => Array.isArray(table) ? table : null)) : [];
  } catch {
    return [];
  }
}

/** The value as written: `[[120, 240, null], [], [80]]`. */
export function formatTableWidths(widths: TableWidths) {
  return `[${widths.map((table) => `[${table.map((width) => width === null ? "null" : String(width)).join(", ")}]`).join(", ")}]`;
}

export const sameTableWidths = (a: TableWidths, b: TableWidths) => formatTableWidths(a) === formatTableWidths(b);

/** The line a macro block holds the widths in. */
export const tableWidthsLine = (widths: TableWidths) => `% !table-widths = ${formatTableWidths(normalizeTableWidths(widths))}`;

/** Whether one macro block's text holds the widths line. */
export const hasTableWidthsLine = (text: string) => text.includes(WIDTHS_MARK) && WIDTHS_LINE.test(text);

/** Widths from one macro block's text; null when it has no `% !table-widths` line. */
export function readMacroBlockTableWidths(text: string): TableWidths | null {
  const match = text.includes(WIDTHS_MARK) ? WIDTHS_LINE.exec(text) : null;
  return match ? parseTableWidths(match[1]) : null;
}

/**
 * One macro block's text with its widths line set: replaced where it is,
 * added last, or (with no widths) removed with its line break. Everything
 * else in the block keeps its bytes.
 */
export function writeMacroBlockTableWidths(text: string, widths: TableWidths): string {
  const normalized = normalizeTableWidths(widths);
  const match = text.includes(WIDTHS_MARK) ? WIDTHS_LINE.exec(text) : null;
  if (match) {
    const start = match.index, end = start + match[0].length;
    if (normalized.length) return text.slice(0, start) + tableWidthsLine(normalized) + text.slice(end);
    const after = /^\r?\n/.exec(text.slice(end))?.[0].length ?? 0;
    const before = after ? 0 : /\r?\n$/.exec(text.slice(0, start))?.[0].length ?? 0;
    return text.slice(0, start - before) + text.slice(end + after);
  }
  if (!normalized.length) return text;
  const newline = /\r\n/.test(text) ? "\r\n" : "\n";
  if (!text) return tableWidthsLine(normalized);
  return /\n$/.test(text) ? `${text}${tableWidthsLine(normalized)}${newline}` : `${text}${newline}${tableWidthsLine(normalized)}`;
}

/** The document's table widths, from the first macro block that has the line ([] without one). */
export function readTableWidths(markdown: string | null | undefined): TableWidths {
  if (!markdown?.includes(WIDTHS_MARK)) return [];
  for (const block of findMacroBlocks(markdown)) {
    const widths = readMacroBlockTableWidths(markdown.slice(block.contentStart, block.contentEnd));
    if (widths) return widths;
  }
  return [];
}

/**
 * The `colwidth` each cell takes from its table's widths. `cells` are the
 * table's rows of [colspan, rowspan]; the result has the same shape: one
 * width per column a cell spans (0 for an automatic one, ProseMirror's
 * convention), or null when none of its columns has a width.
 */
export function cellColumnWidths(rows: ReadonlyArray<ReadonlyArray<readonly [number, number]>>, widths: ReadonlyArray<number | null>) {
  // Rows still to come in which a column is taken by a cell from above (rowspan).
  const covered: number[] = [];
  return rows.map((row) => {
    const taken = covered.map((rest) => rest > 0);
    for (let column = 0; column < covered.length; column++) if (covered[column] > 0) covered[column]--;
    let column = 0;
    return row.map(([colspan, rowspan]) => {
      while (taken[column]) column++;
      const span = Math.max(1, colspan || 1);
      const own = Array.from({ length: span }, (_, index) => widths[column + index] ?? 0);
      if (rowspan > 1) for (let index = 0; index < span; index++) covered[column + index] = rowspan - 1;
      column += span;
      return own.some((width) => width > 0) ? own : null;
    });
  });
}

const isCell = (node: JSONContent) => node.type === "tableCell" || node.type === "tableHeader";

/** A table's column widths, read from its first row (which covers every column). */
export function jsonTableWidths(table: JSONContent): Array<number | null> {
  const widths: Array<number | null> = [];
  for (const cell of table.content?.[0]?.content ?? []) {
    if (!isCell(cell)) continue;
    const span = Math.max(1, Number(cell.attrs?.colspan) || 1);
    const own = Array.isArray(cell.attrs?.colwidth) ? cell.attrs.colwidth as unknown[] : [];
    for (let index = 0; index < span; index++) widths.push(columnWidth(own[index]));
  }
  return widths;
}

function withTableWidths(table: JSONContent, widths: ReadonlyArray<number | null>): JSONContent {
  const rows = table.content ?? [];
  const shape = rows.map((row) => (row.content ?? []).filter(isCell).map((cell) =>
    [Number(cell.attrs?.colspan) || 1, Number(cell.attrs?.rowspan) || 1] as const));
  const colwidths = cellColumnWidths(shape, widths);
  return {
    ...table,
    content: rows.map((row, rowIndex) => {
      let cellIndex = 0;
      return { ...row, content: row.content?.map((cell) => isCell(cell) ? { ...cell, attrs: { ...cell.attrs, colwidth: colwidths[rowIndex][cellIndex++] } } : cell) };
    }),
  };
}

/**
 * Give the tables of a parsed TipTap document (JSON) the widths its macro
 * block names. Tables are counted in document order, as the editor counts
 * them when it writes the line.
 */
export function applyTableWidthsToJson(doc: JSONContent, widths: TableWidths): JSONContent {
  if (!widths.length) return doc;
  let index = 0;
  const visit = (node: JSONContent): JSONContent => {
    if (node.type === "table") {
      const own = widths[index++];
      return own?.length ? withTableWidths(node, own) : node;
    }
    return node.content ? { ...node, content: node.content.map(visit) } : node;
  };
  return visit(doc);
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** The attribute a preview table carries its widths in: `120,240,0` (0 is automatic). */
export const TABLE_WIDTHS_ATTRIBUTE = "data-col-widths";

/** Widths from a table's `data-col-widths` attribute; null when it has none. */
export function tableWidthsAttribute(value: unknown): Array<number | null> | null {
  if (typeof value !== "string" || !value) return null;
  const widths = value.split(",").map((part) => columnWidth(Number(part)));
  return widths.some((width) => width !== null) ? widths : null;
}

type MdNode = Root | RootContent;

/** Whether an HTML block is a table, as the Visual editor writes a table with merged cells. */
const isHtmlTable = (node: MdNode) => node.type === "html" && /^\s*<table[\s>]/i.test(node.value);

function markTables(tree: Root, source: string | null) {
  const widths = readTableWidths(source);
  if (!widths.length) return;
  let index = 0;
  const visit = (node: MdNode) => {
    if (isHtmlTable(node)) { index++; return; }
    if (node.type === "table") {
      const own = widths[index++];
      if (own?.length) {
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, dataColWidths: own.map((width) => width ?? 0).join(",") } };
      }
      return;
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(tree);
}

/**
 * Give each table of the preview the widths the macro block names for it,
 * as a `data-col-widths` attribute the renderer turns into column widths.
 * Use after remark-parse and remarkMarkdownMacros, so the source is at hand
 * as written (macro blocks included); otherwise it is read from the file.
 */
export const remarkTableWidths: Plugin<[], Root> = function () {
  const parse = this.parser;
  if (parse) {
    this.parser = (document, file) => {
      const tree = parse(document, file) as Root;
      markTables(tree, String(document));
      return tree;
    };
    return;
  }
  return (tree, file) => markTables(tree, typeof file.value === "string" ? file.value : null);
};
