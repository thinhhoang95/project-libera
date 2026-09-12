import type { Editor, JSONContent } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import {
  getHeadingEnumerationNumbers,
  headingNumberPrefixLength,
  type MarkdownHeadingEnumerationScope,
} from "./markdown-heading-enumeration";

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
    tr.replaceWith(pos + 1, pos + 1 + prefixLength, editor.schema.text(prefix));
  }
  if (!tr.docChanged) return false;
  editor.view.dispatch(tr);
  return true;
}

export function changeTiptapHeadingLevels(editor: Editor, range: EditorRange, direction: "indent" | "unindent") {
  const tr = closeHistory(editor.state.tr);
  const delta = direction === "indent" ? 1 : -1;
  for (const { node, pos, selected } of getTiptapHeadings(editor, range)) {
    const level = node.attrs.level + delta;
    if (selected && level >= 1 && level <= 6) tr.setNodeMarkup(pos, undefined, { ...node.attrs, level });
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

export function replaceTiptapRangeWithMarkdown(editor: Editor, range: EditorRange, markdown: string) {
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
    .command(({ tr }) => { closeHistory(tr); return true; })
    .insertContentAt(range, content)
    .run();
}
