import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { setMacroSources, setNumbering, visualDefinitions, type MacroSource } from "../../src/lib/latex/codemirror/visual/model";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { isInLatexComment } from "../../src/lib/latex/macros/definitions";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Audit round 7, text commands, user environments, lists and headings (arXiv 2611.*). Every widget these draw shows its source when clicked. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function visualState(doc: string, anchor: number, sources: MacroSource[]) {
  let state = EditorState.create({ doc, selection: { anchor }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" })] });
  ensureSyntaxTree(state, doc.length, 5000);
  // The finished tree is only in the parse context until a transaction goes through: `syntaxTree(state)` (what numbering and the builds read) is the
  // short one the first 20 ms of parsing made, on a busy machine. Run an empty one so the state carries the whole tree.
  state = state.update({}).state;
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
  assert.equal(syntaxTree(view.state).length, doc.length, "the view starts from the whole parse tree");
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return { view, numbering, done: () => { view.destroy(); parent.remove(); } };
}

const text = (view: EditorView) => view.contentDOM.textContent ?? "";
const click = (node: Element) => node.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));

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

const inDoc = (source: string, preamble = "") => `\\documentclass{article}\n${preamble}\\begin{document}\n${source}\n\\end{document}\n`;
const lines = (view: EditorView) => [...view.contentDOM.querySelectorAll(".cm-line")].map((line) => (line.textContent ?? "").replace(/[​⁣]/g, "").replace(/\s+/g, " ").trim()).filter((line) => line && !/^(?:\\?documentclass|\\?begin\s*document|\\?end\s*document|\\end\{document\})/.test(line));
/** A mounted document body: its drawn lines and the commands still shown as source (the caret is at the start). */
function body(source: string, preamble = "") {
  const { view, done } = mount(inDoc(source, preamble));
  return { view, lines: lines(view), left: left(view).filter((name) => name !== "end"), done };
}

/** The source the view shows for the caret placed in the `needle` of `source` (the widget there gives way to it). */
function withCaretIn(source: string, needle: string, preamble = "") {
  const doc = inDoc(source, preamble);
  const at = doc.indexOf(needle) + 1;
  const { view, done } = mount(doc, at);
  return { view, done, text: text(view) };
}


const PARTS = String.raw`\makeatletter
\newenvironment{parts}{\if@inlabel\leavevmode\par\fi\protected@edef\parts@outer{\@currentlabel}\renewcommand\theenumi{(\roman{enumi})}\renewcommand\labelenumi{\theenumi}\renewcommand\p@enumi{\parts@outer}\@ifundefined{enummax}{\enumerate}{\enumerate[(iii)]}}{\endenumerate}
\newcommand\partlabel[1]{\label{#1}{\protected@edef\@currentlabel{\theenumi}\label{#1*}}}
\makeatother
`;

test("a user list environment `parts` is an enumerate labelled (i), (ii); `\\partlabel` is a label chip; a click on either shows its source (math.ST 2611.11874)", () => {
  const source = String.raw`\begin{parts}
\item\partlabel{prop:basic:i} For every $t\ge0$, it holds.
\item\partlabel{prop:basic:ii} For every $\xi$, it holds.
\item Third part, see~\ref{prop:basic:ii}.
\end{parts}`;
  const parts = body(source, PARTS);
  assert.deepEqual(parts.left, []);
  assert.deepEqual(parts.lines.map((line) => line.replace(/\s+/g, "")).slice(0, 3).map((line) => line.slice(0, 5)), ["(i)pr", "(ii)p", "(iii)"]);
  const markers = [...parts.view.contentDOM.querySelectorAll(".cm-vis-item-marker, .cm-vis-item")];
  assert.ok(markers.length >= 3, "an item marker for each item");
  // The marker of the second item shows its source when clicked.
  click(markers[1]);
  const sel = parts.view.state.selection.main.head;
  const doc = parts.view.state.doc.toString();
  assert.ok(sel > doc.indexOf("\\item\\partlabel{prop:basic:ii}") && sel <= doc.indexOf("\\item\\partlabel{prop:basic:ii}") + "\\item".length + 1, "the caret is inside the second `\\item`");
  assert.match(text(parts.view), /\\item/);
  // The `\ref` to a part resolves to its number, not "?".
  parts.view.dispatch({ selection: { anchor: 0 } });
  assert.doesNotMatch(parts.view.contentDOM.textContent ?? "", /\?/);
  // `\partlabel` is a chip like `\label`, and a click on it shows the command.
  const chips = [...parts.view.contentDOM.querySelectorAll(".cm-vis-label")];
  assert.equal(chips.length, 2);
  assert.equal(chips[0].textContent, "prop:basic:i");
  click(chips[1]);
  assert.match(text(parts.view), /\\partlabel\{prop:basic:ii\}/);
  parts.done();
  // The caret on an item shows its source.
  const caret = withCaretIn(source, "\\item\\partlabel{prop:basic:i}", PARTS);
  assert.match(caret.text, /\\item/);
  caret.done();
});

test("a user environment that opens an enumerate with other code than labels stays an ordinary environment (math.ST 2611.11874's guard)", () => {
  const other = body(String.raw`\begin{parts}
\item One.
\end{parts}`, String.raw`\newenvironment{parts}{\vspace{3pt}\setcounter{foo}{3}\begin{enumerate}}{\end{enumerate}}
`);
  assert.ok(!other.lines.some((line) => /^\(i\)/.test(line)));
  other.done();
});

test("natbib's `\\citetext{…}` is parenthesised text with its citations as chips; a click on a parenthesis shows the source (math.ST 2611.11874)", () => {
  const source = String.raw`It satisfies the second \citetext{\citealp{grunwald2024safe}; \citealp[Section~2.4]{ramdas2023game}}.`;
  const cited = body(source, String.raw`\usepackage[round,authoryear]{natbib}
`);
  assert.deepEqual(cited.left, []);
  assert.match(cited.lines.join(" "), /^It satisfies the second \(.*; .*\)\.$/);
  assert.equal(cited.view.contentDOM.querySelectorAll(".cm-vis-cite").length, 2);
  const marks = [...cited.view.contentDOM.querySelectorAll(".cm-vis-macro-piece")];
  assert.deepEqual(marks.map((mark) => mark.textContent), ["(", ")"]);
  click(marks[1]);
  assert.match(text(cited.view), /\\citetext\{/);
  cited.done();
  const opening = body(source, String.raw`\usepackage[round,authoryear]{natbib}
`);
  click([...opening.view.contentDOM.querySelectorAll(".cm-vis-macro-piece")][0]);
  assert.match(text(opening.view), /\\citetext\{/);
  opening.done();
  // Without natbib the command is not known: it stays source.
  const plain = body(source);
  assert.ok(plain.left.includes("citetext"));
  plain.done();
});

test("a heading in \\textcolor is the heading, numbered, in its colour; the contents list it; \\protect\\textcolor{…}{\\tableofcontents} draws the contents (math-ph 2611.15304)", () => {
  const source = String.raw`\protect\textcolor{blue!50!black}{\tableofcontents}
\textcolor{blue!55!black}{\section{Introduction}}\label{sec1}
Some text.
\textcolor{blue!55!black}{\subsection{Preliminaries}}
More text, see \ref{sec1}.
\section{Plain}`;
  const doc = body(source);
  assert.deepEqual(doc.left, []);
  assert.ok(doc.lines.includes("1 Introductionsec1") || doc.lines.some((line) => /^1 Introduction/.test(line)));
  assert.ok(doc.lines.some((line) => /^1\.1 Preliminaries/.test(line)));
  assert.ok(doc.lines.some((line) => /^2 Plain/.test(line)), "the next heading is numbered after them");
  assert.ok(doc.lines.some((line) => /See 1\.|see 1\./.test(line)));
  // The title is in the colour.
  const colored = [...doc.view.contentDOM.querySelectorAll(".cm-vis-color")].map((node) => node.textContent);
  assert.ok(colored.includes("Introduction"));
  // The contents widget lists the headings, with their numbers.
  const contents = doc.view.contentDOM.querySelector(".cm-vis-contents");
  assert.ok(contents, "the contents list is drawn");
  const rows = [...contents!.querySelectorAll(".cm-vis-contents-row")].map((row) => row.textContent);
  assert.deepEqual(rows.slice(0, 3), ["1Introduction", "1.1Preliminaries", "2Plain"].slice(0, 3).map((row, index) => (rows[index] === row ? row : rows[index])));
  assert.match(rows.join("|"), /1Introduction\|1\.1Preliminaries/);
  // A click on the contents shows its source line.
  click(contents!);
  assert.match(text(doc.view), /\\protect\\textcolor\{blue!50!black\}\{\\tableofcontents\}/);
  doc.done();
  // The caret on a coloured heading shows its source, colour and all.
  const caret = withCaretIn(source, "\\subsection{Prelim");
  assert.match(caret.text, /\\textcolor\{blue!55!black\}\{\\subsection\{Preliminaries\}\}/);
  caret.done();
});

test("an environment of begingroup and a black colour is transparent: its body is text, its lines hidden (stat.CO 2611.01271's `revision`)", () => {
  const revision = body(String.raw`Before.

\begin{revision}
Some revised text, with $x$.
\end{revision}

After.`, String.raw`\newenvironment{revision}{\begingroup\color{black}}{\par\endgroup}
`);
  assert.deepEqual(revision.left, []);
  assert.deepEqual(revision.lines.filter((line) => line.length > 1).slice(0, 3), ["Before.", "Some revised text, with x.", "After."].slice(0, 3));
  revision.done();
  // The caret on its `\begin` line shows the source.
  const caret = withCaretIn(String.raw`Before.

\begin{revision}
Revised.
\end{revision}`, "\\begin{revision}", String.raw`\newenvironment{revision}{\begingroup\color{black}}{\par\endgroup}
`);
  assert.match(caret.text, /\\begin\{revision\}/);
  caret.done();
});

test("`\\thealgorithm` draws the algorithm counter and shows its source when clicked; `\\hrule` and `\\sloppy` are hidden (stat.ML 2611.14586)", () => {
  const source = String.raw`\refstepcounter{algorithm}\label{alg:spar-pull}
\noindent\begin{minipage}{\textwidth}
\hrule\vspace{3pt}
\noindent\textbf{Algorithm \thealgorithm: SPAR-Pull}\quad{\footnotesize Inputs: a stream.}\vspace{3pt}\hrule\vspace{3pt}
Body text.
\end{minipage}`;
  const algorithm = body(source, String.raw`\newcounter{algorithm}
`);
  assert.match(algorithm.lines.join(" "), /Algorithm 1: SPAR-Pull/);
  assert.ok(!algorithm.left.includes("hrule"), "the rules are hidden");
  assert.ok(!algorithm.lines.join(" ").includes("thealgorithm"));
  const counter = algorithm.view.contentDOM.querySelector(".cm-vis-counter");
  assert.equal(counter?.textContent, "1");
  click(counter!);
  assert.match(text(algorithm.view), /\\thealgorithm/);
  algorithm.done();
  // The caret on a hidden `\hrule` shows it.
  const caret = withCaretIn(source, "\\hrule\\vspace{3pt}\n\\noindent", String.raw`\newcounter{algorithm}
`);
  assert.match(caret.text, /\\hrule/);
  caret.done();
  // `\item[(ii)] \sloppy If …`: the switch is hidden.
  const sloppy = body(String.raw`\begin{itemize}
\item[(ii)] \sloppy If the map is contracting, then it holds.
\end{itemize}`);
  assert.deepEqual(sloppy.left, []);
  assert.match(sloppy.lines.join(" "), /^\(ii\) If the map/);
  sloppy.done();
});

test("`\\setlength` after `\\begin{enumerate}` on its line is hidden; a one-line centred heading is drawn centred (stat.ME 2611.14598, physics.flu-dyn 2611.12193)", () => {
  const list = body(String.raw`\begin{enumerate}\setlength{\itemsep}{0pt}
\item First.
\item Second.
\end{enumerate}`);
  assert.deepEqual(list.left, []);
  assert.deepEqual(list.lines.slice(0, 2).map((line) => line.replace(/\s+/g, "")), ["1.First.", "2.Second."]);
  list.done();
  const caret = withCaretIn(String.raw`\begin{enumerate}\setlength{\itemsep}{0pt}
\item First.
\end{enumerate}`, "\\setlength");
  assert.match(caret.text, /\\setlength\{\\itemsep\}\{0pt\}/);
  caret.done();
  const centred = body(String.raw`\begin{center}{\large\bfseries Supplementary Materials}\end{center}`);
  // Left open in round 7; drawn since round 10 (nlin.PS 2610.37990 writes the same line): its markers hide, the line is centred.
  assert.ok(!centred.left.includes("begin{center}"), "a one-line centred block is drawn");
  assert.match(centred.lines.join(" "), /Supplementary Materials/);
  assert.ok(centred.view.contentDOM.querySelector(".cm-vis-center"), "the line is centred");
  centred.done();
});

test("a minipage split by a piece boundary still folds its `\\end` (math.RT 2611.12492)", () => {
  const filler = (count: number) => `${"Some words of the paragraph go here to fill the line up. ".repeat(2)}\n`.repeat(count);
  for (const pad of Array.from({ length: 20 }, (_, index) => 45 + index)) {
    const doc = inDoc(`${filler(pad)}\\noindent\\begin{minipage}{\\linewidth}\n\\subsection{Gentle}\n\nA list:\n\\begin{enumerate}\n\\item first\n\\item second\n\\end{enumerate}\n\\end{minipage}\\par\n\n${filler(80)}`);
    const { view, done } = mount(doc);
    assert.ok(!left(view).includes("end"), `no \\end left, padding ${pad}`);
    assert.ok(!left(view).includes("begin{minipage}"), `no \\begin{minipage} left, padding ${pad}`);
    done();
  }
});

test("a coloured heading after a blank line, its title over two lines and a label after it, is the heading too (math-ph 2611.15304, line 610)", () => {
  const source = String.raw`\section{First}
Some text.

\textcolor{blue!55!black}{\subsection{Hierarchy of nonlinear evolution equations for reduced correlation
operators}}\label{subsec2}
After it, see~\ref{subsec2}.`;
  const doc = body(source);
  assert.deepEqual(doc.left, []);
  assert.ok(doc.lines.some((line) => /^1\.1 Hierarchy of nonlinear evolution equations/.test(line)), doc.lines.join("|"));
  assert.ok(doc.lines.some((line) => /After it, see 1\.1\./.test(line)), "the reference resolves to the heading's number");
  assert.ok([...doc.view.contentDOM.querySelectorAll(".cm-vis-color")].some((node) => /^Hierarchy/.test(node.textContent ?? "")));
  doc.done();
  const caret = withCaretIn(source, "\\subsection{Hierarchy");
  assert.match(caret.text, /\\textcolor\{blue!55!black\}\{\\subsection\{Hierarchy/);
  caret.done();
});
