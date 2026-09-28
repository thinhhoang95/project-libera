import { Extension, type Editor } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { reviewBlocks, type ReviewEdit, type ReviewRange } from "./markdown-review";
import { diffNodes, type ChangeHunk, type TrackedChange } from "./tiptap-changes";

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

function hashText(text: string) {
  let hash = 0;
  for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) | 0;
  return (hash >>> 0).toString(36);
}

/** Preview pending review suggestions as inline changes without editing the
 * document: each edited run of blocks is re-parsed with its replacement and
 * diffed against the live nodes. Suggestions that cannot be mapped exactly are
 * left to the review panel rather than shown in the wrong place. */
export function tiptapReviewChanges(editor: Editor, source: string, suggestions: { id: string; label: string; edits: ReviewEdit[] }[]): TrackedChange[] {
  const markdown = editor.markdown;
  const blocks = markdown ? tiptapReviewBlocks(editor, source) : [];
  if (!markdown || !blocks.length) return [];
  const parse = (text: string) => editor.schema.nodeFromJSON(markdown.parse(text)).content;
  const nodes = (fragment: Fragment) => { const list: ProseMirrorNode[] = []; fragment.forEach((node) => list.push(node)); return list; };
  const changes: TrackedChange[] = [];
  for (const suggestion of suggestions) {
    const regions: { first: number; last: number; start: number; end: number; edits: ReviewEdit[] }[] = [];
    const edits = [...suggestion.edits].sort((a, b) => a.start - b.start);
    if (edits.some((edit) => !blocks.some((block) => block.start < edit.end && block.end > edit.start))) continue;
    for (const edit of edits) {
      const first = blocks.findIndex((block) => block.start < edit.end && block.end > edit.start);
      const last = blocks.findLastIndex((block) => block.start < edit.end && block.end > edit.start);
      const region = regions.at(-1);
      if (region && first <= region.last) {
        region.last = Math.max(region.last, last);
        region.end = Math.max(region.end, edit.end, blocks[last].end);
        region.edits.push(edit);
      } else regions.push({ first, last, start: Math.min(blocks[first].start, edit.start), end: Math.max(blocks[last].end, edit.end), edits: [edit] });
    }
    const hunks: ChangeHunk[] = [];
    try {
      for (const region of regions) {
        const from = blocks[region.first].from, to = blocks[region.last].to;
        const original = source.slice(region.start, region.end);
        const proposed = region.edits.reduceRight((text, edit) => text.slice(0, edit.start - region.start) + edit.after + text.slice(edit.end - region.start), original);
        const live = nodes(editor.state.doc.slice(from, to).content), next = nodes(parse(proposed));
        // Refine only when the live nodes are exactly what the source parses to;
        // otherwise show the whole run as replaced, which is still accurate.
        hunks.push(...(Fragment.fromArray(live).eq(parse(original))
          ? diffNodes(live, from, next, 0)
          : [{ a: { from, to }, b: { from: 0, to: 0 }, aContent: Fragment.fromArray(live), bContent: Fragment.fromArray(next), block: true }]));
      }
    } catch { continue; }
    hunks.forEach((hunk, index) => changes.push({
      id: `${suggestion.id}:${index}:${hashText(JSON.stringify(hunk.bContent.toJSON()))}`, group: suggestion.id, source: "review", label: suggestion.label,
      mode: "preview", block: hunk.block, from: hunk.a.from, to: hunk.a.to, other: hunk.bContent, showActions: index === hunks.length - 1,
    }));
  }
  return changes;
}
