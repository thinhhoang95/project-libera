import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import katex from "katex";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { forKatex, KATEX_MACROS } from "../../src/lib/latex/codemirror/visual/math-render";
import { preambleOpenField, setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { emptyLatexDefinitions, readLatexDefinitions } from "../../src/lib/latex/macros/definitions";
import { expandLatexMacros } from "../../src/lib/latex/macros/expand";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Audit round 4b, math.CO 2611.13390: `\@fnsymbol` in an author's note mark, macros a `\loop` makes by name (`\cV`),
 * `varwidth`, and `\hfill {\huge $\lrcorner$}`. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function settle(state: EditorState) {
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

function mount(doc: string, anchor = doc.length) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  const state = settle(EditorState.create({ doc, selection: { anchor }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" })] }));
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state, parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return view;
}

/** What a mounted Visual mode shows for `doc` with the cursor at `anchor`. */
function visibleText(doc: string, anchor = doc.length) {
  const view = mount(doc, anchor);
  const text = view.contentDOM.textContent ?? "";
  view.destroy();
  return text;
}

const mouse = (node: Element, init: Record<string, unknown> = {}) => node.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init }));

const renders = (latex: string) => {
  try { katex.renderToString(forKatex(latex), { throwOnError: true, strict: "ignore", macros: { ...KATEX_MACROS } }); return true; } catch { return false; }
};

const THANKS_DOC = String.raw`\documentclass{amsart}
\makeatletter
\newcommand\thankssymb[1]{\textsuperscript{\@fnsymbol{#1}}}
\makeatother
\title{A Title}
\author[L.~Real]{Lucas Real\thankssymb{1}}
\thanks{\thankssymb{1} Supported by a grant.}
\author[R.~Schaut]{Roman Schaut\thankssymb{2}}
\thanks{\thankssymb{2} Supported by a scholarship.}
\begin{document}
\maketitle
Text.
\end{document}`;

test("\\@fnsymbol{n} is the footnote symbol: the title block shows Lucas Real*, Roman Schaut†, never fnsymbol (2611.13390)", () => {
  const view = mount(THANKS_DOC);
  const block = view.contentDOM.querySelector(".cm-vis-title-block")!;
  assert.ok(block);
  const text = block.textContent ?? "";
  assert.match(text, /Lucas Real\*/);
  assert.match(text, /Roman Schaut†/);
  assert.doesNotMatch(view.contentDOM.textContent ?? "", /fnsymbol|undefined/);
  // The author is still reachable: Edit source unfolds the preamble and puts the cursor in the block's source.
  view.contentDOM.querySelector<HTMLButtonElement>(".cm-vis-title-block .cm-vis-title-source")!.click();
  assert.equal(view.state.field(preambleOpenField), true);
  assert.match(view.contentDOM.textContent ?? "", /\\author\[L\.~Real\]\{Lucas Real\\thankssymb\{1\}\}/);
  view.destroy();
});

test("a title-block author name is clickable to its source: mousedown with Alt reveals the real source (2611.13390)", () => {
  const view = mount(THANKS_DOC);
  const author = view.contentDOM.querySelector<HTMLElement>('.cm-vis-title-block [data-title-part="author"]')!;
  assert.ok(author);
  mouse(author, { altKey: true });
  assert.equal(view.state.field(preambleOpenField), true);
  assert.ok(view.state.selection.main.head <= THANKS_DOC.indexOf("\\title"));
  view.destroy();
});

test("\\@fnsymbol expands to the whole sequence and leaves numbers it has no symbol for as source", () => {
  const defs = readLatexDefinitions(String.raw`\newcommand\ts[1]{\textsuperscript{\@fnsymbol{#1}}}`);
  const expand = (use: string) => expandLatexMacros(use, defs, { mode: "text" });
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => expand(`\\ts{${n}}`).text), ["*", "†", "‡", "§", "¶", "‖", "**", "††", "‡‡"].map((symbol) => `\\textsuperscript{${symbol}}`));
  // Ten has no symbol, a counter is not known here, and in a formula the text symbols are not used: not expanded.
  for (const use of [String.raw`\ts{10}`, String.raw`\ts{x}`, String.raw`\ts{0}`]) {
    const result = expand(use);
    assert.equal(result.ok, false, use);
    assert.equal(result.text, use);
  }
  assert.equal(expandLatexMacros(String.raw`$\ts{1}$`, defs, { mode: "text" }).ok, false);
});

const FACTORY = String.raw`\documentclass{amsart}
\makeatletter
\def\calCommandfactory#1{%
  \expandafter\def\csname c#1\endcsname{\mathcal{#1}}}
\def\frakCommandfactory#1{%
  \expandafter\def\csname frak#1\endcsname{\mathfrak{#1}}}
\newcounter{ctr}
\loop
  \stepcounter{ctr}
  \edef\X{\@Alph\c@ctr}
  \expandafter\calCommandfactory\X
  \expandafter\frakCommandfactory\X
\ifnum\thectr<26
\repeat
\makeatother
`;

test("a \\loop that makes \\cA…\\cZ through \\csname defines them, so $(T, \\cV)$ draws (2611.13390)", () => {
  const defs = readLatexDefinitions(FACTORY, emptyLatexDefinitions(), { file: "Preamble.tex" });
  assert.equal(defs.macros.get("cA")?.at(-1)?.body, String.raw`\mathcal{A}`);
  assert.equal(defs.macros.get("cZ")?.at(-1)?.body, String.raw`\mathcal{Z}`);
  assert.equal(defs.macros.get("frakV")?.at(-1)?.body, String.raw`\mathfrak{V}`);
  assert.equal(defs.macros.get("cAA"), undefined);
  for (const use of [String.raw`(T, \cV)`, String.raw`G/ \cV`, String.raw`\frakM_\cT`]) {
    const expanded = expandLatexMacros(use, defs, { mode: "math", pos: 1000 });
    assert.ok(expanded.ok, use);
    assert.ok(renders(expanded.text), expanded.text);
    assert.doesNotMatch(expanded.text, /\\(?:c|frak)[A-Z](?![A-Za-z])/);
  }
  assert.equal(expandLatexMacros(String.raw`\cV`, defs, { mode: "math", pos: 1000 }).text, String.raw`\mathcal{V}`);
  // In the document: the formula is KaTeX, not source.
  const doc = `${FACTORY}\\begin{document}\nA tree $(T, \\cV)$ and $G/ \\cV$.\n\\end{document}`;
  const view = mount(doc, 0);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  assert.doesNotMatch(view.contentDOM.textContent ?? "", /\\cV/);
  view.destroy();
});

test("a \\loop that is not a bounded macro factory defines nothing and cannot hang", () => {
  const read = (loop: string) => readLatexDefinitions(`\\newcounter{ctr}\n\\def\\f#1{\\expandafter\\def\\csname c#1\\endcsname{\\mathcal{#1}}}\n${loop}`, emptyLatexDefinitions(), { file: "P.tex" });
  // The test never fails: more passes than allowed.
  assert.equal(read(String.raw`\loop \stepcounter{ctr} \edef\X{\@Alph\c@ctr} \expandafter\f\X \ifnum\thectr>-1 \repeat`).macros.get("cA"), undefined);
  // A counter that is never stepped.
  assert.equal(read(String.raw`\loop \edef\X{\@Alph\c@ctr} \expandafter\f\X \ifnum\thectr<26 \repeat`).macros.get("cA"), undefined);
  // Letters run out past 26.
  assert.equal(read(String.raw`\loop \stepcounter{ctr} \edef\X{\@Alph\c@ctr} \expandafter\f\X \ifnum\thectr<40 \repeat`).macros.get("cA"), undefined);
  // An unknown statement in the body.
  assert.equal(read(String.raw`\loop \stepcounter{ctr} \typeout{hi} \edef\X{\@Alph\c@ctr} \expandafter\f\X \ifnum\thectr<4 \repeat`).macros.get("cA"), undefined);
  // The factory is not defined (or takes the letter in a way that is not read).
  assert.equal(read(String.raw`\loop \stepcounter{ctr} \edef\X{\@Alph\c@ctr} \expandafter\g\X \ifnum\thectr<4 \repeat`).macros.get("cA"), undefined);
  // A shorter loop works and stops where the test says.
  const short = read(String.raw`\loop \stepcounter{ctr} \edef\X{\@Alph\c@ctr} \expandafter\f\X \ifnum\thectr<3 \repeat`);
  assert.deepEqual(["cA", "cB", "cC", "cD"].map((name) => !!short.macros.get(name)), [true, true, true, false]);
  // A counter without a \newcounter before is not known: nothing.
  assert.equal(readLatexDefinitions(String.raw`\loop \stepcounter{zz} \edef\X{\@Alph\c@zz} \expandafter\f\X \ifnum\thezz<3 \repeat`, emptyLatexDefinitions(), { file: "P.tex" }).macros.get("cA"), undefined);
});

const VARWIDTH = String.raw`\documentclass{amsart}
\usepackage{varwidth,enumitem}
\begin{document}
Connected superset
\begin{center}
    \begin{varwidth}{\linewidth}
        \begin{enumerate}[label=$(*)$, leftmargin=*]
            \item\label{item:V} $V \supseteq X$
        \end{enumerate}
    \end{varwidth}
\end{center}
contained in $D$.
\end{document}`;

test("varwidth is a transparent wrapper: begin and end hidden, shown at the cursor (2611.13390)", () => {
  const text = visibleText(VARWIDTH, 0);
  assert.doesNotMatch(text, /varwidth|\\linewidth/);
  assert.match(text, /contained in/);
  assert.doesNotMatch(text, /\\begin\{enumerate\}/);
  // The cursor in the folded lines shows each as source, so they can be edited.
  assert.match(visibleText(VARWIDTH, VARWIDTH.indexOf("\\begin{varwidth}") + 5), /\\begin\{varwidth\}\{\\linewidth\}/);
  assert.match(visibleText(VARWIDTH, VARWIDTH.indexOf("\\end{varwidth}") + 5), /\\end\{varwidth\}/);
  // The optional position and a width in the argument fold with the line too.
  const positioned = VARWIDTH.replace("\\begin{varwidth}{\\linewidth}", "\\begin{varwidth}[t]{0.5\\textwidth}");
  assert.doesNotMatch(visibleText(positioned, 0), /varwidth|textwidth/);
});

const MARK = String.raw`\documentclass{amsart}
\usepackage{stmaryrd}
\begin{document}
Proof text.

\hfill {\huge $\lrcorner$}

\vspace{0.5cm}

After.
\end{document}`;

test("\\hfill {\\huge $\\lrcorner$} draws the mark, right-aligned, with the source back at the cursor (2611.13390)", () => {
  const view = mount(MARK, 0);
  const text = view.contentDOM.textContent ?? "";
  assert.doesNotMatch(text, /\\hfill|\\huge|\\lrcorner/);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  assert.ok(view.contentDOM.querySelector(".cm-vis-math"), "the formula is drawn");
  const line = [...view.contentDOM.querySelectorAll(".cm-line")].find((item) => item.querySelector(".cm-vis-hfill"));
  assert.ok(line?.classList.contains("cm-vis-hfill-right"), "alone on its line, the mark is pushed right");
  view.destroy();
  // The cursor on `\hfill`, or in the group's braces or `\huge`, shows the source to edit.
  const at = (needle: string, shift: number) => MARK.indexOf(needle) + shift;
  assert.match(visibleText(MARK, at("\\hfill", 3)), /\\hfill/);
  assert.match(visibleText(MARK, at("{\\huge", 3)), /\{\\huge/);
  // Click-to-source: Alt-mousedown on the drawn formula puts the caret in it, and the source shows (a plain click opens the
  // math editor, which the app installs). No new widget kind: the gap is the `\hfill` symbol, the formula the usual one.
  const clicked = mount(MARK, 0);
  const dd = clicked.contentDOM.querySelector<HTMLElement>(".cm-vis-math-inline")!;
  mouse(dd, { altKey: true });
  assert.match(clicked.contentDOM.textContent ?? "", /\\lrcorner/);
  clicked.destroy();
});

test("\\hfill before a size group in the middle of a line stays a gap, not pushed right; a group with no switch is left alone", () => {
  const body = (line: string) => `\\documentclass{amsart}\n\\begin{document}\nProof.\n\n${line}\n\nAfter.\n\\end{document}`;
  const middle = mount(body("Left \\hfill {\\small right}"), 0);
  assert.doesNotMatch(middle.contentDOM.textContent ?? "", /\\hfill|\\small/);
  assert.equal(middle.contentDOM.querySelector(".cm-vis-hfill-right"), null, "text before the fill: not pushed right");
  middle.destroy();
  assert.match(visibleText(body("\\hfill {right}"), 0), /right/);
});

