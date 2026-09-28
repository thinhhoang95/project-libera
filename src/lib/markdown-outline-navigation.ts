import type { Editor, JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { markdownHeadingOffsets } from "./markdown-review";

export const MARKDOWN_OUTLINE_NAVIGATE_EVENT = "libera:markdown-outline-navigate";

export type MarkdownOutlineNavigateDetail = {
  documentPath: string;
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
