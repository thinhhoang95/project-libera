import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import { Mathematics } from "@tiptap/extension-mathematics";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { TiptapReview, sourceRangeForTiptapSelection, tiptapReviewBlocks, tiptapReviewKey } from "../../src/lib/tiptap-review";
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
