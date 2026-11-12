import "./setup.cjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import fc from "fast-check";
import { JSDOM } from "jsdom";
import { history, undo } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { Compartment, EditorSelection, EditorState, Transaction, type Extension } from "@codemirror/state";
import { dispatchAsOneStep, undoBoundaries } from "../../src/lib/collab/undo-boundary";
import { canEditInMathLive } from "../../src/lib/latex/codemirror/visual/math-edit";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState, setNumberingStart, toggleLatexFormat, visualEntrySelection, visualRevealRanges } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField, LARGE_DOCUMENT } from "../../src/lib/latex/codemirror/visual/structural";
import { numberingField, preambleOpenField, setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";
import { macroAt, readLatexDefinitions } from "../../src/lib/latex/macros/definitions";
import { transparentPlan } from "../../src/lib/latex/codemirror/visual/transparent";
import { latexMathPreview } from "../../src/lib/latex/codemirror/preview";
import { setMacroSources } from "../../src/lib/latex/codemirror/visual/model";
import { showTooltip } from "@codemirror/view";
import { graphicsCandidates, isEditingCell, refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { citationText, plainTexText, stateReferenceText } from "../../src/lib/latex/codemirror/visual/references";
import { latexParser } from "../../src/lib/latex/codemirror/latex-parser";
import { parseAlgorithm2e, parseAlgorithmic } from "../../src/lib/latex/codemirror/visual/algorithm";
import { minimalChange, titleSources } from "../../src/lib/latex/codemirror/visual/title-edit";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

// LF, as the editor holds it: a Windows checkout may have written the fixture with CRLF.
const SAMPLE = readFileSync(path.join(__dirname, "fixtures/latex/visual-sample.tex"), "utf8").replace(/\r\n/g, "\n");

function extensions(extra: Extension[] = []) {
  return [history(), latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }), ...extra];
}

function stateFor(doc: string, extra: Extension[] = [], selection?: number) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  return EditorState.create({ doc, selection: selection === undefined ? undefined : { anchor: selection }, extensions: extensions(extra) });
}

function mount(doc: string, extra: Extension[] = [], selection?: number) {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({ state: stateFor(doc, extra, selection), parent });
}

/** Constructs as "kind:from:to", sorted: what the structural layer has built. */
function constructs(state: EditorState) {
  const list: string[] = [];
  state.field(structuralField).extents.between(0, state.doc.length, (from, to, mark) => { list.push(`${mark.kind}:${from}:${to}`); });
  return list.sort();
}

function kinds(state: EditorState) {
  const counts: Record<string, number> = {};
  state.field(structuralField).extents.between(0, state.doc.length, (_from, _to, mark) => { counts[mark.kind] = (counts[mark.kind] ?? 0) + 1; });
  return counts;
}

function revealedKinds(state: EditorState) {
  const value = state.field(structuralField);
  const out: string[] = [];
  value.extents.between(0, state.doc.length, (_from, _to, mark) => { if (value.revealed.has(mark.id)) out.push(mark.kind); });
  return out;
}

function at(view: EditorView, needle: string, offset = 0) {
  const index = view.state.doc.toString().indexOf(needle);
  assert.ok(index >= 0, `${needle} not found`);
  return index + offset;
}

function number(view: EditorView) {
  const state = view.state;
  // The whole tree, as the app numbers once the parser has caught up (under a loaded test run the parse may lag).
  const tree = ensureSyntaxTree(state, state.doc.length, 5000) ?? syntaxTree(state);
  const numbering = computeLatexNumbering(tree, (from, to) => state.doc.sliceString(from, to), visualDefinitions(state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
}

/* ---- Rendering ------------------------------------------------------------------ */

test("the sample draws every construct it recognises, and the file is not changed", () => {
  const view = mount(SAMPLE);
  assert.equal(view.state.doc.toString(), SAMPLE);
  assert.deepEqual(kinds(view.state), {
    preamble: 1, title: 1, "env-header": 6, "env-end": 5, "env-footer": 1, style: 6, math: 8, heading: 3, footnote: 1, symbol: 6,
    cite: 2, macro: 1, "macro-args": 1, "list-begin": 2, item: 4, "list-end": 2, ref: 6, figure: 2, "document-end": 1,
    // The verbatim block's `\begin` and `\end` lines fold (text round); its lines stay as written, in the code face.
    "code-begin": 1, "code-end": 1,
  });
  const content = view.contentDOM;
  assert.ok(content.querySelector(".cm-vis-preamble"), "the preamble folds into a block");
  assert.equal(content.querySelector(".cm-vis-title")?.textContent, "A Sample Paper");
  assert.equal(content.querySelectorAll(".cm-vis-author").length, 2);
  view.destroy();
});

test("chips and numbers follow the numbering", async () => {
  const view = mount(SAMPLE);
  number(view);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const text = (selector: string) => [...view.contentDOM.querySelectorAll(selector)].map((element) => element.textContent);
  assert.deepEqual(text(".cm-vis-heading-number"), ["1\u2002", "1.1\u2002", "2\u2002"]);
  // jsdom draws the first screen only; the rest is checked through the state.
  assert.equal(text(".cm-vis-ref")[0], "2");
  assert.deepEqual(text(".cm-vis-item"), ["•", "•", "1.", "2."]);
  const reference = (command: string, key: string) => stateReferenceText(view.state, command, [key]);
  assert.deepEqual([reference("\\eqref", "eq:energy"), reference("\\cref", "eq:first"), reference("\\ref", "thm:pyth"), reference("\\ref", "fig:plot"), reference("\\ref", "tab:results")], ["(1)", "eq. (2)", "2.1", "1", "1"]);
  // Scrolled into view, theorem headers, captions and equation numbers show their numbers.
  for (const needle of ["\\begin{theorem}", "\\begin{align}", "\\begin{figure}"]) {
    view.dispatch({ effects: EditorView.scrollIntoView(at(view, needle), { y: "start" }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  view.destroy();
});

test("a \\let alias of a citation command is drawn as a citation, the way its target cites", () => {
  const doc = String.raw`\documentclass{article}
\let\cite\textcite
\begin{document}
Extending the work of \cite{fearing2011evaluating}, and \citep{other}.
\end{document}
`;
  const view = mount(doc);
  assert.equal(kinds(view.state).cite, 2);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-cite").length, 2);
  view.destroy();
  const aux = { labels: {}, citations: { fearing2011evaluating: { label: "Fearing et al., 2011", authors: "Fearing et al.", year: "2011" } } };
  assert.equal(citationText({ command: "\\textcite", keys: ["fearing2011evaluating"] }, aux, () => null), "Fearing et al. (2011)");
});

test("a longtable is drawn as a numbered table: first head, body and last foot, with rows written through macros expanded", async () => {
  const doc = String.raw`\documentclass{article}
\begin{document}
\newcommand{\nrow}[2]{#1 & #2\\[4pt]%
}
\newcommand{\nsection}[1]{\addlinespace[5pt]\midrule\multicolumn{2}{@{}l}{\textit{#1}}\\*\addlinespace[4pt]}
\begin{longtable}{@{}p{0.2\linewidth}@{\hspace{10pt}}>{\raggedright\arraybackslash}p{0.7\linewidth}@{}}
  \caption{Notation.}\label{tab:notation}\\
  \toprule
  Symbol & Description\\
  \midrule
  \endfirsthead
  \multicolumn{2}{c}{(continued)}\\
  \endhead
  \multicolumn{2}{r}{Continued on next page}\\
  \endfoot
  \bottomrule
  \endlastfoot
  \nsection{Sets}
  \nrow{$F$}{Flights.}
  \nrow{$R$}
    {Windows.}
\end{longtable}
See Table~\ref{tab:notation}.
\end{document}
`;
  const view = mount(doc);
  number(view);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(kinds(view.state).table, 1);
  const figure = view.contentDOM.querySelector(".cm-vis-figure-table")!;
  assert.equal(figure.querySelector(".cm-vis-caption")?.textContent, "Table 1: Notation.");
  const rows = [...figure.querySelectorAll("tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim()));
  // The repeated head and the page foot are not drawn; the section row spans both columns.
  assert.deepEqual(rows, [["Symbol", "Description"], ["Sets"], ["F", "Flights."], ["R", "Windows."]]);
  assert.equal(figure.querySelector("table")?.dataset.readonly, "true");
  // \addlinespace is space, not a rule; the \midrule before the section is a rule.
  const sectionRow = figure.querySelectorAll("tr")[1];
  assert.ok(sectionRow.classList.contains("cm-vis-rule") && sectionRow.classList.contains("cm-vis-row-spaced"));
  assert.ok(!figure.querySelectorAll("tr")[2].classList.contains("cm-vis-rule"), "\\addlinespace draws no line");
  assert.equal(stateReferenceText(view.state, "\\ref", ["tab:notation"]), "1");
  // A click on a cell shows the longtable's source.
  figure.querySelectorAll("td")[2].dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
  assert.ok(revealedKinds(view.state).includes("table"));
  view.destroy();
});

test("a tabularx is a grid; with rows written through macros it is drawn from their expansion", () => {
  const doc = String.raw`\documentclass{article}
\begin{document}
\newcommand{\trow}[2]{#1 & #2\\}
\begin{tabularx}{\linewidth}{lX}
Name & Description \\
a & first \\
\end{tabularx}

\begin{tabularx}{\linewidth}{lX}
\trow{$b$}{second}
\trow{$c$}{third}
\end{tabularx}
\end{document}
`;
  const view = mount(doc);
  const tables = [...view.contentDOM.querySelectorAll(".cm-vis-tabular table")] as HTMLElement[];
  assert.equal(tables.length, 2);
  assert.equal(tables[0].dataset.readonly, undefined, "its own cells are edited in place");
  // Since the tables round a macro row is drawn from its expansion row by row, and the table is not read-only as a
  // whole: the macro rows' cells are marked as such (a click shows the call's source).
  assert.equal(tables[1].dataset.readonly, undefined);
  assert.equal(tables[1].querySelectorAll(".cm-vis-table-macro").length, 4);
  assert.deepEqual([...tables[1].querySelectorAll("tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim())), [["b", "second"], ["c", "third"]]);
  view.destroy();
});

test("a figure that draws another file (\\resizebox{…}{\\input{fig}}) shows its caption and a placeholder; \\textcircled is circled", () => {
  const doc = String.raw`\documentclass{article}
\begin{document}
\begin{figure}[t]
  \centering
  \resizebox{\linewidth}{!}{\input{fig_co_setting}}
  \caption{The CO scheme. \textcircled{\small 1} Commit. \textcircled{\small 2} Jitter.}
  \label{fig:co}
\end{figure}
Steps \textcircled{3} and {\small small} text.
\end{document}
`;
  const view = mount(doc);
  const figure = view.contentDOM.querySelector(".cm-vis-figure-figure")!;
  assert.ok(figure, "the figure is drawn");
  assert.equal(figure.querySelector(".cm-vis-figure-drawing-name")?.textContent, "fig_co_setting.tex");
  assert.match(figure.querySelector(".cm-vis-caption-text")?.textContent ?? "", /The CO scheme\. ① Commit\. ② Jitter\./);
  const line = [...view.contentDOM.querySelectorAll(".cm-line")].find((element) => element.textContent?.startsWith("Steps"))!;
  // A group opened by a size switch is drawn as its text: one size here.
  assert.equal(line.textContent, "Steps ③ and small text.");
  view.destroy();
});

/* ---- Real papers: floats, algorithms and older LaTeX (the audit against GAN, BERT, DDPM) ---- */

const PAPER = String.raw`\documentclass{article}
\newcolumntype{L}[1]{>{\raggedright\arraybackslash}p{#1}}
\newcommand{\bx}{\mathbf{x}}
\newcommand\bert{BERT\xspace}
\newtoggle{hq}
\togglefalse{hq}
\begin{document}
\section{Intro}
\begin{table*}[t]
\caption{Wide.}\label{tab:wide}
\begin{tabular*}{\textwidth}{l@{\extracolsep{\fill}}c}
A & {\bf 1} \tabularnewline
\end{tabular*}
\end{table*}

\begin{figure}[t]
\begin{minipage}[t]{0.5\textwidth}
\begin{algorithm}[H]
\caption{Training}\label{alg:training}
\begin{algorithmic}[1]
\Repeat
\State $\bx_0 \sim q$
\Until{converged}
\end{algorithmic}
\end{algorithm}
\end{minipage}\hfill
\begin{minipage}[t]{0.45\textwidth}
\captionof{table}{Results.}\label{tab:results}
\begin{tabular}{lL{2cm}}
\bert & \rlap{$^*$}x \\
\end{tabular}
\end{minipage}
\end{figure}

\begin{table}[t]
\begin{center}{\small
\begin{tabular}{lc}
a & b \\
\end{tabular}}
\end{center}
\caption{Grouped.}\label{tab:grouped}
\end{table}

\begin{figure}[h]
\centering
\includegraphics[width=0.75\textwidth]{\iftoggle{hq}{hq/x.pdf}{lq/x.png}}
\caption{\small{Toggled.} $\textsc{Base}$}\label{fig:toggled}
\end{figure}

\iffalse
\begin{figure}\caption{Hidden.}\label{fig:hidden}\end{figure}
\fi

\begin{align}
\label{eq:late} a &= b \nonumber \\
c &= \hat\bx_0
\end{align}

{\tt [CLS]} and {\bf bold}, as \newcite{devlin}.\footnotemark\footnotetext{Note.}

\begin{ack}
Thanks.
\end{ack}
\end{document}
`;

test("numbering follows starred floats, algorithms, \\captionof panels, \\iffalse and labels in \\nonumber rows", () => {
  const view = mount(PAPER);
  number(view);
  const ref = (key: string) => stateReferenceText(view.state, "\\ref", [key]);
  // table* is Table 1; the algorithm in a minipage is Algorithm 1; \captionof{table} in the other minipage is Table 2;
  // the hidden figure in \iffalse is not counted, so the toggled one is Figure 1; the label in a \nonumber row is the next row's.
  assert.deepEqual([ref("tab:wide"), ref("alg:training"), ref("tab:results"), ref("tab:grouped"), ref("fig:toggled"), ref("eq:late")], ["1", "1", "2", "3", "1", "1"]);
  assert.equal(stateReferenceText(view.state, "\\cref", ["alg:training"]), "algorithm 1");
  assert.ok(!view.state.field(numberingField).labels.has("fig:hidden"));
  view.destroy();
});

test("floats of real papers are drawn: table*, minipage panels with algorithms and \\captionof, grouped tables, toggled images", async () => {
  const view = mount(PAPER);
  number(view);
  const content = view.contentDOM;
  const scrollTo = async (needle: string) => {
    view.dispatch({ effects: EditorView.scrollIntoView(at(view, needle), { y: "start" }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await scrollTo("\\begin{table*}");
  const wide = content.querySelector(".cm-vis-figure-table")!;
  assert.equal(wide.querySelector(".cm-vis-caption")?.textContent, "Table 1: Wide.");
  // `\tabularnewline` ends the row; `{\bf 1}` is bold.
  assert.deepEqual([...wide.querySelectorAll("td")].map((td) => td.textContent?.trim()), ["A", "1"]);
  assert.ok(wide.querySelector("td .cm-vis-b"));
  await scrollTo("\\begin{figure}[t]");
  const panels = [...content.querySelectorAll(".cm-vis-figure-panel")];
  assert.equal(panels.length, 2);
  assert.equal(panels[0].querySelector(".cm-vis-caption")?.textContent, "Algorithm 1 Training");
  assert.deepEqual([...panels[0].querySelectorAll(".cm-vis-algorithm-line")].map((line) => line.textContent?.replace(/\s+/g, " ").trim()), ["1:repeat", "2:x0\u200b\u223cq", "3:until converged"]);
  assert.equal(panels[1].querySelector(".cm-vis-caption")?.textContent, "Table 2: Results.");
  // \xspace draws nothing; \rlap draws its content.
  assert.deepEqual([...panels[1].querySelectorAll("td")].map((td) => td.textContent?.trim()), ["BERT", "∗x"]);
  assert.ok(!panels[1].querySelector(".cm-vis-raw"));
  await scrollTo("\\begin{table}[t]");
  assert.ok([...content.querySelectorAll(".cm-vis-caption")].some((caption) => caption.textContent === "Table 3: Grouped."), "a tabular in {\\small …} is drawn");
  await scrollTo("\\begin{figure}[h]");
  const toggled = [...content.querySelectorAll(".cm-vis-figure-figure")].find((figure) => figure.textContent?.includes("Toggled"))!;
  assert.match(toggled.querySelector(".cm-vis-caption")?.textContent ?? "", /^Figure 1: Toggled\. /);
  assert.ok(!toggled.querySelector(".cm-vis-raw"), "\\small{…} and \\textsc in math draw");
  view.destroy();
});

test("\\iffalse … \\fi is faded source with nothing in it drawn; old font switches, \\newcite, \\footnotetext and ack draw", async () => {
  const view = mount(PAPER);
  const kindsAt = (needle: string) => { const pos = at(view, needle); const out: string[] = []; view.state.field(structuralField).extents.between(pos, pos + 1, (_from, _to, mark) => { out.push(mark.kind); }); return out; };
  // Nothing in it is drawn (no figure), and its lines are faded.
  assert.deepEqual(kindsAt("\\caption{Hidden.}"), ["disabled"]);
  view.dispatch({ effects: EditorView.scrollIntoView(at(view, "\\iffalse"), { y: "center" }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const hidden = [...view.contentDOM.querySelectorAll(".cm-line")].find((element) => element.textContent?.includes("Hidden."))!;
  assert.ok(hidden.classList.contains("cm-vis-disabled"));
  view.dispatch({ effects: EditorView.scrollIntoView(at(view, "{\\tt [CLS]}"), { y: "center" }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const line = [...view.contentDOM.querySelectorAll(".cm-line")].find((element) => element.textContent?.includes("[CLS]"))!;
  assert.equal(line.querySelector(".cm-vis-tt")?.textContent, "[CLS]");
  assert.equal(line.querySelector(".cm-vis-b")?.textContent, "bold");
  assert.ok(line.querySelector(".cm-vis-cite"), "\\newcite is a citation chip");
  assert.equal(line.querySelector(".cm-vis-footnote")?.textContent, "Note.");
  assert.ok([...view.contentDOM.querySelectorAll(".cm-vis-env-title")].some((title) => title.textContent === "Acknowledgments"));
  // `\hat\bx_0` is a formula: the macro's expansion is the accent's argument.
  assert.ok(kindsAt("\\begin{align}").includes("math"));
  view.destroy();
});

test("edits around \\iffalse, font switches and floats build the same constructs as a fresh build", () => {
  const pieces = ["\\iffalse", "\\fi", "\\else", "{\\bf x}", "{\\tt [A]}", "{", "}", "\\begin{table*}", "\\end{table*}", "\\caption{c}", "\n\n", "\\State x", "\\begin{minipage}{1cm}", "\\end{minipage}"];
  const start = PAPER.indexOf("\\begin{document}") + 17;
  fc.assert(fc.property(fc.array(fc.record({ at: fc.nat(), remove: fc.nat({ max: 5 }), insert: fc.constantFrom(...pieces) }), { maxLength: 5 }), (edits) => {
    const view = mount(PAPER);
    try {
      for (const edit of edits) {
        const length = view.state.doc.length;
        const from = start + (edit.at % Math.max(1, length - start - 16));
        const to = Math.min(length - 16, from + edit.remove);
        view.dispatch({ changes: { from, to: Math.max(from, to), insert: edit.insert } });
        ensureSyntaxTree(view.state, view.state.doc.length, 5000);
        view.dispatch({});
      }
      assert.deepEqual(constructs(view.state), constructs(stateFor(view.state.doc.toString())));
    } finally {
      view.destroy();
    }
  }), { numRuns: 40 });
});

test("algorithmic bodies of both packages are read into indented, numbered lines", () => {
  const caps = parseAlgorithmic(String.raw`
\REQUIRE data
\FOR{each $x$}
  \IF{$x > 0$} \STATE keep \COMMENT{positive}
  \ELSE \STATE drop
  \ENDIF
\ENDFOR
\RETURN $y$`, "1")!;
  assert.deepEqual(caps.lines.map((line) => [line.depth, line.lead ?? "", line.text, line.trail ?? "", line.comment ?? "", line.numbered]), [
    [0, "Require:", "data", "", "", false],
    [0, "for", "each $x$", "do", "", true],
    [1, "if", "$x > 0$", "then", "", true],
    [2, "", "keep", "", "positive", true],
    [1, "else", "", "", "", true],
    [2, "", "drop", "", "", true],
    [1, "end if", "", "", "", true],
    [0, "end for", "", "", "", true],
    [0, "return", "$y$", "", "", true],
  ]);
  const pseudo = parseAlgorithmic(String.raw`\label{alg} \vspace{1pt} \Function{Train}{$D$} \State \Return $m$ \EndFunction`, null)!;
  assert.deepEqual(pseudo.lines.map((line) => [line.depth, line.lead, line.text]), [[0, "function", String.raw`\textsc{Train}($D$)`], [1, "return", "$m$"], [0, "end function", ""]]);
  assert.equal(pseudo.numberEvery, 0);
  // algorithm2e is not read: left as source.
  assert.equal(parseAlgorithmic(String.raw`\KwIn{x} \eIf{a}{b}{c}`, null), null);
});

test("the parser reads a file path argument with groups (\\iftoggle) as one argument", () => {
  const tree = latexParser.parse(String.raw`\begin{figure}\includegraphics{\iftoggle{hq}{a.pdf}{b.pdf}}\caption{C}\end{figure}`);
  let caption: string | null = null;
  tree.iterate({ enter: (ref) => { if (ref.name === "Caption") { for (let parent = ref.node.parent; parent; parent = parent.parent) if (parent.name === "FigureEnvironment") caption = "inside"; } } });
  assert.equal(caption, "inside");
  // A path being typed (an unclosed group) ends at the first `}`, as before: it does not swallow the file.
  const typing = latexParser.parse(String.raw`\includegraphics{a{b}` + "\n\nText \\textbf{x}");
  let bold = false;
  typing.iterate({ enter: (ref) => { if (ref.name === "TextBoldCommand") bold = true; } });
  assert.ok(bold);
});

/* ---- Real papers, second batch (the audit against ResNet, Neural ODE, ViT) ---- */

const PAPER2 = String.raw`\documentclass{article}
\usepackage{cvpr}
\newcommand{\tr}{\textnormal{tr}}
\newcommand{\blocka}[2]{\multirow{2}{*}{$\left[\text{3$\times$3, #1}\right]$$\times$#2}}
\newcommand{\nfwidth}{0.3\linewidth}
\begin{document}
\section{Method}\label{sec:method}
\begin{align}
\frac{\partial z}{\partial t} &= -\tr\left(\frac{\partial f}{\partial z}\right) \textnormal{ if $t > 0$} \label{eq:trace}
\end{align}
with $\nicefrac{\partial L}{\partial z}$ and $\mathcal{L}_{\ref{eq:trace}}$, \eg here.

\begin{figure}[t]
\centering
\begin{subfigure}{0.3\linewidth}
\includegraphics[width=\linewidth]{a.png}
\caption{Left.}\label{fig:left}
\end{subfigure}
\begin{subfigure}{0.3\linewidth}
\includegraphics[width=\linewidth]{b.png}
\caption*{}
\end{subfigure}
\begin{subfigure}{\nfwidth}
\includegraphics[width=\linewidth]{c.png}
\caption{Right.}\label{fig:right}
\end{subfigure}
\caption{Both.}\label{fig:both}
\end{figure}

\begin{table}[t]
\centering
\resizebox{0.7\linewidth}{!}{
\begin{tabular}{c|c}
% the stages
layer & output \\
\hline
conv2 & \blocka{64}{2} \\
 & \\
\end{tabular}
}
\caption{Architectures.}\label{tab:arch}
\vspace{1em}
\begin{tabular}{lc}
\raisebox{0.5pt}{\tikz\fill[blue] (0,0) circle (.5ex);} Natural\vspace{2pt} & \begin{tabular}{c}a\\b\end{tabular} \\
\end{tabular}
\caption{Transfer.}\label{tab:transfer}
\end{table}

\begin{appendices}
\section{Proofs}\label{app:proofs}
\begin{equation}\label{eq:app}x\end{equation}
\end{appendices}
\end{document}
`;
const PAPER2_PACKAGE = { path: "nb/cvpr.sty", text: String.raw`\DeclareRobustCommand\onedot{\futurelet\@let@token\@onedot}
\def\@onedot{\ifx\@let@token.\else.\null\fi\xspace}
\def\eg{\emph{e.g}\onedot}`, loadedBy: "", key: "package:cvpr", version: "1" };

function mountPaper2() {
  const view = mount(PAPER2);
  view.dispatch({ effects: setMacroSources.of([PAPER2_PACKAGE]) });
  return view;
}
const scrollTo = async (view: EditorView, needle: string) => {
  view.dispatch({ effects: EditorView.scrollIntoView(at(view, needle), { y: "start" }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
};

test("numbering follows subcaption's sub-figures (letters, \\caption* skipped), two tables in one float and appendices", () => {
  const view = mountPaper2();
  number(view);
  const ref = (key: string) => stateReferenceText(view.state, "\\ref", [key]);
  // The sub-figures are captioned before their figure: 1a, then 1b (the \caption* one has no letter).
  // The second caption in one table is Table 2. `appendices` letters its sections; equations go on (article).
  assert.deepEqual(["fig:left", "fig:right", "fig:both", "tab:arch", "tab:transfer", "app:proofs", "eq:app"].map(ref), ["1a", "1b", "1", "1", "2", "A", "2"]);
  view.destroy();
});

test("floats of the second batch draw: sub-figure panels, tables in \\resizebox, \\multirow through a macro, stacked captions, nested tabulars", async () => {
  const view = mountPaper2();
  number(view);
  const content = view.contentDOM;
  await scrollTo(view, "\\begin{figure}");
  const figure = content.querySelector(".cm-vis-figure-figure")!;
  // Each sub-figure is a panel with its letter; `\caption*{}` shows nothing; the figure's own caption is below them.
  assert.deepEqual([...figure.querySelectorAll(".cm-vis-figure-panel")].map((panel) => panel.querySelector(".cm-vis-caption")?.textContent ?? null), ["(a) Left.", null, "(b) Right."]);
  assert.equal(figure.querySelectorAll(".cm-vis-figure-image").length, 3);
  assert.equal(figure.lastElementChild?.textContent, "Figure 1: Both.");
  await scrollTo(view, "\\begin{table}");
  const table = content.querySelector(".cm-vis-figure-table")!;
  // Two captions without minipages: two parts, one above the other.
  assert.ok(table.querySelector(".cm-vis-figure-panels-stacked"));
  assert.deepEqual([...table.querySelectorAll(".cm-vis-caption")].map((caption) => caption.textContent), ["Table 1: Architectures.", "Table 2: Transfer."]);
  const cells = [...table.querySelectorAll("td")].map((td) => [td.textContent?.replace(/[\u200b\u2063]/g, "").replace(/\s+/g, " ").trim(), (td as HTMLTableCellElement).rowSpan]);
  // The comment line before the first row is not a cell; `\blocka` writes a \multirow, which covers the empty cell below;
  // `\vspace` in a cell draws nothing, a TikZ swatch is a square; a tabular in a cell is a grid in it.
  assert.deepEqual(cells, [["layer", 1], ["output", 1], ["conv2", 1], ["[3×3, 64]×2", 2], ["", 1], ["■ Natural", 1], ["ab", 1], ["a", 1], ["b", 1]]);
  assert.equal(table.querySelectorAll(".cm-vis-table-nested").length, 1);
  assert.ok(!table.querySelector(".cm-vis-raw"));
  view.destroy();
});

test("formulas of the second batch: \\textnormal with $ inside align, \\nicefrac, and \\ref in math following numbering; cvpr's \\eg", async () => {
  // The `$` inside \textnormal does not end the align: the parser reads its argument as text.
  const tree = latexParser.parse(String.raw`\begin{align}a &= b \textnormal{ if $t > 0$} \\ c &= d\end{align}`);
  let errors = 0;
  let mathText = 0;
  tree.iterate({ enter: (node) => { if (node.type.isError) errors++; if (node.name === "MathTextCommand") mathText++; } });
  assert.deepEqual([errors, mathText], [0, 1]);
  const view = mountPaper2();
  assert.equal(kinds(view.state).math, 4, "the align, two inline formulas and the appendix's equation");
  await scrollTo(view, "with $");
  const line = () => [...view.contentDOM.querySelectorAll(".cm-line")].find((element) => element.textContent?.startsWith("with"))!;
  // Before numbering, the reference is unknown; once numbered, the formula is drawn again with its number.
  assert.match(line().textContent ?? "", /L\?/);
  number(view);
  assert.equal(line().textContent?.replace(/\u200b/g, ""), "with ∂L/∂z and L1, e.g. here.");
  view.destroy();
});

test("heading numbers stay right when scrolling reuses a heading's drawing for another heading", async () => {
  const view = mountPaper2();
  try {
    number(view);
    // A heading's line: its number, title and label chip.
    const heading = (title: string) => [...view.contentDOM.querySelectorAll(".cm-line")].map((line) => line.textContent ?? "").find((text) => text.includes(title));
    await scrollTo(view, "\\section{Method}");
    assert.match(heading("Method") ?? "", /^1\sMethod/);
    await scrollTo(view, "\\begin{appendices}");
    assert.match(heading("Proofs") ?? "", /^A\sProofs/);
  } finally {
    view.destroy();
  }
});

test("a package's font machinery (\\def\\small{…\\small…}) is LaTeX's own command; \\xspace spaces before a word, not before punctuation", async () => {
  const doc = String.raw`\documentclass{article}
\usepackage{naacl}
\newcommand\bertbase{BERT$_{\small \textsc{BASE}}$\xspace}
\begin{document}
Using the \bertbase architecture, as \bertbase.

\begin{tabular}{l}
\bertbase (Single) \\
\end{tabular}
\end{document}
`;
  const view = mount(doc);
  try {
    view.dispatch({ effects: setMacroSources.of([{ path: "nb/naacl.sty", text: String.raw`\def\small{\@setsize\small{10pt}\ixpt\@ixpt}`, loadedBy: "", key: "package:naacl", version: "1" }]) });
    assert.ok(!visualDefinitions(view.state).macros.has("small"));
    await scrollTo(view, "Using");
    const clean = (text: string | null | undefined) => (text ?? "").replace(/[​⁣]/g, "").replace(/\s+/g, " ").trim();
    const line = [...view.contentDOM.querySelectorAll(".cm-line")].find((element) => element.textContent?.startsWith("Using"))!;
    assert.equal(clean(line.textContent), "Using the BERTBASE architecture, as BERTBASE.");
    assert.ok(!view.contentDOM.querySelector(".cm-vis-raw"));
    assert.equal(clean(view.contentDOM.querySelector("td")?.textContent), "BERTBASE (Single)");
  } finally {
    view.destroy();
  }
});

test("edits around sub-figures, references in formulas and \\multirow cells build the same constructs as a fresh build", () => {
  const pieces = ["\\begin{subfigure}{1cm}", "\\end{subfigure}", "\\caption*{}", "\\caption{c}", "$\\ref{eq:trace}$", "$", "\\multirow{2}{*}{x}", " & ", "\\\\", "\\textnormal{ $t$}", "{", "}", "\n\n"];
  const start = PAPER2.indexOf("\\begin{document}") + 17;
  fc.assert(fc.property(fc.array(fc.record({ at: fc.nat(), remove: fc.nat({ max: 5 }), insert: fc.constantFrom(...pieces) }), { maxLength: 5 }), (edits) => {
    const view = mountPaper2();
    try {
      for (const edit of edits) {
        const length = view.state.doc.length;
        const from = start + (edit.at % Math.max(1, length - start - 16));
        const to = Math.min(length - 16, from + edit.remove);
        view.dispatch({ changes: { from, to: Math.max(from, to), insert: edit.insert } });
        ensureSyntaxTree(view.state, view.state.doc.length, 5000);
        view.dispatch({});
      }
      const reference = stateFor(view.state.doc.toString()).update({ effects: setMacroSources.of([PAPER2_PACKAGE]) }).state;
      assert.deepEqual(constructs(view.state), constructs(reference));
    } finally {
      view.destroy();
    }
  }), { numRuns: 40 });
});

/* ---- Real papers, third batch (the audit against Attention Is All You Need, GCN, LoRA) ---- */

const PAPER3 = String.raw`\documentclass{article}
\usepackage[ruled,vlined,linesnumbered]{algorithm2e}
\usepackage{subcaption,makecell,xcolor}
\definecolor{myred1}{RGB}{89, 10, 10}
\colorlet{accent}{myred1}
\begin{document}
\begin{center}
    \color{red}
    Provided proper attribution is provided.
\end{center}
\section{Model}
\begin{algorithm}[H]
\SetKwFunction{Hash}{hash}
\KwIn{Initial coloring $h^{(0)}$}
\KwOut{Final coloring $h^{(T)}$}
t $\leftarrow$ 0\;
\Repeat{stable node coloring is reached}{
  \For{$v_i \in \mathcal{V}$}{
    $h_i \leftarrow$ \Hash{$h_j$}\; \tcp*{neighbours}
  }
  \eIf{$t > 9$}{\KwRet{$h$}\;}{$t \leftarrow t+1$\;}
}
\caption{{\bf WL-1 algorithm} \label{alg:wl1}}
\end{algorithm}

\begin{figure}[htbp]
\centering
\begin{subfigure}[b]{0.45\textwidth}
\includegraphics[width=\textwidth]{citeseer.pdf}
\label{fig:depth-a}
\end{subfigure}
\caption{Depth.}\label{fig:depth}
\end{figure}

\begin{table}[h]
\footnotesize
\addtolength{\tabcolsep}{-1pt}
\centering
\begin{tabular}{lll}
\rule{0pt}{2.0ex}Model & BLEU & Cost \\
\multirow{2}{*}{\makecell{RoBERTa base \\ LoRA}} \
& \textcolor{myred1}{+2.2\%} & \boldmath$3.3\cdot 10^{18}$ \\
\end{tabular}
\caption{Results.}\label{tab:results}
\end{table}

\begin{thebibliography}{10}

\bibitem{layernorm2016}
Jimmy~Lei Ba, Jamie~Ryan Kiros, and Geoffrey~E Hinton.
\newblock Layer normalization.
\newblock {\em arXiv preprint arXiv:1607.06450}, 2016.

% \bibitem{hidden}
\bibitem[BZ]{britz2017}
Denny Britz.
\newblock {\em CoRR}, abs/1703.03906, 2017.

\bibitem{cho2014}
Kyunghyun Cho.
\end{thebibliography}
\end{document}
`;

test("algorithm2e bodies are read into lines: blocks as arguments, statements ending with \\;, the document's keywords", () => {
  const spec = parseAlgorithm2e(String.raw`\SetKwFunction{FMain}{Main}\SetKwProg{Fn}{Function}{:}{end}\SetKwInOut{Input}{input}
\Input{$G$}
\Fn{\FMain{$x$}}{
  \uIf{$x > 0$}{\Return{$x$}\;}
  \Else{\lFor{$i$}{skip}}
}
t $\leftarrow$ 0\; \tcc{counter}
\BlankLine
\While{$t < 3$}{$t \gets t + 1$\;}`, { numbered: false, ends: true })!;
  assert.deepEqual(spec.lines.map((line) => [line.depth, line.lead ?? "", line.text, line.trail ?? "", line.comment ?? "", line.numbered]), [
    [0, "input:", "$G$", "", "", false],
    [0, "Function", String.raw`\textsc{Main}($x$):`, "", "", true],
    [1, "if", "$x > 0$", "then", "", true],
    [2, "", String.raw`\textbf{return} $x$`, "", "", true],
    [1, "else", "", "", "", true],
    [2, "for", String.raw`$i$ \textbf{do} skip`, "", "", true],
    [1, "end", "", "", "", true],
    [0, "end", "", "", "", true],
    // `\tcc{…}` is a comment line of its own; `\tcp*{…}` (below) is a side comment.
    [0, "", String.raw`t $\leftarrow$ 0`, "", "", true],
    [0, "", "", "", "counter", true],
    [0, "while", "$t < 3$", "do", "", true],
    [1, "", String.raw`$t \gets t + 1$`, "", "", true],
    [0, "end", "", "", "", true],
  ]);
  assert.equal(spec.numberEvery, 0);
  // algpseudocode's statements, or anything else it does not know, leave it as source.
  assert.equal(parseAlgorithm2e(String.raw`\State x`, { numbered: false, ends: true }), null);
  assert.equal(parseAlgorithm2e(String.raw`\For{a}{b`, { numbered: false, ends: true }), null);
});

test("third batch: an algorithm2e float, a bibliography, colours, struts and a caption-less sub-figure label", async () => {
  const view = mount(PAPER3);
  try {
    number(view);
    // A label in a sub-figure without a caption refers to nothing, as in LaTeX ("??"); the others as usual.
    const labels = view.state.field(numberingField).labels;
    assert.ok(!labels.has("fig:depth-a"));
    assert.deepEqual(["alg:wl1", "fig:depth", "tab:results"].map((key) => stateReferenceText(view.state, "\\ref", [key])), ["1", "1", "1"]);
    const content = view.contentDOM;
    const clean = (text: string | null | undefined) => (text ?? "").replace(/[​⁣]/g, "").replace(/\s+/g, " ").trim();
    // `\color{red}` colours the rest of its environment.
    await scrollTo(view, "\\begin{center}");
    const colored = [...content.querySelectorAll<HTMLElement>(".cm-vis-color")].find((element) => element.textContent?.includes("Provided"));
    assert.ok(colored && /color/.test(colored.getAttribute("style") ?? ""));
    // algorithm2e: ruled, so the caption is on top; lines numbered (linesnumbered), vlined, so no "end".
    await scrollTo(view, "\\begin{algorithm}");
    const algorithm = content.querySelector(".cm-vis-figure-algorithm")!;
    assert.equal(clean(algorithm.querySelector(".cm-vis-caption")?.textContent), "Algorithm 1 WL-1 algorithm");
    assert.ok(algorithm.firstElementChild?.classList.contains("cm-vis-caption"));
    assert.deepEqual([...algorithm.querySelectorAll(".cm-vis-algorithm-line")].map((line) => clean(line.textContent)), [
      "Input: Initial coloring h(0)", "Output: Final coloring h(T)", "1:t ← 0", "2:repeat", "3:for vi∈V do", "4:hi← hash(hj)▷ neighbours",
      "5:if t>9 then", "6:return h", "7:else", "8:t←t+1", "9:until stable node coloring is reached",
    ]);
    // Struts draw nothing, document colours colour, a control space at a cell's end is a space, \boldmath is bold.
    await scrollTo(view, "\\begin{table}");
    const table = content.querySelector(".cm-vis-figure-table")!;
    assert.ok(!table.querySelector(".cm-vis-raw"));
    assert.deepEqual([...table.querySelectorAll("td")].map((td) => clean(td.textContent)), ["Model", "BLEU", "Cost", "RoBERTa base LoRA", "+2.2%", "3.3⋅1018"]);
    assert.match(table.querySelector<HTMLElement>(".cm-vis-color")?.getAttribute("style") ?? "", /rgb\(89, ?10, ?10\)/);
    assert.ok(table.querySelector("td .cm-vis-b .katex"));
    // The bibliography: a heading, [n] markers (a comment's \bibitem is not counted), labels it gives, styled parts.
    await scrollTo(view, "\\begin{thebibliography}");
    assert.ok([...content.querySelectorAll(".cm-line.cm-vis-heading")].some((line) => clean(line.textContent) === "References"));
    assert.deepEqual([...content.querySelectorAll(".cm-vis-bibliography .cm-vis-item")].map((marker) => marker.textContent), ["[1]", "[BZ]", "[3]"]);
    const entry = [...content.querySelectorAll(".cm-line")].find((line) => line.textContent?.includes("arXiv preprint"))!;
    assert.equal(clean(entry.textContent), "arXiv preprint arXiv:1607.06450, 2016.");
    assert.equal(entry.querySelector(".cm-vis-em")?.textContent, "arXiv preprint arXiv:1607.06450");
  } finally {
    view.destroy();
  }
});

test("edits around bibliographies, algorithm2e bodies and colour switches build the same constructs as a fresh build", () => {
  const pieces = ["\\bibitem{k}", "\\bibitem[L]{k}", "\\newblock ", "{\\em x}", "%", "\\;", "\\For{a}{", "}", "{", "\\color{red}", "\\KwIn{x}", "\\end{thebibliography}", "\n\n"];
  const start = PAPER3.indexOf("\\begin{document}") + 17;
  fc.assert(fc.property(fc.array(fc.record({ at: fc.nat(), remove: fc.nat({ max: 5 }), insert: fc.constantFrom(...pieces) }), { maxLength: 5 }), (edits) => {
    const view = mount(PAPER3);
    try {
      for (const edit of edits) {
        const length = view.state.doc.length;
        const from = start + (edit.at % Math.max(1, length - start - 16));
        const to = Math.min(length - 16, from + edit.remove);
        view.dispatch({ changes: { from, to: Math.max(from, to), insert: edit.insert } });
        ensureSyntaxTree(view.state, view.state.doc.length, 5000);
        view.dispatch({});
      }
      assert.deepEqual(constructs(view.state), constructs(stateFor(view.state.doc.toString())));
    } finally {
      view.destroy();
    }
  }), { numRuns: 40 });
});

/* ---- Real papers, fourth batch (the audit against VAE, Batch Normalization, Bahdanau et al.) ---- */

const PAPER4 = String.raw`\documentclass{article}
\usepackage{amsmath,algorithmic,stackengine,ulem}
\newcommand{\eqnr}{\addtocounter{equation}{1}\tag{\theequation}}
\newcommand{\vxhat}{\widehat\mathrm{x}}
\newcommand{\norig}{\text{\sl N}}
\newcommand{\comt}{// }
\begin{document}
\section{Method}
\begin{equation}a = b\label{eq:first}\end{equation}
\begin{align*}
\log p(x) &\geq \mathcal{L}
\eqnr\label{eq:bound}\\
&= c
\end{align*}
Here $\vxhat$ is $\norig$, and $\left[ \mbox{UNK} \right]$, as in \uline{to carry out}, {\tt {\small hairy $\rightarrow$ [MASK]}}.
\begin{quote}
    \it
Un privil\`ege d'admission.
\end{quote}
{    \it Ce genre d'exp\'erience.}
\begin{flalign*}
  \mu &\leftarrow \frac{1}{m} &\text{\comt mean}&
\end{flalign*}

\begin{algorithm}
\caption{Batch Normalizing Transform}\label{alg:bn}
\begin{algorithmic}
\ENSURE $y_i$
\begin{flalign*}
  \mu &\leftarrow \frac{1}{m}\sum_i x_i &\text{\comt mean}&
\end{flalign*}
\STATE $\norig\leftarrow \norig$ \quad \COMMENT Training BN network
\end{algorithmic}
\end{algorithm}

\begin{table}[h]
\centering
\begin{tabular}{ll}
{\bf type} & {\bf \stackanchor{patch size/}{stride}} \\
\sl BN-x5 & 73.0 \\
\end{tabular}
\caption{Inception.}\label{tab:inception}
\end{table}
\end{document}
`;
/** stackengine.sty's definitions are box arithmetic: the editor draws its stacks itself. */
const PAPER4_PACKAGE = { path: "nb/stackengine.sty", text: String.raw`\newcommand*\stackanchor[3][\stackgap]{%
  \setlength{\stack@tmplength}{#1}%
  \stackengine{\stack@tmplength}{#2}{#3}{O}{c}{F}{T}{S}}`, loadedBy: "", key: "package:stackengine", version: "1" };

test("fourth batch: rows numbered by hand (\\addtocounter … \\tag{\\theequation}) are numbered as LaTeX numbers them", async () => {
  const view = mount(PAPER4);
  try {
    number(view);
    assert.deepEqual(["eq:first", "eq:bound"].map((key) => stateReferenceText(view.state, "\\ref", [key])), ["1", "2"]);
    await scrollTo(view, "\\begin{align*}");
    // The align* is drawn, its hand-numbered row with a number slot filled by the numbering pass, the other row without.
    const formula = [...view.contentDOM.querySelectorAll(".cm-vis-math-display")].find((element) => element.getAttribute("aria-label")?.includes("eqnr"))!;
    assert.ok(formula, "the align* with \\eqnr is drawn");
    assert.deepEqual([...formula.querySelectorAll(".eqn-num")].map((slot) => slot.getAttribute("data-vis-num")), ["2"]);
  } finally {
    view.destroy();
  }
});

test("fourth batch: KaTeX-only gaps, font switches in environments, ulem, stacks, flalign and unbraced \\COMMENT", async () => {
  const view = mount(PAPER4);
  try {
    view.dispatch({ effects: setMacroSources.of([PAPER4_PACKAGE]) });
    number(view);
    const content = view.contentDOM;
    const clean = (text: string | null | undefined) => (text ?? "").replace(/[​⁣]/g, "").replace(/\s+/g, " ").trim();
    await scrollTo(view, "Here $");
    const line = [...content.querySelectorAll(".cm-line")].find((element) => element.textContent?.startsWith("Here"))!;
    // `\widehat\mathrm{x}` (an accent's unbraced argument), `\text{\sl N}` and `\mbox` in a formula are drawn; so is
    // one in `{\tt {\small …}}`, where the parser makes the inner group the switch's argument (BERT).
    assert.equal(line.querySelectorAll(".cm-vis-math").length, 4);
    assert.ok(line.querySelector(".cm-vis-tt .cm-vis-math"));
    assert.equal(line.querySelector(".cm-vis-u")?.textContent, "to carry out");
    // A font switch alone in an environment styles the rest of it; one after spaces in a group styles the group.
    const italic = [...content.querySelectorAll(".cm-vis-i")].map((element) => clean(element.textContent));
    assert.ok(italic.includes("Un privilège d'admission."), JSON.stringify(italic));
    assert.ok(italic.includes("Ce genre d'expérience."), JSON.stringify(italic));
    // flalign, which KaTeX lacks, is drawn as align.
    assert.ok(kinds(view.state).math >= 6);
    await scrollTo(view, "\\begin{algorithm}");
    const algorithm = content.querySelector(".cm-vis-figure-algorithm")!;
    const lines = [...algorithm.querySelectorAll(".cm-vis-algorithm-line")];
    // A displayed formula in a statement is drawn; `\COMMENT text` without braces is the line's comment.
    assert.ok(lines[0].querySelector(".cm-vis-fragment-display .katex"));
    assert.ok(!algorithm.querySelector(".cm-vis-raw"));
    assert.equal(clean(lines[1].querySelector(".cm-vis-algorithm-comment")?.textContent), "▷ Training BN network");
    await scrollTo(view, "\\begin{table}");
    const table = content.querySelector(".cm-vis-figure-table")!;
    // stackengine's stack is its two lines, whatever the package defines; `\sl` at a cell's start styles the cell.
    assert.deepEqual([...table.querySelectorAll(".cm-vis-stack-line")].map((part) => clean(part.textContent)), ["patch size/", "stride"]);
    assert.ok(!table.querySelector(".cm-vis-raw"));
    assert.equal(clean(table.querySelectorAll("td")[2].querySelector(".cm-vis-i")?.textContent), "BN-x5");
  } finally {
    view.destroy();
  }
});

test("edits around hand-numbered rows, font switches in environments and stacks build the same constructs as a fresh build", () => {
  const pieces = ["\\eqnr", "\\\\", "\\it ", "{", "}", "\\end{quote}", "\\begin{quote}", "\\uline{x}", "\\COMMENT x", "\\begin{flalign*}", "&", "$", "\n\n"];
  const start = PAPER4.indexOf("\\begin{document}") + 17;
  fc.assert(fc.property(fc.array(fc.record({ at: fc.nat(), remove: fc.nat({ max: 5 }), insert: fc.constantFrom(...pieces) }), { maxLength: 5 }), (edits) => {
    const view = mount(PAPER4);
    try {
      for (const edit of edits) {
        const length = view.state.doc.length;
        const from = start + (edit.at % Math.max(1, length - start - 16));
        const to = Math.min(length - 16, from + edit.remove);
        view.dispatch({ changes: { from, to: Math.max(from, to), insert: edit.insert } });
        ensureSyntaxTree(view.state, view.state.doc.length, 5000);
        view.dispatch({});
      }
      assert.deepEqual(constructs(view.state), constructs(stateFor(view.state.doc.toString())));
    } finally {
      view.destroy();
    }
  }), { numRuns: 40 });
});

/* ---- Real papers, fifth batch (the audit against DQN, YOLO, Layer Normalization) ---- */

const PAPER5 = String.raw`\documentclass{article}
\usepackage{subfigure,tabulary,colortbl,relsize,bbm}
\def\bea#1\eea{\begin{align}#1\end{align}}
\newcommand{\cut}[1]{}
\DeclareMathOperator{\vecop}{vec}
\begin{document}
\section{Background}
\bea
y &= \vecop(x) \label{eq:vec}
\eea
\cut{
\section{Old related work}\label{sec:old}
Some $x$ text.
}
\section{Experiments}\label{sec:exp}
The loss is $\mathlarger{\mathbbm{1}}_{ij}$.
\begin{small}
Smaller text.
\end{small}

\begin{figure}
  \centering
  \mbox{
    \subfigure[Recall@1]{\includegraphics[width=0.33\columnwidth]{r1}}%\quad
    \subfigure[Recall@5]{\includegraphics[width=0.33\columnwidth]{r5}\label{fig:r5}}
  }
  \caption{Recall curves.}\label{fig:recall}
\end{figure}

\begin{table}[h]
\definecolor{Gray}{gray}{0.85}
\centering
\begin{tabulary}{\linewidth}{L|C}
\hline
{\small \textbf{Sarsa}} & $996$ \\
\rowcolor{Gray} YOLO & \cellcolor{red} 63.4 \\
\end{tabulary}
\caption{Results.}\label{timing}
\end{table}

\ifx 1 0
\begin{table}\caption{Old timing.}\label{timing}\end{table}
\fi
\end{document}
`;

test("fifth batch: \\def\\bea#1\\eea pairs, discarding macros, \\ifx 1 0, and the subfigure package's commands, numbered as LaTeX does", () => {
  const view = mount(PAPER5);
  try {
    number(view);
    const ref = (key: string) => stateReferenceText(view.state, "\\ref", [key]);
    // `\bea … \eea` is an align: its row is equation 1. What \cut and `\ifx 1 0` leave out is not numbered:
    // Experiments is section 2, and the second `timing` label (in the false branch) does not replace the first.
    assert.deepEqual(["eq:vec", "sec:exp", "fig:r5", "fig:recall", "timing"].map(ref), ["1", "2", "1(b)", "1", "1"]);
    assert.ok(!view.state.field(numberingField).labels.has("sec:old"));
    const kindsAt = (needle: string) => { const pos = at(view, needle); const out: string[] = []; view.state.field(structuralField).extents.between(pos, pos + 1, (_from, _to, mark) => { out.push(mark.kind); }); return out; };
    // The use in the body (not the definition in the preamble) is drawn as the align it writes.
    assert.ok(kindsAt("\\bea\ny").includes("macro-env") || kindsAt("\\bea\ny").includes("math"), JSON.stringify(kindsAt("\\bea\ny")));
    assert.deepEqual(kindsAt("\\section{Old"), ["disabled"]);
    assert.deepEqual(kindsAt("\\begin{table}\\caption{Old"), ["disabled"]);
  } finally {
    view.destroy();
  }
});

test("fifth batch draws: sub-figure commands as panels, tabulary, colortbl fills, rules before a grouped cell, relsize and size environments", async () => {
  const view = mount(PAPER5);
  try {
    number(view);
    const content = view.contentDOM;
    const clean = (text: string | null | undefined) => (text ?? "").replace(/[​⁣]/g, "").replace(/\s+/g, " ").trim();
    await scrollTo(view, "The loss");
    const line = [...content.querySelectorAll(".cm-line")].find((element) => element.textContent?.startsWith("The loss"))!;
    assert.ok(line.querySelector(".cm-vis-math"), "\\mathlarger is drawn");
    assert.ok([...content.querySelectorAll(".cm-line")].some((element) => element.classList.contains("cm-vis-sized") && element.textContent === "Smaller text."));
    await scrollTo(view, "\\begin{figure}");
    const figure = content.querySelector(".cm-vis-figure-figure")!;
    assert.deepEqual([...figure.querySelectorAll(".cm-vis-figure-panel")].map((panel) => clean(panel.querySelector(".cm-vis-caption")?.textContent)), ["(a) Recall@1", "(b) Recall@5"]);
    assert.equal(clean(figure.lastElementChild?.textContent), "Figure 1: Recall curves.");
    await scrollTo(view, "\\begin{table}[h]");
    const table = content.querySelector(".cm-vis-figure-table")!;
    // The group after `\hline` is the first cell, whole; `C` centres; `\rowcolor` and `\cellcolor` fill.
    const cells = [...table.querySelectorAll("td")];
    assert.deepEqual(cells.map((td) => clean(td.textContent)), ["Sarsa", "996", "YOLO", "63.4"]);
    assert.equal((cells[1] as HTMLElement).style.textAlign, "center");
    assert.ok(cells[2].parentElement!.hasAttribute("data-fill"));
    assert.ok(cells[3].hasAttribute("data-fill"));
    assert.ok(!table.querySelector(".cm-vis-raw"));
  } finally {
    view.destroy();
  }
});

test("edits around delimited pairs, discarding macros, false conditionals and sub-figure commands build the same constructs as a fresh build", () => {
  const pieces = ["\\bea", "\\eea", "\\cut{", "}", "{", "\\ifx 1 0", "\\fi", "\\subfigure[a]{x}", "\\hline", "\\rowcolor{red}", "&", "\\\\", "\n\n"];
  const start = PAPER5.indexOf("\\begin{document}") + 17;
  fc.assert(fc.property(fc.array(fc.record({ at: fc.nat(), remove: fc.nat({ max: 5 }), insert: fc.constantFrom(...pieces) }), { maxLength: 5 }), (edits) => {
    const view = mount(PAPER5);
    try {
      for (const edit of edits) {
        const length = view.state.doc.length;
        const from = start + (edit.at % Math.max(1, length - start - 16));
        const to = Math.min(length - 16, from + edit.remove);
        view.dispatch({ changes: { from, to: Math.max(from, to), insert: edit.insert } });
        ensureSyntaxTree(view.state, view.state.doc.length, 5000);
        view.dispatch({});
      }
      assert.deepEqual(constructs(view.state), constructs(stateFor(view.state.doc.toString())));
    } finally {
      view.destroy();
    }
  }), { numRuns: 40 });
});

/* ---- Real papers, sixth batch (the audit against Seq2seq, U-Net, DCGAN, Mask R-CNN, Distillation) ---- */

const PAPER6 = String.raw`\documentclass{article}
\usepackage{subfig,overpic,amssymb}
\newcommand{\app}{\raise.17ex\hbox{$\scriptstyle\sim$}}
\newlength\savewidth\newcommand\shline{\noalign{\global\savewidth\arrayrulewidth
  \global\arrayrulewidth 1pt}\hline\noalign{\global\arrayrulewidth\savewidth}}
\newcommand{\tablestyle}[2]{\setlength{\tabcolsep}{#1}\renewcommand{\arraystretch}{#2}\centering\footnotesize}
\makeatletter\renewcommand\paragraph{\@startsection{paragraph}{4}{\z@}
  {.5em \@plus1ex \@minus.2ex}{-.5em}{\normalfont\normalsize\bfseries}}\makeatother
\begin{document}
\paragraph{Training:} An RoI gives $\app$5 masks, \app 2 in text, as \checkmark{} says.

\begin{table}[t]
\tablestyle{3.5pt}{1.1}
\begin{tabular}{l|c}
 & AP \\
\shline
MNC & 24.6 \\
\end{tabular}
\caption{Instance segmentation.}\label{tab:final_mask}
\end{table}

\begin{table*}[t]
\subfloat[\textbf{Backbone}.\label{tab:ablation:backbone}]{
\tablestyle{2.5pt}{1.05}\begin{tabular}{c|c}
 & AP \\
\shline
R-50 & 30.3 \\
\end{tabular}}\hspace{2em}
\subfloat[\textbf{Masks}.\label{tab:ablation:sigmoid}]{
\tablestyle{4.8pt}{1.05}\begin{tabular}{c|c}
 & AP \\
\shline
softmax & 24.8 \\
\end{tabular}}
\caption{Ablations.}\label{tab:ablations}
\end{table*}

\begin{table}[t]
\resizebox{\columnwidth}{!}{\tablestyle{2pt}{1.1}\begin{tabular}{l|c}
 & AP \\
\shline
FCIS & 29.2 \\
\end{tabular}}
\caption{Keypoints.}\label{tab:keypoints}
\end{table}

\begin{figure}[t]
\centering
\begin{overpic}[width=1.0\linewidth]{ai/head}
\put(33,29){\tiny Faster R-CNN}
\end{overpic}
\caption{Head architecture.}\label{fig:head}
\end{figure}

\begin{table}[t]
\centering
\begin{small}
\begin{tabular}{|c|c|}
\hline
{\bf Method} & {\bf BLEU} \\ \hline
Baseline & 33.30 \\ \hline
\end{tabular}
\end{small}
\caption{WMT'14.}\label{tab:wmt}
\end{table}

\begin{figure}[h!]
\centerline{
\includegraphics[width=1.\textwidth]{good2.eps} }
\caption{Sentence length.}\label{fig:length}
\end{figure}

Text with \tablestyle{2pt}{1.1} in it.
\end{document}
`;

test("sixth batch: subfig's panels number with their float, and a document's \\@startsection restyle keeps \\paragraph LaTeX's own", () => {
  const view = mount(PAPER6);
  try {
    number(view);
    const ref = (key: string) => stateReferenceText(view.state, "\\ref", [key]);
    // The sub-tables come before their table's caption: 2a, 2b, as subfig numbers them.
    assert.deepEqual(["tab:final_mask", "tab:ablation:backbone", "tab:ablation:sigmoid", "tab:ablations", "tab:keypoints", "tab:wmt", "fig:head", "fig:length"].map(ref), ["1", "2a", "2b", "2", "3", "4", "1", "2"]);
    assert.ok(!visualDefinitions(view.state).macros.has("paragraph"));
    assert.ok(kinds(view.state).heading >= 1, "\\paragraph is drawn as LaTeX's run-in heading");
  } finally {
    view.destroy();
  }
});

test("sixth batch draws: \\raise in formulas and text, rule and layout macros in tables, overpic, size environments and \\centerline in floats", async () => {
  const view = mount(PAPER6);
  try {
    number(view);
    const content = view.contentDOM;
    const clean = (text: string | null | undefined) => (text ?? "").replace(/[\u200b\u2063]/g, "").replace(/\s+/g, " ").trim();
    await scrollTo(view, "\\paragraph{Training");
    const line = [...content.querySelectorAll(".cm-line")].find((element) => element.textContent?.includes("RoI gives"))!;
    assert.equal(line.querySelectorAll(".cm-vis-math").length, 1, "$\\app$ is drawn");
    assert.ok(!line.querySelector(".cm-vis-raw"));
    assert.match(clean(line.textContent), /∼ ?2 in text, as ✓ says\./);
    // Every float is drawn: `\tablestyle` and `\begin{small}` are layout, `\shline` a thick rule, overpic its image.
    assert.deepEqual(kinds(view.state).figure, 6);
    await scrollTo(view, "\\begin{table}[t]\n\\tablestyle");
    const table = content.querySelector(".cm-vis-figure-table")!;
    assert.deepEqual([...table.querySelectorAll("td")].map((td) => clean(td.textContent)), ["", "AP", "MNC", "24.6"]);
    assert.ok(table.querySelector(".cm-vis-rule-heavy"), "\\shline is a thick rule");
    assert.ok(!content.querySelector(".cm-vis-figure .cm-vis-raw"));
    await scrollTo(view, "\\begin{table*}");
    assert.deepEqual([...content.querySelectorAll(".cm-vis-figure-panel .cm-vis-caption")].map((caption) => clean(caption.textContent)), ["(a) Backbone.", "(b) Masks."]);
    // In running text, a layout macro stays as written.
    await scrollTo(view, "Text with");
    const text = [...content.querySelectorAll(".cm-line")].find((element) => element.textContent?.startsWith("Text with"))!;
    assert.equal(text.textContent, String.raw`Text with \tablestyle{2pt}{1.1} in it.`);
  } finally {
    view.destroy();
  }
});

test("edits around rule and layout macros, sub-floats and overpic build the same constructs as a fresh build", () => {
  const pieces = ["\\shline", "\\tablestyle{1pt}{1}", "\\subfloat[a]{x}", "\\begin{overpic}{f}", "\\end{overpic}", "\\begin{small}", "\\end{small}", "\\app", "&", "\\\\", "{", "}", "\n\n"];
  const start = PAPER6.indexOf("\\begin{document}") + 17;
  fc.assert(fc.property(fc.array(fc.record({ at: fc.nat(), remove: fc.nat({ max: 5 }), insert: fc.constantFrom(...pieces) }), { maxLength: 5 }), (edits) => {
    const view = mount(PAPER6);
    try {
      for (const edit of edits) {
        const length = view.state.doc.length;
        const from = start + (edit.at % Math.max(1, length - start - 16));
        const to = Math.min(length - 16, from + edit.remove);
        view.dispatch({ changes: { from, to: Math.max(from, to), insert: edit.insert } });
        ensureSyntaxTree(view.state, view.state.doc.length, 5000);
        view.dispatch({});
      }
      assert.deepEqual(constructs(view.state), constructs(stateFor(view.state.doc.toString())));
    } finally {
      view.destroy();
    }
  }), { numRuns: 40 });
});

test("clicking a citation or label chip opens its source, with the cursor after its keys", () => {
  const doc = "\\documentclass{article}\n\\begin{document}\nAs in \\cite{alpha,beta}.\\label{sec:x}\n\\end{document}\n";
  for (const [selector, end] of [[".cm-vis-cite", "beta}"], [".cm-vis-label", "sec:x}"]] as const) {
    const view = mount(doc, [], 0);
    const chip = view.contentDOM.querySelector(selector)!;
    chip.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
    assert.equal(view.state.selection.main.head, at(view, end, end.length - 1));
    assert.ok(revealedKinds(view.state).includes(selector === ".cm-vis-cite" ? "cite" : "label"), `${selector} shows its source`);
    view.destroy();
  }
});

test("citation chips print TeX accents and escapes in author names", () => {
  assert.equal(plainTexText(String.raw`Boli\'c et al.`), "Bolić et al.");
  assert.equal(plainTexText(String.raw`M{\"u}ller and {\v{S}}koda \& Co.`), "Müller and Škoda & Co.");
  assert.equal(plainTexText(String.raw`{\o}rsted~Gau\ss`), "ørsted Gauß");
  const aux = { labels: {}, citations: { b: { label: "Bolić et al., 2021", authors: String.raw`Boli\'c et al.`, year: "2021" } } };
  assert.equal(citationText({ command: "\\citet", keys: ["b"] }, aux, () => null), "Bolić et al. (2021)");
  assert.equal(citationText({ command: "\\citep", keys: ["k"] }, { labels: {}, citations: {} }, () => ({ author: String.raw`Boli{\'c}, Tatjana and Castelli, Lorenzo`, year: "2021" })), "[Bolić and Castelli 2021]");
});

test("an accent shows its source while the cursor touches it, so typing \\c before a word is not drawn as a cedilla", () => {
  const doc = "\\documentclass{article}\n\\begin{document}\nHere I try to type \\c This line.\n\\end{document}\n";
  const typing = doc.indexOf("\\c This") + 2;
  const view = mount(doc, [], typing);
  assert.ok(revealedKinds(view.state).includes("symbol"), "the cursor right after \\c shows the source");
  view.dispatch({ selection: { anchor: doc.indexOf("line.") } });
  assert.ok(!revealedKinds(view.state).includes("symbol"));
  assert.ok([...view.contentDOM.querySelectorAll(".cm-vis-symbol")].some((element) => element.textContent === "Ţ"), "away from the cursor, \\c T is Ţ");
  view.destroy();
});

test("macros: math macros render expanded, text macros as their expansion, and \\todo keeps its argument editable", () => {
  const view = mount(SAMPLE);
  const macro = view.contentDOM.querySelector(".cm-vis-macro");
  assert.equal(macro?.textContent, "e.g.");
  const pieces = [...view.contentDOM.querySelectorAll(".cm-vis-macro-piece")].map((piece) => piece.textContent);
  assert.deepEqual(pieces, ["[[", "]]"]);
  const argument = view.contentDOM.querySelector(".cm-vis-macro-arg");
  assert.equal(argument?.textContent, "check this");
  assert.match(argument?.getAttribute("style") ?? "", /color/);
  // \norm{v} inside math went through the expansion: KaTeX drew \lVert.
  const norm = [...view.contentDOM.querySelectorAll(".cm-vis-math")].find((element) => element.getAttribute("aria-label")?.includes("\\norm"));
  assert.ok(norm?.innerHTML.includes("∥"));
  view.destroy();
});

test("broken or unknown LaTeX stays as source, but constructs inside a broken one still render", () => {
  const view = mount("Before \\textbf{open $x$ and \\emph{fine}\n\nAfter \\frobnicate{y} and \\begin{theorem}x\\end{lemma}.");
  const found = kinds(view.state);
  assert.equal(found.style, 1, "only \\emph renders; the unclosed \\textbf stays as source");
  assert.equal(found.math, 1);
  assert.equal(found["env-header"], undefined, "a wrong \\end leaves the environment as source");
  view.destroy();
});

test("a hand-built notation table: definitions stay source, rows cover their arguments, and its label is a table", () => {
  const doc = String.raw`\documentclass{article}
\newcommand{\Fset}{\mathcal{F}}
\begin{document}
\begingroup
  \newcommand{\COrow}[2]{\noindent\parbox[t]{0.23\linewidth}{#1}\hspace{10pt}\parbox[t]{0.7\linewidth}{#2}\par}
  \newcommand{\COsection}[1]{\par\noindent\textit{#1}\par}
  \providecommand{\COnote}[1]{\textbf{#1}}
  \refstepcounter{table}
  \label{tab:notation}
  \COrow{$\Fset,\ f$}
    {Set of all flights, indexed by $f \in \Fset$.}
\endgroup
See \cref{tab:notation}.
\end{document}
`;
  const view = mount(doc);
  const list = constructs(view.state);
  const definitions = doc.indexOf("\\newcommand{\\COrow}");
  // The `\refstepcounter` line (counter commands print nothing, text round) folds from its line's start, indentation
  // included: the bodies end where that line starts.
  const bodiesEnd = doc.lastIndexOf("\n", doc.indexOf("\\refstepcounter")) + 1;
  // Round 5: each definition is folded as one inert `layout` unit (shown as source at the caret); nothing else, no widget,
  // is drawn from inside a body.
  assert.ok(list.every((entry) => { const [kind, from] = entry.split(":"); return kind === "layout" || Number(from) < definitions || Number(from) >= bodiesEnd; }), `nothing in definition bodies is drawn: ${list.join(" ")}`);
  for (const name of ["\\newcommand{\\COrow}", "\\newcommand{\\COsection}", "\\providecommand{\\COnote}"]) {
    const start = doc.indexOf(name);
    const lineEnd = doc.indexOf("\n", start);
    assert.ok(list.some((entry) => { const [kind, from, to] = entry.split(":"); return kind === "layout" && Number(from) <= start && Number(to) >= lineEnd; }), `${name} is one folded unit`);
  }
  const row = list.find((entry) => entry.startsWith("macro:"));
  assert.ok(row, "the row is drawn as its expansion");
  const [, rowFrom, rowTo] = row!.split(":").map(Number);
  assert.equal(doc.slice(rowFrom, rowTo), "\\COrow{$\\Fset,\\ f$}\n    {Set of all flights, indexed by $f \\in \\Fset$.}");
  assert.ok(list.every((entry) => { const [, from, to] = entry.split(":"); return entry === row || Number(to) <= rowFrom || Number(from) >= rowTo; }), "nothing inside the row's arguments is drawn separately");
  const state = view.state;
  const numbering = computeLatexNumbering(syntaxTree(state), (from, to) => state.doc.sliceString(from, to), visualDefinitions(state));
  assert.equal(numbering.labels.get("tab:notation")?.kind, "table");
  view.dispatch({ effects: setNumbering.of(numbering) });
  assert.equal(stateReferenceText(view.state, "\\cref", ["tab:notation"]), "table 1");
  view.destroy();
});

test("a redefined built-in is drawn as the document's macro, not as the built-in", () => {
  const view = mount("\\renewcommand{\\textbf}[1]{NEVER #1}\n\\providecommand{\\emph}[1]{X}\nSome \\textbf{x} and \\emph{y}.");
  const list = constructs(view.state);
  const bold = view.state.doc.toString().indexOf("\\textbf{x}");
  assert.ok(!list.some((entry) => entry === `style:${bold}:${bold + 10}`), "not drawn as bold");
  assert.ok(list.some((entry) => entry.startsWith(`macro-args:${bold}:`)), list.join(" "));
  assert.ok(!view.contentDOM.querySelector(".cm-vis-b"));
  assert.ok(view.contentDOM.querySelector(".cm-vis-macro-piece")?.textContent?.includes("NEVER"));
  assert.ok(list.some((entry) => entry.startsWith("style:")), "\\providecommand does not replace \\emph");
  view.destroy();
});

test("a user environment's arguments are read after its name, and its body is not eaten", () => {
  const view = mount("\\newenvironment{note}[1]{\\textbf{#1}}{}\n\\begin{note}{Hello}body\\end{note}");
  assert.equal(view.contentDOM.querySelector(".cm-vis-env-header")?.textContent, "Hello");
  const header = constructs(view.state).find((entry) => entry.startsWith("env-header:"))!;
  assert.equal(view.state.doc.sliceString(Number(header.split(":")[1]), Number(header.split(":")[2])), "\\begin{note}{Hello}");
  view.destroy();
});

test("a figure with content the widget does not draw stays source", () => {
  const drawn = mount("\\begin{figure}[h]\n\\centering\\small\n\\includegraphics[width=.5\\textwidth]{a}\n\\caption{C}\\label{fig:a}\n\\end{figure}");
  assert.equal(kinds(drawn.state).figure, 1);
  drawn.destroy();
  // Sub-figures of images (one above the other, with `\\`) are panels of their figure.
  const panels = mount("\\begin{figure}\n\\begin{subfigure}{.5\\textwidth}\\includegraphics{a}\\\\\n\\includegraphics{b}\\caption{A}\\end{subfigure}\\caption{C}\n\\end{figure}");
  assert.ok(constructs(panels.state).some((entry) => entry.startsWith("figure:0:")));
  panels.destroy();
  // Since the floats round (principle 1) text or a command the widget does not draw no longer keeps the whole figure
  // source: the figure is drawn and just that piece is shown as its source, inside the figure (in its panel).
  for (const [inner, piece] of [["Some text \\includegraphics{a}\\caption{C}", "Some text"], ["\\includegraphics{a}\\foo\\caption{C}", "\\foo"], ["\\begin{subfigure}{.5\\textwidth}K=2 \\includegraphics{a}\\caption{A}\\end{subfigure}\\caption{C}", "K=2"]]) {
    const view = mount(`\\begin{figure}\n${inner}\n\\end{figure}`);
    assert.ok(constructs(view.state).some((entry) => entry.startsWith("figure:0:")), inner);
    const sources = [...view.contentDOM.querySelectorAll(".cm-vis-figure .cm-vis-figure-source")].map((part) => part.textContent?.trim());
    assert.deepEqual(sources, [piece], inner);
    view.destroy();
  }
});

test("a starred definition's name and body stay source", () => {
  const view = mount("\\newcommand*{\\a}{\\textbf{definition}}\n\\renewcommand*\\b[1]{\\emph{#1}}\nText \\textbf{real}.");
  const list = constructs(view.state);
  const real = view.state.doc.toString().indexOf("\\textbf{real}");
  assert.deepEqual(list.filter((entry) => entry.startsWith("style:")), [`style:${real}:${real + 13}`]);
  assert.ok(!list.some((entry) => entry.startsWith("macro")), list.join(" "));
  view.destroy();
});

test("definitions follow edits inside a multi-line body and before them", () => {
  const doc = "\\documentclass{article}\n\\begin{document}\nIntro.\n\\newcommand{\\test}{\n  A}\nUse \\test.\n\\end{document}";
  const view = mount(doc);
  const body = doc.indexOf("  A");
  view.dispatch({ changes: { from: body + 2, to: body + 3, insert: "B" } });
  assert.equal(macroAt(visualDefinitions(view.state), "test", view.state.doc.length)?.body, "\n  B");
  // Text typed before the definition moves it: it still applies only from where it is written.
  const intro = view.state.doc.toString().indexOf("Intro.");
  view.dispatch({ changes: { from: intro, insert: "x".repeat(200) } });
  const defs = visualDefinitions(view.state);
  const at = view.state.doc.toString().indexOf("\\newcommand{\\test}");
  assert.equal(macroAt(defs, "test", at - 1), null);
  assert.equal(macroAt(defs, "test", at)?.body, "\n  B");
  view.destroy();
});

test("item markers follow \\setcounter, as references do", () => {
  const view = mount("\\begin{enumerate}\n\\item a\n\\setcounter{enumi}{3}\n\\item b\n\\end{enumerate}");
  assert.deepEqual([...view.contentDOM.querySelectorAll(".cm-vis-item")].map((item) => item.textContent), ["1.", "4."]);
  view.destroy();
});

/* ---- Widgets and their editors --------------------------------------------------- */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const mouse = (type: string, init: Record<string, unknown> = {}) => new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });

test("references in captions and table cells follow numbering, and fragments use definitions in force where they are", async () => {
  const doc = "\\documentclass{article}\n\\begin{document}\n\\section{A}\\label{sec:a}\n\\begin{figure}\n\\includegraphics{a}\n\\caption{See \\ref{sec:a}}\n\\end{figure}\n\\begin{tabular}{ll}\n\\ref{sec:a} & \\x\n\\end{tabular}\n\\newcommand\\x{LATE}\n\\end{document}";
  const view = mount(doc);
  await tick();
  number(view);
  await tick();
  assert.match(view.contentDOM.querySelector(".cm-vis-caption-text")?.textContent ?? "", /See 1/);
  const cells = [...view.contentDOM.querySelectorAll(".cm-vis-tabular .cm-vis-table-cell")].map((cell) => cell.textContent);
  assert.equal(cells[0], "1");
  assert.equal(cells[1], "\\x", "a definition written after the table does not apply in it");
  view.destroy();
});

test("a cell editor survives a co-author's edit to its table, and clicks in it do not close it", async () => {
  const doc = "\\begin{tabular}{ll}\na & b \\\\\nc & d\n\\end{tabular}\n";
  const view = mount(doc);
  const cellA = () => [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-table-cell")].find((cell) => cell.dataset.row === "0" && cell.dataset.cell === "0")!;
  cellA().dispatchEvent(mouse("mousedown"));
  assert.equal(isEditingCell(cellA()), true);
  const before = view.state.selection.main;
  cellA().dispatchEvent(mouse("mousedown"));
  assert.deepEqual([view.state.selection.main.from, view.state.selection.main.to], [before.from, before.to], "the click stays in the cell");
  cellA().textContent = "draft";
  cellA().dispatchEvent(new dom.window.Event("input"));
  const d = view.state.doc.toString().indexOf("d\n");
  view.dispatch({ changes: { from: d, to: d + 1, insert: "D" }, annotations: Transaction.remote.of(true) });
  await tick();
  assert.equal(isEditingCell(cellA()), true, "the redrawn table continues the edit");
  assert.equal(cellA().textContent, "draft");
  cellA().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  assert.equal(view.state.doc.toString(), "\\begin{tabular}{ll}\ndraft & b \\\\\nc & D\n\\end{tabular}\n");
  view.destroy();
});

test("cancelling a cell shows the cell's current source, and closing the view closes its editors", async () => {
  const view = mount("\\begin{tabular}{l}\na\n\\end{tabular}\n$x^2$\n");
  const cell = view.contentDOM.querySelector<HTMLElement>(".cm-vis-table-cell")!;
  cell.dispatchEvent(mouse("mousedown"));
  cell.textContent = "zzz";
  cell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(cell.textContent, "a");
  assert.equal(isEditingCell(cell), false);
  // (jsdom cannot measure positions, so the formula editor's panel is not opened here; it closes the same way.)
  cell.dispatchEvent(mouse("mousedown"));
  cell.dispatchEvent(mouse("contextmenu", { clientX: 5, clientY: 5 }));
  assert.ok(document.querySelector(".cm-vis-table-menu"));
  view.destroy();
  assert.equal(isEditingCell(cell), false, "the cell editor closed with its view");
  assert.equal(document.querySelector(".cm-vis-table-menu"), null, "and its menu");
});

test("MathLive gets the macros a formula's macros use; ones it cannot read are opaque atoms", () => {
  const view = mount("\\newcommand\\b[1][x]{#1}\\newcommand\\a{\\b}\\newcommand\\c{y}\\newcommand\\d{\\c}\nSee $\\a$ and $\\d$.");
  const doc = view.state.doc.toString();
  // \a uses \b, which has an optional argument: \a is an opaque atom, written back as it is (latex-visual-gaps-math-edit.test.ts).
  assert.equal(canEditInMathLive(view, doc.indexOf("$\\a")), true);
  assert.equal(canEditInMathLive(view, doc.indexOf("$\\d")), true);
  view.destroy();
});

test("a widget's edit is its own undo step, in every history", () => {
  let boundaries = 0;
  const view = mount("", [undoBoundaries.of(() => { boundaries++; })]);
  view.dispatch({ changes: { from: 0, insert: "a" }, userEvent: "input.type" });
  dispatchAsOneStep(view, { changes: { from: 1, insert: "b" }, userEvent: "input.visual.math" });
  view.dispatch({ changes: { from: 2, insert: "c" }, userEvent: "input.type" });
  assert.equal(boundaries, 2);
  undo(view);
  assert.equal(view.state.doc.toString(), "ab");
  undo(view);
  assert.equal(view.state.doc.toString(), "a");
  view.destroy();
});

test("buttons and menus work from the keyboard, and Enter on a selected reference follows it", async () => {
  const view = mount("\\documentclass{article}\n\\begin{document}\n\\section{A}\\label{sec:a}\nSee \\ref{sec:a}.\n\\begin{tabular}{l}\na\n\\end{tabular}\n\\end{document}");
  view.contentDOM.querySelector<HTMLButtonElement>(".cm-vis-preamble-toggle")!.dispatchEvent(mouse("click"));
  assert.equal(view.state.field(preambleOpenField), true, "the preamble button toggles on click (Enter and Space make clicks)");
  number(view);
  const ref = view.state.doc.toString().indexOf("\\ref");
  view.dispatch({ selection: EditorSelection.range(ref, ref + "\\ref{sec:a}".length) });
  assert.ok(runScopeHandlers(view, new dom.window.KeyboardEvent("keydown", { key: "Enter" }), "editor"));
  assert.equal(view.state.selection.main.head, view.state.doc.toString().indexOf("\\section"));
  const cell = view.contentDOM.querySelector<HTMLElement>(".cm-vis-table-cell")!;
  cell.dispatchEvent(mouse("contextmenu", { clientX: 10, clientY: 10 }));
  const menu = document.querySelector<HTMLElement>(".cm-vis-table-menu")!;
  assert.equal(document.activeElement?.textContent, "Insert row above", "the menu takes the focus");
  menu.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  assert.equal(document.activeElement?.textContent, "Insert row below");
  (document.activeElement as HTMLElement).dispatchEvent(mouse("click"));
  assert.equal(document.querySelector(".cm-vis-table-menu"), null);
  assert.match(view.state.doc.toString(), /a \\\\\n/);
  view.destroy();
});

test("typing after a hidden command name keeps every cursor", () => {
  const view = mount("a\\ldots\nb\\ldots\n", [EditorState.allowMultipleSelections.of(true)]);
  const doc = view.state.doc.toString();
  const first = doc.indexOf("\n");
  const second = doc.length - 1;
  view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(first), EditorSelection.cursor(second)]) });
  const handled = view.state.facet(EditorView.inputHandler).some((handler) => handler(view, first, first, "x", () => view.state.update({ changes: { from: first, insert: "x" } })));
  assert.ok(handled);
  assert.equal(view.state.doc.toString(), "a\\ldots x\nb\\ldots x\n");
  assert.equal(view.state.selection.ranges.length, 2);
  view.destroy();
});

test("transparent plans and formula previews follow the definitions they depend on", () => {
  const bold = readLatexDefinitions(String.raw`\newcommand\inner[1]{\textbf{#1}}\newcommand\outer[1]{\inner{#1}}`);
  const italic = readLatexDefinitions(String.raw`\newcommand\inner[1]{\textit{#1}}\newcommand\outer[1]{\inner{#1}}`);
  assert.match(transparentPlan(macroAt(bold, "outer", Number.MAX_SAFE_INTEGER)!, bold)!.marks[0].class, /cm-vis-b/);
  assert.match(transparentPlan(macroAt(italic, "outer", Number.MAX_SAFE_INTEGER)!, italic)!.marks[0].class, /cm-vis-em/);
  const withRef = readLatexDefinitions(String.raw`\newcommand\seeref[1]{#1 (see \ref{sec:a})}`);
  assert.equal(transparentPlan(macroAt(withRef, "seeref", Number.MAX_SAFE_INTEGER)!, withRef), null, "a reference in the fixed part needs the refreshing widget");
  const doc = "Text $\\R$ here.";
  const state = EditorState.create({ doc, selection: { anchor: doc.indexOf("\\R") + 1 }, extensions: [latexLanguageSupport("main.tex", "tree"), latexMathPreview(), latexVisualState()] });
  const before = state.facet(showTooltip);
  const after = state.update({ effects: setMacroSources.of([{ path: "nb/macros.tex", text: "\\newcommand{\\R}{\\mathbb{R}}", version: "1" }]) }).state;
  assert.notEqual(after.facet(showTooltip)[0], before[0], "the preview is drawn again with the new definition");
});

test("graphics resolve from the compile root's directory and \\graphicspath, as TeX finds them", () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  const doc = "\\graphicspath{{figures/}}\n\\begin{document}\n\\includegraphics{plot}\n\\end{document}";
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/chapters/one.tex", rootPath: "nb/main.tex" })] }) });
  assert.deepEqual(graphicsCandidates(view, "plot"), ["nb/plot", "nb/figures/plot"]);
  view.destroy();
});

/* ---- Revealing the source ---------------------------------------------------------- */

test("the innermost construct at the cursor shows its source, by its policy", () => {
  const doc = "\\section{Intro \\textbf{bold}}\n\nText $x^2$ here.\n\\begin{itemize}\n\\item one\n\\end{itemize}\n";
  const view = mount(doc);
  const moveTo = (pos: number) => view.dispatch({ selection: { anchor: pos } });
  // A heading shows its source while the cursor is on its line (it was: only from its line start to its `{`, its
  // markup hidden while its title was typed).
  moveTo(at(view, "bold", 2));
  assert.deepEqual(revealedKinds(view.state), ["heading", "style"], "bold inside a heading reveals the bold markup and the heading's");
  moveTo(at(view, "Intro", 2));
  assert.deepEqual(revealedKinds(view.state), ["heading"], "typing in a heading shows its markup");
  moveTo(0);
  assert.deepEqual(revealedKinds(view.state), ["heading"], "the line start reveals the heading command");
  moveTo(at(view, "$x"));
  assert.deepEqual(revealedKinds(view.state), [], "a formula stays drawn with the cursor at its edge");
  moveTo(at(view, "x^2"));
  assert.deepEqual(revealedKinds(view.state), ["math"], "strictly inside, the formula shows its source");
  moveTo(at(view, "one"));
  assert.deepEqual(revealedKinds(view.state), [], "bullets never open from the cursor");
  view.dispatch({ selection: { anchor: at(view, "one") } });
  assert.ok(runScopeHandlers(view, new dom.window.KeyboardEvent("keydown", { key: "Enter", altKey: true }), "editor"));
  assert.deepEqual(revealedKinds(view.state), ["item"], "Alt+Enter shows the source of the construct at the cursor");
  view.destroy();
});

test("constructs under a pending suggestion or AI change show as source", () => {
  const doc = "A formula $a+b$ and \\textbf{bold}.";
  const formula = doc.indexOf("a+b");
  const view = mount(doc, [visualRevealRanges.of(() => [{ from: formula, to: formula + 1 }])]);
  assert.deepEqual(revealedKinds(view.state), ["math"]);
  view.destroy();
});

/* ---- Keyboard ------------------------------------------------------------------------ */

test("bold toggles off inside \\textbf and on elsewhere", () => {
  const view = mount("Some \\textbf{bold} text");
  view.dispatch({ selection: { anchor: at(view, "bold", 2) } });
  toggleLatexFormat("textbf")(view);
  assert.equal(view.state.doc.toString(), "Some bold text");
  assert.equal(view.state.selection.main.head, at(view, "bold", 2));
  view.dispatch({ selection: EditorSelection.range(at(view, "text"), at(view, "text", 4)) });
  toggleLatexFormat("textbf")(view);
  assert.equal(view.state.doc.toString(), "Some bold \\textbf{text}");
  view.destroy();
});

test("Backspace selects a formula before deleting it, and typing after \\ldots keeps the command", () => {
  const view = mount("See $x^2$ now and\\ldots");
  view.dispatch({ selection: { anchor: at(view, " now") } });
  assert.ok(runScopeHandlers(view, new dom.window.KeyboardEvent("keydown", { key: "Backspace" }), "editor"));
  assert.deepEqual([view.state.selection.main.from, view.state.selection.main.to], [at(view, "$x"), at(view, " now")]);
  assert.equal(view.state.doc.toString(), "See $x^2$ now and\\ldots");
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  const handlers = view.state.facet(EditorView.inputHandler);
  const handled = handlers.some((handler) => handler(view, view.state.doc.length, view.state.doc.length, "x", () => view.state.update({ changes: { from: view.state.doc.length, insert: "x" } })));
  assert.ok(handled);
  assert.equal(view.state.doc.toString(), "See $x^2$ now and\\ldots x");
  view.destroy();
});

test("the cursor goes after a heading's brace, where the heading shows its source", () => {
  // Was: the cursor was clamped before the hidden `}` (and moving on went to the next line), so typing could not
  // leave the heading. Now the heading shows its source with the cursor on its line, and the cursor stays after `}`.
  const doc = "\\section{Title}\\label{sec:t}\nNext";
  const view = mount(doc);
  view.dispatch({ selection: { anchor: doc.indexOf("\nNext") } });
  assert.equal(view.state.selection.main.head, doc.indexOf("\nNext"), "after the } and the label");
  assert.deepEqual(revealedKinds(view.state), ["heading"]);
  view.dispatch({ selection: { anchor: doc.indexOf("Next") } });
  assert.equal(view.state.selection.main.head, doc.indexOf("Next"), "moving on goes to the next line");
  assert.deepEqual(revealedKinds(view.state), []);
  view.destroy();
});

/* ---- Speed and correctness of incremental updates ----------------------------------- */

/* ---- Structure written through macros ------------------------------------------------- */

const STRUCTURE_MACROS = String.raw`\documentclass{article}
\newtheorem{theorem}{Theorem}
\newcommand{\mysec}[1]{\section{#1}}
\newcommand{\step}{\item}
\newcommand{\nl}{\\}
\newcommand{\mycap}[1]{\caption{#1}}
\newcommand{\seclabel}[1]{\label{sec:#1}}
\newcommand{\fn}[1]{\footnote{#1}}
\newcommand{\beq}{\begin{equation}}
\newcommand{\eeq}{\end{equation}}
\newcommand{\bl}{\begin{itemize}}
\newcommand{\el}{\end{itemize}}
\newcommand{\thm}[1]{\begin{theorem}#1\end{theorem}}
\begin{document}
\section{First}
\mysec{Second}\seclabel{second}
\section{Third}\label{sec:third}

\begin{enumerate}
\item One
\step Two\label{it:two}
\item Three
\end{enumerate}

\begin{align}
a &= b \nl
c &= d \label{eq:row}
\end{align}

\beq x = 1 \label{eq:x} \eeq

\begin{figure}
\centering
\includegraphics{x.png}
\mycap{A figure.}\label{fig:a}
\end{figure}

Text\fn{one} and\footnote{two}.

\thm{Statement.}

\bl
\item A
\el
\end{document}
`;

test("numbering counts structure written through macros where they are used", () => {
  const view = mount(STRUCTURE_MACROS);
  number(view);
  const numbering = view.state.field(numberingField);
  const at = (needle: string) => STRUCTURE_MACROS.indexOf(needle);
  const entry = (needle: string, kind: string) => numbering.entries.find((item) => item.pos === at(needle) && item.kind === kind);
  assert.equal(entry("\\mysec{Second}", "section")?.number, "2");
  assert.equal(entry("\\section{Third}", "section")?.number, "3");
  assert.deepEqual(entry("\\begin{align}", "equation")?.rows, ["1", "2"]);
  assert.equal(entry("\\beq x", "equation")?.number, "3");
  assert.equal(entry("\\begin{figure}", "figure")?.number, "1");
  assert.equal(entry("\\thm{", "theorem")?.number, "1");
  // The footnote in \fn's definition is not one: \fn{one} is footnote 1.
  assert.deepEqual(numbering.entries.filter((item) => item.kind === "footnote").map((item) => [item.pos, item.number]), [[at("\\fn{one}"), "1"], [at("\\footnote{two}"), "2"]]);
  const ref = (key: string) => stateReferenceText(view.state, "\\ref", [key]);
  assert.deepEqual([ref("sec:second"), ref("sec:third"), ref("it:two"), ref("eq:row"), ref("eq:x"), ref("fig:a")], ["2", "3", "2", "2", "3", "1"]);
  view.destroy();
});

test("structure written through macros is drawn as what it writes", async () => {
  const view = mount(STRUCTURE_MACROS);
  number(view);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const content = view.contentDOM;
  assert.equal(content.querySelector(".cm-vis-macro-heading")?.textContent, "2 Second");
  assert.ok(content.querySelector(".cm-vis-macro-heading")?.closest(".cm-line")?.classList.contains("cm-vis-h1"), "a heading line");
  assert.deepEqual([...content.querySelectorAll(".cm-vis-item")].map((item) => item.textContent).slice(0, 3), ["1.", "2.", "3."]);
  assert.ok([...content.querySelectorAll(".cm-vis-label")].some((chip) => chip.textContent === "sec:second"), "\\seclabel is a label chip");
  // jsdom draws the first screen only: scroll to the rest.
  const scrollTo = async (needle: string) => {
    view.dispatch({ effects: EditorView.scrollIntoView(at(view, needle), { y: "start" }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await scrollTo("\\begin{figure}");
  assert.equal(content.querySelector(".cm-vis-figure-figure .cm-vis-caption")?.textContent, "Figure 1: A figure.");
  await scrollTo("Text\\fn");
  assert.equal(content.querySelector(".cm-vis-macro-footnote .cm-vis-footnote-mark")?.textContent, "1");
  const environments = [...content.querySelectorAll(".cm-vis-macro-env")].map((element) => element.textContent?.trim());
  assert.deepEqual(environments, ["Theorem 1. Statement.", "A"]);
  assert.equal(content.querySelector(".cm-vis-macro-env-list li")?.textContent, "A");
  assert.ok(kinds(view.state).math >= 2, "the align and the \\beq … \\eeq equation are formulas");
  // A click on a drawn expansion shows the macro's source.
  await scrollTo("\\section{First}");
  content.querySelector(".cm-vis-macro-heading")!.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
  assert.ok(revealedKinds(view.state).includes("heading"));
  view.destroy();
});

test("edits around environments opened and closed by macros build the same constructs as a fresh build", () => {
  const pieces = ["\\beq", "\\eeq", " x = 1 ", "\\mysec{S}", "\\step", "\\fn{n}", "\\thm{T}", "\n\n", "}", "{", "\\bl", "\\el", "\\item a"];
  const start = STRUCTURE_MACROS.indexOf("\\begin{document}") + 17;
  fc.assert(fc.property(fc.array(fc.record({ at: fc.nat(), remove: fc.nat({ max: 5 }), insert: fc.constantFrom(...pieces) }), { maxLength: 5 }), (edits) => {
    const view = mount(STRUCTURE_MACROS);
    try {
      for (const edit of edits) {
        const length = view.state.doc.length;
        const from = start + (edit.at % Math.max(1, length - start - 16));
        const to = Math.min(length - 16, from + edit.remove);
        view.dispatch({ changes: { from, to: Math.max(from, to), insert: edit.insert } });
        ensureSyntaxTree(view.state, view.state.doc.length, 5000);
        view.dispatch({});
      }
      assert.deepEqual(constructs(view.state), constructs(stateFor(view.state.doc.toString())));
    } finally {
      view.destroy();
    }
  }), { numRuns: 40 });
});

test("incremental updates build the same constructs as a fresh build", () => {
  const pieces = ["$", "$x$", "\\textbf{", "}", "{", "\\cite{a}", "\\begin{itemize}\\item x\\end{itemize}", "\n\n", "\\section{S}", " text ", "\\ref{sec:intro}", "\\%", "--", "\\todo{t}", "\\eg"];
  const base = SAMPLE.slice(SAMPLE.indexOf("\\section{Introduction}"), SAMPLE.indexOf("\\begin{figure}"));
  fc.assert(fc.property(fc.array(fc.record({ at: fc.nat(), remove: fc.nat({ max: 6 }), insert: fc.constantFrom(...pieces) }), { maxLength: 6 }), (edits) => {
    const preamble = SAMPLE.slice(0, SAMPLE.indexOf("\\begin{document}") + 17);
    const view = mount(`${preamble}${base}\\end{document}\n`);
    try {
      for (const edit of edits) {
        const length = view.state.doc.length;
        const from = preamble.length + (edit.at % Math.max(1, length - preamble.length - 16));
        const to = Math.min(length - 16, from + edit.remove);
        view.dispatch({ changes: { from, to: Math.max(from, to), insert: edit.insert } });
        // When the parser finishes in the background, the app gets a transaction for it; so does this test.
        ensureSyntaxTree(view.state, view.state.doc.length, 5000);
        view.dispatch({});
      }
      const fresh = stateFor(view.state.doc.toString());
      assert.deepEqual(constructs(view.state), constructs(fresh));
    } finally {
      view.destroy();
    }
  }), { numRuns: 60 });
});

/** Applies `changes` incrementally and checks the result against a fresh build of the same text. */
function assertIncrementalMatchesFresh(doc: string, changes: Array<{ from: number; to?: number; insert?: string }>) {
  const view = mount(doc);
  view.dispatch({ changes });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  view.dispatch({});
  assert.deepEqual(constructs(view.state), constructs(stateFor(view.state.doc.toString())));
  view.destroy();
}

test("deleting at the end of the document rebuilds what it ended", () => {
  const doc = "Text $x$";
  assertIncrementalMatchesFresh(doc, [{ from: doc.length - 1, to: doc.length }]);
  assertIncrementalMatchesFresh("A \\textbf{b}", [{ from: 11, to: 12 }]);
});

test("a rebuild that grows keeps what its first part covered (a macro's second argument on the next line)", () => {
  const doc = String.raw`\documentclass{article}
\newcommand{\two}[2]{#1 and #2}
\begin{document}
Before \tw{$x$}
  {\textbf{b} $y$} after.
\end{document}
`;
  assertIncrementalMatchesFresh(doc, [{ from: doc.indexOf("\\tw{") + 3, insert: "o" }]);
});

test("text that becomes verbatim far from the edit stops being drawn", () => {
  const plain = "Plain words here. ".repeat(250);
  const doc = `\\begin{verbatix}\n${plain}\n\\textbf{SECRET} $x$\n\\end{verbatix}\nAfter.\n`;
  const first = doc.indexOf("verbatix");
  const second = doc.lastIndexOf("verbatix");
  assertIncrementalMatchesFresh(doc, [{ from: first, to: first + 8, insert: "verbatim" }, { from: second, to: second + 8, insert: "verbatim" }]);
  // And back: verbatim text that becomes ordinary text is drawn again.
  const back = doc.replace(/verbatix/g, "verbatim");
  assertIncrementalMatchesFresh(back, [{ from: first, to: first + 8, insert: "verbatix" }, { from: second, to: second + 8, insert: "verbatix" }]);
});

test("cursor moves, scrolling and mode switches never change the document", () => {
  fc.assert(fc.property(fc.array(fc.nat(), { maxLength: 30 }), (positions) => {
    const visual = new Compartment();
    const view = mount(SAMPLE, []);
    const before = view.state.doc.toString();
    for (const position of positions) view.dispatch({ selection: { anchor: position % (view.state.doc.length + 1) } });
    view.dispatch({ effects: visual.reconfigure([]) });
    const unchanged = view.state.doc.toString() === before;
    view.destroy();
    return unchanged;
  }), { numRuns: 25 });
});

test("switching modes keeps the document and its undo history", () => {
  const visual = new Compartment();
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc: "A \\textbf{b} c", extensions: [history(), latexLanguageSupport("main.tex", "tree"), latexVisualState(), visual.of([])] }) });
  view.dispatch({ changes: { from: 0, insert: "X" } });
  view.dispatch({ effects: visual.reconfigure(latexVisualMode({ documentPath: "nb/main.tex" })) });
  assert.ok(view.state.field(structuralField, false));
  view.dispatch({ effects: visual.reconfigure([]) });
  assert.equal(view.state.field(structuralField, false), undefined);
  assert.equal(view.state.doc.toString(), "XA \\textbf{b} c");
  undo(view);
  assert.equal(view.state.doc.toString(), "A \\textbf{b} c");
  view.destroy();
});

test("long documents are built in pieces, the part at the cursor first", () => {
  let body = "";
  for (let i = 0; body.length < LARGE_DOCUMENT * 1.5; i++) body += `\\section{Part ${i}}\nText with $x_${i}$ and \\textbf{bold ${i}}.\n\n`;
  const doc = `\\documentclass{article}\n\\begin{document}\n${body}\\end{document}\n`;
  // As in the app: Source mode has parsed the document when Visual mode starts.
  const visual = new Compartment();
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc, selection: { anchor: doc.length - 10 }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), visual.of([])] }) });
  ensureSyntaxTree(view.state, doc.length, 20_000);
  view.dispatch({ effects: visual.reconfigure(latexVisualMode({ documentPath: "nb/main.tex" })) });
  const value = view.state.field(structuralField);
  assert.ok(value.pending.length > 0, "the rest is pending");
  const near = constructs(view.state).filter((entry) => Number(entry.split(":")[1]) > doc.length - 8000);
  assert.ok(near.length > 0, "the part at the cursor is built");
  const builtHeadings = constructs(view.state).filter((entry) => entry.startsWith("heading:")).length;
  assert.ok(builtHeadings < (body.match(/\\section/g) ?? []).length / 2, "most of the document is not built yet");
  for (let guard = 0; view.state.field(structuralField).pending.length && guard < 60; guard++) {
    const next = view.state.field(structuralField).pending[0];
    view.dispatch({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) });
  }
  assert.equal(view.state.field(structuralField).pending.length, 0);
  const sections = (body.match(/\\section/g) ?? []).length;
  assert.equal(constructs(view.state).filter((entry) => entry.startsWith("heading:")).length, sections);
  assert.equal(constructs(view.state).filter((entry) => entry.startsWith("math:")).length, sections);
  assert.equal(constructs(view.state).filter((entry) => entry.startsWith("style:")).length, sections);
  view.destroy();
});

function fillPending(view: EditorView) {
  ensureSyntaxTree(view.state, view.state.doc.length, 20_000);
  view.dispatch({});
  for (let guard = 0; view.state.field(structuralField).pending.length && guard < 400; guard++) {
    const next = view.state.field(structuralField).pending[0];
    view.dispatch({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) });
  }
}

test("text the parser has not reached stays pending, even on one long line", () => {
  const doc = `\\documentclass{article}\n\\begin{document}\n${"Some \\textbf{bold} and $x$ text. ".repeat(8000)}\n\\end{document}`;
  const visual = new Compartment();
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), visual.of([])] }) });
  ensureSyntaxTree(view.state, 20_000, 50);
  view.dispatch({ effects: visual.reconfigure(latexVisualMode({ documentPath: "nb/main.tex" })) });
  const parsed = syntaxTree(view.state).length;
  assert.ok(parsed < doc.length, "the test needs a partial tree");
  const pending = view.state.field(structuralField).pending;
  assert.ok(pending.some((range) => range.from <= parsed && range.to >= doc.length - 20), `unparsed text is pending: ${JSON.stringify(pending)} (parsed ${parsed})`);
  view.destroy();
});

test("an edit inside a very long list walks its own lines now and the rest of the list later", () => {
  const doc = `\\documentclass{article}\n\\begin{document}\n\\begin{enumerate}\n${"\\item Text with $x$ and \\textbf{bold}.\n".repeat(5000)}\\end{enumerate}\nAfter $y$.\n\\end{document}\n`;
  const view = mount(doc);
  fillPending(view);
  const middle = view.state.doc.toString().indexOf("Text with", doc.length / 2);
  view.dispatch({ changes: { from: middle, insert: "plain " } });
  const parsed = syntaxTree(view.state).length;
  assert.ok(view.state.field(structuralField).pending.every((range) => range.from >= parsed), "plain typing needs nothing else (but what the parser has not reached)");
  view.dispatch({ changes: { from: middle, insert: "\\item new " } });
  assert.ok(view.state.field(structuralField).pending.some((range) => range.from < middle), "the rest of the list is left for later");
  ensureSyntaxTree(view.state, view.state.doc.length, 20_000);
  view.dispatch({});
  fillPending(view);
  const fresh = mount(view.state.doc.toString());
  fillPending(fresh);
  assert.deepEqual(constructs(view.state), constructs(fresh.state));
  view.destroy();
  fresh.destroy();
});

test("body text on the \\begin{document} line is not folded into the preamble", () => {
  const doc = "\\documentclass{article}\n\\begin{document}Hello world!\n\\end{document}";
  const view = mount(doc);
  assert.match(view.contentDOM.textContent ?? "", /Hello world!/);
  assert.equal(visualEntrySelection(view.state)?.head, doc.indexOf("Hello"));
  view.destroy();
});

test("editing \\title in the body redraws \\maketitle", () => {
  const view = mount("\\documentclass{article}\n\\begin{document}\n\\title{A}\n\\maketitle\nText.\n\\end{document}");
  assert.equal(view.contentDOM.querySelector(".cm-vis-title")?.textContent, "A");
  const at = view.state.doc.toString().indexOf("{A}") + 1;
  view.dispatch({ changes: { from: at, to: at + 1, insert: "B" } });
  assert.equal(view.contentDOM.querySelector(".cm-vis-title")?.textContent, "B");
  view.destroy();
});

/* ---- Title block editing -------------------------------------------------------- */

const TITLED = String.raw`\documentclass{article}
\title{Attention Is All You Need}
\author{Ashish Vaswani \\ Google Brain
  \and Noam Shazeer \\
  Google Research}
\date{June 2017}
\begin{document}
\maketitle
Text.
\end{document}`;

function titlePart(view: EditorView, part: string, index = 0) {
  return view.contentDOM.querySelectorAll<HTMLElement>(`.cm-vis-title-block [data-title-part="${part}"]`)[index];
}
const press = (target: Element, key: string, init: Record<string, unknown> = {}) => target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
const typeInto = (area: HTMLTextAreaElement, value: string) => { area.value = value; area.dispatchEvent(new window.Event("input", { bubbles: true })); };

test("the title block's parts map to their source in the preamble", () => {
  const state = stateFor(TITLED);
  const at = TITLED.indexOf("\\maketitle");
  const sources = titleSources(state, at, at + "\\maketitle".length);
  const text = (span: { from: number; to: number } | null) => (span ? state.sliceDoc(span.from, span.to) : null);
  assert.equal(text(sources.title), "Attention Is All You Need");
  assert.deepEqual(sources.authors.map(text), ["Ashish Vaswani \\\\ Google Brain", "Noam Shazeer \\\\\n  Google Research"]);
  assert.equal(text(sources.date), "June 2017");
  // acmart adds an author with each `\author`; LIPIcs' takes five arguments.
  const acm = stateFor("\\documentclass{acmart}\n\\title[Short]{Long}\n\\author{A}\n\\affiliation{X}\n\\author{B}\n\\begin{document}\n\\maketitle\n\\end{document}");
  const acmAt = acm.doc.toString().indexOf("\\maketitle");
  const acmSources = titleSources(acm, acmAt, acmAt + 10);
  assert.equal(acm.sliceDoc(acmSources.title!.from, acmSources.title!.to), "Long");
  assert.deepEqual(acmSources.authors.map((span) => acm.sliceDoc(span.from, span.to)), ["A", "B"]);
  const lipics = stateFor("\\documentclass{lipics-v2021}\n\\author{Dario Stein}{Radboud}{d@ru.nl}{}{}\n\\begin{document}\n\\maketitle\n\\end{document}");
  const lipicsAt = lipics.doc.toString().indexOf("\\maketitle");
  const [author] = titleSources(lipics, lipicsAt, lipicsAt + 10).authors;
  assert.equal(lipics.sliceDoc(author.from, author.to), "{Dario Stein}{Radboud}{d@ru.nl}{}{}");
});

test("clicking an author edits its LaTeX in place, and saving writes only that author as one undo step", () => {
  const view = mount(TITLED);
  const author = titlePart(view, "author", 1);
  assert.match(author.textContent ?? "", /Noam Shazeer/);
  author.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
  const area = view.contentDOM.querySelector<HTMLTextAreaElement>(".cm-vis-title-editor")!;
  assert.ok(area, "the author opens in an editor");
  assert.equal(area.value, "Noam Shazeer \\\\\n  Google Research");
  typeInto(area, "Noam Shazeer \\\\\n  Google DeepMind");
  press(area, "Enter");
  assert.equal(view.state.doc.toString(), TITLED.replace("Google Research", "Google DeepMind"));
  assert.match(titlePart(view, "author", 1).textContent ?? "", /Google DeepMind/);
  assert.equal(view.contentDOM.querySelector(".cm-vis-title-editor"), null);
  undo(view);
  assert.equal(view.state.doc.toString(), TITLED);
  view.destroy();
});

test("Escape writes nothing; Tab saves", () => {
  const view = mount(TITLED);
  titlePart(view, "title").dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
  let area = view.contentDOM.querySelector<HTMLTextAreaElement>(".cm-vis-title-editor")!;
  typeInto(area, "Something else");
  press(area, "Escape");
  assert.equal(view.state.doc.toString(), TITLED);
  assert.equal(titlePart(view, "title").textContent, "Attention Is All You Need");
  titlePart(view, "title").dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
  area = view.contentDOM.querySelector<HTMLTextAreaElement>(".cm-vis-title-editor")!;
  typeInto(area, "Attention Is Not All You Need");
  press(area, "Tab");
  assert.match(view.state.doc.toString(), /\\title\{Attention Is Not All You Need\}/);
  view.destroy();
});

test("Enter on the selected title block edits its title", () => {
  const view = mount(TITLED);
  const at = TITLED.indexOf("\\maketitle");
  view.dispatch({ selection: EditorSelection.range(at, at + "\\maketitle".length) });
  assert.ok(runScopeHandlers(view, new window.KeyboardEvent("keydown", { key: "Enter" }), "editor"));
  assert.equal(view.contentDOM.querySelector<HTMLTextAreaElement>(".cm-vis-title-editor")?.value, "Attention Is All You Need");
  view.destroy();
});

test("an edit to an affiliation on its own line of \\author redraws the title block", () => {
  const view = mount(TITLED);
  const at = TITLED.indexOf("Google Research");
  view.dispatch({ changes: { from: at + "Google ".length, to: at + "Google Research".length, insert: "Brain" } });
  assert.match(titlePart(view, "author", 1).textContent ?? "", /Google Brain/);
  view.destroy();
});

test("only the characters that changed are written", () => {
  assert.deepEqual(minimalChange(10, "Google Research", "Google DeepMind"), { from: 17, to: 25, insert: "DeepMind" });
  assert.deepEqual(minimalChange(0, "aa", "aaa"), { from: 2, to: 2, insert: "a" });
});

test("a chapter's numbers start where its main file includes it", () => {
  const view = mount("\\subsection{Attention}\\label{sec:att}\n\\begin{equation}x\\label{eq:x}\\end{equation}");
  view.dispatch({ effects: setNumberingStart.of({ counters: { section: 3, equation: 4 }, appendix: false }) });
  const state = view.state;
  const numbering = computeLatexNumbering(syntaxTree(state), (from, to) => state.doc.sliceString(from, to), visualDefinitions(state), { start: { counters: { section: 3, equation: 4 }, appendix: false } });
  assert.equal(numbering.labels.get("sec:att")?.number, "3.1");
  assert.equal(numbering.labels.get("eq:x")?.number, "5");
  assert.ok(view.state.field(numberingField, false));
  view.destroy();
});

/* ---- Table editing with collaborators -------------------------------------------- */

const GRID = String.raw`Before.
\begin{tabular}{lc}
\multicolumn{2}{c}{ a } \\
Base & 27.3
\end{tabular}
`;

function cellElement(view: EditorView, text: string) {
  const cell = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-table-cell")].find((element) => element.textContent?.trim() === text);
  assert.ok(cell, `cell ${text} is drawn`);
  return cell!;
}

test("opening and leaving a cell without typing writes nothing", () => {
  const view = mount(GRID);
  const cell = cellElement(view, "a");
  cell.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
  assert.equal(isEditingCell(cell), true);
  assert.equal(cell.textContent, " a ");
  cell.dispatchEvent(new dom.window.FocusEvent("blur"));
  assert.equal(view.state.doc.toString(), GRID);
  view.destroy();
});

test("a cell edit follows its cell through a collaborator's edit before the table", () => {
  const view = mount(GRID);
  const cell = cellElement(view, "27.3");
  cell.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
  // A collaborator inserts text before the table while the cell is open.
  view.dispatch({ changes: { from: 0, insert: "Inserted by someone else. " } });
  cell.textContent = "28.4";
  cell.dispatchEvent(new dom.window.Event("input"));
  cell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(view.state.doc.toString(), `Inserted by someone else. ${GRID.replace("27.3", "28.4")}`);
  view.destroy();
});

test("a table menu command is planned against the table as it is when chosen", () => {
  const view = mount(GRID);
  const cell = cellElement(view, "27.3");
  cell.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const menu = document.querySelector(".cm-vis-table-menu")!;
  view.dispatch({ changes: { from: 0, insert: "Moved. " } });
  const insertBelow = [...menu.querySelectorAll("button")].find((button) => button.textContent === "Insert row below")!;
  insertBelow.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(view.state.doc.toString(), `Moved. ${GRID.replace("Base & 27.3", String.raw`Base & 27.3 \\` + "\n&")}`);
  view.destroy();
});

test("switching to Visual mode with a parse ahead of the state's tree builds only around the cursor", () => {
  const paragraph = "A paragraph with $x^2$ and \textbf{bold} text.\n\n";
  const doc = `\documentclass{article}\n\begin{document}\n${paragraph.repeat(Math.ceil((LARGE_DOCUMENT * 3) / paragraph.length))}\end{document}\n`;
  const visual = new Compartment();
  let state = EditorState.create({ doc, selection: { anchor: Math.floor(doc.length / 2) }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), visual.of([])] });
  // Source mode parsed the whole file, but the state's tree is only updated by its next transaction.
  ensureSyntaxTree(state, doc.length, 20_000);
  state = state.update({ effects: visual.reconfigure(latexVisualMode({ documentPath: "nb/main.tex" })) }).state;
  const field = state.field(structuralField);
  assert.equal(field.treeLength, doc.length, "the build records the parse it used");
  const built = doc.length - field.pending.reduce((sum, range) => sum + range.to - range.from, 0);
  assert.ok(built < 3 * CHUNK, `only the part around the cursor is built at once (${built} characters were)`);
});
