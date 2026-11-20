import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { createMathExtensions } from "../../src/lib/tiptap-math";
import { documentTables, macroBlockTableWidths, tableColumnWidths, transactionsMayAffectTableWidths } from "../../src/lib/tiptap-table-widths";
import { cellColumnWidths, formatTableWidths, parseTableWidths, readMacroBlockTableWidths, readTableWidths, writeMacroBlockTableWidths } from "../../src/lib/table-widths";
import { findMacroBlocks, parseMacroDefinitions } from "../../src/lib/markdown-macros";
import { readDocumentStyle, writeDocumentStyle } from "../../src/lib/references/document-style";
import { replaceTiptapRangeWithMarkdown } from "../../src/lib/tiptap-editor-actions";
import { setTiptapDocumentStyle } from "../../src/lib/tiptap-front-matter";
import { prepareMarkdownPreview } from "../../src/lib/markdown-preview";
import { MarkdownRenderer } from "../../src/components/markdown-renderer";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "DOMParser", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
after(() => dom.window.close());

const TABLE = "| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |";
const OTHER = "| x | y |\n| --- | --- |\n| 7 | 8 |";
/** A macro block holding `lines`. */
const block = (...lines: string[]) => `\`\`\`libera-macro\n${lines.join("\n")}\n\`\`\``;

function mount(content: string, resizableTables = true) {
  return new Editor({ extensions: [...createMarkdownExtensions("Notes/a.md", { resizableTables }), ...createMathExtensions()], content, contentType: "markdown" });
}

const widthsOf = (editor: Editor) => documentTables(editor.state.doc).map(({ node }) => tableColumnWidths(node));

/** Resize a column as prosemirror-tables' columnResizing does: every cell of the column gets the width, in one transaction. */
function resizeColumn(editor: Editor, tableIndex: number, column: number, width: number) {
  const { node, pos } = documentTables(editor.state.doc)[tableIndex];
  const tr = editor.state.tr;
  node.forEach((row: ProseMirrorNode, rowOffset: number) => {
    let col = 0;
    row.forEach((cell, cellOffset) => {
      const span = cell.attrs.colspan as number;
      if (column >= col && column < col + span) {
        const colwidth = Array.isArray(cell.attrs.colwidth) ? [...cell.attrs.colwidth] : Array(span).fill(0);
        colwidth[column - col] = width;
        tr.setNodeMarkup(pos + 1 + rowOffset + 1 + cellOffset, undefined, { ...cell.attrs, colwidth });
      }
      col += span;
    });
  });
  editor.view.dispatch(tr);
}

/** The Markdown the editor writes for `body`, without widths. */
function canonical(body: string) {
  const editor = mount(body, false);
  try { return editor.getMarkdown().trim(); } finally { editor.destroy(); }
}

/** A document as [its first macro block's text or null, the rest]. */
function split(markdown: string): [string | null, string] {
  const first = findMacroBlocks(markdown)[0];
  if (!first) return [null, markdown.trim()];
  return [markdown.slice(first.contentStart, first.contentEnd).replace(/\n$/, ""), (markdown.slice(0, first.start) + markdown.slice(first.end)).trim()];
}

// ---------------------------------------------------------------------------
// The macro block line
// ---------------------------------------------------------------------------

test("table widths are read from the first macro block that has the line", () => {
  const markdown = `# Notes\n\n${block("\\R = $\\mathbb{R}$")}\n\nText\n\n${block("% !table-widths = [[120, null, 200], [], [80]]")}\n\n${block("% !table-widths = [[1]]")}`;
  assert.deepEqual(readTableWidths(markdown), [[120, null, 200], [], [80]]);
  assert.deepEqual(readTableWidths("% !table-widths = [[100]]\n\nNot in a macro block."), []);
  assert.deepEqual(readTableWidths(`\`\`\`text\n% !table-widths = [[100]]\n\`\`\``), []);
  // Spacing and `:` are tolerated.
  assert.deepEqual(readMacroBlockTableWidths("%!table-widths: [[90]]"), [[90]]);
  assert.equal(readMacroBlockTableWidths("\\R = $x$"), null);
  // Trailing automatic columns and tables go; 0 and nonsense are automatic; widths are rounded and clamped.
  assert.deepEqual(parseTableWidths("[[120.4, 0, null], [5, \"x\", 9000], [null], []]"), [[120], [25, null, 4000]]);
  assert.deepEqual(parseTableWidths("not json"), []);
  assert.equal(formatTableWidths([[120, null], [], [80]]), "[[120, null], [], [80]]");
});

test("the line is a comment to the macro parser: no definition, no problem", () => {
  const definitions = parseMacroDefinitions("\\R = $\\mathbb{R}$\n% !table-widths = [[120, 240]]\n");
  assert.equal(definitions.macros.size, 1);
  assert.deepEqual(definitions.errors, []);
});

test("writing the line changes only that line of the block", () => {
  // Added last, with or without a final line break.
  assert.equal(writeMacroBlockTableWidths("\\R = $x$\n", [[120]]), "\\R = $x$\n% !table-widths = [[120]]\n");
  assert.equal(writeMacroBlockTableWidths("\\R = $x$", [[120]]), "\\R = $x$\n% !table-widths = [[120]]");
  assert.equal(writeMacroBlockTableWidths("", [[120]]), "% !table-widths = [[120]]");
  // Replaced where it is.
  assert.equal(writeMacroBlockTableWidths("% !table-widths = [[1]]\n\\R = $x$", [[null, 50]]), "% !table-widths = [[null, 50]]\n\\R = $x$");
  // Removed with its line break when nothing is set.
  assert.equal(writeMacroBlockTableWidths("\\R = $x$\n% !table-widths = [[1]]\n\\S = y", []), "\\R = $x$\n\\S = y");
  assert.equal(writeMacroBlockTableWidths("\\R = $x$\n% !table-widths = [[1]]", [[null]]), "\\R = $x$");
  assert.equal(writeMacroBlockTableWidths("% !table-widths = [[1]]", []), "");
  // CRLF blocks keep their line breaks.
  assert.equal(writeMacroBlockTableWidths("\\R = $x$\r\n", [[60]]), "\\R = $x$\r\n% !table-widths = [[60]]\r\n");
});

test("citation-style still reads and writes as before on the shared front matter helper", () => {
  assert.equal(readDocumentStyle("---\ntitle: X\ncitation-style: \"apa\"  # x\n---\n"), "apa");
  assert.equal(writeDocumentStyle("Text", "ieee"), "---\ncitation-style: ieee\n---\n\nText");
  assert.equal(writeDocumentStyle("---\ncitation-style: ieee\ntitle: X\n---\nText", null), "---\ntitle: X\n---\nText");
});

test("cell widths follow column and row spans", () => {
  // Row 1: a cell over columns 0–1, then column 2. Row 2: column 0 spans two rows. Row 3: columns 1 and 2 only.
  const shape = [[[2, 1], [1, 1]], [[1, 2], [1, 1], [1, 1]], [[1, 1], [1, 1]]] as const;
  assert.deepEqual(cellColumnWidths(shape as unknown as Array<Array<readonly [number, number]>>, [100, null, 300]), [
    [[100, 0], [300]],
    [[100], null, [300]],
    [null, [300]],
  ]);
});

// ---------------------------------------------------------------------------
// Visual editor
// ---------------------------------------------------------------------------

test("a document's tables take their widths from the macro block and save unchanged", () => {
  const macros = block("\\R = $\\mathbb{R}$", "% !table-widths = [[120, null, 200], [], [90]]");
  const editor = mount(`${macros}\n\n${TABLE}\n\n${OTHER}\n\n${OTHER}`);
  try {
    assert.deepEqual(widthsOf(editor), [[120, null, 200], [null, null], [90, null]]);
    assert.deepEqual(split(editor.getMarkdown()), [macros.split("\n").slice(1, -1).join("\n"), canonical(`${TABLE}\n\n${OTHER}\n\n${OTHER}`)]);
    // setContent reads them the same way.
    editor.commands.setContent(`${block("% !table-widths = [[], [55, 66]]")}\n\n${TABLE}\n\n${OTHER}`, { contentType: "markdown" });
    assert.deepEqual(widthsOf(editor), [[null, null, null], [55, 66]]);
  } finally { editor.destroy(); }
});

test("resizing a column writes the line in the same undo step, adding a macro block when there is none", () => {
  const body = canonical(`# Notes\n\n${TABLE}`);
  const editor = mount(`# Notes\n\n${TABLE}`);
  try {
    resizeColumn(editor, 0, 1, 180);
    assert.match(editor.getMarkdown(), /^```libera-macro\n% !table-widths = \[\[null, 180\]\]\n```\n\n# Notes/);
    assert.deepEqual(split(editor.getMarkdown()), ["% !table-widths = [[null, 180]]", body]);
    resizeColumn(editor, 0, 0, 90);
    assert.deepEqual(split(editor.getMarkdown()), ["% !table-widths = [[90, 180]]", body]);
    editor.commands.undo();
    assert.deepEqual(split(editor.getMarkdown()), ["% !table-widths = [[null, 180]]", body]);
    assert.deepEqual(widthsOf(editor), [[null, 180, null]]);
    editor.commands.undo();
    assert.deepEqual(split(editor.getMarkdown()), [null, body]);
    assert.deepEqual(widthsOf(editor), [[null, null, null]]);
    editor.commands.redo();
    assert.deepEqual(widthsOf(editor), [[null, 180, null]]);
    assert.deepEqual(split(editor.getMarkdown()), ["% !table-widths = [[null, 180]]", body]);
  } finally { editor.destroy(); }
});

test("an existing macro block takes the line, and keeps its definitions when the widths go", () => {
  const editor = mount(`Intro\n\n${block("\\R = $\\mathbb{R}$")}\n\n${TABLE}`);
  try {
    resizeColumn(editor, 0, 2, 300);
    assert.equal(split(editor.getMarkdown())[0], "\\R = $\\mathbb{R}$\n% !table-widths = [[null, null, 300]]");
    assert.equal(findMacroBlocks(editor.getMarkdown()).length, 1);
    const { node, pos } = documentTables(editor.state.doc)[0];
    editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
    assert.equal(split(editor.getMarkdown())[0], "\\R = $\\mathbb{R}$");
  } finally { editor.destroy(); }
});

test("a new macro block goes after the front matter, which is left alone", () => {
  const editor = mount(`---\ncitation-style: ieee\n---\n\n${TABLE}`);
  try {
    resizeColumn(editor, 0, 0, 100);
    assert.match(editor.getMarkdown(), /^---\ncitation-style: ieee\n---\n\n```libera-macro\n% !table-widths = \[\[100\]\]\n```\n\n/);
    setTiptapDocumentStyle(editor, "apa");
    assert.match(editor.getMarkdown(), /^---\ncitation-style: apa\n---\n\n```libera-macro\n% !table-widths = \[\[100\]\]\n```/);
    assert.deepEqual(widthsOf(editor), [[100, null, null]]);
  } finally { editor.destroy(); }
});

test("entries follow their tables when a table is added or deleted", () => {
  const editor = mount(`Intro\n\n${TABLE}`);
  try {
    resizeColumn(editor, 0, 0, 140);
    // A new table above the resized one: after the new macro block and the intro.
    const at = editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize;
    editor.commands.insertContentAt(at, OTHER, { contentType: "markdown" });
    assert.deepEqual(widthsOf(editor), [[null, null], [140, null, null]]);
    assert.equal(split(editor.getMarkdown())[0], "% !table-widths = [[], [140]]");
    // Delete the resized table: nothing is left to keep, so the block it was written into goes.
    const { node, pos } = documentTables(editor.state.doc)[1];
    editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
    assert.equal(split(editor.getMarkdown())[0], null);
  } finally { editor.destroy(); }
});

test("editing the line in the Visual editor's macro block resizes the tables", () => {
  const editor = mount(`${block("% !table-widths = [[100, 200]]")}\n\n${OTHER}`);
  try {
    let found = -1;
    editor.state.doc.descendants((node, pos) => { if (found < 0 && node.isText && node.text!.includes("200")) found = pos + node.text!.indexOf("200"); });
    editor.view.dispatch(editor.state.tr.insertText("250", found, found + 3));
    assert.deepEqual(widthsOf(editor), [[100, 250]]);
    assert.deepEqual(macroBlockTableWidths(editor.state.doc), [[100, 250]]);
  } finally { editor.destroy(); }
});

test("a table rewritten from Markdown keeps its widths while the tables stay the same", () => {
  const editor = mount(`${block("% !table-widths = [[100, 200]]")}\n\n${OTHER}`);
  try {
    const { node, pos } = documentTables(editor.state.doc)[0];
    replaceTiptapRangeWithMarkdown(editor, { from: pos, to: pos + node.nodeSize }, "| x | y |\n| --- | --- |\n| 70 | 80 |");
    assert.deepEqual(widthsOf(editor), [[100, 200]]);
    assert.deepEqual(split(editor.getMarkdown()), ["% !table-widths = [[100, 200]]", canonical("| x | y |\n| --- | --- |\n| 70 | 80 |")]);
  } finally { editor.destroy(); }
});

test("a reload with new widths is applied to the tables without writing the line", () => {
  const editor = mount(`${block("% !table-widths = [[100]]")}\n\n${OTHER}`);
  try {
    editor.commands.setContent(`${block("%  !table-widths   [[300,40]]")}\n\n${OTHER}`, { contentType: "markdown", emitUpdate: false });
    assert.deepEqual(widthsOf(editor), [[300, 40]]);
    // The line keeps the user's spacing.
    assert.equal(split(editor.getMarkdown())[0], "%  !table-widths   [[300,40]]");
  } finally { editor.destroy(); }
});

test("typing in a cell does not look at the tables", () => {
  const editor = mount(OTHER);
  try {
    let pos = 0;
    editor.state.doc.descendants((node, at) => { if (!pos && node.isText && node.text === "7") pos = at + 1; });
    const tr = editor.state.tr.insertText("1", pos);
    assert.equal(transactionsMayAffectTableWidths([tr]), false);
    editor.view.dispatch(tr);
    assert.deepEqual(split(editor.getMarkdown()), [null, canonical("| x | y |\n| --- | --- |\n| 71 | 8 |")]);
  } finally { editor.destroy(); }
});

test("a column that loses its width on undo is drawn automatic again", () => {
  const editor = mount(TABLE);
  try {
    resizeColumn(editor, 0, 0, 119);
    const cols = () => Array.from(editor.view.dom.querySelectorAll("col"), (col) => (col as HTMLElement).style.width);
    assert.deepEqual(cols(), ["119px", "", ""]);
    editor.commands.undo();
    assert.deepEqual(cols(), ["", "", ""]);
  } finally { editor.destroy(); }
});

test("merged-cell tables count as tables and keep their widths in the macro block only", () => {
  const editor = mount(`${TABLE}\n\n${OTHER}`);
  try {
    const { node, pos } = documentTables(editor.state.doc)[0];
    editor.commands.setCellSelection({ anchorCell: pos + 2, headCell: pos + 2 + node.firstChild!.child(0).nodeSize });
    assert.equal(editor.commands.mergeCells(), true);
    resizeColumn(editor, 0, 0, 111);
    resizeColumn(editor, 1, 1, 222);
    const markdown = editor.getMarkdown();
    assert.equal(split(markdown)[0], "% !table-widths = [[111], [null, 222]]");
    assert.match(split(markdown)[1], /^<table/);
    assert.equal(/colwidth/.test(markdown), false);
    const reopened = mount(markdown);
    try { assert.deepEqual(widthsOf(reopened), [[111, null, null], [null, 222]]); } finally { reopened.destroy(); }
  } finally { editor.destroy(); }
});

test("without resizable tables nothing is written", () => {
  const editor = mount(`${block("% !table-widths = [[100]]")}\n\n${OTHER}`, false);
  try {
    resizeColumn(editor, 0, 1, 50);
    assert.equal(split(editor.getMarkdown())[0], "% !table-widths = [[100]]");
  } finally { editor.destroy(); }
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

test("the preview gives each table the widths of its entry, counting HTML tables, and hides the line", () => {
  const content = `${block("\\R = $\\mathbb{R}$", "% !table-widths = [[120, null, 200], [1], [60, 70]]")}\n\n${TABLE}\n\n<table><tr><td>m</td></tr></table>\n\n> ${OTHER.replaceAll("\n", "\n> ")}`;
  const html = renderToStaticMarkup(createElement(MarkdownRenderer, { content, documentPath: "Notes/a.md" }));
  assert.match(html, /<table[^>]*data-col-widths="120,0,200"[^>]*style="table-layout:fixed;min-width:345px"/);
  assert.match(html, /<colgroup><col style="width:120px"\/><col style="min-width:25px"\/><col style="width:200px"\/><\/colgroup>/);
  // The table in the quote is the third: fully set, so exactly that wide.
  assert.match(html, /data-col-widths="60,70"[^>]*style="table-layout:fixed;width:130px"/);
  assert.equal(html.includes("table-widths"), false, "the macro block stays hidden");

  // The worker's prepared tree renders the same.
  const tree = structuredClone(prepareMarkdownPreview(content));
  assert.equal(renderToStaticMarkup(createElement(MarkdownRenderer, { content, documentPath: "Notes/a.md", preparedTree: tree })), html);
});

test("a macro block holding only the line is hidden too", () => {
  const html = renderToStaticMarkup(createElement(MarkdownRenderer, { content: `${block("% !table-widths = [[80]]")}\n\n${OTHER}`, documentPath: "Notes/a.md" }));
  assert.equal(html.includes("table-widths"), false);
  assert.match(html, /data-col-widths="80"/);
});

test("the preview leaves tables alone without widths", () => {
  const html = renderToStaticMarkup(createElement(MarkdownRenderer, { content: `${block("\\R = $x$")}\n\n${TABLE}`, documentPath: "Notes/a.md" }));
  assert.equal(/colgroup|data-col-widths|table-layout/.test(html), false);
});
