import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { collectMacroSources } from "../../src/components/libera/latex/latex-dependencies";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { setMacroSources, setNumbering, visualDefinitions, type MacroSource } from "../../src/lib/latex/codemirror/visual/model";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { isInLatexComment } from "../../src/lib/latex/macros/definitions";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Audit round 5, generic environments, tcolorbox boxes, definitions in the body and layout/setup commands: a definition
 * made in the body is one inert unit (2611.05777, 2611.07413), a tcolorbox with its options and title over several lines
 * is a box (2611.07413) and one the preamble file defines is known in the body files (2611.11460), and the setup commands
 * that print nothing (2610.16732, 2611.13971, 2611.14059, 2611.12463, 2611.11400, 2611.11566, 2611.11859) fold away. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function visualState(doc: string, anchor: number, sources: MacroSource[]) {
  let state = EditorState.create({ doc, selection: { anchor }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" })] });
  ensureSyntaxTree(state, doc.length, 5000);
  if (sources.length) state = state.update({ effects: setMacroSources.of(sources) }).state;
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

/** A mounted Visual mode for `doc`, numbered as the app numbers it, the caret at `anchor` (the start by default). */
function mount(doc: string, anchor = 0, sources: MacroSource[] = []) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, anchor, sources), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return { view, numbering, done: () => { view.destroy(); parent.remove(); } };
}

const text = (view: EditorView) => view.contentDOM.textContent ?? "";
const click = (node: Element) => node.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
const squash = (value: string) => value.replace(/[​⁣]/g, "");

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

// cs.GT 2611.05777 ps.tex: definitions made in the body, one with a whole tikzpicture in its body.
const PS_DEFINITIONS = String.raw`\documentclass{article}
\begin{document}
Before the figure.

\usetikzlibrary{arrows.meta,calc,backgrounds}
\newsavebox{\psladderreferencebox}
\newif\ifpsladderoverlay
\pgfkeys{
  /ps ladder/.is family,
  /ps ladder/overlay/.default=true
}

\newcommand{\psladder}[3][]{%
\begingroup
\footnotesize
\pgfmathsetlengthmacro{\ladderlabelwidth}{width("$(H-1,0)$")}
\psladderoverlayfalse
\resizebox{0.95\linewidth}{!}{%
\ifpsladderoverlay \node at (0,0) {$(9,9)$}; \else \fi
}
\endgroup
}

\newcommand{\psladderpicture}[2]{%
\begin{tikzpicture}[x=.8cm]
  \node[vertex] (surplus) at (0,0) {$(-1,0)$};
  \draw[edge] (surplus) -- node[midway,above] {$1$} (root);
  \foreach \a/\b in {c3h0/c4h0} { \path (\a.center) -- node {$\cdots$} (\b); }
\end{tikzpicture}%
}

After the figure.
\end{document}
`;

test("a definition in the body is one inert unit: its tikzpicture, nodes and conditionals are never drawn (2611.05777)", () => {
  const { view, done } = mount(PS_DEFINITIONS);
  const shown = squash(text(view));
  assert.match(shown, /Before the figure\./);
  assert.match(shown, /After the figure\./);
  for (const inside of ["(-1,0)", "(H-1,0)", "(9,9)", "\\draw", "\\node", "\\ifpsladderoverlay", "\\newcommand", "\\usetikzlibrary", "\\pgfkeys", "\\newif"]) assert.ok(!shown.includes(inside), `${inside} is on screen: ${shown}`);
  // Nothing of it counts as left over, and nothing inside was walked into.
  assert.deepEqual(left(view), []);
  done();
});

test("a folded definition shows its source again with the caret in it (click-to-source)", () => {
  const source = PS_DEFINITIONS;
  const { view, done } = mount(source, source.indexOf("After the figure"));
  assert.ok(!squash(text(view)).includes("\\psladderpicture"));
  // The caret in the definition: its lines are shown as written.
  view.dispatch({ selection: { anchor: source.indexOf("\\newcommand{\\psladderpicture}") + 12 } });
  refreshVisualWidgets(view);
  assert.ok(squash(text(view)).includes("\\newcommand{\\psladderpicture}"), squash(text(view)).slice(0, 400));
  done();
});

test("definitions at the top of a section file stay macros for the formulas below (ps-upper.tex)", () => {
  const section = String.raw`\newcommand{\Nsmall}{N_{\mathrm{small}}}
\newcommand{\dcut}{\delta_{\mathrm{check}}}
\newcommand{\Partition}{\textsc{RandRepPartition}}

\subsection{Distortion Upper Bound}
We take $\Nsmall$ and $\dcut$ in \Partition.
`;
  const { view, done } = mount(section, section.length);
  const shown = squash(text(view));
  assert.ok(!shown.includes("\\newcommand") && !shown.includes("\\mathrm"), shown);
  assert.match(shown, /Distortion Upper Bound/);
  assert.equal(view.contentDOM.querySelectorAll(".katex").length, 2);
  assert.ok(!/\\Nsmall|\\dcut/.test(shown), shown);
  done();
});

test("a definition among text is hidden at its own place and shown at the caret", () => {
  const source = String.raw`Before \newcommand{\x}{\textbf{y}} after.`;
  const hidden = mount(source);
  assert.ok(!squash(text(hidden.view)).includes("\\newcommand"), text(hidden.view));
  assert.match(squash(text(hidden.view)), /Before\s+after\./);
  hidden.done();
  const shown = mount(source, source.indexOf("\\textbf"));
  assert.ok(squash(text(shown.view)).includes("\\newcommand{\\x}"), text(shown.view));
  shown.done();
});

test("an environment defined mid-document with an unbalanced tabular is not drawn (2611.07413)", () => {
  const { view, done } = mount(String.raw`\documentclass{article}
\begin{document}
Intro text.
\newcounter{qromalg}[section]
\renewcommand{\theqromalg}{\thesection.\arabic{qromalg}}
\newenvironment{qrombox}[1]{%
\par\medskip\noindent
\begin{tabular}{|p{\dimexpr\linewidth-2\tabcolsep-2\arrayrulewidth\relax}|}
\hline
\textbf{#1}\\ \hline
}{%
\\ \hline
\end{tabular}
\smallskip
}
\let\oldaddcontentsline\addcontentsline
\def\addcontentsline#1#2#3{\oldaddcontentsline{#1}{#2}{#3}}
Closing text.
\end{document}
`);
  const shown = squash(text(view));
  assert.match(shown, /Intro text\./);
  assert.match(shown, /Closing text\./);
  assert.ok(!/tabular|\\hline|qrombox|oldaddcontentsline/.test(shown), shown);
  assert.deepEqual(left(view), []);
  done();
});

test("setup commands the grammar does not know print nothing: \\newif, \\pgfmathsetlengthmacro, \\floatname, \\algtext* (2611.05777)", () => {
  const { view, done } = mount(String.raw`\begin{document}
Prose.
\begingroup
\floatname{algorithm}{Construction}
\algtext*{EndIf}
\algtext*{EndFor}
\pgfmathsetlengthmacro{\branchlabelwidth}{width("$(-1,-1)$")}
\newif\ifdraftmode
\endgroup
More prose.
\end{document}
`);
  const shown = squash(text(view));
  assert.match(shown, /Prose\./);
  assert.match(shown, /More prose\./);
  assert.ok(!/floatname|algtext|EndIf|EndFor|pgfmath|branchlabel|newif|draftmode|\(-1,-1\)/.test(shown), shown);
  done();
});

// cs.CC 2611.07413: `\newtcolorbox[auto counter,…]{BoxBox}[2][]{title={Box~\thetcbcounter: #2},…,#1}` in the preamble.
const BOXES = String.raw`\documentclass{article}
\usepackage[most]{tcolorbox}
\newtcolorbox
[auto counter,
Crefname={Box}{Boxes},
]{BoxBox}[2][]
{
  title    = {Box~\thetcbcounter: #2},
  fonttitle=\small\bfseries,
  colframe = black,
  #1
}
\newtcolorbox[
auto counter,
number within=section,
Crefname={Algo.}{Algo.}
]{AlgorithmBox}[2][]
{
  title    = {Algorithm~\thetcbcounter: #2},
  #1
}
\newtcolorbox[auto counter]{CommentBox}[2][]
{
  title    = #2,
}
\begin{document}
\section{Setup}
\begin{BoxBox}[label={box:dist-D0-D1},
    sidebyside,
    sidebyside align=top,
    float,
    floatplacement=!t
    ]{Distributions $D_0$ and $D_1$}
    Inside the first box.
\end{BoxBox}
See Box~\ref{box:dist-D0-D1}.
\begin{AlgorithmBox}[label={A-2-Section6}]{Adversary that breaks the Statistical
Zero-Knowledge Property}
    Inside the algorithm box.
\end{AlgorithmBox}
\begin{AlgorithmBox}[label=alg:two]{Reduction}
    Inside the second.
\end{AlgorithmBox}
\begin{CommentBox}{A margin note}
    Inside a note.
\end{CommentBox}
\begin{BoxBox}{No options}
    Inside the second box.
\end{BoxBox}
\end{document}
`;

test("a tcolorbox whose options and title run over several lines is a box, numbered by its own counter (2611.07413)", () => {
  const { view, numbering, done } = mount(BOXES);
  const shown = squash(text(view));
  for (const inside of ["Inside the first box.", "Inside the algorithm box.", "Inside the second.", "Inside a note.", "Inside the second box."]) assert.ok(shown.includes(inside), inside);
  // The boxes' own `\begin` and `\end` lines fold away; the titles carry the counter, `number within=section` prefixing it.
  assert.ok(!/\\begin\{(?:BoxBox|AlgorithmBox|CommentBox)\}|\\end\{(?:BoxBox|AlgorithmBox|CommentBox)\}|sidebyside|floatplacement/.test(shown), shown);
  const titles = [...view.contentDOM.querySelectorAll(".cm-vis-env-header")].map((header) => squash(header.textContent ?? ""));
  assert.deepEqual(titles.map((title) => title.replace(/\s+/g, " ")), [
    "Box 1: Distributions D0 and D1",
    "Algorithm 1.1: Adversary that breaks the Statistical Zero-Knowledge Property",
    "Algorithm 1.2: Reduction",
    "A margin note",
    "Box 2: No options",
  ]);
  // `label=` in the options names the box: `\ref` finds its number.
  assert.equal(numbering.labels.get("box:dist-D0-D1")?.number, "1");
  assert.equal(numbering.labels.get("A-2-Section6")?.number, "1.1");
  assert.equal(numbering.labels.get("alg:two")?.number, "1.2");
  assert.match(shown, /See Box\s*1\./);
  assert.deepEqual(left(view).filter((name) => /Box|Comment/.test(name)), []);
  done();
});

test("a box's header opens its source on a click (click-to-source)", () => {
  const { view, done } = mount(BOXES);
  const header = view.contentDOM.querySelector(".cm-vis-env-header");
  assert.ok(header);
  click(header!);
  const source = view.state.doc.toString();
  const at = source.indexOf("\\begin{BoxBox}[label");
  const head = view.state.selection.main.head;
  assert.ok(head >= at && head <= source.indexOf("Inside the first box."), `caret ${head} is outside the opening at ${at}`);
  assert.ok(squash(text(view)).includes("\\begin{BoxBox}[label={box:dist-D0-D1}"), "the opening is shown as written");
  done();
});

test("a box the preamble file defines is a box in a body file (2611.11460 hypbox)", async () => {
  const files: Record<string, string> = {
    "nb/main.tex": String.raw`\documentclass{article}
\input{preamble}
\begin{document}
\input{sections/mm}
\end{document}`,
    "nb/preamble.tex": String.raw`\usepackage{tcolorbox}
\newtcolorbox{hypbox}{colback=blue!5, colframe=blue!40, boxrule=0.5pt}`,
    "nb/sections/mm.tex": String.raw`A paragraph before.
\begin{hypbox}
Assume that the box is drawn as a box.
\end{hypbox}
After.
`,
  };
  const known = new Set(Object.keys(files));
  const { sources } = await collectMacroSources({ filePath: "nb/sections/mm.tex", rootPath: "nb/main.tex", ownPreamble: "", known, readText: async (path) => files[path] ?? "", version: () => "1" });
  const { view, done } = mount(files["nb/sections/mm.tex"], 0, sources);
  const shown = squash(text(view));
  assert.ok(!shown.includes("\\begin{hypbox}") && !shown.includes("\\end{hypbox}"), shown);
  assert.match(shown, /Assume that the box is drawn as a box\./);
  assert.ok(view.contentDOM.querySelector(".cm-vis-box"), "the box's frame");
  done();
});

test("environments that only break lines or pages are transparent: sloppypar, samepage, hangparas (2611.11859, 2611.11400)", () => {
  const { view, done } = mount(String.raw`\begin{document}
\begin{sloppypar}
Sloppy words.
\end{sloppypar}
\begin{samepage}
Same page words.
\end{samepage}
\begin{hangparas}{3ex}{1}
Hanging words.
\end{hangparas}
Tail.
\end{document}
`);
  const shown = squash(text(view));
  for (const word of ["Sloppy words.", "Same page words.", "Hanging words.", "Tail."]) assert.ok(shown.includes(word), word);
  assert.ok(!/sloppypar|samepage|hangparas|3ex/.test(shown), shown);
  done();
});

test("TeX length and penalty assignments, sizes and page setup fold away; \\break breaks the line (2611.14059, 2611.11400, 2610.16732, 2611.12463, 2611.11859)", () => {
  const { view, done } = mount(String.raw`\begin{document}
\begin{enumerate}
\itemsep1pt
\parskip0pt
\item A comparison.
\end{enumerate}
\fontsize{7}{7.7}\selectfont
\predisplaypenalty=0\relax
\ifllncs\else\pagenumbering{roman}\fi
Assume that \break $g$ is positive.
\end{document}
`);
  const shown = squash(text(view));
  assert.match(shown, /A comparison\./);
  assert.ok(!/itemsep|parskip|fontsize|selectfont|predisplaypenalty|pagenumbering/.test(shown), shown);
  assert.ok(!shown.includes("\\break"), shown);
  assert.ok(view.contentDOM.querySelector(".cm-vis-linebreak"), "a break mark where \\break is");
  done();
});

test("\\detokenize writes its argument as it is, and a click opens the command (2611.14059)", () => {
  const source = String.raw`\begin{document}
Prompt \detokenize{{instruction}} here.
\end{document}
`;
  const { view, done } = mount(source);
  const literal = [...view.contentDOM.querySelectorAll(".cm-vis-symbol")].find((node) => node.textContent === "{instruction}");
  assert.ok(literal, squash(text(view)));
  assert.ok(!squash(text(view)).includes("\\detokenize"));
  click(literal!);
  assert.ok(squash(text(view)).includes("\\detokenize{{instruction}}"), "the command is shown as written");
  done();
});

test("groups that only scope layout fold away, the list of contents and the input they scope still drawn (2611.11566, 2611.13971)", () => {
  const source = String.raw`\begin{document}
{\hypersetup{linkcolor=black}\tableofcontents}
\section{Intro}
Words.
{\setlength{\tabcolsep}{3.5pt}\input{tables/ablation}}
{\setlength{\tabcolsep}{2pt}}
\end{document}
`;
  const { view, done } = mount(source);
  const shown = squash(text(view));
  assert.ok(view.contentDOM.querySelector(".cm-vis-contents, [class*='contents']"), "the list of contents is drawn");
  assert.ok(!/hypersetup|linkcolor|tabcolsep/.test(shown), shown);
  assert.match(shown, /Words\./);
  // The list of contents is a widget: a click opens its source line.
  const contents = view.contentDOM.querySelector(".cm-vis-contents, [class*='contents']");
  click(contents!);
  assert.ok(squash(text(view)).includes("\\hypersetup{linkcolor=black}"), "the group is shown as written");
  done();
});

test("array's \\newcolumntype in the body is a definition (2610.16732)", () => {
  const { view, done } = mount(String.raw`\begin{document}
Text.
\newcolumntype{L}[1]{>{\raggedright\arraybackslash}p{#1}}
\begin{tabular}{L{3cm}c}
a & b \\
\end{tabular}
\end{document}
`);
  const shown = squash(text(view));
  assert.ok(!shown.includes("newcolumntype") && !shown.includes("arraybackslash"), shown);
  done();
});

test("ifdraft's \\ifdraft{draft-only code}{} prints nothing in the final version (2611.07413)", () => {
  const { view, done } = mount(String.raw`\documentclass[11pt]{llncs}
\usepackage{ifdraft}
\begin{document}
\ifdraft{
	\special{dvipdfmx:config z 0}
	\listoffixmes
}{}
Visible words.
\end{document}
`);
  const shown = squash(text(view));
  assert.match(shown, /Visible words\./);
  assert.ok(!/ifdraft|special|listoffixmes/.test(shown), shown);
  done();
});
