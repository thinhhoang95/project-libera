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

const WIDE_DEFS = String.raw`\newcommand{\TableText}{\footnotesize}
\newenvironment{widefigure}{\begin{figure*}[!tp]\setkeys{Gin}{trim=3pt 3pt 3pt 3pt}}{\end{figure*}}
\newenvironment{widetable}{\begin{table*}[!tp]}{\end{table*}}
`;
const WIDE_BODY = String.raw`Text \ref{fig:m}, \ref{tab:a} and \ref{fig:p}.

\begin{widefigure}
\centering
\includegraphics{figures/method.pdf}
\caption{One coded step.}
\label{fig:m}
\end{widefigure}

\begin{widetable}
\centering
\caption{Ablation.}
\label{tab:a}
\TableText
\setlength{\tabcolsep}{4pt}
\begin{tabular}{ll}
a & b \\
\end{tabular}
\end{widetable}

\begin{figure}
\includegraphics{figures/plain.pdf}
\caption{Plain.}
\label{fig:p}
\end{figure}`;

function wideChecks(view: EditorView) {
  assert.deepEqual(left(view), []);
  assert.ok(!text(view).includes("widefigure") && !text(view).includes("TableText"), text(view));
  const figures = [...view.contentDOM.querySelectorAll(".cm-vis-figure")];
  assert.ok(figures.length >= 2, view.contentDOM.innerHTML);
  assert.match(figures[0].textContent ?? "", /Figure 1: One coded step/);
  assert.match(figures[1].textContent ?? "", /Table 1: Ablation/);
  assert.deepEqual([...view.contentDOM.querySelectorAll(".cm-vis-ref")].map((node) => node.textContent), ["1", "1", "2"]);
}

test("a user environment that opens `figure*` / `table*` is drawn and numbered as that float, in the file that defines it (eess.SP 2611.19192)", () => {
  const { view, done } = mount(inDoc(WIDE_BODY, WIDE_DEFS));
  wideChecks(view);
  done();
});

test("the same in a chapter file whose definitions come from the main file's macro sources, and a click on it shows its source (eess.SP 2611.19192)", () => {
  const chapter = `${WIDE_BODY}\n`;
  const { view, done } = mount(chapter, 0, [{ path: "nb/main.tex", text: `\\documentclass{IEEEtran}\n${WIDE_DEFS}\\begin{document}\n\\input{chapter}\n\\end{document}\n`, version: "1" }]);
  wideChecks(view);
  const source = view.state.doc.toString();
  // A click selects the whole wrapper (the float's own behaviour); Alt-click shows its source.
  const begin = source.indexOf("\\begin{widefigure}");
  const end = source.indexOf("\\end{widefigure}") + "\\end{widefigure}".length;
  click(view.contentDOM.querySelector(".cm-vis-figure-image")!);
  assert.deepEqual([view.state.selection.main.from, view.state.selection.main.to], [begin, end]);
  view.contentDOM.querySelector(".cm-vis-figure-image")!.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, altKey: true }));
  assert.match(text(view), /\\begin\{widefigure\}/);
  assert.match(text(view), /\\end\{widefigure\}/);
  done();
});

test("a user environment is a float only when its code opens and closes one: other code stays a plain user environment (eess.SP 2611.19192)", () => {
  const defs = String.raw`\newenvironment{halffigure}{\begin{figure}\vspace{3em}\begin{center}}{\end{center}\end{figure}}
\newenvironment{oddtable}{\begin{table}}{\end{figure}}
`;
  const { view, done } = mount(inDoc("\\begin{oddtable}\n\\caption{X}\n\\end{oddtable}\n\n\\begin{halffigure}\n\\caption{Y}\n\\end{halffigure}", defs));
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-figure").length, 0);
  done();
});

test("a user macro that is only a size switch is hidden like the switch itself, and its source shows at the caret (eess.SP 2611.19192)", () => {
  const pre = "\\newcommand{\\TableText}{\\footnotesize}\n\\newcommand{\\Mixed}{\\footnotesize x}\n";
  const source = "Before.\n\n\\TableText\nUser size.\n\n\\Mixed\nMixed.";
  const doc = body(source, pre);
  assert.deepEqual(doc.lines, ["Before.", "User size.", "x", "Mixed."]);
  assert.deepEqual(doc.left, []);
  doc.done();
  const full = inDoc(source, pre);
  const caret = mount(full, full.lastIndexOf("\\TableText") + 2);
  assert.match(text(caret.view), /\\TableText\s*User size/);
  caret.done();
});

test("a deluxetable cell with `\\parbox[t]{9cm}{\\raggedright …}` draws its text, `NaN` and `6$''$` included, and the `\\edef`/`\\setlength` before it draw nothing odd (astro-ph.EP 2611.16046)", () => {
  const source = String.raw`\edef\savedtabcolsep{\the\tabcolsep}\setlength{\tabcolsep}{4pt}
\begin{deluxetable*}{ll}
\tabletypesize{\scriptsize}
\tablecaption{The frame criteria.\label{tab:rules}}
\tablehead{\colhead{Criterion} & \colhead{Test}}
\startdata
pixels & \parbox[t]{9.0cm}{\raggedright PS1 and ZTF: masked pixels are not used. The Mt Lemmon telescopes and CFHT: a NaN or saturated pixel within the fit radius, or a Gaia source within 6$''$ puts the frame out.} \\
fit area & \parbox[t]{2.3cm}{\raggedright PS1} \\
\enddata
\end{deluxetable*}
\setlength{\tabcolsep}{\savedtabcolsep}`;
  const doc = body(source, "\\usepackage{aastex701}\n");
  assert.deepEqual(doc.left, []);
  const table = doc.view.contentDOM.querySelector(".cm-vis-figure");
  assert.ok(table, doc.view.contentDOM.innerHTML);
  const shown = table.textContent ?? "";
  assert.match(shown, /a NaN or saturated pixel within the fit radius/);
  assert.doesNotMatch(shown, /\\[a-zA-Z]{2,}|parbox|raggedright|savedtabcolsep/);
  doc.done();
});

test("an `\\item[...]` label with a command nothing knows stays source, no widget with raw LaTeX; one with a macro the document defines is drawn (hep-ex 2611.16454)", () => {
  const list = (label: string) => `\\begin{description}\n\\item[${label}] The fraction.\n\\end{description}`;
  const unknown = body(list("Momentum \\unknownmacro ($\\unknownmacro^2$):"));
  assert.deepEqual(unknown.view.contentDOM.querySelectorAll(".cm-vis-item-description").length, 0);
  assert.match(text(unknown.view), /\\item\[Momentum \\unknownmacro/);
  assert.ok(![...unknown.view.contentDOM.querySelectorAll(".cm-vis-item")].some((node) => /\\/.test(node.textContent ?? "")));
  unknown.done();
  const pre = "\\newcommand{\\pT}{\\ensuremath{p_{\\text{T}}}\\xspace}\n";
  const known = body(list("Fraction of track-plus-EM-system \\pT ($\\pT^\\mathrm{EM+track} / \\pT$):"), pre);
  const marker = known.view.contentDOM.querySelector(".cm-vis-item");
  assert.ok(marker, known.view.contentDOM.innerHTML);
  assert.doesNotMatch(marker.textContent ?? "", /\\[a-zA-Z]/);
  assert.match(marker.textContent ?? "", /Fraction of track-plus-EM-system/);
  assert.ok(marker.querySelector(".katex"), marker.innerHTML);
  // A click on the marker shows its source.
  click(marker);
  assert.match(text(known.view), /\\item\[Fraction of track-plus-EM-system \\pT/);
  known.done();
});

test("a macro named like a conditional (`\\ifb` for inverse femtobarns) opens no conditional, so a `\\clearpage` restored later by `\\let` is hidden (hep-ex 2611.16454)", () => {
  const pre = "\\newcommand*{\\ifb}{fb\\(^{-1}\\)}\n";
  const src = "\\let\\clearpagebak\\clearpage\n\\let\\clearpage\\relax\n\nText one \\ifb, two.\n\n\\let\\clearpage\\clearpagebak\n%\n\n\\clearpage\n\nText two.\n\n\\clearpage\n";
  const d = body(src, pre);
  assert.ok(!d.left.includes("clearpage"), `left: ${d.left.join(" ")}`);
  assert.ok(!d.lines.join(" ").includes("clearpage"), d.lines.join(" | "));
  d.done();
  // The caret on a `\clearpage` shows its source (a layout command reveals where it stands).
  const full = inDoc(src, pre);
  const caret = mount(full, full.lastIndexOf("\\clearpage") + 2);
  assert.match(text(caret.view), /\\clearpage/);
  caret.done();
});
