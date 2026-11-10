import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { history, undo } from "@codemirror/commands";
import { setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { graphicsStyle, refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { EditorState, Transaction, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* The "edit the components" round, floats: a float stays drawn around the parts it cannot draw (shown as source, or a
 * placeholder naming them, inside it), captions are edited in place, `\subcaptionbox` panels, side-by-side minipages
 * outside floats, `\includegraphics` options, and floats typed progressively. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

/** The Visual mode's state for `doc`, with every pending piece built. */
function visualState(doc: string, extra: Extension[] = [], selection = doc.length) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  let state = EditorState.create({ doc, selection: { anchor: selection }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }), ...extra] });
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

/** Constructs as "kind:from:to": what the structural layer has built. */
function constructs(state: EditorState) {
  const list: string[] = [];
  state.field(structuralField).extents.between(0, state.doc.length, (from, to, mark) => { list.push(`${mark.kind}:${from}:${to}`); });
  return list;
}

function mountView(doc: string, extra: Extension[] = []) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, extra), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return view;
}

/** What a mounted Visual mode shows for `doc`: its text (widgets' included) and the source it shows as code. */
function mounted(doc: string, extra: Extension[] = []) {
  const view = mountView(doc, extra);
  const text = view.contentDOM.textContent ?? "";
  const raw = [...view.contentDOM.querySelectorAll(".cm-vis-raw")].map((node) => node.textContent ?? "");
  const html = view.contentDOM.innerHTML;
  view.destroy();
  return { text, raw, html };
}

const drawnFloats = (doc: string) => constructs(visualState(doc)).filter((item) => item.startsWith("figure:")).length;
const inDocument = (body: string, preamble = "") => `\\documentclass{article}\n${preamble}\\begin{document}\n${body}\n\\end{document}\n`;
const mouse = (type: string, init: Record<string, unknown> = {}) => new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
const key = (name: string, init: Record<string, unknown> = {}) => new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });

/* ---- 1. A float stays drawn around what it cannot draw ---------------------------------------------------------- */

test("\\rowcolors before a tabular in a table float: a source line inside the drawn float, caption and grid drawn", () => {
  // The tables round reads `\rowcolors` as the grid's alternating fills, so it is no longer a source part; an unknown
  // command next to it stands for the part the float cannot draw.
  const doc = inDocument("\\begin{table}\n\\centering\n\\rowcolors{1}{gray!10}{white}\n\\mytablesetup{2pt}\n\\begin{tabular}{ll}\na & b \\\\\nc & d \\\\\n\\end{tabular}\n\\caption[Short]{A table}\n\\label{tab:a}\n\\end{table}");
  assert.equal(drawnFloats(doc), 1);
  const { text, raw, html } = mounted(doc);
  assert.match(text, /Table 1: A table/);
  assert.match(html, /cm-vis-table-cell/);
  assert.match(html, /data-fill/, "\\rowcolors is understood: alternating row fills");
  assert.deepEqual(raw, ["\\mytablesetup{2pt}"]);
  assert.match(html, /cm-vis-figure-source-before/, "drawn above the grid, where it is written");
});

test("listings, framed text, forest trees and chemfig in a float are placeholders naming them; unknown commands are source lines", () => {
  const doc = inDocument(String.raw`\begin{figure}
\centering
\begin{lstlisting}
x = 1
\end{lstlisting}
\begin{framed}
Boxed words.
\end{framed}
\begin{forest}
[S [NP] [VP]]
\end{forest}
\chemfig{A-B}
\mystery{x} \another
\includegraphics{a.png}
\caption{Many things}
\end{figure}`);
  assert.equal(drawnFloats(doc), 1);
  const { text, raw } = mounted(doc);
  // A listing written in the float is drawn as code (the text round's code blocks): a placeholder would hide the code.
  assert.match(text, /x = 1/);
  assert.doesNotMatch(text, /Code \(lstlisting\)/);
  assert.match(text, /Tree \(forest\)/);
  assert.match(text, /Chemical structure \(chemfig\)/);
  assert.match(text, /Figure 1: Many things/);
  // Framed text is prose: it stays visible as source (a placeholder would hide the words), apart from the other parts.
  assert.deepEqual(raw, ["\\begin{framed}\nBoxed words.\n\\end{framed}", "\\mystery{x} \\another"], "framed text and two unknown commands on one line: source parts, the commands one line");
  assert.doesNotMatch(text, /Framed text \(framed\)/);
  assert.doesNotMatch(text, /NP/, "a drawing's placeholder shows its name, not a drawing of its content");
});

test("\\includesvg is an image, \\subimport a drawing from its file, and a \\subcaptionbox in a float is a panel", () => {
  const doc = inDocument("\\begin{figure}\n\\includesvg[width=0.5\\linewidth]{plots/x}\n\\subimport{figs/}{tree}\n\\caption{Imported}\n\\end{figure}");
  assert.equal(drawnFloats(doc), 1);
  const { text, raw } = mounted(doc);
  assert.match(text, /plots\/x\.svg/);
  assert.match(text, /figs\/tree\.tex/);
  assert.deepEqual(raw, []);
});

test("a float holding only what it cannot draw stays source; a parse error inside still leaves it source", () => {
  assert.equal(drawnFloats(inDocument("\\begin{figure}\n\\mystery{x}\n\\end{figure}")), 0);
  assert.equal(drawnFloats(inDocument("\\begin{figure}\n\\begin{forest}\n[S]\n\\end{forest}\n\\end{figure}")), 0);
});

test("a part shown as source in a minipage panel stays in that panel", () => {
  const doc = inDocument("\\begin{figure}\n\\begin{minipage}{0.48\\linewidth}\n\\includegraphics{a}\n\\mystery\n\\caption{Left}\n\\end{minipage}\\hfill\n\\begin{minipage}{0.48\\linewidth}\n\\includegraphics{b}\n\\caption{Right}\n\\end{minipage}\n\\end{figure}");
  assert.equal(drawnFloats(doc), 1);
  const view = mountView(doc);
  const panels = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-figure-panel")];
  assert.equal(panels.length, 2);
  assert.equal(panels[0].querySelector(".cm-vis-raw")?.textContent, "\\mystery");
  assert.equal(panels[1].querySelector(".cm-vis-raw"), null);
  assert.equal(panels[0].style.getPropertyValue("--vis-panel-width"), "48%");
  view.destroy();
});

test("clicking a part shown as source edits only that part; Enter writes the changed characters as one undo step", async () => {
  // An unknown command is the part shown as source (`\rowcolors` is understood since the tables round).
  const doc = inDocument("\\begin{table}\n\\mytablesetup{gray!10}\n\\begin{tabular}{l}\na \\\\\n\\end{tabular}\n\\caption{T}\n\\end{table}");
  const view = mountView(doc, [history()]);
  const part = view.contentDOM.querySelector<HTMLElement>(".cm-vis-figure-source")!;
  part.dispatchEvent(mouse("mousedown"));
  const area = part.querySelector("textarea")!;
  assert.ok(area, "an editor opens over the part");
  assert.equal(area.value, "\\mytablesetup{gray!10}");
  assert.ok(view.contentDOM.querySelector(".cm-vis-table-cell"), "the rest of the float stays drawn");
  area.value = "\\mytablesetup{gray!20}";
  area.dispatchEvent(new dom.window.Event("input"));
  area.dispatchEvent(key("Enter"));
  assert.equal(view.state.doc.toString(), doc.replace("gray!10", "gray!20"));
  undo(view);
  assert.equal(view.state.doc.toString(), doc);
  view.destroy();
});

/* ---- 2. Captions edited in place --------------------------------------------------------------------------------- */

test("clicking a caption edits its LaTeX in place: Enter saves the changed characters, the short title and label stay", async () => {
  const doc = inDocument("\\begin{figure}\n\\includegraphics{a}\n\\caption[Short]{A \\textbf{long} caption}\n\\label{fig:a}\n\\end{figure}");
  const written: Array<[number, number, string]> = [];
  const view = mountView(doc, [history(), EditorView.updateListener.of((update) => update.changes.iterChanges((from, to, _a, _b, inserted) => written.push([from, to, inserted.toString()])))]);
  const caption = view.contentDOM.querySelector<HTMLElement>(".cm-vis-caption-text")!;
  caption.dispatchEvent(mouse("mousedown"));
  const area = caption.querySelector("textarea")!;
  assert.equal(area.value, "A \\textbf{long} caption");
  area.value = "A \\textbf{longer} caption";
  area.dispatchEvent(new dom.window.Event("input"));
  area.dispatchEvent(key("Enter"));
  assert.equal(view.state.doc.toString(), doc.replace("{long}", "{longer}"));
  // Only "er" was written.
  const at = doc.indexOf("long}") + 4;
  assert.deepEqual(written, [[at, at, "er"]]);
  undo(view);
  assert.equal(view.state.doc.toString(), doc, "one undo step");
  view.destroy();
});

test("Escape cancels a caption edit; a sub-figure's caption is edited too", () => {
  const doc = inDocument("\\begin{figure}\n\\begin{subfigure}{0.4\\linewidth}\n\\includegraphics{a}\n\\caption{Left part}\n\\end{subfigure}\n\\caption{Whole}\n\\end{figure}", "\\usepackage{subcaption}\n");
  const view = mountView(doc);
  const captions = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-caption-text")];
  assert.deepEqual(captions.map((caption) => caption.textContent), ["Left part", "Whole"]);
  captions[0].dispatchEvent(mouse("mousedown"));
  const area = captions[0].querySelector("textarea")!;
  assert.equal(area.value, "Left part");
  area.value = "Changed";
  area.dispatchEvent(new dom.window.Event("input"));
  area.dispatchEvent(key("Escape"));
  assert.equal(view.state.doc.toString(), doc);
  assert.equal(captions[0].textContent, "Left part");
  view.destroy();
});

test("a co-author's edit to the caption while it is edited asks before replacing it", () => {
  const doc = inDocument("\\begin{figure}\n\\includegraphics{a}\n\\caption{Mine}\n\\end{figure}");
  const view = mountView(doc);
  const caption = view.contentDOM.querySelector<HTMLElement>(".cm-vis-caption-text")!;
  caption.dispatchEvent(mouse("mousedown"));
  const area = caption.querySelector("textarea")!;
  area.value = "Mine, edited";
  area.dispatchEvent(new dom.window.Event("input"));
  const at = view.state.doc.toString().indexOf("Mine");
  view.dispatch({ changes: { from: at, to: at + 4, insert: "Theirs" }, annotations: Transaction.remote.of(true) });
  const confirm = window.confirm;
  let asked = 0;
  window.confirm = () => { asked++; return false; };
  try {
    const open = view.contentDOM.querySelector<HTMLTextAreaElement>(".cm-vis-float-editor") ?? area;
    open.dispatchEvent(key("Enter"));
  } finally {
    window.confirm = confirm;
  }
  assert.equal(asked, 1);
  assert.match(view.state.doc.toString(), /\\caption\{Theirs\}/);
  view.destroy();
});

/* ---- 3. \subcaptionbox ------------------------------------------------------------------------------------------- */

test("\\subcaptionbox panels are lettered with their captions, and \\ref to them agrees", () => {
  const doc = inDocument(String.raw`\begin{figure}
\centering
\subcaptionbox{Left\label{fig:l}}[0.45\linewidth]{\includegraphics{a.png}}
\hfill
\subcaptionbox{Right\label{fig:r}}{\includegraphics{b.png}}
\caption{Two panels}
\label{fig:two}
\end{figure}
See \ref{fig:l}, \ref{fig:r} and \ref{fig:two}.`, "\\usepackage{subcaption}\n");
  assert.equal(drawnFloats(doc), 1);
  const view = mountView(doc);
  const panels = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-figure-panel")];
  assert.deepEqual(panels.map((panel) => panel.querySelector(".cm-vis-caption")?.textContent), ["(a) Left", "(b) Right"]);
  assert.equal(panels[0].style.getPropertyValue("--vis-panel-width"), "45%");
  assert.match(view.contentDOM.textContent ?? "", /Figure 1: Two panels/);
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  assert.equal(numbering.labels.get("fig:l")?.number, "1a");
  assert.equal(numbering.labels.get("fig:r")?.number, "1b");
  assert.equal(numbering.labels.get("fig:two")?.number, "1");
  view.destroy();
});

/* ---- 4. Side-by-side minipages outside floats -------------------------------------------------------------------- */

test("side-by-side minipages outside floats are columns at their widths, each with its content", () => {
  const doc = inDocument(String.raw`\noindent
\begin{minipage}{0.6\textwidth}
Left text with $x^2$.
\end{minipage}\hfill
\begin{minipage}{0.35\textwidth}
\begin{itemize}
\item one
\item two
\end{itemize}
\end{minipage}

After.`);
  const view = mountView(doc);
  const columns = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-column")];
  assert.equal(columns.length, 2);
  assert.deepEqual(columns.map((column) => column.style.getPropertyValue("--vis-column-width")), ["60%", "35%"]);
  assert.match(columns[0].textContent ?? "", /Left text with/);
  assert.deepEqual([...columns[1].querySelectorAll("li")].map((item) => item.textContent), ["one", "two"]);
  assert.match(view.contentDOM.textContent ?? "", /After\./);
  view.destroy();
});

test("minipage columns with a tabular, an image and parboxes; what a column cannot draw is shown as its source", () => {
  const doc = inDocument(String.raw`\begin{minipage}{0.5\linewidth}
\begin{tabular}{ll}
a & b \\
\end{tabular}
\end{minipage}%
\begin{minipage}{0.5\linewidth}
\includegraphics[width=\linewidth]{a.png}
\mystery{z}
\end{minipage}

\parbox{0.45\textwidth}{Box one.}\hfill\parbox{0.45\textwidth}{Box two.}`);
  const view = mountView(doc);
  const rows = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-columns")];
  assert.equal(rows.length, 2);
  assert.ok(rows[0].querySelector(".cm-vis-table-cell"));
  assert.match(rows[0].textContent ?? "", /a\.png/);
  assert.ok([...rows[0].querySelectorAll(".cm-vis-raw")].some((code) => /\\mystery/.test(code.textContent ?? "")));
  assert.deepEqual([...rows[1].querySelectorAll(".cm-vis-column")].map((column) => column.textContent), ["Box one.", "Box two."]);
  view.destroy();
});

/* ---- 5. \includegraphics options ---------------------------------------------------------------------------------- */

test("\\includegraphics options are read for the image's style", () => {
  assert.deepEqual(graphicsStyle("height=3cm,keepaspectratio"), { height: "3cm", keepAspect: true });
  assert.deepEqual(graphicsStyle("scale=0.5, angle=90"), { scale: 0.5, angle: 90 });
  assert.deepEqual(graphicsStyle("trim=10 20 30 40, clip"), { trim: [10, 20, 30, 40] });
  assert.equal(graphicsStyle("trim=10 20 30 40"), null, "trim without clip draws the whole image, as TeX does");
  assert.deepEqual(graphicsStyle("page=3"), { page: 3 });
  assert.equal(graphicsStyle("width=\\linewidth"), null);
});

/* ---- 6. Floats and minipages typed progressively ----------------------------------------------------------------- */

test("a float or minipage being typed stays source until complete and does not swallow what follows", () => {
  const finished = "\\begin{figure}\n\\includegraphics{a.png}\n\\caption{Typed}\n\\end{figure}";
  const after = "\n\\section{Next}\nMore text.";
  for (let cut = 1; cut < finished.length; cut++) {
    const doc = inDocument(finished.slice(0, cut) + after);
    const state = visualState(doc, [], doc.indexOf(after));
    assert.equal(constructs(state).filter((item) => item.startsWith("figure:")).length, 0, `incomplete at ${cut}: ${JSON.stringify(finished.slice(0, cut))}`);
    // An unclosed `{` (`\includegraphics{a`) takes what follows into its group in TeX too: only a closed one is checked.
    const open = (finished.slice(0, cut).match(/\{/g) ?? []).length - (finished.slice(0, cut).match(/\}/g) ?? []).length;
    if (!open) assert.ok(constructs(state).some((item) => item.startsWith("heading")), `the section after stays drawn at ${cut}`);
  }
  assert.equal(drawnFloats(inDocument(finished + after)), 1);
  const columns = "\\begin{minipage}{0.4\\linewidth}\nA\n\\end{minipage}\\hfill\n\\begin{minipage}{0.4\\linewidth}\nB\n\\end{minipage}";
  for (let cut = 1; cut < columns.length; cut++) {
    const view = mountView(inDocument(columns.slice(0, cut) + after));
    assert.equal(view.contentDOM.querySelectorAll(".cm-vis-columns").length, 0, `columns incomplete at ${cut}`);
    view.destroy();
  }
  const view = mountView(inDocument(columns + after));
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-column").length, 2);
  view.destroy();
});

test("edits around floats with source parts build the same constructs as a fresh build", () => {
  const doc = inDocument("\\begin{table}\n\\rowcolors{2}{gray!10}{white}\n\\begin{tabular}{l}\na \\\\\n\\end{tabular}\n\\caption{T}\n\\end{table}\nText.");
  const view = mountView(doc);
  const at = doc.indexOf("\\rowcolors");
  view.dispatch({ changes: { from: at, insert: "\\foo " } });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  view.dispatch({});
  assert.deepEqual(constructs(view.state), constructs(visualState(view.state.doc.toString())));
  view.destroy();
});
