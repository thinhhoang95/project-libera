import assert from "node:assert/strict";
import { test } from "node:test";
import { Editor } from "@tiptap/core";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { smartPasteMarkdown } from "../../src/lib/markdown-smart-paste";
import { smartPasteTiptapMarkdown } from "../../src/lib/tiptap-editor-actions";

const numberedDocument = "# 1. Intro\n\n## 1.1 Scope\n\nText.\n\n# 2. Method\n\n## 2.1 Data\n";
const pasteAt = numberedDocument.indexOf("# 2. Method");

test("smart paste aligns pasted headings and continues the numbering", () => {
  const pasted = "### Results\n\nBody.\n\n#### Detail\n\n";
  const result = smartPasteMarkdown(numberedDocument, { start: pasteAt, end: pasteAt }, pasted);
  assert.equal(
    result?.value,
    "# 1. Intro\n\n## 1.1 Scope\n\nText.\n\n# 2. Results\n\nBody.\n\n## 2.1 Detail\n\n# 3. Method\n\n## 3.1 Data\n",
  );
  assert.equal(result.value.slice(0, result.selection.start).endsWith("## 2.1 Detail\n\n"), true);
});

test("smart paste replaces stale numbers in the pasted text", () => {
  const pasted = "## 7. Results\n### 7.3. Detail\n";
  const result = smartPasteMarkdown(numberedDocument, { start: pasteAt, end: pasteAt }, pasted);
  assert.match(result!.value, /# 2\. Results\n## 2\.1 Detail\n# 3\. Method/);
});

test("smart paste keeps an unnumbered title and numbers from the numbered level", () => {
  const document = "# Report\n\n## 1. Intro\n\n### 1.1. Scope\n";
  const result = smartPasteMarkdown(document, { start: document.length, end: document.length }, "# Next\n## Sub\n");
  assert.equal(result?.value, "# Report\n\n## 1. Intro\n\n### 1.1. Scope\n## 2. Next\n### 2.1. Sub\n");
});

test("smart paste leaves unnumbered documents unnumbered and ignores pastes without headings", () => {
  const document = "## Intro\n\nText.\n";
  assert.equal(smartPasteMarkdown(document, { start: 0, end: 0 }, "Plain text"), null);
  assert.equal(smartPasteMarkdown(document, { start: document.length, end: document.length }, "# Next\n")?.value, "## Intro\n\nText.\n## Next\n");
});

test("smart paste treats headings pasted inside a code fence as code", () => {
  const document = "# 1. Intro\n\n```\n\n```\n";
  const inside = document.indexOf("```\n") + 4;
  assert.equal(smartPasteMarkdown(document, { start: inside, end: inside }, "# not a heading\n"), null);
});

test("visual smart paste aligns levels and continues heading numbering", () => {
  const editor = new Editor({ extensions: createMarkdownExtensions("Notes/a.md"), content: numberedDocument, contentType: "markdown" });
  try {
    let methodPos = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "heading" && node.textContent === "2. Method") methodPos = pos;
    });
    assert.equal(smartPasteTiptapMarkdown(editor, { from: methodPos, to: methodPos }, "### Results\n\n#### Detail\n"), true);
    const headings: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "heading") headings.push(`${node.attrs.level} ${node.textContent}`);
    });
    assert.deepEqual(headings, ["1 1. Intro", "2 1.1 Scope", "1 2. Results", "2 2.1 Detail", "1 3. Method", "2 3.1 Data"]);
    assert.equal(smartPasteTiptapMarkdown(editor, { from: 1, to: 1 }, "Plain"), false);
  } finally {
    editor.destroy();
  }
});
