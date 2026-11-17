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
import { setMacroSources, setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { expandLatexMacros } from "../../src/lib/latex/macros/expand";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Audit round 8, reading the user's macro definitions and expanding them: the project's include files (2611.21216),
 * `\include` in a preamble (2611.20202), a formula saved in a box (2611.03553), and unicode-math / `\restr` (2611.08668). */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

/** A project in memory: file name (without `nb/`) to text. Opens `file` as the editor does, with the sources its preamble loads. */
async function mountProject(files: Record<string, string>, file: string, root = "main.tex") {
  const known = new Set(Object.keys(files).map((name) => `nb/${name}`));
  const readText = async (path: string) => files[path.replace(/^nb\//, "")] ?? "";
  const doc = files[file];
  const begin = doc.search(/\\begin\{document\}/);
  const ownPreamble = doc.slice(0, Math.max(begin, 0));
  const { sources } = await collectMacroSources({ filePath: `nb/${file}`, rootPath: `nb/${root}`, ownPreamble, ownBody: doc.slice(ownPreamble.length), known, readText, version: () => "1" });
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport(file, "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  let state = EditorState.create({ doc, selection: { anchor: 0 }, extensions: [latexLanguageSupport(file, "tree"), latexVisualState(), latexVisualMode({ documentPath: `nb/${file}` })] });
  state = state.update({ effects: setMacroSources.of(sources) }).state;
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state, parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return { view, done: () => { view.destroy(); parent.remove(); for (const editor of document.querySelectorAll(".cm-vis-math-editor")) editor.remove(); } };
}

const mousedown = (node: Element, altKey = false) => node.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, altKey }));

/** Whether a mousedown on the widget put the caret in `[from, to]` or opened the formula editor on it, or its Alt-click shows the source. */
async function opensSource(view: EditorView, widget: Element, from: number, to: number) {
  const quiet = console.error;
  console.error = () => {};
  mousedown(widget);
  await new Promise((resolve) => setTimeout(resolve, 30));
  console.error = quiet;
  const head = view.state.selection.main.head;
  const plain = document.querySelector(".cm-vis-math-editor") !== null || (head >= from && head <= to) || [...view.state.field(structuralField).revealed.values()].some((range) => range.from <= from && range.to >= to);
  return plain;
}

const renders = (latex: string) => {
  try { katex.renderToString(forKatex(latex), { throwOnError: true, strict: "ignore", macros: { ...KATEX_MACROS } }); return true; } catch { return false; }
};

/** Every `$…$` of the document expanded with the editor's definitions, and whether KaTeX draws it. */
function expandedFormulas(view: EditorView) {
  const defs = visualDefinitions(view.state);
  const doc = view.state.doc.toString();
  return [...doc.matchAll(/\$([^$]+)\$/g)].map((match) => {
    const expanded = expandLatexMacros(match[1], defs, { mode: "math", pos: match.index });
    return { source: match[1], expanded, drawn: expanded.ok && renders(expanded.text) };
  });
}

const CS_LG_FILES = {
  "main.tex": String.raw`\documentclass{article}
\usepackage{amsmath}
\input{includes/base}
\input{includes/commands}
\input{includes/symbols}
\begin{document}
\input{files/background}
\end{document}`,
  "includes/base.tex": String.raw`\usepackage{bm}`,
  "includes/commands.tex": String.raw`\newcommand\MakeUppercaseGreek[1]{%%
  \begingroup
    \let\psi\Psi
    \let\omega\Omega
    \let\gamma\Gamma
    \MakeUppercase{#1}%%
  \endgroup}
\newcommand{\vectorsym}[1]{\bm{#1}}
\newcommand{\randomvec}[1]{\MakeUppercaseGreek{\bm{#1}}}
\newcommand{\brackets}[1]{\left(#1\right)}`,
  "includes/symbols.tex": String.raw`\newcommand{\R}[0]{\mathbb{R}}
\newcommand{\z}[0]{\vectorsym{z}}
\newcommand{\X}[0]{\randomvec{X}}
\newcommand{\qtipwidth}{V}`,
  "files/background.tex": String.raw`Let $\z\in\R^d$ be of width $\qtipwidth$ and $\X\sim\randomvec{Y}$ with $\brackets{\z}$.

\begin{equation}
  \z_i = \qtipwidth
\end{equation}
`,
};

test("a chapter reads its main file's extensionless \\input macro files: `[0]` commands, nested macros, \\MakeUppercase (2611.21216)", async () => {
  const { view, done } = await mountProject(CS_LG_FILES, "files/background.tex");
  try {
    const formulas = expandedFormulas(view);
    assert.equal(formulas.length, 4);
    for (const formula of formulas) assert.ok(formula.drawn, `${formula.source} -> ${formula.expanded.text}`);
    const text = view.contentDOM.textContent ?? "";
    assert.ok(!text.includes("\\z") && !text.includes("\\qtipwidth") && !text.includes("\\randomvec"), text);
    assert.ok(view.contentDOM.querySelectorAll(".cm-vis-math .katex").length >= 4, view.contentDOM.innerHTML.slice(0, 600));
  } finally { done(); }
});

test("a formula using a `[0]` macro from an extensionless \\input reveals its source when clicked (2611.21216)", async () => {
  const { view, done } = await mountProject(CS_LG_FILES, "files/background.tex");
  try {
    const doc = view.state.doc.toString();
    const widget = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-math")][0];
    assert.ok(widget);
    const from = doc.indexOf("$\\z");
    assert.ok(await opensSource(view, widget, from, from + "$\\z\\in\\R^d$".length));
    // Alt-click keeps showing the raw source.
    const again = await mountProject(CS_LG_FILES, "files/background.tex");
    mousedown([...again.view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-math")][0], true);
    assert.match(again.view.contentDOM.textContent ?? "", /\$\\z\\in\\R\^d\$/);
    again.done();
  } finally { done(); }
});

test("\\MakeUppercase{\\bm{Y}} in a formula changes the letters, not the commands (2611.21216)", () => {
  assert.ok(renders(String.raw`\MakeUppercase{\bm{y}}\sim\MakeUppercase{\mathbf{x}_1}`));
  assert.ok(renders(String.raw`\begingroup\let\psi\Psi\MakeUppercase{\bm{y}}\endgroup`));
});

const CS_RO_FILES = {
  "root.tex": String.raw`\documentclass{article}
\include{math_commands}
\begin{document}
As shown in (\Figref{fig:method}), the method works, see \Secref{sec:intro}.
\begin{figure}\caption{Method.}\label{fig:method}\end{figure}
\input{appendix}
\end{document}`,
  "math_commands.tex": String.raw`\def\Figref#1{Figure~\ref{#1}}
\def\Secref#1{Section~\ref{#1}}`,
  "appendix.tex": String.raw`\appendix
We show this in \Figref{fig:method}.`,
};

test("\\include{…} in the preamble loads that file's \\def commands for the main file and the appendix (2611.20202)", async () => {
  for (const file of ["root.tex", "appendix.tex"]) {
    const { view, done } = await mountProject(CS_RO_FILES, file, "root.tex");
    try {
      const text = view.contentDOM.textContent ?? "";
      assert.ok(!text.includes("\\Figref") && !text.includes("\\Secref"), `${file}: ${text}`);
      assert.match(text, /Figure/, file);
    } finally { done(); }
  }
});

test("a \\Figref text macro keeps a click path to its source (2611.20202)", async () => {
  const { view, done } = await mountProject(CS_RO_FILES, "root.tex", "root.tex");
  try {
    const doc = view.state.doc.toString();
    const from = doc.indexOf("\\Figref");
    const widgets = [...view.contentDOM.querySelectorAll<HTMLElement>("*")].filter((node) => node.contentEditable === "false" && (node.textContent ?? "").includes("Figure"));
    assert.ok(widgets.length, view.contentDOM.innerHTML.slice(0, 800));
    mousedown(widgets[0]);
    const { revealed } = view.state.field(structuralField);
    const head = view.state.selection.main.head;
    assert.ok([...revealed.values()].some((range) => range.from <= from && range.to > from) || (head >= from && head <= from + "\\Figref{fig:method}".length), `head ${head}`);
    assert.match(view.contentDOM.textContent ?? "", /\\Figref\{fig:method\}/);
  } finally { done(); }
});

const CT_FILES = {
  "main.tex": String.raw`\documentclass{article}
\usepackage{amsmath}
\usepackage[all]{xy}
\newsavebox{\xymor}
\newcommand{\xynode}{\makebox[0ex]{}}
\savebox{\xymor}{\ensuremath{%
		\xymatrix@1@C=19pt{\xynode \ar@{>}[r] & \xynode }}}
\newsavebox{\xydmor}
\savebox{\xydmor}{\ensuremath{%
		\xymatrix@1@C=19pt{\xynode \ar@{{}{-}_{>}}[r] & \xynode }}}
\newcommand{\mor}{\usebox{\xymor}}
\newcommand{\dmor}{\usebox{\xydmor}}
\begin{document}
Maps $f\colon A\mor B$ and $g\colon B\dmor C$.
\end{document}`,
};

test("\\usebox of a formula saved with \\savebox is that formula: a one-arrow xymatrix is a long arrow (2611.03553)", async () => {
  const { view, done } = await mountProject(CT_FILES, "main.tex");
  try {
    const [mor, dmor] = expandedFormulas(view);
    assert.ok(mor.drawn, `${mor.source} -> ${mor.expanded.text}`);
    assert.match(mor.expanded.text, /\\longrightarrow/);
    // The partial arrow (`\ar@{{}{-}_{>}}`) is not one KaTeX draws: it stays source, with its formula.
    assert.ok(!dmor.drawn);
    const widgets = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-math")];
    assert.equal(widgets.length, 1, view.contentDOM.innerHTML.slice(0, 800));
    assert.match(view.contentDOM.textContent ?? "", /\$g\\colon B\\dmor C\$/);
  } finally { done(); }
});

test("a \\usebox formula opens its source when clicked (2611.03553)", async () => {
  const { view, done } = await mountProject(CT_FILES, "main.tex");
  try {
    const doc = view.state.doc.toString();
    const from = doc.indexOf("$f\\colon");
    const widget = view.contentDOM.querySelector<HTMLElement>(".cm-vis-math")!;
    assert.ok(widget);
    assert.ok(await opensSource(view, widget, from, from + "$f\\colon A\\mor B$".length));
  } finally { done(); }
});

test("a saved box with a plain formula is that formula (\\sbox, 2611.03553's pattern)", async () => {
  const files = { "main.tex": String.raw`\documentclass{article}
\newsavebox{\bb}
\sbox{\bb}{$\mathbb{R}^n$}
\newcommand{\Rn}{\usebox{\bb}}
\begin{document}
Let $x\in\Rn$.
\end{document}` };
  const { view, done } = await mountProject(files, "main.tex");
  try {
    const [formula] = expandedFormulas(view);
    assert.ok(formula.drawn, formula.expanded.text);
    assert.match(formula.expanded.text, /\\mathbb\{R\}\^n/);
  } finally { done(); }
});

const OA_DOC = String.raw`\documentclass{article}
\usepackage{amsmath}
\usepackage[math-style=TeX,bold-style=ISO]{unicode-math}
\newcommand{\dom}{\operatorname{dom}}
\ifdefined\symbfit
  \let\bookboldvector\symbfit
\else
  \let\bookboldvector\boldsymbol
\fi
\newcommand{\bp}{\bookboldvector{p}}
\newcommand\restr[1]{\raisebox{-0.5ex}{\ensuremath{|_{#1}}}}
\begin{document}
Notice that $(1+\Delta)^{-1}\restr{\dom((1-\Delta)^{-1})}=1$ and $\omega(\bp):=(|\bp|^2+m^2)^{1/2}$.
\end{document}`;

test("`\\restr` (a raised \\ensuremath box) and `\\bp` (\\symbfit under unicode-math) are drawn (2611.08668)", async () => {
  const { view, done } = await mountProject({ "main.tex": OA_DOC }, "main.tex");
  try {
    const formulas = expandedFormulas(view);
    assert.equal(formulas.length, 2);
    for (const formula of formulas) assert.ok(formula.drawn, `${formula.source} -> ${formula.expanded.text}`);
    const text = view.contentDOM.textContent ?? "";
    assert.ok(!text.includes("\\restr") && !text.includes("\\bp"), text);
  } finally { done(); }
});
