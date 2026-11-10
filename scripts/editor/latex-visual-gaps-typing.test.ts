import "./setup.cjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { CompletionContext } from "@codemirror/autocomplete";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { latexCompletionSource } from "../../src/lib/latex/codemirror/editing";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Typing paper cuts: a heading is its source while the cursor is on it and can be left with Enter or the arrows;
 * `\c` typed at a line's end stays `\c`; block widgets keep CodeMirror's height map true. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

/** The Visual mode's state for `doc`, with every pending piece built. */
function visualState(doc: string, extra: Extension[] = [], selection = doc.length) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  let state = EditorState.create({ doc, selection: { anchor: selection }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }), ...extra] });
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

/** Constructs as "kind:from:to": what the structural layer has built. */
function constructs(state: EditorState) {
  const list: string[] = [];
  state.field(structuralField).extents.between(0, state.doc.length, (from, to, mark) => { list.push(`${mark.kind}:${from}:${to}`); });
  return list;
}

function mountView(doc: string, selection = doc.length) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, [], selection), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return view;
}

function revealedKinds(state: EditorState) {
  const value = state.field(structuralField);
  const out: string[] = [];
  value.extents.between(0, state.doc.length, (_from, _to, mark) => { if (value.revealed.has(mark.id)) out.push(mark.kind); });
  return out;
}

/** Each line's text and whether it has the heading line class. */
const lines = (view: EditorView) => [...view.contentDOM.querySelectorAll(".cm-line")].map((line) => `${line.classList.contains("cm-vis-heading") ? "H " : ""}${line.textContent}`);
/** The structural layer's line classes, as "class@pos". */
function lineClasses(state: EditorState) {
  const out: string[] = [];
  state.field(structuralField).decorations.between(0, state.doc.length, (from, to, decoration) => { if (from === to && decoration.spec.class) out.push(`${decoration.spec.class}@${from}`); });
  return out;
}
const key = (name: string) => new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });

/* ---- Headings: source while the cursor is on them ------------------------------------------------------------- */

test("a heading shows its source with the cursor in it or at either edge, and is drawn once the cursor is out", () => {
  const doc = "Intro text.\n\\section{Title \\textbf{bold}}\\label{sec:t}\nNext line.\n";
  const head = doc.indexOf("\\section");
  const state = visualState(doc);
  const at = (pos: number) => revealedKinds(state.update({ selection: { anchor: pos } }).state);
  assert.ok(at(doc.indexOf("Title") + 2).includes("heading"), "in the title");
  assert.ok(at(head).includes("heading"), "at its start");
  assert.ok(at(doc.indexOf("\nNext")).includes("heading"), "after its `}` and label, at the line's end");
  assert.deepEqual(at(doc.indexOf("bold") + 2), ["heading", "style"], "in bold text inside it: the heading's markup shows too");
  assert.deepEqual(at(doc.indexOf("Next") + 2), [], "on the next line: drawn");
  assert.deepEqual(at(head - 1), [], "at the end of the line before: drawn");
});

test("a revealed heading is source at the text's size (no heading line class); drawn, it has its size again", () => {
  const doc = "Intro text.\n\\section{Title}\nNext line.\n";
  const view = mountView(doc, doc.indexOf("Title") + 2);
  assert.deepEqual(lines(view).slice(0, 3), ["Intro text.", "\\section{Title}", "Next line."]);
  view.dispatch({ selection: { anchor: doc.indexOf("Next") } });
  const drawn = lines(view);
  assert.match(drawn[1], /^H .*Title$/, "the heading line class, drawn");
  assert.ok(!drawn[1].includes("\\section"));
  view.destroy();
});

test("a heading after text on its line loses its line class too while it shows its source", () => {
  const doc = "Some text \\section{Title}\nNext line.\n";
  const view = mountView(doc, doc.indexOf("Title") + 2);
  assert.equal(lines(view)[0], "Some text \\section{Title}");
  view.destroy();
});

test("the cursor goes after a heading's `}`, and text typed there is outside the heading, shown as source", () => {
  const doc = "\\section{Title}\\label{sec:t}\nNext";
  const view = mountView(doc, doc.indexOf("Next"));
  const end = doc.indexOf("\nNext");
  // Was: clamped before the hidden `}` (typing went into the title). Now the heading shows its source there.
  view.dispatch({ selection: { anchor: end } });
  assert.equal(view.state.selection.main.head, end, "not clamped before the }");
  view.dispatch({ changes: { from: end, insert: "\\c" }, selection: { anchor: end + 2 } });
  assert.equal(view.state.doc.toString(), "\\section{Title}\\label{sec:t}\\c\nNext");
  assert.equal(lines(view)[0], "\\section{Title}\\label{sec:t}\\c", "the line is source, at the text's size");
  view.destroy();
});

test("a click past the end of a drawn heading lands after its `}`; a click in a heading already shown stays put", () => {
  const doc = "\\section{Title}\nNext";
  const view = mountView(doc, doc.length);
  const brace = doc.indexOf("}");
  view.dispatch({ selection: { anchor: brace }, userEvent: "select.pointer" });
  assert.equal(view.state.selection.main.head, brace + 1, "after the hidden }");
  view.dispatch({ selection: { anchor: brace }, userEvent: "select.pointer" });
  assert.equal(view.state.selection.main.head, brace, "in the shown source, the click is where it is");
  view.destroy();
});

test("Enter at the end of a heading's title starts a new line after the heading; in the title it is not taken", () => {
  const doc = "\\section{jsa}\\label{sec:j}\nBody";
  const view = mountView(doc, doc.indexOf("}"));
  assert.ok(runScopeHandlers(view, key("Enter"), "editor"));
  assert.equal(view.state.doc.toString(), "\\section{jsa}\\label{sec:j}\n\nBody");
  assert.equal(view.state.selection.main.head, doc.indexOf("\nBody") + 1, "on the new line");
  assert.ok(!revealedKinds(view.state).includes("heading"), "the heading is drawn again");
  view.dispatch({ selection: { anchor: doc.indexOf("sa") } });
  assert.ok(!runScopeHandlers(view, key("Enter"), "editor"), "mid-title: the ordinary Enter");
  assert.equal(view.state.doc.toString(), "\\section{jsa}\\label{sec:j}\n\nBody");
  view.destroy();
});

test("deleting a heading at the start of the document leaves no heading size on the line after it", () => {
  const doc = "\\section{Title}\nText here.\n";
  let state = visualState(doc, [], doc.length);
  assert.ok(lineClasses(state).some((entry) => entry.startsWith("cm-vis-heading")));
  state = state.update({ changes: { from: 0, to: doc.indexOf("Text") } }).state;
  assert.deepEqual(lineClasses(state), [], "no line class left from the deleted heading");
  assert.deepEqual(constructs(state), constructs(visualState(state.doc.toString())), "as a fresh build");
});

/* ---- `\c` typed at a line's end ------------------------------------------------------------------------------ */

test("\\c typed at the end of a line stays \\c (no cedilla on the next line's letter) and completes to \\cite", () => {
  const doc = "Some text \\c\nBody here.\n";
  const view = mountView(doc, 0);
  // Was: drawn as the accent on `B` across the line break, which pulled `Body here.` up into the line as `B̧ody`.
  assert.deepEqual(lines(view).slice(0, 2), ["Some text \\c", "Body here."]);
  assert.ok(!constructs(view.state).some((entry) => entry.startsWith("symbol:")), "no accent construct");
  const context = new CompletionContext(view.state, doc.indexOf("\nBody"), false);
  const result = latexCompletionSource(context);
  assert.ok(result && result.from === doc.indexOf("\\c"));
  assert.ok(result.options.some((option) => option.label === "\\cite"));
  view.destroy();
  // An accent on the same line is still drawn.
  assert.ok(constructs(visualState("Fa\\c cade.\n", [], 0)).some((entry) => entry.startsWith("symbol:")));
});

/* ---- Block widgets and the height map ------------------------------------------------------------------------ */

test("block widgets have no vertical margin in the Visual mode (CodeMirror measures their border box)", () => {
  const css = readFileSync(path.join(__dirname, "../../src/app/globals.css"), "utf8");
  assert.match(css, /\.libera-latex-visual \.cm-content > :not\(\.cm-line\) \{ margin-block: 0 !important; \}/);
});
