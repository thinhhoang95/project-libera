import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setMacroSources, setNumbering, setNumberingStart, visualDefinitions, type MacroSource } from "../../src/lib/latex/codemirror/visual/model";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexParser as parser } from "../../src/lib/latex/codemirror/latex-parser";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { collectLatexDefinitions, readLatexDefinitions } from "../../src/lib/latex/macros/definitions";
import { computeLatexNumbering, type NumberingStart } from "../../src/lib/latex/macros/numbering";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

/* Multi-file projects, document classes and numbering across files (batch 5–7
 * papers: the book 2403.14606, the thesis 1709.01953, LongBench 2308.14508,
 * LIPIcs and LNCS papers). Each test is the smallest source showing the problem. */

/** The Visual mode's state for `doc`, with every pending piece built; `sources` are other files' definitions. */
function visualState(doc: string, extra: Extension[] = [], sources: MacroSource[] = [], start: NumberingStart | null = null) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }), ...extra] });
  if (sources.length || start) state = state.update({ effects: [setMacroSources.of(sources), setNumberingStart.of(start)] }).state;
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

/** The text a mounted Visual mode shows for `doc` (widgets' text included), numbered as the app numbers it. */
function visibleText(doc: string, sources: MacroSource[] = [], start: NumberingStart | null = null) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, [], sources, start), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state), { start });
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  const text = view.contentDOM.textContent ?? "";
  view.destroy();
  parent.remove();
  return text;
}

function number(source: string, options: Parameters<typeof computeLatexNumbering>[3] = {}, defs = readLatexDefinitions(source)) {
  return computeLatexNumbering(parser.parse(source), (from, to) => source.slice(from, to), defs, options);
}

test("an environment that opens a theorem in a frame is numbered and headed as the theorem (the book 2403.14606's boxdef, B5-02)", () => {
  const doc = String.raw`\documentclass{book}
\usepackage{amsthm,mdframed}
\newtheorem{definition}{Definition}[chapter]
\newenvironment{boxdef}[1]{%
\begin{definition}[#1]\begin{mdframed}[style=defsty]
}{%
\end{mdframed}\end{definition}}
\newenvironment{boxnote}[1][]{\begin{definition}[#1]\textbf{Note}}{\end{definition}}
\begin{document}
\chapter{Introduction}
\begin{definition}A plain one.\end{definition}
\begin{boxdef}{Differentiable programming}\label{def:dp}
Differentiable programming is a paradigm.
\end{boxdef}
See Definition~\ref{def:dp}.
\end{document}`;
  const numbering = number(doc);
  assert.equal(numbering.labels.get("def:dp")?.number, "1.2");
  assert.equal(numbering.labels.get("def:dp")?.env, "definition");
  const state = visualState(doc);
  assert.ok(constructs(state).some((construct) => construct.startsWith("env-header:")));
  const text = visibleText(doc);
  assert.match(text, /Definition 1\.2 \(Differentiable programming\)\. /);
  assert.match(text, /See Definition.1\.2\./);
  assert.doesNotMatch(text, /\\begin\{boxdef\}|mdframed/);
});

test("an environment whose code does more than open a theorem in a frame is not taken for the theorem", () => {
  const doc = String.raw`\newtheorem{definition}{Definition}
\newenvironment{noted}[1][]{\begin{definition}[#1]\textbf{Note}}{\end{definition}}
\newenvironment{mismatched}{\begin{definition}\begin{mdframed}}{\end{definition}}
\begin{document}
\begin{noted}[A]x\label{a}\end{noted}
\begin{mismatched}y\label{b}\end{mismatched}
\end{document}`;
  const numbering = number(doc);
  assert.equal(numbering.labels.get("a"), undefined);
  assert.equal(numbering.labels.get("b"), undefined);
  assert.doesNotMatch(visibleText(doc), /Definition 1/);
});

void collectLatexDefinitions;
