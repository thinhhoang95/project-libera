import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { setMacroSources, setNumbering, visualDefinitions, type MacroSource } from "../../src/lib/latex/codemirror/visual/model";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { isInLatexComment } from "../../src/lib/latex/macros/definitions";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Audit round 6, small text commands, lists and environments: the end mark `\qed` (2611.12330), enumitem's inline lists
 * (2611.05705), math in an index entry (2611.09689), `\smash`, `\savenotes` (2611.05417) and more. Every widget these draw
 * shows its source when clicked. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function visualState(doc: string, anchor: number, sources: MacroSource[]) {
  let state = EditorState.create({ doc, selection: { anchor }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" })] });
  ensureSyntaxTree(state, doc.length, 5000);
  if (sources.length) state = state.update({ effects: setMacroSources.of(sources) }).state;
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

/** A mounted Visual mode for `doc`, numbered as the app numbers it, the caret at `anchor` (the start by default). */
function mount(doc: string, anchor = 0, sources: MacroSource[] = []) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, anchor, sources), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return { view, numbering, done: () => { view.destroy(); parent.remove(); } };
}

const text = (view: EditorView) => view.contentDOM.textContent ?? "";
const click = (node: Element) => node.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));

/** The commands of the document that nothing drawn covers: what the view still shows as source (the audit's "left"). */
function left(view: EditorView) {
  const doc = view.state.doc.toString();
  const shown = view.state.field(structuralField).shown;
  const covered = (pos: number) => {
    let inside = false;
    shown.between(pos, pos + 1, (from, to, decoration) => { if (decoration.point && from <= pos && to > pos) { inside = true; return false; } });
    return inside;
  };
  const found: string[] = [];
  for (const match of doc.matchAll(/\\(?:begin\s*\{([^}]*)\}|([a-zA-Z@]+))/g)) {
    const pos = match.index!;
    if ((pos > 0 && doc[pos - 1] === "\\") || isInLatexComment(doc, pos) || covered(pos)) continue;
    found.push(match[1] !== undefined ? `begin{${match[1]}}` : match[2]);
  }
  return found;
}

const inDoc = (source: string, preamble = "") => `\\documentclass{article}\n${preamble}\\begin{document}\n${source}\n\\end{document}\n`;
const lines = (view: EditorView) => [...view.contentDOM.querySelectorAll(".cm-line")].map((line) => (line.textContent ?? "").replace(/[​⁣]/g, "").replace(/\s+/g, " ").trim()).filter((line) => line && !/^(?:\\?documentclass|\\?begin\s*document|\\?end\s*document|\\end\{document\})/.test(line));
/** A mounted document body: its drawn lines and the commands still shown as source (the caret is at the start). */
function body(source: string, preamble = "") {
  const { view, done } = mount(inDoc(source, preamble));
  return { view, lines: lines(view), left: left(view).filter((name) => name !== "end"), done };
}

/** The source the view shows for the caret placed in the `needle` of `source` (the widget there gives way to it). */
function withCaretIn(source: string, needle: string, preamble = "") {
  const doc = inDoc(source, preamble);
  const at = doc.indexOf(needle) + 1;
  const { view, done } = mount(doc, at);
  return { view, done, text: text(view) };
}

const THEOREMS = String.raw`\newtheorem{theorem}{Theorem}
`;

test("llncs's \\qed before \\end{proof} is hidden (the proof draws its own mark), elsewhere it is a square (math.CO 2611.12330)", () => {
  const proof = body(String.raw`\begin{proof}
Hence the claim holds.
\qed
\end{proof}`);
  assert.deepEqual(proof.left, []);
  assert.equal(proof.lines.filter((line) => /[∎□]/.test(line)).length, 1, `one mark, not a doubled one: ${proof.lines.join("|")}`);
  assert.ok(!proof.lines.some((line) => /qed/.test(line)));
  proof.done();
  // The caret in a hidden `\qed` shows its source.
  const hidden = withCaretIn(String.raw`\begin{proof}
Hence.
\qed
\end{proof}`, "\\qed");
  assert.match(hidden.text, /\\qed/);
  hidden.done();
  // Running text: `\hfill\qed` and `\qedsymbol` draw the square; a click shows the source.
  const running = body(String.raw`This ends it. \hfill\qed

Also \qedsymbol here.`);
  assert.deepEqual(running.left, []);
  const marks = [...running.view.contentDOM.querySelectorAll(".cm-vis-qed")];
  assert.equal(marks.length, 2);
  click(marks[1]);
  assert.match(text(running.view), /\\qedsymbol/);
  running.done();
});

test("enumitem's inline lists draw their items with the list's labels, and a marker shows its source when clicked (cs.GT 2611.05705)", () => {
  const source = String.raw`If the procedure terminates, then there is a finite $M$ such that either
\begin{enumerate*}
	\item $M=0$ and $S^{m}=S$, or
	\item $S^{M} \subsetneq S^{M-1}$ and $S^{m} = S^{M}$.
\end{enumerate*}
In that case, say that it \textbf{terminates}.

We have \begin{enumerate*}[label=(\roman*)]
\item first, \item second, or
\item third.
\end{enumerate*}`;
  const { view, lines: drawn, left: rest, done } = body(source);
  assert.deepEqual(rest, []);
  const joined = drawn.join("\n");
  assert.match(joined, /1\.M=0 and/);
  assert.match(joined, /2\.SM⊊SM−1/);
  assert.match(joined, /\(i\)first,/);
  assert.match(joined, /\(ii\)second, or/);
  assert.match(joined, /\(iii\)third\./);
  assert.doesNotMatch(joined, /\\item|enumerate\*/);
  const markers = [...view.contentDOM.querySelectorAll(".cm-vis-item")];
  assert.equal(markers.length, 5);
  assert.ok(markers.every((marker) => marker.classList.contains("cm-vis-item-inline")));
  click(markers[1]);
  assert.match(text(view), /\\item SM⊊SM−1/);
  done();
  // itemize*.
  const other = body(String.raw`\begin{itemize*}
\item red
\item blue
\end{itemize*}`);
  assert.deepEqual(other.left, []);
  assert.match(other.lines.join("\n"), /•red/);
  other.done();
});

test("math in an index entry is drawn, never shown as raw dollars; a click shows the source (math.DG 2611.09689)", () => {
  const source = String.raw`\begin{definition}\index{$\phi$}\index{horizontal area $\mathcal F$}\index{the twistor lift of $a \in T_S\mathcal{S}(X)$} Text.\end{definition}`;
  const { view, done } = mount(inDoc(source, String.raw`\newtheorem{definition}{Definition}
`));
  const chips = [...view.contentDOM.querySelectorAll(".cm-vis-index")];
  assert.equal(chips.length, 3);
  for (const chip of chips) {
    assert.doesNotMatch(chip.textContent ?? "", /\$|\\(?!\\)/);
    assert.ok(chip.querySelector(".katex"), "the formula is drawn");
  }
  assert.match(chips[1].textContent ?? "", /horizontal area/);
  click(chips[0]);
  assert.match(text(view), /\\index\{\$\\phi\$\}/);
  done();
});

test("\\smash, savenotes, a size switch before a group and \\tnote draw their text (econ.TH 2611.05417, econ.EM 2610.41881)", () => {
  const { view, lines: drawn, left: rest, done } = body(String.raw`\underline{\smash{\emph{One human type.}}} A step. \smash[b]{Low} text.

\large{\textbf{APPENDIX}}

\begin{savenotes}
\begin{itemize}
\item A fact.\footnote{Why.}
\end{itemize}
\end{savenotes}

\emph{Panel B: flat rate}\tnote{c}\par`);
  assert.deepEqual(rest, []);
  const joined = drawn.join("\n");
  assert.match(joined, /One human type\. A step\. Low text\./);
  assert.match(joined, /APPENDIX/);
  assert.match(joined, /•A fact\./);
  assert.match(joined, /Panel B: flat ratec/);
  assert.equal(view.contentDOM.querySelector(".cm-vis-u .cm-vis-em")?.textContent, "One human type.");
  assert.ok(view.contentDOM.querySelectorAll(".cm-vis-sup").length >= 1);
  done();
  // The caret in a hidden `\smash` or `\large` shows its source.
  const smash = withCaretIn(String.raw`\smash{Low} text.`, "\\smash");
  assert.match(smash.text, /\\smash\{Low\}/);
  smash.done();
  const large = withCaretIn(String.raw`\large{\textbf{APPENDIX}}`, "\\large");
  assert.match(large.text, /\\large/);
  large.done();
});

test("{\\color{black} …} and a bibliography's style inside a size group draw nothing of their own (math.NA 2611.09593, math.FA 2611.07785)", () => {
  const { lines: drawn, left: rest, done } = body(String.raw`Before.

{\color{black}
The right side is assembled. Then
\begin{equation}\label{eq:a}
U = 1.
\end{equation}
\subsection{Inside}
More text.
}

{\footnotesize\bibliographystyle{abbrv}
\bibliography{refs}
}{\footnotesize\par}`);
  assert.deepEqual(rest, []);
  assert.ok(drawn.includes("The right side is assembled. Then"), drawn.join("|"));
  assert.doesNotMatch(drawn.join("\n"), /color|bibliographystyle|abbrv/);
  done();
  const color = withCaretIn(String.raw`{\color{black}
Text.
\subsection{Inside}
More.
}`, "\\color");
  assert.match(color.text, /\\color\{black\}/);
  color.done();
});

test("a macro for \\paragraph that is another macro takes the title after it; \\texorpdfstring's bookmark on the next line is hidden (cs.CC 2611.07413)", () => {
  const preamble = String.raw`\newcommand{\para}[1]{\vspace{0.5em}\noindent {\bf #1}}
\renewcommand{\paragraph}{\para}
`;
  const paragraph = body(String.raw`Some text.

\paragraph{A powerful decision oracle.}
An $x$ problem has two verifiers.`, preamble);
  assert.deepEqual(paragraph.left, []);
  assert.ok(paragraph.lines.some((line) => /^A powerful decision oracle\./.test(line)), paragraph.lines.join("|"));
  paragraph.done();
  const title = body(String.raw`\section{Intro}
\subsection{\texorpdfstring{Proof of $H_1\sim H_2$}
{From  H1 to H2}}
\label{sec:ind}
Text.`);
  assert.deepEqual(title.left, []);
  assert.ok(title.lines.some((line) => /Proof of H1∼H2$/.test(line)), title.lines.join("|"));
  assert.ok(!title.lines.some((line) => /From\s+H1 to H2/.test(line)));
  title.done();
});

test("a samepage around a theorem folds away at both ends (cs.DS 2611.10283)", () => {
  const { lines: drawn, left: rest, done } = body(String.raw`\begin{samepage}
\begin{theorem}
Foo holds.
\end{theorem}
\end{samepage}

We remark that it is so.`, THEOREMS);
  assert.deepEqual(rest, []);
  assert.doesNotMatch(drawn.join("\n"), /samepage/);
  done();
});

test("sgame's strategic-form game is drawn as a table, a click shows the source (cs.GT 2611.05706)", () => {
  const source = String.raw`\begin{center}
\begin{game}{2}{2}[Player $i$][Player $j$]
 & $+1$ & $-1$\\
$+1$ & $1-\gamma_i,\;1-\gamma_j$ & $0,0$\\
$-1$ & $0,0$ & $\gamma_i,\;\gamma_j$
\end{game}
\end{center}
After the game.`;
  const { view, left: rest, done } = body(source, String.raw`\usepackage{sgame}
`);
  assert.deepEqual(rest, []);
  const table = view.contentDOM.querySelector(".cm-vis-tabular");
  assert.ok(table, "the game is a table");
  assert.equal(table!.querySelectorAll("tr").length, 4);
  const cells = table!.textContent ?? "";
  assert.match(cells, /Player i/);
  assert.match(cells, /Player j/);
  assert.doesNotMatch(cells, /\\|\$|begin/);
  table!.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, altKey: true }));
  assert.match(text(view), /\\begin\{game\}\{2\}\{2\}/);
  done();
  // Rows or columns other than the header declares: source.
  const wrong = body(String.raw`\begin{game}{2}{2}
 & $+1$ & $-1$\\
$+1$ & $1$ & $0$
\end{game}`, String.raw`\usepackage{sgame}
`);
  assert.equal(wrong.view.contentDOM.querySelector(".cm-vis-tabular"), null);
  wrong.done();
});

