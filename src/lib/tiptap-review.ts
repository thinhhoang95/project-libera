import { Extension, type Editor } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
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
type ReviewBlockMapping = { start: number; end: number; from: number; to: number };
const reviewMappingCache = new WeakMap<Editor, { doc: ProseMirrorNode; source: string; blocks: ReviewBlockMapping[] }>();

// One mapping per immutable document/source pair, shared by all comments and
// selection decorations. Metadata-only transactions keep the document identity.
export function tiptapReviewBlocks(editor: Editor, source: string) {
  const cached = reviewMappingCache.get(editor);
  if (cached?.doc === editor.state.doc && cached.source === source) return cached.blocks;
  const blocks = mapReviewBlocks(editor, source);
  reviewMappingCache.set(editor, { doc: editor.state.doc, source, blocks });
  return blocks;
}

// Align parsed source blocks to the live ProseMirror document in order. Parsing
// through the editor's own schema handles math, marks, images and nested lists.
// Refuse mismatches rather than mapping a repeated paragraph to its first match.
function mapReviewBlocks(editor: Editor, source: string): ReviewBlockMapping[] {
  if (!editor.markdown) return [];
  const blocks = reviewBlocks(source);
  const definitions = blocks.filter((b) => b.type === "definition").map((b) => b.text).join("\n\n");
  const mapped: ReviewBlockMapping[] = [];
  let cursor = 0;
  for (const block of blocks) {
    if (block.type === "definition") continue;
    let parsed;
    try { parsed = editor.schema.nodeFromJSON(editor.markdown.parse(block.text + (definitions ? `\n\n${definitions}` : ""))); }
    catch { return []; }
    if (!parsed.content.size) continue;
    let size = 0;
    const matches = () => {
      // Source and live nodes need not have identical sizes or marks. For
      // example, Markdown moves a bold trailing space outside the **markers**,
      // and a new paragraph may still contain leading spaces while typing.
      const nodes = [];
      size = 0;
      for (let index = 0; index < parsed.childCount; index++) {
        const node = editor.state.doc.nodeAt(cursor + size);
        if (!node) return false;
        nodes.push(node);
        size += node.nodeSize;
      }
      const content = Fragment.fromArray(nodes);
      if (content.eq(parsed.content)) return true;
      // Compare canonical Markdown for these exact, ordered blocks. Never
      // search by text or reparse/setContent on the live editor: repeated
      // passages, selection, IME composition and undo history must stay intact.
      const serialize = (fragment: Fragment) => editor.markdown!.serialize({ type: "doc", content: fragment.toJSON() ?? [] }).trim();
      return serialize(content) === serialize(parsed.content);
    };
    // Tiptap preserves extra blank lines as empty paragraphs; remark's source
    // blocks omit that whitespace. Advance past only these unanchored nodes,
    // keeping nonempty blocks in strict order (including repeated passages).
    while (!matches()) {
      const node = editor.state.doc.nodeAt(cursor);
      if (!node || node.type.name !== "paragraph" || node.content.size !== 0) return [];
      cursor += node.nodeSize;
    }
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
