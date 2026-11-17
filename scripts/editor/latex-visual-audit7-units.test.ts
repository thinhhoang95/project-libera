import "./setup.cjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { loadMhchem } from "../../src/lib/latex/codemirror/visual/math-render";
import { setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { readSiunitx, siunitxConfig } from "../../src/lib/latex/codemirror/visual/siunitx";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Audit round 7, siunitx and mhchem: the units a paper writes as siunitx 3 abbreviations (`\mm`, `\ml`, `\mol`, `\eV`,
 * cond-mat.mes-hall 2611.13235, physics.flu-dyn 2611.12193), a unit's power (`\angstrom^{-1}`), the document's own
 * `\DeclareSIUnit` over the package's and its `\sisetup` (per-mode, range-units, list separators), `\qtyproduct`
 * (physics.optics 2611.13800), `\SI` inside `$…$`, and mhchem's `\ce{…}` in running text (2611.13800, cond-mat.mtrl-sci
 * 2611.14809). The widgets are the inline math widgets: a plain mousedown reveals the source (or opens the formula
 * editor), Alt-mousedown always reveals it. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function visualState(text: string) {
  let state = EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" })] });
  ensureSyntaxTree(state, text.length, 5000);
  // The finished tree is only in the parse context until a transaction goes through: `syntaxTree(state)` (what numbering and the builds read) is the
  // short one the first 20 ms of parsing made, on a busy machine. Run an empty one so the state carries the whole tree.
  state = state.update({}).state;
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
  assert.equal(syntaxTree(view.state).length, text.length, "the view starts from the whole parse tree");
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return { view, done: () => { view.destroy(); parent.remove(); } };
}

const doc = (body: string, preamble = "") => `\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;
const config = (units: Record<string, string> = {}, options: Record<string, string> = {}) => ({ units: new Map(Object.entries(units)), options: new Map(Object.entries(options)) });

const PREAMBLE_13235 = String.raw`\usepackage{siunitx}
\DeclareSIUnit\angstrom{\text{\AA}}
\sisetup{
  per-mode=symbol,
  range-units=single,
  range-phrase=\text{ to },
  multi-part-units=single,
  list-separator = {, },
  list-final-separator = {, \text{and}\ },
  list-pair-separator = { and },
}`;

test("siunitx 3 abbreviations and a power after a unit read (2611.13235, 2611.12193)", () => {
  assert.equal(readSiunitx("\\qty{17.2}{\\ml}", 0)?.latex, "17.2\\,\\mathrm{m}\\mathrm{l}");
  assert.equal(readSiunitx("\\qty{0.1}{\\mm}", 0)?.latex, "0.1\\,\\mathrm{m}\\mathrm{m}");
  assert.equal(readSiunitx("\\SI{0.75}{\\milli\\eV}", 0)?.latex, "0.75\\,\\mathrm{m}\\mathrm{eV}");
  assert.equal(readSiunitx("\\unit{\\ml\\squared}", 0)?.latex, "\\mathrm{m}\\mathrm{l}^{2}");
  assert.equal(readSiunitx("\\SI{14.06}{\\milli\\mol\\per\\gram}", 0)?.latex, "14.06\\,\\mathrm{m}\\mathrm{mol}\\,\\mathrm{g}^{-1}");
  // `\pm` is only a unit inside a unit argument; as the command it is not read.
  assert.equal(readSiunitx("\\SI{1}{\\notaunit}", 0), null);
  // The power after a unit.
  assert.equal(readSiunitx("\\SI{1.5}{\\angstrom^{-1}}", 0)?.latex, "1.5\\,\\text{Å}^{-1}");
  assert.equal(readSiunitx("\\si{\\metre^2}", 0)?.latex, "\\mathrm{m}^{2}");
});

test("a document's own \\DeclareSIUnit overrides the package's unit and its \\sisetup applies (2611.13235)", () => {
  const cfg = config({ angstrom: "\\text{\\AA}", ml: "\\milli\\litre" }, { "per-mode": "symbol", "range-units": "single", "list-final-separator": "{, \\text{and}\\ }" });
  assert.equal(readSiunitx("\\SIlist{3;4.5;6}{\\angstrom^{-1}}", 0, cfg)?.latex, "3\\,\\text{\\AA}^{-1}\\text{, }4.5\\,\\text{\\AA}^{-1}\\text{, and }6\\,\\text{\\AA}^{-1}");
  assert.equal(readSiunitx("\\SI{14.06}{\\milli\\mol\\per\\gram}", 0, cfg)?.latex, "14.06\\,\\mathrm{m}\\mathrm{mol}/\\mathrm{g}");
  assert.equal(readSiunitx("\\SIrange{1}{2}{\\kelvin}", 0, cfg)?.latex, "1\\text{ to }2\\,\\mathrm{K}");
  assert.equal(readSiunitx("\\qty{2}{\\ml}", 0, cfg)?.latex, "2\\,\\mathrm{m}\\mathrm{L}");
  // A declared unit overriding a built-in one: its symbol, not the package's.
  assert.equal(readSiunitx("\\qty{2}{\\kelvin}", 0, config({ kelvin: "\\text{kel}" }))?.latex, "2\\,\\text{kel}");
  // An option not read (a per-mode written otherwise) leaves the command as source.
  assert.equal(readSiunitx("\\qty{2}{\\m\\per\\s}", 0, config({}, { "per-mode": "repeated-symbol" })), null);
  // A definition that is not read: the command stays source.
  assert.equal(readSiunitx("\\qty{2}{\\weird}", 0, config({ weird: "\\somemacro{x}" })), null);
  // The settings come from the document's definitions: `\sisetup` over the options siunitx was loaded with.
  const fromDefs = siunitxConfig({ siunitx: { units: new Map(), options: new Map([["per-mode", "fraction"]]) }, packageOptions: new Map([["siunitx", ["range-units=single"]]]) });
  assert.equal(fromDefs?.options?.get("range-units"), "single");
  assert.equal(fromDefs?.options?.get("per-mode"), "fraction");
});

test("a quantity with an uncertainty is bracketed, and \\qtyproduct / \\numproduct read (2611.12193, 2611.13800)", () => {
  assert.equal(readSiunitx("\\qty[uncertainty-mode=separate]{2.740\\pm0.086}{\\mm}", 0)?.latex, "\\left(2.740\\pm 0.086\\right)\\,\\mathrm{m}\\mathrm{m}");
  assert.equal(readSiunitx("\\qtyproduct{102 x 64}{\\milli\\meter}", 0)?.latex, "102\\,\\mathrm{m}\\mathrm{m}\\times 64\\,\\mathrm{m}\\mathrm{m}");
  assert.equal(readSiunitx("\\qtyproduct[product-units=single]{102 x 64}{\\milli\\meter}", 0)?.latex, "102\\times 64\\,\\mathrm{m}\\mathrm{m}");
  assert.equal(readSiunitx("\\numproduct{3 x 4}", 0)?.latex, "3\\times 4");
  // A noise density's `\per\sqrt{\hertz}` (2611.13800).
  assert.equal(readSiunitx("\\SI{1}{\\pico\\tesla\\per\\sqrt{\\hertz}}", 0)?.latex, "1\\,\\mathrm{p}\\mathrm{T}\\,\\mathrm{Hz}^{-1/2}");
  assert.equal(readSiunitx("\\qtyrange{90}{180}{\\degree}", 0)?.latex, "90{}^{\\circ}\\text{ to }180{}^{\\circ}");
  assert.equal(readSiunitx("\\qtylist{1;2;3}{\\ml}", 0)?.latex, "1\\,\\mathrm{m}\\mathrm{l}\\text{, }2\\,\\mathrm{m}\\mathrm{l}\\text{, and }3\\,\\mathrm{m}\\mathrm{l}");
});

/** The source shown in the formula editor after a plain mousedown on the `index`th math widget (null when it did not open). */
async function plainClickEditor(source: string, index: number, from: number, to: number) {
  const quiet = console.error;
  console.error = () => {};
  const { view, done } = mount(source);
  [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-math")][index].dispatchEvent(new dom.window.MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
  // The editor opens after MathLive's module has loaded (a dynamic import, slow on a busy machine), and under jsdom it ends as the
  // source area: wait for that, or for the caret to be put inside the source instead, not for a fixed time. Bounded: a click that
  // does neither fails after the guard.
  const editorArea = () => document.querySelector<HTMLTextAreaElement>(".cm-vis-math-editor .cm-vis-math-source");
  const revealed = () => view.state.selection.main.head >= from && view.state.selection.main.head <= to;
  const deadline = Date.now() + 20_000;
  while (!editorArea() && !revealed() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  console.error = quiet;
  const area = editorArea();
  const value = area ? area.value : null;
  const head = view.state.selection.main.head;
  done();
  for (const editor of document.querySelectorAll(".cm-vis-math-editor")) editor.remove();
  return value !== null || (head >= from && head <= to);
}

test("paragraphs with units, the user's \\DeclareSIUnit and \\SI in math are drawn, and their widgets reveal the source (2611.13235)", async () => {
  const body = String.raw`We used \SIlist{6;12;28}{\milli\eV} and \SIlist{3;4.5;6}{\angstrom^{-1}}, at \SIrange{1}{2}{\milli\mol\per\gram} and \SI{1.5}{\kelvin}.

This holds until $\approx \SI{11}{\milli\mol\per\gram}$ and the \SI{14.06}{\milli\mol\per\gram} sample.`;
  const { view, done } = mount(doc(body, PREAMBLE_13235));
  const text = view.contentDOM.textContent ?? "";
  assert.ok(!text.includes("\\SI"), text);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  const widgets = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-math")];
  assert.equal(widgets.length, 6, view.contentDOM.innerHTML);
  // Click-to-source on a text unit (the second `\SIlist`) and on the unit inside `$…$`.
  const source = view.state.doc.toString();
  done();
  // A fresh editor per click (a click re-draws the widgets): Alt-mousedown and a plain mousedown reveal the same source.
  for (const [index, marker, end] of [[1, "\\SIlist{3;4.5;6}", "{\\angstrom^{-1}}"], [4, "$\\approx", "$"]] as const) {
    const from = source.indexOf(marker);
    const to = source.indexOf(end, from + marker.length) + end.length;
    const altClick = mount(source);
    [...altClick.view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-math")][index].dispatchEvent(new dom.window.MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true, altKey: true }));
    const head = altClick.view.state.selection.main.head;
    assert.ok(head >= from && head <= to, `caret ${head} not inside ${from}-${to} for ${marker}`);
    altClick.done();
    // A plain click opens the formula editor on the source as written (its source area shows under jsdom).
    assert.ok(await plainClickEditor(source, index, from, to), `no formula editor or revealed source for ${marker}`);
  }
});

test("units with abbreviations in a paragraph and inside math draw (physics.flu-dyn 2611.12193)", () => {
  const body = String.raw`Two photographs at \qty{17.2}{\ml} and \qty{19.2}{\ml}, with $\alpha$ in units of \qty{15}{\degree} and \qty{0.1}{\mm}, \qtyrange{90}{180}{\degree}, \num{2220}.

Noise $\sigma_\text{exp}=\qty{0.4}{\mm}$, $\mathcal N(0,\ \qty{0.5}{\ml})$, $V=\unit{\ml\squared}$ and $\qty[uncertainty-mode=separate]{2.740\pm0.086}{\mm}$.`;
  const { view, done } = mount(doc(body, "\\usepackage{siunitx}"));
  const text = view.contentDOM.textContent ?? "";
  assert.ok(!/\\(?:qty|num|unit)/.test(text), text);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  done();
});

test("\\qtyproduct and \\ce in text draw, and a document without mhchem keeps \\ce as source (2611.13800, 2611.14809)", async () => {
  // Under tsx `import()` finds the extension's ESM build, which registers on another KaTeX than this CommonJS one.
  createRequire(import.meta.url)("katex/contrib/mhchem");
  await loadMhchem();
  const body = String.raw`A build area of \qtyproduct{102 x 64}{\milli\meter} in \ce{Al2O3} and \ce{MnPS_3}, the \ce{D2} line, and \SI{6}{\milli\liter}.`;
  const { view, done } = mount(doc(body, "\\usepackage{siunitx}\n\\usepackage[version=4]{mhchem}"));
  const text = view.contentDOM.textContent ?? "";
  assert.ok(!/\\(?:ce|qtyproduct|SI)/.test(text), text);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  const widgets = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-math")];
  assert.equal(widgets.length, 5, view.contentDOM.innerHTML);
  assert.ok(widgets[1].querySelector(".mord.text, .mord.mathrm, .msupsub") !== null || (widgets[1].textContent ?? "").includes("Al"), widgets[1].innerHTML);
  // Click-to-source: Alt-mousedown and a plain click on the `\ce{Al2O3}` widget put the caret inside it.
  const source = view.state.doc.toString();
  const from = source.indexOf("\\ce{Al2O3}");
  const to = from + "\\ce{Al2O3}".length;
  widgets[1].dispatchEvent(new dom.window.MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true, altKey: true }));
  const head = view.state.selection.main.head;
  assert.ok(head >= from && head <= to, `caret ${head} not inside ${from}-${to}`);
  done();
  assert.ok(await plainClickEditor(source, 1, from, to), "a plain click opens the formula editor or reveals the source");
  // Without mhchem loaded, `\ce` is not a command of the document: left as source.
  const plain = mount(doc(String.raw`The \ce{Al2O3} module.`));
  assert.ok((plain.view.contentDOM.textContent ?? "").includes("\\ce{Al2O3}"));
  plain.done();
});
