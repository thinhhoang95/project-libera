import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fc from "fast-check";
import { JSDOM } from "jsdom";
import { history } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, FIRST_BUILD_AFTER, FIRST_BUILD_BEFORE, LARGE_DOCUMENT, structuralField } from "../../src/lib/latex/codemirror/visual/structural";

/* Visual mode build performance and incremental-build correctness (group F). */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function extensions(extra: Extension[] = []) {
  return [history(), latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }), ...extra];
}

function stateFor(doc: string, selection?: number) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  return EditorState.create({ doc, selection: selection === undefined ? undefined : { anchor: selection }, extensions: extensions() });
}

function mount(doc: string, selection?: number) {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({ state: stateFor(doc, selection), parent });
}

/** Builds every pending piece, in CHUNK pieces from the first. */
function fill(state: EditorState) {
  for (let guard = 0; state.field(structuralField).pending.length && guard < 400; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  assert.equal(state.field(structuralField).pending.length, 0, "everything is built");
  return state;
}

/** Constructs as "kind:from:to", sorted: what the structural layer has built. */
function constructs(state: EditorState) {
  const list: string[] = [];
  state.field(structuralField).extents.between(0, state.doc.length, (from, to, mark) => { list.push(`${mark.kind}:${from}:${to}`); });
  return list.sort();
}

/** What the structural layer draws in [0, end): each decoration's range and widget (its key: what it shows) or line class. */
function drawn(state: EditorState, end: number) {
  const list: string[] = [];
  state.field(structuralField).decorations.between(0, end, (from, to, value) => {
    if (from >= end) return;
    const widget = value.spec.widget as { key?: string; constructor: { name: string } } | undefined;
    list.push(`${from}:${to}:${widget ? `${widget.constructor.name}:${widget.key ?? ""}` : `line:${value.spec.class ?? ""}`}`);
  });
  return list.sort();
}

/** A state for `doc` as the app has it when Visual mode starts: parsed by Source mode, the cursor at `head`. */
function openedAt(doc: string, head: number) {
  const visual = new Compartment();
  const state = EditorState.create({ doc, selection: { anchor: head }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), visual.of([])] });
  ensureSyntaxTree(state, doc.length, 5000);
  return state.update({ effects: visual.reconfigure(latexVisualMode({ documentPath: "nb/main.tex" })) }).state;
}

/** Applies `changes` one transaction each (the parser catching up after each), and checks the result against a fresh build. */
function assertIncrementalMatchesFresh(doc: string, changes: Array<{ from: number; to?: number; insert?: string }>) {
  const view = mount(doc);
  for (const change of changes) {
    view.dispatch({ changes: change });
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    view.dispatch({});
  }
  const incremental = fill(view.state);
  const fresh = fill(stateFor(view.state.doc.toString()));
  assert.deepEqual(constructs(incremental), constructs(fresh));
  view.destroy();
  return fresh;
}

test("a caption macro whose argument the parser ends early is not a caption: a brace typed after the float changes nothing", () => {
  // The fast-check counterexample of "edits around environments opened and closed by macros" (seed 2), shrunk: before
  // the `}` the caption's text never closes; after it, `\mycap`'s argument (read from the text) swallows `\end{figure}`,
  // which drew the float whole in a fresh build while the incremental one left it as source.
  const doc = String.raw`\documentclass{article}
\newcommand{\mycap}[1]{\caption{#1}}
\begin{document}
\begin{figure}
\mycap{{ figure.}\label{fig:a}
\end{figure}\thm{T}
Text\fn{one} and\footnote{two}.
\end{document}
`;
  const fresh = assertIncrementalMatchesFresh(doc, [{ from: doc.indexOf("Text"), insert: "}" }]);
  assert.ok(!constructs(fresh).some((entry) => entry.startsWith("figure:")), "the float stays source");
  assert.ok(constructs(fresh).some((entry) => entry.startsWith("label:")), "its parts are drawn on their own");
});

test("an edit followed past a pending piece redraws what it changed after that piece", () => {
  // The flaky "edits around environments opened and closed by macros" property, made deterministic: with the parser
  // behind (a fast-check run under load) pieces are left pending, and following an edit stopped at the first one
  // (`\begin{enumerate}` becoming `\beqbegin{enumerate}` left the `\end{document}` line folded). A long file has pending
  // pieces right after it opens: here its end is built, a piece before it is not, and an edit just before that piece
  // makes all the rest verbatim.
  const paragraph = "A paragraph of plain words and more words, with nothing drawn in it at all.\n\n";
  const filler = paragraph.repeat(Math.ceil((LARGE_DOCUMENT * 2) / paragraph.length));
  const doc = `\\documentclass{article}\n\\begin{document}\nBefore $x$.\n${filler}\\textbf{bold} and $y$\n\\end{verbatim}\nAfter.\n\\end{document}\n`;
  let state = openedAt(doc, 0);
  const tail = doc.indexOf("\\textbf{bold}") - 2000;
  for (let guard = 0; guard < 40; guard++) {
    const piece = state.field(structuralField).pending.find((range) => range.to > tail);
    if (!piece) break;
    state = state.update({ effects: buildPendingEffect.of({ from: Math.max(piece.from, tail), to: piece.to }) }).state;
  }
  const middle = state.field(structuralField).pending.find((range) => range.from < tail);
  assert.ok(middle, "a piece in the middle is pending");
  assert.ok(constructs(state).some((entry) => entry.startsWith("style:")), "\\textbf{bold} is drawn");
  const at = state.doc.lineAt(middle!.from - 1500).from;
  assert.ok(at > doc.indexOf("Before"));
  state = state.update({ changes: { from: at, insert: "\\begin{verbatim}\n" } }).state;
  ensureSyntaxTree(state, state.doc.length, 5000);
  const incremental = fill(state.update({}).state);
  const fresh = fill(openedAt(incremental.doc.toString(), 0));
  assert.deepEqual(constructs(incremental), constructs(fresh));
  assert.ok(!constructs(incremental).some((entry) => entry.startsWith("style:")), "verbatim text is not drawn");
});

const CUSTOM_LIST = String.raw`\documentclass{article}
\usepackage{enumitem}
\newlist{steps}{enumerate}{3}
\setlist[steps,1]{label=\arabic*.}
\begin{document}
\begin{steps}
\item One
\item Two
\item Three
\end{steps}
\end{document}
`;

test("a } typed lines after a font switch's { draws the group it closes", () => {
  // The flaky "edits around hand-numbered rows, font switches in environments and stacks" property (a counterexample
  // found by fuzzing, not a timing one): `\begin{algorithmic}` edited to `\be\eqnralgorithmic}` closed the
  // `{    \it Ce genre…` group opened lines before. Only the edited lines were walked, and the group's style starts before them.
  const doc = "\\documentclass{article}\n\\begin{document}\nBefore {    \\it open\n\\begin{quote}\nQuoted.\n\\end{quote}\nAfter\nEnd.\n\\end{document}\n";
  const fresh = assertIncrementalMatchesFresh(doc, [{ from: doc.indexOf("After") + 5, insert: "}" }]);
  assert.ok(constructs(fresh).some((entry) => entry.startsWith(`style:${doc.indexOf("{    \\it")}:`)), "the group is drawn in italics");
  // And as in the counterexample, with the parser's error recovery around an environment's `\end`.
  const paper = "\\documentclass{article}\n\\begin{document}\n{    \\it Ce genre d'exp\\'erience.\n\\begin{algorithm}\n\\begin{algorithmic}\n\\STATE x\n\\end{algorithmic}\n\\end{algorithm}\n\\end{document}\n";
  const at = paper.indexOf("\\begin{algorithmic}");
  assertIncrementalMatchesFresh(paper, [{ from: at + 3, to: at + 7, insert: "\\eqnr" }]);
});

test("typing in a list of the document's own (enumitem's \\newlist) keeps its items drawn", () => {
  // The edit's lines were walked without the list around them: `\item Two` lost its marker until the next full build.
  const fresh = assertIncrementalMatchesFresh(CUSTOM_LIST, [{ from: CUSTOM_LIST.indexOf("Two") + 1, insert: "x" }]);
  assert.equal(constructs(fresh).filter((entry) => entry.startsWith("item:")).length, 3);
});

/** An `enumerate` of `count` items, a `\setcounter` and an `\item[*]` in it, then a nested list and a list of the document's own. */
function longList(count: number) {
  const items = Array.from({ length: count }, (_, i) => (i === 40 ? "\\setcounter{enumi}{100}\n" : "") + (i === 7 ? "\\item[*] Starred.\n" : "") + `\\item Item ${i} with $x_{${i}}$ and \\textbf{b}.\n`).join("");
  return `\\begin{enumerate}\n${items}\\item With an inner list:\n\\begin{itemize}\n\\item Inner\n\\end{itemize}\n\\end{enumerate}\n\n\\begin{steps}\n\\item First\n\\item Second\n\\end{steps}\n`;
}

test("a list of hundreds of items opens in pieces, its items numbered as when it is built whole", () => {
  // Codex review C-9: a long list was widened whole on the first build and on every idle piece (an enumerate of
  // 10,000 items: one 63 ms piece; with distinct formulas, close to a second).
  const preamble = CUSTOM_LIST.slice(0, CUSTOM_LIST.indexOf("\\begin{steps}"));
  const doc = `${preamble}${longList(1500)}\\end{document}\n`;
  const middle = doc.indexOf("\\item Item 750 ");
  const state = openedAt(doc, middle);
  const value = state.field(structuralField);
  assert.ok(value.pending.some((range) => range.from < middle - 10_000) && value.pending.some((range) => range.to > middle + 10_000), `only the part at the cursor is built (${JSON.stringify(value.pending)})`);
  const marker = (at: number, state: EditorState) => {
    let label = "";
    state.field(structuralField).decorations.between(at, at, (_from, _to, decoration) => { label = (decoration.spec.widget as { label?: string } | undefined)?.label ?? label; });
    return label;
  };
  // 40 items before the `\setcounter`, which sets the count to 100 (the starred item is not counted): item 750 is 811.
  assert.equal(marker(middle, state), "811.");
  const whole = fill(state);
  assert.equal(marker(middle, whole), "811.");
  assert.equal(constructs(whole).filter((entry) => entry.startsWith("list-end:")).length, 3);
});

test("a long document built in pieces of any size, in any order, draws what one build of it draws", () => {
  // The first build and idle pieces walk a long list in parts, each part knowing how many items come before it;
  // pieces stop after a few milliseconds. Whatever the parts, the result is the one walk of the whole.
  const preamble = String.raw`\documentclass{article}
\usepackage{enumitem}
\newlist{steps}{enumerate}{3}
\newtheorem{theorem}{Theorem}
\newcommand{\step}{\item}
\begin{document}
\section{Lists}
`;
  const body = `${longList(150)}\n\\begin{theorem}\nA statement with $y$.\n\\end{theorem}\n\nText \\emph{em} and \\cite{a}.\n\\begin{enumerate}\n\\item A\n\\step B\n\\item C\n\\end{enumerate}\n`;
  const text = preamble + body;
  assert.ok(text.length < LARGE_DOCUMENT, "the reference is built in one walk");
  const reference = drawn(stateFor(`${text}\\end{document}\n`), text.length);
  const paragraph = "Plain words after the lists, with nothing to draw.\n\n";
  const doc = `${text}${paragraph.repeat(Math.ceil((LARGE_DOCUMENT * 1.5) / paragraph.length))}\\end{document}\n`;
  fc.assert(fc.property(fc.nat({ max: doc.length }), fc.array(fc.record({ at: fc.nat({ max: doc.length }), size: fc.integer({ min: 1, max: 3000 }) }), { maxLength: 12 }), (head, pieces) => {
    let state = openedAt(doc, head);
    for (const piece of pieces) state = state.update({ effects: buildPendingEffect.of({ from: piece.at, to: Math.min(doc.length, piece.at + piece.size) }) }).state;
    assert.deepEqual(drawn(fill(state), text.length), reference);
  }), { numRuns: 30 });
});

/** A chapter of `size` characters: paragraphs with formulas, a heading every few of them. */
function chapter(size: number) {
  let body = "";
  for (let i = 0; body.length < size; i++) body += `${i % 4 ? "" : `\\section{Part ${i}}\n`}Words about $f_{${i}}(x) = \\sum_{k=1}^{${i}} x_k^2$ and \\textbf{bold ${i}}, then more plain words to read.\n\n`;
  return `\\documentclass{article}\n\\begin{document}\n${body}\\end{document}\n`;
}

test("a chapter over a few screens long opens with the part around the cursor built, the rest pending", () => {
  // Batch 5 (B5-20): 35–60 KB chapters were built whole when opened, 30–55 ms with formulas (KaTeX's cache cold).
  const doc = chapter(LARGE_DOCUMENT * 3);
  const state = openedAt(doc, 0);
  const pending = state.field(structuralField).pending;
  const built = doc.length - pending.reduce((sum, range) => sum + range.to - range.from, 0);
  assert.ok(built <= FIRST_BUILD_BEFORE + FIRST_BUILD_AFTER + 2_000, `only the part at the cursor is built (${built} characters were)`);
  assert.ok(constructs(state).some((entry) => entry.startsWith("heading:")), "the first screen is drawn");
  assert.deepEqual(constructs(fill(state)), constructs(fill(openedAt(doc, doc.length - 10))));
});

test("an unclosed { typed mid-file is followed a screen ahead now, the rest is built in pieces", () => {
  // Batch 5 (B5-17): the brace changes the syntax to the end of the file; following all of it now cost ~10 ms a keystroke.
  const doc = chapter(LARGE_DOCUMENT * 4);
  let state = fill(openedAt(doc, 0));
  const at = state.doc.lineAt(Math.floor(doc.length / 3)).from;
  state = state.update({ changes: { from: at, insert: "{" } }).state;
  const pending = state.field(structuralField).pending;
  assert.ok(pending.length === 1 && pending[0].from > at && pending[0].from < at + 20_000 && pending[0].to === state.doc.length, `what follows a screen ahead is pending (${JSON.stringify(pending)})`);
  assert.deepEqual(constructs(fill(state)), constructs(fill(openedAt(state.doc.toString(), 0))));
});

test("pending pieces on screen are built right after the update, not in idle time", async () => {
  // Opened with the cursor at its end, a long file's first screen is pending: it is built before the browser paints.
  const doc = chapter(LARGE_DOCUMENT * 3);
  const view = mount(doc, doc.length - 10);
  const onScreen = () => view.state.field(structuralField).pending.filter((range) => range.from < view.viewport.to && range.to > view.viewport.from);
  assert.ok(onScreen().length > 0, "the screen is pending at first");
  for (let i = 0; i < 20 && onScreen().length; i++) await Promise.resolve();
  assert.deepEqual(onScreen(), []);
  assert.ok(view.state.field(structuralField).pending.length > 0, "what is off screen waits for idle time");
  view.destroy();
});
