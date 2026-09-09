import type { Editor, JSONContent } from "@tiptap/core";

export const MARKDOWN_OUTLINE_NAVIGATE_EVENT = "libera:markdown-outline-navigate";

export type MarkdownOutlineNavigateDetail = {
  documentPath: string;
  markdown: string;
  offset: number;
};

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
