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
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Every widget the Visual mode draws can be clicked back into its source (audit round 7). The small widgets that draw
 * a hidden command (a heading's number, a footnote mark, `\ldots`, `\\`, a proof's ∎, a bullet) had no click handler,
 * and CodeMirror ignores clicks on widgets: whether they could be edited was up to the browser. These tests click each
 * drawn widget of a document in turn and check that its source then shows. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function mount(doc: string) {
  let state = EditorState.create({ doc, selection: { anchor: 0 }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" })] });
  ensureSyntaxTree(state, doc.length, 5000);
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state, parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return { view, done: () => { view.destroy(); parent.remove(); } };
}

/** The drawn widgets: the outermost non-editable elements of the content. */
function widgets(view: EditorView) {
  return [...view.contentDOM.querySelectorAll<HTMLElement>("*")].filter((node) => {
    if (node.contentEditable !== "false") return false;
    for (let up = node.parentElement; up && up !== view.contentDOM; up = up.parentElement) if (up.contentEditable === "false") return false;
    return true;
  });
}

/**
 * Whether a click on the `index`-th drawn widget shows its source (or selects it, ready for Enter, as an image does).
 * `altKey`: an Alt-click, which shows the source of the widgets whose plain click does something else (a formula opens
 * its editor, a reference goes to its label).
 */
function clickShowsSource(doc: string, index: number, altKey = false) {
  const { view, done } = mount(doc);
  try {
    const node = widgets(view)[index];
    const pos = view.posAtDOM(node);
    const label = `${node.className || node.nodeName} at ${pos} (${JSON.stringify(doc.slice(pos, pos + 24))})`;
    node.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, altKey }));
    const { revealed } = view.state.field(structuralField);
    const selection = view.state.selection.main;
    const shown = [...revealed.values()].some((range) => range.from <= pos && range.to >= pos);
    const selected = !selection.empty && selection.from <= pos && selection.to > pos;
    return { ok: shown || selected, label };
  } finally {
    done();
  }
}

const DOCUMENT = String.raw`\documentclass{article}
\usepackage{amsmath,amsthm}
\newtheorem{theorem}{Theorem}
\title{A Title}
\author{An Author}
\begin{document}
\maketitle
Plain text first, where the caret starts.

\section{Introduction}\label{sec:intro}
Some text\footnote{A note.} with dots\ldots{} and a dash -- and a break\\
on the next line, a formula $x^2$, a citation~\cite{key} and a reference~\ref{sec:intro}.

\subsection*{Unnumbered}
\begin{theorem}[Main]\label{thm:main}
Every $x$ is $x$.
\end{theorem}
\begin{proof}
Clear.
\end{proof}
\begin{proof} Indented, as math.GT 2611.08002 and math.PR 2611.15228 write it.
  \end{proof}
\begin{itemize}
\item One.
\item[$\star$] Two.
\end{itemize}
\begin{enumerate}
\item First.
\end{enumerate}
\begin{equation}
a = b \label{eq:a}
\end{equation}
\begin{table}[h]
\centering
\begin{tabular}{cc}
a & b \\
c & d
\end{tabular}
\caption{A table.}
\end{table}
\textbf{Bold} and \emph{emphasis} and \url{https://example.com}.
\begin{thebibliography}{9}
\bibitem{key} A. Author, A book.
\end{thebibliography}
\end{document}
`;

test("every widget drawn in a sample document shows its source when clicked (audit round 7)", () => {
  const { view, done } = mount(DOCUMENT);
  const count = widgets(view).length;
  const kinds = new Set(widgets(view).map((node) => node.className.split(" ")[0]));
  done();
  assert.ok(count >= 15, `expected many widgets, drew ${count}`);
  for (const kind of ["cm-vis-heading-number", "cm-vis-footnote-mark", "cm-vis-symbol", "cm-vis-linebreak", "cm-vis-env-header", "cm-vis-env-footer", "cm-vis-item"]) {
    assert.ok([...kinds].some((name) => name.startsWith(kind.split(" ")[0])), `the sample draws ${kind}: ${[...kinds].join(", ")}`);
  }
  const failures: string[] = [];
  for (let index = 0; index < count; index++) {
    const { ok, label } = clickShowsSource(DOCUMENT, index);
    if (!ok && !clickShowsSource(DOCUMENT, index, true).ok) failures.push(label);
  }
  assert.deepEqual(failures, [], "widgets a click does not open");
});

test("a heading's number opens the heading's source; a footnote mark, the footnote's", () => {
  const { view, done } = mount(DOCUMENT);
  const number = view.contentDOM.querySelector(".cm-vis-heading-number")!;
  number.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  const line = view.state.doc.lineAt(view.state.selection.main.head).text;
  assert.match(line, /^\\section\{Introduction\}/);
  assert.match(view.contentDOM.textContent ?? "", /\\section\{Introduction\}/);
  done();
  const second = mount(DOCUMENT);
  const mark = second.view.contentDOM.querySelector(".cm-vis-footnote-mark")!;
  mark.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  assert.match(second.view.contentDOM.textContent ?? "", /\\footnote\{A note\.\}/);
  second.done();
});

test("a click a widget handles itself is left to it; a right click is not taken", () => {
  const { view, done } = mount(DOCUMENT);
  const head = view.state.selection.main.head;
  const symbol = view.contentDOM.querySelector(".cm-vis-linebreak")!;
  symbol.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 }));
  assert.equal(view.state.selection.main.head, head);
  done();
});
