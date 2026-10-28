import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { Editor } from "@tiptap/core";
import { ySyncAnnotation } from "y-codemirror.next";
import {
  applyTextChanges,
  detectMarkdownHeadingNumbering,
  getMarkdownHeadingNumberingChanges,
  getMarkdownHeadingNumberRemovalChanges,
  getStructuralHeadingNumbers,
  mapOffsetThroughTextChanges,
} from "../../src/lib/markdown-heading-numbering";
import { headingNumberingTransactions, headingNumberingSpec } from "../../src/lib/markdown-codemirror/heading-numbering";
import { markdownValueSync } from "../../src/lib/markdown-codemirror/value-sync";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { setTiptapHeadingNumbering, TiptapHeadingNumbering } from "../../src/lib/tiptap-heading-numbering";
import { numberTiptapHeadings, removeTiptapHeadingNumbers } from "../../src/lib/tiptap-editor-actions";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "getComputedStyle"] as const) {
  Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
}

const renumber = (value: string, skipTitle = true) =>
  applyTextChanges(value, getMarkdownHeadingNumberingChanges(value, { skipTitle }));

test("structural numbers start at the highest level and can skip the title", () => {
  const headings = [1, 2, 3, 2, 1].map((level) => ({ level, text: "" }));
  assert.deepEqual(getStructuralHeadingNumbers(headings, { skipTitle: false }), ["1.", "1.1", "1.1.1", "1.2", "2."]);
  // The title is skipped; the later level-1 heading keeps level 1 the base.
  assert.deepEqual(getStructuralHeadingNumbers(headings, { skipTitle: true }), [null, "1.1", "1.1.1", "1.2", "2."]);
  assert.deepEqual(getStructuralHeadingNumbers([1, 2, 3, 2].map((level) => ({ level, text: "" })), { skipTitle: true }), [null, "1.", "1.1", "2."]);
  // Only a title: nothing is numbered.
  assert.deepEqual(getStructuralHeadingNumbers([{ level: 1, text: "" }], { skipTitle: true }), [null]);
  // The document's multi-part style ("1.1.") is kept.
  assert.deepEqual(
    getStructuralHeadingNumbers([{ level: 1, text: "1. A" }, { level: 2, text: "1.1. B" }, { level: 2, text: "C" }], { skipTitle: false }),
    ["1.", "1.1.", "1.2."],
  );
});

test("renumbering source text fixes numbers, strips the title's and skips code", () => {
  const value = "# 1. Report\n\n## Intro\n\n```\n## code\n```\n\n### 7. Scope\n\n## 9 Method\n";
  assert.equal(renumber(value), "# Report\n\n## 1. Intro\n\n```\n## code\n```\n\n### 1.1 Scope\n\n## 2. 9 Method\n");
  assert.equal(renumber(value, false), "# 1. Report\n\n## 1.1 Intro\n\n```\n## code\n```\n\n### 1.1.1 Scope\n\n## 1.2 9 Method\n");
  assert.equal(renumber(renumber(value)), renumber(value), "idempotent");
  // Bare markers are not a heading yet: the user may still type more `#`.
  assert.equal(renumber("# T\n\n##"), "# T\n\n##");
  const removal = "# 1. A\n\n## 1.1 B\n\n## C";
  assert.equal(applyTextChanges(removal, getMarkdownHeadingNumberRemovalChanges(removal)), "# A\n\n## B\n\n## C");
});

test("typing a heading marker numbers it and puts the caret after the number", () => {
  const value = "# Title\n\n## 1. Intro\n\n## ";
  const changes = getMarkdownHeadingNumberingChanges(value, { skipTitle: true });
  const next = applyTextChanges(value, changes);
  assert.equal(next, "# Title\n\n## 1. Intro\n\n## 2. ");
  assert.equal(mapOffsetThroughTextChanges(value.length, changes), next.length);
});

test("after a deletion, the number holding the caret is left for the user to clear", () => {
  const value = "# T\n\n## 1. A\n\n## 2.";
  assert.deepEqual(getMarkdownHeadingNumberingChanges(value, { skipTitle: true }, value.length), []);
  assert.equal(getMarkdownHeadingNumberingChanges(value, { skipTitle: true }).length, 1);
});

test("documents count as numbered when every heading but the title is", () => {
  assert.equal(detectMarkdownHeadingNumbering("# Title\n\n## 1. A\n\n## 2. B"), true);
  assert.equal(detectMarkdownHeadingNumbering("# 1. A\n\n# 2. B"), true);
  assert.equal(detectMarkdownHeadingNumbering("## 1. Install\n\n## Usage"), false);
  assert.equal(detectMarkdownHeadingNumbering("Text only"), false);
  assert.equal(detectMarkdownHeadingNumbering(""), null);
});

test("CodeMirror appends renumbering after local edits, but leaves history and outside text alone", () => {
  let enabled = true;
  const start = EditorState.create({ doc: "# Title\n\n## 1. A\n\n" });
  const update = (spec: TransactionSpec) => headingNumberingTransactions([start.update(spec)], { enabled, skipTitle: true });
  const end = start.doc.length;
  const transactions = update({ changes: { from: end, insert: "## " }, selection: EditorSelection.cursor(end + 3), userEvent: "input.type" });
  assert.equal(transactions.length, 2, "the edit and renumbering are separate transactions");
  const typed = transactions.at(-1)!.state;
  assert.equal(typed.doc.toString(), "# Title\n\n## 1. A\n\n## 2. ");
  assert.equal(typed.selection.main.head, typed.doc.length);

  const insertAt = start.doc.toString().indexOf("## 1. A");
  const insertion = { changes: { from: insertAt, insert: "## New\n\n" }, userEvent: "input.paste" };
  assert.equal(update(insertion).at(-1)!.newDoc.toString(), "# Title\n\n## 1. New\n\n## 2. A\n\n");
  for (const patch of [
    { userEvent: "undo" }, { userEvent: "redo" },
    { annotations: ySyncAnnotation.of({} as never) },
    { annotations: markdownValueSync.of("value") }, { annotations: markdownValueSync.of("review") },
  ]) {
    const result = update({ ...insertion, ...patch });
    assert.equal(result.length, 1);
    assert.equal(result[0].newDoc.toString(), "# Title\n\n## New\n\n## 1. A\n\n");
  }

  enabled = false;
  assert.equal(update(insertion).at(-1)!.newDoc.toString(), "# Title\n\n## New\n\n## 1. A\n\n");
  const spec = headingNumberingSpec(EditorState.create({ doc: "# T\n\n## A" }), { enabled: true, skipTitle: true });
  assert.deepEqual(spec?.changes, [{ from: 8, insert: "1. ", to: 8 }]);
});

test("the Visual editor numbers new headings while numbering is on", () => {
  const editor = new Editor({
    // Mounted: an editor without an element installs no ProseMirror plugins.
    element: document.createElement("div"),
    extensions: [...createMarkdownExtensions("Notes/a.md"), TiptapHeadingNumbering],
    content: "# Title\n\n## 1. Intro",
    contentType: "markdown",
  });
  try {
    setTiptapHeadingNumbering(editor, { enabled: true, skipTitle: true }, false);
    assert.equal(editor.getMarkdown(), "# Title\n\n## 1. Intro");
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Next" }] });
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Sub" }] });
    assert.equal(editor.getMarkdown(), "# Title\n\n## 1. Intro\n\n## 2. Next\n\n### 2.1 Sub");
    // Undo never stops at an unnumbered heading: the number is part of the edit.
    editor.commands.undo();
    assert.equal(editor.getMarkdown(), "# Title\n\n## 1. Intro");
    editor.commands.redo();
    assert.equal(editor.getMarkdown(), "# Title\n\n## 1. Intro\n\n## 2. Next\n\n### 2.1 Sub");
    setTiptapHeadingNumbering(editor, { enabled: false, skipTitle: true }, false);
    removeTiptapHeadingNumbers(editor);
    assert.equal(editor.getMarkdown(), "# Title\n\n## Intro\n\n## Next\n\n### Sub");
    numberTiptapHeadings(editor, { skipTitle: false });
    assert.equal(editor.getMarkdown(), "# 1. Title\n\n## 1.1 Intro\n\n## 1.2 Next\n\n### 1.2.1 Sub");
    // Switching numbering on renumbers at once.
    setTiptapHeadingNumbering(editor, { enabled: true, skipTitle: true }, true);
    assert.equal(editor.getMarkdown(), "# Title\n\n## 1. Intro\n\n## 2. Next\n\n### 2.1 Sub");
  } finally {
    editor.destroy();
  }
});
