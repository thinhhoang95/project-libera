import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import { Mathematics } from "@tiptap/extension-mathematics";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { TiptapReview, sourceRangeForTiptapSelection, tiptapRangeForSource, tiptapReviewBlocks, tiptapReviewKey } from "../../src/lib/tiptap-review";
import { reviewBlocks } from "../../src/lib/markdown-review";
const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "DOMParser", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
after(() => dom.window.close());
test("visual review maps repeated and rich Markdown blocks to exact source ranges without serializing annotations", () => {
  const sources = [
    "# Title\n\nRepeated paragraph.\n\nRepeated paragraph.",
    "Tiếng Việt 😀 with **bold** and [link](https://example.com).\n\n- One\n  - Nested\n\n> Quote\n\n```ts\nconst a = 1;\n```",
    "| A | B |\n| - | - |\n| x | y |\n\n$$x^2$$\n\nMath $y$ here.",
    "First\r\n\r\nSecond\r\n\r\n<div>HTML</div>",
  ];
  for (const source of sources) {
    const editor = new Editor({ extensions: [...createMarkdownExtensions("Notes/a.md"), Mathematics, TiptapReview], content: source, contentType: "markdown" });
    try {
      const before = editor.getMarkdown();
      const mapping = tiptapReviewBlocks(editor, source);
      assert.equal(mapping.length, reviewBlocks(source).length, source);
      assert.ok(mapping.every((b, i) => i === 0 || b.from >= mapping[i - 1].to));
      const mapped = mapping.at(-1)!;
      editor.view.dispatch(editor.state.tr.setMeta(tiptapReviewKey, [{ from: mapped.from + 1, to: mapped.to - 1, kind: "comment" }]));
      assert.equal(editor.getMarkdown(), before);
      assert.ok(editor.view.dom.querySelector(".review-visual-highlight"));
    } finally { editor.destroy(); }
  }
});

test("selecting from a preceding paragraph closing boundary targets only the selected paragraph", () => {
  const source = "First **paragraph**.\n\nSecond paragraph.";
  const editor = new Editor({ extensions: [...createMarkdownExtensions("Notes/a.md"), TiptapReview], content: source, contentType: "markdown" });
  try {
    const mapping = tiptapReviewBlocks(editor, source);
    assert.deepEqual(sourceRangeForTiptapSelection(editor, source, mapping[0].to - 1, mapping[1].to - 1), { start: mapping[1].start, end: mapping[1].end });
  } finally { editor.destroy(); }
});

test("blank paragraphs do not break comments or shift repeated passages to the wrong source range", () => {
  for (const source of [
    "\n\nRepeated paragraph.\n\n\n\nRepeated paragraph.\n\n",
    "# Title\r\n\r\n\r\n\r\nMath $x$ here.\r\n\r\n\r\n\r\nRepeated paragraph.",
  ]) {
    const editor = new Editor({ extensions: [...createMarkdownExtensions("Notes/a.md"), Mathematics, TiptapReview], content: source, contentType: "markdown" });
    try {
      const before = editor.getJSON();
      const expected = reviewBlocks(source);
      const positions: { from: number; to: number }[] = [];
      editor.state.doc.forEach((node, pos) => {
        if (node.content.size) positions.push({ from: pos, to: pos + node.nodeSize });
      });
      assert.equal(positions.length, expected.length);
      expected.forEach((block, index) => {
        const position = positions[index];
        assert.deepEqual(sourceRangeForTiptapSelection(editor, source, position.from + 1, position.to - 1), { start: block.start, end: block.end });
        assert.deepEqual(tiptapRangeForSource(editor, source, block), position);
      });
      assert.deepEqual(editor.getJSON(), before, "mapping must not rewrite the document");
      editor.commands.insertContentAt(positions[0].from + 1, "Edited ");
      const draft = editor.getMarkdown();
      const lastBlock = reviewBlocks(draft).at(-1)!;
      const lastPosition = editor.state.doc.content.size - (source.endsWith("\n\n") ? 2 : 0);
      assert.deepEqual(sourceRangeForTiptapSelection(editor, draft, lastPosition - 2, lastPosition - 1), { start: lastBlock.start, end: lastBlock.end });
    } finally { editor.destroy(); }
  }
});

test("mapping still refuses changed text instead of guessing between repeated passages", () => {
  const source = "Repeated.\n\n\n\nRepeated.";
  const editor = new Editor({ extensions: createMarkdownExtensions("Notes/a.md"), content: source, contentType: "markdown" });
  try {
    editor.commands.insertContentAt(1, "Changed ");
    assert.deepEqual(tiptapReviewBlocks(editor, source), []);
  } finally { editor.destroy(); }
});
