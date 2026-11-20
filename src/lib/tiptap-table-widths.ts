import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { AddMarkStep, AttrStep, DocAttrStep, RemoveMarkStep, ReplaceAroundStep, ReplaceStep } from "@tiptap/pm/transform";
import { TIPTAP_BRIDGE_META } from "./collab/bindings/tiptap-ytext";
import { MACRO_BLOCK_LANGUAGE, isMacroBlockLanguage } from "./markdown-macros";
import { textChange } from "./references/document-style";
import { FRONT_MATTER_NODE_NAME } from "./tiptap-front-matter";
import {
  cellColumnWidths, hasTableWidthsLine, normalizeTableWidths, readMacroBlockTableWidths, sameTableWidths, tableWidthsLine,
  writeMacroBlockTableWidths, type TableWidths,
} from "./table-widths";

// Keeps the Visual editor's table column widths and the document's
// `% !table-widths` line in its ```libera-macro block (table-widths.ts) in
// step.
//
// Dragging a column border (prosemirror-tables' columnResizing) sets the
// cells' `colwidth`; this plugin then writes every table's widths to the
// macro block in the same undo step, so the widths reach the Markdown file.
// A document without a macro block gets one at the top. Inserting, deleting
// or moving a table rewrites the line the same way, so each entry stays with
// its table.
//
// The other way round, a change that brings a new line (an undo, the line
// edited in the macro block, a collaborator's edit, the document reloaded
// from the Source editor) is applied to the tables. Those changes, and a
// collaborator's table that the bridge parsed on its own, are never answered
// by writing the line: only the user's own edits elsewhere write it, so two
// editors never race to.

export const tiptapTableWidthsKey = new PluginKey("liberaTableWidths");

const TABLE_STRUCTURE = new Set(["table", "tableRow", "tableCell", "tableHeader"]);

type Positioned = { node: ProseMirrorNode; pos: number };

const isMacroBlock = (node: ProseMirrorNode) => !!node.type.spec.code && isMacroBlockLanguage(node.attrs.language);

/** The document's tables and macro blocks, in order (tables do not nest). */
function documentParts(doc: ProseMirrorNode) {
  const tables: Positioned[] = [];
  const macroBlocks: Positioned[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "table") { tables.push({ node, pos }); return false; }
    if (isMacroBlock(node)) { macroBlocks.push({ node, pos }); return false; }
    return !node.isTextblock && !node.isAtom;
  });
  return { tables, macroBlocks };
}

export const documentTables = (doc: ProseMirrorNode) => documentParts(doc).tables;

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

/** The widths the document's macro blocks name: the first block with the line ([] without one). */
function statedWidths(macroBlocks: Positioned[]): TableWidths {
  for (const { node } of macroBlocks) {
    const widths = readMacroBlockTableWidths(node.textContent);
    if (widths) return widths;
  }
  return [];
}

export const macroBlockTableWidths = (doc: ProseMirrorNode) => statedWidths(documentParts(doc).macroBlocks);

const sameColwidth = (a: unknown, b: number[] | null) =>
  JSON.stringify(Array.isArray(a) && a.some((width) => width > 0) ? a : null) === JSON.stringify(b);

/** Give one table's cells the column widths (positions stay valid: only attributes change). */
function setTableWidths(tr: Transaction, { node, pos }: Positioned, widths: ReadonlyArray<number | null>) {
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
function applyWidths(tr: Transaction, tables: Positioned[], widths: TableWidths) {
  tables.forEach((table, index) => {
    const own = widths[index] ?? [];
    if (!sameTableWidths(normalizeTableWidths([tableColumnWidths(table.node)]), normalizeTableWidths([own]))) setTableWidths(tr, table, own);
  });
}

/**
 * Set the `% !table-widths` line: in the macro block that has it, else the
 * first macro block, else a new block at the top (after any front matter).
 * A block left empty by removing the line goes too.
 */
function writeWidths(tr: Transaction, widths: TableWidths) {
  const { doc } = tr;
  const { schema } = doc.type;
  const { macroBlocks } = documentParts(doc);
  const holder = macroBlocks.find(({ node }) => hasTableWidthsLine(node.textContent)) ?? macroBlocks[0];
  if (holder) {
    const text = holder.node.textContent;
    // The line as the user wrote it stays while it says the same.
    if (sameTableWidths(readMacroBlockTableWidths(text) ?? [], widths)) return;
    const next = writeMacroBlockTableWidths(text, widths);
    if (!next.trim()) { tr.delete(holder.pos, holder.pos + holder.node.nodeSize); return; }
    const change = textChange(text, next);
    const start = holder.pos + 1;
    if (change.insert) tr.insertText(change.insert, start + change.from, start + change.to);
    else tr.delete(start + change.from, start + change.to);
    return;
  }
  const codeBlock = schema.nodes.codeBlock;
  if (!widths.length || !codeBlock) return;
  const at = doc.firstChild?.type.name === FRONT_MATTER_NODE_NAME ? doc.firstChild.nodeSize : 0;
  tr.insert(at, codeBlock.create({ language: MACRO_BLOCK_LANGUAGE }, schema.text(tableWidthsLine(widths))));
}

/** Whether table structure lies in [from, to] (not just text inside a cell), or the range touches a macro block. */
function structureBetween(doc: ProseMirrorNode, from: number, to: number) {
  let found = false;
  doc.nodesBetween(Math.max(0, from), Math.min(doc.content.size, to), (node, pos) => {
    if (found) return false;
    if (isMacroBlock(node) || (TABLE_STRUCTURE.has(node.type.name) && (pos >= from || pos + node.nodeSize <= to))) found = true;
    return !found && !node.isTextblock;
  });
  return found;
}

/** Whether an edit may change the tables, their widths or the widths line. Typing in a cell does not. */
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
        const node = before.nodeAt(step.pos);
        if (node && (TABLE_STRUCTURE.has(node.type.name) || isMacroBlock(node) || node.type.spec.code)) return true;
      } else if (!(step instanceof AddMarkStep || step instanceof RemoveMarkStep || step instanceof DocAttrStep)) return true;
    }
  }
  return false;
}

/** Changes the user did not make here: a collaborator's (the bridge), undo/redo, a reload, or this plugin's own. */
const isExternal = (tr: Transaction) => !!tr.getMeta(TIPTAP_BRIDGE_META) || !!tr.getMeta("history$")
  || tr.getMeta("preventUpdate") === true || !!tr.getMeta(tiptapTableWidthsKey);

/** The transaction that brings the tables and the widths line back in step, or null when they are. */
export function syncTableWidths(transactions: readonly Transaction[], oldState: EditorState, newState: EditorState): Transaction | null {
  const { tables, macroBlocks } = documentParts(newState.doc);
  const stated = statedWidths(macroBlocks);
  const tr = newState.tr.setMeta(tiptapTableWidthsKey, true);
  const old = documentParts(oldState.doc);
  if (transactions.some(isExternal) || !sameTableWidths(statedWidths(old.macroBlocks), stated)) {
    // A new line: it decides.
    applyWidths(tr, tables, stated);
    return tr.docChanged ? tr.setMeta("addToHistory", false) : null;
  }
  // The user's edit: the tables decide. A table parsed afresh (an AI rewrite,
  // a pasted replacement) has no widths; while the number of tables holds,
  // it keeps those of its entry.
  const sameCount = old.tables.length === tables.length;
  const widths = normalizeTableWidths(tables.map((table, index) => {
    const own = tableColumnWidths(table.node);
    const entry = stated[index];
    return sameCount && entry?.length && own.every((width) => width === null) && entry.length <= columnCount(table.node) ? entry : own;
  }));
  applyWidths(tr, tables, widths);
  writeWidths(tr, widths);
  return tr.docChanged ? tr : null;
}

/**
 * The Visual editor's link between column resizing and the macro block (see
 * the header). Add it with Table's `resizable` option.
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
