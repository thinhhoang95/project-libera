import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { reviewBlocks, type ReviewRange } from "./markdown-review";

export const tiptapReviewKey = new PluginKey<DecorationSet>("liberaReview");
export const TiptapReview = Extension.create({
  name: "liberaReview",
  addProseMirrorPlugins() {
    return [new Plugin({ key: tiptapReviewKey, state: {
      init: () => DecorationSet.empty,
      apply: (tr, previous) => {
        const ranges = tr.getMeta(tiptapReviewKey) as { from: number; to: number; kind: string }[] | undefined;
        return ranges ? DecorationSet.create(tr.doc, ranges.map((r) => Decoration.inline(r.from, r.to, { class: `review-visual-highlight review-${r.kind}` }))) : previous.map(tr.mapping, tr.doc);
      },
    }, props: { decorations: (state) => tiptapReviewKey.getState(state) } })];
  },
});
// Align parsed source blocks to the live ProseMirror document in order. Parsing
// through the editor's own schema handles math, marks, images and nested lists.
// Refuse mismatches rather than mapping a repeated paragraph to its first match.
export function tiptapReviewBlocks(editor: Editor, source: string) {
  if (!editor.markdown) return [];
  const blocks = reviewBlocks(source);
  const definitions = blocks.filter((b) => b.type === "definition").map((b) => b.text).join("\n\n");
  const mapped: { start: number; end: number; from: number; to: number }[] = [];
  let cursor = 0;
  for (const block of blocks) {
    if (block.type === "definition") continue;
    let parsed;
    try { parsed = editor.schema.nodeFromJSON(editor.markdown.parse(block.text + (definitions ? `\n\n${definitions}` : ""))); }
    catch { return []; }
    const size = parsed.content.size;
    if (!size) continue;
    if (cursor + size > editor.state.doc.content.size || !editor.state.doc.slice(cursor, cursor + size).content.eq(parsed.content)) return [];
    mapped.push({ start: block.start, end: block.end, from: cursor, to: cursor + size });
    cursor += size;
  }
  return mapped;
}
export function tiptapRangeForSource(editor: Editor, source: string, range: ReviewRange) {
  const blocks = tiptapReviewBlocks(editor, source).filter((b) => b.start < range.end && b.end > range.start);
  return blocks.length ? { from: blocks[0].from, to: blocks.at(-1)!.to } : null;
}
export function sourceRangeForTiptapSelection(editor: Editor, source: string, from: number, to: number): ReviewRange | null {
  // DOM selections may start at the previous paragraph's closing boundary.
  // Include only blocks whose editable content actually intersects selection.
  const blocks = tiptapReviewBlocks(editor, source).filter((b) => from === to ? b.from <= from && b.to > from : b.from + 1 < to && b.to - 1 > from);
  return blocks.length ? { start: blocks[0].start, end: blocks.at(-1)!.end } : null;
}
