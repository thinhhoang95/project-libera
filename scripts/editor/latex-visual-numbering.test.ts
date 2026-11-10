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
import { readBibEntries, readCompiledBibliography, readLatexBibliographyReferences } from "../../src/lib/latex/project";
import { citationStyle, citationText, type BibLookup } from "../../src/lib/latex/codemirror/visual/references";
import { latexProjectField } from "../../src/lib/latex/codemirror/editing";
import { EMPTY_AUX, parseLatexAux } from "../../src/lib/latex/aux-file";

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

/** A lookup over entries as the project hands them over (a `.bib`'s first, compiled ones after). */
function lookup(entries: ReturnType<typeof readCompiledBibliography>): BibLookup {
  return (key) => {
    const matches = entries.filter((entry) => entry.key === key);
    const compiled = matches.find((entry) => entry.label !== undefined || entry.citeAuthor !== undefined || entry.number !== undefined);
    const entry = matches[0];
    return entry ? { author: entry.author ?? compiled?.author, year: entry.year ?? compiled?.year, title: entry.title, citeAuthor: compiled?.citeAuthor, label: compiled?.label, number: compiled?.number } : null;
  };
}

const NATBIB_BBL = String.raw`\begin{thebibliography}{2}
\bibitem[Jones et~al.(1990)Jones, Baker, and Williams]{jon90} Jones.
\bibitem[Smith(1991)]{smi91} Smith.
\end{thebibliography}`;

test("B6-15/B5-16: a numeric style prints numbers: the compiled .bbl over the .bib, natbib's numbers option, an author–year .aux", () => {
  // The .bib entry comes first in the project's list, the numeric .bbl's label wins.
  const bib = readBibEntries(String.raw`@article{vaswani, author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki}, title = {Attention}, year = {2017}}`);
  const bbl = readCompiledBibliography(String.raw`\begin{thebibliography}{10}
\bibitem{other} Other.
\bibitem{vaswani} Ashish Vaswani. \newblock Attention.
\end{thebibliography}`);
  const project = latexProjectField.init(() => ({ labels: [], bibEntries: [...bib, ...bbl], files: [] }));
  const text = visibleText("\\documentclass{article}\n\\begin{document}\nAs in \\cite{vaswani}.\n\\end{document}\n", [project]);
  assert.match(text, /As in \[2\]\./);
  assert.doesNotMatch(text, /Vaswani et al\./);
  // natbib with `numbers`: an author–year .bbl prints the entries' places, \citet the authors and the number.
  const numbers = citationStyle(readLatexDefinitions("\\usepackage[numbers]{natbib}"));
  const natbib = readCompiledBibliography(NATBIB_BBL);
  assert.equal(citationText({ command: "\\citep", keys: ["smi91", "jon90"] }, EMPTY_AUX, lookup(natbib), numbers), "[2, 1]");
  assert.equal(citationText({ command: "\\citet", keys: ["jon90"], post: "p.~5" }, EMPTY_AUX, lookup(natbib), numbers), "Jones et al. [1, p. 5]");
  // Without it, natbib's .aux numbers its author–year entries too: the authors win (SDID's "Athey et al. [13]").
  const aux = parseLatexAux(String.raw`\bibcite{athey2019}{{13}{2019}{{Athey et~al.}}{{Athey, Bayati, Imbens, and Qu}}}
\bibcite{lv2023}{{5}{2023{\natexlab{a}}}{{Lv et~al.}}{{Lv, Yan, and Qiu}}}
\bibcite{plain}{3}`);
  const authorYear = citationStyle(readLatexDefinitions("\\usepackage{natbib}"));
  const none = lookup([]);
  assert.equal(citationText({ command: "\\citet", keys: ["athey2019"] }, aux, none, authorYear), "Athey et\u00a0al. (2019)");
  assert.equal(citationText({ command: "\\citep", keys: ["athey2019"] }, aux, none, authorYear), "[Athey et\u00a0al. 2019]");
  assert.equal(citationText({ command: "\\citet", keys: ["athey2019"] }, aux, none, numbers), "Athey et\u00a0al. [13]");
  // natbib's \natexlab in the .aux year (GaLore's "2023\natexlaba").
  assert.equal(citationText({ command: "\\citep", keys: ["lv2023"] }, aux, none, authorYear), "[Lv et\u00a0al. 2023a]");
  // A numeric style's .aux (plain.bst): a number, without authors.
  assert.equal(citationText({ command: "\\cite", keys: ["plain"] }, aux, none, authorYear), "[3]");
});

test("B4-12/B4-14: textual citations keep their notes; apacite's \\citeA and natbib's author–year \\cite name the authors", () => {
  const natbib = lookup(readCompiledBibliography(NATBIB_BBL));
  const style = citationStyle(readLatexDefinitions("\\usepackage[authoryear]{natbib}"));
  // As pdflatex prints them (natbib, authoryear).
  assert.equal(citationText({ command: "\\citet", keys: ["jon90"], post: "p.~5" }, EMPTY_AUX, natbib, style), "Jones et al. (1990, p. 5)");
  assert.equal(citationText({ command: "\\citet", keys: ["jon90"], pre: "see", post: "p.~5" }, EMPTY_AUX, natbib, style), "Jones et al. (see 1990, p. 5)");
  assert.equal(citationText({ command: "\\citep", keys: ["jon90"], pre: "see", post: "ch.~2" }, EMPTY_AUX, natbib, style), "[see Jones et al. 1990, ch. 2]");
  assert.equal(citationText({ command: "\\cite", keys: ["jon90"] }, EMPTY_AUX, natbib, style), "Jones et al. (1990)");
  assert.equal(citationText({ command: "\\citet", keys: ["jon90", "smi91"] }, EMPTY_AUX, natbib, style), "Jones et al. (1990); Smith (1991)");
  // Without natbib, \cite is parenthetical; apacite's \citeA is textual.
  assert.equal(citationText({ command: "\\cite", keys: ["jon90"] }, EMPTY_AUX, natbib), "[Jones et al. 1990]");
  assert.equal(citationText({ command: "\\citeA", keys: ["smi91"] }, EMPTY_AUX, natbib), "Smith (1991)");
  const text = visibleText("\\documentclass{article}\n\\usepackage{apacite}\n\\begin{document}\nIn line with \\citeA[p.~3]{smi91}.\n\\end{document}\n", [latexProjectField.init(() => ({ labels: [], bibEntries: readCompiledBibliography(NATBIB_BBL), files: [] }))]);
  assert.match(text, /In line with Smith \(1991, p\. 3\)\./);
});

test("B4-15: apacite's .bbl gives the cited authors, the year (with its letter) and the title", () => {
  const entries = readCompiledBibliography(String.raw`\begin{thebibliography}{}

\bibitem [\protect \citeauthoryear {%
Aaronson%
}{%
Aaronson%
}{%
{\protect \APACyear {2001}}%
}]{%
aaronson2001}
\APACinsertmetastar {%
aaronson2001}%
\begin{APACrefauthors}%
Aaronson, D.%
\end{APACrefauthors}%
\unskip\
\newblock
\APACrefYearMonthDay{2001}{2}{}.
\newblock
{\BBOQ}\APACrefatitle {Price Pass-Through and the Minimum Wage} {Price
  pass-through and the minimum wage}.{\BBCQ}

\bibitem [\protect \citeauthoryear {%
Aizpurua-Olaizola%
, Soydaner%
\ \BBA {} Usobiaga%
}{%
Aizpurua-Olaizola%
\ \protect \BOthers {.}}{%
{\protect \APACyear {2016}{\protect \BCnt {1}}}%
}]{%
aiz2016}
Text.

\bibitem [\protect \citeauthoryear {%
Allegretto%
\ \BBA {} Reich%
}{%
Allegretto%
\ \BBA {} Reich%
}{%
{\protect \APACyear {2018}}%
}]{%
reich2018}
Text.
\end{thebibliography}`);
  assert.deepEqual(entries.map((entry) => [entry.key, entry.citeAuthor, entry.year]), [
    ["aaronson2001", "Aaronson", "2001"], ["aiz2016", "Aizpurua-Olaizola et al.", "2016a"], ["reich2018", "Allegretto and Reich", "2018"],
  ]);
  assert.equal(entries[0].title, "Price Pass-Through and the Minimum Wage");
  assert.equal(citationText({ command: "\\citeA", keys: ["reich2018"] }, EMPTY_AUX, lookup(entries)), "Allegretto and Reich (2018)");
});

/** A mounted Visual mode for `doc`, numbered as the app numbers it; `inspect` reads its DOM before it is destroyed. */
function mounted<T>(doc: string, inspect: (dom: HTMLElement) => T) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc), parent });
  view.dispatch({ effects: setNumbering.of(computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state))) });
  refreshVisualWidgets(view);
  try { return inspect(view.contentDOM); } finally { view.destroy(); parent.remove(); }
}

test("B4-10: a \\tag written in math is read whole, and a reference to it draws the math", () => {
  const source = String.raw`\begin{document}
\begin{equation}
a = b \tag{$\mathcal{I}$}\label{eq:I}
\end{equation}
By \eqref{eq:I} and \ref{eq:I}.
\end{document}`;
  assert.equal(number(source).labels.get("eq:I")?.number, "$\\mathcal{I}$");
  const chips = mounted(source, (dom) => [...dom.querySelectorAll(".cm-vis-ref")].map((chip) => ({ math: !!chip.querySelector(".katex"), label: chip.getAttribute("aria-label") })));
  assert.deepEqual(chips, [{ math: true, label: "Reference to (\\mathcal{I})" }, { math: true, label: "Reference to \\mathcal{I}" }]);
});

test("B4-09: \\hyperref[label]{text} draws its text as a link to the label", () => {
  const source = String.raw`\begin{document}
\section{Results}\label{sec:result}
By the \hyperref[sec:result]{identity lemma}, done.
\end{document}`;
  assert.match(visibleText(source), /By the identity lemma, done\./);
  const link = mounted(source, (dom) => dom.querySelector("[data-ref]")?.textContent);
  assert.equal(link, "identity lemma");
});

test("B4-24/B7-24: \\footnotemark and \\footnotetext share a number, in displays too; \\fnsymbol marks are symbols", () => {
  const source = String.raw`\begin{document}
Text.\footnote{First.}
\begin{equation*}
x \quad \text{for each $m$.\footnotemark}
\end{equation*}
\footnotetext{The map is integrable.}
Then\footnotemark[7] and \footnotetext[7]{Seventh.} and\footnote{Third.}
\renewcommand{\thefootnote}{\fnsymbol{footnote}}
\setcounter{footnote}{0}
Title\footnotemark
\footnotetext{Contact.}
\footnotetext[2]{Corresponding authors.}
\end{document}`;
  const numbers = number(source).entries.filter((entry) => entry.kind === "footnote").map((entry) => entry.number);
  assert.deepEqual(numbers, ["1", "2", "7", "7", "3", "*", "*", "†"]);
  const marks = mounted(source, (dom) => [...dom.querySelectorAll(".cm-vis-footnote-mark")].map((mark) => mark.textContent));
  assert.deepEqual(marks, ["1", "2", "7", "7", "3", "*", "*", "†"]);
});

test("B5-28: a listing with a caption is numbered, and its label refers to it", () => {
  const source = String.raw`\documentclass{book}
\usepackage{listings}
\usepackage{cleveref}
\begin{document}
\chapter{Introduction}
\begin{lstlisting}[caption={A Julia function, short}, label=lst:jl]
function f(x)
end
\end{lstlisting}
\begin{lstlisting}[title={Unnumbered}]
x
\end{lstlisting}
\lstinputlisting[caption=Loader,label={lst:load}]{load.jl}
\end{document}`;
  const labels = number(source).labels;
  assert.equal(labels.get("lst:jl")?.number, "1.1");
  assert.equal(labels.get("lst:load")?.number, "1.2");
  assert.equal(says(source, "\\cref", ["lst:jl"]), "listing 1.1");
  assert.equal(says(source, "\\autoref", ["lst:load"]), "Listing 1.2");
  assert.equal(number(source.replace("{book}", "{article}").replace("\\chapter{Introduction}", "")).labels.get("lst:jl")?.number, "1");
});

test("B7-27: a .bib named twice, or a key twice in it, is read once", () => {
  assert.deepEqual(readLatexBibliographyReferences(String.raw`\ifnum\x=1 \bibliography{abbrev3,crypto} \else \bibliography{abbrev3,crypto} \fi`), ["abbrev3.bib", "crypto.bib"]);
  assert.deepEqual(readBibEntries("@article{a, title={One}}\n@misc{a, title={Two}}\n@book{b, title={Three}}").map((entry) => [entry.key, entry.title]), [["a", "One"], ["b", "Three"]]);
});
