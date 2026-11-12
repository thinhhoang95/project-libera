import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { history } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setMacroSources, setNumbering, visualDefinitions, type MacroSource } from "../../src/lib/latex/codemirror/visual/model";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { isInLatexComment } from "../../src/lib/latex/macros/definitions";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Document-class front matter and class environments, round 6 (arXiv 2611.13966 cas-sc, 2611.09184 and 2611.14035 IEEEtran, 2611.09593 siamart,
 * 2611.12089 IEEEproof, 2610.38605 \nobalance, 2611.10293 \appendixpage, 2610.39375 \suppressfloats). */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

/** The Visual mode's state for `doc`, with every pending piece built. */
function visualState(doc: string, extra: Extension[] = [], sources: MacroSource[] = []) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [history(), latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }), ...extra] });
  if (sources.length) state = state.update({ effects: setMacroSources.of(sources) }).state;
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

function mount(doc: string, extra: Extension[] = [], sources: MacroSource[] = []) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, extra, sources), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return view;
}

/** The commands of the document that nothing drawn covers: what the view still shows as source (the audit's "left"). */
function left(view: EditorView) {
  const doc = view.state.doc.toString();
  const shown = view.state.field(structuralField).shown;
  const covered = (pos: number) => {
    let inside = false;
    shown.between(pos, pos + 1, (from, to, decoration) => { if (decoration.point && from <= pos && to > pos) { inside = true; return false; } });
    return inside;
  };
  const found: string[] = [];
  for (const match of doc.matchAll(/\\(?:begin\s*\{([^}]*)\}|([a-zA-Z@]+))/g)) {
    const pos = match.index!;
    if ((pos > 0 && doc[pos - 1] === "\\") || isInLatexComment(doc, pos) || covered(pos)) continue;
    found.push(match[1] !== undefined ? `begin{${match[1]}}` : match[2]);
  }
  return found;
}

const click = (node: Element, init: Record<string, unknown> = {}) => node.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init }));
const press = (target: Element, key: string) => target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
const text = (view: EditorView) => view.contentDOM.textContent ?? "";
const titleBlock = (view: EditorView) => view.contentDOM.querySelector<HTMLElement>(".cm-vis-title-block");
const sourceButton = (view: EditorView) => view.contentDOM.querySelector<HTMLButtonElement>(".cm-vis-title-block .cm-vis-title-source");
const part = (view: EditorView, name: string, index = 0) => view.contentDOM.querySelector<HTMLElement>(`.cm-vis-title-block [data-title-part="${name}"][data-title-index="${index}"]`)!;
const cursorAt = (view: EditorView, needle: string, shift = 0) => view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf(needle) + shift } });
const editorArea = (view: EditorView) => view.contentDOM.querySelector<HTMLTextAreaElement>(".cm-vis-title-editor");

// Elsevier CAS (arXiv 2611.13966, cs.AI): commented-out declarations and a commented-out abstract between the commands, `\author[…]{…}[orcid=…]`.
const CAS = String.raw`\documentclass[a4paper,fleqn]{cas-sc}
\begin{document}
\let\WriteBookmarks\relax

% Short title / author for running heads (CAS-style)
%\shorttitle{Taxonomy induction}
\shorttitle{Controlled Knowledge Engineering}
\shortauthors{Limniatis et~al.}

\title[mode=title]{Controlled Knowledge Engineering for Taxonomy Induction}

\author[1]{Jonas Limniatis}
%\cormark[1]
%\fnmark[1]
\ead{jonas.limniatis@lht.dlh.de}

%\credit{Conceptualization of this study, Methodology, Software}

\affiliation[1]{organization={Lufthansa Technik},
                city={Hamburg},
               citysep={}, % Uncomment if no comma needed between city and postcode
                postcode={22335},
                country={Germany}}

\author[3,4,5]{Robert Stahlbock}[orcid=0000-0002-0393-4904]
\cormark[1]
\ead{robert.stahlbock@uni-hamburg.de}
\cortext[cor1]{Corresponding author}
%\fntext[fn1]{This is the first author footnote.}

\begin{comment}
\begin{abstract}
%TODO: replace with final abstract at the end of the writing process.
Old abstract.
\end{abstract}
\end{comment}

\begin{abstract}
Taxonomies are structured knowledge representations.
\end{abstract}

\begin{keywords}
Taxonomy induction \sep Agentic LLM systems
\end{keywords}

\maketitle

\section{Introduction}
Body text.
\end{document}`;

test("2611.13966: CAS's front matter around a commented-out abstract is drawn as one title block", () => {
  const view = mount(CAS);
  const block = titleBlock(view)!;
  assert.ok(block, "a title block");
  const shown = block.textContent ?? "";
  assert.match(shown, /Controlled Knowledge Engineering for Taxonomy Induction/);
  assert.match(shown, /Jonas Limniatis/);
  assert.match(shown, /Robert Stahlbock/);
  assert.match(shown, /Lufthansa Technik/);
  assert.match(shown, /Corresponding author/);
  assert.match(block.querySelector(".cm-vis-title-abstract-body")?.textContent ?? "", /structured knowledge representations/);
  assert.doesNotMatch(block.querySelector(".cm-vis-title-abstract-body")?.textContent ?? "", /Old abstract/);
  assert.deepEqual(left(view).filter((name) => name !== "end"), []);
  view.destroy();
});

test("2611.13966: CAS's title block gives the source on a click", () => {
  const view = mount(CAS);
  click(part(view, "author", 0));
  assert.equal(editorArea(view)!.value, "Jonas Limniatis");
  press(editorArea(view)!, "Escape");
  sourceButton(view)!.click();
  assert.match(text(view), /\\shorttitle\{Controlled Knowledge Engineering\}/);
  assert.match(text(view), /\\author\[3,4,5\]\{Robert Stahlbock\}\[orcid=/);
  view.destroy();
});

// IEEEtran conference (arXiv 2611.09184, cs.IT): `\author` with its `{` on the next line, a drafted author list in comments (with unbalanced braces),
// author blocks split by `\and` and the user's `\linebreakand`.
const IEEE_CONF = String.raw`\documentclass[conference]{IEEEtran}
\begin{document}

\title{Enhanced Informed Dynamic BP Decoding
Scheduling Strategies for 5G NR LDPC Codes%
\thanks{This is the author's accepted manuscript.}
}

\makeatletter
\newcommand{\linebreakand}{%
  \end{@IEEEauthorhalign}
  \hfill\mbox{}\par
  \mbox{}\hfill\begin{@IEEEauthorhalign}
}
\makeatother

\author
{%Tofar C.-Y. Chang$\dagger$\thanks{$\dagger$Correspondence addressee}, I-Hsiang Lee\thanks{The authors are
%with Inst. of Communications Eng.}}
  \IEEEauthorblockN{Tofar C.-Y. Chang}
  \IEEEauthorblockA{\textit{Dept. of Electrical Eng.} \\
    Taipei, TAIWAN}
  \and
  \IEEEauthorblockN{I-Hsiang Lee}
  \IEEEauthorblockA{\textit{MediaTek Inc.} \\
    Hsinchu, TAIWAN}
  %\and
  \linebreakand % <------------- \and with a line-break

  \IEEEauthorblockN{Jian-Jia Weng}
  \IEEEauthorblockA{\textit{Dept. of Electrical Eng.} \\
    Keelung, TAIWAN}
}

\maketitle
\begin{abstract}
We present an enhanced strategy.
\end{abstract}

\section{Introduction}
Body text.
\end{document}`;

test("2611.09184: IEEEtran conference author blocks split by \\and and a user's \\linebreakand are drawn, none left as source", () => {
  const view = mount(IEEE_CONF);
  const block = titleBlock(view)!;
  assert.ok(block, "a title block");
  const shown = block.textContent ?? "";
  assert.match(shown, /Enhanced Informed Dynamic BP Decoding/);
  assert.match(shown, /Tofar C\.-Y\. Chang/);
  assert.match(shown, /Jian-Jia Weng/);
  assert.match(shown, /MediaTek Inc\./);
  assert.doesNotMatch(shown, /IEEEauthorblock|linebreakand|Correspondence/);
  assert.deepEqual(left(view).filter((name) => name !== "end"), []);
  view.destroy();
});

test("2611.09184: the IEEEtran conference title block gives the source on a click", () => {
  const view = mount(IEEE_CONF);
  sourceButton(view)!.click();
  assert.match(text(view), /\\IEEEauthorblockN\{Jian-Jia Weng\}/);
  assert.match(text(view), /\\linebreakand/);
  view.destroy();
});

// IEEEtran journal (arXiv 2611.14035, cs.LG): `\markboth` with its two arguments across a `%` line end, `\IEEEpubid`, `\IEEEaftertitletext`, then `\maketitle`.
const IEEE_JOURNAL = String.raw`\documentclass[journal]{IEEEtran}
\begin{document}

\title{ScaleBrain: A Scale-Consistent Framework}

\author{Minyu Zhou, Yajing Wu and Wensheng Zhang
        % <-this % stops a space
\thanks{This work was supported in part by the National Key Program.}%
\thanks{Minyu Zhou is with Nankai University.}%
}

% The paper headers
\markboth{Journal of \LaTeX\ Class Files,~Vol.~14, No.~8, August~2021}%
{Zhou \MakeLowercase{\textit{et al.}}: ScaleBrain: A Scale-Consistent Framework}

\IEEEpubid{0000--0000/00\$00.00~\copyright~2021 IEEE}
% Remember, if you use this you must call \IEEEpubidadjcol in the second
% column for its text to clear the IEEEpubid mark.

\IEEEaftertitletext{\vspace{-1em}}
\maketitle

\begin{abstract}
Foundation models are a paradigm.
\end{abstract}

\section{Introduction}
Understanding brain activity.

\IEEEpubidadjcol

Over the past few decades.
\IEEEpeerreviewmaketitle
\end{document}`;

test("2611.14035: IEEEtran's \\markboth, \\IEEEpubid and \\IEEEaftertitletext stay in the title block; \\IEEEpubidadjcol and \\IEEEpeerreviewmaketitle are hidden", () => {
  const view = mount(IEEE_JOURNAL);
  const block = titleBlock(view)!;
  assert.ok(block, "a title block");
  assert.match(block.textContent ?? "", /ScaleBrain: A Scale-Consistent Framework/);
  assert.match(block.textContent ?? "", /Minyu Zhou/);
  assert.doesNotMatch(text(view), /markboth|IEEEpubid|IEEEaftertitletext|IEEEpeerreview|MakeLowercase/);
  assert.deepEqual(left(view).filter((name) => name !== "end"), []);
  view.destroy();
});

test("2611.14035: the hidden IEEEtran switches and the title block show their source on a click", () => {
  const view = mount(IEEE_JOURNAL);
  sourceButton(view)!.click();
  assert.match(text(view), /\\markboth\{Journal of/);
  assert.match(text(view), /\\IEEEaftertitletext/);
  cursorAt(view, "\\IEEEpubidadjcol", 3);
  assert.match(text(view), /\\IEEEpubidadjcol/);
  cursorAt(view, "\\IEEEpeerreviewmaketitle", 3);
  assert.match(text(view), /\\IEEEpeerreviewmaketitle/);
  view.destroy();
});

// SIAM's shared preamble (arXiv 2611.09593, math.NA): a file the root `\input`s before `\begin{document}`; opened on its own it has no body.
const SIAM_SHARED = String.raw`% SIAM Shared Information Template
% Packages and macros go here
\usepackage{amsfonts}
\usepackage{graphicx}
\newsiamremark{assumption}{Assumption}

\ifpdf
  \DeclareGraphicsExtensions{.eps,.pdf,.png,.jpg}
\else
  \DeclareGraphicsExtensions{.eps}
\fi

\newcommand{\creflastconjunction}{, and~}
\newsiamthm{claim}{Claim}

% Sets running headers as well as PDF title and authors
\headers{Hybrid Quantum-Classical Solver}{K. Chawla, S. Lee, and J. Valyou}

\title{A Hybrid Quantum-Classical Solver for Darcy Flow\thanks{Submitted to the editors.
\funding{This work was supported by the U.S. Department of Energy.}}}

\author{Kapil Chawla\thanks{Department of Mathematics, Florida State University (\email{kc25bc@fsu.edu}).}
\and Sanghyun Lee\footnotemark[2] \and Jonathan Valyou\footnotemark[2]}

\usepackage{amsopn}
\DeclareMathOperator{\diag}{diag}
`;

test("2611.09593: SIAM's shared preamble file, opened on its own, is a preamble: nothing of it is left as source", () => {
  const view = mount(SIAM_SHARED);
  assert.ok(view.contentDOM.querySelector(".cm-vis-preamble"), "the file folds as a preamble");
  assert.doesNotMatch(text(view), /usepackage|newsiamremark|ifpdf|headers|funding/);
  assert.deepEqual(left(view).filter((name) => name !== "end"), []);
  view.destroy();
});

test("2611.09593: the shared preamble opens to its source on a click, and a macros-only file is not taken for one", () => {
  const view = mount(SIAM_SHARED);
  view.contentDOM.querySelector<HTMLButtonElement>(".cm-vis-preamble-toggle")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.match(text(view), /\\headers\{Hybrid Quantum-Classical Solver\}/);
  assert.match(text(view), /\\newsiamremark\{assumption\}/);
  view.destroy();
  const macros = mount("\\newcommand{\\R}{\\mathbb{R}}\n\\usepackage{amsmath}\n");
  assert.equal(macros.contentDOM.querySelector(".cm-vis-preamble"), null);
  macros.destroy();
});

// siamart's main file (arXiv 2611.09593): the title block is in the shared file it `\input`s in the preamble.
const SIAM_MAIN = String.raw`\documentclass[onefignum,onetabnum]{siamart171218}
\usepackage{amsmath}
\input{ex_shared}

\begin{document}

\maketitle

\begin{abstract}
Quantum linear system algorithms.
\end{abstract}

\section{Introduction}
Body text.
\end{document}`;

test("2611.09593: siamart's title block, written in the shared file the preamble inputs, is drawn at \\maketitle", () => {
  const view = mount(SIAM_MAIN, [], [{ path: "nb/ex_shared.tex", text: SIAM_SHARED, version: "1", loadedBy: "", key: "input:ex_shared" }]);
  const block = titleBlock(view)!;
  assert.ok(block, "a title block");
  assert.match(block.textContent ?? "", /A Hybrid Quantum-Classical Solver for Darcy Flow/);
  assert.match(block.textContent ?? "", /Kapil Chawla/);
  assert.match(block.textContent ?? "", /Sanghyun Lee/);
  assert.doesNotMatch(block.textContent ?? "", /\\thanks|\\funding|\\email|footnotemark/);
  // Its commands are in the other file: a click on the title shows the `\maketitle` line.
  click(part(view, "title", 0));
  assert.match(text(view), /\\maketitle/);
  view.destroy();
});

// IEEEtran's proof (arXiv 2611.12089, math.OC), and layout switches with no output (2610.38605 `\nobalance`, 2611.10293 `\appendixpage`, 2610.39375 `\suppressfloats[t]`).
const IEEE_PROOF = String.raw`\documentclass{IEEEtran}
\usepackage{amsthm}
\newtheorem{theorem}{Theorem}
\begin{document}
\nobalance
\section{Results}
\begin{theorem}
It holds.
\end{theorem}

\begin{IEEEproof}
Since $a=b$, we have the claim.
\end{IEEEproof}

\begin{IEEEproof}[Proof of Theorem 1]
Again.
\end{IEEEproof}

\suppressfloats[t]
\appendixpage
Text after.
\end{document}`;

test("2611.12089: IEEEproof is drawn as a proof with its optional heading; \\nobalance, \\suppressfloats and \\appendixpage are hidden", () => {
  const view = mount(IEEE_PROOF);
  const headers = [...view.contentDOM.querySelectorAll(".cm-vis-env-header")].map((node) => node.textContent);
  assert.ok(headers.some((header) => /^Proof/.test(header ?? "")), `a Proof header in ${JSON.stringify(headers)}`);
  assert.ok(headers.some((header) => /Proof of Theorem 1/.test(header ?? "")));
  assert.doesNotMatch(text(view), /IEEEproof|nobalance|suppressfloats|appendixpage/);
  assert.deepEqual(left(view).filter((name) => name !== "end"), []);
  view.destroy();
});

test("2611.12089: an IEEEproof header and the hidden switches show their source at the caret", () => {
  const view = mount(IEEE_PROOF);
  cursorAt(view, "\\begin{IEEEproof}", 3);
  assert.match(text(view), /\\begin\{IEEEproof\}/);
  cursorAt(view, "\\nobalance", 3);
  assert.match(text(view), /\\nobalance/);
  cursorAt(view, "\\suppressfloats", 3);
  assert.match(text(view), /\\suppressfloats\[t\]/);
  cursorAt(view, "\\appendixpage", 3);
  assert.match(text(view), /\\appendixpage/);
  view.destroy();
});
