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
import { expandLatexMacros } from "../../src/lib/latex/macros/expand";
import { macroAt, readLatexDefinitions } from "../../src/lib/latex/macros/definitions";
import { readCompiledBibliography } from "../../src/lib/latex/project";
import { citationText } from "../../src/lib/latex/codemirror/visual/references";
import { EMPTY_AUX } from "../../src/lib/latex/aux-file";
import { computeLatexNumbering, numberingEntryAt } from "../../src/lib/latex/macros/numbering";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
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
function visibleText(doc: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc), parent });
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

test("an array drawn on its own keeps its column specification (Featherweight Go's \\begin{array}{l} in rules)", () => {
  const doc = "\\begin{document}\n\\begin{array}{cc}\na & b \\\\\nc & d\n\\end{array}\n\\end{document}\n";
  assert.equal(constructs(visualState(doc)).some((item) => item.startsWith("math:")), true);
});
