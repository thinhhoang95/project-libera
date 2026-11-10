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
import {
  addRule, macroRowReadings, mergeCells, moveColumn, moveRow, parseTabular, readTableSettings, removeRules, safeCellText, setColumnAlignment, splitCell, type TableChange,
} from "../../src/lib/latex/codemirror/visual/table-model";
import { openTableMenu } from "../../src/lib/latex/codemirror/visual/table-edit";

/* Tables: a cell or row that cannot be drawn falls back alone, ragged tables stay drawn, the table commands
 * (merge, split, alignment, rules, moving rows and columns), what `\rowcolors`, `\arraystretch` and friends mean in
 * the grid, and a table being typed staying source until it is complete. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser", "MouseEvent", "KeyboardEvent"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
Object.defineProperty(globalThis, "alert", { value: () => undefined, configurable: true });
dom.window.alert = () => undefined;
after(() => dom.window.close());

/** Builds every pending piece of the structural layer. */
function built(state: EditorState) {
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

function visualState(doc: string, extra: Extension[] = []) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  const state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }), ...extra] });
  ensureSyntaxTree(state, doc.length, 5000);
  return built(state);
}

function constructs(state: EditorState) {
  const list: string[] = [];
  state.field(structuralField).extents.between(0, state.doc.length, (from, to, mark) => { list.push(`${mark.kind}:${from}:${to}`); });
  return list;
}

/** A mounted view (the caller destroys it). */
function mount(doc: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc), parent });
  view.dispatch({ effects: setNumbering.of(computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state))) });
  refreshVisualWidgets(view);
  return { view, done: () => { view.destroy(); parent.remove(); } };
}

/** The grid drawn for `doc`, as an element detached from the (destroyed) view. */
function grid(doc: string) {
  const { view, done } = mount(doc);
  const table = view.contentDOM.querySelector(".cm-vis-table")?.cloneNode(true) as HTMLTableElement | undefined;
  done();
  return table ?? null;
}

const inDocument = (body: string, preamble = "") => `${preamble}\\begin{document}\n${body}\n\\end{document}\n`;

function apply(source: string, changes: TableChange[] | null) {
  assert.ok(changes, "a plan");
  let out = source;
  for (const change of [...changes].sort((a, b) => b.from - a.from)) out = out.slice(0, change.from) + change.insert + out.slice(change.to);
  return out;
}

/* ---- 1. Fail at the smallest unit ------------------------------------------------------------------------------- */

const ROW_MACRO = String.raw`\newcommand{\row}[2]{#1 & #2 \\}`;

test("a row written through a macro is drawn from its expansion; the other rows stay editable cells", () => {
  const table = String.raw`\begin{tabular}{ll}
x & y \\
\row{a}{b}
\\
c & d
\end{tabular}`;
  const readings = macroRowReadings(table, (text) => text.replace(/\\row\{(\w)\}\{(\w)\}/g, "$1 & $2 \\\\"));
  assert.deepEqual(Object.keys(readings ?? {}), ["1"]);
  const drawn = grid(inDocument(table, ROW_MACRO))!;
  assert.ok(drawn);
  assert.equal(drawn.dataset.readonly, undefined, "the table is not read-only as a whole");
  const editable = [...drawn.querySelectorAll<HTMLElement>(".cm-vis-table-cell[data-row]")].map((td) => td.textContent);
  assert.deepEqual(editable, ["x", "y", "c", "d"]);
  // `\row{a}{b}` then `\\`: its row, then an empty one, as TeX sets them.
  assert.deepEqual([...drawn.querySelectorAll(".cm-vis-table-macro")].map((td) => td.textContent), ["a", "b", ""]);
});

test("a cell-level macro (a \\multirow written by \\blocka) is not a macro row", () => {
  const table = String.raw`\begin{tabular}{ll}
\blocka{64}{3} & y \\
\end{tabular}`;
  assert.equal(macroRowReadings(table, (text) => text.replace(/\\blocka\{(\d+)\}\{(\d+)\}/, "\\multirow{$2}{*}{$1}")), null);
});

test("a row whose expansion cannot be read is its own source row", () => {
  const table = String.raw`\begin{tabular}{ll}
x & y \\
\row{a}{b}
\end{tabular}`;
  assert.deepEqual(macroRowReadings(table, (text) => (text.includes("\\row") ? null : text)), { 1: null });
});

test("a cell with a comment or a line break opens in the cell editor; others stay drawn", async () => {
  const { view, done } = mount(inDocument(String.raw`\begin{tabular}{ll}
a % note
& b \\
c & d \newline e
\end{tabular}`));
  try {
    const cells = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-table-cell[data-row]")];
    assert.equal(cells.length, 4);
    const commented = cells[0];
    assert.ok(commented.classList.contains("cm-vis-table-source-only"));
    commented.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    assert.equal(commented.getAttribute("contenteditable"), "true");
    assert.equal(commented.textContent, "a % note");
    assert.equal(constructs(view.state).filter((item) => item.startsWith("table:")).length, 1);
  } finally { done(); }
});

test("a comment typed at a cell's end gets a line break so it hides nothing", () => {
  assert.equal(safeCellText("a % note", " & b \\\\"), "a % note\n");
  assert.equal(safeCellText("a % note", "  "), "a % note");
  assert.equal(safeCellText("50\\% off", " & b"), "50\\% off");
});

/* ---- 2. Ragged and malformed tables ------------------------------------------------------------------------------ */

test("rows with more cells than the specification (or a \\multicolumn past its end) are drawn and marked", () => {
  const drawn = grid(inDocument(String.raw`\begin{tabular}{lll}
a & b \\
c & d & e & f \\
\multicolumn{5}{c}{wide} \\
g & h & i
\end{tabular}`))!;
  const rows = [...drawn.querySelectorAll("tr")];
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => row.classList.contains("cm-vis-table-row-odd")), [false, true, true, false]);
});

/* ---- 3. Table commands ----------------------------------------------------------------------------------------- */

const SIMPLE = String.raw`\begin{tabular}{lcr}
\hline
a & b & c \\
d & e & f \\
g & h & i
\end{tabular}`;

test("merging cells writes a \\multicolumn, a \\multirow, or both; splitting undoes it", () => {
  const model = parseTabular(SIMPLE)!;
  const across = apply(SIMPLE, mergeCells(model, SIMPLE, 0, 0, 0, 0, 1));
  assert.match(across, /\\multicolumn\{2\}\{l\}\{a b\} & c \\\\/);
  assert.equal(apply(across, splitCell(parseTabular(across)!, across, 0, 0, 0)), SIMPLE.replace("a & b", "a b &"));
  const down = apply(SIMPLE, mergeCells(model, SIMPLE, 0, 0, 1, 1, 1));
  assert.match(down, /a & \\multirow\{2\}\{\*\}\{b e\} & c \\\\\nd & {2}& f/);
  assert.match(apply(down, splitCell(parseTabular(down)!, down, 0, 0, 1)), /a & b e & c/);
  const blockMerged = apply(SIMPLE, mergeCells(model, SIMPLE, 0, 1, 2, 0, 1));
  assert.match(blockMerged, /\\multicolumn\{2\}\{l\}\{\\multirow\{2\}\{\*\}\{d e g h\}\} & f \\\\\n\\multicolumn\{2\}\{l\}\{\} & i/);
  // A cell crossing the block's edge refuses.
  assert.equal(mergeCells(parseTabular(across)!, across, 0, 0, 1, 1, 1), null);
  // Only the merged cells change.
  assert.ok(across.startsWith("\\begin{tabular}{lcr}\n\\hline\n"));
});

test("a column's alignment changes only its letter", () => {
  const model = parseTabular(String.raw`\begin{tabular}{|>{\bfseries}l|p{2cm}|c|}
a & b & c
\end{tabular}`)!;
  assert.deepEqual(setColumnAlignment(model, 0, "r"), [{ from: model.specFrom + 13, to: model.specFrom + 14, insert: "r" }]);
  assert.equal(setColumnAlignment(model, 1, "c"), null, "a paragraph column");
  assert.equal(setColumnAlignment(model, 2, "c"), null, "already centred");
});

test("rules are added as the table writes them (\\hline or booktabs) and removed with their line", () => {
  const model = parseTabular(SIMPLE)!;
  assert.equal(apply(SIMPLE, addRule(model, SIMPLE, 0, 1)), SIMPLE.replace("d & e", "\\hline\nd & e"));
  assert.equal(apply(SIMPLE, addRule(model, SIMPLE, 0, 2, true)), SIMPLE.replace("g & h & i", "g & h & i \\\\\n\\hline"));
  assert.equal(apply(SIMPLE, removeRules(model, SIMPLE, 0, 0)), SIMPLE.replace("\\hline\n", ""));
  assert.equal(removeRules(model, SIMPLE, 0, 1), null);
  const booktabs = String.raw`\begin{tabular}{ll}
\toprule
a & b \\
c & d \\
\bottomrule
\end{tabular}`;
  const ruled = parseTabular(booktabs)!;
  assert.equal(apply(booktabs, addRule(ruled, booktabs, 0, 1)), booktabs.replace("c & d", "\\midrule\nc & d"));
  assert.equal(apply(booktabs, removeRules(ruled, booktabs, 0, 1, true)), booktabs.replace("\\bottomrule\n", ""));
});

test("rows and columns move with the fewest changes; rules stay between the rows", () => {
  const model = parseTabular(SIMPLE)!;
  assert.equal(apply(SIMPLE, moveRow(model, SIMPLE, 0, 0, 1)), SIMPLE.replace("a & b & c \\\\\nd & e & f", "d & e & f \\\\\na & b & c"));
  // The last row, without `\\`, swaps its text only.
  assert.equal(apply(SIMPLE, moveRow(model, SIMPLE, 0, 2, -1)), SIMPLE.replace("d & e & f \\\\\ng & h & i", "g & h & i \\\\\nd & e & f"));
  assert.equal(moveRow(model, SIMPLE, 0, 0, -1), null);
  assert.equal(apply(SIMPLE, moveColumn(model, SIMPLE, 0, 0, 1)), String.raw`\begin{tabular}{clr}
\hline
b & a & c \\
e & d & f \\
h & g & i
\end{tabular}`);
});

test("the table menu lists the commands, works from the keyboard, and applies one as a single change", () => {
  const { view, done } = mount(inDocument(SIMPLE));
  try {
    const td = view.contentDOM.querySelector<HTMLElement>(".cm-vis-table-cell[data-row='0'][data-cell='1']")!;
    const table = td.closest(".cm-vis-table") as HTMLTableElement & { liberaTableStart?: () => number | null };
    openTableMenu(view, new MouseEvent("contextmenu", { clientX: 10, clientY: 10 }), table.liberaTableStart!, 0, 1);
    const menu = document.querySelector(".cm-vis-table-menu")!;
    const labels = [...menu.querySelectorAll("button")].map((button) => button.textContent);
    for (const label of ["Merge with cell right", "Merge with cell below", "Split cell", "Align column left", "Add rule above", "Remove rules above", "Move row down", "Move column left"]) assert.ok(labels.includes(label), label);
    assert.ok((menu.querySelector("button:focus") ?? document.activeElement)?.textContent);
    const before = view.state.doc.toString();
    const button = [...menu.querySelectorAll("button")].find((item) => item.textContent === "Align column right")!;
    let transactions = 0;
    const count = view.dispatch.bind(view);
    view.dispatch = ((...args: Parameters<EditorView["dispatch"]>) => { transactions++; count(...args); }) as EditorView["dispatch"];
    button.click();
    assert.equal(transactions, 1);
    assert.equal(view.state.doc.toString(), before.replace("{lcr}", "{lrr}"));
    assert.equal(document.querySelector(".cm-vis-table-menu"), null);
  } finally { done(); }
});

/* ---- 4. Grid semantics ------------------------------------------------------------------------------------------ */

test("\\rowcolors and \\arraystretch are read from before the tabular", () => {
  assert.deepEqual(readTableSettings(String.raw`\centering \rowcolors{2}{gray!10}{white} \renewcommand{\arraystretch}{1.5}`), { rowColors: { start: 2, odd: "gray!10", even: "white" }, stretch: 1.5 });
  assert.equal(readTableSettings(String.raw`\rowcolors{2}{gray}{white}\hiderowcolors`), undefined);
  assert.deepEqual(readTableSettings("", "1.2"), { stretch: 1.2 });
});

test("a table float with \\rowcolors stays drawn, with alternating fills; \\arraystretch makes taller rows", () => {
  const doc = inDocument(String.raw`\begin{table}
\centering
\rowcolors{2}{gray!10}{white}
\renewcommand{\arraystretch}{1.4}
\begin{tabular}{ll}
a & b \\
c & d \\
e & f
\end{tabular}
\caption{T}
\end{table}`);
  assert.equal(constructs(visualState(doc)).filter((item) => item.startsWith("figure:")).length, 1);
  const drawn = grid(doc)!;
  assert.equal(drawn.style.getPropertyValue("--vis-arraystretch"), "1.4");
  // Rows 2 (even, white: no fill) and 3 (odd, gray).
  assert.deepEqual([...drawn.querySelectorAll("tr")].map((row) => (row as HTMLElement).dataset.fill !== undefined), [false, false, true]);
});

test("\\columncolor, \\cline, m{} columns, \\diagbox, \\rotatebox and siunitx S columns are drawn as they mean", () => {
  const drawn = grid(inDocument(String.raw`\begin{tabular}{>{\columncolor{blue}}l m{2cm} S}
\diagbox{Row}{Col} & \rotatebox{90}{Head} & {Value} \\
\cline{2-3}
a & b & 1.5 \\
c & d & 12.25 \\
e & f & 3
\end{tabular}`))!;
  const rows = [...drawn.querySelectorAll("tr")];
  const cells = (row: number) => [...rows[row].querySelectorAll<HTMLElement>("td")];
  assert.ok(cells(1)[0].dataset.columnFill !== undefined);
  assert.equal(cells(1)[1].style.verticalAlign, "middle");
  assert.ok(cells(0)[0].classList.contains("cm-vis-table-diag"));
  assert.equal(cells(0)[0].textContent, "ColRow");
  assert.ok(cells(0)[1].querySelector(".cm-vis-rotated-up"));
  // Partial rule: only columns 2 and 3 of row 2.
  assert.deepEqual(cells(1).map((td) => td.classList.contains("cm-vis-cell-rule")), [false, true, true]);
  assert.ok(!rows[1].classList.contains("cm-vis-rule"));
  // Points line up: every number is as wide as the widest integer and fraction.
  const numbers = [1, 2, 3].map((row) => cells(row)[2].textContent!);
  assert.deepEqual(numbers, ["\u20071.5\u2007", "12.25", "\u20073\u2008\u2007\u2007"]);
  assert.equal(new Set(numbers.map((text) => text.length)).size, 1);
});

test("a \\rotatebox at another angle or an unknown command is drawn plainly, never fatal", () => {
  const drawn = grid(inDocument(String.raw`\begin{tabular}{ll}
\rotatebox{45}{Head} & \unknowncmd{x} \\
a & b
\end{tabular}`))!;
  assert.ok(drawn);
  assert.equal(drawn.querySelector(".cm-vis-rotated"), null);
  assert.equal(drawn.querySelectorAll("td").length, 4);
});

/* ---- 5. A table being typed --------------------------------------------------------------------------------- */

test("a table typed step by step stays source until \\end{tabular}; its neighbours are not disturbed", () => {
  const before = "\\section{Intro}\nText $x$ here.\n\n";
  const afterText = "\n\nMore $y$ text.\n";
  const steps = ["\\begin{tabular}{ll", "\\begin{tabular}{ll}", "\\begin{tabular}{ll}\na & b \\\\", "\\begin{tabular}{ll}\na & b \\\\\nc & d", "\\begin{tabular}{ll}\na & b \\\\\nc & d\n\\end{tabular}"];
  const bodyStart = inDocument("").indexOf("\n") + 1;
  let state = visualState(inDocument(before + afterText));
  const neighbours = (s: EditorState) => constructs(s).filter((item) => !item.startsWith("table:") && !item.startsWith("document-end"));
  const reference = neighbours(state).filter((item) => Number(item.split(":")[1]) < bodyStart + before.length);
  let typed = "";
  steps.forEach((step, index) => {
    const at = bodyStart + before.length;
    state = built(state.update({ changes: { from: at, to: at + typed.length, insert: step } }).state);
    typed = step;
    const fresh = visualState(state.doc.toString());
    assert.deepEqual(constructs(state), constructs(fresh), `step ${index}: incremental equals fresh`);
    const tables = constructs(state).filter((item) => item.startsWith("table:"));
    assert.equal(tables.length, index === steps.length - 1 ? 1 : 0, `step ${index}`);
    assert.deepEqual(neighbours(state).filter((item) => Number(item.split(":")[1]) < at), reference, `step ${index}: before`);
  });
});
