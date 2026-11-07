import "./setup.cjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parser } from "codemirror-lang-latex/src/latex.mjs";
import { parseLatexAux } from "../../src/lib/latex/aux-file";
import { bodyStartOf, collectLatexDefinitions, emptyLatexDefinitions, loadKey, macroAt, readLatexDefinitions, readLatexInputs } from "../../src/lib/latex/macros/definitions";
import { expandLatexMacros, expandLatexMacroUse, needsMathMode } from "../../src/lib/latex/macros/expand";
import { computeLatexNumbering, enumerateItemLabel, formatCounterValue, numberingEntryAt, referenceText, splitMathRows } from "../../src/lib/latex/macros/numbering";
import { katexForEnvironment } from "../../src/lib/latex/codemirror/visual/math-render";
import { chapterNumberingStart } from "../../src/lib/latex/macros/project-numbering";
import { readGroup, readOptional } from "../../src/lib/macros/core";
import { readBalancedGroup } from "../../src/lib/latex/project";

function defsOf(source: string) {
  return readLatexDefinitions(source);
}

function number(source: string, options: Parameters<typeof computeLatexNumbering>[3] = {}) {
  const tree = parser.parse(source);
  return computeLatexNumbering(tree, (from, to) => source.slice(from, to), defsOf(source), options);
}

/* ---- Shared primitives -------------------------------------------------------- */

test("the shared group readers handle nesting, escapes and optional arguments", () => {
  assert.deepEqual(readGroup("{a{b}\\}c}d", 0), { content: "a{b}\\}c", end: 9 });
  assert.equal(readGroup("{open", 0), null);
  assert.deepEqual(readOptional("[x={a]b}]rest", 0), { content: "x={a]b}", end: 9 });
  assert.equal(readBalancedGroup("\\section{A {B}}", 8), "A {B}");
});

/* ---- Definitions ------------------------------------------------------------- */

test("definition forms are read with their arguments and defaults", () => {
  const defs = defsOf(String.raw`\documentclass[11pt]{article}
\usepackage{amsmath, amssymb}
\newcommand{\R}{\mathbb{R}}
\newcommand\norm[1]{\lVert #1 \rVert}
\newcommand{\vect}[2][x]{(#1_1, \dots, #1_{#2})}
\renewcommand{\R}{\mathbb{R}^n}
\providecommand{\R}{ignored}
\providecommand{\N}{\mathbb{N}}
\newcommand*\samethanks[1][\value{footnote}]{\footnotemark[#1]}
\def\twice#1{#1, #1}
\let\eps\varepsilon
\DeclareMathOperator{\tr}{tr}
\DeclareMathOperator*{\argmax}{arg\,max}
\NewDocumentCommand{\set}{s m}{\IfBooleanTF{#1}{\{#2\}}{\left\{#2\right\}}}
\newenvironment{note}[1][Note]{\textbf{#1.}}{\par}
\newtheorem{theorem}{Theorem}[section]
\newtheorem{lemma}[theorem]{Lemma}
\theoremstyle{definition}
\newtheorem*{remark}{Remark}
\numberwithin{equation}{section}
\crefname{lemma}{lem.}{lems.}
% \newcommand{\commented}{no}
\begin{document}
\newcommand{\late}{body}
\end{document}`);
  assert.equal(defs.documentClass, "article");
  assert.deepEqual(defs.packages, ["amsmath", "amssymb"]);
  assert.equal(macroAt(defs, "R", 0)?.body, "\\mathbb{R}^n");
  assert.equal(macroAt(defs, "N", 0)?.body, "\\mathbb{N}");
  assert.equal(macroAt(defs, "norm", 0)?.arity, 1);
  assert.equal(macroAt(defs, "vect", 0)?.optional, "x");
  assert.equal(macroAt(defs, "samethanks", 0)?.optional, "\\value{footnote}");
  assert.equal(macroAt(defs, "twice", 0)?.arity, 1);
  assert.equal(macroAt(defs, "eps", 0)?.body, "\\varepsilon");
  assert.equal(macroAt(defs, "tr", 0)?.body, "\\operatorname{tr}");
  assert.equal(macroAt(defs, "argmax", 0)?.body, "\\operatorname*{arg\\,max}");
  assert.deepEqual(macroAt(defs, "set", 0)?.spec, [{ type: "s" }, { type: "m" }]);
  assert.equal(macroAt(defs, "commented", 0), null);
  assert.equal(defs.environments.get("note")?.optional, "Note");
  assert.deepEqual(defs.theorems.get("lemma"), { name: "lemma", title: "Lemma", counter: "theorem", within: undefined, numbered: true, style: "plain" });
  assert.equal(defs.theorems.get("theorem")?.within, "section");
  assert.equal(defs.theorems.get("remark")?.numbered, false);
  assert.equal(defs.theorems.get("remark")?.style, "definition");
  assert.equal(defs.counterWithin.get("equation"), "section");
  assert.equal(defs.crefNames.get("lemma")?.singular, "lem.");
  // A definition in the body applies from where it is written.
  const body = bodyStartOf(String.raw`\begin{document}`);
  assert.ok(body > 0);
  assert.equal(macroAt(defs, "late", 0), null);
  assert.equal(macroAt(defs, "late", Number.MAX_SAFE_INTEGER)?.body, "body");
});

test("wrong and unsupported definitions are listed, and comments between arguments are skipped", () => {
  const defs = defsOf(String.raw`\newcommand{\bad}[1]{#1 and #2}
\newcommand{\nobody}
\def\delimited#1.{#1}
\edef\expanded{x}
\NewDocumentCommand{\fancy}{r<>}{#1}
\renewenvironment{abstract}%
  {\begin{center}}%
  {\end{center}}`);
  assert.deepEqual(defs.problems.map((problem) => problem.message), ["\\bad uses #2 but takes 1 argument", "\\nobody has no {…} body"]);
  assert.deepEqual(defs.unsupported.map((note) => note.name), ["delimited", "expanded", "fancy"]);
  assert.equal(defs.environments.get("abstract")?.begin, "\\begin{center}");
});

test("definitions from other files apply everywhere, and inputs are listed", () => {
  const defs = emptyLatexDefinitions();
  readLatexDefinitions(String.raw`\newcommand{\shared}{S}`, defs, { file: "macros.tex" });
  readLatexDefinitions(String.raw`\begin{document}\shared\end{document}`, defs);
  assert.equal(macroAt(defs, "shared", 0)?.pos, -1);
  assert.deepEqual(readLatexInputs("\\input{a}\n% \\input{b}\n\\include{c}").map((input) => input.path), ["a", "c"]);
});

test("local definitions end with their group, and \\gdef does not", () => {
  const source = String.raw`\documentclass{article}
{\newcommand\pre{P}}
\begin{document}
{\def\a{A}\a}\a
\begingroup\newcommand\b{B}\b\endgroup\b
{\gdef\c{C}}\c
\begin{center}\renewcommand\pre{Q}\pre\end{center}\pre
\end{document}`;
  const defs = defsOf(source);
  const use = (needle: string) => source.indexOf(needle);
  assert.equal(macroAt(defs, "a", use("\\a}\\a"))?.body, "A", "inside its group");
  assert.equal(macroAt(defs, "a", use("\\a}\\a") + 3), null, "after its group");
  assert.equal(macroAt(defs, "b", use("\\b\\endgroup"))?.body, "B");
  assert.equal(macroAt(defs, "b", use("\\endgroup\\b") + 9), null);
  assert.equal(macroAt(defs, "c", use("}\\c") + 1)?.body, "C", "\\gdef is global");
  assert.equal(macroAt(defs, "pre", use("\\pre\\end{center}"))?.body, "Q");
  assert.equal(macroAt(defs, "pre", use("\\end{center}\\pre") + 12), null, "a preamble group's definition never reaches the body");
  assert.equal(macroAt(defs, "late", Number.MAX_SAFE_INTEGER), null);
});

test("definitions TeX does not run are not read, and ones under an unknown condition hide the earlier meaning", () => {
  const defs = defsOf(String.raw`\newcommand\z{Z1}
\begin{verbatim}
\newcommand\v{V}
\end{verbatim}
\verb|\newcommand\w{W}|
\iffalse\newcommand\x{X}\else\newcommand\y{Y}\fi
\ifdefined\foo\renewcommand\z{Z2}\fi
\newif\iffoo
\newcommand\after{A}
\newcommand\deferred{\newcommand\inner{I}}
\begin{document}\end{document}`);
  assert.equal(macroAt(defs, "v", 0), null, "verbatim");
  assert.equal(macroAt(defs, "w", 0), null, "\\verb");
  assert.equal(macroAt(defs, "x", 0), null, "the false branch");
  assert.equal(macroAt(defs, "y", 0)?.body, "Y", "the \\else branch runs");
  assert.equal(macroAt(defs, "after", 0)?.body, "A", "\\newif opens no conditional");
  assert.equal(macroAt(defs, "inner", 0), null, "a definition's body is not run");
  assert.equal(macroAt(defs, "z", 0)?.unsupported, true);
  assert.equal(expandLatexMacros("\\z", defs).ok, false, "its uses stay source");
});

test("an unsupported redefinition hides the earlier definition", () => {
  const defs = defsOf(String.raw`\newcommand{\a}{A}\edef\a{B}\newcommand{\d}{D}\def\d#1.{#1}`);
  assert.equal(expandLatexMacros("\\a", defs).ok, false);
  assert.equal(expandLatexMacros("\\d", defs).ok, false);
});

test("comments do not count in groups or between arguments", () => {
  const defs = defsOf("\\newcommand{\\c}{a % }\n b}\n\\newcommand{\\f}[1]{<#1>}");
  assert.equal(macroAt(defs, "c", 0)?.body, "a % }\n b");
  assert.equal(expandLatexMacros("\\f% comment\n{x}", defs).text, "<x>");
  assert.equal(expandLatexMacros("\\f% comment\n\n{x}", defs).ok, false, "a blank line ends the arguments");
});

test("substitution keeps control words apart from the letters after them", () => {
  const defs = defsOf(String.raw`\newcommand\f[1]{\alpha#1}\newcommand\g[1]{#1x}\newcommand\h{y}`);
  assert.equal(expandLatexMacros("\\f{x}", defs).text, "\\alpha x");
  assert.equal(expandLatexMacros("\\g{\\alpha}", defs).text, "\\alpha x");
  assert.equal(expandLatexMacros("\\alpha\\h", defs).text, "\\alpha y");
  assert.equal(expandLatexMacros("\\f{+}", defs).text, "\\alpha+");
});

test("text expansion expands math inside $…$ and \\ensuremath as math", () => {
  const defs = defsOf(String.raw`\DeclareMathOperator{\tr}{tr}
\newcommand\trace{the $\tr x$}
\newcommand\tracem{\ensuremath{\tr y}}
\newcommand\bad{\tr z}`);
  assert.equal(expandLatexMacroUse("\\trace", defs)?.text, "the $\\operatorname{tr} x$");
  assert.equal(expandLatexMacroUse("\\tracem", defs)?.text, "\\ensuremath{\\operatorname{tr} y}");
  assert.equal(expandLatexMacroUse("\\bad", defs), null, "outside math it still fails");
});

test("\\let aliases of commands the reader does not know stay source before arguments", () => {
  const defs = defsOf(String.raw`\let\b\textbf\let\dots\ldots`);
  assert.equal(macroAt(defs, "b", 0)?.alias, true);
  assert.equal(expandLatexMacroUse("\\b{x}", defs), null);
  assert.equal(expandLatexMacroUse("\\dots and", defs)?.text, "\\ldots");
  assert.equal(expandLatexMacros("\\b{x}", defs).text, "\\textbf{x}", "in a formula the tokens stay together");
});

test("other files are read where they are loaded, in TeX's order, through nested inputs", () => {
  const sources = [
    { path: "nb/macros.tex", text: String.raw`\renewcommand\x{B}\input{symbols}`, loadedBy: "", key: loadKey("input", "macros") },
    { path: "nb/symbols.tex", text: String.raw`\newcommand\sym{S}`, loadedBy: "nb/macros.tex", key: loadKey("input", "symbols.tex") },
    { path: "nb/mine.sty", text: String.raw`\newcommand\pkg{P}`, loadedBy: "", key: loadKey("package", "mine") },
  ];
  const before = collectLatexDefinitions(sources, { text: String.raw`\newcommand\x{A}\input{macros}\usepackage{mine}\begin{document}\end{document}` });
  assert.equal(macroAt(before, "x", 0)?.body, "B", "the input's redefinition comes after the main file's definition");
  assert.equal(macroAt(before, "sym", 0)?.body, "S");
  assert.equal(macroAt(before, "pkg", 0)?.body, "P");
  const after = collectLatexDefinitions(sources, { text: String.raw`\input{macros}\renewcommand\x{A}\begin{document}\end{document}` });
  assert.equal(macroAt(after, "x", 0)?.body, "A");
  const unloaded = collectLatexDefinitions(sources, { text: String.raw`\begin{document}\end{document}` });
  assert.equal(macroAt(unloaded, "sym", 0), null, "a file nothing loads any more does not apply");
});

/* ---- Expansion --------------------------------------------------------------- */

test("math macros expand with arguments, defaults and undelimited arguments", () => {
  const defs = defsOf(String.raw`\newcommand{\R}{\mathbb{R}}
\newcommand{\norm}[1]{\lVert #1 \rVert}
\newcommand{\vect}[2][x]{(#1_1, \dots, #1_{#2})}
\newcommand{\eps}{\varepsilon}
\newcommand{\mbf}[1]{\mathbf{#1}}
\NewDocumentCommand{\set}{s m}{\IfBooleanTF{#1}{\{#2\}}{\left\{#2\right\}}}
\NewDocumentCommand{\opt}{o m}{\IfNoValueTF{#1}{#2}{#1:#2}}`);
  assert.equal(expandLatexMacros("x \\in \\R^n", defs).text, "x \\in \\mathbb{R}^n");
  assert.equal(expandLatexMacros("\\norm{v}", defs).text, "\\lVert v \\rVert");
  assert.equal(expandLatexMacros("\\vect{n}", defs).text, "(x_1, \\dots, x_{n})");
  assert.equal(expandLatexMacros("\\vect[y]{3}", defs).text, "(y_1, \\dots, y_{3})");
  assert.equal(expandLatexMacros("\\mbf x", defs).text, "\\mathbf{x}");
  assert.equal(expandLatexMacros("\\eps x", defs).text, "\\varepsilon x");
  assert.equal(expandLatexMacros("\\set*{a}", defs).text, "\\{a\\}");
  assert.equal(expandLatexMacros("\\set{a}", defs).text, "\\left\\{a\\right\\}");
  assert.equal(expandLatexMacros("\\opt{b}", defs).text, "b");
  assert.equal(expandLatexMacros("\\opt[a]{b}", defs).text, "a:b");
  // Unknown commands are left alone.
  assert.equal(expandLatexMacros("\\alpha + \\R", defs).text, "\\alpha + \\mathbb{R}");
});

test("expansion stops at recursion, depth and size limits", () => {
  const recursive = defsOf(String.raw`\newcommand{\loop}{\loop x}`);
  assert.equal(expandLatexMacros("\\loop", recursive).ok, false);
  const explosive = defsOf(String.raw`\newcommand{\a}{\b\b\b\b}\newcommand{\b}{\c\c\c\c}\newcommand{\c}{\d\d\d\d}\newcommand{\d}{\e\e\e\e}\newcommand{\e}{\f\f\f\f}\newcommand{\f}{\g\g\g\g}\newcommand{\g}{xxxxxxxxxxxxxxxxxxxx}`);
  assert.equal(expandLatexMacros("\\a", explosive).ok, false);
  const missing = defsOf(String.raw`\newcommand{\two}[2]{#1#2}`);
  assert.equal(expandLatexMacros("\\two{a}", missing).ok, false);
});

test("text uses expand once and know when they need math", () => {
  const defs = defsOf(String.raw`\newcommand\todo[1]{\textcolor{red}{[[#1]]}}
\newcommand{\eg}{e.g.}
\newcommand{\R}{\mathbb{R}}
\DeclareMathOperator{\tr}{tr}`);
  assert.deepEqual(expandLatexMacroUse("\\todo{check} rest", defs), { text: "\\textcolor{red}{[[check]]}", length: 12, used: [macroAt(defs, "todo", 0)!.fingerprint] });
  assert.equal(expandLatexMacroUse("\\eg, more", defs)?.text, "e.g.");
  assert.equal(expandLatexMacroUse("\\tr", defs), null);
  assert.ok(needsMathMode("\\mathbb{R}"));
  assert.ok(needsMathMode("x^2"));
  assert.ok(!needsMathMode("$x^2$ and \\ensuremath{\\alpha}"));
  assert.ok(!needsMathMode("e.g."));
});

/* ---- Numbering --------------------------------------------------------------- */

const ARTICLE = String.raw`\documentclass{article}
\newtheorem{theorem}{Theorem}[section]
\newtheorem{lemma}[theorem]{Lemma}
\newtheorem{definition}{Definition}
\begin{document}
\section{Intro}\label{sec:intro}
\subsection{Scope}\label{sec:scope}
\section*{Unnumbered}
\section{Method}\label{sec:method}
\begin{theorem}[Name]\label{thm:a}x\end{theorem}
\begin{lemma}\label{lem:b}y\end{lemma}
\begin{definition}\label{def:c}z\end{definition}
\begin{equation}a\label{eq:a}\end{equation}
\begin{equation*}b\end{equation*}
\begin{align}
c &= d \label{eq:c} \\
e &= f \nonumber \\
g &= h \tag{*} \label{eq:tag} \\
i &= j \label{eq:i}
\end{align}
\begin{figure}\label{fig:early}\caption{Cap}\label{fig:a}\end{figure}
\begin{table}\caption{T}\label{tab:a}\end{table}
Text\footnote{one} and\footnote{two}.
\begin{enumerate}\item a\label{item:a}\item b\label{item:b}\end{enumerate}
\appendix
\section{Extra}\label{sec:extra}
\end{document}`;

test("numbers follow the document: sections, theorems, equations, figures, footnotes, items and the appendix", () => {
  const numbering = number(ARTICLE);
  const labels = Object.fromEntries([...numbering.labels].map(([key, target]) => [key, target.number]));
  assert.deepEqual(labels, {
    "sec:intro": "1", "sec:scope": "1.1", "sec:method": "2", "thm:a": "2.1", "lem:b": "2.2", "def:c": "1",
    "eq:a": "1", "eq:c": "2", "eq:tag": "*", "eq:i": "3", "fig:early": "2", "fig:a": "1", "tab:a": "1",
    "item:a": "1", "item:b": "2", "sec:extra": "A",
  });
  const align = numbering.entries.find((entry) => entry.kind === "equation" && entry.rows && entry.rows.length === 4);
  assert.deepEqual(align?.rows, ["2", null, "*", "3"]);
  assert.deepEqual(numbering.entries.filter((entry) => entry.kind === "footnote").map((entry) => entry.number), ["1", "2"]);
  assert.deepEqual(numbering.entries.filter((entry) => entry.kind === "section").map((entry) => entry.number), ["1", "1.1", null, "2", "A"]);
});

test("chapter classes number within chapters, and \\numberwithin is followed", () => {
  const book = number(String.raw`\documentclass{book}
\begin{document}
\chapter{One}\section{A}\subsection{a}\subsubsection{unnumbered in books}
\begin{equation}x\label{eq:x}\end{equation}
\begin{figure}\caption{F}\label{fig:f}\end{figure}
\chapter{Two}\begin{equation}y\label{eq:y}\end{equation}
\end{document}`);
  assert.equal(book.labels.get("eq:x")?.number, "1.1");
  assert.equal(book.labels.get("fig:f")?.number, "1.1");
  assert.equal(book.labels.get("eq:y")?.number, "2.1");
  assert.deepEqual(book.entries.filter((entry) => entry.kind === "section").map((entry) => entry.number), ["1", "1.1", "1.1.1", null, "2"]);
  const within = number(String.raw`\documentclass{article}\numberwithin{equation}{section}
\begin{document}\section{A}\begin{equation}x\label{eq:1}\end{equation}\section{B}\begin{equation}y\label{eq:2}\end{equation}\end{document}`);
  assert.equal(within.labels.get("eq:1")?.number, "1.1");
  assert.equal(within.labels.get("eq:2")?.number, "2.1");
});

test("a label in a caption is the figure's, entries stay in position order, and titles count in the fingerprint", () => {
  const source = String.raw`\documentclass{article}
\begin{document}
\section{AAA}\label{sec:a}
\begin{figure}Text\footnote{n}\caption{Cap\label{fig:x}}\end{figure}
\end{document}`;
  const numbering = number(source);
  assert.deepEqual(numbering.labels.get("fig:x"), { number: "1", kind: "figure", pos: source.indexOf("\\begin{figure}") });
  assert.deepEqual(numbering.entries.map((entry) => entry.pos), [...numbering.entries.map((entry) => entry.pos)].sort((a, b) => a - b));
  assert.equal(numberingEntryAt(numbering, source.indexOf("\\begin{figure}"), "figure")?.number, "1");
  assert.notEqual(number(source.replace("AAA", "BBB")).fingerprint, numbering.fingerprint, "\\nameref shows the title");
});

test("footnotes: printed alone in books, explicit numbers, labels inside them, and endnotes", () => {
  const numbering = number(String.raw`\documentclass{book}
\begin{document}
\chapter{A}
Text\footnote{a\label{fn:a}} and\footnote[7]{b}.
\section{S}\label{sec:s}
\chapter{B}
More\footnote{c}\endnote{e}.
\end{document}`);
  assert.deepEqual(numbering.entries.filter((entry) => entry.kind === "footnote").map((entry) => entry.number), ["1", "7", "1", "1"]);
  assert.deepEqual(numbering.labels.get("fn:a")?.kind, "footnote");
  assert.equal(numbering.labels.get("fn:a")?.number, "1");
  assert.equal(numbering.labels.get("sec:s")?.number, "1.1", "the label after the footnote is the section's");
});

test("align rows: a final \\\\ adds no row, and commented numbering commands do nothing", () => {
  const numbering = number(String.raw`\begin{align}a&=b\\\end{align}
\begin{equation}c % \nonumber \tag{X}
\label{eq:c}\end{equation}
\begin{eqnarray}d\\\end{eqnarray}
\begin{equation}e\label{eq:e}\end{equation}`);
  assert.equal(numbering.labels.get("eq:c")?.number, "2");
  assert.equal(numbering.labels.get("eq:e")?.number, "5", "eqnarray's final \\\\ is a numbered row");
});

test("explicit tags are KaTeX's to draw, in starred environments too", () => {
  assert.match(katexForEnvironment("equation*", "x \\tag{A}").latex, /\\tag\{A\}/);
  assert.match(katexForEnvironment("align", "a \\\\ b \\tag*{B}").latex, /\\tag\*\{B\}/);
  const numbering = number(String.raw`\begin{align}a\\b\tag{B}\\c\end{align}`);
  const entry = numbering.entries[0];
  assert.deepEqual(entry.rows, ["1", "B", "2"]);
  assert.deepEqual(entry.tagged, [false, true, false]);
});

test("secnumdepth, custom \\theequation and subequations change the numbers", () => {
  const depth = number(String.raw`\documentclass{article}
\setcounter{secnumdepth}{1}
\begin{document}
\section{A}\subsection{B}\label{sec:b}
\end{document}`);
  assert.deepEqual(depth.entries.map((entry) => entry.number), ["1", null]);
  const custom = number(String.raw`\documentclass{article}
\renewcommand{\theequation}{\arabic{section}-\arabic{equation}}
\begin{document}
\section{A}\begin{equation}x\label{eq:x}\end{equation}
\begin{subequations}\label{eq:group}
\begin{align}a\label{eq:a}\\b\label{eq:b}\end{align}
\end{subequations}
\end{document}`);
  assert.equal(custom.labels.get("eq:x")?.number, "1-1");
  assert.equal(custom.labels.get("eq:group")?.number, "1-2");
  assert.equal(custom.labels.get("eq:a")?.number, "1-2a");
  assert.equal(custom.labels.get("eq:b")?.number, "1-2b");
  const unknown = number(String.raw`\renewcommand{\theequation}{\fancy{equation}}\begin{equation}x\label{eq:u}\end{equation}`);
  assert.equal(unknown.labels.get("eq:u")?.number, "?");
});

test("item numbers follow counter commands, custom labels and nesting", () => {
  const numbering = number(String.raw`\begin{enumerate}
\item a\label{i:a}
\setcounter{enumi}{3}
\item b\label{i:b}
\begin{enumerate}\item c\label{i:c}\end{enumerate}
\end{enumerate}
\begin{enumerate}[label=(\alph*)]\item d\label{i:d}\end{enumerate}`);
  assert.deepEqual(["i:a", "i:b", "i:c", "i:d"].map((key) => numbering.labels.get(key)?.number), ["1", "4", "4a", "(a)"]);
  assert.equal(enumerateItemLabel(2, 1, "leftmargin=*"), "2.", "a template without a label keeps the default");
});

test("align rows split at \\\\ outside braces and nested environments", () => {
  assert.deepEqual(splitMathRows("a \\\\ \\begin{matrix} 1 \\\\ 2 \\end{matrix} \\\\[2pt] {x \\\\ y} \\\\* z"), ["a ", " \\begin{matrix} 1 \\\\ 2 \\end{matrix} ", " {x \\\\ y} ", " z"]);
});

test("references say what the PDF says", () => {
  const numbering = number(ARTICLE);
  const defs = defsOf(ARTICLE);
  const target = (key: string) => numbering.labels.get(key) ?? null;
  assert.equal(referenceText("\\ref", [target("sec:scope")], defs, ["sec:scope"]), "1.1");
  assert.equal(referenceText("\\eqref", [target("eq:c")], defs, ["eq:c"]), "(2)");
  assert.equal(referenceText("\\cref", [target("eq:c")], defs, ["eq:c"]), "eq. (2)");
  assert.equal(referenceText("\\Cref", [target("fig:a")], defs, ["fig:a"]), "Figure 1");
  assert.equal(referenceText("\\cref", [target("lem:b")], defs, ["lem:b"]), "Lemma 2.2");
  assert.equal(referenceText("\\autoref", [target("sec:method")], defs, ["sec:method"]), "Section 2");
  assert.equal(referenceText("\\cref", [target("eq:a"), target("eq:c")], defs, ["eq:a", "eq:c"]), "eqs. (1) and (2)");
});

test("a chapter's counters continue from where the main file includes it", async () => {
  const files: Record<string, string> = {
    "nb/main.tex": String.raw`\documentclass{article}
\begin{document}
\section{Intro}
\input{background}
\input{chapters/model}
\end{document}`,
    "nb/background.tex": String.raw`\section{Background}\begin{equation}x\end{equation}`,
    "nb/chapters/model.tex": String.raw`\subsection{Attention}\begin{equation}y\end{equation}`,
  };
  const start = await chapterNumberingStart("nb/chapters/model.tex", "nb/main.tex", async (path) => files[path] ?? "");
  assert.deepEqual(start, { counters: { section: 2, subsection: 0, subsubsection: 0, paragraph: 0, subparagraph: 0, equation: 1 }, appendix: false });
  const numbering = number(files["nb/chapters/model.tex"], { start });
  assert.deepEqual(numbering.entries.map((entry) => `${entry.kind}:${entry.number}`), ["section:2.1", "equation:2"]);
  assert.equal(await chapterNumberingStart("nb/other.tex", "nb/main.tex", async (path) => files[path] ?? ""), null);
});

test("a main file's numbers count the chapters it includes", () => {
  const chapter = String.raw`\section{Background}\begin{equation}x\label{eq:in}\end{equation}`;
  const main = String.raw`\documentclass{article}
\begin{document}
\section{Intro}
\input{chapters/background}
\section{Method}\label{sec:method}
\end{document}`;
  const tree = parser.parse(chapter);
  const numbering = computeLatexNumbering(parser.parse(main), (from, to) => main.slice(from, to), defsOf(main), {
    includes: (name) => (name === "chapters/background" ? { tree, read: (from, to) => chapter.slice(from, to) } : null),
  });
  assert.equal(numbering.labels.get("sec:method")?.number, "3");
  assert.equal(numbering.labels.get("eq:in"), undefined, "labels in the included file are its own (the .aux has them)");
  assert.deepEqual(numbering.entries.map((entry) => entry.number), ["1", "3"]);
});

test("a chapter's inputs resolve from the main file's directory, with the theorems its macro files define", async () => {
  const files: Record<string, string> = {
    "nb/main.tex": String.raw`\documentclass{article}
\input{macros}
\begin{document}
\input{chapters/one}
\input{chapters/two}
\end{document}`,
    "nb/macros.tex": String.raw`\newtheorem{theorem}{Theorem}`,
    "nb/chapters/one.tex": String.raw`\section{One}\input{chapters/one-more}`,
    "nb/chapters/one-more.tex": String.raw`\begin{theorem}a\end{theorem}\begin{theorem}b\end{theorem}`,
    "nb/chapters/two.tex": String.raw`\begin{theorem}c\end{theorem}`,
  };
  const base = collectLatexDefinitions([
    { path: "nb/main.tex", text: files["nb/main.tex"].slice(0, files["nb/main.tex"].indexOf("\\begin{document}")) },
    { path: "nb/macros.tex", text: files["nb/macros.tex"], loadedBy: "nb/main.tex", key: loadKey("input", "macros") },
  ]);
  const start = await chapterNumberingStart("nb/chapters/two.tex", "nb/main.tex", async (path) => files[path] ?? "", base);
  assert.equal(start?.counters.theorem, 2);
});

test("macro sources are found through nested inputs, each marked with what loads it", async () => {
  const { collectBodyIncludes, collectMacroSources } = await import("../../src/components/libera/latex/latex-dependencies");
  const files: Record<string, string> = {
    "nb/macros.tex": String.raw`\newcommand\m{M}\input{defs/symbols}`,
    "nb/defs/symbols.tex": String.raw`\newcommand\s{S}`,
    "nb/mine.sty": String.raw`\newcommand\p{P}`,
    "nb/ch1.tex": String.raw`\input{ch1-part}`,
    "nb/ch1-part.tex": String.raw`\section{Part}`,
  };
  const known = new Set(Object.keys(files));
  const readText = async (path: string) => files[path] ?? "";
  const { sources, paths } = await collectMacroSources({
    filePath: "nb/main.tex", rootPath: "nb/main.tex", ownPreamble: String.raw`\documentclass{article}\input{macros}\usepackage{mine}`, known, readText, version: () => "1",
  });
  assert.deepEqual(sources.map((source) => [source.path, source.loadedBy, source.key]), [
    ["nb/macros.tex", "", "input:macros"], ["nb/mine.sty", "", "package:mine"], ["nb/defs/symbols.tex", "nb/macros.tex", "input:defs/symbols"],
  ]);
  assert.deepEqual(paths, ["nb/macros.tex", "nb/mine.sty", "nb/defs/symbols.tex"]);
  const defs = collectLatexDefinitions(sources, { text: String.raw`\documentclass{article}\input{macros}\usepackage{mine}\begin{document}\end{document}` });
  assert.equal(macroAt(defs, "s", 0)?.body, "S");
  const { includes } = await collectBodyIncludes({ filePath: "nb/main.tex", rootPath: "nb/main.tex", text: String.raw`\begin{document}\include{ch1}\end{document}`, known, readText });
  assert.deepEqual([...includes.keys()], ["input:ch1", "input:ch1-part"]);
});

/* ---- The compiled .aux -------------------------------------------------------- */

test("labels and citation labels are read from the .aux, in plain and hyperref forms", () => {
  const aux = parseLatexAux(String.raw`\relax
\providecommand\hyper@newdestlabel[2]{}
\newlabel{sec:intro}{{1}{1}{Introduction}{section.1}{}}
\newlabel{sec:intro@cref}{{[section][1][]1}{[1][1][]1}}
\newlabel{eq:energy}{{3}{4}}
\newlabel{tab:a}{{\relax 2}{5}{Results\relax }{table.caption.3}{}}
\bibcite{vaswani2017}{12}
\bibcite{knuth1984}{{3}{1984}{{Knuth}}{{Knuth}}}`);
  assert.deepEqual(aux.labels["sec:intro"], { number: "1", page: "1", title: "Introduction" });
  assert.deepEqual(aux.labels["eq:energy"], { number: "3", page: "4", title: undefined });
  assert.equal(aux.labels["tab:a"].number, "2");
  assert.equal(aux.labels["sec:intro@cref"], undefined);
  assert.deepEqual(aux.citations.vaswani2017, { label: "12" });
  assert.deepEqual(aux.citations.knuth1984, { label: "3", year: "1984", authors: "Knuth" });
});

/* ---- Review fixes ------------------------------------------------------------ */

test("expansion work is bounded, not only its result", () => {
  const defs = defsOf(String.raw`\newcommand{\a}{\b\b\b\b\b\b}\newcommand{\b}{\c\c\c\c\c\c}\newcommand{\c}{\d\d\d\d\d\d}\newcommand{\d}{\e\e\e\e\e\e}\newcommand{\e}{\f\f\f\f\f\f}\newcommand{\f}{\g\g\g\g\g\g}\newcommand{\g}{}`);
  const started = Date.now();
  assert.equal(expandLatexMacros(String.raw`\a`, defs).ok, false);
  assert.ok(Date.now() - started < 500, "stops early");
});

test("counters numbered within themselves and huge values do not hang or crash", () => {
  const numbering = number(String.raw`\documentclass{article}\numberwithin{equation}{equation}\newcounter{a}[b]\newcounter{b}[a]
\begin{document}\begin{equation}x\label{eq:x}\end{equation}\stepcounter{a}\end{document}`);
  assert.equal(numbering.labels.get("eq:x")?.number, "1");
  const started = Date.now();
  assert.equal(formatCounterValue(1_000_000_000, "Roman"), "1000000000");
  assert.equal(formatCounterValue(0, "alph"), "0");
  assert.ok(Date.now() - started < 50);
});
