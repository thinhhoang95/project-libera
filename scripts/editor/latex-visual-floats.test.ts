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
  // tikz-cd in a numbered equation: KaTeX cannot draw it, so it stays source.
  const equation = inDocument("\\begin{equation}\\begin{tikzcd} A \\arrow[r] & B \\end{tikzcd}\\label{eq:cospan}\\end{equation}");
  assert.equal(constructs(visualState(equation)).some((item) => item.startsWith("math:")), false);
});
