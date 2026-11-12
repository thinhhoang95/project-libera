import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { plainTexText } from "../../src/lib/latex/codemirror/visual/references";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Round 5, references, labels, list labels, citations, bibliography, theorem wrappers (math.DG 2611.11400, math.AP 2611.12463,
 * cs.CR 2611.11859, cs.LG 2611.14059, econ.TH 2611.01431, cs.CC 2611.07413, cs.GT 2611.05777, cs.SE 2611.12982, math.ST 2611.09087,
 * math.NT 2611.11566): each case is a small excerpt written for the test. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function visualState(doc: string, extra: Extension[] = [], anchor = doc.length) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  let state = EditorState.create({ doc, selection: { anchor }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }), ...extra] });
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

function mount(doc: string, extra: Extension[] = [], anchor = doc.length) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, extra, anchor), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return view;
}

const inDocument = (body: string, preamble = "", documentClass = "article") => `\\documentclass{${documentClass}}\n${preamble}\\begin{document}\n${body}\n\\end{document}\n`;
const lineTexts = (view: EditorView) => [...view.contentDOM.querySelectorAll(".cm-line")].map((line) => (line.textContent ?? "").replace(/\s+/g, " ").trim());
const mouse = (type: string, init: Record<string, unknown> = {}) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });

/** The visible text of a document body, the caret placed at `anchor` (default: the end, past the body). */
function bodyText(body: string, anchor?: number, preamble = "", documentClass = "article", extra: Extension[] = []) {
  const doc = inDocument(body, preamble, documentClass);
  const view = mount(doc, extra, anchor ?? doc.length);
  const text = lineTexts(view).filter(Boolean).filter((line) => !/^(?:\\documentclass|▸ Preamble|\\end\{document\})/.test(line)).join("\n");
  view.destroy();
  view.dom.parentElement?.remove();
  return text;
}

/** Mousedown on the first element matching `selector` reveals the source it stands for: the caret lands inside it. */
function clickReveals(body: string, selector: string, source: string, preamble = "", documentClass = "article", init: Record<string, unknown> = {}) {
  const doc = inDocument(body, preamble, documentClass);
  const view = mount(doc, [], doc.length);
  const target = view.contentDOM.querySelector(selector);
  assert.ok(target, `no ${selector} widget`);
  target.dispatchEvent(mouse("mousedown", init));
  const from = doc.indexOf(source);
  const head = view.state.selection.main.head;
  assert.ok(from >= 0 && head >= from && head <= from + source.length, `caret ${head} not in ${source} at ${from}`);
  view.destroy();
  view.dom.parentElement?.remove();
}


const altClick = { altKey: true };

test("an enumitem label with font commands draws formatted, never as raw LaTeX (math.DG 2611.11400)", () => {
  const body = "\\begin{enumerate}[label=\\textup{(\\roman*)}]\n\\item first\n\\item second\n\\end{enumerate}\n\\begin{enumerate}[label=\\textbf{\\arabic*.}]\n\\item third\n\\end{enumerate}";
  const text = bodyText(body);
  assert.match(text, /\(i\)first/);
  assert.match(text, /\(ii\)second/);
  assert.match(text, /1\.third/);
  assert.doesNotMatch(text, /\\text/);
  clickReveals(body, ".cm-vis-item", "\\item first");
});

test("a reference to an equation tagged \\tag{\\textbf{i}} prints plain text (math.AP 2611.12463)", () => {
  const body = "\\begin{align}\n\\label{ci1}&a>b,\\tag{\\textbf{i}}\\\\\n\\label{ci3}&c\\tag{\\textbf{ii}}\n\\end{align}\nwhenever (\\ref{ci1}) and \\eqref{ci3} hold";
  const text = bodyText(body);
  assert.doesNotMatch(text, /\\textbf/);
  assert.match(text, /whenever \(i\) and \(ii\) hold/);
  clickReveals(body, ".cm-vis-ref", "\\ref{ci1}", "", "article", altClick);
});

test("a citation note with \\textsuperscript prints it, and an unknown command never leaks its name (cs.CR 2611.11859)", () => {
  const text = bodyText("Weil \\cite[n\\textsuperscript{o} 10, Th\\'eor\\`eme 1]{Weil64}.");
  assert.match(text, /Weil \[Weil64, nᵒ 10, Théorème 1\]/);
  assert.doesNotMatch(text, /\\|textsuperscript/);
  // The plain-text fallback prints the argument of a command it does not know, not the command's name.
  assert.equal(plainTexText("n\\textsuperscript{o} 10, \\unknowncmd{x}"), "no 10, x");
});

test("jmlr's \\tableref, \\sectionref, \\appendixref and \\figureref are reference chips (cs.LG 2611.14059)", () => {
  const body = "See \\tableref{tab:a}, \\sectionref{sec:b}, \\figureref{fig:d} and \\sectionref{sec:b,sec:c}; \\appendixref{apd:e}.\n\\section{B}\\label{sec:b}\n\\section{C}\\label{sec:c}\n\\begin{table}\n\\caption{T}\\label{tab:a}\n\\end{table}\n\\begin{figure}\n\\caption{F}\\label{fig:d}\n\\end{figure}\n\\appendix\n\\section{Corpus}\\label{apd:e}";
  const text = bodyText(body, undefined, "", "jmlr");
  assert.match(text, /See Table 1, Section 1, Figure 1 and Sections 1 and 2; Appendix A\./);
  clickReveals(body, ".cm-vis-ref", "\\tableref{tab:a}", "", "jmlr", altClick);
  // Not a jmlr document: the command is not known, so it stays source.
  assert.match(bodyText("See \\tableref{tab:a}.\n\\begin{table}\n\\caption{T}\\label{tab:a}\n\\end{table}"), /\\tableref\{tab:a\}/);
});

test("prettyref's \\prettyref follows \\newrefformat, else the usual prefix words (econ.TH 2611.01431)", () => {
  const body = "In \\prettyref{eq:x}, \\prettyref{sec:b} and \\prettyref{fig:y}.\n\\section{B}\\label{sec:b}\n\\begin{equation}\\label{eq:x}a\\end{equation}\n\\begin{figure}\\caption{Y}\\label{fig:y}\\end{figure}";
  const pre = "\\usepackage{prettyref}\n\\newrefformat{eq}{(\\ref{#1})}\n\\newrefformat{sec}{Section~\\ref{#1}}\n";
  const text = bodyText(body, undefined, pre);
  assert.match(text, /In \(1\), Section 1 and Figure 1\./);
  clickReveals(body, ".cm-vis-ref", "\\prettyref{eq:x}", pre, "article", altClick);
  // An unknown prefix has no format: the command stays source.
  assert.match(bodyText("See \\prettyref{zzz:q}.", undefined, "\\usepackage{prettyref}\n"), /\\prettyref\{zzz:q\}/);
});

test("cleveref's \\Cpageref, zref-clever's \\zcsetup and \\label[type]{key} (cs.CC 2611.07413, cs.GT 2611.05777)", () => {
  const body = "Recall the definition on \\Cpageref{def:a}: \\zcsetup{reftype=Claim}done.\n\\begin{enumerate}\n\\item \\zcsetup{reftype=Property}\\label[Property]{def:a} (Dense) one\n\\item two\n\\end{enumerate}\nBy \\cref{def:a}.";
  const pre = "\\usepackage{cleveref}\n\\Crefname{Property}{Property}{Properties}\n\\crefname{Property}{property}{properties}\n";
  const text = bodyText(body, undefined, pre);
  assert.doesNotMatch(text, /\\Cpageref|\\zcsetup|\\label/);
  assert.match(text, /on Page \?:/);
  assert.match(text, /By property 1\./);
  // Clicking the typed label's chip opens its source.
  clickReveals(body, ".cm-vis-label", "\\label[Property]{def:a}", pre);
  // The hidden set-up shows its source when the caret enters it.
  const doc = inDocument(body, pre);
  const view = mount(doc, [], doc.indexOf("\\zcsetup{reftype=Claim}") + 3);
  assert.match(lineTexts(view).join("\n"), /\\zcsetup\{reftype=Claim\}/);
  view.destroy();
  view.dom.parentElement?.remove();
});

test("\\crefalias, \\numberwithin are hidden, \\lq and \\rq are quotes (cs.SE 2611.12982, math.NT 2611.11566)", () => {
  const body = "\\crefalias{section}{appendix}\n\\numberwithin{table}{section}\nThe \\lq\\lq{}main\\rq\\rq{} of it.";
  const text = bodyText(body);
  assert.doesNotMatch(text, /crefalias|numberwithin/);
  assert.match(text, /The ‘‘main’’ of it\./);
  const doc = inDocument(body);
  const view = mount(doc, [], doc.indexOf("\\numberwithin") + 4);
  assert.match(lineTexts(view).join("\n"), /\\numberwithin\{table\}\{section\}/);
  view.destroy();
  view.dom.parentElement?.remove();
});

test("\\printbibliography with a trailing comment draws the References list (math.ST 2611.09087)", () => {
  const body = "Text.\n\n\\printbibliography % print bibliography\n";
  const doc = inDocument(body, "\\usepackage[backend=biber]{biblatex}\n");
  const view = mount(doc, [], 0);
  assert.doesNotMatch(view.contentDOM.textContent ?? "", /printbibliography/);
  assert.match(view.contentDOM.textContent ?? "", /References/);
  view.destroy();
  view.dom.parentElement?.remove();
});

test("\\href with spaces or a line break before its text is a link (cs.CC 2611.07413, math.DG 2611.11400)", () => {
  const body = "\\begin{thebibliography}{9}\n\\bibitem{a} A. \\newblock \\href {https://doi.org/10.1/x} {\\path{doi:10.1/x}}.\n\\bibitem{b} B.\n\\href{https://doi.org/10.2/y}\n  {\\emph{Title one}},\n\\end{thebibliography}";
  const text = bodyText(body, undefined, "\\usepackage{hyperref}\n");
  assert.doesNotMatch(text, /\\href|\\path|\\emph/);
  assert.match(text, /A\. doi:10\.1\/x\./);
  assert.match(text, /Title one,/);
  const doc = inDocument(body, "\\usepackage{hyperref}\n");
  const view = mount(doc, [], doc.length);
  const link = [...view.contentDOM.querySelectorAll(".cm-vis-link")].find((node) => node.textContent?.includes("Title one"));
  assert.equal(link?.getAttribute("data-href"), "https://doi.org/10.2/y");
  view.destroy();
  view.dom.parentElement?.remove();
});

test("an unnumbered theorem wrapper whose heading names another theorem (cs.GT 2611.05777's reptheorem)", () => {
  const pre = "\\newtheorem{theorem}{Theorem}\n\\newtheorem*{reptheorembody}{\\reptheoremheading}\n\\DeclareRobustCommand{\\reptheoremheading}{\\Cref{\\reptheoremlabel}}\n\\newenvironment{reptheorem}[1]\n  {\\def\\reptheoremlabel{#1}\\begin{reptheorembody}}\n  {\\end{reptheorembody}}\n\\usepackage{cleveref}\n";
  const body = "\\begin{theorem}\\label{thm:lb}\nFirst.\n\\end{theorem}\n\n\\begin{reptheorem}{thm:lb}\nAgain.\n\\end{reptheorem}";
  const text = bodyText(body, undefined, pre);
  assert.match(text, /Theorem 1\.\nFirst\./);
  assert.match(text, /Theorem 1\.\nAgain\./);
  assert.doesNotMatch(text, /reptheorem|\\def|\\Cref/);
  const doc = inDocument(body, pre);
  const view = mount(doc, [], doc.length);
  const headers = [...view.contentDOM.querySelectorAll(".cm-vis-env-header")];
  assert.equal(headers.length, 2);
  view.destroy();
  view.dom.parentElement?.remove();
});

test("a restatable called in another file is a chip naming it, which opens its source (cs.GT 2611.05777's \\pathconcentrationlemma*)", () => {
  const pre = "\\usepackage{thm-restate}\n\\newtheorem{lemma}{Lemma}\n";
  const body = "Before.\n\n\\pathconcentrationlemma*\n\nAfter.";
  const text = bodyText(body, undefined, pre);
  assert.match(text, /pathconcentrationlemma \(restated\)/);
  assert.doesNotMatch(text, /\\pathconcentrationlemma/);
  clickReveals(body, ".cm-vis-label", "\\pathconcentrationlemma*", pre);
});

test("zref-clever's \\zcsetup inside an equation does not keep the formula from drawing (cs.CC 2611.07413)", () => {
  const body = "\\begin{equation}\\zcsetup{reftype=Expression}\\label{eq:joint}\nx=y\n\\end{equation}";
  const doc = inDocument(body);
  const view = mount(doc, [], 0);
  assert.ok(view.contentDOM.querySelector(".katex"), "the equation is drawn");
  assert.doesNotMatch(view.contentDOM.textContent ?? "", /zcsetup/);
  view.destroy();
  view.dom.parentElement?.remove();
});
