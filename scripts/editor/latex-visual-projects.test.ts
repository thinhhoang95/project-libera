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
import { collectLatexDefinitions, macroAt, readLatexDefinitions } from "../../src/lib/latex/macros/definitions";
import { computeLatexNumbering, type NumberingStart } from "../../src/lib/latex/macros/numbering";
import { chapterNumberingStart } from "../../src/lib/latex/macros/project-numbering";

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

/** A project's files by notebook path, read as the workspace reads them. */
function project(files: Record<string, string>) {
  return { known: new Set(Object.keys(files)), readText: async (path: string) => files[path] ?? "" };
}

/** What the workspace gives a chapter: its macro sources and where its numbering starts (latex-workspace.tsx). */
async function chapterData(files: Record<string, string>, filePath: string, rootPath = "nb/main.tex") {
  const { collectMacroSources } = await import("../../src/components/libera/latex/latex-dependencies");
  const { known, readText } = project(files);
  const own = files[filePath];
  const { sources } = await collectMacroSources({ filePath, rootPath, ownPreamble: own.slice(0, Math.max(0, own.search(/\\begin\s*\{document\}/))), known, readText, version: () => "1" });
  const macroSources = sources.map((source) => ({ ...source, version: "1" }));
  const rootSource = sources.find((source) => source.path === rootPath);
  const base = rootSource ? collectLatexDefinitions(sources.map((source) => {
    const body = source === rootSource ? source.text.search(/\\begin\s*\{document\}/) : -1;
    return body >= 0 ? { ...source, text: source.text.slice(0, body) } : source;
  })) : undefined;
  const start = await chapterNumberingStart(filePath, rootPath, readText, base);
  return { sources: macroSources, start };
}

test("a chapter knows the macros its main file defines in its body before including it (2304.03442, B5-11)", async () => {
  const files = {
    "nb/main.tex": String.raw`\documentclass{article}
\newcommand{\pre}{P}
\begin{document}
\newcommand{\gentxt}[1]{\textbf{#1}}
{\newcommand{\scoped}{S}}
\begin{table}\renewcommand{\arraystretch}{2}\end{table}
\input{sections/intro}
\newcommand{\later}{L}
\input{sections/method}
\end{document}`,
    "nb/sections/intro.tex": String.raw`\section{Intro}\newcommand{\fromintro}{I}`,
    "nb/sections/method.tex": String.raw`\section{Method}
Text $\pre$ \gentxt{agent} and \fromintro{} but \later{} and \scoped{}.`,
  };
  const { sources } = await chapterData(files, "nb/sections/method.tex");
  const state = visualState(files["nb/sections/method.tex"], [], sources);
  const defs = visualDefinitions(state);
  for (const name of ["pre", "gentxt", "fromintro", "later"]) assert.ok(macroAt(defs, name, 30), name);
  // A definition local to a group of the main file's body ended there.
  assert.equal(macroAt(defs, "scoped", 30), null);
  assert.equal(macroAt(defs, "arraystretch", 30), null);
  const text = visibleText(files["nb/sections/method.tex"], sources);
  assert.match(text, /P agent and I(?:\{\})? but L(?:\{\})? and \\scoped/);
  // The intro, included before \later is defined, does not see it.
  const intro = await chapterData(files, "nb/sections/intro.tex");
  const introDefs = visualDefinitions(visualState(files["nb/sections/intro.tex"], [], intro.sources));
  assert.equal(macroAt(introDefs, "later", 5), null);
  assert.ok(macroAt(introDefs, "gentxt", 5));
});

test("a chapter is numbered with the formats and counters its main file sets in its body before including it (B4-03)", async () => {
  const files = {
    "nb/main.tex": String.raw`\documentclass{article}
\begin{document}
\section{Main}
\begin{table}\caption{Main}\label{tab:main}\end{table}
\input{results}
\appendix
\renewcommand{\thetable}{A\arabic{table}}
\setcounter{table}{0}
\renewcommand{\thesection}{S\arabic{section}}
\input{appendix}
\end{document}`,
    "nb/results.tex": String.raw`\section{Results}\begin{table}\caption{R}\label{tab:r}\end{table}`,
    "nb/appendix.tex": String.raw`\section{Proofs}\label{sec:proofs}
\begin{table}\caption{Extra}\label{tab:extra}\end{table}`,
  };
  const { sources, start } = await chapterData(files, "nb/appendix.tex");
  assert.equal(start?.counters.table, 0);
  assert.equal(start?.appendix, true);
  // The tables before the appendix keep their numbers, in this chapter's references too.
  assert.equal(start?.labels?.find(([key]) => key === "tab:r")?.[1].number, "2");
  const state = visualState(files["nb/appendix.tex"], [], sources, start);
  const numbering = computeLatexNumbering(syntaxTree(state), (from, to) => state.doc.sliceString(from, to), visualDefinitions(state), { start });
  assert.equal(numbering.labels.get("tab:extra")?.number, "A1");
  assert.equal(numbering.labels.get("sec:proofs")?.number, "S1");
  // Without the main file's body, the appendix's format and the letters would be used instead.
  const results = await chapterData(files, "nb/results.tex");
  const resultsState = visualState(files["nb/results.tex"], [], results.sources, results.start);
  const resultsNumbering = computeLatexNumbering(syntaxTree(resultsState), (from, to) => resultsState.doc.sliceString(from, to), visualDefinitions(resultsState), { start: results.start });
  assert.equal(resultsNumbering.labels.get("tab:r")?.number, "2");
});

test("a section format made before \\appendix gives way to its letters in a chapter included after it", async () => {
  const files = {
    "nb/main.tex": String.raw`\documentclass{article}
\begin{document}
\renewcommand{\thesection}{\Roman{section}}
\section{One}
\appendix
\input{appendix}
\end{document}`,
    "nb/appendix.tex": String.raw`\section{Proofs}\label{sec:proofs}`,
  };
  const { sources, start } = await chapterData(files, "nb/appendix.tex");
  const state = visualState(files["nb/appendix.tex"], [], sources, start);
  const numbering = computeLatexNumbering(syntaxTree(state), (from, to) => state.doc.sliceString(from, to), visualDefinitions(state), { start });
  assert.equal(numbering.labels.get("sec:proofs")?.number, "A");
});

test("a chapter included through another file gets that file's definitions up to its include", async () => {
  const files = {
    "nb/main.tex": String.raw`\documentclass{book}
\begin{document}
\include{toc}
\end{document}`,
    "nb/toc.tex": String.raw`\newcommand{\early}{E}
\input{chapters/one}
\newcommand{\late}{L}`,
    "nb/chapters/one.tex": String.raw`\chapter{One} \early \late`,
  };
  const { sources } = await chapterData(files, "nb/chapters/one.tex");
  const defs = visualDefinitions(visualState(files["nb/chapters/one.tex"], [], sources));
  assert.ok(macroAt(defs, "early", 5));
  assert.equal(macroAt(defs, "late", 5), null);
});

void collectLatexDefinitions;
