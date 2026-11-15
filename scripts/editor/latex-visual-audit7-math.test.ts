import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import katex from "katex";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { forKatex, KATEX_MACROS } from "../../src/lib/latex/codemirror/visual/math-render";
import { setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Audit round 7, math: `\chardef` switches read by `\ifnum` in the preamble (math.AP 2611.14954), mathtools' `\MoveEqLeft`
 * and a user alias of `equation` (math.PR 2611.15228), `\mathbbl` (stat.ME 2611.14011), old font switches in `\text`
 * (math.AP 2611.14951), `\xymatrix` (math.GT 2611.08002). Every new rendering is checked for click-to-source. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function visualState(text: string) {
  let state = EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" })] });
  ensureSyntaxTree(state, text.length, 5000);
  for (let guard = 0; state.field(structuralField).pending.length && guard < 500; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

function mount(text: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(text), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return { view, done: () => { view.destroy(); parent.remove(); } };
}

const doc = (body: string, preamble = "") => `\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;
const renders = (latex: string) => {
  try { katex.renderToString(forKatex(latex), { throwOnError: true, strict: "ignore", macros: { ...KATEX_MACROS } }); return true; } catch { return false; }
};
const widgetsOf = (view: EditorView) => [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-math")];
const click = (el: HTMLElement, alt = true) => el.dispatchEvent(new dom.window.MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true, altKey: alt }));

test("`\\chardef\\showllabel=0` decides `\\ifnum\\showllabel=1` so `\\llabel` is defined, and the display is a formula (math.AP 2611.14954)", () => {
  const preamble = String.raw`\chardef\showllabel=0
\usepackage{amsmath}`;
  const defs = String.raw`\def\inon#1{\hbox{\ \ \ \ \ \ \ }\hbox{#1}}
\def\indeq{\quad{}}
\def\comma{ {\rm ,\qquad{}} }
\def\les{\lesssim}
\def\tt{\langle t\rangle}
\def\gg{G}
\ifnum\showllabel=1
 \def\llabel#1{\marginnote{\color{lightgray}\rm\small(#1)}[-0.0cm]\notag}
\else
 \def\llabel#1{\notag}
\fi`;
  const body = String.raw`${defs}
Text.
\begin{equation}
  (v_k - \psi_k)a_{jk}n_j = 0
  \inon{on $\partial \Omega$,}
  \label{EQ03}
\end{equation}
\begin{equation}
  \limsup_{t \to T} \|D^k\omega(t)\|_{L^\infty} = \infty \comma k \geq 1 . \llabel{EQ10a}
\end{equation}
\begin{align}
  a &\les \tt \\ &\indeq\indeq \gg
\end{align}`;
  const { view, done } = mount(doc(body, preamble));
  const text = view.contentDOM.textContent ?? "";
  assert.ok(!text.includes("\\llabel{") && !text.includes("\\inon"), text);
  assert.equal(widgetsOf(view).length, 3, view.contentDOM.innerHTML);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  // Click-to-source on the first display.
  const source = view.state.doc.toString();
  const from = source.indexOf("\\begin{equation}");
  const to = source.indexOf("\\end{equation}") + 14;
  click(widgetsOf(view)[0]);
  const head = view.state.selection.main.head;
  assert.ok(head > from && head < to, `caret ${head} not in ${from}-${to}`);
  done();
});

test("mathtools' `\\MoveEqLeft` opens the first row of an align: the row is drawn, the command never (math.PR 2611.15228)", () => {
  const body = String.raw`\begin{align*}
\MoveEqLeft
    \partial^{\beta} u(x) - \partial^{\beta} u(y)
    \\&= \sum_{l=1}^{k} a_l
\end{align*}
\begin{align}\label{eq:x}
    \MoveEqLeft[3] a \\ &\le b
\end{align}`;
  const { view, done } = mount(doc(body, "\\usepackage{mathtools}"));
  const widgets = widgetsOf(view);
  assert.equal(widgets.length, 2, view.contentDOM.innerHTML);
  assert.ok(!(view.contentDOM.textContent ?? "").includes("MoveEqLeft"));
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  const source = view.state.doc.toString();
  click(widgets[0]);
  const head = view.state.selection.main.head;
  assert.ok(head > source.indexOf("\\begin{align*}") && head < source.indexOf("\\end{align*}") + 12, `caret ${head}`);
  assert.ok((view.contentDOM.textContent ?? "").includes("MoveEqLeft"));
  done();
});

test("`equ` from mhequ, and a `\\newenvironment` alias of `equation`, are numbered display equations that open to source (math.PR 2611.15228)", () => {
  const body = String.raw`\begin{equ}\label{eq:SPDE}
    \partial_t u = \xi,
\end{equ}
Between.
\begin{equ}
    a = b
\end{equ}`;
  for (const preamble of ["\\usepackage{mhequ}", "\\newenvironment{equ}{\\begin{equation}}{\\end{equation}}"]) {
    const { view, done } = mount(doc(body, preamble));
    const widgets = widgetsOf(view);
    assert.equal(widgets.length, 2, `${preamble}: ${view.contentDOM.innerHTML}`);
    assert.ok(!(view.contentDOM.textContent ?? "").includes("\\begin{equ}"), preamble);
    assert.ok(widgets.every((widget) => /\(\d\)/.test(widget.textContent ?? "") || widget.querySelector(".eqn-num") || widget.classList.contains("cm-vis-math-numbered")), `${preamble}: not numbered ${widgets[0].outerHTML.slice(-300)}`);
    const source = view.state.doc.toString();
    click(widgets[1]);
    const head = view.state.selection.main.head;
    const from = source.lastIndexOf("\\begin{equ}");
    assert.ok(head > from && head < source.lastIndexOf("\\end{equ}") + 9, `${preamble}: caret ${head}`);
    assert.ok((view.contentDOM.textContent ?? "").includes("\\begin{equ}"), preamble);
    done();
  }
});

test("`\\DeclareSymbolFontAlphabet{\\mathbbl}{bbold}` makes `\\mathbbl d` a blackboard-bold d, drawn with `\\mathbb` (stat.ME 2611.14011)", () => {
  const preamble = "\\usepackage{mathbbol}\n\\DeclareSymbolFontAlphabet{\\mathbbl}{bbold}";
  const body = "We suppose $(\\mathcal V, \\mathbbl d)$ is a space with $\\mathbbl d(v,w)=0$.\n\\begin{equation}\nM(x,r) = \\max_y \\mathbbl d(\\xi(y),\\xi(x))\n\\end{equation}";
  const { view, done } = mount(doc(body, preamble));
  assert.equal(widgetsOf(view).length, 3, view.contentDOM.innerHTML);
  assert.ok(!(view.contentDOM.textContent ?? "").includes("\\mathbbl"));
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  const source = view.state.doc.toString();
  click(widgetsOf(view)[2]);
  const head = view.state.selection.main.head;
  assert.ok(head > source.indexOf("\\begin{equation}") && head < source.indexOf("\\end{equation}"), `caret ${head}`);
  done();
});

test("LaTeX 2e font switches in `\\text{}` (`\\normalfont`, `\\itshape`) draw, `\\it` already did (math.AP 2611.14951)", () => {
  assert.ok(renders("\\text{\\normalfont (EGCC)} \\left\\{ \\begin{aligned} & \\text{\\it for every } r>0 \\text{ \\itshape there exists } t_r > 0 \\end{aligned} \\right."));
  assert.ok(renders("\\text{\\upshape a}\\text{\\bfseries b}\\text{\\slshape c}\\text{\\rmfamily d}\\text{\\sffamily e}\\text{\\ttfamily f}"));
  const body = "\\begin{equation*}\n\\text{\\normalfont (EGCC)}\n\\left\\{\n\\begin{aligned}\n & \\text{\\it for every } r>0 \\text{ \\it there exists } t_r > 0\\\\\n& \\text{\\it or leaves } B(0,r)\n\\end{aligned}\n\\right.\n\\end{equation*}";
  const { view, done } = mount(doc(body));
  assert.equal(widgetsOf(view).length, 1, view.contentDOM.innerHTML);
  assert.ok(!(view.contentDOM.textContent ?? "").includes("\\normalfont"));
  done();
});

test("xy's `^-{f}` label (tight against the arrow) is an arrow label, and the diagram opens to source (math.GT 2611.08002)", () => {
  const body = "Consider\n\\[\\xymatrix{P \\ar[r]^-{f_0^{n+k}} & f_0^{n+k}(P) \\subseteq f_0^n(P) \\ar[r]^-{g} & Q \\\\ K \\ar[u] \\ar[rr]^{h} & & K \\ar[u]}\\]\nand $\\check{H}^*(K)$ as\n\\begin{equation}\\label{eq:l}\\xymatrix{H & \\ar[l]_-{f^*} H & \\ar[l]_{f} \\ldots}\\end{equation}";
  const { view, done } = mount(doc(body));
  const widgets = widgetsOf(view);
  assert.equal(widgets.length, 3, view.contentDOM.innerHTML);
  assert.ok(!(view.contentDOM.textContent ?? "").includes("\\xymatrix"));
  const source = view.state.doc.toString();
  click(widgets[0]);
  const head = view.state.selection.main.head;
  assert.ok(head > source.indexOf("\\[") && head < source.indexOf("\\]") + 2, `caret ${head}`);
  assert.ok((view.contentDOM.textContent ?? "").includes("\\xymatrix"));
  done();
});

test("an `equ` the document defines as something else is not an equation", () => {
  const body = String.raw`\begin{equ}
    a = b
\end{equ}`;
  const { view, done } = mount(doc(body, "\\usepackage{mhequ}\n\\newenvironment{equ}{\\begin{center}}{\\end{center}}"));
  assert.equal(widgetsOf(view).length, 0);
  done();
});
