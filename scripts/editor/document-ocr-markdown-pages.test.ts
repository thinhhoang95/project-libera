import assert from "node:assert/strict";
import { test } from "node:test";
import { PICTURE_PLACEHOLDER_PREFIX } from "../../src/lib/document-ocr/doctags";
import {
  applyHeadingLevels,
  extractFigurePlaceholders,
  extractMarkdownHeadings,
  joinMarkdownPages,
  splitMarkdownBlocks,
} from "../../src/lib/document-ocr/markdown-pages";

test("keeps fenced code with blank lines in one block", () => {
  assert.deepEqual(splitMarkdownBlocks("Text\n\n```js\na();\n\nb();\n```\n\nMore"), ["Text", "```js\na();\n\nb();\n```", "More"]);
});

test("joins a paragraph and a hyphenated word cut by the page break, past footnotes", () => {
  const joined = joinMarkdownPages([
    "## 1 Introduction\n\nThe network learns a repre-\n\n[^1-1]: A footnote.",
    "sentation of the input.\n\nA new paragraph.",
  ]);
  assert.equal(joined, "## 1 Introduction\n\nThe network learns a representation of the input.\n\n[^1-1]: A footnote.\n\nA new paragraph.");
});

test("keeps paragraphs apart when the first page ends a sentence and the next starts a heading", () => {
  assert.equal(joinMarkdownPages(["Done.", "# Next"]), "Done.\n\n# Next");
  assert.equal(joinMarkdownPages(["Done.", "New sentence."]), "Done.\n\nNew sentence.");
  assert.equal(joinMarkdownPages(["It continues", "<!-- Page 2 was not read. -->"]), "It continues\n\n<!-- Page 2 was not read. -->");
});

test("continues a table across pages, with or without a repeated header", () => {
  const first = "| A | B |\n| --- | --- |\n| 1 | 2 |";
  assert.equal(joinMarkdownPages([first, "| 3 | 4 |"]), "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");
  assert.equal(joinMarkdownPages([first, "| A | B |\n|---|---|\n| 3 | 4 |"]), "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");
  // A headerless continuation with nothing to join gets a header row.
  assert.equal(joinMarkdownPages(["Text.", "| 3 | 4 |\n| 5 | 6 |"]), "Text.\n\n| 3 | 4 |\n| --- | --- |\n| 5 | 6 |");
});

test("reads and rewrites heading levels in order, outside code", () => {
  const markdown = "# Title\n\n```\n# not a heading\n```\n\n# 1 Introduction\n\n### 1.1 Scope\n\n## Journal of Things";
  assert.deepEqual(extractMarkdownHeadings(markdown, 3).map((heading) => [heading.level, heading.text, heading.page]), [
    [1, "Title", 3], [1, "1 Introduction", 3], [3, "1.1 Scope", 3], [2, "Journal of Things", 3],
  ]);
  assert.equal(
    applyHeadingLevels(markdown, [1, 2, 3, 0]),
    "# Title\n\n```\n# not a heading\n```\n\n## 1 Introduction\n\n### 1.1 Scope\n\nJournal of Things",
  );
});

test("turns figure boxes into picture placeholders and drops unusable ones", () => {
  const { markdown, pictures } = extractFigurePlaceholders(
    "Before.\n\n![Figure 1: The model](figure:0.1, 0.2, 0.5, 0.3)\n\n![Logo](figure:0.9,0.9,0.01,0.01)\n\nAfter.",
  );
  assert.equal(markdown, `Before.\n\n![Figure 1: The model](${PICTURE_PLACEHOLDER_PREFIX}0)\n\n*Logo*\n\nAfter.`);
  assert.deepEqual(pictures, [{ index: 0, caption: "Figure 1: The model", box: { x: 0.1, y: 0.2, width: 0.5, height: 0.3 } }]);
});
