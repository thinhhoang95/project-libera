import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { history, undo } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { preambleOpenField, setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* The rule: a rendered widget always gives a way to edit its raw source. The title block draws commands that are usually
 * written in the (folded) preamble, so "Edit source" must unfold the preamble and put the cursor at the first of them;
 * an author can be added from the block; keywords and the like are clickable. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function visualState(doc: string, extra: Extension[] = []) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [history(), latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }), ...extra] });
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

function mount(doc: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return view;
}

const press = (target: Element, key: string) => target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
const typeInto = (area: HTMLTextAreaElement, value: string) => { area.value = value; area.dispatchEvent(new window.Event("input", { bubbles: true })); };
const mouse = (node: Element, init: Record<string, unknown> = {}) => node.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init }));
const part = (view: EditorView, name: string, index = 0) => view.contentDOM.querySelector<HTMLElement>(`.cm-vis-title-block [data-title-part="${name}"][data-title-index="${index}"]`)!;
const notes = (view: EditorView) => [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-title-block [data-title-note]")];
const editor = (view: EditorView) => view.contentDOM.querySelector<HTMLTextAreaElement>(".cm-vis-title-editor");
const sourceButton = (view: EditorView) => view.contentDOM.querySelector<HTMLButtonElement>(".cm-vis-title-block .cm-vis-title-source");
const addButton = (view: EditorView) => view.contentDOM.querySelector<HTMLButtonElement>(".cm-vis-title-block .cm-vis-title-add-author");

const BODY = "\nText.\n\\end{document}";
const PREAMBLE_TITLE = String.raw`\documentclass{article}
\title{A Title}
\author{Alice One\thanks{Funded.} \and Bob Two}
\date{June 2025}
\keywords{alpha, beta}
\begin{document}
\maketitle` + BODY;

test("the title block has an Edit source action: it unfolds the preamble and puts the cursor at the first command of the block", () => {
  const view = mount(PREAMBLE_TITLE);
  assert.equal(view.state.field(preambleOpenField), false, "the preamble starts folded");
  const button = sourceButton(view);
  assert.ok(button, "a discoverable Edit source button");
  button.click();
  assert.equal(view.state.field(preambleOpenField), true, "the preamble is unfolded");
  const titleAt = PREAMBLE_TITLE.indexOf("\\title{");
  const head = view.state.selection.main.head;
  assert.ok(head >= titleAt && head <= titleAt + "\\title{A Title}".length, `the cursor is in \\title{…} (at ${head}, \\title at ${titleAt})`);
  assert.match(view.contentDOM.textContent ?? "", /\\title\{A Title\}/);
  assert.match(view.contentDOM.textContent ?? "", /\\author\{Alice One\\thanks\{Funded\.\} \\and Bob Two\}/);
  // The block is still drawn at \maketitle, and the source can be edited there.
  assert.ok(view.contentDOM.querySelector(".cm-vis-title-block"));
  view.dispatch({ changes: { from: titleAt + "\\title{".length, insert: "New " }, selection: { anchor: titleAt + 7 } });
  assert.equal(part(view, "title").textContent, "New A Title");
  view.destroy();
});

test("Alt-click on a part reveals the whole block's real source too, not just the \\maketitle line", () => {
  const view = mount(PREAMBLE_TITLE);
  mouse(part(view, "date"), { altKey: true });
  assert.equal(view.state.field(preambleOpenField), true);
  assert.equal(view.state.selection.main.head, PREAMBLE_TITLE.indexOf("\\title{"));
  view.destroy();
});

test("title declarations written in the body: Edit source shows the folded block's source with the cursor in its first command", () => {
  const doc = "\\documentclass{article}\n\\begin{document}\n\\title{Body Title}\n\\author{Carol}\n\\maketitle" + BODY;
  const view = mount(doc);
  assert.equal(view.contentDOM.textContent?.includes("\\title{Body Title}"), false);
  sourceButton(view)!.click();
  const head = view.state.selection.main.head;
  assert.ok(head > doc.indexOf("\\title") && head < doc.indexOf("\\maketitle"), "the cursor is inside the block's source");
  assert.match(view.contentDOM.textContent ?? "", /\\title\{Body Title\}/);
  assert.match(view.contentDOM.textContent ?? "", /\\maketitle/);
  // Leaving it draws the block again.
  view.dispatch({ selection: { anchor: doc.length } });
  assert.ok(view.contentDOM.querySelector(".cm-vis-title-block"));
  assert.equal(part(view, "title").textContent, "Body Title");
  view.destroy();
});

test("add author: a control on the author line appends \\and and a new author as one undo step; Escape and empty text write nothing", () => {
  const view = mount(PREAMBLE_TITLE);
  const add = addButton(view);
  assert.ok(add, "an add-author control");
  add.click();
  let area = editor(view)!;
  assert.ok(area, "the new author's field is open");
  assert.equal(area.value, "");
  typeInto(area, "Carol Three");
  press(area, "Enter");
  const wanted = PREAMBLE_TITLE.replace("Bob Two}", "Bob Two \\and Carol Three}");
  assert.equal(view.state.doc.toString(), wanted);
  assert.equal(view.contentDOM.querySelectorAll('.cm-vis-title-block [data-title-part="author"]').length, 3);
  undo(view);
  assert.equal(view.state.doc.toString(), PREAMBLE_TITLE);
  // Escape, and an empty field: nothing is written.
  addButton(view)!.click();
  area = editor(view)!;
  typeInto(area, "Dave");
  press(area, "Escape");
  assert.equal(view.state.doc.toString(), PREAMBLE_TITLE);
  assert.equal(editor(view), null);
  addButton(view)!.click();
  press(editor(view)!, "Enter");
  assert.equal(view.state.doc.toString(), PREAMBLE_TITLE);
  view.destroy();
});

test("add author is offered only where \\and separates the authors (not acmart, where each \\author is one)", () => {
  const acm = String.raw`\documentclass{acmart}
\title{T}
\author{A}
\affiliation{X}
\begin{document}
\maketitle` + BODY;
  const view = mount(acm);
  assert.equal(addButton(view)?.hidden ?? true, true);
  view.destroy();
});

test("keywords under the title are clickable: one \\keywords is edited in place; several \\ccsdesc show their source", () => {
  const view = mount(PREAMBLE_TITLE);
  const [keywords] = notes(view);
  assert.match(keywords.textContent ?? "", /Keywords: alpha, beta/);
  mouse(keywords);
  const area = editor(view)!;
  assert.equal(area.value, "alpha, beta");
  typeInto(area, "alpha, beta, gamma");
  press(area, "Enter");
  assert.equal(view.state.doc.toString(), PREAMBLE_TITLE.replace("alpha, beta}", "alpha, beta, gamma}"));
  assert.match(notes(view)[0].textContent ?? "", /alpha, beta, gamma/);
  view.destroy();
  const ccs = String.raw`\documentclass{acmart}
\title{T}
\author{A}
\ccsdesc[500]{Theory~of~computation}
\ccsdesc[300]{Software}
\begin{document}
\maketitle` + BODY;
  const second = mount(ccs);
  mouse(notes(second)[0]);
  assert.equal(editor(second), null, "two commands make one line: not edited as one field");
  assert.equal(second.state.field(preambleOpenField), true);
  assert.equal(second.state.selection.main.head, ccs.indexOf("\\title"), "the cursor goes to the first command of the block");
  assert.match(second.contentDOM.textContent ?? "", /\\ccsdesc\[500\]\{Theory~of~computation\}/);
  second.destroy();
});

test("Alt+Enter on the selected title block shows its source in the preamble too", () => {
  const view = mount(PREAMBLE_TITLE);
  const at = PREAMBLE_TITLE.indexOf("\\maketitle");
  view.dispatch({ selection: EditorSelection.range(at, at + "\\maketitle".length) });
  assert.ok(runScopeHandlers(view, new window.KeyboardEvent("keydown", { key: "Enter", altKey: true }), "editor"));
  assert.equal(view.state.field(preambleOpenField), true);
  assert.equal(view.state.selection.main.head, PREAMBLE_TITLE.indexOf("\\title{"));
  view.destroy();
});

test("ICML's title block, written inside \\twocolumn[…], shows all of its source from the button", () => {
  const doc = String.raw`\documentclass{article}
\usepackage{icml2025}
\begin{document}
\twocolumn[
\icmltitle{An ICML Title}
\begin{icmlauthorlist}
\icmlauthor{Alice One}{a}
\end{icmlauthorlist}
\icmlaffiliation{a}{University A}
]
Text.
\end{document}`;
  const view = mount(doc);
  assert.equal(view.contentDOM.textContent?.includes("\\icmlaffiliation"), false);
  sourceButton(view)!.click();
  assert.match(view.contentDOM.textContent ?? "", /\\icmlaffiliation\{a\}\{University A\}/);
  assert.match(view.contentDOM.textContent ?? "", /\\icmltitle\{An ICML Title\}/);
  view.destroy();
});

test("click-to-edit a part still works with the new affordances present", () => {
  const view = mount(PREAMBLE_TITLE);
  mouse(part(view, "title"));
  const area = editor(view)!;
  assert.equal(area.value, "A Title");
  typeInto(area, "Another Title");
  press(area, "Enter");
  assert.equal(view.state.doc.toString(), PREAMBLE_TITLE.replace("A Title", "Another Title"));
  assert.equal(view.state.field(preambleOpenField), false, "editing a part leaves the preamble folded");
  view.destroy();
});
