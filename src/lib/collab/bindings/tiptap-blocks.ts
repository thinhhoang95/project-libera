// Block model for the Visual-editor ↔ Y.Text bridge (collaboration map §7.2).
//
// The source text is tiled into alternating gaps (whitespace between blocks)
// and blocks (top-level remark nodes, the same ranges `reviewBlocks` gives the
// review code). Each tile records how many ProseMirror top-level nodes stand
// for it: a block is usually one node, a gap holds the empty paragraphs Tiptap
// keeps for extra blank lines. Concatenating the tiles gives the exact source,
// and concatenating their nodes gives the ProseMirror document, so a change on
// either side can be confined to the tiles it touches.

import type { Editor } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { reviewBlocks } from "../../markdown-review";

export type TileKind = "gap" | "block" | "dirty";

export interface Tile {
  /**
   * `gap` and `block` tiles are in step with their nodes. A `dirty` tile
   * merges tiles whose source changed (remotely, or locally in a way that
   * still needs re-tiling); the bridge reconciles it on the next sync.
   */
  kind: TileKind;
  /** Offset of the tile in the current Y.Text. */
  start: number;
  /** The tile's current source text (Y.Text coordinates). */
  text: string;
  /** Number of ProseMirror top-level nodes that represent this tile. */
  count: number;
  /** remark node type, for blocks. */
  type?: string;
  /** For dirty tiles: the source the current ProseMirror nodes stand for. */
  pmText?: string;
  /** A dirty tile whose nodes must be reparsed even though its text did not change. */
  stale?: boolean;
}

/** How a gap borders the document: blank lines at the start or end parse differently. */
export type GapEdge = "interior" | "lead" | "trail" | "only";

export interface SourceBlock {
  start: number;
  end: number;
  type: string;
}

/** Parse and serialize single blocks with the editor's own Markdown extensions. */
export interface MarkdownCodec {
  schema: Schema;
  /** Top-level nodes for a Markdown fragment. */
  parse(markdown: string): ProseMirrorNode[];
  /** Markdown for one top-level node, without surrounding blank lines. */
  serializeNode(node: ProseMirrorNode): string;
}

export function editorMarkdownCodec(editor: Editor): MarkdownCodec {
  const markdown = editor.markdown;
  if (!markdown) throw new Error("The Visual bridge needs the Tiptap Markdown extension.");
  const schema = editor.schema;
  return {
    schema,
    parse(text) {
      const json = markdown.parse(text);
      return (json.content ?? []).map((node) => repairNode(schema, schema.nodeFromJSON(node)));
    },
    serializeNode(node) {
      // Tables serialize with a surrounding newline. Blank lines between blocks
      // are the gaps' business, so strip them here.
      return markdown.serialize({ type: "doc", content: [node.toJSON()] }).replace(/^\n+|\n+$/g, "");
    },
  };
}

/**
 * The Markdown parser does not validate against the schema: "- # Title"
 * yields a list item whose first child is a heading, which ProseMirror rejects
 * later ("Called contentMatchAt on a node with invalid content"). Fill in what
 * the content expression requires, or fall back to a plain paragraph. Every
 * participant parses the same way, so the repair is the same everywhere.
 */
export function repairNode(schema: Schema, node: ProseMirrorNode): ProseMirrorNode {
  if (node.isText || node.isLeaf) return node;
  const kids: ProseMirrorNode[] = [];
  let changed = false;
  node.forEach((child) => {
    const repaired = repairNode(schema, child);
    changed ||= repaired !== child;
    kids.push(repaired);
  });
  const content = changed ? Fragment.fromArray(kids) : node.content;
  if (node.type.validContent(content)) return changed ? node.copy(content) : node;
  const filled = node.type.createAndFill(node.attrs, content, node.marks);
  if (filled) return filled;
  const text = node.textContent;
  return schema.nodes.paragraph.create(null, text ? schema.text(text) : null);
}

function parseBlocks(text: string, offset: number): SourceBlock[] {
  return reviewBlocks(text).map((block) => ({ start: block.start + offset, end: block.end + offset, type: block.type }));
}

const CHUNK = 32_000;

/**
 * Top-level source blocks with absolute offsets.
 *
 * remark's cost grows faster than linearly with document size (a 1 MB note
 * takes about 18 s in one parse, 2 s in 50 KB pieces), so long texts are
 * parsed in chunks cut before a paragraph or heading that follows a blank
 * line. Each seam is then checked by parsing its two neighbouring blocks
 * together: block structure at a blank line depends only on the block before
 * it (an open fence, list, HTML or math block), so if that pair parses the
 * same, the whole parse does. A seam that fails is merged and reparsed.
 */
export function sourceBlocks(text: string, offset = 0): SourceBlock[] {
  if (text.length <= 2 * CHUNK) return parseBlocks(text, offset);
  const cuts: number[] = [];
  for (let pos = CHUNK; pos < text.length - CHUNK / 2;) {
    const blank = /\n[ \t]*\n+(?=[A-Za-z#À-￿])/g;
    blank.lastIndex = pos;
    const match = blank.exec(text);
    if (!match) break;
    const cut = match.index + match[0].length;
    cuts.push(cut);
    pos = cut + CHUNK;
  }
  cuts.push(text.length);
  const result: SourceBlock[] = [];
  let start = 0;
  for (const end of cuts) {
    const blocks = parseBlocks(text.slice(start, end), offset + start);
    const last = result.at(-1), first = blocks[0];
    if (last && first) {
      const pair = parseBlocks(text.slice(last.start - offset, first.end - offset), last.start);
      const holds = pair.length === 2 && pair[0].end === last.end && pair[1].start === first.start && pair[1].end === first.end;
      if (!holds) {
        result.pop();
        result.push(...parseBlocks(text.slice(last.start - offset, end), last.start));
        start = end;
        continue;
      }
    }
    result.push(...blocks);
    start = end;
  }
  return result;
}

export function isEmptyParagraph(node: ProseMirrorNode | undefined): boolean {
  return !!node && node.type.name === "paragraph" && node.childCount === 0;
}

const gapCache = new Map<string, number>();

/**
 * Number of empty paragraphs Tiptap creates for a run of blank lines. Only
 * newlines matter for the common case; anything else (spaces, CRLF) is
 * measured by parsing the gap between placeholder paragraphs, once.
 */
export function gapEmptyParagraphs(codec: MarkdownCodec, text: string, edge: GapEdge): number {
  if (/^\n*$/.test(text)) {
    const half = Math.floor(text.length / 2);
    if (edge === "interior") return Math.max(0, half - 1);
    return text.length < 2 ? 0 : half;
  }
  const key = `${edge}\u0000${text}`;
  const cached = gapCache.get(key);
  if (cached !== undefined) return cached;
  const left = edge === "interior" || edge === "trail" ? "x" : "";
  const right = edge === "interior" || edge === "lead" ? "x" : "";
  const nodes = codec.parse(left + text + right);
  const count = Math.max(0, nodes.filter(isEmptyParagraph).length);
  if (gapCache.size > 512) gapCache.clear();
  gapCache.set(key, count);
  return count;
}

/**
 * Markdown for a run of top-level nodes that replaces source bounded by a
 * block on the left (`hasLeft`) and/or right (`hasRight`), or the document
 * edges. Empty paragraphs become blank lines, the inverse of
 * `gapEmptyParagraphs`, so the result parses back to the same run.
 */
export function serializeRun(codec: MarkdownCodec, nodes: readonly ProseMirrorNode[], hasLeft: boolean, hasRight: boolean): string {
  const parts = nodes.map((node) => isEmptyParagraph(node) ? "" : codec.serializeNode(node));
  const joined = parts.join("\n\n");
  if (hasLeft && hasRight) return parts.length ? `\n\n${joined}\n\n` : "\n\n";
  if (hasLeft) return parts.length ? `\n\n${joined}` : "";
  if (hasRight) return parts.length ? `${joined}\n\n` : "";
  // A document made only of empty paragraphs: "" already stands for one.
  if (parts.every((part) => part === "")) return parts.length <= 1 ? "" : "\n".repeat(2 * parts.length);
  return joined;
}

/**
 * Whether an existing node may stand for a source block of this remark type.
 * Used after a local edit to keep the user's nodes when the new source still
 * means the same structure, and to reparse when it does not (for example a
 * paragraph whose text now starts with "# ", or two lists that merged).
 */
export function nodeMatchesBlock(node: ProseMirrorNode, type: string, text: string): boolean {
  switch (node.type.name) {
    case "paragraph":
      // "$$" is an inline marker in Libera, but remark-math opens a block with it
      // that runs across blank lines; only a single-paragraph run is the same thing.
      return type === "paragraph" || type === "html" || (type === "math" && !/\n[ \t]*\n/.test(text)) || (type === "blockquote" && text.startsWith(">>>"));
    case "heading": return type === "heading";
    case "bulletList":
    case "orderedList":
    case "taskList": return type === "list";
    case "blockquote": return type === "blockquote" && !text.startsWith(">>>");
    case "codeBlock": return type === "code";
    case "horizontalRule": return type === "thematicBreak";
    case "table": return type === "table";
    case "blockMath": return type === "math" || type === "paragraph";
    case "image": return type === "paragraph";
    default: return true;
  }
}

/**
 * Builds tiles for `text` (which starts at `offset`), given the remark blocks
 * inside it. Counts are left at 0; callers fill them from parsing or from the
 * existing nodes.
 */
export function tilesForBlocks(text: string, offset: number, blocks: readonly SourceBlock[]): Tile[] {
  const tiles: Tile[] = [];
  let cursor = offset;
  for (const block of blocks) {
    tiles.push({ kind: "gap", start: cursor, text: text.slice(cursor - offset, block.start - offset), count: 0 });
    tiles.push({ kind: "block", start: block.start, text: text.slice(block.start - offset, block.end - offset), count: 0, type: block.type });
    cursor = block.end;
  }
  tiles.push({ kind: "gap", start: cursor, text: text.slice(cursor - offset), count: 0 });
  return tiles;
}

export function gapEdge(index: number, length: number, leftEdge: boolean, rightEdge: boolean): GapEdge {
  const first = index === 0 && leftEdge, last = index === length - 1 && rightEdge;
  return first && last ? "only" : first ? "lead" : last ? "trail" : "interior";
}

export const tileEnd = (tile: Tile) => tile.start + tile.text.length;

// ---------------------------------------------------------------------------
// Position alignment between a node run and its source text.
//
// ProseMirror positions and source offsets are related only through visible
// text: "**bold**" is four visible characters behind four markup characters.
// The alignment matches each text node verbatim in the source when it can,
// and falls back to a greedy character match (escapes, entities), so it is
// exact for plain text and approximate inside inline formatting.

/** `pm + k` corresponds to `src + k` for k in 0..len. */
export interface AlignSegment { pm: number; src: number; len: number }

const LOOKAHEAD = 64;

/** Alignment for nodes laid out from position 0, against `text`. */
export function alignRun(nodes: readonly ProseMirrorNode[], text: string): AlignSegment[] {
  const segments: AlignSegment[] = [];
  let cursor = 0;
  let pos = 0;
  const visit = (node: ProseMirrorNode, start: number) => {
    if (node.isText) {
      const value = node.text ?? "";
      const found = value ? text.indexOf(value, cursor) : -1;
      if (found >= 0 && found - cursor <= Math.max(LOOKAHEAD, 4 * value.length + 512)) {
        segments.push({ pm: start, src: found, len: value.length });
        cursor = found + value.length;
        return;
      }
      for (let index = 0; index < value.length; index++) {
        const hit = text.indexOf(value[index], cursor);
        if (hit < 0 || hit - cursor > LOOKAHEAD) continue;
        segments.push({ pm: start + index, src: hit, len: 1 });
        cursor = hit + 1;
      }
      return;
    }
    if (node.isLeaf) {
      const value = node.type.name === "hardBreak" ? "\n" : typeof node.attrs.latex === "string" ? node.attrs.latex : "";
      const hit = value ? text.indexOf(value, cursor) : -1;
      if (hit >= 0 && hit - cursor <= LOOKAHEAD + value.length) {
        segments.push({ pm: start, src: hit, len: 0 });
        cursor = hit + value.length;
        segments.push({ pm: start + node.nodeSize, src: cursor, len: 0 });
      }
      return;
    }
    if (node.isTextblock && node.content.size === 0) {
      // An empty block: place the caret after the next line break's markup.
      const lineEnd = text.indexOf("\n", cursor);
      segments.push({ pm: start + 1, src: lineEnd < 0 ? text.length : Math.min(text.length, lineEnd + 1), len: 0 });
      return;
    }
    node.forEach((child, offset) => visit(child, start + 1 + offset));
  };
  for (const node of nodes) {
    visit(node, pos);
    pos += node.nodeSize;
  }
  return segments;
}

/** Source offset for a position relative to the run's start. */
export function alignedOffset(segments: readonly AlignSegment[], pos: number): number {
  let best: AlignSegment | undefined;
  for (const segment of segments) {
    if (segment.pm > pos) break;
    best = segment;
  }
  if (!best) return 0;
  return best.src + Math.min(best.len, pos - best.pm);
}

/** Position relative to the run's start for a source offset. */
export function alignedPosition(segments: readonly AlignSegment[], offset: number): number | null {
  let best: AlignSegment | undefined;
  for (const segment of segments) {
    if (segment.src > offset) break;
    best = segment;
  }
  if (!best) return segments[0]?.pm ?? null;
  return best.pm + Math.min(best.len, offset - best.src);
}
