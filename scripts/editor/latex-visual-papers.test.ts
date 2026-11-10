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
import { columnSpans } from "../../src/lib/latex/codemirror/visual/table-model";
import { renderKatex } from "../../src/lib/latex/codemirror/visual/math-render";
import { parseAlgorithm2e } from "../../src/lib/latex/codemirror/visual/algorithm";
import { expandLatexMacros } from "../../src/lib/latex/macros/expand";
import { macroAt, readLatexDefinitions } from "../../src/lib/latex/macros/definitions";
import { readBibEntries, readCompiledBibliography } from "../../src/lib/latex/project";
import { citationText } from "../../src/lib/latex/codemirror/visual/references";
import { latexProjectField } from "../../src/lib/latex/codemirror/editing";
import { EMPTY_AUX } from "../../src/lib/latex/aux-file";
import { computeLatexNumbering, numberingEntryAt } from "../../src/lib/latex/macros/numbering";
import { chapterNumberingStart } from "../../src/lib/latex/macros/project-numbering";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

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

/* Regressions found by opening real papers in the Visual mode (arXiv sources:
 * Callaway & Sant'Anna 1803.09015, Borusyak et al. 2108.12419, Featherweight Go
 * 2005.11710, O'Donnell 2105.10386). Each test is the smallest source that
 * showed the problem. */

function number(source: string, options: Parameters<typeof computeLatexNumbering>[3] = {}) {
  const tree = parser.parse(source);
  return computeLatexNumbering(tree, (from, to) => source.slice(from, to), readLatexDefinitions(source), options);
}

function sectionNumbers(source: string, options: Parameters<typeof computeLatexNumbering>[3] = {}) {
  return number(source, options).entries.filter((entry) => entry.kind === "section").map((entry) => entry.number);
}

test("a \\the… format applies from where it is defined, not to what comes before it (Callaway & Sant'Anna's appendices)", () => {
  const source = String.raw`\documentclass{article}
\newtheorem{assumption}{Assumption}
\numberwithin{equation}{section}
\begin{document}
\section{Introduction}\label{intro}
\begin{assumption}\label{first}Irreversibility.\end{assumption}
\begin{equation}a=b\label{eq}\end{equation}
\appendix
\renewcommand{\thesection}{B}
\renewcommand{\theassumption}{B.\arabic{assumption}}\setcounter{assumption}{0}
\section{Extensions}
\begin{assumption}\label{later}Again.\end{assumption}
\end{document}`;
  const numbering = number(source);
  assert.equal(numbering.labels.get("intro")?.number, "1");
  assert.equal(numbering.labels.get("first")?.number, "1");
  assert.equal(numbering.labels.get("eq")?.number, "1.1");
  assert.equal(numbering.labels.get("later")?.number, "B.1");
  assert.deepEqual(sectionNumbers(source), ["1", "B"]);
});

test("a format written with a math prime is shown with the prime, and the plain format comes back after it (Borusyak et al.)", () => {
  const source = String.raw`\newtheorem{assumption}{Assumption}
\begin{document}
\begin{assumption}\label{a1}One.\end{assumption}
\renewcommand{\theassumption}{1$^\prime$}
\begin{assumption}\label{a1p}One, generalized.\end{assumption}
\renewcommand{\theassumption}{\arabic{assumption}}\setcounter{assumption}{1}
\begin{assumption}\label{a2}Two.\end{assumption}
\end{document}`;
  const labels = number(source).labels;
  assert.equal(labels.get("a1")?.number, "1");
  assert.equal(labels.get("a1p")?.number, "1′");
  assert.equal(labels.get("a2")?.number, "2");
});

test("a file \\input after a definition is numbered: the definition's extent in the main file does not hide it", () => {
  const main = String.raw`\newcommand{\f}{foo}
\begin{document}
\input{child}
\section{After}
\end{document}`;
  const child = String.raw`\section{Child}\begin{equation}x=y\end{equation}`;
  const childTree = parser.parse(child);
  const includes = (name: string) => (name === "child" ? { tree: childTree, read: (from: number, to: number) => child.slice(from, to) } : null);
  const numbering = number(main, { includes });
  assert.deepEqual(numbering.entries.filter((entry) => entry.kind === "section").map((entry) => entry.number), ["2"]);
  assert.equal(numbering.counters.equation, 1);
});

test("a \\WithSuffix definition or one missing its body does not switch numbering off for the rest of the file (Featherweight Go)", () => {
  const suffix = String.raw`\WithSuffix\newcommand\foo*{bar}
\begin{document}
\section{First}\label{first}
\end{document}`;
  assert.equal(number(suffix).labels.get("first")?.number, "1");
  const unfinished = String.raw`\newcommand{\broken}
\begin{document}
\section{First}\label{first}
\section{Second}
\end{document}`;
  assert.deepEqual(sectionNumbers(unfinished), ["1", "2"]);
  assert.equal(number(unfinished).labels.get("first")?.number, "1");
  // The body after the suffix is skipped, and nothing is reported missing.
  const defs = readLatexDefinitions(suffix);
  assert.equal(defs.problems.length, 0);
  assert.equal(defs.extents.some((extent) => extent.broken), false);
});

test("etoolbox's and biblatex's \\ifbool{…}, \\iffieldundef{…} are macros, not conditionals: later definitions are read (Borusyak et al.)", () => {
  const source = String.raw`\DeclareFieldFormat{textcitehyperref}{\bibhyperref{#1\ifbool{cbx:parens}{\bibcloseparen}{}}}
\renewbibmacro*{textcite}{\ifboolexpr{ not test {\iffieldundef{prenote}} }{}{}}
\ifdef\foo{}{}
\providecommand{\assumptionname}{Assumption}
\newif\ifdraft
\ifdraft \newcommand{\note}{draft} \fi
\begin{document}\end{document}`;
  const defs = readLatexDefinitions(source);
  assert.equal(macroAt(defs, "assumptionname", 0)?.body, "Assumption");
  assert.equal(macroAt(defs, "assumptionname", 0)?.unsupported, undefined);
  // A conditional made with \newif is one, whatever follows it.
  assert.equal(macroAt(defs, "note", 0)?.unsupported, true);
});

test("definitions in \\AtBeginDocument{…} and LyX's \\global\\long\\def last past their braces", () => {
  const source = String.raw`\AtBeginDocument{
\let\ref\Cref
}
\begin{document}
{\global\long\def\expec#1{\mathbb{E}\left[#1\right]}%
}
$\expec{x}$
\end{document}`;
  const defs = readLatexDefinitions(source);
  const ref = macroAt(defs, "ref", source.indexOf("$"));
  assert.equal(ref?.alias, true);
  assert.equal(ref?.body, "\\Cref");
  const expec = macroAt(defs, "expec", source.indexOf("$\\expec"));
  assert.equal(expec?.arity, 1);
  assert.equal(expec?.end, undefined);
});

test("a class that defines \\chapter (a custom class built on amsbook) numbers sections within chapters (O'Donnell's book)", () => {
  const source = String.raw`\documentclass{gsm-l-odonnell}
\begin{document}
\chapter{Boolean functions}
\section{On analysis}
\section{The Fourier expansion}
\chapter{Social choice}
\section{Social choice functions}\label{sec:social}
\end{document}`;
  const numbering = number(source);
  assert.deepEqual(numbering.entries.filter((entry) => entry.kind === "section").map((entry) => entry.number), ["1", "1.1", "1.2", "2", "2.1"]);
  assert.equal(numbering.labels.get("sec:social")?.number, "2.1");
  // A chapter file that continues the book: its first section is 2.1, not the eighth section.
  const chapter = String.raw`\chapter{Social choice}\section{Social choice functions}`;
  const continued = number(chapter, { start: { counters: { chapter: 1, section: 7 }, appendix: false } });
  assert.equal(numberingEntryAt(continued, chapter.indexOf("\\section"), "section")?.number, "2.1");
});

test("a figure holding a code listing or \\verb text is not replaced by a figure widget, which would hide the code", () => {
  for (const listing of [
    "\\begin{lstlisting}\nfunc main() { println(42) }\n\\end{lstlisting}",
    "\\begin{verbatim}\nfunc main() { println(42) }\n\\end{verbatim}",
    "\\verb|func main() { println(42) }|",
  ]) {
    const doc = `\\begin{document}\n\\begin{figure}\n${listing}\n\\caption{Example}\n\\end{figure}\n\\end{document}\n`;
    assert.equal(constructs(visualState(doc)).some((item) => item.startsWith("figure:")), false, listing);
    assert.match(visibleText(doc), /println\(42\)/);
  }
  // A figure of an image and a caption is still drawn as one.
  const image = "\\begin{document}\n\\begin{figure}\n\\includegraphics{plot.png}\n\\caption{Example}\n\\end{figure}\n\\end{document}\n";
  assert.equal(constructs(visualState(image)).some((item) => item.startsWith("figure:")), true);
});

test("a repeated column specification is bounded by its count, even when it repeats nothing", () => {
  const started = performance.now();
  assert.equal(columnSpans("*{100000000000000000000}{}"), null);
  assert.equal(columnSpans("*{10000000}{}"), null);
  assert.ok(performance.now() - started < 50);
  assert.deepEqual(columnSpans("*{3}{c}")?.map((column) => column.letter), ["c", "c", "c"]);
  assert.deepEqual(columnSpans("l*{2}{}r")?.map((column) => column.letter), ["l", "r"]);
});

/** A formula as the Visual mode draws it: the document's macros expanded, then KaTeX; null when it stays source. */
function drawn(preamble: string, formula: string) {
  const defs = readLatexDefinitions(`${preamble}\n\\begin{document}\\end{document}`);
  const expanded = expandLatexMacros(formula, defs, { mode: "math", pos: 0 });
  return expanded.ok ? renderKatex(expanded.text, false) : null;
}

test("the italic correction \\/ and \\protect draw nothing in a formula (O'Donnell's \\Var and \\Ex)", () => {
  const preamble = String.raw`\newcommand{\Ex}{\mathop{\bf E\/}}\newcommand{\Var}{\mathop{\bf Var\/}}\newcommand{\Tinf}{\protect\mathbf{I}}`;
  assert.ok(drawn(preamble, String.raw`\Var[f] \leq \Tinf[f]`));
  assert.ok(drawn(preamble, String.raw`\Ex_{x}[f(x)]`));
});

test("mathtools' psmallmatrix and the other delimited small matrices are drawn (Borusyak et al.'s rank condition)", () => {
  for (const env of ["psmallmatrix", "bsmallmatrix", "Bsmallmatrix", "vsmallmatrix", "Vsmallmatrix"]) {
    assert.ok(drawn("", String.raw`\text{rank}\left(\begin{${env}}Z_1 \\ Z_0\end{${env}}\right)`), env);
  }
});

test("mathtools' \\DeclarePairedDelimiter macros expand at their three sizes (Synthetic DiD's \\smallabs)", () => {
  const preamble = String.raw`\usepackage{mathtools}\DeclarePairedDelimiter\set{\{}{\}}\DeclarePairedDelimiter{\smallabs}{\lvert}{\rvert}`;
  const defs = readLatexDefinitions(`${preamble}\n\\begin{document}\\end{document}`);
  const expand = (text: string) => expandLatexMacros(text, defs, { mode: "math", pos: 0 }).text;
  assert.equal(expand(String.raw`\smallabs{x}`), String.raw`\mathopen{\lvert}x\mathclose{\rvert}`);
  assert.equal(expand(String.raw`\smallabs*{\frac{a}{b}}`), String.raw`\left\lvert \frac{a}{b} \right\rvert`);
  assert.equal(expand(String.raw`\smallabs[\big]{x}`), String.raw`\mathopen{\big\lvert}x\mathclose{\big\rvert}`);
  for (const formula of [String.raw`\smallabs{x}`, String.raw`\smallabs*{x}`, String.raw`\smallabs[\Big]{x}`, String.raw`\set{x : x > 0}`]) assert.ok(drawn(preamble, formula), formula);
});

test("pgffor loops that define a macro per letter are read as those macros (the max-flow paper's \\mB and \\cG)", () => {
  const preamble = String.raw`\usepackage{pgffor}
\foreach \x in {A,...,Z}{%
	\expandafter\xdef\csname m\x\endcsname{\noexpand\mathbf{\x}}
}
\foreach \x in {a,b,c}{\expandafter\xdef\csname v\x\endcsname{\noexpand\boldsymbol{\x}}}`;
  const defs = readLatexDefinitions(`${preamble}\n\\begin{document}\\end{document}`);
  assert.equal(macroAt(defs, "mB", 0)?.body, "\\mathbf{B}");
  assert.equal(macroAt(defs, "mZ", 0)?.body, "\\mathbf{Z}");
  assert.equal(macroAt(defs, "vc", 0)?.body, "\\boldsymbol{c}");
  assert.equal(macroAt(defs, "vd", 0), null);
  assert.ok(drawn(preamble, String.raw`\mB^\top \bf = \vb`.replace("\\bf", "f")));
  // A loop that does something else, or expands what it should not, is not read.
  const other = readLatexDefinitions(String.raw`\foreach \x in {1,...,3}{\node at (\x,0) {\x};}
\foreach \x in {A,B}{\expandafter\xdef\csname m\x\endcsname{\mathbf{\x}}}
\begin{document}\end{document}`);
  assert.equal(other.macros.size, 0);
});

test("a title's \\begingroup\\renewcommand\\thefootnote{}…\\endgroup draws only its footnote mark (Synthetic DiD)", () => {
  const doc = String.raw`\documentclass{article}
\title{Synthetic Difference in Differences \begingroup \renewcommand\thefootnote{}\footnote{We thank the referees.}\endgroup}
\author{Dmitry Arkhangelsky}
\begin{document}
\maketitle
Text.
\end{document}
`;
  const text = visibleText(doc);
  // The `\title{…}` line is source; the title \maketitle draws comes after it.
  const drawnTitle = text.slice(text.lastIndexOf("Synthetic Difference in Differences"));
  assert.match(drawnTitle, /^Synthetic Difference in Differences\s*\*/);
  assert.doesNotMatch(drawnTitle, /begingroup|renewcommand|thefootnote|endgroup/);
});

test("a user environment whose code holds conditionals, counters and glue is not drawn half-read: its \\begin stays source (Julia's jinput)", () => {
  const preamble = String.raw`\newcounter{jcounter}
\newenvironment{jinput}[1][]{\ifx#1\relax\else\setcounter{jcounter}{#1}\addtocounter{jcounter}{-1}\fi\refstepcounter{jcounter}\ttfamily\hspace*{-.7in}\noindent\begin{minipage}[t]{.19\textwidth}\vskip2ex\hspace*{\fill}\textcolor{incolor}{In[\arabic{jcounter}]: }\end{minipage}\begin{minipage}[t]{.8\textwidth}\vskip-0ex\begin{shaded}}{\end{shaded}\end{minipage}\par}
\newenvironment{note}{\noindent\textbf{Note.}}{\par}`;
  const doc = `${preamble}\n\\begin{document}\n\\begin{jinput}\nA = rand(3,3)\n\\end{jinput}\n\n\\begin{note}\nRead this.\n\\end{note}\n\\end{document}\n`;
  const text = visibleText(doc);
  assert.match(text, /A = rand\(3,3\)/);
  assert.doesNotMatch(text, /textwidth|2ex|plus|arabic|jcounter\}/);
  assert.match(text, /\\begin\{jinput\}/);
  // An environment whose code is text is still drawn with its header.
  assert.match(text, /Note\./);
  assert.doesNotMatch(text, /\\begin\{note\}/);
});

test("the named-theorem idiom draws its argument as the heading, not the \\renewcommand (O'Donnell's named)", () => {
  const preamble = String.raw`\newtheorem*{namedtheorem}{\theoremname}
\newcommand{\theoremname}{testing}
\newenvironment{named}[1]{ \renewcommand{\theoremname}{#1} \begin{namedtheorem}} {\end{namedtheorem}}`;
  const doc = `${preamble}\n\\begin{document}\n\\begin{named}{Poincar\\'{e} Inequality}\nFor any $f$, $\\mathrm{Var}[f] \\leq I[f]$.\n\\end{named}\n\\end{document}\n`;
  const text = visibleText(doc);
  assert.match(text, /Poincar(?:é|\\'\{e\}) Inequality/);
  assert.doesNotMatch(text, /renewcommand|testing/);
});

test("LyX's theorem names (\\protect\\assumptionname) and \\let\\ref\\Cref in \\AtBeginDocument draw as in the PDF (Borusyak et al.)", () => {
  const doc = String.raw`\documentclass{article}
\usepackage{cleveref}
\newtheorem{assumption}{\protect\assumptionname}
\AtBeginDocument{
\Crefname{assumption}{Assumption}{Assumptions}%
\let\ref\Cref
}
\providecommand{\assumptionname}{Assumption}
\begin{document}
\begin{assumption}[Parallel trends]\label{assu:A1}One.\end{assumption}
\begin{assumption}\label{assu:A2}Two.\end{assumption}
Under \ref{assu:A1,assu:A2} and \ref{assu:A2}.
\end{document}
`;
  const text = visibleText(doc);
  assert.match(text, /Assumption 1/);
  assert.doesNotMatch(text, /assumptionname/);
  assert.match(text, /Assumptions 1 and 2/);
  assert.doesNotMatch(text, /\?/);
});

test("a theorem the document calls algorithm is drawn as a theorem, not tried as a float (Callaway & Sant'Anna's bootstrap)", () => {
  const doc = String.raw`\documentclass{article}
\newtheorem{algorithm}{Algorithm}
\begin{document}
\begin{algorithm}\label{alg:boot}
1) Draw a realization. 2) Compute the estimator.
\end{algorithm}
\end{document}
`;
  const text = visibleText(doc);
  assert.match(text, /Algorithm 1/);
  assert.doesNotMatch(text, /\\begin\{algorithm\}/);
  assert.match(text, /Draw a realization/);
});

test("acmart's authors are all in the title block, and its abstract before \\begin{document} is drawn with the title (Featherweight Go)", () => {
  const doc = String.raw`\documentclass[acmsmall]{acmart}
\title{Featherweight Go}
\author{Robert Griesemer}
\affiliation{\institution{Google}}
\author{Philip Wadler}
\affiliation{\institution{University of Edinburgh}}
\author{Nobuko Yoshida}
\begin{abstract}
We describe a design for generics in Go.
\end{abstract}
\begin{document}
\maketitle
\section{Introduction}
Text.
\end{document}
`;
  const text = visibleText(doc);
  const drawn = text.slice(text.indexOf("Featherweight Go", text.indexOf("Preamble") + 1));
  for (const name of ["Robert Griesemer", "Philip Wadler", "Nobuko Yoshida"]) assert.match(drawn, new RegExp(name));
  assert.match(drawn, /Abstract\s*We describe a design for generics in Go\./);
  // In an article, the last \author is the one TeX keeps.
  const article = visibleText(String.raw`\documentclass{article}
\title{T}\author{First}\author{Second}
\begin{document}
\maketitle
\end{document}
`);
  assert.doesNotMatch(article.slice(article.lastIndexOf("T")), /First/);
});

test("imsart's frontmatter is drawn as the title block, and its abstract as text (Generalized Random Forests)", () => {
  const doc = String.raw`\documentclass[aos]{imsart}
\begin{document}
\begin{frontmatter}
\title{Generalized Random Forests}
\runtitle{Generalized Random Forests}
\author{\fnms{Susan} \snm{Athey}\ead[label=e1]{athey@stanford.edu}}
\address{Stanford Graduate School of Business \\ \printead{e1}}
\and
\author{\fnms{Stefan} \snm{Wager}\corref{}\ead[label=e3]{swager@stanford.edu}}
\runauthor{Athey, Tibshirani and Wager}
\begin{abstract}
We propose generalized random forests.
\end{abstract}
\end{frontmatter}
\section{Introduction}
\end{document}
`;
  const text = visibleText(doc);
  assert.match(text, /Generalized Random Forests/);
  assert.match(text, /Susan Athey/);
  assert.match(text, /Stefan Wager/);
  assert.match(text, /We propose generalized random forests\./);
  assert.doesNotMatch(text, /\\fnms|\\runtitle|\\begin\{frontmatter\}|\\address/);
  // A frontmatter holding anything else stays source.
  const other = visibleText(doc.replace("\\runtitle{Generalized Random Forests}", "Some text here."));
  assert.match(other, /\\begin\{frontmatter\}/);
});

test("\\index entries are small tags, not raw commands (O'Donnell's book)", () => {
  const doc = String.raw`\begin{document}
In this section we describe social choice,
\index{social choice}
a topic studied by economists. \index{Arrow's Theorem@Arrow's Theorem!proof}
\end{document}
`;
  const text = visibleText(doc);
  assert.doesNotMatch(text, /\\index/);
  assert.match(text, /social choice/);
  assert.match(text, /Arrow's Theorem › proof/);
});

test("a chapter's references to another chapter resolve without a compile; the .aux, when there is one, wins (max-flow paper)", async () => {
  const files: Record<string, string> = {
    "nb/main.tex": String.raw`\documentclass{article}
\begin{document}
\input{intro}
\input{spanner}
\input{jtree}
\end{document}`,
    "nb/intro.tex": String.raw`\section{Introduction}\label{sec:intro}`,
    "nb/spanner.tex": String.raw`\section{Spanners}\label{sec:spanner}\newtheorem{theorem}{Theorem}\begin{theorem}\label{thm:spanner}A spanner.\end{theorem}`,
    "nb/jtree.tex": String.raw`\section{Data Structure Chain}\label{sec:jtree} By Section~\ref{sec:spanner} and \ref{sec:intro}.`,
  };
  const start = await chapterNumberingStart("nb/jtree.tex", "nb/main.tex", async (path) => files[path] ?? "");
  const numbering = number(files["nb/jtree.tex"], { start });
  assert.equal(numbering.labels.get("sec:jtree")?.number, "3");
  assert.ok(numbering.labels.get("sec:jtree")!.pos >= 0);
  assert.deepEqual(numbering.labels.get("sec:spanner"), { number: "2", kind: "section", pos: -1, title: "Spanners" });
  assert.equal(numbering.labels.get("sec:intro")?.number, "1");
  const { labelTarget } = await import("../../src/lib/latex/codemirror/visual/references");
  assert.equal(labelTarget("sec:spanner", numbering, EMPTY_AUX)?.number, "2");
  assert.equal(labelTarget("sec:spanner", numbering, { labels: { "sec:spanner": { number: "5", page: "9" } }, citations: {} })?.number, "5");
  // A label of this file stays this file's.
  assert.equal(labelTarget("sec:jtree", numbering, { labels: { "sec:jtree": { number: "7", page: "1" } }, citations: {} })?.number, "3");
});

test("algorithm2e's \\KwTo in a loop header and its side comments in parentheses are read (Synthetic DiD, max-flow paper)", () => {
  const variance = parseAlgorithm2e(String.raw`\For{$b \leftarrow 1$ \KwTo $B$}{Compute $\hat\tau^{(b)}$\;}`, { numbered: false, ends: true });
  assert.ok(variance);
  assert.equal(variance.lines[0].lead, "for");
  assert.match(variance.lines[0].text, /\\textbf\{to\}/);
  assert.doesNotMatch(variance.lines[0].text, /KwTo/);
  const spanner = parseAlgorithm2e(String.raw`\For(\tcp*[f]{Re-set level-$\geq j$ sparsifiers.}){$i = j, \dots, L$}{Rebuild $H_i$\;}
\ForEach(\label{line:each}){$e \in E$}{Update $e$\;}
\If(\tcp*[h]{rare}){$x > 0$}{Stop\;}`, { numbered: true, ends: true });
  assert.ok(spanner);
  assert.equal(spanner.lines[0].comment, "Re-set level-$\\geq j$ sparsifiers.");
  assert.equal(spanner.lines[0].text, "$i = j, \\dots, L$");
  const each = spanner.lines.find((line) => line.text === "$e \\in E$");
  assert.ok(each);
  assert.equal(each.comment, undefined);
  assert.equal(spanner.lines.find((line) => line.lead === "if")?.comment, "rare");
  // Parentheses that do not close leave the algorithm as source.
  assert.equal(parseAlgorithm2e(String.raw`\For(\tcp{x}{c}{b\;}`, { numbered: false, ends: true }), null);
});

test("floats with adjustbox, a \\subcaption* note or an algorithm's prose are drawn whole, with that text (SDID, Callaway & Sant'Anna, GRF)", () => {
  const adjust = "\\begin{document}\n\\begin{table}\n\\caption{Results}\n\\begin{adjustbox}{width=\\linewidth}\n\\begin{tabular}{lc}\na & 1 \\\\\nb & 2\n\\end{tabular}\n\\end{adjustbox}\n\\end{table}\n\\end{document}\n";
  assert.equal(constructs(visualState(adjust)).some((item) => item.startsWith("figure:")), true);
  const note = "\\begin{document}\n\\begin{figure}[t]\n\\caption{Minimum wage effects}\n\\centering\n\\includegraphics{plot.pdf}\n\\subcaption*{\\textit{Notes:} The effect of the minimum wage on teen employment.}\n\\end{figure}\n\\end{document}\n";
  assert.equal(constructs(visualState(note)).some((item) => item.startsWith("figure:")), true);
  assert.match(visibleText(note), /Notes: The effect of the minimum wage on teen employment\./);
  const prose = String.raw`\documentclass{article}
\usepackage{algorithm,algpseudocode}
\begin{document}
\begin{algorithm}[t]
\caption{Generalized random forest}\label{alg:forest}
\vspace{-0.4\baselineskip}
\justify
All tuning parameters are pre-specified, including the number of trees $B$.
\begin{algorithmic}[1]
\Procedure{GeneralizedRandomForest}{set of examples $\mathcal{S}$}
\State weight vector $\alpha \gets 0$
\EndProcedure
\end{algorithmic}
\end{algorithm}
\end{document}
`;
  assert.equal(constructs(visualState(prose)).some((item) => item.startsWith("figure:")), true);
  const text = visibleText(prose);
  assert.match(text, /All tuning parameters are pre-specified, including the number of trees/);
  assert.doesNotMatch(text, /\\justify|\\vspace|\\caption/);
  // Prose after the lines is the float's note, drawn under it.
  const after = prose.replace("\\end{algorithmic}\n", "\\end{algorithmic}\nMore text after.\n");
  assert.equal(constructs(visualState(after)).some((item) => item.startsWith("figure:")), true);
  assert.match(visibleText(after), /More text after\./);
});

test("a box's optional arguments do not leave it raw in a table cell (GRF's \\parbox[b][0.25\\textwidth][c]{…}{…})", () => {
  const doc = String.raw`\begin{document}
\begin{tabular}{cc}
\parbox[b][0.25\textwidth][c]{0.1\textwidth}{$\cdots$} & x \\
\end{tabular}
\end{document}
`;
  const text = visibleText(doc);
  assert.doesNotMatch(text, /\\parbox|textwidth/);
});

test("thmtools' restatable is drawn and numbered as the theorem it names; \\texorpdfstring shows its TeX (max-flow paper)", () => {
  const doc = String.raw`\documentclass{article}
\usepackage{thmtools,thm-restate}
\newtheorem{theorem}{Theorem}
\begin{document}
\section{Spanners via \texorpdfstring{$\ell_1$}{l1} embeddings}
\begin{theorem}\label{thm:first}First.\end{theorem}
\begin{restatable}[Static embedding]{theorem}{staticEmbedding}
\label{thm:static}
Every graph has a spanner.
\end{restatable}
See Theorem~\ref{thm:static}.
\end{document}
`;
  const numbering = number(doc);
  assert.equal(numbering.labels.get("thm:static")?.number, "2");
  const text = visibleText(doc);
  assert.match(text, /Theorem 2/);
  assert.match(text, /Static embedding/);
  assert.match(text, /Every graph has a spanner\./);
  assert.doesNotMatch(text, /\\begin\{restatable\}|staticEmbedding/);
  assert.doesNotMatch(text, /texorpdfstring|\bl1\b/);
  assert.match(text, /Spanners via/);
});

test("formulas in captions and algorithm steps expand math macros, resolve references and keep broken delimiters as source", () => {
  const preamble = String.raw`\documentclass{article}
\usepackage{amsmath,algorithm2e}
\DeclareMathOperator*{\argmin}{arg\,min}
\newcommand{\p}[1]{\left(#1\right)}`;
  // Synthetic DiD's Algorithm 1: a displayed formula with \argmin in a statement.
  const algorithm = `${preamble}
\\begin{document}
\\begin{algorithm}[t]
\\KwData{$Y, W$}
Compute the estimator \\begin{equation*}\\hat\\tau = \\argmin_{\\tau}\\p{x - \\tau}\\end{equation*}\\;
\\caption{SDID}
\\end{algorithm}
\\end{document}
`;
  const text = visibleText(algorithm);
  assert.doesNotMatch(text, /\\argmin|\\begin\{equation\*\}/);
  // A reference in a caption's formula shows its number; a broken formula stays source.
  const caption = String.raw`\documentclass{article}
\begin{document}
\begin{equation}a=b\label{e}\end{equation}
\begin{figure}
\includegraphics{x.png}
\caption{Weights $w_{\ref{e}}$ and a broken $x formula.}
\end{figure}
\end{document}
`;
  const drawn = visibleText(caption);
  assert.doesNotMatch(drawn, /\\ref/);
  assert.match(drawn, /\$x formula/);
});

test("enumitem's lists of the document's own are drawn and numbered as their kind (O'Donnell's exercises)", () => {
  const doc = String.raw`\documentclass{book}
\usepackage{enumitem}
\newlist{exercises}{enumerate}{6}
\setlist[exercises,1]{leftmargin=*,label=\thechapter.\arabic*}
\setlist[exercises,2]{leftmargin=\parindent,label=(\emph{\alph*})}
\begin{document}
\chapter{Social choice}
\begin{exercises}
\item For each function, determine if it is odd.\label{ex:odd}
\item Prove May's Theorem:
\begin{exercises}
\item Show that $f$ is symmetric.
\end{exercises}
\end{exercises}
See Exercise~\ref{ex:odd}.
\end{document}
`;
  const text = visibleText(doc);
  assert.doesNotMatch(text, /\\item|\\begin\{exercises\}/);
  assert.match(text, /1\s*For each function/);
  assert.match(text, /2\s*Prove May's Theorem/);
  assert.match(text, /\(a\)\s*Show that/);
  // The reference shows the chapter's number, as the label does in the PDF.
  assert.equal(number(doc).labels.get("ex:odd")?.number, "1.1");
});

test("title declarations written in the body right before \\maketitle are folded into the title block (DiD, SDID, Carlini & Wagner)", () => {
  const doc = String.raw`\documentclass{article}
\begin{document}

\title{Towards Evaluating the Robustness \\ of Neural Networks}
\author{Nicholas Carlini \qquad David Wagner \\ University of California, Berkeley}
% the date is empty
\date{}

\maketitle

\section{Introduction}
\end{document}
`;
  const text = visibleText(doc);
  assert.doesNotMatch(text, /\\title|\\author|\\date/);
  assert.match(text, /Towards Evaluating the Robustness/);
  assert.match(text, /Nicholas Carlini/);
  // Something else between them and \maketitle: they stay source.
  const other = visibleText(doc.replace("\\date{}", "\\date{}\n\\setlength{\\parskip}{0pt}"));
  assert.match(other, /\\title/);
});

test("a control symbol the document defines (\\1) expands, and the TeX.SX \\widebar is drawn as a bar (Generalized Random Forests)", () => {
  const preamble = String.raw`\makeatletter
\newcommand*\widebar[1]{\@ifnextchar^{{\wide@bar{#1}{0}}}{\wide@bar{#1}{1}}}
\newcommand*\wide@bar[2]{\setbox0\hbox{$#1$}\mathaccent"0362{#1}}
\makeatother
\newcommand{\bY}{\widebar{Y}}
\newcommand{\1}{\mathbf{1}}`;
  assert.ok(drawn(preamble, String.raw`\rho_i = Y_i - \bY_p`));
  assert.ok(drawn(preamble, String.raw`\psi_{\theta}(Y_i) = q - \1\{Y_i \leq \theta\}`));
  // Undefined control symbols are left for KaTeX, which draws its own (`\!`, `\|`).
  assert.ok(drawn("", String.raw`\|x\|\!+\!y`));
});

test("tabbing's tab stops are gaps and its formulas are drawn; \\= elsewhere is still a macron (Featherweight Go's proofs)", () => {
  const doc = String.raw`\begin{document}
\begin{tabbing}
$e' = x$ \= and $t_b = y$ \\
\> $\Gamma \vdash e : t$ by inversion
\end{tabbing}
Caf\=e
\end{document}
`;
  const text = visibleText(doc);
  assert.doesNotMatch(text, /\\=|\\>|\\begin\{tabbing\}/);
  assert.match(text, /by inversion/);
  assert.match(text, /Cafē/);
});

test("mathpartir's mathpar and \\inferrule are drawn as rules (Featherweight Go's typing rules)", () => {
  const preamble = String.raw`\documentclass{article}
\usepackage{mathpartir}
\newcommand{\ov}[1]{\overline{#1}}
\newcommand{\fields}{\mathit{fields}}`;
  const doc = `${preamble}
\\begin{document}
\\begin{mathpar}
\\inferrule
  {(\\mathsf{type}~t_S~\\mathsf{struct}\\{\\ov{f~t}\\}) \\in \\ov{D}}
  {\\fields(t_S) = \\ov{f~t}}

\\inferrule[t-call]
  {\\Gamma \\vdash e : t \\and \\Gamma \\vdash \\ov{e} : \\ov{t}}
  {\\Gamma \\vdash e.m(\\ov{e}) : u}
\\\\
\\inferrule*[right=r-field]
  {}
  {\\text{$v$ is a value}}
\\end{mathpar}
$\\inferrule{a}{b}$ inline too.
\\end{document}
`;
  const state = visualState(doc);
  const math = constructs(state).filter((item) => item.startsWith("math:"));
  assert.equal(math.length, 2);
  const text = visibleText(doc);
  assert.doesNotMatch(text, /\\inferrule|\\begin\{mathpar\}/);
  assert.match(text, /t-call/i);
  assert.match(text, /r-field/i);
});

test("ctable's tables are drawn and numbered, with their notes (Callaway & Sant'Anna)", () => {
  const doc = String.raw`\documentclass{article}
\usepackage{ctable}
\begin{document}
\begin{table}\caption{Earlier}\begin{tabular}{l}x\end{tabular}\end{table}
\ctable[caption={Summary Statistics for Main Dataset},label=tab:ss, pos=t,notespar]{lcccc}{\tnote[]{\textit{Notes}: Summary statistics for counties.}}{\FL
\multicolumn{1}{l}{}&\multicolumn{1}{c}{Treated}&\multicolumn{1}{c}{Untreated}&\multicolumn{1}{c}{Diff.}&\multicolumn{1}{c}{P-val}\ML
~~Midwest&0.59&0.34&0.25&0.00\NN
~~South&0.27&0.59&-0.32&0.00\LL
}
See Table~\ref{tab:ss}.
\end{document}
`;
  assert.equal(number(doc).labels.get("tab:ss")?.number, "2");
  assert.equal(constructs(visualState(doc)).filter((item) => item.startsWith("figure:")).length, 2);
  const text = visibleText(doc);
  assert.doesNotMatch(text, /\\ctable|\\FL|\\NN|\\ML|\\LL/);
  assert.match(text, /Table 2: Summary Statistics for Main Dataset/);
  assert.match(text, /Midwest/);
  assert.match(text, /Notes: Summary statistics for counties\./);
});

test("batch 3 numbering: macro regions, appendix letters, body \\counterwithin, \\value, title footnotes, sub-caption labels", () => {
  // SIAM's environment macros (\bequation … \end{equation}): what follows a region is numbered.
  const pairs = String.raw`\newcommand{\bequation}{\begin{equation}}
\newcommand{\bfigure}{\begin{figure}}
\begin{document}
\section{One}
\bequation\label{b} y \end{equation}
\bfigure\includegraphics{c}\caption{C}
\end{figure}
\subsection{Two}\label{s2}
\begin{equation}\label{e} z \end{equation}
\section{Three}\label{s3}
\end{document}`;
  const regions = number(pairs).labels;
  assert.equal(regions.get("s2")?.number, "1.1");
  assert.equal(regions.get("e")?.number, "2");
  assert.equal(regions.get("s3")?.number, "2");
  // A class's \def\thesection before \appendix gives way to letters (ICML, JMLR).
  const appendix = String.raw`\def\thesection{\arabic{section}}
\begin{document}
\section{Intro}\label{i}
\appendix
\section{Details}\label{a}
\end{document}`;
  assert.equal(number(appendix).labels.get("i")?.number, "1");
  assert.equal(number(appendix).labels.get("a")?.number, "A");
  // \counterwithin in the body applies from there (SimCLR's figures after \appendix).
  const within = String.raw`\begin{document}
\section{Intro}
\begin{figure}\caption{Main}\label{f1}\end{figure}
\appendix
\counterwithin{figure}{section}
\section{More}
\begin{figure}\caption{Extra}\label{f2}\end{figure}
\end{document}`;
  assert.equal(number(within).labels.get("f1")?.number, "1");
  assert.equal(number(within).labels.get("f2")?.number, "A.1");
  // \setcounter{c}{\value{d}} (SIAM's insets save and restore the figure counter).
  const saved = String.raw`\newcounter{figtemp}
\begin{document}
\begin{figure}\caption{A}\label{fa}\end{figure}
\setcounter{figtemp}{\value{figure}}\setcounter{figure}{0}
\begin{figure}\caption{Inset}\end{figure}
\setcounter{figure}{\value{figtemp}}
\begin{figure}\caption{B}\label{fb}\end{figure}
\end{document}`;
  assert.equal(number(saved).labels.get("fb")?.number, "2");
  // A footnote in the title does not count: \maketitle starts them again.
  const title = String.raw`\title{T\footnote{x}}
\begin{document}
\maketitle
Body.\footnote{a}
\end{document}`;
  assert.deepEqual(number(title).entries.filter((entry) => entry.kind === "footnote").map((entry) => entry.number), ["1", "1"]);
  // A label inside a sub-figure's caption (Normalizing Flows).
  const sub = String.raw`\begin{document}
\begin{figure}
\begin{subfigure}{0.4\textwidth}\includegraphics{a}\caption{Forward\label{fwd}}\end{subfigure}
\caption{Flows}\label{flows}
\end{figure}
\end{document}`;
  assert.equal(number(sub).labels.get("fwd")?.number, "1a");
});

test("batches 3, 5 and 6: template packages, float layout, spacing in formulas, dingbats, dashed rules, dcolumn, comments", async () => {
  // A template's natbib.sty (ICLR, ACL) does not hide natbib's commands from the Visual mode.
  const natbib = readLatexDefinitions(String.raw`\DeclareRobustCommand\citep{\begingroup\NAT@swatrue\let\NAT@ctype\z@\NAT@partrue\@ifstar{\NAT@fulltrue\NAT@citetp}{\NAT@fullfalse\NAT@citetp}}
\newcommand\cref{\@cref{cref}}`, undefined, { file: "natbib.sty" });
  assert.equal(macroAt(natbib, "citep", 0), null);
  assert.equal(macroAt(natbib, "cref", 0), null);
  // With hyperref, a preamble \renewcommand{\ref}{\hyperref} is undone at \begin{document}; one in \AtBeginDocument is not.
  assert.equal(macroAt(readLatexDefinitions(String.raw`\usepackage{hyperref}\renewcommand{\ref}{\hyperref}\begin{document}\end{document}`), "ref", 0), null);
  assert.equal(macroAt(readLatexDefinitions(String.raw`\usepackage{hyperref}\AtBeginDocument{\let\ref\Cref}\begin{document}\end{document}`), "ref", 0)?.alias, true);
  // Floats with ICML's \vskip, \vspace*, an unbraced \setlength, a length assignment and acmart's \Description are drawn whole.
  for (const layout of ["\\vskip 0.15in", "\\vspace*{2pt}", "\\setlength\\tabcolsep{3pt}", "\\aboverulesep = 2mm", "\\Description{A plot of the agents.}", "\\vskip -0.1in plus 2pt"]) {
    const doc = `\\begin{document}\n\\begin{table}\n\\caption{Results}\n${layout}\n\\centering\n\\begin{tabular}{lc}\na & 1 \\\\\n\\end{tabular}\n\\end{table}\n\\end{document}\n`;
    assert.equal(constructs(visualState(doc)).some((item) => item.startsWith("figure:")), true, layout);
  }
  // Vertical space in a formula (SimPO's definitions) and tikzmark nodes (Self-RAG's tokens) are drawn.
  assert.ok(drawn("", String.raw`p(y)=\frac{1}{|y|}\log\pi(y). \vspace{-0.5em}`));
  assert.ok(drawn("", String.raw`p(\tikzmarknode[draw=red,thick]{test}{\textbf{Retrieve}} = 1)`));
  // pifont's dingbats, in text and in cells; arydshln's dashed rules are rules.
  const ding = String.raw`\newcommand{\cmark}{\ding{51}}
\begin{document}
Yes \ding{51}, no \ding{55}.
\begin{tabular}{lc}
A & \cmark \\ \hdashline
\multicolumn{2}{l}{\it Training} \\ \cdashline{1-2}
B & \ding{55} \\
\end{tabular}
\end{document}
`;
  const text = visibleText(ding);
  assert.doesNotMatch(text, /\\ding|\\hdashline|\\cdashline|\\multicolumn/);
  assert.match(text, /Yes ✓, no ✗/);
  // dcolumn's D columns: a grid, with the stars of a coefficient raised.
  const dcolumn = String.raw`\usepackage{dcolumn}
\begin{document}
\begin{tabular}{l*{2}{D{.}{.}{3.2}}}
Minimum wage & 1.41^{***} & 0.20 \\
\end{tabular}
\end{document}
`;
  const table = visibleText(dcolumn);
  assert.doesNotMatch(table, /D\{\.\}|\^\{\*\*\*\}|\\begin\{tabular\}/);
  assert.match(table, /Minimum wage/);
  // The comment package's environment is left out (faded), as \iffalse is, and not numbered.
  const comment = String.raw`\begin{document}
\section{Kept}
\begin{comment}
\section{Dropped}
\end{comment}
\section{Next}\label{next}
\end{document}`;
  assert.equal(number(comment).labels.get("next")?.number, "2");
  // Control symbols that typeset nothing are hidden in text.
  assert.doesNotMatch(visibleText("\\begin{document}\nRNN\\@. Done.\n\\end{document}\n"), /\\@/);
});

test("rest of batch 3: float notes, threeparttable, xparse g, bib accents, natexlab, fancyref, ICML and JMLR titles, redefined \\(", () => {
  // Applied economics' notes: a paragraph, a notes minipage, threeparttable's tablenotes.
  const notes = [
    "\\caption{Effects}\n\\begin{tabular}{lc}\na & 1 \\\\\n\\end{tabular}\n\\vspace{1mm}\n\\begin{singlespace}\\noindent\\footnotesize\\textit{Notes}: Standard errors in parentheses.\\end{singlespace}",
    "\\caption{Effects}\n\\begin{tabular}{lc}\na & 1 \\\\\n\\end{tabular}\n\\begin{minipage}{\\textwidth}\\footnotesize Notes: Standard errors in parentheses.\\end{minipage}",
    "\\begin{threeparttable}\n\\caption{Effects}\n\\begin{tabular}{lc}\na & 1\\tnote{a} \\\\\n\\end{tabular}\n\\begin{tablenotes}\\item[a] Standard errors in parentheses.\\end{tablenotes}\n\\end{threeparttable}",
  ];
  for (const body of notes) {
    const doc = `\\begin{document}\n\\begin{table}\n${body}\n\\end{table}\n\\end{document}\n`;
    assert.equal(constructs(visualState(doc)).some((item) => item.startsWith("figure:")), true, body);
    const text = visibleText(doc);
    assert.match(text, /Standard errors in parentheses\./);
    assert.match(text, /Table 1: Effects/);
    assert.doesNotMatch(text, /\\begin\{|\\footnotesize|\\item|\\tnote/);
  }
  // xparse's g arguments (Monotone Additive Statistics' \E{X} and \E{X}{\mu}).
  const xparse = String.raw`\DeclareDocumentCommand\E{ m g }{\mathbb{E}\IfNoValueTF{#2}{}{_{#2}}\left[#1\right]}`;
  assert.ok(drawn(xparse, String.raw`\log\E{e^{aX}}`));
  assert.ok(drawn(xparse, String.raw`\E{X}{\mu} = 0`));
  // .bib values with \" accents and nested braces; \natexlab in compiled years.
  const bib = readBibEntries(String.raw`@article{fuchs2009, author = {Fuchs-Sch\"undeln, Nicola and Sch\"undeln, Matthias}, title = {{The {Long} title}}, year = 2009}
@article{hyv, author = "Hyv\"arinen, Aapo", year = "1999"}`);
  assert.equal(bib[0].author, "Fuchs-Sch\\\"undeln, Nicola and Sch\\\"undeln, Matthias");
  assert.equal(bib[1].author, "Hyv\\\"arinen, Aapo");
  const natexlab = readCompiledBibliography(String.raw`\begin{thebibliography}{2}
\bibitem[{Bickel and Lehmann(1975{\natexlab{a}})}]{bl75}
Bickel.
\end{thebibliography}`);
  assert.equal(natexlab[0].year, "1975a");
  // fancyref.
  const fancy = String.raw`\begin{document}
\section{Intro}\label{sec:intro}
See \fref{sec:intro} and \Fref{sec:intro}.
\end{document}`;
  assert.match(visibleText(fancy), /See section 1 and Section 1\./);
  // ICML's title block and JMLR's author block.
  const icml = String.raw`\begin{document}
\twocolumn[
\icmltitle{A Simple Framework for Contrastive Learning}
\begin{icmlauthorlist}
\icmlauthor{Ting Chen}{goo}
\icmlauthor{Simon Kornblith}{goo}
\end{icmlauthorlist}
\icmlaffiliation{goo}{Google Research, Brain Team}
\vskip 0.3in
]
\printAffiliationsAndNotice{}
Text.
\end{document}
`;
  const icmlText = visibleText(icml);
  assert.match(icmlText, /A Simple Framework for Contrastive Learning/);
  assert.match(icmlText, /Ting Chen/);
  assert.match(icmlText, /Google Research, Brain Team/);
  assert.doesNotMatch(icmlText, /\\icml|\\twocolumn|\\printAffiliations/);
  const jmlr = String.raw`\documentclass{article}
\title{Normalizing Flows}
\author{\name George Papamakarios \email gpapamak@google.com \\ \addr DeepMind}
\editor{Ryan Adams}
\begin{document}
\maketitle
\end{document}
`;
  const jmlrText = visibleText(jmlr);
  assert.doesNotMatch(jmlrText.slice(jmlrText.lastIndexOf("Normalizing Flows")), /\\name|\\email|\\addr|\\editor/);
  assert.match(jmlrText, /George Papamakarios/);
  // SIAM's \renewcommand{\(}{\left(}: the parentheses are drawn, not a formula.
  const siam = String.raw`\renewcommand{\(}{\left(}\renewcommand{\)}{\right)}
\begin{document}
Then $x\(y\)$ holds.
\end{document}`;
  assert.ok(drawn(String.raw`\renewcommand{\(}{\left(}\renewcommand{\)}{\right)}`, String.raw`\log\(\frac{2}{\eta}\)`));
  assert.doesNotMatch(visibleText(siam), /\\end\{document\}x/);
});

test("a compiled bibliography gives citations their authors, years and numbers when there is no .bib (arXiv sources)", () => {
  const cite = (command: string, keys: string[], entries: ReturnType<typeof readCompiledBibliography>) => citationText({ command, keys }, EMPTY_AUX, (key) => {
    const entry = entries.find((candidate) => candidate.key === key);
    return entry ? { author: entry.author, year: entry.year, title: entry.title, citeAuthor: entry.citeAuthor, label: entry.label } : null;
  });
  // biblatex's .bbl (Borusyak et al.), with an entry repeated in a second reference section.
  const biblatex = readCompiledBibliography(String.raw`\refsection{0}
    \entry{Abraham2018}{article}{}
      \name{author}{2}{}{%
        {{hash=3011926b49b3aa7b3e8913ca855e42fc}{%
           family={Sun},
           familyi={S\bibinitperiod},
           given={Liyang},
           giveni={L\bibinitperiod}}}%
        {{hash=1bfe7aacc440efc360e6a6e3eaa7a2d3}{%
           family={Abraham},
           familyi={A\bibinitperiod},
           given={Sarah},
           giveni={S\bibinitperiod}}}%
      }
      \field{labelnamesource}{author}
      \field{title}{{Estimating Dynamic Treatment Effects in Event Studies}}
      \field{year}{2021}
    \endentry
    \entry{Abraham2018}{article}{}
      \name{author}{1}{}{%
        {{hash=0}{family={Wrong}}}%
      }
      \field{year}{1999}
    \endentry
  \endrefsection`);
  assert.equal(biblatex.length, 1);
  assert.equal(biblatex[0].year, "2021");
  assert.equal(cite("\\textcite", ["Abraham2018"], biblatex), "Sun and Abraham (2021)");
  // natbib's author-year labels.
  const natbib = readCompiledBibliography(String.raw`\begin{thebibliography}{2}
\bibitem[{Abadie et~al.(2010)Abadie, Diamond, and Hainmueller}]{abadie2010}
Abadie, A., A.~Diamond, and J.~Hainmueller.
\newblock Synthetic control methods.
\bibitem[Card and Krueger(1994)]{card1994}
Card, D. and A.~B. Krueger.
\end{thebibliography}`);
  assert.equal(cite("\\citet", ["abadie2010"], natbib), "Abadie et al. (2010)");
  assert.equal(cite("\\citep", ["card1994"], natbib), "[Card and Krueger 1994]");
  // The harvard package (Callaway & Sant'Anna's .bbl).
  const harvard = readCompiledBibliography(String.raw`\begin{thebibliography}{xx}
\harvarditem{Abadie}{2005}{Abadie2005}
Abadie, A.  \harvardyearleft 2005\harvardyearright , "Semiparametric estimators,"
\harvarditem[Abadie et~al.]{Abadie, Diamond \harvardand\ Hainmueller}{2010}{Abadie2010}
Abadie, A., Diamond, A.
\end{thebibliography}`);
  assert.equal(cite("\\citet", ["Abadie2005"], harvard), "Abadie (2005)");
  assert.equal(cite("\\citet", ["Abadie2010"], harvard), "Abadie et al. (2010)");
  // A numeric style written into the document (Attention Is All You Need): numbered in order.
  const numeric = readCompiledBibliography(String.raw`\begin{thebibliography}{10}
\bibitem{layernorm2016}
Jimmy~Lei Ba, Jamie~Ryan Kiros, and Geoffrey~E Hinton.
\newblock Layer normalization.
\bibitem{bahdanau2014neural}
Dzmitry Bahdanau, Kyunghyun Cho, and Yoshua Bengio.
\newblock Neural machine translation by jointly learning to align and translate.
\end{thebibliography}`);
  assert.equal(numeric[1].title, "Neural machine translation by jointly learning to align and translate");
  assert.equal(cite("\\cite", ["bahdanau2014neural", "layernorm2016"], numeric), "[2, 1]");
});

test("\\bibliography and \\printbibliography draw the compiled reference list; layout blocks, keywords and cells read as text", () => {
  const entries = readCompiledBibliography(String.raw`\begin{thebibliography}{2}
\bibitem{layernorm2016}
Jimmy~Lei Ba, Jamie~Ryan Kiros, and Geoffrey~E Hinton.
\newblock Layer normalization.
\bibitem[Card and Krueger(1994)]{card1994}
Card, D. and A.~B. Krueger.
\end{thebibliography}`);
  const project = latexProjectField.init(() => ({ labels: [], bibEntries: entries, files: [] }));
  const doc = "\\documentclass{article}\n\\begin{document}\nText.\n\\bibliographystyle{plain}\n\\bibliography{refs,more}\n\\end{document}\n";
  const kinds = constructs(visualState(doc)).map((item) => item.split(":")[0]);
  assert.ok(kinds.includes("bibliography"));
  assert.ok(kinds.includes("bibliography-style"));
  const text = visibleText(doc, [project]);
  assert.match(text, /References/);
  assert.match(text, /\[1\]Layer normalization\./);
  assert.match(text, /Card and Krueger\. 1994\./);
  assert.doesNotMatch(text, /\\bibliography/);
  // Without a compiled bibliography: a note, not an empty list.
  assert.match(visibleText(doc), /Listed in the PDF \(from refs,more\)/);
  const biblatex = "\\documentclass{book}\n\\begin{document}\nText.\n\\printbibliography[title={Works Cited}]\n\\end{document}\n";
  assert.match(visibleText(biblatex), /Works Cited/);
  assert.match(visibleText(biblatex.replace("[title={Works Cited}]", "")), /Bibliography/);
  // Not alone on its line: source.
  assert.ok(!constructs(visualState("\\begin{document}\nSee \\bibliography{refs} here.\n\\end{document}\n")).some((item) => item.startsWith("bibliography")));
  // setspace's blocks and keywords: their text, without the environment markup.
  const blocks = visibleText("\\begin{document}\n\\begin{doublespace}\nSpaced text.\n\\end{doublespace}\n\\begin{IEEEkeywords}\nlearning, graphs\n\\end{IEEEkeywords}\n\\end{document}\n");
  assert.match(blocks, /Spaced text\./);
  assert.match(blocks, /learning, graphs/);
  assert.doesNotMatch(blocks, /\\begin\{(?:doublespace|IEEEkeywords)\}/);
  // A list in a minipage in a table cell, and `\emph {x}` with a space before its group.
  const cells = visibleText("\\begin{document}\n\\begin{tabular}{ll}\nA & \\begin{minipage}{3cm}\\begin{itemize}\\item First\\item Second\\end{itemize}\\end{minipage} \\\\\nB & an \\emph {emphasised} word \\\\\n\\end{tabular}\n\\end{document}\n");
  assert.match(cells, /First/);
  assert.match(cells, /Second/);
  assert.match(cells, /an emphasised word/);
  assert.doesNotMatch(cells, /\\begin\{(?:minipage|itemize)\}|\\item|\\emph/);
});

test("a theorem's note on the line after \\begin is its note; after a blank line it is text (Callaway & Sant'Anna)", () => {
  const preamble = "\\newtheorem{assumption}{Assumption}\n\\begin{document}\n";
  const next = visibleText(`${preamble}\\begin{assumption}\n[Irreversibility of Treatment]\\label{ass:irrev} Units stay treated.\n\\end{assumption}\n\\end{document}\n`);
  assert.match(next, /Assumption 1 \(Irreversibility of Treatment\)/);
  assert.doesNotMatch(next, /\[Irreversibility/);
  const blank = visibleText(`${preamble}\\begin{assumption}\n\n[Not a note] Text.\n\\end{assumption}\n\\end{document}\n`);
  assert.match(blank, /\[Not a note\]/);
});

test("an array drawn on its own keeps its column specification (Featherweight Go's \\begin{array}{l} in rules)", () => {
  const doc = "\\begin{document}\n\\begin{array}{cc}\na & b \\\\\nc & d\n\\end{array}\n\\end{document}\n";
  assert.equal(constructs(visualState(doc)).some((item) => item.startsWith("math:")), true);
});
