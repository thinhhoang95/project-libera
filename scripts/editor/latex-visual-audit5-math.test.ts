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
import { collectLatexDefinitions } from "../../src/lib/latex/macros/definitions";
import { expandLatexMacros } from "../../src/lib/latex/macros/expand";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Audit round 5, math and macro expansion: `\def\+Bound{…}` (cs.PL 2610.37006), `\mbox{\sc …}` and `\mbox{\em …}`
 * (2610.37006), `\DeclareMathSymbol` of a Cyrillic Sha and `\hyperref` in a formula (math.NT 2611.11566), `\footnotemark`
 * in a `cases` and the `\mathpalette\cmd\relax` overlay (cs.CR 2611.11859), definitions from a file the body inputs
 * (q-fin.MF 2610.16732), `\zcsetup` in an equation (cs.CC 2611.07413). No new widgets: the formulas are the math widgets. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function visualState(doc: string, sources: MacroSource[] = []) {
  let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" })] });
  ensureSyntaxTree(state, doc.length, 5000);
  if (sources.length) state = state.update({ effects: setMacroSources.of(sources) }).state;
  for (let guard = 0; state.field(structuralField).pending.length && guard < 500; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

function mount(doc: string, sources: MacroSource[] = []) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, sources), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return { view, done: () => { view.destroy(); parent.remove(); } };
}

const doc = (body: string, preamble = "") => `\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;

const renders = (latex: string) => {
  try { katex.renderToString(forKatex(latex), { throwOnError: true, strict: "ignore", macros: { ...KATEX_MACROS } }); return true; } catch { return false; }
};

test("`\\def\\+Bound{…}` (text right after the name, no parameter) expands where it is used (2610.37006)", () => {
  const defs = collectLatexDefinitions([], { text: String.raw`\documentclass{article}
\newcommand{\pjoin}{\oplus}
\def\+Bound{\pjoin\mbox{-Bound}}
\def\*Bound{\ast\mbox{-Bound}}
\begin{document}\end{document}` });
  const expanded = expandLatexMacros(String.raw`\+Bound(\delta,\bound) \*Bound(\prog^\ast, m)`, defs, { mode: "math", pos: 1000 });
  assert.ok(expanded.ok, JSON.stringify(expanded));
  assert.equal(expanded.text.replace(/\s+/g, ""), String.raw`\oplus\mbox{-Bound}(\delta,\bound)\ast\mbox{-Bound}(\prog^\ast,m)`);
  // Without the text after it, the use is not the one the definition is for.
  assert.equal(expandLatexMacros(String.raw`\+ x`, defs, { mode: "math", pos: 1000 }).ok, false);
});

test("a formula with `\\+Bound` is drawn as math, not left as source (2610.37006)", () => {
  const { view, done } = mount(doc("Then $\\+Bound(\\delta,k)$ holds.", "\\def\\+Bound{\\oplus\\mbox{-Bound}}"));
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  assert.ok(view.contentDOM.querySelector(".katex"), view.contentDOM.innerHTML);
  assert.ok(!(view.contentDOM.textContent ?? "").includes("\\+"));
  done();
});

test("old font switches inside a text box in a formula: `\\mbox{\\sc Files}`, `\\mbox{\\em ``ab''}` (2610.37006)", () => {
  assert.ok(renders(String.raw`F\in\mbox{\sc Files}=\Sigma^\ast`));
  assert.ok(renders("\\delta(\\{\\mbox{\\em ``ab''}\\},\\{\\mbox{\\em ``ba''}\\})=0"));
  assert.ok(renders(String.raw`\mbox{\sc Files} \times \mbox{\sc Files}`));
});

test("`\\DeclareMathSymbol{\\Sha}{\\mathalpha}{cyrletters}{\"58}` draws the Cyrillic Sha; `\\hyperref[x]{…}` in a formula draws its text (2611.11566)", () => {
  const preamble = String.raw`\DeclareSymbolFont{cyrletters}{OT2}{wncyr}{m}{n}
\DeclareMathSymbol{\Sha}{\mathalpha}{cyrletters}{"58}
\newcommand{\RF}{\hyperref[def:RF]{\textup{(RF)}}}`;
  const { view, done } = mount(doc("Let $\\Sha(E/K)$ be finite, and assume $\\RF$ holds.", preamble));
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  const text = view.contentDOM.textContent ?? "";
  assert.ok(text.includes("Ш"), text);
  assert.ok(text.includes("(RF)"), text);
  assert.ok(!text.includes("\\hyperref"), text);
  done();
});

test("a footnote mark after a `\\text{…}` row of a `cases` is drawn as a mark, not a source row (2611.11859)", () => {
  const { view, done } = mount(doc([
    "\\begin{equation}\\label{eq:cone}",
    "  s = \\begin{cases}",
    "    1,\\text{ if }x = 0; \\\\",
    "    \\text{arbitrary, otherwise.}\\footnotemark",
    "  \\end{cases}",
    "\\end{equation}\\footnotetext{No restriction.}",
  ].join("\n")));
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  assert.ok(!(view.contentDOM.textContent ?? "").includes("\\footnotemark"));
  assert.ok((view.contentDOM.textContent ?? "").includes("otherwise."));
  done();
});

test("`\\mathpalette\\cmd\\relax` with an `\\ooalign` overlay of a raised letter is drawn (2611.11859's `\\rgets`)", () => {
  const preamble = String.raw`\newcommand{\rgets}{\mathrel{\mathpalette\rgetscmd\relax}}
\newcommand{\rgetscmd}{\ooalign{$\leftarrow$\cr
    \hidewidth\raisebox{1.2\height}{\scalebox{0.5}{\ \rm R}}\hidewidth\cr}}%`;
  const { view, done } = mount(doc("The user samples $\\vec r \\rgets \\mathbb{F}_2^d$ and sends it.", preamble));
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  const text = view.contentDOM.textContent ?? "";
  assert.ok(text.includes("R") && text.includes("←"), text);
  assert.ok(!text.includes("mathpalette"), text);
  done();
  // The overlay forms KaTeX can draw; a different overlay is still left alone.
  assert.ok(renders(String.raw`x \mathrel{\mathpalette\ooalign{$\leftarrow$\cr\hidewidth\raisebox{1.2\height}{\scalebox{0.5}{\ \rm R}}\hidewidth\cr}\relax} y`));
  assert.ok(!renders(String.raw`\mathpalette\fooalign\relax`));
});

test("`\\zcsetup{…}` right after `\\begin{equation}` draws nothing in the formula (2611.07413)", () => {
  const { view, done } = mount(doc("\\begin{equation}\n\\zcsetup{reftype=Expression}\n  x^2 + y^2 = z^2.\n\\end{equation}"));
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  assert.ok(view.contentDOM.querySelector(".katex"));
  assert.ok(!(view.contentDOM.textContent ?? "").includes("zcsetup"));
  done();
});

test("a file the body inputs defines macros for the text after it, in the editor's source collection (2610.16732)", async () => {
  const files: Record<string, string> = {
    "nb/main.tex": String.raw`\documentclass{article}
\begin{document}
\subsection{Restricted Universe}
\input{generated/audit}
We use \CrcQPathCount\ paths and a tolerance $\CrcResetGateTolerance$.
\end{document}`,
    "nb/generated/audit.tex": String.raw`\providecommand{\CrcQPathCount}{100000}
\providecommand{\CrcResetGateTolerance}{2\times10^{-6}}`,
    "nb/generated/other.tex": String.raw`Only text here.`,
  };
  const text = files["nb/main.tex"];
  const bodyAt = text.indexOf("\\begin{document}");
  const { sources } = await collectMacroSources({
    filePath: "nb/main.tex", rootPath: "nb/main.tex", ownPreamble: text.slice(0, bodyAt), ownBody: text.slice(bodyAt), known: new Set(Object.keys(files)), readText: async (path) => files[path] ?? "", version: () => "1",
  });
  assert.deepEqual(sources.map((source) => [source.path, source.loadedBy, source.key]), [["nb/generated/audit.tex", "", "input:generated/audit"]]);
  const { view, done } = mount(text, sources);
  const shown = view.contentDOM.textContent ?? "";
  assert.ok(shown.includes("100000 paths"), shown);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  assert.ok(!shown.includes("\\Crc"), shown);
  done();
});
