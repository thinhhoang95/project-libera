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
  const blocks = mapReviewBlocks(editor, source) ?? mapLiveBlocks(editor, source);
  reviewMappingCache.set(editor, { doc: editor.state.doc, source, blocks });
  return blocks;
}

// Align parsed source blocks to the live ProseMirror document in order. Parsing
// through the editor's own schema handles math, marks, images and nested lists.
// Refuse mismatches rather than mapping a repeated paragraph to its first match.
function mapReviewBlocks(editor: Editor, source: string): ReviewBlockMapping[] | null {
  if (!editor.markdown) return [];
  const blocks = reviewBlocks(source);
  const definitions = blocks.filter((b) => b.type === "definition").map((b) => b.text).join("\n\n");
  const mapped: ReviewBlockMapping[] = [];
  let cursor = 0;
  for (const block of blocks) {
    if (block.type === "definition") continue;
    let parsed;
    try { parsed = editor.schema.nodeFromJSON(editor.markdown.parse(block.text + (definitions ? `\n\n${definitions}` : ""))); }
    catch { return null; }
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
      // Trailing spaces typed at a line end are not compared: Markdown drops
      // them (a heading of spaces parses as an empty heading).
      const serialize = (fragment: Fragment) => editor.markdown!.serialize({ type: "doc", content: fragment.toJSON() ?? [] }).replace(/[ \t]+$/gm, "").trim();
      return serialize(content) === serialize(parsed.content);
    };
    // Tiptap preserves extra blank lines as empty paragraphs; remark's source
    // blocks omit that whitespace. Mid-edit, a block can also be blank in
    // other ways (a new empty heading, a paragraph holding only spaces) that
    // leaves no source block. Advance past only these unanchored nodes,
    // keeping nonempty blocks in strict order (including repeated passages).
    while (!matches()) {
      const node = editor.state.doc.nodeAt(cursor);
      if (!node || !isBlankBlock(node)) return null;
      cursor += node.nodeSize;
    }
    mapped.push({ start: block.start, end: block.end, from: cursor, to: cursor + size });
    cursor += size;
  }
  return mapped;
}
// The fallback while the live document is mid-edit in a shape the strict
// alignment refuses (say, a list item or quote just started). Each top-level
// node is found in the source by its own Markdown, in order, from where the
// previous one ended; a node not found that way takes the source between its
// found neighbours. Read-only: the editor and the source are never changed.
// Only for a source that is the live document's own Markdown: against a stale
// source (an anchor not yet caught up) a guess could pick the wrong copy of a
// repeated passage, so that keeps refusing.
function mapLiveBlocks(editor: Editor, source: string): ReviewBlockMapping[] {
  const markdown = editor.markdown;
  if (!markdown) return [];
  let live;
  try { live = editor.getMarkdown(); } catch { return []; }
  if (live.replace(/\r\n?/g, "\n").trimEnd() !== source.replace(/\r\n?/g, "\n").trimEnd()) return [];
  const nodes: { from: number; to: number; start: number; end: number }[] = [];
  let cursor = 0;
  editor.state.doc.forEach((node, offset) => {
    if (isBlankBlock(node)) return;
    let text = "";
    try { text = markdown.serialize({ type: "doc", content: [node.toJSON()] }).trim(); } catch { /* Placed from its neighbours below. */ }
    const lines = text.split("\n").map((line) => line.trimEnd());
    let at = text ? source.indexOf(text, cursor) : -1;
    let length = text.length;
    // Trailing spaces typed at a line end may be spelled differently.
    if (at < 0 && lines[0]) {
      const first = source.indexOf(lines[0], cursor);
      if (first >= 0) {
        let end = first;
        for (const line of lines) { const found = source.indexOf(line, end); if (found < 0 || source.slice(end, found).trim()) { end = -1; break; } end = found + line.length; }
        if (end > first) { at = first; length = end - first; }
      }
    }
    if (at >= 0) cursor = at + length;
    nodes.push({ from: offset, to: offset + node.nodeSize, start: at, end: at < 0 ? -1 : at + length });
  });
  nodes.forEach((node, index) => {
    if (node.start >= 0) return;
    let start = 0, end = source.length;
    for (let other = index - 1; other >= 0; other--) if (nodes[other].end >= 0) { start = nodes[other].end; break; }
    for (let other = index + 1; other < nodes.length; other++) if (nodes[other].start >= 0) { end = nodes[other].start; break; }
    while (start < end && /\s/.test(source[start])) start++;
    while (end > start && /\s/.test(source[end - 1])) end--;
    Object.assign(node, { start, end });
  });
  return nodes.filter((node) => node.end > node.start);
}
// A block that shows nothing yet: no text but whitespace, no code, and no
// leaf content such as an image, math or a rule.
function isBlankBlock(node: ProseMirrorNode) {
  if (node.isLeaf || node.type.spec.code) return false;
  let blank = true;
  node.descendants((child) => {
    if (!blank) return false;
    if (child.type.spec.code || (child.isText ? /\S/.test(child.text!) : child.isLeaf)) blank = false;
    return blank;
  });
  return blank;
}
export function tiptapRangeForSource(editor: Editor, source: string, range: ReviewRange) {
  const blocks = tiptapReviewBlocks(editor, source).filter((b) => b.start < range.end && b.end > range.start);
  return blocks.length ? { from: blocks[0].from, to: blocks.at(-1)!.to } : null;
}
function selectedBlocks(editor: Editor, source: string, from: number, to: number) {
  // DOM selections may start at the previous paragraph's closing boundary.
  // Include only blocks whose editable content actually intersects selection.
  return tiptapReviewBlocks(editor, source).filter((b) => from === to ? b.from <= from && b.to > from : b.from + 1 < to && b.to - 1 > from);
}
export function sourceRangeForTiptapSelection(editor: Editor, source: string, from: number, to: number): ReviewRange | null {
  const blocks = selectedBlocks(editor, source, from, to);
  return blocks.length ? { start: blocks[0].start, end: blocks.at(-1)!.end } : null;
}

// A mapped block's inline content aligned to its Markdown source. Rendered
// text is the source without its markup, in order, so a forward scan finds
// each character where the source has it, past emphasis, links, code, list
// markers and table pipes alike. A character the source spells another way
// (an entity) stays unaligned. Inline nodes without text (math, images) take
// the source between their aligned neighbours.
type AlignedUnit = { pos: number; size: number; start: number; end: number; space: boolean };
const blockAlignments = new WeakMap<ReviewBlockMapping, AlignedUnit[]>();

function alignedUnits(editor: Editor, source: string, block: ReviewBlockMapping) {
  const cached = blockAlignments.get(block);
  if (cached) return cached;
  const text = source.slice(block.start, block.end);
  const units: AlignedUnit[] = [];
  const atoms: number[] = [];
  // A highlight's color letter (`y>>>`) is markup, not text: a highlighted
  // passage starting with that letter must not take the delimiter.
  const markup = new Set<number>();
  for (const match of text.matchAll(/[yroagtbvps](?=>>>)/g)) markup.add(match.index);
  const find = (character: string, from: number) => {
    let at = text.indexOf(character, from);
    while (at >= 0 && markup.has(at)) at = text.indexOf(character, at + 1);
    return at;
  };
  let cursor = 0;
  // Spaces typed at the start of a line have no source: Markdown drops them.
  let leading = true;
  editor.state.doc.nodesBetween(block.from, block.to, (node, pos) => {
    if (node.isTextblock) leading = true;
    if (node.isInline && node.isLeaf && !node.isText) { leading = false; atoms.push(units.length); units.push({ pos, size: node.nodeSize, start: -1, end: -1, space: false }); }
    if (!node.isText) return;
    for (let index = 0; index < node.text!.length; index++) {
      const character = node.text![index];
      const space = /\s/.test(character);
      if (space && leading) { units.push({ pos: pos + index, size: 1, start: -1, end: -1, space }); continue; }
      if (!space) leading = false;
      let at = space ? cursor : find(character, cursor);
      if (space) while (at < text.length && !/\s/.test(text[at])) at++;
      if (at < 0 || at >= text.length) at = -1;
      else cursor = at + 1;
      units.push({ pos: pos + index, size: 1, start: at < 0 ? -1 : block.start + at, end: at < 0 ? -1 : block.start + at + 1, space });
    }
  });
  for (const index of atoms) {
    let start = block.start, end = block.end;
    for (let other = index - 1; other >= 0; other--) if (units[other].start >= 0) { start = units[other].end; break; }
    for (let other = index + 1; other < units.length; other++) if (units[other].start >= 0) { end = units[other].start; break; }
    while (start < end && /[\s|]/.test(source[start])) start++;
    while (end > start && /[\s|]/.test(source[end - 1])) end--;
    if (end > start) Object.assign(units[index], { start, end });
  }
  blockAlignments.set(block, units);
  return units;
}

/** The exact source range of a visual selection, or its whole blocks when none
 * of the selected text can be aligned with their Markdown. */
export function sourceRangeForTiptapTextSelection(editor: Editor, source: string, from: number, to: number): ReviewRange | null {
  const blocks = selectedBlocks(editor, source, from, to);
  if (!blocks.length) return null;
  const whole = { start: blocks[0].start, end: blocks.at(-1)!.end };
  if (from === to) return whole;
  let start = Infinity, end = -Infinity;
  for (const block of blocks) for (const unit of alignedUnits(editor, source, block)) {
    if (unit.start < 0 || unit.space || unit.pos >= to || unit.pos + unit.size <= from) continue;
    start = Math.min(start, unit.start); end = Math.max(end, unit.end);
  }
  return end > start ? { start, end } : whole;
}

/** The visual-editor positions showing a source range: exactly its text where
 * that aligns with the mapped blocks, otherwise the blocks themselves. */
export function tiptapSelectionForSourceRange(editor: Editor, source: string, range: ReviewRange) {
  const blocks = tiptapReviewBlocks(editor, source).filter((b) => b.start < Math.max(range.end, range.start + 1) && b.end > range.start);
  if (!blocks.length) return null;
  let from = Infinity, to = -Infinity;
  for (const block of blocks) for (const unit of alignedUnits(editor, source, block)) {
    if (unit.start < 0 || unit.space || unit.start >= range.end || unit.end <= range.start) continue;
    from = Math.min(from, unit.pos); to = Math.max(to, unit.pos + unit.size);
  }
  if (to > from) return { from, to };
  return { from: blocks[0].from + 1, to: Math.max(blocks[0].from + 1, blocks.at(-1)!.to - 1) };
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
