import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { expandInChunks } from "../../src/lib/latex/codemirror/visual/table-model";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Tables, round 4: long tables whose cells use the document's macros, TeX assignment lines and row-helper definitions
 * around a table (arXiv 2611.10440 tables/tab04, 2611.11388 notation_table.tex). */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser", "MouseEvent", "KeyboardEvent"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function mount(doc: string) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 20_000);
  let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" })] });
  ensureSyntaxTree(state, doc.length, 20_000);
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state, parent });
  view.dispatch({ effects: setNumbering.of(computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state))) });
  refreshVisualWidgets(view);
  return { view, done: () => { view.destroy(); parent.remove(); } };
}

function revealedKinds(view: EditorView) {
  const value = view.state.field(structuralField);
  const out: string[] = [];
  value.extents.between(0, view.state.doc.length, (_from, _to, mark) => { if (value.revealed.has(mark.id)) out.push(mark.kind); });
  return out;
}

const PREAMBLE = String.raw`\documentclass{article}
\usepackage{longtable,booktabs}
\newcommand{\tms}{{\mkern1mu\times\mkern1mu}}
\newcommand{\Mach}[2]{\par\hangindent=1.2em\hangafter=1\noindent$\mathbf{#1}:#2$}
\newcommand{\Alt}[1]{\par\hangindent=0.8em\hangafter=1\noindent #1}
`;

/** 2611.10440 tab04: a longtable of `\Mach`/`\Alt` cells, long enough that expanding all of it in one go hits the expander's size limit. */
function machTable(rows: number) {
  const lines: string[] = [];
  for (let n = 0; n < rows; n++) {
    lines.push(String.raw`2a, ${n} & $${12510 + n}$ & \Alt{$5788 \to$ (i)}\Alt{$5834 \to$ (ii)--(iii)} & \Mach{12510}{12510}\Mach{7065}{4666 + 918 + 800 + 2\tms 286 + 59 + \mbox{$2\tms 19 + 3\tms 4$}}\Mach{7065}{4666 + 2\tms 800 + 2\tms 286 + 67 + 2\tms 59 + \mbox{$2\tms 19 + 4$}} \\`);
  }
  return String.raw`{\scriptsize
\medmuskip=3mu\relax % fixed spacing around + (no shrinking)
\relpenalty=10000\relax % never break right after the colon in \Mach
\setlength{\tabcolsep}{3.1pt}
\renewcommand{\arraystretch}{1.08}
\begin{longtable}{@{}>{\raggedright\arraybackslash}p{0.115\textwidth} r >{\raggedright\arraybackslash}p{0.172\textwidth} >{\raggedright\arraybackslash}p{0.395\textwidth}@{}}
\caption{Phase 3 endgame.}\label{tab:phase3a}\\
\toprule
Case, Step & Job & Valid / Transition & Offline witness schedule \\
\midrule
\endfirsthead
\multicolumn{4}{@{}l}{\small\emph{Phase 3 (continued)}}\\[2pt]
\endhead
\bottomrule
\endlastfoot
${lines.join("\n")}
\end{longtable}
}`;
}

test("2611.10440 tab04: a long longtable with macro cells is drawn as a table; the cells' macros are drawn, none shows as source", () => {
  const doc = `${PREAMBLE}\\begin{document}\n${machTable(100)}\n\\end{document}\n`;
  assert.ok(doc.length > 20_000, "longer than the expander's limit on one expansion");
  const { view, done } = mount(doc);
  const figure = view.contentDOM.querySelector(".cm-vis-figure-table");
  assert.ok(figure, "the longtable is a table widget");
  assert.equal(figure!.querySelector(".cm-vis-caption")?.textContent, "Table 1: Phase 3 endgame.");
  const cells = [...figure!.querySelectorAll("tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim()));
  // The head, then the 100 rows (the repeated head and the foot are not drawn).
  assert.equal(cells.length, 101);
  const last = cells.at(-1)!;
  assert.equal(last[0], "2a, 99");
  assert.match(last[3] ?? "", /^12510:125107065:4666\+918\+800\+2×286\+59\+2×19\+3×4/);
  // No paragraph-shape assignment, macro or `\mbox` is written out in the cells.
  assert.doesNotMatch(figure!.textContent ?? "", /\\[A-Za-z]{2,}|hangindent|hangafter|undefined/);
  // The setup lines before the table print nothing.
  assert.doesNotMatch(view.contentDOM.textContent ?? "", /medmuskip|relpenalty|arraystretch/);
  // Editable: a click on a cell shows the longtable's source.
  figure!.querySelectorAll("td")[2].dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
  assert.ok(revealedKinds(view).includes("table"), "a click shows the table's source");
  done();
});

test("2611.10440 tab02: TeX assignment lines (\\medmuskip, \\relpenalty) and \\renewcommand{\\arraystretch} fold away and show at the cursor", () => {
  const doc = `${PREAMBLE}\\begin{document}\nBefore.\n\n${machTable(2)}\n\\end{document}\n`;
  for (const [needle, shown] of [["\\medmuskip", "\\medmuskip=3mu\\relax"], ["\\relpenalty", "\\relpenalty=10000\\relax"], ["\\renewcommand{\\arraystretch}", "\\renewcommand{\\arraystretch}{1.08}"]] as const) {
    const { view, done } = mount(doc);
    assert.ok(!(view.contentDOM.textContent ?? "").includes(shown), `${needle} is folded`);
    // The cursor on the line shows its source again.
    view.dispatch({ selection: { anchor: doc.indexOf(needle) + 3 } });
    assert.ok(revealedKinds(view).includes("layout"), `${needle} line is revealed at the cursor`);
    assert.ok((view.contentDOM.textContent ?? "").includes(shown), `${needle} source is shown at the cursor`);
    done();
  }
});

test("a TeX assignment name without a value, and a text line starting with one, stay source", () => {
  const doc = `${PREAMBLE}\\begin{document}\n\\parindent is the paragraph indent.\n\n\\hangindent=2em\\relax\nText.\n\\end{document}\n`;
  const { view, done } = mount(doc);
  const text = view.contentDOM.textContent ?? "";
  assert.ok(text.includes("\\parindent is the paragraph indent"), "no value: not a setting line");
  assert.ok(!text.includes("\\hangindent=2em"), "a valued assignment folds away");
  view.dispatch({ selection: { anchor: doc.lastIndexOf("\\hangindent") + 2 } });
  assert.ok((view.contentDOM.textContent ?? "").includes("\\hangindent=2em\\relax"));
  done();
});

const NOTATION = String.raw`\documentclass{article}
\usepackage{longtable,booktabs}
\begin{document}
\begingroup
\renewcommand{\arraystretch}{1.12}
\newcommand{\ntrow}[3]{#1 & #2 & #3\\}
\newcommand{\ntgroup}[1]{\midrule\multicolumn{3}{@{}l}{\textbf{#1}}\\*\addlinespace[2pt]}
\newcommand{\plain}[1]{plain #1}
\begin{longtable}{@{}p{.2\textwidth}p{.6\textwidth}p{.14\textwidth}@{}}
\caption{Notation.}\label{tab:S-notation}\\
\toprule
Symbol & Meaning & Definition\\
\midrule
\endfirsthead
\bottomrule
\endlastfoot
\ntrow{$m,n$}{Array dimensions.}{Sec.~1}
\ntgroup{Graphs}
\ntrow{$G$}{A \plain{graph}.}{Sec.~2}
\end{longtable}
\endgroup
\end{document}
`;

test("2611.11388 notation_table.tex: row helpers (\\ntrow, \\ntgroup) and \\arraystretch fold away; rows are cells; a plain \\newcommand stays source", () => {
  const { view, done } = mount(NOTATION);
  const text = view.contentDOM.textContent ?? "";
  assert.ok(!text.includes("\\ntrow"), "the row helper's definition is folded");
  assert.ok(!text.includes("\\ntgroup"), "the group helper's definition is folded");
  assert.ok(!text.includes("\\renewcommand{\\arraystretch}"), "\\arraystretch is folded");
  // Round 5: every body definition is one inert unit, folded; one that writes no rows is source again at the caret.
  assert.ok(!text.includes("\\newcommand{\\plain}"), "a definition that writes no rows is folded too");
  view.dispatch({ selection: { anchor: NOTATION.indexOf("\\newcommand{\\plain}") + 4 } });
  assert.ok((view.contentDOM.textContent ?? "").includes("\\newcommand{\\plain}[1]{plain #1}"), "a definition that writes no rows is still source at the caret");
  view.dispatch({ selection: { anchor: 0 } });
  const figure = view.contentDOM.querySelector(".cm-vis-figure-table")!;
  const rows = [...figure.querySelectorAll("tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim()));
  assert.deepEqual(rows.slice(0, 1), [["Symbol", "Meaning", "Definition"]]);
  assert.deepEqual(rows.slice(1).map((row) => row.length), [3, 1, 3]);
  assert.equal(rows[2][0], "Graphs");
  assert.equal(rows[3][1], "A plain graph.");
  // The definitions come back as source at the cursor.
  for (const needle of ["\\newcommand{\\ntrow}", "\\newcommand{\\ntgroup}", "\\renewcommand{\\arraystretch}"]) {
    view.dispatch({ selection: { anchor: NOTATION.indexOf(needle) + 4 } });
    assert.ok(revealedKinds(view).includes("layout"), `${needle} is revealed at the cursor`);
    assert.ok((view.contentDOM.textContent ?? "").includes(needle), `${needle} source is shown`);
  }
  // Editable: a click on the table shows its source.
  view.dispatch({ selection: { anchor: 0 } });
  figure.querySelectorAll("td")[0].dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
  assert.ok(revealedKinds(view).includes("table"));
  done();
});

test("one macro the expander cannot take leaves that line as written; the table and its other rows are still drawn", () => {
  const doc = String.raw`\documentclass{article}
\usepackage{longtable,booktabs}
\newcommand{\row}[2]{#1 & #2\\}
\DeclareMathOperator{\bad}{bad}
\begin{document}
\begin{longtable}{ll}
\endhead
\row{a}{first}
\row{b}{\bad}
\row{c}{third}
\end{longtable}
\end{document}
`;
  const { view, done } = mount(doc);
  const figure = view.contentDOM.querySelector(".cm-vis-figure-table");
  assert.ok(figure, "the table is drawn");
  const text = figure!.textContent ?? "";
  assert.ok(text.includes("first") && text.includes("third"), "the other rows are drawn");
  assert.ok(text.includes("\\bad"), "the one macro it cannot take is left as source");
  done();
});

test("expandInChunks: a body past the chunk size is expanded piece by piece; an unreadable line stays as written", () => {
  const expand = (text: string) => (text.includes("BAD") ? null : text.replace(/\\r\{(\w+)\}/g, "$1 &\\\\"));
  const lines = Array.from({ length: 800 }, (_, n) => (n === 400 ? "\\r{BAD}" : `\\r{row${n}}`));
  const out = expandInChunks(lines.join("\n"), expand);
  const result = out.split("\n");
  assert.equal(result.length, 800);
  assert.equal(result[0], "row0 &\\\\");
  assert.equal(result[400], "\\r{BAD}");
  assert.equal(result[799], "row799 &\\\\");
  // A call whose argument is on the next line is expanded joined.
  const joined = expandInChunks("\\r\n{a}\n".repeat(1000), (text) => (/^(\\r\n\{a\}\n)+$/.test(text) ? text.replace(/\\r\n\{a\}\n/g, "A&\\\\\n") : null));
  assert.ok(!joined.includes("\\r"));
});
