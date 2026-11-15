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

/* Front matter, document classes and bibliography, audit round 7 (the arXiv id is at each test). */

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


// Whether the source of `needle` is in the DOM (what a click or the caret reveals).
const shows = (view: EditorView, needle: string) => text(view).includes(needle);

// stat.AP 2611.10515: `\title{\bf …\thanks{…}}`, `\author{…\thanks{…\href{mailto:…}{…}}… \and …}`, `\date{\today}` in the body, then
// `\maketitle\thispagestyle{empty}` on one line: the block did not fold the declarations because the line held more than `\maketitle`.
const STAT_AP_TITLE = String.raw`\documentclass[11pt,letterpaper]{article}
\usepackage{natbib}
\begin{document}
\title{\bf A General Statistical Framework for Attention \\ and Manipulation Checks\thanks{We thank Lea Dinsing. }}
\author{Kentaro Nakamura\thanks{Ph.D. Student, John F. Kennedy School
    of Government, Harvard University. Email:
    \href{mailto:knakamura@g.harvard.edu}{knakamura@g.harvard.edu}.} \and
    Kosuke Imai\thanks{Edith and Benjamin Geisinger
    Professor. Phone: 617--384--6778, Email:
    \href{mailto:Imai@Harvard.Edu}{Imai@Harvard.Edu}, URL:
    \href{https://imai.fas.harvard.edu}{https://imai.fas.harvard.edu}.}}
\date{\today}
\maketitle\thispagestyle{empty}

\begin{abstract}
Hello.
\end{abstract}
\end{document}
`;

test("2611.10515: a title block ending in `\\maketitle\\thispagestyle{empty}` is drawn over all its commands and stays editable", () => {
  const view = mount(STAT_AP_TITLE);
  assert.ok(titleBlock(view));
  assert.deepEqual(left(view), []);
  assert.match(titleBlock(view)!.textContent ?? "", /A General Statistical Framework for Attention/);
  assert.match(titleBlock(view)!.textContent ?? "", /Kosuke Imai/);
  // A click on a part edits it in place; the source button shows every command, `\thispagestyle` among them.
  click(part(view, "author", 1));
  assert.equal(editorArea(view)!.value.startsWith("Kosuke Imai"), true);
  press(editorArea(view)!, "Escape");
  sourceButton(view)!.click();
  assert.match(text(view), /\\maketitle\\thispagestyle\{empty\}/);
  assert.match(text(view), /\\title\{/);
  view.destroy();
});

// cond-mat.mes-hall 2611.13157 and 2611.13235 (Springer Nature's sn-jnl): `\bmhead{…}` is a run-in unnumbered heading.
const SN_JNL = String.raw`\documentclass[pdflatex,sn-nature]{sn-jnl}
\begin{document}

\title[Short]{Mimicking the zero-field Josephson diode effect}

\author*[1,2]{\fnm{Nathan} \sur{Satchell}}\email{satchell@txstate.edu}
\affil[1]{\orgdiv{Department of Physics}, \orgname{Texas State University}, \orgaddress{\city{San Marcos}, \country{USA}}}
\abstract{A Josephson junction.}

\maketitle

\section{Methods}\label{sec:methods}

\bmhead{Device fabrication}
The junctions were fabricated by the process of our previous work.

\bmhead{Acknowledgements}
We thank everyone.
\end{document}
`;

test("2611.13157: sn-jnl's \\bmhead is a run-in unnumbered heading, and a click shows its source", () => {
  const view = mount(SN_JNL);
  assert.deepEqual(left(view), []);
  const headings = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-macro-heading")];
  assert.deepEqual(headings.map((heading) => heading.textContent), ["Device fabrication", "Acknowledgements"]);
  assert.ok(!shows(view, "\\bmhead"));
  click(headings[0]);
  assert.ok(shows(view, "\\bmhead{Device fabrication}"));
  const at = view.state.doc.toString().indexOf("\\bmhead{Device fabrication}");
  assert.ok(view.state.selection.main.head >= at && view.state.selection.main.head <= at + "\\bmhead{Device fabrication}".length);
  view.destroy();
});

// cs.LG 2611.16789 (elsarticle `frontmatter`): the abstract is long enough for the `\end{frontmatter}` line to be built in a later piece than the `\begin`.
test("2611.16789: `\\end{frontmatter}` folds away when it is built in a later piece, and shows at the caret", () => {
  const abstract = Array.from({ length: 160 }, (_, i) => `Sentence ${i} of the abstract is a line of plain words that fill the piece.`).join("\n");
  const doc = String.raw`\documentclass[5p,times,procedia]{elsarticle}
\begin{document}
\begin{frontmatter}

\title{ScrewSense: Mapping the Invisible -- Anomaly Detection}

\author[a]{Tobias Lettner \corref{cor1}}
\address[a]{Department of Electrical Engineering, Amberg, Germany}

\cortext[cor1]{* \textit{Corresponding author: t.lettner@oth-aw.de}}

\begin{abstract}
${abstract}
\end{abstract}

\begin{keyword}
  Anomaly Detection \sep Error Classification
\end{keyword}

\end{frontmatter}

\section{Introduction and Motivation}
Text.
\end{document}
`;
  assert.ok(doc.length > 8000);
  const view = mount(doc);
  assert.deepEqual(left(view), []);
  cursorAt(view, "\\end{frontmatter}");
  assert.ok(shows(view, "\\end{frontmatter}"));
  view.destroy();
});

// stat.ML 2611.14586 (jmlr2e): the style defines `keywords` with grouped margins and a small gap around its label.
const JMLR_KEYWORDS = String.raw`\documentclass[twoside,11pt]{article}
\newenvironment{keywords}
{\bgroup\leftskip 20pt\rightskip 20pt \small\noindent{\bf Keywords:} }%
{\par\egroup\vskip 0.25ex}
\begin{document}
\begin{abstract}%
Recursive estimators.
\end{abstract}

\begin{keywords}
streaming regression, prior-anchored ridge, forgetting factor
\end{keywords}

\section{Introduction}
Text.
\end{document}
`;

test("2611.14586: jmlr2e's `keywords` environment draws its label and keywords, and the heading shows its source on a click", () => {
  const view = mount(JMLR_KEYWORDS);
  assert.deepEqual(left(view), []);
  const header = view.contentDOM.querySelector<HTMLElement>(".cm-vis-env-header-user");
  assert.match(header?.textContent ?? "", /Keywords:/);
  assert.ok(!shows(view, "\\begin{keywords}"));
  click(header!);
  assert.ok(shows(view, "\\begin{keywords}"));
  assert.ok(shows(view, "streaming regression"));
  // The `\end` line shows at the caret.
  cursorAt(view, "\\end{keywords}");
  assert.ok(shows(view, "\\end{keywords}"));
  view.destroy();
});

// math.NA 2611.14041 (siamart): `keywords` and `MSCcodes` after the abstract.
const SIAM_ABSTRACT = String.raw`\documentclass[hidelinks]{siamart251216}
\begin{document}
\begin{abstract}
We study things.
\end{abstract}

\begin{keywords}
matrix-free, $p$-multigrid, hybrid Schwarz
\end{keywords}

\begin{MSCcodes}
65F05, 65F08, 65F10
% provenance (not printed): titles checked against the MSC2020 list
\end{MSCcodes}

\section{Introduction}
Text.
\end{document}
`;

test("2611.14041: siamart's MSCcodes environment draws like keywords, and its lines show their source at the caret", () => {
  const view = mount(SIAM_ABSTRACT);
  assert.deepEqual(left(view), []);
  assert.ok(!shows(view, "\\begin{MSCcodes}"));
  assert.ok(view.contentDOM.querySelector(".cm-vis-keywords"));
  const codes = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-keywords")].find((line) => /65F05/.test(line.textContent ?? ""));
  assert.ok(codes);
  cursorAt(view, "\\begin{MSCcodes}", 3);
  assert.ok(shows(view, "\\begin{MSCcodes}"));
  cursorAt(view, "\\end{MSCcodes}", 3);
  assert.ok(shows(view, "\\end{MSCcodes}"));
  view.destroy();
});

// stat.AP 2611.10325 (eso-pic): a page decoration drawn on every printed page.
test("2611.10325: `\\AddToShipoutPictureFG*{…}` is hidden like other layout commands, and shows at the caret", () => {
  const doc = String.raw`\documentclass{IEEEtran}
\usepackage{eso-pic}
\begin{document}
Before.

\AddToShipoutPictureFG*{\AtPageLowerLeft{\put(\LenToUnit{0.5\paperwidth},\LenToUnit{0.32in}){\makebox(0,0)[b]{\parbox{\textwidth}{\scriptsize\centering \textcopyright~2026 IEEE. Personal use of this material is permitted.}}}}}

\begin{abstract}
Evaluations.
\end{abstract}
\end{document}
`;
  const view = mount(doc);
  assert.deepEqual(left(view), []);
  assert.ok(!shows(view, "AddToShipoutPictureFG"));
  assert.ok(!shows(view, "2026 IEEE"));
  cursorAt(view, "\\AddToShipoutPictureFG", 5);
  assert.ok(shows(view, "\\AddToShipoutPictureFG*{"));
  view.destroy();
});

// math.PR 2611.15228: a .bbl's fallbacks `\expandafter\ifx\csname burlalt\endcsname\relax \def\burlalt#1#2{\href{#2}{\texttt{#1}}}\fi`.
const BURLALT = String.raw`\documentclass{article}
\begin{document}
Text \cite{AB}.
\begin{thebibliography}{99}
\providecommand{\bysame}{\leavevmode\hbox to3em{\hrulefill}\thinspace}
\expandafter\ifx\csname url\endcsname\relax
  \def\url#1{\texttt{#1}}\fi
\expandafter\ifx\csname urlprefix\endcsname\relax\def\urlprefix{URL }\fi
\expandafter\ifx\csname href\endcsname\relax
  \def\href#1#2{#2}\fi
\expandafter\ifx\csname burlalt\endcsname\relax
  \def\burlalt#1#2{\href{#2}{\texttt{#1}}}\fi

\bibitem[AB]{AB}
\textsc{S.~Athreya}.
\newblock Well-posedness.
\newblock
  \burlalt{doi:10.1002/cpa.22157}{http://dx.doi.org/10.1002/cpa.22157}.
\end{thebibliography}
\end{document}
`;

test("2611.15228: `\\burlalt{doi:…}{url}` from the bibliography's own fallback definition is a link showing its first argument, and a click shows the source", () => {
  const view = mount(BURLALT);
  const entry = text(view);
  assert.match(entry, /doi:10\.1002\/cpa\.22157\./);
  assert.ok(!entry.includes("dx.doi.org"));
  assert.ok(!entry.includes("\\burlalt"));
  assert.deepEqual(left(view), []);
  const shown = [...view.contentDOM.querySelectorAll<HTMLElement>("*")].filter((node) => node.children.length === 0 && /^doi:10\.1002/.test(node.textContent ?? "")).at(-1)!;
  click(shown);
  assert.ok(shows(view, "\\burlalt{doi:10.1002/cpa.22157}{http://dx.doi.org/10.1002/cpa.22157}"));
  view.destroy();
});

// cond-mat.stat-mech 2611.14576: size and spacing settings on the `thebibliography` line.
test("2611.14576: settings after `\\begin{thebibliography}{99}` go with the heading, which shows them on a click", () => {
  const doc = String.raw`\documentclass{article}
\begin{document}
Text \cite{a}.
\begin{thebibliography}{99}\small\setlength{\baselineskip}{11pt}\setlength{\itemsep}{0pt}\setlength{\parsep}{0pt}

\bibitem{a}
G.~Sch\"utz, Phys. Rev. E (2004).
\end{thebibliography}
\end{document}
`;
  const view = mount(doc);
  assert.deepEqual(left(view), []);
  assert.ok(!shows(view, "\\setlength"));
  const heading = view.contentDOM.querySelector<HTMLElement>(".cm-vis-macro-heading")!;
  assert.equal(heading.textContent?.trim(), "References");
  click(heading);
  assert.ok(shows(view, "\\small\\setlength{\\baselineskip}{11pt}\\setlength{\\itemsep}{0pt}"));
  view.destroy();
});

// eess.SY 2611.15162 and stat.ML 2611.13765 (IEEEtran): `\bibliography` inside a group with a spacing change, and `\bstctlcite`.
test("2611.15162: `\\begingroup\\renewcommand{\\baselinestretch}{0.94}\\bibliography{references}\\endgroup` is the References list, and a click shows the line", () => {
  const doc = String.raw`\documentclass[journal]{IEEEtran}
\begin{document}
\bstctlcite{BSTcontrol}

\title{A title}
\author{A. Author}
\maketitle

Text \cite{a}.

\bibliographystyle{IEEEtran}
\begingroup\renewcommand{\baselinestretch}{0.94}\bibliography{references}\endgroup
\end{document}
`;
  const view = mount(doc);
  assert.deepEqual(left(view), []);
  assert.ok(!shows(view, "\\bstctlcite"));
  const list = view.contentDOM.querySelector<HTMLElement>(".cm-vis-references")!;
  assert.ok(list);
  assert.ok(!shows(view, "\\begingroup"));
  click(list);
  assert.ok(shows(view, "\\begingroup"));
  assert.ok(shows(view, "\\bibliography{references}\\endgroup"));
  cursorAt(view, "\\renewcommand{\\baselinestretch}", 3);  assert.ok(shows(view, "\\renewcommand{\\baselinestretch}{0.94}"));
  // The hidden `\bstctlcite` shows its source at the caret.
  cursorAt(view, "\\bstctlcite", 4);
  assert.ok(shows(view, "\\bstctlcite{BSTcontrol}"));
  view.destroy();
});

// hep-ph 2611.15647: `\newcommand{\pref}[1]{{(\ref{#1})}}` with a label that holds `_`.
test("2611.15647: a macro whose body is `(\\ref{#1})` draws for a label with an underscore, and a click shows the use", () => {
  const doc = String.raw`\documentclass{article}
\newcommand{\pref}[1]{{(\ref{#1})}}
\begin{document}
See {\it e.g.}~Eq.~\pref{eq:effective_gravitational_couplings} for details.
\begin{equation}\label{eq:effective_gravitational_couplings} x \end{equation}
\end{document}
`;
  const view = mount(doc);
  assert.deepEqual(left(view), []);
  assert.match(text(view), /Eq\.\s\(1\) for details/);
  const mark = view.contentDOM.querySelector<HTMLElement>(".cm-vis-macro");
  assert.ok(mark);
  click(mark!);
  assert.ok(shows(view, "\\pref{eq:effective_gravitational_couplings}"));
  view.destroy();
});
