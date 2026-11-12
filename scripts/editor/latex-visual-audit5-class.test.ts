import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { history } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { isInLatexComment } from "../../src/lib/latex/macros/definitions";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Document-class front matter and class environments, round 5 (arXiv 2611.13971 cas-dc, 2610.37006 lmcs, 2611.07413 llncs, 2611.12757 IEEEojcsys, 
 * 2611.11466 siamart, 2611.13868 IEEEtran, 2611.01431 INFORMS, 2611.14059 jmlr). */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

/** The Visual mode's state for `doc`, with every pending piece built. */
function visualState(doc: string, extra: Extension[] = []) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [history(), latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }), ...extra] });
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

function mount(doc: string, extra: Extension[] = []) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, extra), parent });
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
const typeInto = (area: HTMLTextAreaElement, value: string) => { area.value = value; area.dispatchEvent(new window.Event("input", { bubbles: true })); };
const text = (view: EditorView) => view.contentDOM.textContent ?? "";
const titleBlock = (view: EditorView) => view.contentDOM.querySelector<HTMLElement>(".cm-vis-title-block");
const sourceButton = (view: EditorView) => view.contentDOM.querySelector<HTMLButtonElement>(".cm-vis-title-block .cm-vis-title-source");
const part = (view: EditorView, name: string, index = 0) => view.contentDOM.querySelector<HTMLElement>(`.cm-vis-title-block [data-title-part="${name}"][data-title-index="${index}"]`)!;
const cursorAt = (view: EditorView, needle: string, shift = 0) => view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf(needle) + shift } });
const editorArea = (view: EditorView) => view.contentDOM.querySelector<HTMLTextAreaElement>(".cm-vis-title-editor");

// Elsevier CAS (arXiv 2611.13971, cs.AI): front matter as commands before `\maketitle`, the abstract and keywords between.
const CAS = String.raw`\documentclass[a4paper,fleqn]{cas-dc}
\begin{document}
\let\WriteBookmarks\relax
\def\floatpagepagefraction{1}
\def\textpagefraction{.001}

\shorttitle{TransGHOST: Real-Time Reconstruction}

\shortauthors{N. Nataraj, M. Sogabe et al.}

\title [mode = title]{TransGHOST: Real-Time Reconstruction}


\author[1]{Niran Nataraj}
\ead{niran@g.ecc.u-tokyo.ac.jp, hi@niran.dev}


\author[1]{Maina Sogabe}
\cormark[1]
\ead{fsogabe-vet@g.ecc.u-tokyo.ac.jp}

\affiliation[1]{organization={Department of Information Physics and Computing, The University of Tokyo},
            city={Tokyo},
            country={Japan}}

\cortext[1]{Corresponding author}

\begin{abstract}
Intraoperative scene perception is limited by instrument occlusion.
\end{abstract}


\begin{keywords}
Surgical scene reconstruction \sep
Instrument occlusion \sep
Cataract surgery
\end{keywords}

\maketitle

\section{Introduction}
Body text.
\end{document}`;

test("2611.13971: Elsevier CAS's title, authors, affiliation, emails, corresponding-author note and keywords are drawn, nothing left as source", () => {
  const view = mount(CAS);
  const block = titleBlock(view)!;
  assert.ok(block, "a title block");
  const shown = block.textContent ?? "";
  assert.match(shown, /TransGHOST: Real-Time Reconstruction/);
  assert.match(shown, /Niran Nataraj/);
  assert.match(shown, /Maina Sogabe/);
  assert.match(shown, /Department of Information Physics and Computing, The University of Tokyo, Tokyo, Japan/);
  assert.match(shown, /Email: niran@g\.ecc\.u-tokyo\.ac\.jp/);
  assert.match(shown, /Corresponding author/);
  assert.match(shown, /Surgical scene reconstruction, Instrument occlusion, Cataract surgery/);
  assert.match(block.querySelector(".cm-vis-title-abstract-body")?.textContent ?? "", /limited by instrument occlusion/);
  assert.doesNotMatch(text(view), /\\sep|\\ead|\\cormark|\\WriteBookmarks|\\shorttitle|organization=/);
  assert.deepEqual(left(view).filter((name) => name !== "end"), []);
  view.destroy();
});

test("2611.13971: CAS's title block gives the source on a click: a name edits in place, the key-value address and the button show the commands", () => {
  const view = mount(CAS);
  click(part(view, "author", 1));
  assert.equal(editorArea(view)!.value, "Maina Sogabe");
  typeInto(editorArea(view)!, "Maina Sogabe-Ito");
  press(editorArea(view)!, "Enter");
  assert.match(view.state.doc.toString(), /\\author\[1\]\{Maina Sogabe-Ito\}/);
  sourceButton(view)!.click();
  assert.match(text(view), /\\title \[mode = title\]/);
  assert.match(text(view), /organization=\{Department of Information Physics/);
  assert.match(text(view), /\\cormark\[1\]/);
  view.destroy();
});

// LMCS (arXiv 2610.37006, cs.PL): `\author[Short]{Name\lmcsorcid{…}}[a]`, an `\address` and `\email` per mark, the abstract before `\maketitle`.
const LMCS = String.raw`\documentclass{lmcs}
\keywords{Abstract Lipschitz Continuity, Abstract Interpretation}
\begin{document}

\title{Abstract Lipschitz Continuity}

\author[M.~Campion]{Marco Campion\lmcsorcid{0000-0002-1099-3494}}[a]
\author[I.~Mastroeni]{Isabella Mastroeni\lmcsorcid{0000-0003-1213-536X}}[b]

\address{Sorbonne Université, LIP6, Paris, France}	%
\email{marco.campion@lip6.fr}  %

\address{University of Verona, Department of Computer Science, Italy}	%
\email{\{isabella.mastroeni, michele.pasqua\}@univr.it}  %

\begin{abstract}
  \noindent We introduce Abstract Lipschitz Continuity.
\end{abstract}

\maketitle

\section{Introduction}
Body text.
\end{document}`;

test("2610.37006: the LMCS class's title, authors (ORCIDs not printed), addresses and emails are drawn from the marks `[a]`, `[b]`", () => {
  const view = mount(LMCS);
  const block = titleBlock(view)!;
  assert.ok(block, "a title block");
  const shown = block.textContent ?? "";
  assert.match(shown, /Abstract Lipschitz Continuity/);
  assert.match(shown, /Marco Campion/);
  assert.doesNotMatch(shown, /0000-0002|lmcsorcid/);
  assert.match(shown, /Sorbonne Université, LIP6, Paris, France/);
  assert.match(shown, /University of Verona, Department of Computer Science, Italy/);
  assert.match(shown, /Email: marco\.campion@lip6\.fr/);
  assert.match(block.querySelector(".cm-vis-title-abstract-body")?.textContent ?? "", /Abstract Lipschitz Continuity\./);
  assert.deepEqual(left(view).filter((name) => name !== "end"), []);
  view.destroy();
});

test("2610.37006: LMCS's title block: a click on an address edits it in place, the button shows the author commands with their ORCIDs", () => {
  const view = mount(LMCS);
  const line = view.contentDOM.querySelector<HTMLElement>(`.cm-vis-title-block [data-title-part="line"]`)!;
  assert.ok(line, "an address line");
  click(line);
  assert.match(editorArea(view)!.value, /Sorbonne|marco\.campion/);
  view.destroy();
  const source = mount(LMCS);
  sourceButton(source)!.click();
  // The block's first command is the `\keywords` in the preamble: the preamble opens at it.
  assert.match(text(source), /\\keywords\{Abstract Lipschitz Continuity/);
  source.destroy();
});

// LNCS (arXiv 2611.07413, cs.CC): `\let`/`\def` around `\maketitle` (a ToC trick) must not break the block.
const LLNCS = String.raw`\documentclass[11pt]{llncs}
\begin{document}
\title{Structured Quantum Hardness from Unstructured Assumptions}
\author{
Xiao Liang\inst{1}
\and
Takashi Yamakawa\inst{2}
}
\institute{
The Chinese University of Hong Kong, Hong Kong\\ \email{xiaoliang@cuhk.edu.hk}
\and
NTT Social Informatics Laboratories, Japan\\ \email{takashi.yamakawa@ntt.com}
}

% -- The wrap-up around "\maketitle" is used to remove paper title from ToC
\let\oldaddcontentsline\addcontentsline
\def\addcontentsline#1#2#3{}
\maketitle

\begin{abstract}
Whether useful structured hardness can arise.
\end{abstract}
\section{Introduction}
Body text.
\end{document}`;

test("2611.07413: LNCS's authors and institutes are drawn although `\\let` and `\\def` sit between them and `\\maketitle`", () => {
  const view = mount(LLNCS);
  const block = titleBlock(view)!;
  assert.ok(block, "a title block");
  const shown = block.textContent ?? "";
  assert.match(shown, /Xiao Liang/);
  assert.match(shown, /Takashi Yamakawa/);
  assert.match(shown, /NTT Social Informatics Laboratories/);
  assert.deepEqual(left(view).filter((name) => name !== "end"), []);
  click(part(view, "author", 0));
  assert.match(editorArea(view)!.value, /Xiao Liang/);
  view.destroy();
});

// IEEEojcsys (arXiv 2611.12757, math.OC): `\affilmark` numbers, `\affil`, `\authornote`, abstract and `IEEEkeywords` before `\maketitle`.
const OJCSYS = String.raw`\documentclass[11pt]{IEEEojcsys}
\begin{document}

\title{Succinct Infinite-Horizon Lyapunov and LQR Value Problems Are
BQP-Complete}

\author{Mohamed Serry\affilmark{1,2}}

\author{Jun Liu\affilmark{1}}%

\affil{Department of Applied Mathematics,
University of Waterloo, Canada}

\affil{Department of Mechanical Engineering, University of Waterloo, Canada}

\authornote{Both authors contributed equally to this manuscript.}
\begin{abstract}
Fundamental tasks in linear systems analysis.
\end{abstract}
\begin{IEEEkeywords}
Quantum algorithms, infinite horizon, output energy.
\end{IEEEkeywords}
\maketitle
\section{Introduction}
Body text.
\end{document}`;

test("2611.12757: IEEEojcsys's authors with affiliation marks, numbered affiliations, note and keywords are drawn", () => {
  const view = mount(OJCSYS);
  const block = titleBlock(view)!;
  assert.ok(block, "a title block");
  const shown = block.textContent ?? "";
  assert.match(shown, /Mohamed Serry/);
  assert.match(shown, /Jun Liu/);
  assert.match(shown, /Department of Applied Mathematics/);
  assert.match(shown, /Department of Mechanical Engineering/);
  assert.match(shown, /Both authors contributed equally/);
  assert.match(shown, /Quantum algorithms, infinite horizon, output energy\./);
  assert.doesNotMatch(text(view), /\\affilmark|\\authornote|IEEEkeywords/);
  assert.deepEqual(left(view).filter((name) => name !== "end"), []);
  click(part(view, "author", 1));
  assert.match(editorArea(view)!.value, /Jun Liu\\affilmark\{1\}/);
  press(editorArea(view)!, "Escape");
  view.destroy();
});

// siamart (arXiv 2611.11466, math.NA): the class predefines theorem, lemma, corollary, proposition and definition; the paper's `\newsiamremark`.
const SIAM = String.raw`\documentclass[onefignum,onetabnum]{siamart251216}
\usepackage{amsmath}
%\newtheorem{theorem}{Theorem}
%\newtheorem{lemma}[theorem]{Lemma}
\newsiamremark{remark}{Remark}
\newsiamthm{claim}{Claim}
\begin{document}
\begin{abstract}
We study a method.
\end{abstract}
\begin{keywords}
discontinuous Galerkin
\end{keywords}
\begin{AMS}
65N30, 76D07
\end{AMS}
\section{Main results}
\begin{theorem}\label{thm:main}
A first statement.
\end{theorem}
\begin{lemma}\label{lem:a}
A second statement.
\end{lemma}
\begin{corollary}\label{cor:norm}
A third statement.
\end{corollary}
\begin{remark}
A remark.
\end{remark}
\begin{claim}
A claim.
\end{claim}
See Lemma~\ref{lem:a} and Corollary~\ref{cor:norm}.
\end{document}`;

test("2611.11466: siamart's predefined lemma and corollary, the paper's `\\newsiamremark` remark and the AMS block are drawn, numbered with the theorems", () => {
  const view = mount(SIAM);
  const shown = text(view);
  assert.match(shown, /Theorem 1/);
  assert.match(shown, /Lemma 2/);
  assert.match(shown, /Corollary 3/);
  assert.match(shown, /Remark 4/);
  assert.match(shown, /Claim 5/);
  assert.match(shown, /See Lemma\s2 and Corollary\s3\./);
  assert.match(shown, /65N30, 76D07/);
  assert.doesNotMatch(shown, /\\begin\{(?:AMS|lemma|corollary|remark)\}|\\newsiamremark/);
  assert.deepEqual(left(view).filter((name) => name !== "end"), []);
  view.destroy();
});

test("2611.11466: a click on siamart's lemma header shows its source", () => {
  const view = mount(SIAM);
  const header = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")].find((line) => /^Lemma 2/.test(line.textContent ?? ""));
  assert.ok(header, "a Lemma 2 header");
  click(header!.querySelector("[class*='cm-vis']") ?? header!);
  cursorAt(view, "\\begin{lemma}", 3);
  assert.match(text(view), /\\begin\{lemma\}/);
  view.destroy();
});

// IEEEtran (arXiv 2611.13868, cs.CV): the biographies at the end, and a `\section*{}` with no title.
const BIO = String.raw`\documentclass[journal]{IEEEtran}
\begin{document}
\section*{}
\label{sec:abstract}
Deep neural networks underpin tasks.

\section{Introduction}
Text.

\section*{Biographies}

\begin{IEEEbiographynophoto}{Lorenzo Cirillo}
received the B.S. degree in computer and control engineering.
\end{IEEEbiographynophoto}

\begin{IEEEbiography}[{\includegraphics[width=1in,height=1.25in,clip,keepaspectratio]{photo}}]{Irene Amerini}
is an Associate Professor at DIAG.
\end{IEEEbiography}
\end{document}`;

test("2611.13868: IEEEtran's biographies are drawn as a name over the text; an untitled `\\section*{}` is not left as source", () => {
  const view = mount(BIO);
  const shown = text(view);
  assert.match(shown, /Lorenzo Cirillo/);
  assert.match(shown, /\[photo\] Irene Amerini/);
  assert.match(shown, /received the B\.S\. degree/);
  assert.doesNotMatch(shown, /IEEEbiography|\\includegraphics/);
  assert.deepEqual(left(view).filter((name) => name !== "end"), []);
  view.destroy();
});

test("2611.13868: a click on a biography's name shows the `\\begin{IEEEbiographynophoto}{…}` source, so does Alt-click", () => {
  for (const init of [{}, { altKey: true }]) {
    const view = mount(BIO);
    const name = view.contentDOM.querySelector<HTMLElement>(".cm-vis-bio-name")!;
    assert.ok(name, "a biography name");
    assert.equal(name.textContent, "Lorenzo Cirillo");
    click(name, init);
    assert.match(text(view), /\\begin\{IEEEbiographynophoto\}\{Lorenzo Cirillo\}/);
    view.destroy();
  }
});

// INFORMS (arXiv 2611.01431, econ.TH): `APPENDICES` is the `\appendix` of the class.
const INFORMS = String.raw`\documentclass[mnsc]{informs4}
\begin{document}
\section{Introduction}
Text.
\begin{APPENDICES}
\section{Proofs}\label{app:proofs}
Proof text, see Section~\ref{app:proofs}.
\end{APPENDICES}
\end{document}`;

test("2611.01431: INFORMS's APPENDICES letters its sections like `\\appendix` and its begin and end lines fold away", () => {
  const view = mount(INFORMS);
  const shown = text(view);
  assert.match(shown, /A\s*Proofs/);
  assert.match(shown, /see Section\sA\./);
  assert.doesNotMatch(shown, /APPENDICES/);
  assert.deepEqual(left(view).filter((name) => name !== "end"), []);
  cursorAt(view, "\\begin{APPENDICES}", 3);
  assert.match(text(view), /\\begin\{APPENDICES\}/);
  view.destroy();
});

// JMLR (arXiv 2611.14059, cs.LG): `\ifmlhdemo` is the class's `\newif`, never set by this paper.
const JMLR = String.raw`\documentclass[pmlr,twocolumn,10pt]{jmlr}
\jmlrproceedings{}{}
\title[HandsOnAid]{HandsOnAid: An Offline First-Aid Assistant}
\author[Salvi and Muna]{%
  \Name{Rezwan Islam Salvi}\nametag{\thanks{Equal contribution.}}\quad
  \Name{Saiyma Sittul Muna}\nametag{\footnotemark[1]}\\
  {\normalfont Islamic University of Technology}
}
\begin{document}
\maketitle
\ifmlhdemo\else
\begin{abstract}
Emergencies can occur where there is no phone signal.
\end{abstract}
\fi
\section{Introduction}
Text.
\end{document}`;

test("2611.14059: the JMLR title block is drawn and an `\\ifmlhdemo\\else … \\fi` around the abstract does not hide it", () => {
  const view = mount(JMLR);
  const shown = text(view);
  assert.match(shown, /HandsOnAid: An Offline First-Aid Assistant/);
  assert.match(shown, /Rezwan Islam Salvi/);
  assert.match(shown, /Emergencies can occur/);
  view.destroy();
});
