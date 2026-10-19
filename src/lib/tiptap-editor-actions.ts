import type { Editor, JSONContent } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { addColumn, addRow, CellSelection, TableMap, type TableRect } from "@tiptap/pm/tables";
import { tiptapChangesKey, type ChangeSource, type TiptapChangesMeta } from "./tiptap-changes";
import {
  getHeadingEnumerationNumbers,
  headingNumberPrefixLength,
  type MarkdownHeadingEnumerationScope,
} from "./markdown-heading-enumeration";
import { getStructuralHeadingNumbers, type HeadingNumberingOptions } from "./markdown-heading-numbering";
import { getSmartPasteLevelShift, shiftHeadingLevel, type SmartPasteMode } from "./markdown-smart-paste";

export type EditorRange = { from: number; to: number };

// ProseMirror nodes are immutable: unchanged subtrees retain their identity.
// Cache heading presence so toolbar subscriptions do not collect every heading
// (or walk every text node) on every selection/typing transaction.
const headingPresence = new WeakMap<Node, boolean>();
export function hasTiptapHeadings(node: Node): boolean {
  const cached = headingPresence.get(node);
  if (cached !== undefined) return cached;
  let found = node.type.name === "heading";
  for (let index = 0; !found && index < node.childCount; index += 1) {
    found = hasTiptapHeadings(node.child(index));
  }
  headingPresence.set(node, found);
  return found;
}

export function getTiptapHeadings(editor: Editor, range: EditorRange) {
  const headings: { node: Node; pos: number; selected: boolean }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      headings.push({ node, pos, selected: range.from < range.to && range.from < pos + node.nodeSize - 1 && range.to > pos + 1 });
    }
  });
  return headings;
}

export function enumerateTiptapHeadings(
  editor: Editor,
  scope: MarkdownHeadingEnumerationScope,
  range: EditorRange = editor.state.selection,
  startAt = 1,
) {
  const headings = getTiptapHeadings(editor, range);
  const numbers = getHeadingEnumerationNumbers(headings.map(({ node }) => node.attrs.level), {
    scope, startAt,
    selectedIndexes: headings.flatMap((heading, index) => heading.selected ? [index] : []),
  });
  const tr = closeHistory(editor.state.tr);
  applyTiptapHeadingNumbers(tr, headings, numbers);
  if (!tr.docChanged) return false;
  editor.view.dispatch(tr);
  return true;
}

function applyTiptapHeadingNumbers(tr: Transaction, headings: { node: Node; pos: number }[], numbers: Map<number, string>) {
  // Work backwards so earlier node positions remain valid. Replace only the
  // number prefix, preserving marks, links, equations and heading attributes.
  for (let index = headings.length - 1; index >= 0; index -= 1) {
    const number = numbers.get(index);
    if (!number) continue;
    const { node, pos } = headings[index];
    let leadingText = "";
    for (let childIndex = 0; childIndex < node.childCount; childIndex += 1) {
      const child = node.child(childIndex);
      if (!child.isText) break;
      leadingText += child.text;
    }
    const prefixLength = headingNumberPrefixLength(leadingText);
    const prefix = `${number}${node.content.size > prefixLength ? " " : ""}`;
    if (leadingText.slice(0, prefixLength) === prefix) continue;
    tr.replaceWith(pos + 1, pos + 1 + prefixLength, tr.doc.type.schema.text(prefix));
  }
}

function collectJsonHeadings(nodes: JSONContent[] | undefined, headings: JSONContent[] = []) {
  for (const node of nodes ?? []) {
    if (node.type === "heading") headings.push(node);
    collectJsonHeadings(node.content, headings);
  }
  return headings;
}

/** Leading plain text of a heading, where its number lives. */
function headingLeadingText(node: Node) {
  let text = "";
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (!child.isText) break;
    text += child.text;
  }
  return text;
}

/**
 * Give every heading in `tr.doc` its structural number (see
 * markdown-heading-numbering.ts), replacing only the number prefix so marks,
 * links and equations stay. `protectPos`: after a deletion, the heading whose
 * number holds the caret keeps what the user left, so Backspace can clear it.
 */
export function applyTiptapStructuralNumbers(tr: Transaction, options: HeadingNumberingOptions, protectPos?: number) {
  const headings: { node: Node; pos: number }[] = [];
  tr.doc.descendants((node, pos) => {
    if (node.type.name === "heading") headings.push({ node, pos });
  });
  const numbers = getStructuralHeadingNumbers(
    headings.map(({ node }) => ({ level: node.attrs.level as number, text: headingLeadingText(node) })),
    options,
  );
  for (let index = headings.length - 1; index >= 0; index -= 1) {
    const { node, pos } = headings[index];
    const leadingText = headingLeadingText(node);
    const prefixLength = headingNumberPrefixLength(leadingText);
    const number = numbers[index];
    const prefix = number === null ? "" : `${number} `;
    if (leadingText.slice(0, prefixLength) === prefix) continue;
    const numberRun = leadingText.match(/^[\d.]*\s*/)?.[0].length ?? 0;
    if (protectPos !== undefined && protectPos >= pos + 1 && protectPos <= pos + 1 + numberRun) continue;
    if (prefix) tr.replaceWith(pos + 1, pos + 1 + prefixLength, tr.doc.type.schema.text(prefix));
    else tr.delete(pos + 1, pos + 1 + prefixLength);
  }
  return tr;
}

/** Number every heading now, as one undo step. */
export function numberTiptapHeadings(editor: Editor, options: HeadingNumberingOptions) {
  const tr = applyTiptapStructuralNumbers(closeHistory(editor.state.tr), options);
  if (!tr.docChanged) return false;
  editor.view.dispatch(tr);
  return true;
}

/** Remove every heading number, as one undo step. */
export function removeTiptapHeadingNumbers(editor: Editor) {
  const tr = closeHistory(editor.state.tr);
  const headings: { node: Node; pos: number }[] = [];
  tr.doc.descendants((node, pos) => {
    if (node.type.name === "heading") headings.push({ node, pos });
  });
  for (let index = headings.length - 1; index >= 0; index -= 1) {
    const { node, pos } = headings[index];
    const prefixLength = headingNumberPrefixLength(headingLeadingText(node));
    if (prefixLength) tr.delete(pos + 1, pos + 1 + prefixLength);
  }
  if (!tr.docChanged) return false;
  editor.view.dispatch(tr);
  return true;
}

/**
 * Smart Paste: the pasted content's highest heading goes one level below the
 * closest heading before the insertion point ("child", a normal paste) or at
 * its level ("peer"), all in one undo step. Heading numbers follow from the
 * editor's structural numbering. Returns false when the Markdown has no
 * headings, so the normal paste runs.
 */
export function smartPasteTiptapMarkdown(editor: Editor, range: EditorRange, markdown: string, mode: SmartPasteMode = "child") {
  const parsed = editor.markdown?.parse(markdown);
  const pastedHeadings = collectJsonHeadings(parsed?.content);
  if (!parsed?.content || !pastedHeadings.length) return false;
  const previous = getTiptapHeadings(editor, range).filter(({ pos }) => pos < range.from).at(-1);
  const shift = getSmartPasteLevelShift(
    previous?.node.attrs.level as number | undefined,
    pastedHeadings.map((heading) => heading.attrs?.level ?? 1),
    mode,
  );
  for (const heading of pastedHeadings) {
    heading.attrs = { ...heading.attrs, level: shiftHeadingLevel(heading.attrs?.level ?? 1, shift) };
  }
  return editor.chain()
    .command(({ tr }) => { closeHistory(tr); return true; })
    .insertContentAt(range, parsed.content)
    .scrollIntoView()
    .run();
}

export function changeTiptapHeadingLevels(editor: Editor, range: EditorRange, direction: "indent" | "unindent") {
  const tr = closeHistory(editor.state.tr);
  const delta = direction === "indent" ? 1 : -1;
  for (const { node, pos, selected } of getTiptapHeadings(editor, range)) {
    const level = node.attrs.level + delta;
    if (!selected) continue;
    if (direction === "unindent" && level === 0) {
      tr.setNodeMarkup(pos, editor.schema.nodes.paragraph);
    } else if (level >= 1 && level <= 6) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, level });
    }
  }
  if (!tr.docChanged) return false;
  editor.view.dispatch(tr);
  return true;
}

export function getTiptapSelectionMarkdown(editor: Editor, range: EditorRange) {
  const content = editor.state.doc.slice(range.from, range.to).content.toJSON() as JSONContent[] | null;
  return editor.markdown?.serialize({ type: "doc", content: content ?? [] }) ?? "";
}

/** Keep an asynchronous AI result anchored to its selection without overwriting
 * typing elsewhere. Reject it if the selected content itself was changed. */
export function trackTiptapRange(editor: Editor, initial: EditorRange) {
  let range = { from: initial.from, to: initial.to };
  const original = editor.state.doc.slice(range.from, range.to);
  let valid = true;
  const onTransaction = ({ transaction }: { transaction: Transaction }) => {
    if (!transaction.docChanged || !valid) return;
    const from = transaction.mapping.mapResult(range.from, 1);
    const to = transaction.mapping.mapResult(range.to, -1);
    range = { from: from.pos, to: Math.max(from.pos, to.pos) };
    valid = !from.deletedAcross && !to.deletedAcross && transaction.doc.slice(range.from, range.to).eq(original);
  };
  editor.on("transaction", onTransaction);
  return {
    get range() { return range; },
    isValid: () => valid && !editor.isDestroyed,
    dispose: () => { editor.off("transaction", onTransaction); },
  };
}

/**
 * Pastes a copied Markdown table into the cells at the selection, in one undo step,
 * the way Word and Excel do: the pasted block is anchored at the top-left selected
 * cell, and the table gains rows/columns when the block does not fit. Returns false
 * (so the normal paste runs) for non-table content or when merged cells are involved.
 */
export function pasteMarkdownTableIntoCells(editor: Editor, markdown: string): boolean {
  const { state } = editor;
  const sel = state.selection;
  const cellTypes = ["tableCell", "tableHeader"];
  let tableStart: number;
  let left: number, top: number;
  if (sel instanceof CellSelection) {
    tableStart = sel.$anchorCell.start(-1);
    const rect = TableMap.get(sel.$anchorCell.node(-1)).rectBetween(sel.$anchorCell.pos - tableStart, sel.$headCell.pos - tableStart);
    ({ left, top } = rect);
  } else {
    const $from = sel.$from;
    let depth = $from.depth;
    while (depth > 2 && !cellTypes.includes($from.node(depth).type.name)) depth--;
    if (depth < 2 || !cellTypes.includes($from.node(depth).type.name)) return false;
    tableStart = $from.start(depth - 2);
    ({ left, top } = TableMap.get($from.node(depth - 2)).findCell($from.before(depth) - tableStart));
  }
  const json = editor.markdown?.parse(markdown);
  if (!json) return false;
  const pasted = editor.schema.nodeFromJSON(json);
  const pastedTable = pasted.childCount === 1 ? pasted.child(0) : null;
  if (pastedTable?.type.name !== "table") return false;
  const rows = pastedTable.childCount;
  const cols = pastedTable.child(0).childCount;
  for (let r = 0; r < rows; r++) {
    const row = pastedTable.child(r);
    if (row.childCount !== cols) return false;
    for (let c = 0; c < cols; c++) if (row.child(c).attrs.colspan > 1 || row.child(c).attrs.rowspan > 1) return false;
  }
  const tr = state.tr;
  const tableRect = (): TableRect => {
    const table = tr.doc.nodeAt(tableStart - 1)!;
    const map = TableMap.get(table);
    return { left: 0, top: 0, right: map.width, bottom: map.height, map, table, tableStart };
  };
  while (top + rows > tableRect().map.height) addRow(tr, tableRect(), tableRect().map.height);
  while (left + cols > tableRect().map.width) addColumn(tr, tableRect(), tableRect().map.width);
  const map = tableRect().map;
  // Work backwards so earlier cell positions stay valid as content sizes change.
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const pos = tableStart + map.map[(top + r) * map.width + left + c];
      const cell = tr.doc.nodeAt(pos);
      if (!cell || cell.attrs.colspan > 1 || cell.attrs.rowspan > 1) return false;
      tr.replaceWith(pos + 1, pos + 1 + cell.content.size, pastedTable.child(r).child(c).content);
    }
  }
  closeHistory(tr);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** With `track`, the replacement is shown as proposed changes to accept or reject. */
export function replaceTiptapRangeWithMarkdown(editor: Editor, range: EditorRange, markdown: string, track?: ChangeSource) {
  const parsed = editor.markdown?.parse(markdown);
  if (!parsed) return false;
  const from = editor.state.doc.resolve(range.from);
  const to = editor.state.doc.resolve(range.to);
  // A one-paragraph AI reply to an inline selection should stay within its
  // paragraph/heading, rather than splitting the surrounding text into blocks.
  const content = from.sameParent(to) && from.parent.inlineContent && parsed.content?.length === 1 && parsed.content[0].type === "paragraph"
    ? parsed.content[0].content ?? []
    : parsed.content ?? [];
  return editor.chain()
    .command(({ tr }) => {
      closeHistory(tr);
      if (track) tr.setMeta(tiptapChangesKey, { type: "track", source: track } satisfies TiptapChangesMeta);
      return true;
    })
    .insertContentAt(range, content)
    .run();
}

/** Where Write with AI puts a new block for a caret at `pos`: in place of an empty
 * top-level paragraph, otherwise after the top-level block containing the caret. */
export function getTiptapBlockInsertionRange(editor: Editor, pos: number): EditorRange {
  const $pos = editor.state.doc.resolve(pos);
  if ($pos.depth === 0) return { from: pos, to: pos };
  const node = $pos.node(1);
  const from = $pos.before(1);
  const to = $pos.after(1);
  return node.isTextblock && node.content.size === 0 ? { from, to } : { from: to, to };
}
