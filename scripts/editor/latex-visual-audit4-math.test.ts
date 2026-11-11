import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { enumerateItemLabel } from "../../src/lib/latex/macros/numbering";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Audit round 4, math environments and list labels: eqnarray rows with `&\to&` (cond-mat.str-el 2611.09434), a cell of an
 * align KaTeX rejects (quant-ph 2611.13347), revtex's widetext pairing across build pieces (2611.09434), and enumitem labels
 * written with formulas, `label=$(\square_{\arabic*})$` (math.CO 2611.13390). */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function visualState(doc: string) {
  let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" })] });
  ensureSyntaxTree(state, doc.length, 5000);
  for (let guard = 0; state.field(structuralField).pending.length && guard < 500; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

function mount(doc: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return { view, done: () => { view.destroy(); parent.remove(); } };
}

const doc = (body: string, preamble = "") => `\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;

test("an eqnarray row `&\\to&` keeps its command apart from the next letter (2611.09434)", () => {
  const { view, done } = mount(doc([
    "\\begin{enumerate}",
    "\\item Note that $x$, and since",
    "\\begin{eqnarray}",
    "  \\tilde{L}_\\alpha\\tilde{\\rho}_s&=&\\tilde{L}_\\alpha P_m\\nonumber\\\\",
    "  &\\to&P_{m-1}\\tilde{\\rho}P_{n-1}\\equiv \\tilde{\\rho}_{s-2},",
    "  \\label{eq:rules}",
    "\\end{eqnarray}",
    "one obtains done.",
    "\\end{enumerate}",
  ].join("\n")));
  const text = view.contentDOM.textContent ?? "";
  assert.ok(text.includes("→"), text);
  assert.ok(!/\\to|\\tilde|&|\\nonumber/.test(text), text);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  done();
});

test("an align cell with an undefined macro is the only source in its row; no stray `&` (2611.13347)", () => {
  const { view, done } = mount(doc("\\begin{align*}\n  x &= y \\\\\n  &\\bbone_\\texttt{A}\\P{\\sigma^{00}} \\\\\n  z &= \\boxed{\\bC Z}\n\\end{align*}"));
  const sources = [...view.contentDOM.querySelectorAll(".cm-vis-math-source")].map((node) => node.textContent);
  assert.deepEqual(sources, ["\\bbone_\\texttt{A}\\P{\\sigma^{00}}", "= \\boxed{\\bC Z}"]);
  assert.ok(!(view.contentDOM.textContent ?? "").includes("&"));
  done();
});

test("every `\\end{widetext}` is folded whatever piece the build splits at", () => {
  const block = ["\\begin{widetext}", "\\begin{eqnarray}", "a&=&b", "\\end{eqnarray}", "\\end{widetext}"].join("\n");
  for (const padding of [9000, 11000, 12950, 14100, 16400, 19000]) {
    const filler = Array.from({ length: Math.ceil(padding / 60) }, (_, i) => `Filler line ${i} of plain prose that fills the document up.`).join("\n");
    const text = doc(`${filler}\n${block}\nmid\n${block}\n${filler}\n${block}`);
    const state = visualState(text);
    const shown = state.field(structuralField).shown;
    for (const match of text.matchAll(/\\end\{widetext\}/g)) {
      let covered = false;
      shown.between(match.index!, match.index! + 1, (from, to, decoration) => { if (decoration.point && from <= match.index! && to > match.index!) covered = true; });
      assert.ok(covered, `padding ${padding}: \\end{widetext} at ${match.index} is source`);
    }
  }
});

test("enumitem labels with formulas are drawn as math, literal ones are not read as counters (2611.13390)", () => {
  assert.equal(enumerateItemLabel(2, 1, "label=$(\\square_{\\arabic*})$"), "$(\\square_{2})$");
  assert.equal(enumerateItemLabel(3, 1, "label=$(\\star)$"), "$(\\star)$");
  assert.equal(enumerateItemLabel(1, 1, "label=$(\\diamond_{2.1})$"), "$(\\diamond_{2.1})$");
  assert.equal(enumerateItemLabel(12, 1, "label=$(L_{\\arabic*})$"), "$(L_{12})$");
  assert.equal(enumerateItemLabel(3, 1, "label=(\\roman*)"), "(iii)");
  assert.equal(enumerateItemLabel(2, 1, "label={\\Alph*.}"), "B.");
  assert.equal(enumerateItemLabel(2, 1, "label=\\textbf{\\alph*)}, leftmargin=*"), "\\textbf{b)}");
  assert.equal(enumerateItemLabel(2, 1, "label=(a)"), "(a)");
  // enumerate's short form still counts.
  assert.equal(enumerateItemLabel(2, 1, "(a)"), "(b)");
  assert.equal(enumerateItemLabel(3, 1, "(i)"), "(iii)");
});

const LIST = (options: string, items = ["first", "second"]) => `\\begin{enumerate}[${options}]\n${items.map((item) => `\\item ${item}`).join("\n")}\n\\end{enumerate}`;

test("list markers with math labels show KaTeX, never `$…$`, and a click opens their source", () => {
  const { view, done } = mount(doc([
    LIST("label=$(\\square_{\\arabic*})$"),
    LIST("label=$(\\star)$", ["only"]),
    LIST("label=(\\roman*)"),
    "\\begin{enumerate}\n\\item[$(\\dagger)$] given\n\\item[(x)] plain\n\\end{enumerate}",
  ].join("\n"), "\\usepackage{enumitem}"));
  const markers = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-item")];
  const texts = markers.map((marker) => (marker.textContent ?? "").replace(/[\u200b\u2063]/g, ""));
  assert.ok(!texts.some((text) => text.includes("$")), texts.join("|"));
  assert.equal(markers.filter((marker) => marker.querySelector(".katex")).length, 4);
  assert.ok(texts.includes("(i)") && texts.includes("(ii)") && texts.includes("(x)"), texts.join("|"));
  // Click-to-source: mousedown on a math marker puts the caret inside its `\item` and the marker gives way to the source.
  const source = view.state.doc.toString();
  const star = markers[2];
  assert.ok(star);
  const before = view.contentDOM.querySelectorAll(".cm-vis-item").length;
  star!.dispatchEvent(new dom.window.MouseEvent("mousedown", { button: 0, bubbles: true }));
  const head = view.state.selection.main.head;
  const itemAt = source.indexOf("\\item only");
  assert.ok(head > itemAt - 2 && head <= itemAt + "\\item".length, `caret ${head} not in the item at ${itemAt}`);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-item").length, before - 1);
  // The `\item[$(\dagger)$]` marker too (a label written in the item).
  const written = view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-item")[4];
  assert.ok(written);
  written!.dispatchEvent(new dom.window.MouseEvent("mousedown", { button: 0, bubbles: true }));
  const open = source.indexOf("\\item[$(\\dagger)$]");
  assert.ok(view.state.selection.main.head > open && view.state.selection.main.head < open + "\\item[$(\\dagger)$]".length);
  done();
});

test("a label formula KaTeX or the fragment cannot draw stays as written", () => {
  const { view, done } = mount(doc(`${LIST("label=$(\\nosuchcommand_{\\arabic*})$")}\n${LIST("label=\\color{red}\\arabic*.")}`, "\\usepackage{enumitem}"));
  const markers = [...view.contentDOM.querySelectorAll(".cm-vis-item")];
  assert.equal(markers.length, 4);
  assert.equal(markers.filter((marker) => marker.querySelector(".katex")).length, 0);
  done();
});

test("a reference to an item with a math label draws the math, also inside a minipage (2611.13390)", () => {
  const body = [
    "\\begin{enumerate}[label=$(\\dagger_{\\arabic*})$]",
    "\\item\\label{item:a} one",
    "\\item\\label{item:b} two",
    "\\end{enumerate}",
    "See item \\cref{item:b} here.",
    "\\begin{minipage}[c]{0.67\\textwidth}",
    "On the other hand, item \\cref{item:b} implies the claim.",
    "\\end{minipage}",
  ].join("\n");
  const { view, done } = mount(doc(body, "\\usepackage{enumitem}\\usepackage{cleveref}"));
  const text = view.contentDOM.textContent ?? "";
  assert.ok(!text.includes("$"), text);
  const chips = [...view.contentDOM.querySelectorAll(".cm-vis-ref")];
  assert.ok(chips.length >= 1 && chips.every((chip) => chip.querySelector(".katex")), chips.map((chip) => chip.innerHTML).join("\n"));
  done();
});
