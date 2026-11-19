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

/* Audit round 10, math: `\o` in a formula (math.AC 2611.10064), extarrows' long arrows (math.KT 2610.27016), siunitx quantities with an
 * empty unit (cs.AR 2611.19101) and tikz-cd's older `\arrow[opts]{dir}{label}` (math.SP 2611.09610, math.AT 2611.11463). Every new rendering is checked for click-to-source. */

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

/** The text a document shows in its content, widgets included. */
const shown = (view: EditorView) => view.contentDOM.textContent ?? "";

/** Every non-editable widget, clicked in turn (plain, then Alt), must reveal its source. */
function everyWidgetOpens(text: string) {
  const { view, done } = mount(text);
  const nodes = [...view.contentDOM.querySelectorAll<HTMLElement>("*")].filter((node) => {
    if (node.contentEditable !== "false") return false;
    for (let up = node.parentElement; up && up !== view.contentDOM; up = up.parentElement) if (up.contentEditable === "false") return false;
    return true;
  });
  const failures: string[] = [];
  for (const node of nodes) {
    const pos = view.posAtDOM(node);
    for (const alt of [false, true]) {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      refreshVisualWidgets(view);
      node.dispatchEvent(new dom.window.MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true, altKey: alt }));
      const { revealed } = view.state.field(structuralField);
      const selection = view.state.selection.main;
      const opened = [...revealed.values()].some((range) => range.from <= pos && range.to >= pos) || (!selection.empty && selection.from <= pos && selection.to > pos);
      if (opened) break;
      if (alt) failures.push(`${node.className} at ${pos}`);
    }
  }
  done();
  return { count: nodes.length, failures };
}

test("`\\o` in a formula is the slashed o unless the document defines it (math.AC 2611.10064)", () => {
  assert.ok(renders(String.raw`(A,\o), K\cap {\o}^2\subset \o K, A/\o, \O`));
  const body = String.raw`Let $(A,\o)$ be regular and $K\cap {\o}^2\subset \o K$ with $A/\o$.`;
  const { view, done } = mount(doc(body));
  assert.equal(widgetsOf(view).length, 3);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  assert.ok(shown(view).includes("ø"), shown(view));
  const source = view.state.doc.toString();
  opensToSource(view, 0, source.indexOf("$(A"), source.indexOf("$ be") + 1);
  done();
  const own = mount(doc(String.raw`Let $(A,\o)$ be.`, String.raw`\newcommand{\o}{\mathfrak{m}}`));
  assert.ok(!shown(own.view).includes("ø"), shown(own.view));
  own.done();
});

test("extarrows' `\\xlongrightarrow{j^*}` is a stretchy arrow with its labels (math.KT 2610.27016)", () => {
  assert.ok(renders(String.raw`A \xlongrightarrow{j^*} B \xlongleftarrow[b]{a} C \xLongrightarrow{x} D \xLongleftrightarrow{y} E \xlongleftrightarrow{z} F`));
  const diagram = String.raw`\Ext_{a(1)}^{**}(H^*(B)) \xlongrightarrow{j^*} \Ext_{e(1)}^{**}(H^*(B))`;
  const body = String.raw`Then
\[ ${diagram}, \]
sends the classes.`;
  const { view, done } = mount(doc(body, String.raw`\usepackage{extarrows}\DeclareMathOperator{\Ext}{Ext}`));
  assert.equal(widgetsOf(view).length, 1);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  assert.ok(view.contentDOM.querySelector(".x-arrow"), view.contentDOM.innerHTML);
  const source = view.state.doc.toString();
  opensToSource(view, 0, source.indexOf("\\["), source.indexOf("\\]") + 2);
  done();
});

test("`\\qty{0.11}{}` with an empty unit is its number alone (cs.AR 2611.19101)", () => {
  const body = String.raw`Costs \qty{0.11}{} percentage points, \SI{2}{} more, $\qty{3}{}$ and \qty{5}{\percent}.`;
  const { view, done } = mount(doc(body, "\\usepackage{siunitx}"));
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  assert.ok(!shown(view).includes("\\qty") && !shown(view).includes("\\SI"), shown(view));
  assert.ok(shown(view).includes("0.11"), shown(view));
  done();
  assert.deepEqual(everyWidgetOpens(doc(body, "\\usepackage{siunitx}")).failures, []);
});

test("tikz-cd's older `\\arrow[hook]{r}{f}` with `{}` cells is drawn (math.SP 2611.09610)", () => {
  const diagram = String.raw`\begin{tikzcd}[column sep=large,row sep=large]
A \arrow[d] & {} & B \arrow[hook]{r}{f} & C \arrow{d}{g}\\
D & {} & E & F
\end{tikzcd}`;
  assert.ok(renders(diagram));
  const body = String.raw`Consider
\[
${diagram}
\]
done.`;
  const { view, done } = mount(doc(body));
  assert.equal(widgetsOf(view).length, 1);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  const source = view.state.doc.toString();
  opensToSource(view, 0, source.indexOf("\\["), source.indexOf("\\]") + 2);
  done();
});

test("a tikz-cd dashed diagonal stays source, a plain one is drawn: KaTeX has no dashed diagonal (math.AT 2611.11463)", () => {
  assert.ok(!renders(String.raw`\begin{tikzcd} & BO\arrow[d]\\ B\arrow[ur,dashed]\arrow[r,"\xi"'] & BG. \end{tikzcd}`));
  assert.ok(renders(String.raw`\begin{tikzcd} & BO\arrow[d]\\ B\arrow[ur]\arrow[r,"\xi"'] & BG \end{tikzcd}`));
});
