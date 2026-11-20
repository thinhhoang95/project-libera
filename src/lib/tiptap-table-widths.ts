import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { AddMarkStep, AttrStep, DocAttrStep, RemoveMarkStep, ReplaceAroundStep, ReplaceStep } from "@tiptap/pm/transform";
import { TIPTAP_BRIDGE_META } from "./collab/bindings/tiptap-ytext";
import { FRONT_MATTER_NODE_NAME } from "./tiptap-front-matter";
import { cellColumnWidths, normalizeTableWidths, readTableWidths, sameTableWidths, writeTableWidths, type TableWidths } from "./table-widths";

// Keeps the Visual editor's table column widths and the document's
// `table-widths` front matter line (table-widths.ts) in step.
//
// Dragging a column border (prosemirror-tables' columnResizing) sets the
// cells' `colwidth`; this plugin then writes every table's widths to the
// front matter in the same undo step, so the widths reach the Markdown file.
// Inserting, deleting or moving a table rewrites the line the same way, so
// each entry stays with its table.
//
// The other way round, a change that brings a new front matter (an undo, a
// collaborator's edit, the document reloaded from the Source editor) is
// applied to the tables. Those changes, and a collaborator's table that the
// bridge parsed on its own, are never answered by writing the front matter:
// only the user's own edits write it, so two editors never race to.

export const tiptapTableWidthsKey = new PluginKey("liberaTableWidths");

const TABLE_STRUCTURE = new Set(["table", "tableRow", "tableCell", "tableHeader", FRONT_MATTER_NODE_NAME]);

type TablePosition = { node: ProseMirrorNode; pos: number };

/** The document's tables, in order (tables do not nest). */
export function documentTables(doc: ProseMirrorNode) {
  const tables: TablePosition[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "table") { tables.push({ node, pos }); return false; }
    return !node.isTextblock && !node.isAtom;
  });
  return tables;
}

/** A table's column widths, from its first row (which covers every column). */
export function tableColumnWidths(table: ProseMirrorNode): Array<number | null> {
  const widths: Array<number | null> = [];
  table.firstChild?.forEach((cell) => {
    const span = Math.max(1, Number(cell.attrs.colspan) || 1);
    const own = Array.isArray(cell.attrs.colwidth) ? cell.attrs.colwidth as unknown[] : [];
    for (let index = 0; index < span; index++) widths.push(typeof own[index] === "number" && (own[index] as number) > 0 ? own[index] as number : null);
  });
  return widths;
}

const columnCount = (table: ProseMirrorNode) => tableColumnWidths(table).length;

function frontMatter(doc: ProseMirrorNode) {
  const first = doc.firstChild;
  return first?.type.name === FRONT_MATTER_NODE_NAME ? first : null;
}

/** The widths the document's front matter names ([] without any). */
export function frontMatterTableWidths(doc: ProseMirrorNode): TableWidths {
  const node = frontMatter(doc);
  return node ? readTableWidths(String(node.attrs.raw ?? "")) : [];
}

const sameColwidth = (a: unknown, b: number[] | null) =>
  JSON.stringify(Array.isArray(a) && a.some((width) => width > 0) ? a : null) === JSON.stringify(b);

/** Give one table's cells the column widths (positions stay valid: only attributes change). */
function setTableWidths(tr: Transaction, { node, pos }: TablePosition, widths: ReadonlyArray<number | null>) {
  const shape: Array<Array<readonly [number, number]>> = [];
  node.forEach((row) => {
    const cells: Array<readonly [number, number]> = [];
    row.forEach((cell) => { cells.push([Number(cell.attrs.colspan) || 1, Number(cell.attrs.rowspan) || 1]); });
    shape.push(cells);
  });
  const colwidths = cellColumnWidths(shape, widths);
  node.forEach((row, rowOffset, rowIndex) => {
    row.forEach((cell, cellOffset, cellIndex) => {
      const colwidth = colwidths[rowIndex][cellIndex];
      if (!sameColwidth(cell.attrs.colwidth, colwidth)) tr.setNodeAttribute(pos + 1 + rowOffset + 1 + cellOffset, "colwidth", colwidth);
    });
  });
}

/** Give every table the widths of its entry (none for a table without one). */
function applyWidths(tr: Transaction, tables: TablePosition[], widths: TableWidths) {
  tables.forEach((table, index) => {
    const own = widths[index] ?? [];
    if (!sameTableWidths(normalizeTableWidths([tableColumnWidths(table.node)]), normalizeTableWidths([own]))) setTableWidths(tr, table, own);
  });
}

/** Set the front matter's `table-widths` line, adding or removing the front matter as needed. */
function writeFrontMatter(tr: Transaction, widths: TableWidths) {
  const node = frontMatter(tr.doc);
  const type = tr.doc.type.schema.nodes[FRONT_MATTER_NODE_NAME];
  if (!type) return;
  const raw = node ? String(node.attrs.raw ?? "") : "";
  // The line as the user wrote it stays while it says the same.
  if (sameTableWidths(readTableWidths(raw), widths)) return;
  const next = writeTableWidths(raw, widths).replace(/(?:\r\n|\r|\n)+$/, "");
  if (next === raw) return;
  if (!node) tr.insert(0, type.create({ raw: next }));
  else if (!next) tr.delete(0, node.nodeSize);
  else tr.setNodeMarkup(0, undefined, { ...node.attrs, raw: next });
}

/** Whether a table's structure or a cell's or the front matter's attributes lie in [from, to] (not just text inside a cell). */
function structureBetween(doc: ProseMirrorNode, from: number, to: number) {
  let found = false;
  doc.nodesBetween(Math.max(0, from), Math.min(doc.content.size, to), (node, pos) => {
    if (found) return false;
    if (TABLE_STRUCTURE.has(node.type.name) && (pos >= from || pos + node.nodeSize <= to)) found = true;
    return !found && !node.isTextblock;
  });
  return found;
}

/** Whether an edit may change the tables, their widths or the front matter. Typing in a cell does not. */
export function transactionsMayAffectTableWidths(transactions: readonly Transaction[]) {
  for (const tr of transactions) {
    for (let index = 0; index < tr.steps.length; index++) {
      const step = tr.steps[index];
      const before = tr.docs[index];
      const after = index + 1 < tr.docs.length ? tr.docs[index + 1] : tr.doc;
      if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
        let touched = false;
        step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
          touched ||= structureBetween(before, oldStart, oldEnd) || structureBetween(after, newStart, newEnd);
        });
        if (touched) return true;
      } else if (step instanceof AttrStep) {
        if (TABLE_STRUCTURE.has(before.nodeAt(step.pos)?.type.name ?? "")) return true;
      } else if (!(step instanceof AddMarkStep || step instanceof RemoveMarkStep || step instanceof DocAttrStep)) return true;
    }
  }
  return false;
}

/** Changes the user did not make here: a collaborator's (the bridge), undo/redo, a reload, or this plugin's own. */
const isExternal = (tr: Transaction) => !!tr.getMeta(TIPTAP_BRIDGE_META) || !!tr.getMeta("history$")
  || tr.getMeta("preventUpdate") === true || !!tr.getMeta(tiptapTableWidthsKey);

/** The transaction that brings the tables and the front matter back in step, or null when they are. */
export function syncTableWidths(transactions: readonly Transaction[], oldState: EditorState, newState: EditorState): Transaction | null {
  const stated = frontMatterTableWidths(newState.doc);
  const tables = documentTables(newState.doc);
  const tr = newState.tr.setMeta(tiptapTableWidthsKey, true);
  if (transactions.some(isExternal) || !sameTableWidths(frontMatterTableWidths(oldState.doc), stated)) {
    // A new front matter: it decides.
    applyWidths(tr, tables, stated);
    return tr.docChanged ? tr.setMeta("addToHistory", false) : null;
  }
  // The user's edit: the tables decide. A table parsed afresh (an AI rewrite,
  // a pasted replacement) has no widths; while the number of tables holds,
  // it keeps those of its entry.
  const sameCount = documentTables(oldState.doc).length === tables.length;
  const widths = normalizeTableWidths(tables.map((table, index) => {
    const own = tableColumnWidths(table.node);
    const entry = stated[index];
    return sameCount && entry?.length && own.every((width) => width === null) && entry.length <= columnCount(table.node) ? entry : own;
  }));
  applyWidths(tr, tables, widths);
  writeFrontMatter(tr, widths);
  return tr.docChanged ? tr : null;
}

/**
 * The Visual editor's link between column resizing and the front matter
 * (see the header). Add it with Table's `resizable` option; Markdown files
 * that cannot have front matter (slide decks) should not.
 */
export const TiptapTableWidths = Extension.create({
  name: "liberaTableWidths",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: tiptapTableWidthsKey,
      appendTransaction(transactions, oldState, newState) {
        if (!transactions.some((tr) => tr.docChanged) || !transactionsMayAffectTableWidths(transactions)) return null;
        return syncTableWidths(transactions, oldState, newState);
      },
    })];
  },
});
