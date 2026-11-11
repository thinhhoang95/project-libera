import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { katexForEnvironment, loadMhchem, onMathExtensionLoaded, renderKatex } from "../../src/lib/latex/codemirror/visual/math-render";
import { readSiunitx } from "../../src/lib/latex/codemirror/visual/siunitx";
import { expandLatexMacros } from "../../src/lib/latex/macros/expand";
import { readLatexDefinitions } from "../../src/lib/latex/macros/definitions";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* How formulas are typeset (KaTeX preprocessing) and numbered: per-row fallback, empheq/breqn/IEEEeqnarray, physics,
 * siunitx, colours, array column specifications, symbols, and formulas being typed. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function visualState(doc: string, extra: Extension[] = []) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }), ...extra] });
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

/** Constructs as "kind:from:to". */
function constructs(state: EditorState) {
  const list: string[] = [];
  state.field(structuralField).extents.between(0, state.doc.length, (from, to, mark) => { list.push(`${mark.kind}:${from}:${to}`); });
  return list;
}

/** What a mounted Visual mode shows: its text, the equation numbers set on number slots, in order, and its HTML. */
function mounted(doc: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  const text = view.contentDOM.textContent ?? "";
  const numbers = [...view.contentDOM.querySelectorAll(".eqn-num[data-vis-num]")].map((slot) => slot.getAttribute("data-vis-num"));
  const sources = [...view.contentDOM.querySelectorAll(".cm-vis-math-source")].map((node) => node.textContent);
  const html = view.contentDOM.innerHTML;
  view.destroy();
  parent.remove();
  return { text, numbers, sources, html, numbering };
}

/** A formula as the Visual mode draws it (macros expanded, then KaTeX); null when it stays source. */
function drawn(preamble: string, formula: string, display = false) {
  const defs = readLatexDefinitions(`${preamble}\n\\begin{document}\\end{document}`);
  const expanded = expandLatexMacros(formula, defs, { mode: "math", pos: 0 });
  return expanded.ok ? renderKatex(expanded.text, display) : null;
}

const doc = (body: string, preamble = "") => `\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;
const mathCount = (state: EditorState) => constructs(state).filter((item) => item.startsWith("math:")).length;

test("an align row KaTeX rejects shows its source; the other rows are drawn and keep their numbers", () => {
  const view = mounted(doc("\\begin{align}\na &= b \\\\\nc &= \\undefinedthing{d} \\\\\ne &= f \\label{e3}\n\\end{align}\n\\begin{equation}\ng = h \\label{e4}\n\\end{equation}\nSee \\eqref{e4}."));
  // Only the cell KaTeX rejects is source (the row's `&` is not shown); `c` is drawn.
  assert.deepEqual(view.sources, ["= \\undefinedthing{d}"]);
  assert.deepEqual(view.numbers, ["1", "2", "3", "4"]);
  // A failing row with \nonumber or \tag keeps no slot.
  const tagged = mounted(doc("\\begin{align}\na &= b \\\\\nc &= \\nope \\nonumber \\\\\ne &= f\n\\end{align}"));
  assert.deepEqual(tagged.numbers, ["1", "2"]);
  // Nested: one case of a `cases` inside an equation.
  assert.match(drawn("", "f = \\begin{cases} 1 & x>0 \\\\ \\nope & x \\le 0 \\end{cases}", true) ?? "", /cm-vis-math-source[\s\S]*\\nope/);
  // All rows rejected: the formula stays source.
  assert.equal(drawn("", "\\begin{aligned} \\nope \\\\ \\nada \\end{aligned}", true), null);
  // A `$…$` in a formula's text.
  assert.match(drawn("", "a + \\text{if $\\nope x$ and $y$} b") ?? "", /cm-vis-math-source/);
});

test("a formula that renders whole is drawn as before (no source parts)", () => {
  const html = drawn("", "\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}", true)!;
  assert.ok(html && !html.includes("cm-vis-math-source"));
});

test("empheq, dmath, dseries and IEEEeqnarray are drawn and numbered; later numbers do not shift", () => {
  const view = mounted(doc([
    "\\begin{empheq}[left=\\empheqlbrace]{align}\nx &= 1 \\\\\ny &= 2\n\\end{empheq}",
    "\\begin{dmath}\na = b + c\n\\end{dmath}",
    "\\begin{IEEEeqnarray}{rCl}\na &=& b \\\\\nc &=& d \\IEEEnonumber\n\\end{IEEEeqnarray}",
    "\\begin{equation}\nz = 0 \\label{last}\n\\end{equation}",
  ].join("\n"), "\\usepackage{empheq}\\usepackage{breqn}"));
  assert.equal(view.numbering.labels.get("last")?.number, "5");
  assert.deepEqual(view.numbers, ["1", "2", "3", "4", "5"]);
  assert.equal(drawn("", katexForEnvironment("dseries*", "a=b").latex, true) !== null, true);
  // dgroup*: its dmaths are unnumbered.
  const group = mounted(doc("\\begin{dgroup*}\n\\begin{dmath}\na = b\n\\end{dmath}\n\\end{dgroup*}\n\\begin{equation}\nc\\label{c}\n\\end{equation}"));
  assert.equal(group.numbering.labels.get("c")?.number, "1");
});

test("page breaks, struts and labels in their forms do not turn a formula to source", () => {
  for (const formula of ["a &= b \\displaybreak[2] \\\\ c &= d", "a &= b \\displaybreak \\\\ c &= d \\label[lemma]{x}"]) {
    assert.ok(drawn("", katexForEnvironment("align", formula).latex, true), formula);
  }
  for (const formula of ["\\allowdisplaybreaks[1] a = b", "\\mathstrut a \\strut", "a \\label*{x}", "a \\zlabel{x}"]) assert.ok(drawn("", formula), formula);
});

test("array column specifications and rules are written as KaTeX takes them", () => {
  for (const formula of [
    "\\begin{array}{@{}l@{\\quad}r@{}} a & b \\end{array}", "\\begin{array}{l!{\\vrule}r} a & b \\end{array}", "\\begin{array}{>{\\displaystyle}l<{x}r} a & b \\end{array}",
    "\\begin{array}{p{2cm}m{1cm}} a & b \\end{array}", "\\begin{array}{*{3}{c}} a & b & c \\end{array}", "\\begin{array}{cc} \\multicolumn{2}{c}{x} \\\\ a & b \\end{array}",
    "\\begin{array}{cc} a & b \\\\ \\cline{1-2} a & b \\end{array}", "\\begin{array}{cc} a & b \\\\ \\cmidrule(lr){1-2} a & b \\end{array}",
    "\\begin{array}{cc} a & b \\\\ \\noalign{\\smallskip} a & b \\end{array}", "\\begin{array}{cc} a & b \\\\ \\specialrule{1pt}{2pt}{2pt} a & b \\end{array}",
    "\\begin{array}[t]{cc} a & b \\end{array}",
  ]) assert.ok(drawn("", formula), formula);
  // An unknown column letter stays source.
  assert.equal(drawn("", "\\begin{array}{Q} a \\end{array}"), null);
});

test("physics: \\eval, \\var, matrix commands, \\pv and the \\qty forms", () => {
  const physics = "\\usepackage{physics}";
  for (const formula of ["\\eval{x^2}_0^1", "\\eval*{x^2}_0^1", "\\eval(x^2)|_0^1", "\\var{S}", "\\var{x}", "\\imat{2}", "\\dmat{1,2,3}", "\\xmat*{a}{2}{2}", "\\admat[0]{1,2}",
    "\\zmat{2}{2}", "\\pmat{1}", "\\mqty(\\imat{2})", "\\smqty[\\dmat{a,b}]", "\\spmqty{a&b}", "\\Pmqty{a&b}", "\\pv\\int f", "\\qty(\\frac{a}{b})", "\\qty\\big(a)", "\\qty|a|"]) {
    assert.ok(drawn(physics, formula), formula);
  }
  const identity = drawn(physics, "\\imat{2}")!;
  assert.equal((identity.match(/>1</g) ?? []).length, 2);
});

test("siunitx in formulas", () => {
  assert.equal(readSiunitx("\\SI{12.5}{\\kilo\\meter\\per\\second}", 0)?.latex, "12.5\\,\\mathrm{k}\\mathrm{m}\\,\\mathrm{s}^{-1}");
  assert.equal(readSiunitx("\\num{1.5e3}", 0)?.latex, "1.5\\times 10^{3}");
  assert.equal(readSiunitx("\\num{3+-0.2}", 0)?.latex, "3\\pm 0.2");
  assert.equal(readSiunitx("\\si{\\meter\\squared}", 0)?.latex, "\\mathrm{m}^{2}");
  assert.equal(readSiunitx("\\ang{30}", 0)?.latex, "30^{\\circ}");
  assert.equal(readSiunitx("\\SI{5}{\\unknownunit}", 0), null);
  for (const formula of ["\\SI{12.5}{\\kilo\\meter\\per\\second}", "\\num{1.5e3} \\num{3+-0.2}", "\\qty{3}{\\percent}", "\\SIrange{1}{2}{\\metre}", "\\numlist{1;2;3}", "\\si[per-mode=symbol]{\\metre\\per\\second}", "20\\,\\celsius", "\\micro\\text{m}", "\\unit{kg.m^2/s}"]) assert.ok(drawn("", formula), formula);
});

test("siunitx in running text is drawn; an unknown unit stays source", () => {
  const state = visualState(doc("Speed \\SI{12.5}{\\kilo\\meter\\per\\second} and \\num{3e4}, but \\SI{5}{\\furlong}."));
  assert.equal(mathCount(state), 2);
});

test("colours in formulas: models, mixes and \\definecolor names", () => {
  for (const formula of ["\\textcolor[HTML]{FF0000}{x}", "\\color[rgb]{1,0,0} x", "\\textcolor{red!50!blue}{x}", "\\colorbox[gray]{0.9}{x}"]) assert.ok(drawn("", formula), formula);
  assert.match(drawn("", "\\textcolor{red!50!blue}{x}")!, /color:\s*#/);
  const view = mounted(doc("$\\textcolor{myc}{x}$", "\\usepackage{xcolor}\\definecolor{myc}{RGB}{10,20,30}"));
  assert.match(view.html, /#0a141e/i);
});

test("symbols and commands mapped for KaTeX", () => {
  for (const formula of ["\\prescript{a}{b}{X}", "\\sideset{_a^b}{_c^d}\\sum", "\\sideset{}{'}\\sum_n", "\\mleft( x \\mright)", "\\smashoperator{\\sum_{i=1}^n}", "\\smashoperator[r]{\\sum_i}",
    "\\upalpha \\upOmega", "\\text{\\ensuremath{x^2}}", "a \\hfill b", "a\\mspace{3mu}b", "\\hdots \\iddots", "\\relbar \\Relbar", "\\bigtimes_i A", "\\buildrel \\rm def \\over =",
    "\\mit{x} \\mathbfit{x}", "\\idotsint \\iiiint", "\\text{\\textmu m}", "\\Lbag x \\Rbag \\lightning \\mapsfrom"]) {
    assert.ok(drawn("", formula), formula);
  }
});

test("mhchem is loaded on first use and formulas are drawn again", async () => {
  let heard = 0;
  const stop = onMathExtensionLoaded(() => { heard++; });
  assert.equal(renderKatex("\\ce{H2O}", false), null);
  await loadMhchem();
  stop();
  assert.equal(heard, 1);
});

test("formulas being typed stay source and do not make later paragraphs math", () => {
  const after = "\n\nA later paragraph with $y$.\n";
  const typed = ["\\begin{align}\na &= b", "\\begin{align}\na &= b \\\\\nc &= d\n\\end{ali", "$x + ", "\\[ x + y", "\\begin{empheq}[left=\\empheqlbrace]{align}\na &= b", "\\begin{dmath}\na = b"];
  for (const partial of typed) {
    const state = visualState(doc(partial + after));
    // Only the later paragraph's `$y$` is drawn.
    assert.equal(mathCount(state), 1, partial);
  }
  const complete = visualState(doc("\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}" + after));
  assert.equal(mathCount(complete), 2);
});
