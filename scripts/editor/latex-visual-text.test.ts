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
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

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

/** A mounted Visual mode for `doc`, numbered as the app numbers it; `inspect` reads its DOM before it is destroyed. */
function mounted<T>(doc: string, inspect: (content: HTMLElement) => T, extra: Extension[] = []) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, extra), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  const result = inspect(view.contentDOM);
  view.destroy();
  parent.remove();
  return result;
}

/** The text a mounted Visual mode shows for `doc` (widgets' text included), numbered as the app numbers it. */
function visibleText(doc: string, extra: Extension[] = []) {
  return mounted(doc, (content) => content.textContent ?? "", extra);
}

/** The text after the folded preamble. */
function bodyText(doc: string) {
  const text = visibleText(doc);
  const preamble = text.indexOf("Preamble");
  return preamble < 0 ? text : text.slice(text.indexOf("\n", preamble) + 1 || preamble + 8);
}

/* Group D2 of the paper batches (front matter, body text, lists and package commands). Each test is the smallest
 * source that showed the problem in a paper's Visual mode. */

test("B4-04: a layout command in a title or note takes only its own argument (\\title{\\vspace{-2.5cm}{…}}, \\protect{\\hyperref…})", () => {
  const title = visibleText(String.raw`\documentclass{article}
\usepackage[dvipsnames]{xcolor}
\title{\vspace{-2.5cm}{\color{MidnightBlue} \textbf{How much inflation can fiscal policy create?}}}
\author{Matthias H\"ansel}
\begin{document}
\maketitle
\end{document}
`);
  assert.match(title, /How much inflation can fiscal policy create\?/);
  assert.doesNotMatch(title.slice(title.indexOf("Preamble") + 10), /\\color|\\vspace|-2\.5cm/);
  const proof = visibleText(String.raw`\begin{document}
\begin{proof}[Proof of the \protect{\hyperref[theorem:env]{envelope theorem and converse}}]
Text.
\end{proof}
\end{document}
`);
  assert.match(proof, /Proof of the envelope theorem and converse/);
  // Spacing a fragment draws nothing, starred or not; what follows it is still drawn.
  const spaced = visibleText(String.raw`\documentclass{article}
\title{\vspace*{-1cm}A Title\vspace{0.5cm}}
\author{A \and B}
\begin{document}
\maketitle
\end{document}
`);
  assert.doesNotMatch(spaced.slice(spaced.indexOf("Preamble") + 10), /\*|-1cm|0\.5cm/);
  assert.match(spaced, /A Title/);
});

test("B4-22: the minimum-wage paper's title folds with \\vspace between its parts, and {\\color{x} …} in a fragment is coloured", () => {
  const doc = String.raw`\documentclass{scrartcl}
\begin{document}

%%%
% Title page:
\title{\LARGE The Devil is in the Details: \\Heterogeneous Effects of the German Minimum Wage\vspace{0.5cm}}

\author{Mario Bossler%
\thanks{TH Nuremberg.}
\\
\small{\emph {TH Nuremberg, IAB, IZA, LASER}}
\and
Ying Liang%
\thanks{JGU Mainz.}\vspace{-0.3cm}
\\
\small{\emph {JGU Mainz}} \vspace{0.4cm}
}

\vspace{-0.3cm}
\date{April 2024}

\maketitle
\section{Introduction}
\end{document}
`;
  const text = visibleText(doc);
  assert.doesNotMatch(text, /\\title|\\author|\\date|\\vspace|0\.4cm/);
  assert.match(text, /The Devil is in the Details/);
  assert.match(text, /TH Nuremberg, IAB, IZA, LASER/);
  const style = mounted(String.raw`\documentclass{article}
\title{{\color{blue} Blue} title}
\begin{document}
\maketitle
\end{document}
`, (content) => content.querySelector(".cm-vis-title .cm-vis-color")?.getAttribute("style") ?? null);
  assert.match(style ?? "", /color/);
});

test("B5-09/B5-30: acmart's abstract, CCS metadata, keywords and definitions before \\maketitle fold into the title block; the teaser figure stays drawn (Generative Agents)", () => {
  const doc = String.raw`\documentclass[sigconf]{acmart}
\begin{document}

\title[Generative Agents]{Generative Agents: Interactive Simulacra of Human Behavior}

\author{Joon Sung Park}
\affiliation{%
  \institution{Stanford University}
  \country{USA}}
\email{joonspk@stanford.edu}

\author{Michael S. Bernstein}
\affiliation{%
  \institution{Stanford University}
  \country{USA}}
\email{msb@cs.stanford.edu}

\renewcommand{\shortauthors}{J.S. Park, M.S. Bernstein}

\newcommand{\gentxt}[1]{{\color{darkgray}\small\fontfamily{}\selectfont
#1}}

\begin{abstract}
  Believable proxies of human behavior can empower interactive applications.
\end{abstract}

\begin{CCSXML}
<ccs2012>
<concept>
<concept_desc>Human-centered computing~Interactive systems and tools</concept_desc>
</concept>
</ccs2012>
\end{CCSXML}

\ccsdesc[500]{Human-centered computing~Interactive systems and tools}

\keywords{Human-AI interaction, agents}

\begin{teaserfigure}
  \includegraphics[width=\textwidth]{figures/cover.png}
  \caption{Generative agents are believable simulacra.}
  \label{fig:teaser}
\end{teaserfigure}

\maketitle

\section{Introduction}
Text.
\end{document}
`;
  const state = visualState(doc);
  const kinds = constructs(state).map((construct) => construct.split(":")[0]);
  assert.ok(kinds.includes("title"));
  assert.ok(kinds.includes("figure"), kinds.join(" "));
  const text = bodyText(doc);
  assert.doesNotMatch(text, /\\title|\\author|ccs2012|\\ccsdesc|\\keywords|\\renewcommand|\\begin\{abstract\}|\\maketitle/);
  for (const part of ["Generative Agents: Interactive Simulacra", "Joon Sung Park", "Michael S. Bernstein", "Believable proxies", "Interactive systems and tools", "Human-AI interaction, agents"]) assert.match(text, new RegExp(part));
  // The title block comes before the teaser figure, whose caption is drawn.
  assert.ok(text.indexOf("Believable proxies") < text.indexOf("Generative agents are believable simulacra"));
});

test("B5-09: IEEEtran's author blocks are drawn as names with their affiliations (Membership Inference)", () => {
  const text = bodyText(String.raw`\documentclass[conference]{IEEEtran}
\begin{document}
\title{Membership Inference Attacks Against\\
       Machine Learning Models}
	\author{
		\IEEEauthorblockN{Reza Shokri}
		\IEEEauthorblockA{Cornell Tech\\{\tt shokri@cornell.edu}}
		\and
		\IEEEauthorblockN{Marco Stronati$^{*}$\thanks{$^{*}$This research was performed at Cornell Tech.}}
		\IEEEauthorblockA{INRIA \\{\tt marco@stronati.org}}
	}

\maketitle
\end{document}
`);
  assert.doesNotMatch(text, /IEEEauthorblock/);
  for (const part of ["Reza Shokri", "Cornell Tech", "shokri@cornell.edu", "Marco Stronati", "INRIA"]) assert.match(text, new RegExp(part));
});

test("B7-13: LIPIcs' five-argument \\author commands each add an author with their affiliation (Stein & Samuelson)", () => {
  const text = bodyText(String.raw`\documentclass[a4paper,UKenglish]{lipics-v2021}
\title{A Category for unifying Gaussian Probability and Nondeterminism}
\author{Dario {Stein}}{iHub, Radboud University Nijmegen, The Netherlands}{dario.stein@ru.nl}{}{}
\author{Richard {Samuelson}}{Humming Inc., United States of America}{richard@heyhumming.com}{}{}
%TODO mandatory, please use full name
\authorrunning{D. Stein}
\ccsdesc[500]{Theory of computation~Probabilistic computation}
\keywords{systems theory, hypergraph categories}
\begin{document}
\maketitle
\end{document}
`);
  for (const part of ["Dario Stein", "iHub, Radboud University Nijmegen", "dario.stein@ru.nl", "Richard Samuelson", "Humming Inc.", "Theory of computation → Probabilistic computation", "systems theory, hypergraph categories"]) assert.match(text, new RegExp(part));
});

test("B7-26: amsart's abstract written before \\maketitle is drawn under the title, in the title block", () => {
  const text = bodyText(String.raw`\documentclass[letterpaper, 11pt]{amsart}
\title{Debordering determinantal ideals}
\author{A. Author}
\subjclass[2020]{68Q15}
\begin{document}

\begin{abstract}
One important question in algebraic complexity is understanding polynomial ideals.
\end{abstract}

\maketitle
\section{Introduction}
\end{document}
`);
  assert.doesNotMatch(text, /\\begin\{abstract\}|\\maketitle/);
  assert.ok(text.indexOf("Debordering determinantal ideals") < text.indexOf("One important question"), text);
  assert.match(text, /Mathematics Subject Classification: 68Q15/);
  // In an article, an abstract before \maketitle is printed where it is: not folded into the title.
  const article = bodyText(String.raw`\documentclass{article}
\title{T}
\begin{document}
\begin{abstract}
Before the title.
\end{abstract}
\maketitle
\end{document}
`);
  assert.ok(article.indexOf("Before the title") < article.lastIndexOf("T"), article);
});

test("B7-15: an \\item label with a formula or a style is drawn as LaTeX (\\item[$(i)$], \\item[\\textbf{Step 1}])", () => {
  const html = mounted(String.raw`\newcommand{\qKG}{\mathsf{KG}}
\begin{document}
\begin{description}
\item[$\qKG(1^\lambda)$:] generates keys.
\item[\textbf{Step 1}] first.
\item[Plain] text.
\end{description}
\end{document}
`, (content) => [...content.querySelectorAll(".cm-vis-item")].map((item) => ({ html: item.innerHTML, text: item.textContent })));
  assert.equal(html.length, 3);
  assert.match(html[0].html, /katex/);
  assert.doesNotMatch(html[0].text ?? "", /\\qKG|\$/);
  assert.match(html[1].html, /<strong>Step 1<\/strong>/);
  assert.equal(html[2].text, "Plain");
});

test("B7-16: an old font switch at the start of a heading's argument styles the heading (\\section{\\bf Introduction})", () => {
  const text = bodyText(String.raw`\begin{document}
\section{\bf Introduction}
\subsection{\sc Model}
Text.
\end{document}
`);
  assert.doesNotMatch(text, /\\bf|\\sc/);
  assert.match(text, /Introduction/);
});

test("B6-20: paralist's lists are drawn as lists (inparaenum's items run in their paragraph), and CJK's encoding arguments fold away", () => {
  const doc = String.raw`\begin{document}
Our images exhibit three advantages.
\begin{inparaenum}[(i)]
\item simple and cheap to acquire;
\item diverse;
\end{inparaenum}
\begin{compactitem}
\item one
\end{compactitem}
\begin{CJK}{UTF8}{gbsn}
阅读以下文字
\end{CJK}
\end{document}
`;
  const items = mounted(doc, (content) => [...content.querySelectorAll(".cm-vis-item")].map((item) => `${item.className}|${item.textContent}`));
  assert.deepEqual(items.map((item) => item.split("|")[1]), ["(i)", "(ii)", "•"]);
  assert.match(items[0], /cm-vis-item-inline/);
  const text = bodyText(doc);
  assert.doesNotMatch(text, /inparaenum|compactitem|CJK|UTF8|gbsn/);
  assert.match(text, /阅读以下文字/);
});

test("M-13/B7-25/B4-21/B5-32/B6-23/B3-25: lines holding only layout fold away; layout inside a line is hidden", () => {
  const doc = String.raw`\documentclass{book}
\definecolor{myred}{RGB}{200,0,0}
\begin{document}
\frontmatter
\tableofcontents
\mainmatter
\onehalfspacing
\chapter{Intro}
First paragraph.
\par
\medskip\noindent
\vspace*{-0.3cm} % tighter
\setlength{\parindent}{0pt}
\definecolor{accent}{RGB}{10,20,30}
\tikzset{
  every node/.style={draw}
}
\justifying
\noindent Second paragraph\vspace{2pt} goes on\newline here.
\afterpage{\clearpage
Rotated.
}
\begin{subequations}
\begin{equation}a=b\end{equation}
\end{subequations}
\backmatter
\end{document}
`;
  const state = visualState(doc);
  const layout = constructs(state).filter((construct) => construct.startsWith("layout:")).length;
  assert.ok(layout >= 10, constructs(state).join(" "));
  const text = bodyText(doc);
  assert.doesNotMatch(text, /\\(?:frontmatter|tableofcontents|mainmatter|onehalfspacing|par|medskip|noindent|vspace|setlength|definecolor|tikzset|justifying|afterpage|clearpage|backmatter)\b|subequations|every node|2pt/);
  assert.match(text, /Second paragraph goes on/);
  assert.match(text, /Rotated\./);
});

test("a line with text after its layout commands is not folded: only the commands are hidden", () => {
  const doc = String.raw`\begin{document}
\noindent{\bf Note:} the rest.
\medskip Next \par after.
\end{document}
`;
  const state = visualState(doc);
  assert.ok(!constructs(state).some((construct) => construct.startsWith("layout:")), constructs(state).join(" "));
  const text = bodyText(doc);
  assert.match(text, /Note: the rest\./);
  assert.match(text, /Next ↵ after\./);
  assert.doesNotMatch(text, /\\noindent|\\medskip|\\par/);
});

test("B6-22: braces around a whole footnote print nothing", () => {
  const text = bodyText(String.raw`\begin{document}
Text\footnote{{An aside.}} and more.
\end{document}
`);
  assert.match(text, /An aside\./);
  assert.doesNotMatch(text, /\{An aside\.\}/);
});

test("B5-29: todonotes' \\todo and \\missingfigure are note chips", () => {
  const chips = mounted(String.raw`\begin{document}
Text\todo{check this claim} more text.
\todo[inline]{Rewrite $x$.}
\missingfigure{The pipeline}
\end{document}
`, (content) => [...content.querySelectorAll(".cm-vis-todo")].map((chip) => chip.textContent ?? ""));
  assert.equal(chips.length, 3);
  assert.equal(chips[0], "To do: check this claim");
  assert.match(chips[1], /^To do: Rewrite .*x.*\.$/);
  assert.equal(chips[2], "Missing figure: The pipeline");
});

test("B5-15: glossaries' and acronym's commands print their entries' forms", () => {
  const text = bodyText(String.raw`\documentclass{article}
\usepackage[acronym]{glossaries}
\newacronym{gpu}{GPU}{graphics processing unit}
\newglossaryentry{gauss}{name={Gaussian}, description={a distribution}}
\begin{document}
We train on a \gls{gpu}; \Gls{gauss}s are smooth; \acrlong{gpu}; \glspl{gpu}; \acrfull{gpu}.
A \ac{CNN} and \acl{CNN} and \acp{CNN}; \gls{unknown}.
\begin{acronym}
\acro{CNN}{Convolutional Neural Network}
\end{acronym}
\end{document}
`);
  assert.match(text, /on a GPU; Gaussians are smooth; graphics processing unit; GPUs; graphics processing unit \(GPU\)\./);
  assert.match(text, /A CNN and Convolutional Neural Network and CNNs;/);
  // An entry the document does not define stays as written.
  assert.match(text, /\\gls\{unknown\}/);
});

test("B6-18/B7-20: thm-restate's \\name* is drawn as the restated theorem's heading, with its number (Larrauri & Živný)", () => {
  const text = bodyText(String.raw`\documentclass{article}
\usepackage{thm-restate}
\newtheorem{theorem}{Theorem}
\begin{document}
\begin{theorem}First.\end{theorem}
\begin{restatable}[Main]{theorem}
{promisemonoids}\label{th:promisemonoids}
Let $M_1$ be a monoid.
\end{restatable}
We prove it.

\promisemonoids*

\begin{proof}Done.\end{proof}
\end{document}
`);
  assert.match(text, /Theorem 2 \(Main, restated\)\./);
  assert.doesNotMatch(text, /\\promisemonoids/);
});

test("B4-17/B5-31: eurosym's \\euro and \\EUR in text and formulas; \\raisebox around an inline icon; \\censor and \\nicefrac in cells", () => {
  const text = bodyText(String.raw`\documentclass{article}
\usepackage{eurosym}
\begin{document}
A wage of \euro{8.50}, \EUR{12} per hour.
Tools: \raisebox{-0.1cm}{\protect\includegraphics[width=0.3cm]{figures/book.png}} and more.
\begin{tabular}{ll}
/r/\censor{......}51y & \nicefrac{1}{2} \\
\end{tabular}
\end{document}
`);
  assert.match(text, /A wage of €8\.50, € ?12 per hour/);
  assert.doesNotMatch(text, /\\euro|\\EUR|\\raisebox|-0\.1cm|\\censor|\\nicefrac/);
  const katex = mounted(String.raw`\begin{document}
$\euro 8.50$
\end{document}
`, (content) => content.querySelector(".katex")?.textContent ?? "");
  assert.match(katex, /€/);
});

test("B5-27: IEEEtran's bibliography definitions fold away, and its spacing macros in entries print nothing (Membership Inference)", () => {
  const text = bodyText(String.raw`\begin{document}
\begin{thebibliography}{10}
\providecommand{\url}[1]{#1}
\csname url@samestyle\endcsname
\providecommand{\newblock}{\relax}
\providecommand{\bibinfo}[2]{#2}
\providecommand{\BIBentrySTDinterwordspacing}{\spaceskip=0pt\relax}
\providecommand{\BIBentryALTinterwordstretchfactor}{4}
\providecommand{\BIBentryALTinterwordspacing}{\spaceskip=\fontdimen2\font plus
\BIBentryALTinterwordstretchfactor\fontdimen3\font minus
  \fontdimen4\font\relax}
\providecommand{\BIBdecl}{\relax}
\BIBdecl

\bibitem{abadi2016deep}
\BIBentryALTinterwordspacing
M.~Abadi, Deep learning with differential privacy, in \emph{{CCS}}, 2016.
\BIBentrySTDinterwordspacing
\end{thebibliography}
\end{document}
`);
  assert.doesNotMatch(text, /providecommand|csname|BIBdecl|spaceskip|BIBentry/);
  assert.match(text, /Abadi/);
});

test("B5-30/B3-25: \\keywords in the text is drawn with its label; a CCSXML block folds away", () => {
  const text = bodyText(String.raw`\documentclass{article}
\begin{document}
\begin{abstract}
We develop a command.

\keywords{many instruments, two-stage least squares.}
\end{abstract}
\begin{CCSXML}
<ccs2012>
</ccs2012>
\end{CCSXML}
\end{document}
`);
  assert.match(text, /Keywords: many instruments, two-stage least squares\./);
  assert.doesNotMatch(text, /\\keywords|ccs2012/);
});

test("a citation note prints its emphasis, font switches and spacing as text (cs.CL 2611.11838, math.AG 2611.08810)", () => {
  const text = bodyText(String.raw`\documentclass{article}
\begin{document}
Probing \citep[\emph{inter alia}]{hewitt,tenney} and \cite[{\rm I\hspace{-.01em}I\hspace{-.01em}I}. 7.1 and~8.2]{Stichtenoth}.
Kept: \cite[\unknownmacro{x}]{other}.
\end{document}
`);
  assert.match(text, /hewitt; tenney, inter alia\]/);
  assert.match(text, /\[Stichtenoth, III\. 7\.1 and 8\.2\]/);
  assert.doesNotMatch(text, /\\emph|\\rm|\\hspace/);
  // A note with a command that is not understood leaves its citation as source.
  assert.match(text, /\\cite\[\\unknownmacro\{x\}\]\{other\}/);
});

test("Cambridge's jfp front matter folds into the title block, also when a long document is built in pieces (cs.LO 2610.41832)", () => {
  const doc = String.raw`\documentclass[nolinenum]{jfp}
\begin{document}
\journaltitle{arxiv}
\cpr{The Author(s),}
\doival{10.1017/xxxxx}
\newcommand{\shorttitle}{Pareto climate economics}
\lefttitle{Botta, Jansson, Richter}
\righttitle{\shorttitle}
\totalpg{\pageref{lastpage01}}
\jnlDoiYr{2026}
\title{Pareto climate economics: optimism and pessimism}
\begin{authgrp}
\author{NICOLA BOTTA} \affiliation{Potsdam Institute for Climate Impact Research.
  (\email{botta@pik-potsdam.de})}
%
\author{PATRIK JANSSON}
\affiliation{Chalmers University of Technology. (\email{patrikj@chalmers.se})}
\end{authgrp}
\begin{abstract}
${"We argue that simple models help. ".repeat(80)}
\end{abstract}
\maketitle%[E]
\section{Introduction}
${"Body text of the paper. ".repeat(600)}
\end{document}
`;
  const state = visualState(doc);
  assert.ok(constructs(state).includes(`title:${doc.indexOf("\\journaltitle")}:${doc.indexOf("%[E]") + 4}`));
  const text = bodyText(doc);
  assert.match(text, /Pareto climate economics: optimism and pessimism/);
  assert.match(text, /NICOLA BOTTA.*PATRIK JANSSON/);
  assert.doesNotMatch(text, /\\journaltitle|\\cpr|\\doival|\\jnlDoiYr|\\author|authgrp|\\affiliation|\\email/);
});
