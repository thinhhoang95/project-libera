import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { RootContent, Nodes } from "mdast";

/** Target output per chunk, leaving headroom under the 16k-token response cap for reasoning and markup. */
export const LATEX_CHUNK_TOKENS = 10_000;
/** LaTeX commands and escaping make the output longer than its Markdown source. */
const LATEX_EXPANSION = 1.3;

/** Rough token count: one per CJK character, one per two other non-ASCII characters, one per four ASCII characters. */
export function estimateTokens(text: string) {
  const wide = text.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/g)?.length ?? 0;
  const other = text.match(/[^\x00-\x7f]/g)?.length ?? 0;
  return wide + (other - wide) / 2 + (text.length - other) / 4;
}

/** Markdown characters per chunk for this document's script density. */
export function latexChunkCharacters(markdown: string) {
  const tokens = estimateTokens(markdown) * LATEX_EXPANSION;
  return Math.max(2_000, Math.floor(tokens ? markdown.length * LATEX_CHUNK_TOKENS / tokens : markdown.length));
}

export type LatexBlock = {
  id: number; markdown: string; type: string; continuation: boolean;
  /** Paragraph block that is resumed by the next block. */
  continues?: boolean;
  /** Ordinal of a split-out item of an ordered list. */
  listStart?: number;
  /** The leading level-1 heading, which \\maketitle already renders. */
  title?: boolean;
};
export type LatexChunk = { blocks: LatexBlock[]; references: string };
export type LatexPlan = { chunks: LatexChunk[]; overview: string; title?: string };

/** Split at Markdown syntax boundaries, never through a table, equation or inline construct. */
export function planLatexChunks(markdown: string, chunkCharacters = latexChunkCharacters(markdown)): LatexPlan {
  // An indivisible block may exceed one chunk; the response continues in the same thread.
  const maxBlockCharacters = 2 * chunkCharacters;
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown);
  const slice = (node: Nodes) => markdown.slice(node.position!.start.offset!, node.position!.end.offset!);
  const definitions = new Map<string, string>();
  const definitionNodes = new Map<string, Nodes>();
  const types = new Set<string>();
  const headings: string[] = [];
  function walk(node: Nodes, visit: (node: Nodes) => void) {
    visit(node);
    if ("children" in node) for (const child of node.children) walk(child, visit);
  }
  walk(tree, (node) => {
    types.add(node.type);
    if (node.type === "definition" || node.type === "footnoteDefinition") {
      const id = node.identifier.toLowerCase();
      if (!definitions.has(id)) { definitions.set(id, slice(node)); definitionNodes.set(id, node); }
    }
    if (node.type === "heading") headings.push(slice(node));
  });

  const blocks: LatexBlock[] = [];
  const blockReferences = new Map<number, Set<string>>();
  let activeReferences = new Set<string>();
  function add(text: string, type: string, extra: Partial<LatexBlock> = {}) {
    if (text.length > maxBlockCharacters) {
      throw new Error(`A Markdown ${type} block exceeds ${maxBlockCharacters.toLocaleString("en-US")} characters and cannot be split safely. Break it into smaller blocks before exporting.`);
    }
    blocks.push({ id: blocks.length + 1, markdown: text, type, continuation: false, ...extra });
    blockReferences.set(blocks.length, activeReferences);
  }
  function split(node: RootContent) {
    const text = slice(node);
    if (text.length <= chunkCharacters) { add(text, node.type); return; }
    if (node.type === "list") {
      // Each item retains its original marker, numbering, nesting and indentation.
      node.children.forEach((item, index) => add(slice(item), "list", node.ordered ? { listStart: (node.start ?? 1) + index } : {}));
    } else if (node.type === "paragraph") {
      // Only whitespace in plain text is safe; emphasis, links, code and math remain atomic.
      const boundaries: number[] = [];
      for (const child of node.children) {
        if (child.type !== "text") continue;
        const offset = child.position!.start.offset! - node.position!.start.offset!;
        for (const match of slice(child).matchAll(/\s+/g)) boundaries.push(offset + match.index! + match[0].length);
      }
      let start = 0;
      while (text.length - start > chunkCharacters) {
        const end = boundaries.findLast((point) => point > start && point <= start + chunkCharacters);
        if (end === undefined) break;
        add(text.slice(start, end), "paragraph", { continuation: start > 0, continues: true }); start = end;
      }
      add(text.slice(start), "paragraph", { continuation: start > 0 });
    } else if (node.type === "code") {
      // Repeat fences around each group of complete lines, including the original language.
      const fence = "`".repeat(Math.max(3, ...[...node.value.matchAll(/`+/g)].map((match) => match[0].length + 1)));
      const opening = `${fence}${node.lang || ""}${node.meta ? " " + node.meta : ""}\n`;
      let value = "";
      for (const line of node.value.match(/[^\n]*\n|[^\n]+$/g) || []) {
        if (value && opening.length + value.length + line.length + fence.length + 1 > chunkCharacters) {
          add(opening + value + (value.endsWith("\n") ? "" : "\n") + fence, "code"); value = "";
        }
        value += line;
      }
      if (value) add(opening + value + (value.endsWith("\n") ? "" : "\n") + fence, "code");
    } else if (node.type === "table" && node.children.length > 1) {
      // Keep each row whole and repeat the header/delimiter so every chunk is a valid table.
      const header = markdown.slice(node.position!.start.offset!, node.children[1].position!.start.offset!);
      let rows = "";
      for (const row of node.children.slice(1)) {
        const value = slice(row) + "\n";
        if (rows && header.length + rows.length + value.length > chunkCharacters) {
          add(header + rows, "table"); rows = "";
        }
        rows += value;
      }
      add(header + rows, "table");
    } else {
      add(text, node.type);
    }
  }
  let first = true;
  for (const node of tree.children) {
    if (node.type !== "definition" && node.type !== "footnoteDefinition") {
      const before = blocks.length;
      activeReferences = new Set<string>();
      walk(node, (child) => {
        if (child.type === "linkReference" || child.type === "imageReference" || child.type === "footnoteReference") activeReferences.add(child.identifier.toLowerCase());
      });
      split(node);
      if (first && node.type === "heading" && node.depth === 1 && blocks.length > before) blocks[before].title = true;
      first = false;
    }
  }
  if (!blocks.length) throw new Error("The document has no content to convert.");

  const chunks: LatexChunk[] = [];
  let current: LatexBlock[] = [];
  let size = 0;
  function references(items: LatexBlock[]) {
    const used = new Set<string>();
    function include(id: string) {
      if (used.has(id)) return;
      used.add(id);
      const definition = definitionNodes.get(id);
      if (definition) walk(definition, (node) => {
        if (node.type === "linkReference" || node.type === "imageReference" || node.type === "footnoteReference") include(node.identifier.toLowerCase());
      });
    }
    for (const block of items) for (const id of blockReferences.get(block.id)!) include(id);
    return [...used].map((id) => definitions.get(id) || "").join("\n");
  }
  function flush() {
    if (!current.length) return;
    const context = references(current);
    if (context.length > maxBlockCharacters) throw new Error("The reference definitions for a LaTeX chunk are too large. Shorten the linked URLs or footnotes before exporting.");
    chunks.push({ blocks: current, references: context }); current = []; size = 0;
  }
  for (const block of blocks) {
    if (size + block.markdown.length > chunkCharacters) flush();
    current.push(block); size += block.markdown.length;
  }
  flush();
  const overview = `Document syntax: ${[...types].join(", ")}\nHeadings (overview only):\n${headings.join("\n").slice(0, 4_000)}\nOpening excerpt (overview only):\n${blocks[0].markdown.slice(0, 1_000)}`;
  const title = blocks[0].title ? blocks[0].markdown.replace(/^#+[ 	]*/, "").replace(/[ 	]+#+[ 	]*$/, "").trim() : undefined;
  return { chunks, overview, title };
}
