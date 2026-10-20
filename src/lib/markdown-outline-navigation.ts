import type { Editor, JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { markdownHeadingOffsets } from "./markdown-review";
import { scanCitations } from "./references/citation-syntax";

export const MARKDOWN_OUTLINE_NAVIGATE_EVENT = "libera:markdown-outline-navigate";

export type MarkdownOutlineNavigateDetail = {
  documentPath: string;
  /** With an end, selects the source range [offset, end) instead of a heading. */
  end?: number;
  markdown: string;
  offset: number;
};

const headingPositions = new WeakMap<ProseMirrorNode, number[]>();
const sourceLines = new WeakMap<Editor, { source: string; starts: number[] }>();
function lowerBound(values: number[], target: number) {
  let low = 0, high = values.length;
  while (low < high) { const mid = (low + high) >>> 1; if (values[mid] < target) low = mid + 1; else high = mid; }
  return low;
}
export function markdownLineForTiptapPosition(
  editor: Editor,
  markdown: string,
  position: number,
  headingOffsets = markdownHeadingOffsets(markdown),
) {
  if (editor.isDestroyed) return null;

  const doc = editor.state.doc;
  let positions = headingPositions.get(doc);
  if (!positions) {
    positions = [];
    doc.descendants((node, pos) => { if (node.type.name === "heading") positions!.push(pos); });
    headingPositions.set(doc, positions);
  }
  const precedingHeadings = lowerBound(positions, Math.max(0, position));
  const headingOffset = precedingHeadings ? headingOffsets[precedingHeadings - 1] : 0;
  if (headingOffset === undefined) return null;
  let lines = sourceLines.get(editor);
  if (!lines || lines.source !== markdown) {
    const starts = [0];
    for (let i = 0; i < markdown.length; i++) if (markdown[i] === "\n") starts.push(i + 1);
    lines = { source: markdown, starts };
    sourceLines.set(editor, lines);
  }
  return lowerBound(lines.starts, headingOffset + 1);

}

export function navigateTiptapToMarkdownHeading(editor: Editor, markdown: string, offset: number) {
  if (editor.isDestroyed || !editor.markdown || offset < 0 || offset >= markdown.length) return;

  // Parse the preceding source with the editor's own parser. Counting parsed
  // headings also accounts for setext/nested headings and ignores fenced code.
  // Text matching would select the wrong section when titles are repeated.
  let precedingHeadings = 0;
  function countHeadings(node: JSONContent) {
    if (node.type === "heading") precedingHeadings += 1;
    node.content?.forEach(countHeadings);
  }
  countHeadings(editor.markdown.parse(markdown.slice(0, offset)));

  let target: number | undefined;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading" && precedingHeadings-- === 0) target = pos;
  });
  if (target === undefined) return;

  editor.commands.setTextSelection(target + 1);
  editor.view.dom.focus({ preventScroll: true });
  const element = editor.view.nodeDOM(target);
  if (element instanceof HTMLElement) {
    element.scrollIntoView({ block: "start", inline: "nearest" });
  }
}

/** A citation token becomes its keys, separated by spaces. */
function citationsAsKeys(source: string) {
  if (!source.includes("@")) return source;
  let text = "";
  let last = 0;
  for (const { citation, start, end } of scanCitations(source)) {
    text += `${source.slice(last, start)} ${citation.items.map((item) => item.key).join(" ")} `;
    last = end;
  }
  return last ? text + source.slice(last) : source;
}

/** The plain words a Markdown passage shows once rendered, lower-cased with single spaces. Citations count as their keys. */
export function markdownPassageWords(source: string) {
  return citationsAsKeys(source)
    .replace(/^[ \t]*(#{1,6}[ \t]+|[-*+][ \t]+(\[[ xX]\][ \t]+)?|\d+[.)][ \t]+|[a-z]?>[ \t]?)/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\/?color(=[^\]]*)?\]/g, "")
    .replace(/[a-z]?>>>|<<</g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, " ")
    .replace(/\*\*|__|~~|`|(?<![\p{L}\p{N}])[*_]|[*_](?![\p{L}\p{N}])/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Select a passage given by Markdown source offsets (a Global Search hit): go
 * to its section's heading, then find the passage's first words after it and
 * select that paragraph. Falls back to the heading when the words are not found.
 */
export function revealTiptapMarkdownRange(editor: Editor, markdown: string, start: number, end: number) {
  if (editor.isDestroyed || !editor.markdown) return;

  const doc = editor.state.doc;
  const offsets = markdownHeadingOffsets(markdown);
  const headingOffset = offsets.filter((offset) => offset <= start).at(-1);
  let anchor = 0;
  if (headingOffset !== undefined) {
    navigateTiptapToMarkdownHeading(editor, markdown, headingOffset);
    anchor = editor.state.selection.from;
  }

  // Rendered text after the anchor, lower-cased with single spaces, and the document position of each character.
  let text = "";
  const positions: number[] = [];
  doc.nodesBetween(anchor, doc.content.size, (node, position) => {
    if (node.isText) {
      const value = node.text ?? "";
      for (let index = 0; index < value.length; index += 1) {
        if (position + index < anchor) continue;
        const character = /\s/.test(value[index]) ? " " : value[index].toLowerCase();
        if (character === " " && (!text || text.endsWith(" "))) continue;
        text += character;
        positions.push(position + index);
      }
    } else if (node.isBlock && text && !text.endsWith(" ")) {
      text += " ";
      positions.push(position);
    }
    return true;
  });

  const words = markdownPassageWords(markdown.slice(start, end)).split(" ");
  const candidates = [words.slice(0, 8), words.slice(0, 4), words.slice(2, 6), words.slice(-6)]
    .map((part) => part.join(" ").trim())
    .filter((needle) => needle.length >= 8);
  let from = -1;
  let found = -1;
  for (const needle of candidates) {
    found = text.indexOf(needle);
    if (found >= 0) {
      from = positions[found];
      break;
    }
  }
  if (from < 0) return;

  // Select through the paragraph where the passage ends.
  const tail = words.slice(-5).join(" ");
  const tailIndex = tail.length >= 8 ? text.indexOf(tail, found) : -1;
  const $from = doc.resolve(from);
  const $to = tailIndex >= 0 ? doc.resolve(positions[Math.min(positions.length - 1, tailIndex + tail.length - 1)]) : $from;
  editor.commands.setTextSelection({
    from: $from.parent.isTextblock ? $from.start() : from,
    to: $to.parent.isTextblock ? $to.end() : $to.pos,
  });
  editor.view.dom.focus({ preventScroll: true });
  const { node } = editor.view.domAtPos(from);
  const element = node instanceof HTMLElement ? node : node.parentElement;
  element?.scrollIntoView({ block: "center", inline: "nearest" });
}
