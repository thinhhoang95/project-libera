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

/* Audit round 9, floats, tables, list labels and the user wrappers around them (arXiv 2611.*). Every widget these draw shows its source when clicked. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function visualState(doc: string, anchor: number, sources: MacroSource[]) {
  let state = EditorState.create({ doc, selection: { anchor }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" })] });
  ensureSyntaxTree(state, doc.length, 5000);
  // The finished tree is only in the parse context until a transaction goes through: `syntaxTree(state)` (what numbering and the builds read) is the
  // short one the first 20 ms of parsing made, on a busy machine. Run an empty one so the state carries the whole tree.
  state = state.update({}).state;
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
  assert.equal(syntaxTree(view.state).length, doc.length, "the view starts from the whole parse tree");
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return { view, numbering, done: () => { view.destroy(); parent.remove(); } };
}

const text = (view: EditorView) => view.contentDOM.textContent ?? "";

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

test("a label whose key holds a command stays source, no raw command in a chip (physics.hist-ph 2609.14600)", () => {
  const { view, lines: drawn, done } = body("\\begin{lstlisting}\nx = 1\n\\end{lstlisting}\\label{LISTING\\thelstlisting}\n\nText \\label{ok}.");
  assert.deepEqual([...view.contentDOM.querySelectorAll(".cm-vis-label")].map((chip) => chip.textContent), ["ok"], drawn.join("|"));
  assert.ok(text(view).includes("\\label{LISTING\\thelstlisting}"));
  done();
});

test("subappendices: its lines fold away and its sections are the chapter's appendices, 1.A and 1.B (physics.hist-ph 2609.14600)", () => {
  const source = "\\chapter{First}\n\\section{Body}\nText.\n\\begin{subappendices}\n\\section{Proof}\\label{pr}\nMore.\n\\subsection{Detail}\n\\end{subappendices}\n\\section{After}\nSee \\ref{pr}.";
  const full = `\\documentclass{book}\n\\usepackage{appendix}\n\\begin{document}\n${source}\n\\end{document}\n`;
  const { view, done } = mount(full);
  assert.deepEqual(left(view).filter((name) => name !== "end"), []);
  assert.ok(!text(view).includes("subappendices"), text(view));
  const shown = [...view.contentDOM.querySelectorAll(".cm-line")].map((line) => (line.textContent ?? "").replace(/\s+/g, " ").trim());
  assert.ok(shown.some((line) => /^1\.A\s*Proof/.test(line)), shown.join("|"));
  assert.ok(shown.some((line) => /^1\.A\.1\s*Detail/.test(line)), shown.join("|"));
  assert.ok(shown.some((line) => /^1\.2\s*After/.test(line)), shown.join("|"));
  assert.equal(view.contentDOM.querySelector(".cm-vis-ref")?.textContent, "1.A");
  done();
  const caret = mount(full, full.indexOf("\\begin{subappendices}") + 3);
  assert.match(text(caret.view), /\\begin\{subappendices\}/);
  caret.done();
});

test("REVTeX's \\NoCaseChange in a heading and seqsplit in text draw their text (physics.soc-ph 2611.10574, q-bio.BM 2610.24806)", () => {
  const { lines: drawn, left: rest, done } = body("\\section{Proofs of theorems~\\NoCaseChange{(ii)} and \\NoCaseChange{(iv)}}\n\nSequence \\seqsplit{ACGTACGT} ends.");
  assert.deepEqual(rest, []);
  assert.ok(drawn.some((line) => /Proofs of theorems\s*\(ii\) and \(iv\)/.test(line)), drawn.join("|"));
  assert.ok(drawn.some((line) => /Sequence ACGTACGT ends\./.test(line)), drawn.join("|"));
  done();
});

test("float placement settings and fancyhdr page styles print nothing, their source shows at the caret (nlin.PS 2610.37990, cs.AR 2611.19101)", () => {
  const settings = "\\makeatletter\\renewcommand{\\fps@table}{!htbp}\\renewcommand{\\fps@figure}{!htbp}\\makeatother";
  const style = "\\fancypagestyle{firstpagestyle}{%\n\\fancyhf{}%\n\\renewcommand{\\headrulewidth}{0pt}%\n\\fancyfoot[C]{\\footnotesize Accepted to \\emph{X}, 2026.}%\n}\n\\thispagestyle{firstpagestyle}";
  const { lines: drawn, left: rest, done } = body(`Before.\n\n${settings}\n\n${style}\n\nAfter.`);
  assert.deepEqual(rest, []);
  assert.deepEqual(drawn, ["Before.", "After."]);
  done();
  const full = inDoc(`Before.\n\n${settings}\n\n${style}\n\nAfter.`);
  for (const marker of ["\\fps@table", "\\fancyhf"]) {
    const caret = mount(full, full.indexOf(marker) + 2);
    assert.ok(text(caret.view).includes(marker), `${marker}: ${text(caret.view)}`);
    caret.done();
  }
});

test("`\\begin{center}{\\large\\bfseries Heading}\\end{center}` on one line is a centred bold heading (nlin.PS 2610.37990)", () => {
  const { view, lines: drawn, left: rest, done } = body("\\begin{center}{\\large\\bfseries Supplemental Material}\\end{center}");
  assert.deepEqual(rest, []);
  assert.deepEqual(drawn, ["Supplemental Material"]);
  assert.ok(view.contentDOM.querySelector(".cm-vis-center"), view.contentDOM.innerHTML);
  assert.ok(view.contentDOM.querySelector(".cm-vis-b"), view.contentDOM.innerHTML);
  done();
  const full = inDoc("\\begin{center}{\\large\\bfseries Supplemental Material}\\end{center}");
  const atStart = mount(full, full.indexOf("\\begin{center}") + 3);
  assert.ok(text(atStart.view).includes("\\begin{center}") && !text(atStart.view).includes("\\end{center}"), text(atStart.view));
  atStart.done();
  const atEnd = mount(full, full.indexOf("\\end{center}") + 3);
  assert.ok(text(atEnd.view).includes("\\end{center}") && !text(atEnd.view).includes("\\begin{center}"), text(atEnd.view));
  atEnd.done();
});

test("`\\boldmath … \\unboldmath` in an item: bold formulas, the switches print nothing and show at the caret (cs.SI 2611.09126)", () => {
  const source = "\\begin{itemize}\n\\item \\boldmath$\\alpha$ and $\\beta$\\unboldmath. These two coefficients.\n\\item Plain $x$.\n\\end{itemize}";
  const { view, lines: drawn, left: rest, done } = body(source);
  assert.deepEqual(rest, []);
  assert.ok(!drawn.join("|").includes("boldmath"), drawn.join("|"));
  const bold = view.contentDOM.querySelector(".cm-vis-b");
  assert.ok(bold, view.contentDOM.innerHTML);
  done();
  const full = inDoc(source);
  const caret = mount(full, full.indexOf("\\unboldmath") + 3);
  assert.ok(text(caret.view).includes("\\unboldmath"), text(caret.view));
  caret.done();
});
