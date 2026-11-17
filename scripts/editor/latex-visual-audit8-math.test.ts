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

/* Audit round 8, math: accents over a font command (physics.plasm-ph 2611.11343), colour boxes with `$` inside formulas (cs.LO 2611.10842),
 * a tabular in an align (econ.TH 2611.05701), `\eqno` (math.GR 2611.14085), `\lambdabar` (nucl-th 2611.13953),
 * `\lhook\joinrel\longrightarrow` (math.AG 2611.18357), `\dh` (gr-qc 2611.18827), `\EuScript` and `\glsadd` (math.OA 2611.08668).
 * Every new rendering is checked for click-to-source. */

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

/** An Alt-click on the formula widget at `index` (a plain click opens the formula editor) opens its source, the caret inside `[from, to]`. */
function opensToSource(view: EditorView, index: number, from: number, to: number) {
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  refreshVisualWidgets(view);
  const widget = widgetsOf(view)[index];
  assert.ok(widget, `no widget ${index}`);
  click(widget, true);
  const head = view.state.selection.main.head;
  assert.ok(head >= from && head <= to, `caret ${head} not in ${from}-${to}`);
}

test("an accent over a font command with an unbraced letter, `\\breve \\mathcal P(E)`, is read as TeX does (physics.plasm-ph 2611.11343)", () => {
  assert.ok(renders(String.raw`\breve \mathcal P(E)`));
  assert.ok(renders(String.raw`\hat\mathbf x + \bar \mathrm{ab} + \tilde\mathcal C_n + \vec\boldsymbol\alpha`));
  const body = String.raw`Let $\breve \mathcal P(E)$ be the profile.
\begin{eqnarray}
\breve \mathcal P(E)  &=&  \breve P(\Omega(E)) \omega(E)
\end{eqnarray}`;
  const { view, done } = mount(doc(body));
  assert.equal(widgetsOf(view).length, 2, view.contentDOM.innerHTML);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  assert.ok(!(view.contentDOM.textContent ?? "").includes("\\breve"));
  const source = view.state.doc.toString();
  opensToSource(view, 1, source.indexOf("\\begin{eqnarray}"), source.indexOf("\\end{eqnarray}") + 14);
  done();
});

test("`\\colorbox{…}{$0$}` inside `$…$` and an `align*` keeps the formula in one piece (cs.LO 2611.10842)", () => {
  const body = String.raw`We have $(p_1,p_2) = (\colorbox{red!40}{$0$},\colorbox{blue!40}{$1$})$ and $x$, thus
{\scriptsize\fboxsep2pt
\begin{align*}
W^t &= \left( \begin{pmatrix} e_1(\colorbox{red!40}{$0$}\colorbox{blue!40}{$0$}) & e_1(\colorbox{red!40}{$0$}\colorbox{blue!40}{$1$}) \\ e_1(\fcolorbox{red}{blue!20}{$1$}) & 1 \end{pmatrix} \right)
\end{align*}}
Done.`;
  const { view, done } = mount(doc(body));
  const widgets = widgetsOf(view);
  // The inline formula, `$x$`, and the display.
  assert.equal(widgets.length, 3, view.contentDOM.innerHTML);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  const text = view.contentDOM.textContent ?? "";
  assert.ok(!text.includes("\\colorbox") && !text.includes("$"), text);
  const source = view.state.doc.toString();
  opensToSource(view, 0, source.indexOf("$(p_1"), source.indexOf("$ and $x$") + 1);
  opensToSource(view, 2, source.indexOf("\\begin{align*}"), source.indexOf("\\end{align*}") + 12);
  done();
});

test("a colour box with `$` in the text keeps the grammar's reading there (cs.LO 2611.10842)", () => {
  const { view, done } = mount(doc(String.raw`Text \colorbox{yellow}{$y$} in a sentence, and $z$.`));
  assert.equal(widgetsOf(view).length, 2, view.contentDOM.innerHTML);
  done();
});

test("a simple tabular inside an `align*` is an array, never raw `\\begin{tabular}` text (econ.TH 2611.05701)", () => {
  const body = String.raw`The payoffs are
\begin{align*}
\begin{tabular}{c|ccc}
\text{designer's $u$} & $\omega_1$ & $\omega_2$ & $\omega_3$ \\ \hline
$a_1$       & $1$        & $1$        & $1$        \\
$a_2$       & $0$        & $2$        & $\text{x}$
\end{tabular}
\end{align*}
Next.`;
  const { view, done } = mount(doc(body));
  assert.equal(widgetsOf(view).length, 1, view.contentDOM.innerHTML);
  assert.ok(widgetsOf(view)[0].querySelector(".mtable"), widgetsOf(view)[0].innerHTML.slice(0, 300));
  const text = view.contentDOM.textContent ?? "";
  assert.ok(!text.includes("tabular") && !text.includes("\\hline"), text);
  const source = view.state.doc.toString();
  opensToSource(view, 0, source.indexOf("\\begin{align*}"), source.indexOf("\\end{align*}") + 12);
  done();
});

test("a tabular KaTeX cannot be given as an array is never drawn as raw text in a display (econ.TH 2611.05701)", () => {
  const { view, done } = mount(doc(String.raw`\begin{align*}
a &= b \\
\begin{tabular}{l}\begin{itemize}\item x\end{itemize}\end{tabular}
\end{align*}`));
  for (const widget of widgetsOf(view)) assert.ok(!(widget.textContent ?? "").includes("tabular"), widget.textContent ?? "");
  done();
});

test("`\\eqno\\hbox{\\qedsymbol}` at the end of an `equation*` is a right-hand mark, drawn (math.GR 2611.14085)", () => {
  const body = String.raw`\begin{equation*}
\forall h \exists \lambda\in \CC : h * \fhi = \lambda \fhi. \eqno\hbox{\qedsymbol}
\end{equation*}
After.`;
  const { view, done } = mount(doc(body, "\\usepackage{amsthm}\\newcommand{\\CC}{\\mathbb C}\\newcommand{\\fhi}{\\varphi}"));
  assert.equal(widgetsOf(view).length, 1, view.contentDOM.innerHTML);
  assert.ok(widgetsOf(view)[0].querySelector(".tag"), widgetsOf(view)[0].innerHTML.slice(-300));
  assert.ok(!(view.contentDOM.textContent ?? "").includes("eqno"));
  const source = view.state.doc.toString();
  opensToSource(view, 0, source.indexOf("\\begin{equation*}"), source.indexOf("\\end{equation*}") + 15);
  assert.equal(renders(String.raw`a \eqno(1) b \\ c`), false, "an `\\eqno` that does not end the formula stays source");
  done();
});

test("`\\eqno` in an `equation*` inside a lemma's list item is drawn too (math.GR 2611.14085)", () => {
  const body = String.raw`\begin{lem}
The following hold.
\begin{enumerate}
\item $\fhi$ is bi-$K$-invariant.
\item $\fhi$ is an eigenvector for $\cpct(K, \CC)$:
\begin{equation*}
\forall h \in \cpct(K\backslash G/K, \CC) \ \exists \lambda\in \CC : h * \fhi = \lambda \fhi. \eqno\hbox{\qedsymbol}
\end{equation*}\label{pt:sph:eigen}
\end{enumerate}
\end{lem}`;
  const preamble = "\\usepackage{amsmath,amsthm,mathrsfs}\\newtheorem{lem}{Lemma}\\newcommand*{\\sC}{\\mathscr{C}}\\newcommand*{\\cpct}{\\sC_{\\mathrm{c}}}\\newcommand*{\\CC}{\\mathbf{C}}\\newcommand*{\\fhi}{\\varphi}";
  const { view, done } = mount(doc(body, preamble));
  const display = widgetsOf(view).find((widget) => widget.querySelector(".tag"));
  assert.ok(display, view.contentDOM.innerHTML.slice(-1500));
  assert.ok(!(view.contentDOM.textContent ?? "").includes("eqno"));
  done();
});

test("`\\lambdabar`, `\\lhook\\joinrel\\longrightarrow`, `\\dh`, `\\EuScript` and `\\glsadd` are drawn (nucl-th 2611.13953, math.AG 2611.18357, gr-qc 2611.18827, math.OA 2611.08668)", () => {
  assert.ok(renders(String.raw`\sigma=\pi\lambdabar^2(2L+1)`));
  assert.ok(renders(String.raw`A \lhook\joinrel\longrightarrow B \qquad C \lhook\joinrel\xrightarrow{f} D`));
  assert.ok(renders(String.raw`\bar{\text{\dh}} \phi + \text{\dh}\psi + \text{\DH}`));
  assert.ok(renders(String.raw`\EuScript{F} \otimes \EuScript F`));
  assert.ok(renders(String.raw`a\glsadd{x} + b`));
  const body = String.raw`\begin{align}
\ethb \eth \sigma &= \lambdabar \EuScript{F} \glsadd{x}\\
A &\lhook\joinrel\longrightarrow B
\end{align}`;
  const { view, done } = mount(doc(body, "\\newcommand{\\eth}{\\text{\\dh}}\\newcommand{\\ethb}{\\bar{\\text{\\dh}}}"));
  assert.equal(widgetsOf(view).length, 1, view.contentDOM.innerHTML);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  assert.ok(!/\\[a-zA-Z]{2,}/.test(widgetsOf(view)[0].textContent ?? ""), widgetsOf(view)[0].textContent ?? "");
  const source = view.state.doc.toString();
  opensToSource(view, 0, source.indexOf("\\begin{align}"), source.indexOf("\\end{align}") + 11);
  done();
});
