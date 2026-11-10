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
import { latexParser as parser } from "../../src/lib/latex/codemirror/latex-parser";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { readLatexDefinitions } from "../../src/lib/latex/macros/definitions";
import { computeLatexNumbering, referenceText } from "../../src/lib/latex/macros/numbering";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

/* Numbering, references and bibliography (group B of the arXiv audit): the
 * smallest source showing each problem. */

/** The Visual mode's state for `doc`, with every pending piece built. */
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

/** Constructs as "kind:from:to": what the structural layer has built. */
function constructs(state: EditorState) {
  const list: string[] = [];
  state.field(structuralField).extents.between(0, state.doc.length, (from, to, mark) => { list.push(`${mark.kind}:${from}:${to}`); });
  return list;
}

/** The text a mounted Visual mode shows for `doc` (widgets' text included), numbered as the app numbers it. */
function visibleText(doc: string, extra: Extension[] = []) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, extra), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  const text = view.contentDOM.textContent ?? "";
  view.destroy();
  parent.remove();
  return text;
}

function number(source: string, options: Parameters<typeof computeLatexNumbering>[3] = {}) {
  const tree = parser.parse(source);
  return computeLatexNumbering(tree, (from, to) => source.slice(from, to), readLatexDefinitions(source), options);
}

function sectionNumbers(source: string, options: Parameters<typeof computeLatexNumbering>[3] = {}) {
  return number(source, options).entries.filter((entry) => entry.kind === "section").map((entry) => entry.number);
}

test("B5-01: \\frontmatter and \\backmatter chapters are not numbered; \\mainmatter starts at chapter 1", () => {
  const source = String.raw`\documentclass{book}
\begin{document}
\frontmatter
\chapter{Preface}
\chapter{Acknowledgements}
\mainmatter
\chapter{Introduction}\label{chap:intro}
\section{Motivation}\label{sec:mot}
\appendix
\chapter{Proofs}\label{app:proofs}
\backmatter
\chapter{Index}\label{index}
\end{document}`;
  assert.deepEqual(sectionNumbers(source), [null, null, "1", "1.1", "A", null]);
  const labels = number(source).labels;
  assert.equal(labels.get("chap:intro")?.number, "1");
  assert.equal(labels.get("sec:mot")?.number, "1.1");
  assert.equal(labels.get("app:proofs")?.number, "A");
  // A label after an unnumbered chapter refers to what was numbered before it (LaTeX's \@currentlabel).
  assert.equal(labels.get("index")?.number, "A");
  // memoir's front matter numbers no heading at all; in an article the commands do not exist.
  assert.deepEqual(sectionNumbers(source.replace("{book}", "{memoir}").replace("\\chapter{Preface}", "\\chapter{Preface}\\section{Scope}")), [null, null, null, "1", "1.1", "A", null]);
  // A chapter included after \frontmatter in the main file starts unnumbered too.
  assert.deepEqual(sectionNumbers(String.raw`\chapter{Foreword}`, { start: { counters: {}, appendix: false, mainmatter: false } }), [null]);
});

test("B4-01: \\begin{appendix} letters the sections after it, and the floats numbered by them (KOMA min-wage paper)", () => {
  const source = String.raw`\documentclass{scrartcl}
\begin{document}
\section{Introduction}
\section{Conclusion}
\begin{appendix}
\section{Description of additional data}\label{app:data}
\renewcommand*{\thetable}{\thesection\arabic{table}}
\setcounter{table}{0}
\begin{table}\caption{Summary}\label{tab:a1}\end{table}
\subsection{Panel}\label{app:panel}
\end{appendix}
\end{document}`;
  assert.deepEqual(sectionNumbers(source), ["1", "2", "A", "A.1"]);
  const labels = number(source).labels;
  assert.equal(labels.get("app:data")?.number, "A");
  assert.equal(labels.get("tab:a1")?.number, "A1");
  assert.equal(labels.get("app:panel")?.number, "A.1");
  // Its \begin and \end lines fold away as the appendix package's environment's do.
  assert.doesNotMatch(visibleText(source), /\\begin\{appendix\}|\\end\{appendix\}/);
});

test("B4-02: KOMA's \\captionabove and \\captionbelow caption a float: numbered, labelled and drawn", () => {
  const source = String.raw`\documentclass{scrartcl}
\begin{document}
\begin{figure}[ht!]
\captionabove{Changing mass of jobs}
\label{fig:bunching}
\centering
\includegraphics[width=0.9\textwidth]{real.png}
\end{figure}
\begin{table}
\captionbelow[Short]{Descriptive statistics}\label{tab:description}
\begin{tabular}{ll}
a & b \\
\end{tabular}
\end{table}
\begin{minipage}{\linewidth}
\captionaboveof{table}{Outside a float}\label{tab:outside}
\end{minipage}
See Figure \ref{fig:bunching}, Table \ref{tab:description} and Table \ref{tab:outside}.
\end{document}`;
  const labels = number(source).labels;
  assert.equal(labels.get("fig:bunching")?.number, "1");
  assert.equal(labels.get("tab:description")?.number, "1");
  assert.equal(labels.get("tab:outside")?.number, "2");
  const kinds = constructs(visualState(source)).map((item) => item.split(":")[0]);
  assert.equal(kinds.filter((kind) => kind === "figure").length, 2);
  const text = visibleText(source);
  assert.match(text, /Figure 1/);
  assert.match(text, /Changing mass of jobs/);
  assert.match(text, /Table 1/);
  assert.match(text, /Descriptive statistics/);
  assert.match(text, /See Figure 1, Table 1 and Table 2\./);
  // (A caption outside a float, `\captionof`'s too, stays source.)
  assert.doesNotMatch(text, /\\caption(?:above|below)[[{]/);
});

/** What a reference command says for labels of `source` (outputs checked against pdflatex with cleveref and hyperref). */
function says(source: string, command: string, keys: string[]) {
  const numbering = number(source);
  return referenceText(command, keys.map((key) => numbering.labels.get(key) ?? null), readLatexDefinitions(source), keys);
}

test("B5-04/B7-18/B7-19: \\cref and \\autoref name chapters, parts and appendices; lists group by type, sort and compress", () => {
  const article = String.raw`\documentclass{article}
\usepackage{hyperref}
\usepackage{cleveref}
\begin{document}
\section{Intro}\label{sec:a}
\subsection{Sub}\label{sec:sub}
\begin{equation}a\label{eq:1}\end{equation}
\begin{equation}a\label{eq:2}\end{equation}
\begin{equation}a\label{eq:3}\end{equation}
\begin{equation}a\label{eq:4}\end{equation}
\begin{figure}\caption{F}\label{fig:a}\end{figure}
\begin{table}\caption{T}\label{tab:b}\end{table}
\begin{enumerate}\item one\label{it:1}\end{enumerate}
\appendix
\section{Proofs}\label{app:a}
\subsection{More}\label{app:b}
\end{document}`;
  assert.equal(says(article, "\\cref", ["fig:a", "tab:b"]), "fig. 1 and table 1");
  assert.equal(says(article, "\\Cref", ["fig:a", "eq:1"]), "Figure 1 and eq. (1)");
  assert.equal(says(article, "\\cref", ["eq:3", "eq:1", "eq:2", "eq:4"]), "eqs. (1) to (4)");
  assert.equal(says(article, "\\cref", ["eq:1", "eq:2"]), "eqs. (1) and (2)");
  assert.equal(says(article, "\\cref", ["fig:a", "tab:b", "eq:1"]), "fig. 1, table 1, and eq. (1)");
  assert.equal(says(article, "\\cref", ["fig:a", "eq:1", "tab:b", "eq:2"]), "fig. 1, eqs. (1) and (2), and table 1");
  assert.equal(says(article, "\\cref", ["sec:sub"]), "section 1.1");
  assert.equal(says(article, "\\Cref", ["it:1"]), "Item 1");
  assert.equal(says(article, "\\namecref", ["fig:a"]), "fig.");
  assert.equal(says(article, "\\nameCref", ["eq:1"]), "Equation");
  // hyperref: "section", "subsection", "Equation" (no parentheses), and "Appendix" for an article's appendix sections.
  assert.deepEqual(["sec:a", "sec:sub", "eq:1", "fig:a", "it:1", "app:a", "app:b"].map((key) => says(article, "\\autoref", [key])), ["section 1", "subsection 1.1", "Equation 1", "Figure 1", "item 1", "Appendix A", "subsection A.1"]);
  // After \appendix cleveref says "appendix" (B7-19), at every level.
  assert.equal(says(article, "\\cref", ["app:a"]), "appendix A");
  assert.equal(says(article, "\\Cref", ["app:b"]), "Appendix A.1");
  assert.equal(says(article, "\\cref", ["app:a", "sec:a"]), "appendix A and section 1");
  // A book: parts and chapters, `[capitalize,noabbrev]`, and its appendix chapters and their sections.
  const book = String.raw`\documentclass{book}
\usepackage{hyperref}
\usepackage[capitalize,noabbrev]{cleveref}
\begin{document}
\part{First}\label{part:a}
\chapter{Intro}\label{chap:a}
\section{Sec}\label{sec:a}
\begin{equation}a\label{eq:1}\end{equation}
\begin{figure}\caption{F}\label{fig:a}\end{figure}
\appendix
\chapter{Proofs}\label{app:a}
\section{More}\label{app:b}
\end{document}`;
  assert.deepEqual(["part:a", "chap:a", "sec:a", "eq:1", "fig:a"].map((key) => says(book, "\\cref", [key])), ["Part I", "Chapter 1", "Section 1.1", "Equation (1.1)", "Figure 1.1"]);
  assert.deepEqual(["part:a", "chap:a", "sec:a"].map((key) => says(book, "\\autoref", [key])), ["Part I", "chapter 1", "section 1.1"]);
  assert.deepEqual(["app:a", "app:b"].map((key) => says(book, "\\cref", [key])), ["Appendix A", "Appendix A.1"]);
  assert.deepEqual(["app:a", "app:b"].map((key) => says(book, "\\autoref", [key])), ["Appendix A", "section A.1"]);
  assert.equal(says(book, "\\Cref", ["app:a", "app:b"]), "Appendices A and A.1");
  // The document's own names: \crefname, only a \Crefname, and hyperref's \sectionautorefname.
  const named = article.replace("\\begin{document}", "\\crefname{figure}{plot}{plots}\\Crefname{table}{Tab.}{Tabs.}\\renewcommand{\\sectionautorefname}{Section}\n\\begin{document}");
  assert.equal(says(named, "\\cref", ["fig:a"]), "plot 1");
  assert.equal(says(named, "\\Cref", ["fig:a"]), "Plot 1");
  assert.equal(says(named, "\\cref", ["tab:b"]), "tab. 1");
  assert.equal(says(named, "\\autoref", ["sec:a"]), "Section 1");
});

test("B4-25: \\crefalias names a counter's labels as another type (Econometrica's appendices)", () => {
  const source = String.raw`\documentclass{article}
\usepackage{cleveref}
\crefname{appsec}{appendix}{appendices}
\begin{document}
\section{Intro}\label{sec:a}
\begin{appendices}
\crefalias{section}{appsec}
\crefalias{subsection}{appsec}
\section{Proofs}\label{app:a}
\subsection{Lemma}\label{app:b}
\end{appendices}
\end{document}`;
  assert.equal(says(source, "\\cref", ["sec:a"]), "section 1");
  assert.equal(says(source, "\\cref", ["app:a"]), "appendix A");
  assert.equal(says(source, "\\Cref", ["app:a", "app:b"]), "Appendices A and A.1");
  // A \crefalias before \appendix (pdflatex: "appendix 2").
  assert.equal(says(String.raw`\usepackage{cleveref}\begin{document}\section{A}\crefalias{section}{appendix}\section{B}\label{b}\end{document}`, "\\cref", ["b"]), "appendix 2");
});

test("B7-17: \\crefrange{a}{b} is one chip, \"eqs. (1) to (3)\"", () => {
  const source = String.raw`\documentclass{article}
\usepackage{cleveref}
\begin{document}
\begin{equation}a\label{eq:1}\end{equation}
\begin{equation}b\label{eq:2}\end{equation}
\begin{equation}c\label{eq:3}\end{equation}
By \crefrange{eq:1}{eq:3} and \Crefrange{eq:1}{eq:2}, done.
\end{document}`;
  assert.equal(says(source, "\\crefrange", ["eq:1", "eq:3"]), "eqs. (1) to (3)");
  const text = visibleText(source);
  assert.match(text, /By eqs\. \(1\) to \(3\) and Equations \(1\) to \(2\), done\./);
  assert.doesNotMatch(text, /\{eq:3\}|\{eq:2\}/);
});
