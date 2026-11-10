import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { history } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";

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
