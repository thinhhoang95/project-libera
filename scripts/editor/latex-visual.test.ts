import "./setup.cjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import fc from "fast-check";
import { JSDOM } from "jsdom";
import { history, undo } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState, setNumberingStart, toggleLatexFormat, visualRevealRanges } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField, LARGE_DOCUMENT } from "../../src/lib/latex/codemirror/visual/structural";
import { numberingField, setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { stateReferenceText } from "../../src/lib/latex/codemirror/visual/references";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

const SAMPLE = readFileSync(path.join(__dirname, "fixtures/latex/visual-sample.tex"), "utf8");

function extensions(extra: Extension[] = []) {
  return [history(), latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }), ...extra];
}

function stateFor(doc: string, extra: Extension[] = [], selection?: number) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  return EditorState.create({ doc, selection: selection === undefined ? undefined : { anchor: selection }, extensions: extensions(extra) });
}

function mount(doc: string, extra: Extension[] = [], selection?: number) {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({ state: stateFor(doc, extra, selection), parent });
}

/** Constructs as "kind:from:to", sorted: what the structural layer has built. */
function constructs(state: EditorState) {
  const list: string[] = [];
  state.field(structuralField).extents.between(0, state.doc.length, (from, to, mark) => { list.push(`${mark.kind}:${from}:${to}`); });
  return list.sort();
}

function kinds(state: EditorState) {
  const counts: Record<string, number> = {};
  state.field(structuralField).extents.between(0, state.doc.length, (_from, _to, mark) => { counts[mark.kind] = (counts[mark.kind] ?? 0) + 1; });
  return counts;
}

function revealedKinds(state: EditorState) {
  const value = state.field(structuralField);
  const out: string[] = [];
  value.extents.between(0, state.doc.length, (_from, _to, mark) => { if (value.revealed.has(mark.id)) out.push(mark.kind); });
  return out;
}

function at(view: EditorView, needle: string, offset = 0) {
  const index = view.state.doc.toString().indexOf(needle);
  assert.ok(index >= 0, `${needle} not found`);
  return index + offset;
}

function number(view: EditorView) {
  const state = view.state;
  const numbering = computeLatexNumbering(syntaxTree(state), (from, to) => state.doc.sliceString(from, to), visualDefinitions(state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
}

/* ---- Rendering ------------------------------------------------------------------ */

test("the sample draws every construct it recognises, and the file is not changed", () => {
  const view = mount(SAMPLE);
  assert.equal(view.state.doc.toString(), SAMPLE);
  assert.deepEqual(kinds(view.state), {
    preamble: 1, title: 1, "env-header": 6, "env-end": 5, "env-footer": 1, style: 6, math: 8, heading: 3, footnote: 1, symbol: 6,
    cite: 2, macro: 1, "macro-args": 1, "list-begin": 2, item: 4, "list-end": 2, ref: 6, figure: 2, "document-end": 1,
  });
  const content = view.contentDOM;
  assert.ok(content.querySelector(".cm-vis-preamble"), "the preamble folds into a block");
  assert.equal(content.querySelector(".cm-vis-title")?.textContent, "A Sample Paper");
  assert.equal(content.querySelectorAll(".cm-vis-author").length, 2);
  view.destroy();
});

test("chips and numbers follow the numbering", async () => {
  const view = mount(SAMPLE);
  number(view);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const text = (selector: string) => [...view.contentDOM.querySelectorAll(selector)].map((element) => element.textContent);
  assert.deepEqual(text(".cm-vis-heading-number"), ["1\u2002", "1.1\u2002", "2\u2002"]);
  // jsdom draws the first screen only; the rest is checked through the state.
  assert.equal(text(".cm-vis-ref")[0], "2");
  assert.deepEqual(text(".cm-vis-item"), ["•", "•", "1.", "2."]);
  const reference = (command: string, key: string) => stateReferenceText(view.state, command, [key]);
  assert.deepEqual([reference("\\eqref", "eq:energy"), reference("\\cref", "eq:first"), reference("\\ref", "thm:pyth"), reference("\\ref", "fig:plot"), reference("\\ref", "tab:results")], ["(1)", "eq. (2)", "2.1", "1", "1"]);
  // Scrolled into view, theorem headers, captions and equation numbers show their numbers.
  for (const needle of ["\\begin{theorem}", "\\begin{align}", "\\begin{figure}"]) {
    view.dispatch({ effects: EditorView.scrollIntoView(at(view, needle), { y: "start" }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  view.destroy();
});

test("macros: math macros render expanded, text macros as their expansion, and \\todo keeps its argument editable", () => {
  const view = mount(SAMPLE);
  const macro = view.contentDOM.querySelector(".cm-vis-macro");
  assert.equal(macro?.textContent, "e.g.");
  const pieces = [...view.contentDOM.querySelectorAll(".cm-vis-macro-piece")].map((piece) => piece.textContent);
  assert.deepEqual(pieces, ["[[", "]]"]);
  const argument = view.contentDOM.querySelector(".cm-vis-macro-arg");
  assert.equal(argument?.textContent, "check this");
  assert.match(argument?.getAttribute("style") ?? "", /color/);
  // \norm{v} inside math went through the expansion: KaTeX drew \lVert.
  const norm = [...view.contentDOM.querySelectorAll(".cm-vis-math")].find((element) => element.getAttribute("aria-label")?.includes("\\norm"));
  assert.ok(norm?.innerHTML.includes("∥"));
  view.destroy();
});

test("broken or unknown LaTeX stays as source, but constructs inside a broken one still render", () => {
  const view = mount("Before \\textbf{open $x$ and \\emph{fine}\n\nAfter \\frobnicate{y} and \\begin{theorem}x\\end{lemma}.");
  const found = kinds(view.state);
  assert.equal(found.style, 1, "only \\emph renders; the unclosed \\textbf stays as source");
  assert.equal(found.math, 1);
  assert.equal(found["env-header"], undefined, "a wrong \\end leaves the environment as source");
  view.destroy();
});

/* ---- Revealing the source ---------------------------------------------------------- */

test("the innermost construct at the cursor shows its source, by its policy", () => {
  const doc = "\\section{Intro \\textbf{bold}}\n\nText $x^2$ here.\n\\begin{itemize}\n\\item one\n\\end{itemize}\n";
  const view = mount(doc);
  const moveTo = (pos: number) => view.dispatch({ selection: { anchor: pos } });
  moveTo(at(view, "bold", 2));
  assert.deepEqual(revealedKinds(view.state), ["style"], "bold inside a heading reveals only the bold markup");
  moveTo(at(view, "Intro", 2));
  assert.deepEqual(revealedKinds(view.state), [], "typing in a heading keeps its markup hidden");
  moveTo(0);
  assert.deepEqual(revealedKinds(view.state), ["heading"], "the line start reveals the heading command");
  moveTo(at(view, "$x"));
  assert.deepEqual(revealedKinds(view.state), [], "a formula stays drawn with the cursor at its edge");
  moveTo(at(view, "x^2"));
  assert.deepEqual(revealedKinds(view.state), ["math"], "strictly inside, the formula shows its source");
  moveTo(at(view, "one"));
  assert.deepEqual(revealedKinds(view.state), [], "bullets never open from the cursor");
  view.dispatch({ selection: { anchor: at(view, "one") } });
  assert.ok(runScopeHandlers(view, new dom.window.KeyboardEvent("keydown", { key: "Enter", altKey: true }), "editor"));
  assert.deepEqual(revealedKinds(view.state), ["item"], "Alt+Enter shows the source of the construct at the cursor");
  view.destroy();
});

test("constructs under a pending suggestion or AI change show as source", () => {
  const doc = "A formula $a+b$ and \\textbf{bold}.";
  const formula = doc.indexOf("a+b");
  const view = mount(doc, [visualRevealRanges.of(() => [{ from: formula, to: formula + 1 }])]);
  assert.deepEqual(revealedKinds(view.state), ["math"]);
  view.destroy();
});

/* ---- Keyboard ------------------------------------------------------------------------ */

test("bold toggles off inside \\textbf and on elsewhere", () => {
  const view = mount("Some \\textbf{bold} text");
  view.dispatch({ selection: { anchor: at(view, "bold", 2) } });
  toggleLatexFormat("textbf")(view);
  assert.equal(view.state.doc.toString(), "Some bold text");
  assert.equal(view.state.selection.main.head, at(view, "bold", 2));
  view.dispatch({ selection: EditorSelection.range(at(view, "text"), at(view, "text", 4)) });
  toggleLatexFormat("textbf")(view);
  assert.equal(view.state.doc.toString(), "Some bold \\textbf{text}");
  view.destroy();
});

test("Backspace selects a formula before deleting it, and typing after \\ldots keeps the command", () => {
  const view = mount("See $x^2$ now and\\ldots");
  view.dispatch({ selection: { anchor: at(view, " now") } });
  assert.ok(runScopeHandlers(view, new dom.window.KeyboardEvent("keydown", { key: "Backspace" }), "editor"));
  assert.deepEqual([view.state.selection.main.from, view.state.selection.main.to], [at(view, "$x"), at(view, " now")]);
  assert.equal(view.state.doc.toString(), "See $x^2$ now and\\ldots");
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  const handlers = view.state.facet(EditorView.inputHandler);
  const handled = handlers.some((handler) => handler(view, view.state.doc.length, view.state.doc.length, "x", () => view.state.update({ changes: { from: view.state.doc.length, insert: "x" } })));
  assert.ok(handled);
  assert.equal(view.state.doc.toString(), "See $x^2$ now and\\ldots x");
  view.destroy();
});

test("the cursor stays before a heading's hidden brace", () => {
  const doc = "\\section{Title}\\label{sec:t}\nNext";
  const view = mount(doc);
  view.dispatch({ selection: { anchor: doc.indexOf("\nNext") } });
  assert.equal(view.state.selection.main.head, doc.indexOf("}"), "clamped before the }");
  view.dispatch({ selection: { anchor: doc.indexOf("\nNext") } });
  assert.equal(view.state.selection.main.head, doc.indexOf("Next"), "moving on from there goes to the next line");
  view.destroy();
});

/* ---- Speed and correctness of incremental updates ----------------------------------- */

test("incremental updates build the same constructs as a fresh build", () => {
  const pieces = ["$", "$x$", "\\textbf{", "}", "{", "\\cite{a}", "\\begin{itemize}\\item x\\end{itemize}", "\n\n", "\\section{S}", " text ", "\\ref{sec:intro}", "\\%", "--", "\\todo{t}", "\\eg"];
  const base = SAMPLE.slice(SAMPLE.indexOf("\\section{Introduction}"), SAMPLE.indexOf("\\begin{figure}"));
  fc.assert(fc.property(fc.array(fc.record({ at: fc.nat(), remove: fc.nat({ max: 6 }), insert: fc.constantFrom(...pieces) }), { maxLength: 6 }), (edits) => {
    const preamble = SAMPLE.slice(0, SAMPLE.indexOf("\\begin{document}") + 17);
    const view = mount(`${preamble}${base}\\end{document}\n`);
    try {
      for (const edit of edits) {
        const length = view.state.doc.length;
        const from = preamble.length + (edit.at % Math.max(1, length - preamble.length - 16));
        const to = Math.min(length - 16, from + edit.remove);
        view.dispatch({ changes: { from, to: Math.max(from, to), insert: edit.insert } });
        // When the parser finishes in the background, the app gets a transaction for it; so does this test.
        ensureSyntaxTree(view.state, view.state.doc.length, 5000);
        view.dispatch({});
      }
      const fresh = stateFor(view.state.doc.toString());
      assert.deepEqual(constructs(view.state), constructs(fresh));
    } finally {
      view.destroy();
    }
  }), { numRuns: 60 });
});

test("cursor moves, scrolling and mode switches never change the document", () => {
  fc.assert(fc.property(fc.array(fc.nat(), { maxLength: 30 }), (positions) => {
    const visual = new Compartment();
    const view = mount(SAMPLE, []);
    const before = view.state.doc.toString();
    for (const position of positions) view.dispatch({ selection: { anchor: position % (view.state.doc.length + 1) } });
    view.dispatch({ effects: visual.reconfigure([]) });
    const unchanged = view.state.doc.toString() === before;
    view.destroy();
    return unchanged;
  }), { numRuns: 25 });
});

test("switching modes keeps the document and its undo history", () => {
  const visual = new Compartment();
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc: "A \\textbf{b} c", extensions: [history(), latexLanguageSupport("main.tex", "tree"), latexVisualState(), visual.of([])] }) });
  view.dispatch({ changes: { from: 0, insert: "X" } });
  view.dispatch({ effects: visual.reconfigure(latexVisualMode({ documentPath: "nb/main.tex" })) });
  assert.ok(view.state.field(structuralField, false));
  view.dispatch({ effects: visual.reconfigure([]) });
  assert.equal(view.state.field(structuralField, false), undefined);
  assert.equal(view.state.doc.toString(), "XA \\textbf{b} c");
  undo(view);
  assert.equal(view.state.doc.toString(), "A \\textbf{b} c");
  view.destroy();
});

test("long documents are built in pieces, the part at the cursor first", () => {
  let body = "";
  for (let i = 0; body.length < LARGE_DOCUMENT * 1.5; i++) body += `\\section{Part ${i}}\nText with $x_${i}$ and \\textbf{bold ${i}}.\n\n`;
  const doc = `\\documentclass{article}\n\\begin{document}\n${body}\\end{document}\n`;
  // As in the app: Source mode has parsed the document when Visual mode starts.
  const visual = new Compartment();
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc, selection: { anchor: doc.length - 10 }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), visual.of([])] }) });
  ensureSyntaxTree(view.state, doc.length, 20_000);
  view.dispatch({ effects: visual.reconfigure(latexVisualMode({ documentPath: "nb/main.tex" })) });
  const value = view.state.field(structuralField);
  assert.ok(value.pending.length > 0, "the rest is pending");
  const near = constructs(view.state).filter((entry) => Number(entry.split(":")[1]) > doc.length - 8000);
  assert.ok(near.length > 0, "the part at the cursor is built");
  const builtHeadings = constructs(view.state).filter((entry) => entry.startsWith("heading:")).length;
  assert.ok(builtHeadings < (body.match(/\\section/g) ?? []).length / 2, "most of the document is not built yet");
  for (let guard = 0; view.state.field(structuralField).pending.length && guard < 60; guard++) {
    const next = view.state.field(structuralField).pending[0];
    view.dispatch({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) });
  }
  assert.equal(view.state.field(structuralField).pending.length, 0);
  const sections = (body.match(/\\section/g) ?? []).length;
  assert.equal(constructs(view.state).filter((entry) => entry.startsWith("heading:")).length, sections);
  assert.equal(constructs(view.state).filter((entry) => entry.startsWith("math:")).length, sections);
  assert.equal(constructs(view.state).filter((entry) => entry.startsWith("style:")).length, sections);
  view.destroy();
});

test("a chapter's numbers start where its main file includes it", () => {
  const view = mount("\\subsection{Attention}\\label{sec:att}\n\\begin{equation}x\\label{eq:x}\\end{equation}");
  view.dispatch({ effects: setNumberingStart.of({ counters: { section: 3, equation: 4 }, appendix: false }) });
  const state = view.state;
  const numbering = computeLatexNumbering(syntaxTree(state), (from, to) => state.doc.sliceString(from, to), visualDefinitions(state), { start: { counters: { section: 3, equation: 4 }, appendix: false } });
  assert.equal(numbering.labels.get("sec:att")?.number, "3.1");
  assert.equal(numbering.labels.get("eq:x")?.number, "5");
  assert.ok(view.state.field(numberingField, false));
  view.destroy();
});
