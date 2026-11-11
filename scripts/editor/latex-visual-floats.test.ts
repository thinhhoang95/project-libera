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
import { renderLatexFragment } from "../../src/lib/latex/codemirror/visual/render-fragment";
import { readLatexDefinitions } from "../../src/lib/latex/macros/definitions";
import { EMPTY_AUX } from "../../src/lib/latex/aux-file";
import { computeLatexNumbering, EMPTY_NUMBERING } from "../../src/lib/latex/macros/numbering";

/* Floats, tables, captions and boxes as real papers write them (batches 4–7: the minimum-wage paper 2403.17206, the
 * cannabis pass-through paper 2303.10367, the HANK paper 2403.00471, Self-RAG 2310.11511, Depth Anything 2401.10891,
 * Neyshabur's thesis 1709.01953, the QMA₁ paper 2411.02681). Each test is the smallest source showing the problem. */

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

/** What a mounted Visual mode shows for `doc`: its text (widgets' included), numbered as the app numbers it, and the source it shows as code. */
function mounted(doc: string, extra: Extension[] = []) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, extra), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  const text = view.contentDOM.textContent ?? "";
  const raw = [...view.contentDOM.querySelectorAll(".cm-vis-raw")].map((node) => node.textContent ?? "");
  const html = view.contentDOM.innerHTML;
  view.destroy();
  parent.remove();
  return { text, raw, html };
}

/** Whether `doc` has a float drawn whole. */
function drawnFloats(doc: string) {
  return constructs(visualState(doc)).filter((item) => item.startsWith("figure:")).length;
}

/** A fragment (caption, cell, macro expansion) as HTML, with the preamble's definitions. */
function fragment(preamble: string, latex: string) {
  const defs = readLatexDefinitions(`${preamble}\n\\begin{document}\\end{document}`);
  const div = document.createElement("div");
  div.append(renderLatexFragment(latex, { defs, numbering: EMPTY_NUMBERING, aux: EMPTY_AUX, bib: () => null } as never));
  return div;
}

const inDocument = (body: string, preamble = "") => `${preamble}\\begin{document}\n${body}\n\\end{document}\n`;

test("B4-05: floatrow's \\floatfoot before the caption, a \\rule line and \\hfil between panels keep the float drawn", () => {
  const floatfoot = inDocument("\\begin{figure}\n\\includegraphics{a.png}\n\\floatfoot{Notes: The figure shows things.}\n\\caption{A figure}\n\\end{figure}");
  assert.equal(drawnFloats(floatfoot), 1);
  assert.match(mounted(floatfoot).text, /Figure 1: A figureNotes: The figure shows things\./);
  // The cannabis paper: sub-figures side by side with `\hfil`, then `\par \bigskip \rule{\textwidth}{0.4pt}` and a notes minipage.
  const ruled = inDocument(String.raw`\begin{figure}[!htbp]
\caption{Inflation rates}
\centering
\begin{subfigure}{0.5\textwidth}\centering\includegraphics[width=\linewidth]{a.png}\caption{Wholesale}\label{fig:1a}\end{subfigure}\hfil
\begin{subfigure}{0.5\textwidth}\centering\includegraphics[width=\linewidth]{b.png}\caption{Retail}\label{fig:1b}\end{subfigure}
\label{fig:1}
\par \bigskip
\rule{\textwidth}{0.4pt}
\begin{minipage}[h]{\textwidth}
\medskip
\small Notes: The figures show the distribution.
\end{minipage}
\end{figure}`);
  assert.equal(drawnFloats(ruled), 1);
  const text = mounted(ruled).text;
  // The notes are under the panels, though the caption is above them.
  assert.match(text, /Figure 1: Inflation ratesa\.png\(a\) Wholesaleb\.png\(b\) RetailNotes: The figures show the distribution\./);
  assert.doesNotMatch(text, /\\rule|\\par|\\small/);
});

test("B4-05: threeparttable notes inside \\resizebox are drawn under the table, without the wrapper's brace", () => {
  const doc = inDocument(String.raw`\begin{table}
\centering
\caption{Weighted summary statistics}
\resizebox{1\textwidth}{!}{
\begin{threeparttable}
\begin{tabular}{lr}
a & 18.10 \\
\end{tabular}
\begin{tablenotes}
\begin{small} \textit{Notes:} Weighted sample averages.
\end{small}
\end{tablenotes}
\end{threeparttable}
}
\end{table}`);
  assert.equal(drawnFloats(doc), 1);
  const { text, raw } = mounted(doc);
  assert.match(text, /Table 1: Weighted summary statistics.*Notes: Weighted sample averages\.$/);
  assert.deepEqual(raw.filter((item) => item.trim()), []);
});

test("B4-05: notes written between a table and a caption at its end (\\par\\vspace… Notes: …) are drawn under the caption", () => {
  const doc = inDocument("\\begin{table}\n\\centering\n\\begin{tabular}{lc}\na & 1 \\\\\n\\end{tabular}\n\\par\\vspace{2mm} \\footnotesize Notes: Standard errors in parentheses.\n\\caption{Effects}\n\\label{tab:x}\n\\end{table}");
  assert.equal(drawnFloats(doc), 1);
  assert.match(mounted(doc).text, /a1Table 1: EffectsNotes: Standard errors in parentheses\.$/);
  // A label and space there are no note.
  const plain = inDocument("\\begin{figure}\n\\includegraphics{a.png}\n\\label{fig:a}\n\\vspace{-2mm}\n\\caption{Only a label before}\n\\end{figure}");
  assert.match(mounted(plain).text, /a\.pngFigure 1: Only a label before$/);
});

test("B4-30: \\captionsetup[figure]{name=…} and \\renewcommand{\\tablename} rename the captions' labels", () => {
  const doc = inDocument("\\begin{figure}\n\\includegraphics{a.png}\n\\caption{Renamed}\n\\end{figure}\n\\begin{table}\n\\caption{Also}\n\\begin{tabular}{l}\nx \\\\\n\\end{tabular}\n\\end{table}",
    "\\captionsetup[figure]{labelfont={bf},labelsep=period,name={Fig.}}\n\\renewcommand{\\tablename}{Tab.}\n");
  assert.match(mounted(doc).text, /Fig\. 1: Renamed.*Tab\. 1: Also/);
});

test("B4-05: acmart's \\Description and \\singlespace after a float's content are not notes", () => {
  const doc = inDocument("\\begin{figure}\n\\includegraphics{map.png}\n\\caption{The map}\n\\Description{The labeled map of the game world.}\n\\singlespace\n\\end{figure}");
  const { text, raw } = mounted(doc);
  assert.match(text, /Figure 1: The map/);
  assert.doesNotMatch(text, /labeled map|singlespace/);
  assert.deepEqual(raw, []);
});

test("B6-05/B5-12: \\textcolor[HTML], \\colorbox[rgb], {\\color{red} …} and \\color[HTML] switches in cells and captions are coloured", () => {
  const colored = fragment("", String.raw`\textcolor[HTML]{1F77B4}{blue} {\color{red} red} \colorbox[rgb]{1,0,0}{boxed} plain \color[HTML]{222222} grey`);
  const spans = [...colored.querySelectorAll<HTMLElement>(".cm-vis-color, .cm-vis-colorbox")];
  assert.deepEqual(spans.map((span) => [span.textContent?.trim(), span.style.color || span.style.backgroundColor]), [
    ["blue", "rgb(31, 119, 180)"], ["red", "rgb(220, 38, 38)"], ["boxed", "rgb(255, 0, 0)"], ["grey", "rgb(34, 34, 34)"],
  ]);
  assert.equal(colored.querySelectorAll(".cm-vis-raw").length, 0);
  assert.match(colored.textContent ?? "", /plain/);
  // A colour it does not know stays source.
  assert.equal(fragment("", "\\color{nosuchcolor} x").querySelector(".cm-vis-raw")?.textContent, "\\color{nosuchcolor}");
  // Font selection draws nothing.
  const fonts = fragment("", String.raw`\fontfamily{ptm}\selectfont Times \usefont{T1}{ptm}{m}{n}x`);
  assert.equal(fonts.textContent?.replace(/\s+/g, " ").trim(), "Times x");
  // In a table: drawn as a grid, the colours applied.
  const table = inDocument(String.raw`\begin{table}
\caption{Colours}
\begin{tabular}{ll}
\textcolor[HTML]{1F77B4}{blue} & {\color{red} red} \\
\end{tabular}
\end{table}`);
  const { text, raw } = mounted(table);
  assert.match(text, /Table 1: Coloursblue red/);
  assert.deepEqual(raw, []);
});

test("B6-17: a footnote in a cell, a caption or a macro keeps its text; \\blfootnote is not numbered", () => {
  const cell = fragment("", "x\\footnote{A note in a cell.}");
  assert.equal(cell.querySelector(".cm-vis-footnote-mark")?.textContent, "*");
  assert.equal(cell.querySelector(".cm-vis-footnote")?.textContent, "A note in a cell.");
  const preamble = String.raw`\newcommand\blfootnote[1]{\begingroup\renewcommand\thefootnote{}\footnote{#1}\addtocounter{footnote}{-1}\endgroup}`;
  const unmarked = fragment(preamble, "\\blfootnote{Work was done during an internship.}This");
  assert.equal(unmarked.querySelector(".cm-vis-footnote-mark")?.textContent, "*");
  assert.equal(unmarked.querySelector(".cm-vis-footnote")?.textContent, "Work was done during an internship.");
  // Numbered as the text's footnotes are, in a table cell.
  const doc = inDocument("Text\\footnote{First.}\n\\begin{table}\n\\caption{T}\n\\begin{tabular}{l}\nx\\footnote{In a cell.} \\\\\n\\end{tabular}\n\\end{table}");
  assert.match(mounted(doc).text, /x2In a cell\./);
  // In the text, through a macro (Depth Anything's abstract).
  assert.match(mounted(inDocument("\\blfootnote{Work was done during an internship at TikTok.}This work presents", preamble)).text, /\*Work was done during an internship at TikTok\.This work presents/);
});

test("B4-06: \\include of a table body inside a float is a placeholder naming the file", () => {
  const doc = inDocument("\\begin{table}[!htbp]\n\\centering\n\\caption{Descriptive statistics}\n\\label{tab:1}\n\\include{tables/establishment_descriptive_statistics}\n\\end{table}");
  assert.equal(drawnFloats(doc), 1);
  assert.match(mounted(doc).text, /Table 1: Descriptive statisticstables\/establishment_descriptive_statistics\.texDrawn in the PDF/);
});

test("B4-07: \\captionsetup and \\caption* notes beside a caption are a note, written out or through a macro", () => {
  const preamble = String.raw`\newcommand\fignote[1]{\captionsetup{font=footnotesize}\caption*{\textit{Note:} #1}}`;
  const macro = inDocument("\\begin{figure}\n\\centering\n\\caption{Model responses}\n\\includegraphics{a.pdf}\n\\fignote{The figures display the output.}\n\\end{figure}", preamble);
  const written = inDocument("\\begin{figure}\n\\centering\n\\includegraphics{a.pdf}\n\\caption{Responses}\n\\captionsetup{font=small}\n\\caption*{Notes: written out.}\n\\end{figure}");
  for (const [doc, note] of [[macro, /Figure 1: Model responsesa\.pdfNote: The figures display the output\./], [written, /a\.pdfFigure 1: ResponsesNotes: written out\./]] as const) {
    assert.equal(drawnFloats(doc), 1);
    const { text, raw } = mounted(doc);
    assert.match(text, note);
    assert.deepEqual(raw, []);
  }
});

test("B4-18: \\phantom keeps its space unseen, \\vphantom draws nothing, \\newline in \\textit breaks the line", () => {
  const phantom = fragment("", "18.10\\phantom{0} x\\vphantom{y}");
  assert.equal(phantom.querySelector<HTMLElement>(".cm-vis-phantom")?.style.visibility, "hidden");
  assert.equal(phantom.querySelector(".cm-vis-phantom")?.textContent, "0");
  assert.doesNotMatch(phantom.textContent ?? "", /y/);
  const broken = fragment("", "\\textit{a\\newline b}");
  assert.equal(broken.querySelector("em")?.innerHTML, "a<br>b");
});

test("B5-08: a picture of labels over a figure's images is an overlay: the images are drawn, with a note", () => {
  const doc = inDocument(String.raw`\begin{figure}[t]
\centering
\includegraphics[width=.245\textwidth]{a.pdf}
\includegraphics[width=.245\textwidth]{b.pdf}
\begin{picture}(0,0)(0,0)
{\small \put(-162, 90){$\ell_2$ norm}\put(-70, 90){$\ell_1$-path norm}}
\end{picture}
\caption{Comparing measures.}
\end{figure}`);
  assert.equal(drawnFloats(doc), 1);
  const { text, raw } = mounted(doc);
  assert.match(text, /a\.pdfb\.pdf\+ overlay \(labels drawn in the PDF\)Figure 1: Comparing measures\./);
  assert.deepEqual(raw, []);
  // A picture after the caption is not read as notes.
  const after = inDocument("\\begin{figure}\n\\includegraphics{a.pdf}\n\\caption{C}\n\\begin{picture}(0,0)(0,0)\\put(1,2){label}\\end{picture}\n\\end{figure}");
  assert.match(mounted(after).text, /a\.pdf\+ overlay \(labels drawn in the PDF\)Figure 1: C$/);
});

test("B6-11: a tcolorbox in a table* is drawn as a framed box with its parts, and the float with its caption", () => {
  const doc = inDocument(String.raw`\begin{table*}[h!]
\begin{tcolorbox}
{\bf Instructions}\\
Given an instruction, judge.
\tcblower
{\bf Demonstrations}  \\
{\bf Instruction} Give three tips. \\
\end{tcolorbox}
\caption{\label{tab:algo_box} Instructions for retrieval.}
\end{table*}`);
  assert.equal(drawnFloats(doc), 1);
  const { text, raw, html } = mounted(doc);
  assert.match(text, /Instructions Given an instruction, judge\.Demonstrations\s+Instruction Give three tips\.\s*Table 1:\s+Instructions for retrieval\./);
  assert.equal((html.match(/cm-vis-figure-box-part/g) ?? []).length, 2);
  assert.deepEqual(raw, []);
});

test("B7-22: quantikz circuits, tikz-cd diagrams and a TikZ file input in a formula are placeholders in a float", () => {
  const circuit = inDocument("\\begin{figure}[h]\n\\centering\n\\begin{quantikz}\n& \\ctrl{2} & \\qw \\\\\n& \\targ{} & \\qw\n\\end{quantikz}\n\\caption{Toffoli gate}\n\\end{figure}");
  const input = inDocument("\\begin{figure}[h]\n\\centering\n\\[ \\input{dict.tikz} \\]\n\\caption{Dictionary}\n\\end{figure}");
  const square = inDocument("\\begin{figure}\n\\[\\begin{tikzcd} A \\arrow[r] & B \\end{tikzcd}\\]\n\\caption{Square}\n\\end{figure}");
  const expected = [/Diagram \(quantikz\)Drawn in the PDFFigure 1: Toffoli gate/, /dict\.tikzDrawn in the PDFFigure 1: Dictionary/, /Diagram \(tikz-cd\)Drawn in the PDFFigure 1: Square/];
  [circuit, input, square].forEach((doc, index) => {
    assert.equal(drawnFloats(doc), 1);
    assert.match(mounted(doc).text, expected[index]);
  });
  // tikz-cd in a numbered equation: a simple diagram is drawn as a KaTeX array (math-diagram.ts, audit round 3, math.AG 2611.06861).
  const equation = inDocument("\\begin{equation}\\begin{tikzcd} A \\arrow[r] & B \\end{tikzcd}\\label{eq:cospan}\\end{equation}");
  assert.equal(constructs(visualState(equation)).some((item) => item.startsWith("math:")), true);
});

test("B6-11: a tcolorbox, an mdframed and a \\newtcolorbox box in the text are framed lines, with the title and \\tcblower", () => {
  const doc = inDocument(String.raw`\begin{tcolorbox}[title=Prompt for QA]
Answer the question.
\tcblower
Question: x
\end{tcolorbox}
\begin{mdframed}
Framed text.
\end{mdframed}
\begin{prompt}[NarrativeQA]
You are given a story.
\end{prompt}`, "\\newtcolorbox{prompt}[1][]{colback=gray!5, title=#1}\n");
  const { text, html } = mounted(doc);
  assert.match(text, /Prompt for QAAnswer the question\.Question: xFramed text\.NarrativeQAYou are given a story\./);
  assert.doesNotMatch(text, /\\begin|\\end|tcblower/);
  // Three frames, each with a first and a last line.
  assert.equal((html.match(/cm-vis-box-first/g) ?? []).length, 3);
  assert.equal((html.match(/cm-vis-box-last/g) ?? []).length, 3);
  assert.equal((html.match(/cm-vis-box-lower/g) ?? []).length, 1);
});

test("B6-16: CVPR's teaser in \\twocolumn[{…}] and \\captionof outside floats are numbered captions", () => {
  const teaser = String.raw`\title{Depth Anything}
\begin{document}
\twocolumn[{
\maketitle
\begin{center}
    \captionsetup{type=figure}
    \includegraphics[width=1.0\textwidth, height=3.5cm]{figure/teaser.png}\vspace{-1mm}\\
    \captionof{figure}{Our model exhibits impressive generalization.}
    \label{fig:teaser}
\end{center}
}]
Text after.
\end{document}
`;
  const shown = mounted(teaser);
  assert.match(shown.text, /Depth Anythingfigure\/teaser\.pngFigure 1: Our model exhibits impressive generalization\.Text after\./);
  assert.doesNotMatch(shown.text, /twocolumn|\\begin|captionof|\}\]/);
  const loose = inDocument(String.raw`\begin{center}
\includegraphics[width=0.5\textwidth]{plot.png}
\captionof{figure}{A figure without a float.}
\label{fig:loose}
\end{center}
\begin{minipage}{\linewidth}
\captionof{table}{Panel table}
\begin{tabular}{ll}
a & b \\
\end{tabular}
\end{minipage}
\captionof{figure}{Alone on its line.}`);
  assert.equal(drawnFloats(loose), 3);
  assert.match(mounted(loose).text, /plot\.pngFigure 1: A figure without a float\.Table 1: Panel tableabFigure 2: Alone on its line\./);
});

test("B4-13: estout's \\newcolumntype{.} column, repeated with *{3}{.}, is read and aligned as dcolumn's", () => {
  const doc = inDocument("\\begin{tabular}{l*{3}{.}}\nx & 1.5 & 2.25 & 3.0 \\\\\n\\end{tabular}", "\\newcolumntype{.}{D{.}{.}{-1}}\n");
  assert.equal(constructs(visualState(doc)).filter((item) => item.startsWith("table:")).length, 1);
  assert.equal((mounted(doc).html.match(/text-align: right/g) ?? []).length, 3);
});

test("B4-19: commented-out row lines between and after rows are no rows", () => {
  for (const body of ["a & b \\\\\n% c & d \\\\\ne & f \\\\", "a & b \\\\\ne & f \\\\\n% c & d \\\\\n\\hline", "a & b \\\\ % c & d \\\\\ne & f % g"]) {
    const { html, raw } = mounted(inDocument(`\\begin{tabular}{ll}\n${body}\n\\end{tabular}`));
    assert.equal((html.match(/<tr/g) ?? []).length, 2, body);
    assert.deepEqual(raw, []);
  }
});

test("B4-20: a row read from another file (\\input{rows.tex} in the tabular) is a placeholder row", () => {
  const doc = inDocument("\\begin{tabular}{lcc}\n\\toprule\n& A & B \\\\\n\\hline\n  \\input{./tables/summary_stats_post.tex} \\\\\nx & 1 & 2 \\\\\n\\bottomrule\n\\end{tabular}");
  const { text, raw, html } = mounted(doc);
  assert.match(text, /ABRows from tables\/summary_stats_post\.texx12/);
  assert.deepEqual(raw, []);
  assert.match(html, /colspan="3"/);
});

test("B4-29..34: stargazer's \\\\[-1.8ex] rows, \\rotatebox in cells, and a tabular of rules only", () => {
  const stargazer = inDocument(String.raw`\begin{table}[!htbp] \centering
  \caption{Effects}
\begin{tabular}{@{\extracolsep{5pt}}lcc}
\\[-1.8ex]\hline
\hline \\[-1.8ex]
 & \multicolumn{2}{c}{\textit{Dependent variable:}} \\
\cline{2-3}
\\[-1.8ex] & (1) & (2)\\
\hline \\[-1.8ex]
 Trt & 0.090$^{*}$ & 0.133 \\
\hline \\[-1.8ex]
\end{tabular}
\end{table}`);
  const { html, text } = mounted(stargazer);
  // Three rows of text, no empty ones; the last rule closes the table.
  assert.equal((html.match(/<tr/g) ?? []).length, 3);
  assert.match(text, /Table 1: EffectsDependent variable:\(1\)\(2\)Trt0\.090∗0\.133/);
  assert.match(html, /cm-vis-table-closed/);
  const rotated = mounted(inDocument("\\begin{tabular}{lc}\n\\multirow{2}{*}{\\rotatebox[origin=c]{90}{Start age}} & a \\\\\n\\rotatebox{90}{Up} & b \\\\\n\\end{tabular}"));
  assert.match(rotated.text, /Start ageaUpb/);
  assert.deepEqual(rotated.raw, []);
  // A square turned by 45° in the text (the Econometrica paper's end of an example) is a diamond; other turns stay source.
  const diamond = mounted(inDocument("End. \\rotatebox[origin=c]{45}{$\\square$}\n\nNext \\rotatebox{90}{word}."));
  assert.match(diamond.text, /End\. ◇Next \\rotatebox\{90\}\{word\}\./);
  // Rules only: nothing to draw, it stays source.
  const rules = inDocument("\\begin{tabular}{ll}\n\\hline\n\\hline\n\\end{tabular}");
  assert.equal(constructs(visualState(rules)).some((item) => item.startsWith("table:")), false);
});

test("2611.08676: AASTeX's deluxetable is drawn as a numbered table with its head, rows and notes; \\plottwo figures as images", () => {
  const preamble = "\\documentclass{aastex701}\n";
  const table = inDocument(String.raw`\begin{deluxetable*}{lcc}[h!]\label{tab:params}
\tablecaption{Stellar Parameters}
\tablewidth{0pt}
\tabletypesize{\scriptsize}
\tablehead{
\colhead{Parameter} & \colhead{K2-141} & \colhead{NGTS-10}
}
\startdata
\sidehead{Literature}
Radius & $0.68\pm0.02$ & \nodata \\
% Bytes & 1 & 2 \\
Bytes & 1\phn--\phn9 & 11--19\tablenotemark{a} \\
\hline
\enddata
\tablenotetext{a}{From 2MASS.}
\tablecomments{A star marks adopted values.}
\tablerefs{(1) Malavolta 2018.}
\end{deluxetable*}`, preamble);
  assert.equal(drawnFloats(table), 1);
  const { text, html, raw } = mounted(table);
  assert.match(text, /Table 1: Stellar ParametersParameterK2-141NGTS-10LiteratureRadius0\.68±0\.02⋯Bytes1\u2007–\u2007911–19a/);
  assert.match(text, /aFrom 2MASS\.Note—A star marks adopted values\.References—\(1\) Malavolta 2018\./);
  assert.doesNotMatch(text, /Bytes12/);
  assert.match(html, /<sup>a<\/sup>/);
  assert.deepEqual(raw, []);
  // A command it does not know inside leaves it as source.
  assert.equal(drawnFloats(inDocument("\\begin{deluxetable}{l}\n\\tablecaption{A}\n\\mystery{x}\n\\startdata\na\n\\enddata\n\\end{deluxetable}", preamble)), 0);
  const plots = inDocument("\\begin{figure*}[h!]\n    \\epsscale{0.8}\n    \\plotone{a.pdf}\n    \\plottwo{b.pdf}{c.pdf}\n    \\caption{Spectra}\n    \\label{fig:spec}\n\\end{figure*}", preamble);
  assert.equal(drawnFloats(plots), 1);
  assert.match(mounted(plots).text, /a\.pdfb\.pdfc\.pdfFigure 1: Spectra/);
  // Outside AASTeX the commands are not known: they are source lines inside the drawn figure.
  const unknown = plots.replace("aastex701", "article");
  assert.equal(drawnFloats(unknown), 1);
  assert.match(mounted(unknown).raw.join("\n"), /\\plotone\{a\.pdf\}/);
});

test("hep-th 2611.10539, cond-mat 2611.08102: revtex's ruledtabular is a ruled table with its label-first caption; widetext is transparent", () => {
  const doc = inDocument(String.raw`\begin{table*}[!ht]
\caption{\label{tab:params}Parameters of the reference flows. Lengths in cells, $c_s$ the speed.}
\begin{ruledtabular}
\begin{tabular}{lcc}
Flow & $L$ & $T$\\
\hline
Shear & 64 & 100\\
\end{tabular}
\end{ruledtabular}
\end{table*}
\begin{widetext}
Wide text.
\end{widetext}`, "\\documentclass{revtex4-2}\n");
  assert.equal(drawnFloats(doc), 1);
  const { text, html } = mounted(doc);
  assert.match(text, /Table 1: Parameters of the reference flows\. Lengths in cells, cs.* the speed\.FlowLTShear64100Wide text\./);
  assert.match(html, /cm-vis-table-ruled/);
  assert.doesNotMatch(text, /tab:params|ruledtabular|widetext/);
});

test("stat.ME 2611.09678: a caption macro that boxes the table (\\tbl{caption}{tabular or \\input}) draws the table; \\begingroup lines fold", () => {
  const doc = inDocument(String.raw`\begin{table}[htbp]\small
\tbl{Networks and observation design.}
{\begin{tabular}{lrr}\toprule
 & EMA & Chicago\\\midrule
Zones & 74 & 387\\\bottomrule
\end{tabular}}
\label{tab:networks}
\end{table}
\begin{table}[htbp]
\tbl{Primary comparisons.}{\input{tables/tab_primary.tex}}
\label{tab:primary}
\end{table}
\begingroup\footnotesize\setlength{\tabcolsep}{4pt}
Text.
\endgroup`, "\\newcommand{\\tbl}[2]{\\caption{#1}\\noindent\\makebox[\\linewidth]{#2}}\n");
  assert.equal(drawnFloats(doc), 2);
  const { text, raw } = mounted(doc);
  assert.match(text, /Table 1: Networks and observation design\.EMAChicagoZones74387Table 2: Primary comparisons\.tables\/tab_primary\.tex.*Text\.$/);
  assert.doesNotMatch(text, /begingroup|endgroup|tabcolsep/);
  assert.deepEqual(raw.filter((item) => item.trim()), []);
  // A caption macro writing more than a box of its arguments stays source.
  const other = inDocument("\\begin{table}\n\\tbl{Caption}{\\begin{tabular}{l}\nx \\\\\n\\end{tabular}}\n\\end{table}", "\\newcommand{\\tbl}[2]{\\caption{#1}Text \\makebox{#2}}\n");
  assert.equal(drawnFloats(other), 0);
});

test("cs.CL 2611.11838: boxes of text around a \\dimexpr-wide minipage, written out or by a macro, are drawn as framed text in a figure", () => {
  const doc = inDocument(String.raw`\begin{figure}[t]
\centering
\setlength{\fboxsep}{4pt}
\begin{minipage}{\linewidth}
\noindent\colorbox{promptcolor}{%
\begin{minipage}{\dimexpr\linewidth-2\fboxsep\relax}
\raggedright
\textbf{Prompt:} When was the \emph{current Dalai Lama} born?
\end{minipage}}

\genbox{basecolor}{No intervention}{%
There is \textbf{no ambiguity}.
}
\end{minipage}
\caption{Qualitative evaluation.}
\label{fig:dalai}
\end{figure}
\begin{figure}
\fbox{\begin{minipage}{\dimexpr\linewidth-2\fboxsep\relax}
Some prompt text.
\end{minipage}}
\caption{Framed.}
\end{figure}`, String.raw`\usepackage{xcolor}
\newcommand{\genbox}[3]{%
    \vspace{0.2em}
    \noindent\colorbox{#1}{%
    \begin{minipage}{\dimexpr\linewidth-2\fboxsep\relax}
    \raggedright
    \textbf{#2:} {\itshape #3}
    \end{minipage}}%
}
`);
  assert.equal(drawnFloats(doc), 2);
  const { text, html, raw } = mounted(doc);
  assert.match(text, /Prompt: When was the current Dalai Lama born\?\s*No intervention:\s*There is no ambiguity\.\s*Figure 1: Qualitative evaluation\.Some prompt text\.Figure 2: Framed\./);
  assert.equal((html.match(/cm-vis-figure-box"/g) ?? []).length, 3);
  assert.deepEqual(raw.filter((item) => item.trim()), []);
});

test("layout and numbering state in the body folds away: \\appendix, \\renewcommand{\\the…}, \\setcounter, \\twocolumn, \\frenchspacing (stat.ME 2611.09678, cs.CL 2611.11838)", () => {
  const doc = inDocument(String.raw`\frenchspacing
Text.
\clearpage
\appendix
\renewcommand{\thesection}{A\arabic{section}}
\renewcommand{\theequation}{S\arabic{equation}}
\setcounter{equation}{0}
\section{More}
\begin{equation}x=1\label{eq:s}\end{equation}
\twocolumn
\renewcommand{\foo}{bar}
\twocolumn[Kept text]`);
  // Only another command's definition stays source; `\twocolumn[Kept text]` is a transparent wrapper (round 4, MLSys 2611.13560).
  const { text } = mounted(doc);
  assert.match(text, /Text\.A1\W*More/);
  assert.match(text, /\\renewcommand\{\\foo\}\{bar\}Kept text$/);
  assert.doesNotMatch(text, /frenchspacing|clearpage|appendix|thesection|theequation|setcounter|twocolumn\\/);
  // Numbering reads the lines that folded away.
  const state = visualState(doc);
  const numbering = computeLatexNumbering(syntaxTree(state), (from, to) => state.doc.sliceString(from, to), visualDefinitions(state));
  assert.equal(numbering.labels.get("eq:s")?.number, "S1");
});
