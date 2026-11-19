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
import { collectLatexDefinitions } from "../../src/lib/latex/macros/definitions";
import { expandLatexMacros } from "../../src/lib/latex/macros/expand";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Audit round 10, macro definitions and expansion: a `\def` the parser cannot read, data macros made with `\csname`, a built-in
 * command redefined with TikZ, an environment that is a `\def`. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

/** The definitions the editor holds for `file` of an in-memory project (file name without `nb/` to text). */
async function projectSources(files: Record<string, string>, file: string, root = file) {
  const known = new Set(Object.keys(files).map((name) => `nb/${name}`));
  const readText = async (path: string) => files[path.replace(/^nb\//, "")] ?? "";
  const doc = files[file];
  const begin = doc.search(/\\begin\{document\}/);
  const ownPreamble = doc.slice(0, Math.max(begin, 0));
  const { sources } = await collectMacroSources({ filePath: `nb/${file}`, rootPath: `nb/${root}`, ownPreamble, ownBody: doc.slice(ownPreamble.length), known, readText, version: () => "1" });
  return { sources, doc, bodyStart: begin };
}

async function projectDefinitions(files: Record<string, string>, file: string) {
  const { sources, doc, bodyStart } = await projectSources(files, file);
  return collectLatexDefinitions(sources, { text: doc, bodyStart });
}

async function mountProject(files: Record<string, string>, file: string) {
  const { sources, doc } = await projectSources(files, file);
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

const renders = (latex: string) => {
  try { katex.renderToString(forKatex(latex), { throwOnError: true, strict: "ignore", macros: { ...KATEX_MACROS } }); return true; } catch { return false; }
};

const mountText = async (doc: string, extra: Record<string, string> = {}) => mountProject({ "main.tex": doc, ...extra }, "main.tex");

/** Whether a click on `node` put the caret inside [from, to] or revealed that range as source. */
async function clickShowsSource(view: EditorView, node: Element, from: number, to: number) {
  mousedown(node);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const head = view.state.selection.main.head;
  const revealed = [...view.state.field(structuralField).revealed.values()].some((range) => range.from <= from && range.to >= to);
  // A formula opens its editor (MathLive) on a click, which holds its source.
  return (head >= from && head <= to) || revealed || document.querySelector(".cm-vis-math-editor") !== null;
}

test("one \\def with text before #1 does not blank the document: the autoref names of hyperref (nlin.SI 2610.32149)", async () => {
  const doc = String.raw`\documentclass{article}
\usepackage{hyperref}
\def\makeautorefname#1#2{\expandafter\def\csname#1autorefname\endcsname{#2}}
\def\equationautorefname~#1\null{(#1)\null}
\makeautorefname{footnote}{footnote}%
\makeautorefname{item}{item}%
\begin{document}
\section{Intro}
Some \emph{text} with $\alpha+\beta$ and a formula
\begin{equation}
\frac{1}{2}\sum_{i=1}^r \chi_i
\end{equation}
\end{document}
`;
  const { view, done } = await mountText(doc);
  try {
    const text = view.contentDOM.textContent ?? "";
    assert.ok(!text.includes("\\emph") && !text.includes("\\section") && !text.includes("\\begin{equation}"), text);
    assert.ok(view.contentDOM.querySelectorAll(".cm-vis-math .katex").length >= 2, view.contentDOM.innerHTML.slice(0, 600));
  } finally { done(); }
});

/** A paper's data macros: one `\expandafter\def\csname mpb@NAME\endcsname{VALUE}` per number, read by `\mpb{NAME}`. */
const DATA_FILES = {
  "main.tex": String.raw`\documentclass{article}
\makeatletter
\newcommand{\mpb}[1]{\@ifundefined{mpb@#1}{\textcolor{red}{\textbf{??#1}}}{\csname mpb@#1\endcsname}}
\makeatother
\input{generated/macros.tex}
\begin{document}
We ran \mpb{n.models} models scored \mpb{gemma.calc}\% and $p = \mpb{luna.px.det}$, $x = \mpb{range}$ and \mpb{missing.one}.
\end{document}`,
  "generated/macros.tex": String.raw`% Generated. Do not edit.
\expandafter\def\csname mpb@n.models\endcsname{12}
\expandafter\def\csname mpb@gemma.calc\endcsname{93.1}
\expandafter\gdef\csname mpb@luna.px.det\endcsname{0.03}
\expandafter\def\csname mpb@range\endcsname{2--10}
\expandafter\def\csname mpb@J.one.name\endcsname{Claude Fable 5.1}
\@namedef{mpb@named.value}{7{,}000}
`,
};

test("data macros made with \\csname are read and used with \\csname and \\@ifundefined (physics.med-ph 2611.05340)", async () => {
  const defs = await projectDefinitions(DATA_FILES, "main.tex");
  const text = (latex: string) => expandLatexMacros(latex, defs, { mode: "text" });
  assert.deepEqual([text(String.raw`\mpb{n.models}`).ok, text(String.raw`\mpb{n.models}`).text], [true, "12"]);
  assert.equal(text(String.raw`\mpb{J.one.name}`).text, "Claude Fable 5.1");
  assert.equal(text(String.raw`\mpb{named.value}`).text, "7{,}000");
  assert.equal(text(String.raw`\csname mpb@gemma.calc\endcsname\%`).text, "93.1\\%");
  // A name of the data family that is not defined takes the `\@ifundefined` branch: the author's red "??name" marker.
  assert.match(text(String.raw`\mpb{missing.one}`).text, /\\textcolor\{red\}\{\\textbf\{\?\?missing\.one\}\}/);
  // A name that is no data (LaTeX's own `c@page`) is not decided here.
  assert.equal(text(String.raw`\@ifundefined{c@page}{a}{b}`).ok, false);
  const math = expandLatexMacros(String.raw`p = \mpb{luna.px.det}`, defs, { mode: "math" });
  assert.ok(math.ok && math.text === "p = 0.03" && renders(math.text), math.text);
});

test("data macros are drawn in the text and in formulas, and a click shows the use as source (physics.med-ph 2611.05340)", async () => {
  const { view, done } = await mountText(DATA_FILES["main.tex"], { "generated/macros.tex": DATA_FILES["generated/macros.tex"] });
  try {
    const text = view.contentDOM.textContent ?? "";
    assert.ok(!text.includes("\\mpb") && !text.includes("@ifundefined"), text);
    assert.match(text, /We ran 12 models scored 93\.1%/);
    assert.match(text, /\?\?missing\.one/);
    const math = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-math")];
    assert.ok(math.length >= 2 && math.every((formula) => formula.querySelector(".katex")), view.contentDOM.innerHTML.slice(0, 600));
    const doc = view.state.doc.toString();
    const from = doc.indexOf("\\mpb{n.models}");
    const macro = view.contentDOM.querySelector<HTMLElement>(".cm-vis-macro");
    assert.ok(macro);
    assert.ok(await clickShowsSource(view, macro, from, from + "\\mpb{n.models}".length));
  } finally { done(); }
});

test("thousands of data macros are read quickly (physics.med-ph 2611.05340)", async () => {
  const lines = Array.from({ length: 4300 }, (_, n) => String.raw`\expandafter\def\csname mpb@k${n}.v\endcsname{${n}.5}`).join("\n");
  const files = { ...DATA_FILES, "generated/macros.tex": lines };
  const started = performance.now();
  const defs = await projectDefinitions(files, "main.tex");
  const elapsed = performance.now() - started;
  assert.equal(defs.dataMacros?.macros.size, 4300);
  assert.equal(expandLatexMacros(String.raw`\mpb{k4299.v}`, defs, { mode: "text" }).text, "4299.5");
  assert.ok(elapsed < 3000, `${elapsed} ms`);
});

test("a built-in command redefined with TikZ keeps its built-in meaning: \\underbrace (math.SP 2611.09610)", async () => {
  const files = {
    "main.tex": String.raw`\documentclass{article}
\usepackage{tikz}
\makeatletter
\def\underbrace#1{\@ifnextchar_{\tikz@@underbrace{#1}}{\tikz@@underbrace{#1}_{}}}
\def\tikz@@underbrace#1_#2{\tikz[baseline=(a.east)] {\node (a) {\(#1\)}; \draw[ultra thick,decorate,decoration={brace,amplitude=5pt}] (a.south east) -- node[below] {\(\scriptstyle #2\)} (a.south west);}}
\makeatother
\begin{document}
\begin{equation}
\Delta:=\underbrace{\partial_{q+1}(\partial_{q+1})^*}_{\Delta_{q,+}}+\underbrace{(\partial_q)^*\partial_q}_{\Delta_{q,-}}
\end{equation}
\end{document}`,
  };
  const defs = await projectDefinitions(files, "main.tex");
  assert.equal(defs.macros.get("underbrace"), undefined);
  const expanded = expandLatexMacros(String.raw`\underbrace{a+b}_{c}`, defs, { mode: "math" });
  assert.ok(expanded.ok && renders(expanded.text), expanded.text);
  const { view, done } = await mountText(files["main.tex"]);
  try {
    const math = view.contentDOM.querySelector<HTMLElement>(".cm-vis-math");
    assert.ok(math?.querySelector(".katex"), view.contentDOM.innerHTML.slice(0, 500));
    assert.ok(!(view.contentDOM.textContent ?? "").includes("\\underbrace"));
  } finally { done(); }
});

test("\\orcidlink of a project's own orcidlink.sty is the built-in mark, in text too, and a click shows it (nucl-ex 2611.08473)", async () => {
  const files = {
    "main.tex": String.raw`\documentclass{article}
\usepackage{orcidlink}
\begin{document}
D.A.H.~Abdallah\,\orcidlink{0000-0003-4768-2718}\,$^{\rm 133}$, S.~Acharya\,\orcidlink{0000-0002-9213-5329}\,$^{\rm 49}$.
\end{document}`,
    "orcidlink.sty": String.raw`\ProvidesPackage{orcidlink}
\RequirePackage{tikz}
\DeclareRobustCommand\orcidlink[1]{\begin{tikzpicture}[baseline] \fill[green] (0,0) circle (1ex); \end{tikzpicture}}
`,
  };
  const defs = await projectDefinitions(files, "main.tex");
  assert.equal(defs.macros.get("orcidlink"), undefined);
  const { view, done } = await mountText(files["main.tex"], { "orcidlink.sty": files["orcidlink.sty"] });
  try {
    const text = view.contentDOM.textContent ?? "";
    assert.ok(!text.includes("\\orcidlink"), text);
    const marks = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-symbol")].filter((node) => node.textContent === "iD");
    assert.equal(marks.length, 2);
    const doc = view.state.doc.toString();
    const from = doc.indexOf("\\orcidlink{0000-0003");
    assert.ok(await clickShowsSource(view, marks[0], from, from + "\\orcidlink{0000-0003-4768-2718}".length));
  } finally { done(); }
});

test("a rotated-arrow definition of stix's \\twoheaduparrow is drawn as the symbol (math.GN 2610.31059)", async () => {
  const files = {
    "main.tex": String.raw`\documentclass{article}
\makeatletter
\newcommand{\twoheaddownarrow}{\mathrel{\mathpalette\thd@arrow{}}}
\newcommand{\thd@arrow}[2]{\rotatebox[origin=c]{90}{$\m@th#1\twoheadleftarrow$}}
\newcommand{\twoheaduparrow}{\mathrel{\mathpalette\thd@arrowd{}}}
\newcommand{\thd@arrowd}[2]{\rotatebox[origin=c]{90}{$\m@th#1\twoheadrightarrow$}}
\makeatother
\begin{document}
$f \twoheaduparrow x$, $\twoheaduparrow\varepsilon$ and $A \twoheaddownarrow B$.
\end{document}`,
  };
  const defs = await projectDefinitions(files, "main.tex");
  for (const formula of [String.raw`f \twoheaduparrow x`, String.raw`\twoheaduparrow\varepsilon`, String.raw`A \twoheaddownarrow B`]) {
    const expanded = expandLatexMacros(formula, defs, { mode: "math" });
    assert.ok(expanded.ok && renders(expanded.text) && /[↟↡]/.test(expanded.text), `${formula} -> ${expanded.text}`);
  }
  const { view, done } = await mountText(files["main.tex"]);
  try {
    const math = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-math")];
    assert.equal(math.length, 3);
    assert.ok(math.every((formula) => formula.querySelector(".katex")));
    const doc = view.state.doc.toString();
    const from = doc.indexOf("$f \\twoheaduparrow x$");
    assert.ok(await clickShowsSource(view, math[0], from, from + 22));
  } finally { done(); }
});

test("an environment that is a \\def: \\begin{PRoof} draws the macro's text, its \\end is hidden, a click shows the source (cs.DM 2611.13813)", async () => {
  const doc = String.raw`\documentclass{article}
\def\Proof{\par\noindent{\textbf{Proof of Theorem 3.1}~}}
\def\PRoof{\par\noindent{\textbf{Proof of Claim 1}~}}
\def\[{\left[}
\def\]{\right]}
\begin{document}
\begin{Proof} We complete the proof.

\begin{PRoof}~To prove this claim.
\begin{eqnarray*}
a & = & \[28(L)-1\] + c
\end{eqnarray*}
\end{PRoof}

After.
\end{Proof}
\end{document}
`;
  const { view, done } = await mountText(doc);
  try {
    const text = view.contentDOM.textContent ?? "";
    assert.ok(!text.includes("\\begin{PRoof}") && !text.includes("\\end{PRoof}") && !text.includes("\\end{Proof}") && !text.includes("\\begin{Proof}"), text);
    assert.match(text, /Proof of Claim 1/);
    assert.match(text, /Proof of Theorem 3\.1/);
    const header = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-env-header-user")].find((node) => /Claim 1/.test(node.textContent ?? ""));
    assert.ok(header);
    const from = doc.indexOf("\\begin{PRoof}");
    assert.ok(await clickShowsSource(view, header, from, from + "\\begin{PRoof}".length));
  } finally { done(); }
});

test("a \\def whose name is a built-in environment's is not read as that environment: center stays the built-in (cs.DM 2611.13813)", async () => {
  const doc = String.raw`\documentclass{article}
\def\center{X}
\begin{document}
\begin{center}
hello
\end{center}
\end{document}
`;
  const { view, done } = await mountText(doc);
  try { assert.ok(!(view.contentDOM.textContent ?? "").includes("\\begin{center}")); } finally { done(); }
});
