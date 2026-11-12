import "./setup.cjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import katex from "katex";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { forKatex, KATEX_MACROS, loadMhchem, renderKatex } from "../../src/lib/latex/codemirror/visual/math-render";
import { setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Audit round 6, math and macro expansion: a preamble `\def` with delimited parameters that swallowed the whole body
 * (math.DG 2611.09697), `\m@th`/`\rlap`/`\raisebox` in a `:=` symbol, `\fint`, a `\tag{$\macro$}` seen by `\eqref` (math.AP
 * 2611.11553), `\multicolumn` with a grouped column spec in a math array (cs.PL 2610.26599), mhchem (math.NA 2611.09574),
 * `\reflectbox` arrows and `\MakeUppercase{\romannumeral2}` (math.DG 2611.09689), `\phantomsection` and algorithm2e keywords
 * in a formula (cs.IT 2611.09366), `\footnote` at the end of a display (econ.TH 2611.05417). No new widgets: the formulas are
 * the math widgets, whose click-to-source is checked on the footnote display. */

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

test("a preamble `\\def` with delimited parameters (`#1&#2\\\\#3&#4\\\\`) does not swallow the body (math.DG 2611.09697)", () => {
  const preamble = String.raw`\def\textmatrix#1&#2\\#3&#4\\{\bigl({#1 \atop #3}\ {#2 \atop #4}\bigr)}
\def\dispmatrix#1&#2\\#3&#4\\{\left({#1 \atop #3}\ {#2 \atop #4}\right)}
\def\pair#1:#2:#3.{(#1,#2,#3)}
\newcommand{\be}{\begin{equation}}
\newcommand{\ee}{\end{equation}}`;
  const { view, done } = mount(doc("Let $\\mathcal S$ be the class and \\emph{this} holds.\n\\[ a+b \\]", preamble));
  assert.equal(view.contentDOM.querySelectorAll(".katex").length, 2);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  const text = view.contentDOM.textContent ?? "";
  assert.ok(!text.includes("\\emph") && !text.includes("\\mathcal"), text);
  done();
});

test("the `:=` symbol built with `\\m@th`, `\\rlap` and `\\raisebox`, `\\upperInd` and `\\fint` are drawn (math.AP 2611.11553)", () => {
  const preamble = String.raw`\makeatletter
\newcommand*{\defeq}{\mathrel{\rlap{%
			\raisebox{0.3ex}{$\m@th\cdot$}}%
		\raisebox{-0.3ex}{$\m@th\cdot$}}%
	=}
\makeatother
\newcommand{\upperInd}[1]{^{(#1)}}
\usepackage{esint}`;
  const { view, done } = mount(doc("Let $y\\upperInd{1} \\defeq \\fint_{B} u\\,dx$ and\n\\begin{align*}\nA &\\defeq B\n\\end{align*}", preamble));
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  assert.equal(view.contentDOM.querySelectorAll(".katex").length, 2);
  const text = view.contentDOM.textContent ?? "";
  assert.ok(!text.includes("\\defeq") && !text.includes("\\upperInd") && !text.includes("\\fint") && !text.includes("m@th"), text);
  done();
});

test("`\\eqref` to an equation tagged `\\tag{$\\measConst$}` draws the macro's formula, not its source (math.AP 2611.11553)", () => {
  const { view, done } = mount(doc("\\begin{align}\nm &= 1,\\tag{$\\measConst$}\\label{eq:m}\n\\end{align}\nBy \\eqref{eq:m} we get $x$.", "\\newcommand{\\measConst}{\\mu_{\\mathrm{c}}}"));
  const chip = view.contentDOM.querySelector(".cm-vis-ref");
  assert.ok(chip, view.contentDOM.innerHTML);
  assert.ok(chip!.querySelector(".katex"), chip!.innerHTML);
  assert.ok(!(chip!.textContent ?? "").includes("$") && !(chip!.textContent ?? "").includes("\\measConst"), chip!.textContent ?? "");
  done();
});

test("`\\multicolumn{2}{@{}c@{}}{…}` and `\\begingroup … \\endgroup` around a math array are drawn (cs.PL 2610.26599)", () => {
  assert.ok(renders(String.raw`\begingroup
\renewcommand{\arraystretch}{1.15}
\begin{array}{@{}l@{\hspace{2.4em}}l@{}}
\multicolumn{2}{@{}c@{}}{
  \begin{array}{@{}l@{\hspace{1.1em}}l@{}}
  \mathsf{abs}(a) \triangleq b, & \mathsf{abs}(c) \triangleq d,
  \end{array}
}\\[2pt]
x \triangleq y & z \triangleq w, \\
u & v.
\end{array}
\endgroup`));
  const { view, done } = mount(doc("Then\n\\[\n\\begin{array}{@{}l@{\\hspace{2.4em}}l@{}}\n\\multicolumn{2}{@{}c@{}}{a \\triangleq b}\\\\\nx & y\n\\end{array}\n\\]\nholds."));
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  assert.ok(view.contentDOM.querySelector(".katex"));
  done();
});

test("`\\ce{Ru}` is drawn once KaTeX's mhchem is loaded (math.NA 2611.09574)", async () => {
  // Under tsx `import()` finds the extension's ESM build, which registers on another KaTeX than this CommonJS one.
  createRequire(import.meta.url)("katex/contrib/mhchem");
  await loadMhchem();
  const html = renderKatex("\\ce{RuO2}", false);
  assert.ok(html && html.includes("katex"), String(html));
  assert.ok(!html!.includes("\\ce"));
});

test("`\\reflectbox{\\ensuremath{\\mapsto}}` is the mirrored arrow and `\\textup{\\MakeUppercase{\\romannumeral2}}` is II (math.DG 2611.09689)", () => {
  assert.ok(renders(String.raw`j(1) \mathrel{\reflectbox{\ensuremath{\mapsto}}} j`));
  assert.ok(forKatex(String.raw`a \reflectbox{$\rightarrow$} b`).includes("\\leftarrow"));
  // An arrow whose mirror is not known stays as written (and so the formula stays source).
  assert.ok(forKatex(String.raw`a \reflectbox{\ensuremath{\foo}} b`).includes("\\reflectbox"));
  assert.ok(renders(String.raw`\langle \operatorname{\textup{\MakeUppercase{\romannumeral2}}}_S(e_i,e_j),a\rangle`));
  assert.ok(forKatex(String.raw`\textup{\MakeUppercase{\romannumeral4}} \romannumeral9`).includes("\\textup{IV} ix"));
  const { view, done } = mount(doc("\\[ \\langle \\II_S(e_i,e_j),a\\rangle = 0 \\]", "\\DeclareMathOperator{\\II}{\\textup{\\MakeUppercase{\\romannumeral2}}}"));
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  assert.ok(view.contentDOM.querySelector(".katex"));
  done();
});

test("`\\phantomsection` before a label in an equation, and algorithm2e keywords in a formula (cs.IT 2611.09366)", () => {
  const body = [
    "\\begin{equation}\\phantomsection\\label{eq-no-bit-errors}{ (1-p)^{bn}. }\\end{equation}",
    "\\begin{algorithm}",
    "\\SetKwFunction{FindErrors}{FindErrors}",
    "\\SetKwFunction{True}{True}",
    "\\KwIn{$E$}",
    "$P\\leftarrow \\FindErrors(E[i,:])$\\;",
    "\\end{algorithm}",
    "\\begin{itemize}",
    "\\item \\(\\FindErrors(\\mathbf{y})\\) returns \\(\\True\\) if it works.",
    "\\end{itemize}",
  ].join("\n");
  const { view, done } = mount(doc(body, "\\usepackage{algorithm2e}"));
  const text = view.contentDOM.textContent ?? "";
  assert.ok(!text.includes("\\phantomsection"), text);
  const item = [...view.contentDOM.querySelectorAll(".katex")].map((node) => node.textContent ?? "");
  assert.ok(item.some((value) => value.includes("FindErrors")), item.join("|"));
  assert.ok(item.some((value) => value.includes("True")), item.join("|"));
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  done();
});

test("a `\\footnote` at the end of a display is a mark, the display is one formula, and a click shows its source (econ.TH 2611.05417)", () => {
  const body = [
    "For any two measures,",
    "\\[",
    "    \\nu'\\succeq\\nu \\quad\\Longrightarrow\\quad F(\\nu')\\geq F(\\nu).\\footnote{We say $\\nu'\\succeq\\nu$ if $",
    " \\int f\\,d\\nu'\\ge\\int f\\,d\\nu$ for every bounded $f$.}",
    "\\]",
    "Next we have $z$.",
  ].join("\n");
  const { view, done } = mount(doc(body));
  assert.ok(renders("F(\\nu')\\geq F(\\nu).\\footnote{We say $\\nu$ if $x$.}"));
  const widgets = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-math")];
  // The display and the later `$z$`: the footnote's own `$…$` are not formulas of their own.
  assert.equal(widgets.length, 2, view.contentDOM.innerHTML);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  assert.ok(!(view.contentDOM.textContent ?? "").includes("\\footnote"));
  // Click-to-source: Alt-mousedown on the display puts the caret inside it (a plain click opens the formula editor).
  const source = view.state.doc.toString();
  const from = source.indexOf("\\[");
  const to = source.indexOf("\\]") + 2;
  widgets[0].dispatchEvent(new dom.window.MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true, altKey: true }));
  const head = view.state.selection.main.head;
  assert.ok(head > from && head < to, `caret ${head} not inside ${from}-${to}; length ${source.length}; widgets ${widgets.map((w) => w.className).join("|")}`);
  assert.ok((view.contentDOM.textContent ?? "").includes("\\footnote"));
  done();
});
