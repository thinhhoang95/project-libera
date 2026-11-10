import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { FigureWidget, refreshVisualWidgets, TableWidget } from "../../src/lib/latex/codemirror/visual/widgets";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexParser, latexDocumentParser } from "../../src/lib/latex/codemirror/latex-parser";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { definitionDiagnostics } from "../../src/lib/latex/codemirror/visual/diagnostics";
import { latexProjectField, setLatexProject } from "../../src/lib/latex/codemirror/editing";
import { macroAt, readLatexDefinitions } from "../../src/lib/latex/macros/definitions";
import { expandLatexMacros, expandLatexMacroUse, expandMacroUseWithProvenance } from "../../src/lib/latex/macros/expand";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";
import { disabledRegions, discardingMacros } from "../../src/lib/latex/macros/structure";

/* The macros round: structure a macro writes edited at its call, braced conditionals (etoolbox, ifthen), xparse's other
 * argument types, diagnostics for what stays source, and a preamble definition left open while it is typed. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

/** Builds every pending piece of a Visual state. */
function settle(state: EditorState) {
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

/** The Visual mode's state for `doc`, with every pending piece built. */
function visualState(doc: string, extra: Extension[] = []) {
  const state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }), latexProjectField, ...extra] });
  ensureSyntaxTree(state, doc.length, 5000);
  return settle(state);
}

/** Constructs as "kind:from:to". */
function constructs(state: EditorState) {
  const list: string[] = [];
  state.field(structuralField).extents.between(0, state.doc.length, (from, to, mark) => { list.push(`${mark.kind}:${from}:${to}`); });
  return list.sort();
}

/** Kinds of the constructs built at the first occurrence of `needle`. */
function kindsAt(state: EditorState, needle: string) {
  const pos = state.doc.toString().indexOf(needle);
  assert.ok(pos >= 0, needle);
  const out: string[] = [];
  state.field(structuralField).extents.between(pos, pos + 1, (_from, _to, mark) => { out.push(mark.kind); });
  return out;
}

/** The widgets drawn, with where each starts. */
function widgets(state: EditorState) {
  const out: Array<{ from: number; widget: unknown }> = [];
  state.field(structuralField).decorations.between(0, state.doc.length, (from, _to, decoration) => { if (decoration.spec.widget) out.push({ from, widget: decoration.spec.widget }); });
  return out;
}

/** What a mounted Visual mode shows for `doc`, numbered as the app numbers it. */
function visibleText(doc: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  const text = view.contentDOM.textContent ?? "";
  view.destroy();
  parent.remove();
  return { text, numbering };
}

function number(source: string) {
  return computeLatexNumbering(latexParser.parse(source), (from, to) => source.slice(from, to), readLatexDefinitions(source));
}

function leftOut(source: string) {
  const defs = readLatexDefinitions(source);
  return disabledRegions(source, discardingMacros(defs), defs).map((region) => source.slice(region.from, region.to));
}

const TBL = String.raw`\documentclass{article}
\newcommand{\tbl}[2]{\begin{table}\caption{#1}#2\end{table}}
\begin{document}
\tbl{My caption\label{t}}{\begin{tabular}{ll}a & b\\ c & d\end{tabular}}
See \ref{t}.
\end{document}`;

test("item 1: a macro wrapping a whole table is drawn as the table, its caption and cells placed at the call's arguments", () => {
  const state = visualState(TBL);
  assert.ok(kindsAt(state, "\\tbl{My").includes("figure"));
  const { text, numbering } = visibleText(TBL);
  assert.match(text, /Table 1: My caption/);
  assert.equal(numbering.labels.get("t")?.number, "1");
  const drawn = widgets(state).find((item) => item.widget instanceof FigureWidget)!;
  const spec = (drawn.widget as FigureWidget).spec;
  // The grid is the call's second argument: the cell editor edits it there.
  const tabular = spec.tabulars![0];
  assert.equal(tabular.readOnly, undefined);
  assert.equal(TBL.slice(drawn.from + tabular.offset, drawn.from + tabular.offset + tabular.source.length), tabular.source);
  assert.equal(TBL.indexOf("\\begin{tabular}"), drawn.from + tabular.offset);
  // The caption is the first argument: a click puts the cursor there.
  assert.equal(TBL.slice(drawn.from + spec.captionSource!.from, drawn.from + spec.captionSource!.to), "My caption\\label{t}");
  assert.equal(spec.captionPos, TBL.indexOf("My caption"));
});

test("item 1: what the definition writes stays read-only; an argument written twice maps both copies to the call", () => {
  const written = String.raw`\newcommand{\tab}[2]{\begin{table}\caption{#1}\begin{tabular}{ll}#2\end{tabular}\end{table}}
\begin{document}
\tab{Cap}{a & b\\}
\end{document}`;
  const spec = (widgets(visualState(written)).find((item) => item.widget instanceof FigureWidget)!.widget as FigureWidget).spec;
  assert.equal(spec.tabulars![0].readOnly, true);
  assert.ok(spec.captionSource);
  const defs = readLatexDefinitions(String.raw`\newcommand{\twice}[1]{#1 and #1}\begin{document}\end{document}`);
  const source = "\\twice{x y}";
  const traced = expandMacroUseWithProvenance(source, defs, { pos: 0 })!;
  assert.equal(traced.text, "x y and x y");
  assert.deepEqual(traced.segments.map((segment) => [segment.from, segment.to, segment.source]), [[0, 3, 7], [8, 11, 7]]);
  // An argument the body takes apart is not traced (the use is drawn as before).
  const tested = readLatexDefinitions(String.raw`\newcommand{\t}[1]{\ifx#1a yes\else no\fi}\begin{document}\end{document}`);
  assert.equal(expandLatexMacroUse("\\t{a}", tested, { pos: 999 })?.text.trim(), "yes");
  assert.equal(expandMacroUseWithProvenance("\\t{a}", tested, { pos: 999 }), null);
});

test("item 1: a macro-written table being typed stays source until its call is complete (principle 2)", () => {
  const call = String.raw`\tbl{Cap}{\begin{tabular}{ll}a & b\end{tabular}}`;
  const preamble = String.raw`\newcommand{\tbl}[2]{\begin{table}\caption{#1}#2\end{table}}` + "\n\\begin{document}\n";
  for (const cut of [8, 20, 30, call.length - 1]) {
    const doc = `${preamble}${call.slice(0, cut)}\n\\end{document}`;
    assert.ok(!kindsAt(visualState(doc), "\\tbl{").includes("figure"), call.slice(0, cut));
  }
  assert.ok(kindsAt(visualState(`${preamble}${call}\n\\end{document}`), "\\tbl{").includes("figure"));
});

test("item 1: a tabular written whole by a macro argument is a grid edited there; wrapper environments forward an optional title", () => {
  const doc = String.raw`\newcommand{\grid}[1]{#1}
\newcommand{\boxed}[1]{\begin{tabular}{l}#1\end{tabular}}
\newtheorem{theorem}{Theorem}
\newenvironment{mythm}[1][]{\begin{theorem}[#1]}{\end{theorem}}
\begin{document}
\boxed{x\\ y\\}
\begin{mythm}[Pythagoras]
Body.
\end{mythm}
\end{document}`;
  const state = visualState(doc);
  const table = widgets(state).find((item) => item.widget instanceof TableWidget)!.widget as TableWidget;
  assert.equal(table.readOnly, true);
  assert.match(visibleText(doc).text, /Theorem 1 \(Pythagoras\)\. Body\./);
});

test("item 2: etoolbox's and ifthen's braced tests in the body are decided as \\iffalse is", () => {
  const source = String.raw`\usepackage{etoolbox}
\newtoggle{long}
\toggletrue{long}
\newbool{draft}
\newcommand{\empty}{}
\newcommand{\full}{x}
\newtheorem{theorem}{Theorem}
\begin{document}
\iftoggle{long}{Long text.}{Short text.}
\nottoggle{long}{NotA}{NotB}
\ifbool{draft}{Draft}{Final}
\ifdef{\full}{Has}{Lacks}
\ifundef{\nothere}{Maybe}{Maybe2}
\ifcsdef{full}{CsHas}{CsLacks}
\ifdefempty{\empty}{Empty}{Full}
\ifthenelse{\equal{a}{b}}{Same}{Differ}
\ifthenelse{\isodd{3}}{Odd}{Even}
\ifthenelse{\boolean{draft}}{BDraft}{BFinal}
\ifdefined\undefined Gone\else Kept\fi
\iftoggle{long}{}{\begin{theorem}\label{gone}X\end{theorem}}
\begin{theorem}\label{kept}Y\end{theorem}
\end{document}`;
  const out = leftOut(source).join("|");
  for (const gone of ["{Short text.}", "{NotA}", "{Draft}", "{Lacks}", "{CsLacks}", "{Full}", "{Same}", "{Even}", "{BDraft}", "Gone"]) assert.ok(out.includes(gone), gone);
  for (const kept of ["Long text.", "NotB", "Final", "Has}", "CsHas}", "Empty}", "Differ", "Odd}", "BFinal", "Kept"]) assert.ok(!out.includes(`{${kept.replace(/}$/, "")}}`) || kept === "Kept", kept);
  // `\ifundef` of a name the reader cannot know about stays undecided: nothing of it is left out.
  assert.ok(!out.includes("Maybe"));
  const numbering = number(source);
  assert.equal(numbering.labels.has("gone"), false);
  assert.equal(numbering.labels.get("kept")?.number, "1");
  const { text } = visibleText(source);
  assert.match(text, /Long text\./);
  const state = visualState(source);
  assert.deepEqual(kindsAt(state, "{Short text.}"), ["disabled"]);
});

test("item 2: preamble definitions under a braced test are read from the branch taken; an unknown test hides them", () => {
  const source = String.raw`\newtoggle{long}
\toggletrue{long}
\iftoggle{long}{\newcommand{\ver}{LONG}}{\newcommand{\ver}{SHORT}}
\newboolean{arxiv}
\setboolean{arxiv}{true}
\ifthenelse{\boolean{arxiv}}{\newcommand{\venue}{arXiv}}{}
{\iftoggle{long}{\newcommand{\local}{L}}{}}
\iftoggle{unknown}{\newcommand{\maybe}{M}}{}
\begin{document}
\ver, \venue
\end{document}`;
  const defs = readLatexDefinitions(source);
  assert.equal(macroAt(defs, "ver", 999)?.body, "LONG");
  assert.equal(macroAt(defs, "venue", 999)?.body, "arXiv");
  // A definition in a branch inside a group still ends with the group.
  assert.equal(macroAt(defs, "local", 999), null);
  assert.equal(macroAt(defs, "maybe", 999)?.unsupported, true);
  assert.match(visibleText(source).text, /LONG, arXiv/);
  // In a macro's body too.
  const body = readLatexDefinitions(String.raw`\newtoggle{t}\togglefalse{t}\newcommand{\v}{\iftoggle{t}{A}{B}}\begin{document}\end{document}`);
  assert.equal(expandLatexMacroUse("\\v", body, { pos: 999 })?.text, "B");
});

test("item 3: xparse's t, r, R, d, D and e argument types; expandable commands; v stays unsupported", () => {
  const defs = readLatexDefinitions(String.raw`\NewDocumentCommand{\pl}{t+ m}{\IfBooleanTF{#1}{+#2}{#2}}
\NewDocumentCommand{\pair}{r() d<> D[]{9}}{(#1|\IfNoValueTF{#2}{-}{#2}|#3)}
\NewDocumentCommand{\emb}{m e{^_}}{#1\IfNoValueF{#2}{^{#2}}\IfNoValueF{#3}{_{#3}}}
\NewDocumentCommand{\embd}{E{^}{{0}}}{p#1}
\NewExpandableDocumentCommand{\ex}{m}{[#1]}
\NewDocumentCommand{\verb}{v}{#1}
\begin{document}\end{document}`);
  const text = (source: string) => expandLatexMacros(source, defs, { mode: "math", pos: 999 }).text;
  assert.equal(text("\\pl+{x}"), "+x");
  assert.equal(text("\\pl{x}"), "x");
  assert.equal(text("\\pair(a)<b>[c]"), "(a|b|c)");
  assert.equal(text("\\pair(a)"), "(a|-|9)");
  assert.equal(text("\\emb{x}_{i}^{2}"), "x^{2}_{i}");
  assert.equal(text("\\emb{x}"), "x");
  assert.equal(text("\\embd"), "p0");
  assert.equal(text("\\ex{y}"), "[y]");
  assert.equal(macroAt(defs, "verb", 999)?.unsupported, true);
  assert.ok(defs.unsupported.some((note) => note.name === "verb"));
});

test("item 3: \\PassOptionsToPackage gives a package loaded later its options; \\@ifstar picks the form", () => {
  const defs = readLatexDefinitions(String.raw`\PassOptionsToPackage{numbers,sort}{natbib}
\usepackage[square]{natbib}
\makeatletter
\newcommand{\foo}{\@ifstar{\foo@s}{\foo@n}}
\newcommand{\foo@s}{STAR}
\newcommand{\foo@n}{PLAIN}
\makeatother
\begin{document}\end{document}`);
  assert.deepEqual(defs.packageOptions.get("natbib"), ["numbers", "sort", "square"]);
  assert.equal(expandLatexMacros("\\foo* and \\foo", defs, { mode: "text", pos: 999 }).text, "STAR and PLAIN");
});

test("item 4: definitions that stay source and missing files are diagnostics at their call site", () => {
  const doc = String.raw`\documentclass{article}
\usepackage{amsmath}
\usepackage{styles/mine}
\newcommand{\bad}[1]{#2}
\edef\x{y}
\input{glyphtounicode}
\begin{document}
\input{chapters/intro}
\input{chapters/there}
\includegraphics{figs/missing}
\includegraphics{figs/plot}
\end{document}`;
  let state = visualState(doc);
  state = state.update({ effects: setLatexProject.of({ labels: [], bibEntries: [], files: [], allPaths: ["chapters/there.tex", "figs/plot.pdf"] }) }).state;
  const found = definitionDiagnostics(state).map((item) => `${item.severity}:${doc.slice(item.from, item.to)}`);
  assert.deepEqual(found, [
    "warning:\\usepackage{styles/mine}",
    "warning:\\newcommand",
    "info:\\edef",
    "warning:\\input{chapters/intro}",
    "info:\\includegraphics{figs/missing}",
  ]);
  // Without the project's files only the definitions are checked.
  assert.equal(definitionDiagnostics(visualState(doc)).length, 2);
});

test("item 5: an unclosed definition in the preamble leaves the body drawn and numbered; closing it changes nothing else", () => {
  const open = String.raw`\documentclass{article}
\newcommand{\bad}[1]{\textbf{#1}
\newcommand{\good}{G}
\begin{document}
\section{One}\label{one}
Text \good.
\end{document}`;
  const state = visualState(open);
  assert.ok(kindsAt(state, "\\section{One}").includes("heading"));
  assert.ok(visualDefinitions(state).problems.some((note) => note.name === "bad"));
  const parsed = latexDocumentParser.parse(open);
  assert.ok(computeLatexNumbering(parsed, (from, to) => open.slice(from, to), readLatexDefinitions(open)).labels.has("one"));
  // Typing the `}` (incrementally) gives what a fresh build of the closed file gives, and back.
  const at = open.indexOf("{#1}") + 4;
  const closed = settle(state.update({ changes: { from: at, insert: "}" } }).state);
  ensureSyntaxTree(closed, closed.doc.length, 5000);
  assert.deepEqual(constructs(settle(closed)), constructs(visualState(closed.doc.toString())));
  const reopened = settle(closed.update({ changes: { from: at, to: at + 1 } }).state);
  ensureSyntaxTree(reopened, reopened.doc.length, 5000);
  assert.deepEqual(constructs(settle(reopened)), constructs(visualState(open)));
  // A preamble whose groups close is parsed as the package parses it.
  const fine = String.raw`\newcommand{\a}{x}\begin{document}y\end{document}`;
  assert.equal(latexDocumentParser.parse(fine).toString(), latexParser.parse(fine).toString());
});
