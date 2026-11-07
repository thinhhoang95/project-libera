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
import { stateReferenceText } from "../../src/lib/latex/codemirror/visual/references";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

const SAMPLE = readFileSync(path.join(__dirname, "fixtures/latex/visual-sample.tex"), "utf8");

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
  const numbering = computeLatexNumbering(syntaxTree(state), (from, to) => state.doc.sliceString(from, to), visualDefinitions(state));
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
  const bodiesEnd = doc.indexOf("\\refstepcounter");
  assert.ok(list.every((entry) => { const from = Number(entry.split(":")[1]); return from < definitions || from >= bodiesEnd; }), `nothing in definition bodies is drawn: ${list.join(" ")}`);
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
  for (const inner of ["Some text \\includegraphics{a}\\caption{C}", "\\includegraphics{a}\\foo\\caption{C}", "\\begin{subfigure}{.5\\textwidth}\\includegraphics{a}\\caption{A}\\end{subfigure}\\caption{C}"]) {
    const view = mount(`\\begin{figure}\n${inner}\n\\end{figure}`);
    // (A sub-figure may still be drawn on its own.)
    assert.ok(!constructs(view.state).some((entry) => entry.startsWith("figure:0:")), inner);
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

test("MathLive gets the macros a formula's macros use, and refuses ones it would change", () => {
  const view = mount("\\newcommand\\b[1][x]{#1}\\newcommand\\a{\\b}\\newcommand\\c{y}\\newcommand\\d{\\c}\nSee $\\a$ and $\\d$.");
  const doc = view.state.doc.toString();
  assert.equal(canEditInMathLive(view, doc.indexOf("$\\a")), false, "\\a uses \\b, which has an optional argument");
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
  moveTo(at(view, "bold", 2));
  assert.deepEqual(revealedKinds(view.state), ["style"], "bold inside a heading reveals only the bold markup");
  moveTo(at(view, "Intro", 2));
  assert.deepEqual(revealedKinds(view.state), [], "typing in a heading keeps its markup hidden");
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

test("the cursor stays before a heading's hidden brace", () => {
  const doc = "\\section{Title}\\label{sec:t}\nNext";
  const view = mount(doc);
  view.dispatch({ selection: { anchor: doc.indexOf("\nNext") } });
  assert.equal(view.state.selection.main.head, doc.indexOf("}"), "clamped before the }");
  view.dispatch({ selection: { anchor: doc.indexOf("\nNext") } });
  assert.equal(view.state.selection.main.head, doc.indexOf("Next"), "moving on from there goes to the next line");
  view.destroy();
});

/* ---- Speed and correctness of incremental updates ----------------------------------- */

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
