import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import katex from "katex";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { collectMacroSources } from "../../src/components/libera/latex/latex-dependencies";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { forKatex, KATEX_MACROS } from "../../src/lib/latex/codemirror/visual/math-render";
import { setMacroSources, setNumbering, visualDefinitions, type MacroSource } from "../../src/lib/latex/codemirror/visual/model";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { collectLatexDefinitions, readLatexDefinitions } from "../../src/lib/latex/macros/definitions";
import { expandLatexMacros } from "../../src/lib/latex/macros/expand";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";
import { subfilesRootPath } from "../../src/lib/latex/project";

/* Audit round 4, macro engine and project files: a subfiles chapter reads its main file's preamble and local packages
 * (2611.13347), `\def` with delimited parameters and accents built from box arithmetic (2611.13390), and counters made
 * to count together with `\let\c@lemmaL\c@theorem` (2611.11388). No new widgets: the hidden lines are the layout kind
 * other counter commands use, shown again at the cursor. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function settle(state: EditorState) {
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

function visualState(doc: string, anchor = doc.length, sources: MacroSource[] = []) {
  let state = EditorState.create({ doc, selection: { anchor }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" })] });
  ensureSyntaxTree(state, doc.length, 5000);
  if (sources.length) state = state.update({ effects: setMacroSources.of(sources) }).state;
  return settle(state);
}

/** What a mounted Visual mode shows for `doc` with the cursor at `anchor`, numbered as the app numbers it. */
function visibleText(doc: string, anchor = doc.length, sources: MacroSource[] = []) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, anchor, sources), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  const text = view.contentDOM.textContent ?? "";
  view.destroy();
  parent.remove();
  return { text, numbering };
}

const renders = (latex: string) => {
  try { katex.renderToString(forKatex(latex), { throwOnError: true, strict: "ignore", macros: { ...KATEX_MACROS } }); return true; } catch { return false; }
};

test("a subfiles chapter reads the main file's preamble and its local package (stylesheet.sty), nothing added to the files (2611.13347)", async () => {
  const files: Record<string, string> = {
    "nb/main.tex": String.raw`\documentclass{amsart}
\usepackage{amsmath, stylesheet, subfiles}
\begin{document}
\subfile{sections/2}
\end{document}`,
    "nb/stylesheet.sty": String.raw`\usepackage{amssymb}
\newcommand{\bL}{\mathbf{L}}
\newcommand{\mcS}{\mathcal{S}}
\renewcommand{\P}[1]{\left(#1\right)}`,
    "nb/sections/2.tex": String.raw`\documentclass[../main.tex]{subfiles}
\begin{document}
\section{Prelims} $\oplus\bL$ and $\mcS\P{x}$.
\end{document}`,
  };
  const known = new Set(Object.keys(files));
  assert.equal(subfilesRootPath("nb/sections/2.tex", files["nb/sections/2.tex"], known), "nb/main.tex");
  const { sources } = await collectMacroSources({
    filePath: "nb/sections/2.tex", rootPath: "nb/main.tex", ownPreamble: "", known, readText: async (path) => files[path] ?? "", version: () => "1",
  });
  assert.ok(sources.some((source) => source.path === "nb/stylesheet.sty"), "the local package is read");
  const defs = collectLatexDefinitions(sources);
  for (const formula of [String.raw`\oplus\bL`, String.raw`\mcS\P{x}`]) {
    const expanded = expandLatexMacros(formula, defs, { mode: "math", pos: 50 });
    assert.ok(expanded.ok, formula);
    assert.ok(renders(expanded.text), expanded.text);
  }
  const { text } = visibleText(files["nb/sections/2.tex"], 0, sources);
  assert.doesNotMatch(text, /\\bL|\\mcS|Undefined/);
});

test("\\def with delimited parameters expands at its uses: \\set{B_v}:{v\\in V} (2611.13390)", () => {
  const defs = readLatexDefinitions(String.raw`\newcommand{\Set}[1]{{\left\lbrace {#1} \right\rbrace}}
\def\set#1:#2{\Set{{#1} \colon {#2}}}
\def\pair#1,#2.{(#1;#2)}`);
  const expand = (text: string) => expandLatexMacros(text, defs, { mode: "math", pos: 1000 });
  const set = expand(String.raw`\set{B_v}:{v\in V(H)}`);
  assert.ok(set.ok);
  assert.equal(set.text, String.raw`{\left\lbrace {{B_v} \colon {v\in V(H)}} \right\rbrace}`);
  assert.ok(renders(set.text));
  // A braced first argument loses its braces (TeX strips them); an unbraced one runs to the delimiter, outside groups.
  assert.equal(expand(String.raw`\pair{a,b},c.`).text, String.raw`(a,b;c)`);
  assert.equal(expand(String.raw`\pair x,y.`).text, String.raw`(x;y)`);
  // Followed by more formula, and used inside another argument.
  assert.equal(expand(String.raw`\sup\set{k_{\ell(q)}}:{q} = \kappa`).text, String.raw`\sup{\left\lbrace {{k_{\ell(q)}} \colon {q}} \right\rbrace} = \kappa`);
  // Without its delimiter the use cannot be read: it stays source (the expansion fails rather than guessing).
  assert.equal(expand(String.raw`\set{B_v}`).ok, false);
  // A definition TeX could not read as written still shadows the earlier meaning and stays source.
  const odd = readLatexDefinitions(String.raw`\def\bad#1\par#2{#1#2}`);
  assert.equal(expandLatexMacros(String.raw`\bad a b`, odd, { mode: "math", pos: 1000 }).ok, false);
});

test("an accent built from box arithmetic draws as an accent over the base (accents.sty \\accentset, \\raisebox, \\lineskiplimit; 2611.13390)", () => {
  const defs = readLatexDefinitions(String.raw`\usepackage{accents,graphicx}
\newcommand{\oacc}[4]{\text{$\lineskiplimit=0pt #1{\raisebox{#2}[\height][\depth]{\scalebox{.65}{$\circ$}}}{\mathstrut\smash[#3]{#4}}$}}
\newcommand{\odowncl}[1]{\lceil \oacc\accentset{-.2ex}{t}{#1} \rceil}
\newcommand{\oupcl}[1]{\lfloor \oacc\underaccent{.2ex}{b}{#1} \rfloor}
\newcommand{\upcl}[1]{\lfloor {#1} \rfloor}`);
  for (const use of [String.raw`\odowncl{t}`, String.raw`\oupcl{t}`, String.raw`\upcl{t}\subseteq \odowncl{N(\oupcl{s})}`]) {
    const expanded = expandLatexMacros(use, defs, { mode: "math", pos: 1000 });
    assert.ok(expanded.ok, use);
    assert.ok(renders(expanded.text), expanded.text);
  }
  const html = katex.renderToString(forKatex(expandLatexMacros(String.raw`\odowncl{t}`, defs, { mode: "math", pos: 1000 }).text), { strict: "ignore", macros: { ...KATEX_MACROS } });
  assert.match(html, /∘/);
  assert.doesNotMatch(html, /lineskiplimit/);
});

test("\\let\\c@lemmaL\\c@theorem makes the counters count together, and its lines are hidden, shown at the cursor (2611.11388)", () => {
  const doc = String.raw`\documentclass{article}
\newtheorem{theorem}{Theorem}
\newtheorem{lemmaL}{Lemma}
\newtheorem{remark}{Remark}
\begin{document}
\section{One}
\begin{theorem}\label{t1}A.\end{theorem}
\begin{lemmaL}\label{l1}B.\end{lemmaL}
\makeatletter
\let\c@lemmaL\c@theorem
\let\c@remark\c@theorem
\makeatother
\begin{theorem}\label{t2}C.\end{theorem}
\begin{lemmaL}\label{l2}D.\end{lemmaL}
\begin{remark}\label{r1}E.\end{remark}
\setcounter{theorem}{0}
\begin{lemmaL}\label{l3}F.\end{lemmaL}
\end{document}`;
  const { text, numbering } = visibleText(doc, 0);
  const number = (key: string) => numbering.labels.get(key)?.number;
  // Before the `\let` they count apart; after it, in one sequence (a lemma after the theorem is 2, the remark 4).
  assert.deepEqual([number("t1"), number("l1")], ["1", "1"]);
  assert.deepEqual([number("t2"), number("l2"), number("r1")], ["2", "3", "4"]);
  assert.equal(number("l3"), "1");
  assert.doesNotMatch(text, /\\let|c@lemmaL|c@theorem/);
  // At the cursor the line is source again, so it can be edited.
  const at = doc.indexOf("\\let\\c@lemmaL") + 8;
  assert.match(visibleText(doc, at).text, /\\let\\c@lemmaL\\c@theorem/);
  // A `\let` of anything else is not understood: it stays source.
  const other = doc.replace("\\let\\c@remark\\c@theorem", "\\let\\foo\\bar");
  assert.match(visibleText(other, 0).text, /\\let\\foo\\bar/);
});

test("a preamble's \\let of counter registers aliases the counters too (2611.11388)", () => {
  const preamble = String.raw`\documentclass{article}
\newtheorem{theorem}{Theorem}
\newtheorem{lemmaL}{Lemma}
\makeatletter
\let\c@lemmaL\c@theorem
\makeatother
`;
  const doc = `${preamble}\\begin{document}
\\begin{theorem}\\label{t1}A.\\end{theorem}
\\begin{lemmaL}\\label{l1}B.\\end{lemmaL}
\\end{document}`;
  const { numbering } = visibleText(doc, 0);
  assert.equal(numbering.labels.get("l1")?.number, "2");
});

test("a line \\renewcommand{\\qedsymbol}{…} in a proof is hidden, shown at the cursor (2611.13390)", () => {
  const doc = String.raw`\documentclass{amsart}
\begin{document}
\begin{proof}[Proof of the claim]
\renewcommand{\qedsymbol}{$\blacksquare$}
Assume the contrary.
\end{proof}
\end{document}`;
  const { text } = visibleText(doc, 0);
  assert.doesNotMatch(text, /renewcommand|qedsymbol/);
  assert.match(text, /Assume the contrary/);
  const at = doc.indexOf("\\renewcommand") + 5;
  assert.match(visibleText(doc, at).text, /\\renewcommand\{\\qedsymbol\}/);
});
