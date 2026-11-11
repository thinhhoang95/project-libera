import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { history } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { isInLatexComment } from "../../src/lib/latex/macros/definitions";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Document-class front matter (arXiv 2611.13560 MLSys, 2611.09434 revtex 4-2): what each class prints, with the source of anything
 * hidden or replaced one click away. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

/** The Visual mode's state for `doc`, with every pending piece built. */
function visualState(doc: string, extra: Extension[] = []) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [history(), latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }), ...extra] });
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

function mount(doc: string, extra: Extension[] = []) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, extra), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return view;
}

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

const click = (node: Element, init: Record<string, unknown> = {}) => node.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init }));
const press = (target: Element, key: string) => target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
const typeInto = (area: HTMLTextAreaElement, value: string) => { area.value = value; area.dispatchEvent(new window.Event("input", { bubbles: true })); };
const text = (view: EditorView) => view.contentDOM.textContent ?? "";
const titleBlock = (view: EditorView) => view.contentDOM.querySelector<HTMLElement>(".cm-vis-title-block");
const sourceButton = (view: EditorView) => view.contentDOM.querySelector<HTMLButtonElement>(".cm-vis-title-block .cm-vis-title-source");
const part = (view: EditorView, name: string, index = 0) => view.contentDOM.querySelector<HTMLElement>(`.cm-vis-title-block [data-title-part="${name}"][data-title-index="${index}"]`)!;
const cursorAt = (view: EditorView, needle: string, shift = 0) => view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf(needle) + shift } });
const editorArea = (view: EditorView) => view.contentDOM.querySelector<HTMLTextAreaElement>(".cm-vis-title-editor");

// MLSys (arXiv 2611.13560, cs.CL): the ICML class's macros under another prefix, the abstract inside `\twocolumn[{ … }]`.
const MLSYS = String.raw`\documentclass{article}
\usepackage[accepted,nohyperref]{mlsys2025}
\begin{document}
\twocolumn[{
\mlsystitle{Are Dense Rewards Worth Their Tokens?}
\begin{mlsysauthorlist}
\mlsysauthor{Vikash Singh}{cwru}
\mlsysauthor{Weicong Chen}{cwru}
\end{mlsysauthorlist}
\mlsysaffiliation{cwru}{Department of Computer Science, Case Western Reserve University}
\mlsyscorrespondingauthor{Vipin Chaudhary}{vipin@case.edu}
\mlsyskeywords{Reinforcement learning}
\vskip 0.3in
\begin{abstract}
RLVR trains language models to reason.
\end{abstract}
}]

\printAffiliationsAndNotice{}
\section{Introduction}
Body text.
\end{document}`;

test("2611.13560: MLSys's title block is drawn from its macros, the abstract inside \\twocolumn[{…}] stays an abstract", () => {
  const view = mount(MLSYS);
  const block = titleBlock(view)!;
  assert.ok(block, "a title block");
  assert.match(block.textContent ?? "", /Are Dense Rewards Worth Their Tokens\?/);
  assert.match(block.textContent ?? "", /Vikash Singh/);
  assert.match(block.textContent ?? "", /Weicong Chen/);
  assert.equal((block.textContent ?? "").split("Department of Computer Science").length - 1, 1, "one affiliation line for two authors of it");
  // The grammar has no environments inside `[…]`: the title block draws the abstract written in it.
  assert.match(block.querySelector(".cm-vis-title-abstract-heading")?.textContent ?? "", /Abstract/);
  assert.match(block.querySelector(".cm-vis-title-abstract-body")?.textContent ?? "", /RLVR trains language models to reason\./);
  const shown = text(view);
  assert.doesNotMatch(shown, /\\mlsys|\\twocolumn|\\printAffiliations|\\begin\{abstract|\}\]/);
  assert.deepEqual(left(view).filter((name) => name !== "end"), []);
  view.destroy();
});

test("2611.13560: MLSys's title block gives the source: a click on a name, on the title, the button, the closing `}]` under the cursor", () => {
  const view = mount(MLSYS);
  click(part(view, "author", 1));
  assert.equal(editorArea(view)!.value, "Weicong Chen");
  typeInto(editorArea(view)!, "Weicong Chen Jr.");
  press(editorArea(view)!, "Enter");
  assert.match(view.state.doc.toString(), /\\mlsysauthor\{Weicong Chen Jr\.\}\{cwru\}/);
  click(part(view, "title"));
  assert.equal(editorArea(view)!.value, "Are Dense Rewards Worth Their Tokens?");
  press(editorArea(view)!, "Escape");
  click(part(view, "abstract"));
  assert.equal(editorArea(view)!.value, "RLVR trains language models to reason.");
  typeInto(editorArea(view)!, "RLVR trains models.");
  press(editorArea(view)!, "Enter");
  assert.match(view.state.doc.toString(), /\\begin\{abstract\}\nRLVR trains models\.\n\\end\{abstract\}/);
  sourceButton(view)!.click();
  assert.match(text(view), /\\mlsysaffiliation\{cwru\}/);
  assert.match(text(view), /\\twocolumn\[\{/);
  assert.match(text(view), /\\mlsyscorrespondingauthor\{Vipin Chaudhary\}/);
  view.destroy();
  const closing = mount(MLSYS);
  assert.equal(text(closing).includes("}]"), false);
  cursorAt(closing, "}]\n", 1);
  assert.match(text(closing), /\}\]/);
  closing.destroy();
});

test("a `\\twocolumn[…]` whose block is not a title is a wrapper: its text is drawn, the delimiters fold away and show at the cursor", () => {
  for (const [open, close] of [["\\twocolumn[{", "}]"], ["\\twocolumn[", "]"]]) {
    const doc = `\\documentclass{article}\n\\begin{document}\n${open}\nText set across both columns, with $x$.\n${close}\nAfter.\n\\end{document}`;
    const view = mount(doc);
    const shown = text(view);
    assert.match(shown, /Text set across both columns/, open);
    assert.equal(shown.includes("\\twocolumn"), false, open);
    assert.equal(shown.includes(close), false, open);
    assert.deepEqual(left(view).filter((name) => name !== "end"), [], open);
    cursorAt(view, "\\twocolumn", 3);
    assert.ok(text(view).includes(open), `${open} shows with the cursor in it`);
    cursorAt(view, `\n${close}\n`, 1);
    assert.ok(text(view).includes(close), `${close} shows with the cursor in it`);
    view.destroy();
  }
});

test("ICML's block keeps its title block, with affiliations told apart by number when they differ", () => {
  const view = mount(String.raw`\documentclass{article}
\usepackage{icml2025}
\begin{document}
\twocolumn[
\icmltitle{An ICML Title}
\begin{icmlauthorlist}
\icmlauthor{Alice One}{a}
\icmlauthor{Bob Two}{a,b}
\end{icmlauthorlist}
\icmlaffiliation{a}{University A}
\icmlaffiliation{b}{Institute B}
]
Text.
\end{document}`);
  const block = titleBlock(view)!.textContent ?? "";
  assert.match(block, /Alice One1/);
  assert.match(block, /Bob Two1,2/);
  assert.match(block, /1University A|1 University A/);
  assert.match(block, /Institute B/);
  sourceButton(view)!.click();
  assert.match(text(view), /\\icmlaffiliation\{b\}\{Institute B\}/);
  view.destroy();
});

// JHEP's `jheppub` (arXiv 2611.12698, hep-th): every `\author[n]{…}` is an author, `\affiliation[n]{…}` numbers the places and
// `\abstract{…}` is the abstract; the sweep found only the last author and no abstract.
test("2611.12698: jheppub's title block shows all authors, the affiliations and the abstract, each way back to its source", () => {
  const doc = String.raw`\documentclass{article}
\usepackage{jheppub}
\title{On a Topological Term}
\author[1]{Marek Li\v{s}ka}
\emailAdd{liska@example.org}
\author[2]{and David Kubi\v{z}n\'{a}k}
\affiliation[1]{School of Theoretical Physics, Dublin}
\affiliation[2]{Institute of Theoretical Physics, Prague}
\abstract{We revisit the thermodynamic implications of the term.}
\begin{document}
\maketitle
\section{Introduction}
Text.
\end{document}`;
  const view = mount(doc);
  const block = titleBlock(view)!;
  assert.ok(block);
  assert.match(block.textContent ?? "", /Marek Liška/);
  assert.match(block.textContent ?? "", /and David Kubižnák/);
  assert.match(block.textContent ?? "", /1 School of Theoretical Physics, Dublin/);
  assert.match(block.textContent ?? "", /2 Institute of Theoretical Physics, Prague/);
  assert.match(block.querySelector(".cm-vis-title-abstract-body")?.textContent ?? "", /We revisit the thermodynamic implications/);
  // Click-to-edit the first author and the abstract; the button shows every command.
  click(part(view, "author", 0));
  assert.equal(editorArea(view)!.value, String.raw`Marek Li\v{s}ka`);
  press(editorArea(view)!, "Escape");
  click(part(view, "abstract"));
  assert.equal(editorArea(view)!.value, "We revisit the thermodynamic implications of the term.");
  press(editorArea(view)!, "Escape");
  sourceButton(view)!.click();
  assert.match(text(view), /\\affiliation\[2\]\{Institute of Theoretical Physics, Prague\}/);
  assert.match(text(view), /\\emailAdd\{liska@example\.org\}/);
  view.destroy();
});

// revtex's `\acknowledgments` (arXiv 2611.09434, cond-mat.str-el): an unnumbered heading, the text after it plain.
test("2611.09434: revtex's \\acknowledgments is the Acknowledgments heading, its source shown at the cursor", () => {
  const doc = String.raw`\documentclass[aps,pra]{revtex4-2}
\begin{document}
\section{Intro}
Text.
\acknowledgments
Thanks to X.
\bibliography{refs}
\end{document}`;
  const view = mount(doc);
  assert.equal(left(view).includes("acknowledgments"), false);
  assert.match(view.contentDOM.querySelector(".cm-vis-env-header")?.textContent ?? "", /Acknowledgments/);
  assert.equal(text(view).includes("\\acknowledgments"), false);
  assert.match(text(view), /Thanks to X\./);
  cursorAt(view, "\\acknowledgments", 4);
  assert.ok(text(view).includes("\\acknowledgments"), "the cursor on the line shows the command");
  view.destroy();
  // With an argument (another class's command) it stays source.
  const other = mount(doc.replace("\\acknowledgments\n", "\\acknowledgments{Thanks}\n"));
  assert.ok(left(other).includes("acknowledgments"));
  other.destroy();
});

// revtex's `widetext` (arXiv 2611.09434): a transparent environment, also when it runs past a build piece.
test("2611.09434: widetext pairs, its end folded away and shown at the cursor, even across build pieces", () => {
  // Without `widetext` among the environments drawn whole, its `\end` was left as source in a document of this shape (the piece
  // that held it did not know the environment began in the one before).
  const lines = (name: string, count: number) => Array.from({ length: count }, (_, index) => `${name} ${index} text set across both columns, long enough to fill a piece.`).join("\n");
  const doc = String.raw`\documentclass[aps,pra]{revtex4-2}
\begin{document}
\section{Intro}
${lines("Pre", 20)}
\begin{widetext}
\begin{eqnarray}
K&=&a\nonumber\\&&+c.
\end{eqnarray}
${lines("Mid", 20)}
\end{widetext}
After.
${lines("Post", 140)}
\end{document}`;
  const view = mount(doc);
  assert.deepEqual(left(view).filter((name) => /widetext/.test(name)), []);
  const endAt = doc.indexOf("\\end{widetext}");
  let covered = false;
  view.state.field(structuralField).shown.between(endAt, endAt + 1, (from, to, decoration) => { if (decoration.point && from <= endAt && to > endAt) covered = true; });
  assert.ok(covered, "\\end{widetext} is folded away");
  view.dispatch({ selection: { anchor: endAt + 3 } });
  assert.match(text(view), /\\end\{widetext\}/);
  view.destroy();
});
