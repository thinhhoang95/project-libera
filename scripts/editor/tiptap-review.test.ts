import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import { Mathematics } from "@tiptap/extension-mathematics";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { TiptapReview, sourceRangeForTiptapSelection, sourceRangeForTiptapTextSelection, tiptapRangeForSource, tiptapReviewBlocks, tiptapReviewKey, tiptapSelectionForSourceRange } from "../../src/lib/tiptap-review";
import { reviewBlocks } from "../../src/lib/markdown-review";
import { markdownLineForTiptapPosition } from "../../src/lib/markdown-outline-navigation";
const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "DOMParser", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
after(() => dom.window.close());

test("visual positions map to the corresponding Markdown heading line", () => {
  const source = "# First\n\nIntro\n\n> ## Nested\n> Body\n\nSetext\n------\n\n## Last\n\nEnd";
  const editor = new Editor({ extensions: createMarkdownExtensions("Notes/a.md"), content: source, contentType: "markdown" });
  try {
    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "heading") positions.push(pos + 1);
    });
    assert.deepEqual(
      positions.map((position) => markdownLineForTiptapPosition(editor, source, position)),
      [1, 5, 8, 11],
    );
    assert.equal(markdownLineForTiptapPosition(editor, source, editor.state.doc.content.size), 11);
  } finally {
    editor.destroy();
  }
});

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

test("review mapping tolerates live whitespace/mark normalization without rebuilding the editor", () => {
  const edits: ((editor: Editor) => void)[] = [
    (editor) => { editor.commands.insertContentAt(1, " "); },
    (editor) => { editor.chain().setTextSelection({ from: 1, to: 7 }).toggleBold().run(); },
    (editor) => { editor.chain().setTextSelection(6).splitBlock().run(); },
  ];
  for (const edit of edits) {
    const editor = new Editor({ extensions: createMarkdownExtensions("Notes/a.md"), content: "Hello there\n\nSecond paragraph", contentType: "markdown" });
    try {
      edit(editor);
      const source = editor.getMarkdown();
      const before = editor.getJSON(), selection = editor.state.selection;
      const blocks = reviewBlocks(source);
      const mapped = tiptapReviewBlocks(editor, source);
      assert.equal(mapped.length, blocks.length, source);
      for (const block of mapped) {
        assert.deepEqual(sourceRangeForTiptapSelection(editor, source, block.from + 1, block.to - 1), { start: block.start, end: block.end });
        assert.deepEqual(tiptapRangeForSource(editor, source, block), { from: block.from, to: block.to });
      }
      assert.deepEqual(editor.getJSON(), before);
      assert.equal(editor.state.selection, selection);
    } finally { editor.destroy(); }
  }
});

test("comments reuse block mappings and invalidate them on content/source changes", () => {
  const editor = new Editor({ extensions: [...createMarkdownExtensions("Notes/a.md"), TiptapReview], content: "Hello\n\nRepeated\n\nRepeated", contentType: "markdown" });
  try {
    const source = editor.getMarkdown();
    const mapping = tiptapReviewBlocks(editor, source);
    editor.view.dispatch(editor.state.tr.setMeta(tiptapReviewKey, [{ from: 1, to: 6, kind: "comment" }]));
    assert.equal(tiptapReviewBlocks(editor, source), mapping);
    editor.commands.insertContentAt(1, "Changed ");
    assert.deepEqual(tiptapReviewBlocks(editor, source), []);
    const updated = tiptapReviewBlocks(editor, editor.getMarkdown());
    assert.equal(updated.length, 3);
    assert.notEqual(updated, mapping);
  } finally { editor.destroy(); }
});

test("a highlighted passage maps to exactly its text, never its whole table, list or paragraph", () => {
  // The rendered text with each character's position; inline nodes without text are "\uFFFC".
  const live = (editor: Editor) => {
    let text = "";
    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.isBlock && text && !text.endsWith(" ")) { text += " "; positions.push(-1); }
      if (node.isText) for (let index = 0; index < node.text!.length; index++) { text += node.text![index]; positions.push(pos + index); }
      else if (node.isInline && node.isLeaf) { text += "\uFFFC"; positions.push(pos); }
    });
    return { text, positions };
  };
  const cases: [string, string, string][] = [
    ["| A | B |\n|---|---|\n| one | two |\n| three | four |", "two three", "two |\n| three"],
    ["| A | B |\n|---|---|\n| x = 1 | two |", "x = 1", "x = 1"],
    ["| A | B |\n|---|---|\n| [x](y) z | two |", "x z", "x](y) z"],
    ["- [ ] one item\n- [x] two item\n", "one item two", "one item\n- [x] two"],
    ["- top\n  - inner one\n  - inner two\n", "inner two", "inner two"],
    ["Call my_function with x = 5 * 3 or ~5.\n", "my_function with x = 5 * 3 or ~5", "my_function with x = 5 * 3 or ~5"],
    ["See [the docs](https://example.com/a/long/path) for more.\n", "docs for more", "docs](https://example.com/a/long/path) for more"],
    ["Tom &amp; Jerry are here.\n", "Tom & Jerry", "Tom &amp; Jerry"],
    ["Some **bold _and_ italic** text.\n", "bold and italic", "bold _and_ italic"],
    ["Energy $E=mc^2$ is famous.\n", "\uFFFC", "$E=mc^2$"],
  ];
  for (const [source, selected, quote] of cases) {
    const editor = new Editor({ extensions: [...createMarkdownExtensions("Notes/a.md"), Mathematics, TiptapReview], content: source, contentType: "markdown" });
    try {
      const { text, positions } = live(editor);
      const index = text.indexOf(selected);
      assert.ok(index >= 0, `${selected} in ${text}`);
      const from = positions[index], to = positions[index + selected.length - 1] + 1;
      const range = sourceRangeForTiptapTextSelection(editor, source, from, to);
      assert.equal(source.slice(range!.start, range!.end), quote, source);
      assert.deepEqual(tiptapSelectionForSourceRange(editor, source, range!), { from, to }, source);
    } finally { editor.destroy(); }
  }
});

test("a comment anchored on one list item or table row highlights only that item or row", () => {
  const source = "- one\n- two\n- three\n\n| A | B |\n|---|---|\n| x | y |\n| z | w |";
  const editor = new Editor({ extensions: [...createMarkdownExtensions("Notes/a.md"), TiptapReview], content: source, contentType: "markdown" });
  try {
    const item = source.indexOf("- two"), row = source.indexOf("| z");
    const itemRange = tiptapSelectionForSourceRange(editor, source, { start: item, end: item + "- two".length })!;
    assert.equal(editor.state.doc.textBetween(itemRange.from, itemRange.to, " "), "two");
    const rowRange = tiptapSelectionForSourceRange(editor, source, { start: row, end: row + "| z | w |".length })!;
    assert.equal(editor.state.doc.textBetween(rowRange.from, rowRange.to, " "), "z w");
  } finally { editor.destroy(); }
});

test("visual selections keep mapping to Markdown while blocks are mid-edit", () => {
  const base = "# Title\n\nFirst paragraph here.\n\n- one\n- two\n\nLast paragraph.";
  const at = (editor: Editor, text: string, offset = 0) => { let found = -1; editor.state.doc.descendants((node, pos) => { if (found < 0 && node.isTextblock && node.textContent.includes(text)) found = pos + 1 + node.textContent.indexOf(text) + offset; }); return found; };
  const newBlock = (editor: Editor) => { editor.commands.setTextSelection(at(editor, "here.", 5)); editor.commands.splitBlock(); };
  const edits: [string, (editor: Editor) => void][] = [
    ["whitespace paragraph", (e) => { newBlock(e); e.commands.insertContent(" "); }],
    ["empty heading", (e) => { newBlock(e); e.commands.toggleHeading({ level: 2 }); }],
    ["heading of spaces", (e) => { newBlock(e); e.commands.toggleHeading({ level: 2 }); e.commands.insertContent("  "); }],
    ["empty blockquote", (e) => { newBlock(e); e.commands.toggleBlockquote(); }],
    ["empty list item joined to a list", (e) => { newBlock(e); e.commands.toggleBulletList(); }],
    ["leading space", (e) => { e.commands.setTextSelection(at(e, "First")); e.commands.insertContent(" "); }],
  ];
  for (const [name, edit] of edits) {
    const editor = new Editor({ extensions: [...createMarkdownExtensions("Notes/a.md"), TiptapReview], content: base, contentType: "markdown" });
    try {
      edit(editor);
      const source = editor.getMarkdown();
      const before = editor.state.doc;
      for (const word of ["paragraph", "Last", "two", "Title"]) {
        const from = at(editor, word);
        const range = sourceRangeForTiptapTextSelection(editor, source, from, from + word.length);
        assert.equal(range && source.slice(range.start, range.end), word, `${name}: ${word}`);
      }
      assert.equal(editor.state.doc, before, `${name}: the live document is left untouched`);
    } finally { editor.destroy(); }
  }
});

test("a comment on highlighted text that starts with the color letter takes the text, not the delimiter", () => {
  const editor = new Editor({ extensions: [...createMarkdownExtensions("Notes/a.md"), TiptapReview], content: "# T\n\nyou say yes here.\n\nEnd.", contentType: "markdown" });
  try {
    let from = -1, to = -1;
    editor.state.doc.descendants((node, pos) => { if (from < 0 && node.type.name === "paragraph") { from = pos + 1; to = pos + 1 + node.content.size; } });
    editor.chain().setTextSelection({ from, to }).toggleHighlight({ color: "#fef08a" }).run();
    const source = editor.getMarkdown();
    assert.match(source, /y>>>you say yes here\.<<</);
    for (const [start, end, text] of [[from, to, "you say yes here."], [from, from + 3, "you"]] as const) {
      const range = sourceRangeForTiptapTextSelection(editor, source, start, end);
      assert.equal(range && source.slice(range.start, range.end), text);
    }
  } finally { editor.destroy(); }
});
