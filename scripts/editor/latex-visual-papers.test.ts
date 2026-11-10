import "./setup.cjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { latexParser as parser } from "../../src/lib/latex/codemirror/latex-parser";
import { macroAt, readLatexDefinitions } from "../../src/lib/latex/macros/definitions";
import { computeLatexNumbering, numberingEntryAt } from "../../src/lib/latex/macros/numbering";

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
