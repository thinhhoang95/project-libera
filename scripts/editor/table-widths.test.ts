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
import { documentTables, tableColumnWidths, transactionsMayAffectTableWidths } from "../../src/lib/tiptap-table-widths";
import { cellColumnWidths, formatTableWidths, parseTableWidths, readTableWidths, writeTableWidths } from "../../src/lib/table-widths";
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

// ---------------------------------------------------------------------------
// The front matter line
// ---------------------------------------------------------------------------

test("table-widths reads, normalizes and writes one front matter line", () => {
  assert.deepEqual(readTableWidths("---\ntable-widths: [[120, null, 200], [], [80]]\n---\n\nText"), [[120, null, 200], [], [80]]);
  // Trailing automatic columns and tables go; 0 and nonsense are automatic; widths are rounded and clamped.
  assert.deepEqual(parseTableWidths("[[120.4, 0, null], [5, \"x\", 9000], [null], []]"), [[120], [25, null, 4000]]);
  assert.deepEqual(parseTableWidths("not json"), []);
  assert.deepEqual(parseTableWidths("[[100]]  # a comment"), [[100]]);
  assert.equal(formatTableWidths([[120, null], [], [80]]), "[[120, null], [], [80]]");

  assert.equal(writeTableWidths("# Title", [[120]]), "---\ntable-widths: [[120]]\n---\n\n# Title");
  assert.equal(writeTableWidths("---\ncitation-style: ieee\n---\n\nText", [[1000, null, 50]]), "---\ncitation-style: ieee\ntable-widths: [[1000, null, 50]]\n---\n\nText");
  // No widths left: the line goes, and front matter that held only it.
  assert.equal(writeTableWidths("---\ntable-widths: [[120]]\n---\n\n# Title", [[null]]), "# Title");
  assert.equal(writeTableWidths("---\ncitation-style: ieee\ntable-widths: [[120]]\n---\nText", []), "---\ncitation-style: ieee\n---\nText");
  // CRLF documents keep their line breaks.
  assert.equal(writeTableWidths("---\r\ntitle: X\r\n---\r\n", [[60]]), "---\r\ntitle: X\r\ntable-widths: [[60]]\r\n---\r\n");
});

test("citation-style still reads and writes as before on the shared front matter helper", () => {
  assert.equal(readDocumentStyle("---\ntable-widths: [[1]]\ncitation-style: \"apa\"  # x\n---\n"), "apa");
  assert.equal(writeDocumentStyle("Text", "ieee"), "---\ncitation-style: ieee\n---\n\nText");
  assert.equal(writeDocumentStyle("---\ncitation-style: ieee\ntable-widths: [[120]]\n---\nText", null), "---\ntable-widths: [[120]]\n---\nText");
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

/** The Markdown the editor writes for `body`, without front matter. */
function canonical(body: string) {
  const editor = mount(body, false);
  try { return editor.getMarkdown().trim(); } finally { editor.destroy(); }
}

/** A document as [front matter source or null, body]. */
function split(markdown: string): [string | null, string] {
  const match = /^---\n[\s\S]*?\n---(?=\n|$)/.exec(markdown);
  return match ? [match[0], markdown.slice(match[0].length).trim()] : [null, markdown.trim()];
}

test("a document's tables take their widths from the front matter and save unchanged", () => {
  const front = "---\ntable-widths: [[120, null, 200], [], [90]]\n---";
  const editor = mount(`${front}\n\n${TABLE}\n\n${OTHER}\n\n${OTHER}`);
  try {
    assert.deepEqual(widthsOf(editor), [[120, null, 200], [null, null], [90, null]]);
    assert.deepEqual(split(editor.getMarkdown()), [front, canonical(`${TABLE}\n\n${OTHER}\n\n${OTHER}`)]);
    // setContent reads them the same way.
    editor.commands.setContent(`---\ntable-widths: [[], [55, 66]]\n---\n\n${TABLE}\n\n${OTHER}`, { contentType: "markdown" });
    assert.deepEqual(widthsOf(editor), [[null, null, null], [55, 66]]);
  } finally { editor.destroy(); }
});

test("resizing a column writes the front matter in the same undo step", () => {
  const body = canonical(`# Notes\n\n${TABLE}`);
  const editor = mount(`# Notes\n\n${TABLE}`);
  try {
    resizeColumn(editor, 0, 1, 180);
    assert.deepEqual(split(editor.getMarkdown()), ["---\ntable-widths: [[null, 180]]\n---", body]);
    resizeColumn(editor, 0, 0, 90);
    assert.deepEqual(split(editor.getMarkdown()), ["---\ntable-widths: [[90, 180]]\n---", body]);
    editor.commands.undo();
    assert.deepEqual(split(editor.getMarkdown()), ["---\ntable-widths: [[null, 180]]\n---", body]);
    assert.deepEqual(widthsOf(editor), [[null, 180, null]]);
    editor.commands.undo();
    assert.deepEqual(split(editor.getMarkdown()), [null, body]);
    assert.deepEqual(widthsOf(editor), [[null, null, null]]);
    editor.commands.redo();
    assert.deepEqual(widthsOf(editor), [[null, 180, null]]);
    assert.deepEqual(split(editor.getMarkdown()), ["---\ntable-widths: [[null, 180]]\n---", body]);
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

test("other front matter keys are kept, and the citation style can still change", () => {
  const editor = mount(`---\ncitation-style: ieee\n---\n\n${TABLE}`);
  try {
    resizeColumn(editor, 0, 2, 300);
    assert.equal(split(editor.getMarkdown())[0], "---\ncitation-style: ieee\ntable-widths: [[null, null, 300]]\n---");
    setTiptapDocumentStyle(editor, "apa");
    assert.equal(split(editor.getMarkdown())[0], "---\ncitation-style: apa\ntable-widths: [[null, null, 300]]\n---");
    assert.deepEqual(widthsOf(editor), [[null, null, 300]]);
  } finally { editor.destroy(); }
});

test("entries follow their tables when a table is added or deleted", () => {
  const editor = mount(`Intro\n\n${TABLE}`);
  try {
    resizeColumn(editor, 0, 0, 140);
    // A new table above the resized one.
    const intro = editor.state.doc.child(1);
    editor.commands.insertContentAt(editor.state.doc.child(0).nodeSize + intro.nodeSize, OTHER, { contentType: "markdown" });
    assert.deepEqual(widthsOf(editor), [[null, null], [140, null, null]]);
    assert.equal(split(editor.getMarkdown())[0], "---\ntable-widths: [[], [140]]\n---");
    // Delete the resized table: nothing is left to keep.
    const { node, pos } = documentTables(editor.state.doc)[1];
    editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
    assert.equal(split(editor.getMarkdown())[0], null);
  } finally { editor.destroy(); }
});

test("a table rewritten from Markdown keeps its widths while the tables stay the same", () => {
  const editor = mount(`---\ntable-widths: [[100, 200]]\n---\n\n${OTHER}`);
  try {
    const { node, pos } = documentTables(editor.state.doc)[0];
    replaceTiptapRangeWithMarkdown(editor, { from: pos, to: pos + node.nodeSize }, "| x | y |\n| --- | --- |\n| 70 | 80 |");
    assert.deepEqual(widthsOf(editor), [[100, 200]]);
    assert.deepEqual(split(editor.getMarkdown()), ["---\ntable-widths: [[100, 200]]\n---", canonical("| x | y |\n| --- | --- |\n| 70 | 80 |")]);
  } finally { editor.destroy(); }
});

test("a reload with new widths is applied to the tables without writing the front matter", () => {
  const editor = mount(`---\ntable-widths: [[100]]\n---\n\n${OTHER}`);
  try {
    editor.commands.setContent(`---\ntable-widths:   [[300,40]]\n---\n\n${OTHER}`, { contentType: "markdown", emitUpdate: false });
    assert.deepEqual(widthsOf(editor), [[300, 40]]);
    // The line keeps the user's spacing.
    assert.equal(split(editor.getMarkdown())[0], "---\ntable-widths:   [[300,40]]\n---");
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

test("merged-cell tables count as tables and keep their widths in the front matter only", () => {
  const editor = mount(`${TABLE}\n\n${OTHER}`);
  try {
    const { node, pos } = documentTables(editor.state.doc)[0];
    editor.commands.setCellSelection({ anchorCell: pos + 2, headCell: pos + 2 + node.firstChild!.child(0).nodeSize });
    assert.equal(editor.commands.mergeCells(), true);
    resizeColumn(editor, 0, 0, 111);
    resizeColumn(editor, 1, 1, 222);
    const markdown = editor.getMarkdown();
    assert.equal(split(markdown)[0], "---\ntable-widths: [[111], [null, 222]]\n---");
    assert.match(split(markdown)[1], /^<table/);
    assert.equal(/colwidth/.test(markdown), false);
    const reopened = mount(markdown);
    try { assert.deepEqual(widthsOf(reopened), [[111, null, null], [null, 222]]); } finally { reopened.destroy(); }
  } finally { editor.destroy(); }
});

test("without resizable tables nothing is written", () => {
  const editor = mount(`---\ntable-widths: [[100]]\n---\n\n${OTHER}`, false);
  try {
    resizeColumn(editor, 0, 1, 50);
    assert.equal(split(editor.getMarkdown())[0], "---\ntable-widths: [[100]]\n---");
  } finally { editor.destroy(); }
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

test("the preview gives each table the widths of its entry, counting HTML tables", () => {
  const content = `---\ntable-widths: [[120, null, 200], [1], [60, 70]]\n---\n\n${TABLE}\n\n<table><tr><td>m</td></tr></table>\n\n> ${OTHER.replaceAll("\n", "\n> ")}`;
  const html = renderToStaticMarkup(createElement(MarkdownRenderer, { content, documentPath: "Notes/a.md" }));
  assert.match(html, /<table[^>]*data-col-widths="120,0,200"[^>]*style="table-layout:fixed;min-width:345px"/);
  assert.match(html, /<colgroup><col style="width:120px"\/><col style="min-width:25px"\/><col style="width:200px"\/><\/colgroup>/);
  // The table in the quote is the third: fully set, so exactly that wide.
  assert.match(html, /data-col-widths="60,70"[^>]*style="table-layout:fixed;width:130px"/);
  assert.equal(html.includes("table-widths"), false, "front matter stays hidden");

  // The worker's prepared tree renders the same.
  const tree = structuredClone(prepareMarkdownPreview(content));
  assert.equal(renderToStaticMarkup(createElement(MarkdownRenderer, { content, documentPath: "Notes/a.md", preparedTree: tree })), html);
});

test("the preview leaves tables alone without widths", () => {
  const html = renderToStaticMarkup(createElement(MarkdownRenderer, { content: `---\ntitle: X\n---\n\n${TABLE}`, documentPath: "Notes/a.md" }));
  assert.equal(/colgroup|data-col-widths|table-layout/.test(html), false);
});
