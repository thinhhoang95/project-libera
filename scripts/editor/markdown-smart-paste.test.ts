import assert from "node:assert/strict";
import { test } from "node:test";
import { Editor } from "@tiptap/core";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { smartPasteMarkdown } from "../../src/lib/markdown-smart-paste";
import { smartPasteTiptapMarkdown } from "../../src/lib/tiptap-editor-actions";

const document = "# Intro\n\n## Scope\n\nText.\n\n# Method\n\n## Data\n";
const pasteAt = document.indexOf("# Method");

test("a normal smart paste nests the pasted headings under the closest previous heading", () => {
  const pasted = "# Results\n\nBody.\n\n## Detail\n\n";
  const result = smartPasteMarkdown(document, { start: pasteAt, end: pasteAt }, pasted);
  assert.equal(
    result?.value,
    "# Intro\n\n## Scope\n\nText.\n\n### Results\n\nBody.\n\n#### Detail\n\n# Method\n\n## Data\n",
  );
  assert.equal(result.value.slice(0, result.selection.start).endsWith("#### Detail\n\n"), true);
});

test("paste with peer heading level puts the pasted headings beside the closest previous heading", () => {
  const pasted = "#### Results\n##### Detail\n";
  const result = smartPasteMarkdown(document, { start: pasteAt, end: pasteAt }, pasted, "peer");
  assert.equal(result?.value, "# Intro\n\n## Scope\n\nText.\n\n## Results\n### Detail\n# Method\n\n## Data\n");
});

test("smart paste uses level 1 without a previous heading and clamps at level 6", () => {
  assert.equal(smartPasteMarkdown("Text.\n", { start: 6, end: 6 }, "### A\n#### B\n")?.value, "Text.\n# A\n## B\n");
  assert.equal(smartPasteMarkdown("Text.\n", { start: 6, end: 6 }, "### A\n", "peer")?.value, "Text.\n# A\n");
  const deep = "###### Deep\n";
  assert.equal(smartPasteMarkdown(deep, { start: deep.length, end: deep.length }, "# A\n## B\n")?.value, "###### Deep\n###### A\n###### B\n");
});

test("smart paste ignores headings inside the replaced selection and pastes without headings", () => {
  const value = "# A\n\n## B\n\nx";
  const start = value.indexOf("## B");
  // "## B" is replaced, so the closest previous heading is "# A".
  assert.equal(smartPasteMarkdown(value, { start, end: value.length }, "# New\n")?.value, "# A\n\n## New\n");
  assert.equal(smartPasteMarkdown(value, { start: 0, end: 0 }, "Plain text"), null);
});

test("smart paste treats headings pasted inside a code fence as code", () => {
  const value = "# Intro\n\n```\n\n```\n";
  const inside = value.indexOf("```\n") + 4;
  assert.equal(smartPasteMarkdown(value, { start: inside, end: inside }, "# not a heading\n"), null);
});

test("visual smart paste nests or pairs pasted headings with the closest previous heading", () => {
  const headingsOf = (editor: Editor) => {
    const headings: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "heading") headings.push(`${node.attrs.level} ${node.textContent}`);
    });
    return headings;
  };
  const methodPos = (editor: Editor) => {
    let position = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "heading" && node.textContent === "Method") position = pos;
    });
    return position;
  };
  const editor = new Editor({ extensions: createMarkdownExtensions("Notes/a.md"), content: document, contentType: "markdown" });
  try {
    const at = methodPos(editor);
    assert.equal(smartPasteTiptapMarkdown(editor, { from: at, to: at }, "# Results\n\n## Detail\n"), true);
    assert.deepEqual(headingsOf(editor), ["1 Intro", "2 Scope", "3 Results", "4 Detail", "1 Method", "2 Data"]);
    const next = methodPos(editor);
    assert.equal(smartPasteTiptapMarkdown(editor, { from: next, to: next }, "#### Peer\n", "peer"), true);
    assert.deepEqual(headingsOf(editor), ["1 Intro", "2 Scope", "3 Results", "4 Detail", "4 Peer", "1 Method", "2 Data"]);
    assert.equal(smartPasteTiptapMarkdown(editor, { from: 1, to: 1 }, "Plain"), false);
  } finally {
    editor.destroy();
  }
});
