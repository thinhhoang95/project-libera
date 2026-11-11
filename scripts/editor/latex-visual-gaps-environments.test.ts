import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Environments, boxes, lists and table rules (audit round 3, environments area): user boxes across the pieces of a long
 * document, wrappers that only box or lay out their content (adjustbox, lrbox, multicols), LaTeX's own `list` and
 * `trivlist`, counter and box declarations, and the rules of a file of table rows with no table around it. Everything
 * drawn stays editable: the cursor on a folded line shows its source. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

/** The Visual mode's state for `doc`, with every pending piece built. */
function visualState(doc: string, extra: Extension[] = [], selection = doc.length) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  let state = EditorState.create({ doc, selection: { anchor: selection }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }), ...extra] });
  for (let guard = 0; state.field(structuralField).pending.length && guard < 400; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

function mountView(doc: string, selection = doc.length) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, [], selection), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return view;
}

/** What a mounted Visual mode shows for `doc` with the cursor at `selection`. */
function mounted(doc: string, selection = doc.length) {
  const view = mountView(doc, selection);
  const text = view.contentDOM.textContent ?? "";
  const html = view.contentDOM.innerHTML;
  view.destroy();
  return { text, html };
}

/** The commands the way the audit counts them: in the body and not under anything the view replaces. */
function leftCommands(state: EditorState) {
  const shown = state.field(structuralField).shown;
  const doc = state.doc.toString();
  const covered = (pos: number) => {
    let inside = false;
    shown.between(pos, pos + 1, (from, to, decoration) => { if (decoration.point && from <= pos && to > pos) { inside = true; return false; } });
    return inside;
  };
  const bodyFrom = doc.indexOf("\\begin{document}") + "\\begin{document}".length;
  const bodyTo = doc.indexOf("\\end{document}");
  const left: string[] = [];
  for (const match of doc.slice(bodyFrom, bodyTo).matchAll(/\\(?:begin\s*\{([^}]*)\}|([a-zA-Z@]+))/g)) {
    const pos = bodyFrom + match.index!;
    if (doc[pos - 1] === "\\" || covered(pos)) continue;
    left.push(match[1] !== undefined ? `begin{${match[1]}}` : match[2]);
  }
  return left;
}

const inDocument = (body: string, preamble = "") => `\\documentclass{article}\n${preamble}\\begin{document}\n${body}\n\\end{document}\n`;
const constructKinds = (state: EditorState) => {
  const kinds: string[] = [];
  state.field(structuralField).extents.between(0, state.doc.length, (from, to, mark) => { kinds.push(`${mark.kind}:${from}:${to}`); });
  return kinds;
};

/* ---- 1. A user box across the pieces of a long document ------------------------------------------------------- */

test("hep-th 2611.09538: a \\newtcolorbox box that a piece boundary cuts is folded at its \\end too", () => {
  // The document is built in pieces; a box whose `\begin` is in one and `\end` in the next used to leave `\end{mainbox}`.
  const preamble = "\\usepackage[most]{tcolorbox}\n\\newtcolorbox{mainbox}{breakable,colback=blue!3,colframe=blue!45!black,boxrule=0.5pt,arc=2pt}\n";
  const filler = (n: number) => `${"Some running text of the paper, a sentence. ".repeat(14)}\\label{p${n}}\n\n`;
  let body = "";
  for (let n = 0; n < 40; n++) body += filler(n) + `\\begin{mainbox}\n\\textbf{Principle ${n}.} A statement in the box, long enough to span a line or two of the editor.\n\n\\smallskip\n\\textbf{Method.} Another paragraph in the same box, then a list:\n\\begin{enumerate}\n\\item \\emph{Lift.} One.\n\\item \\emph{Identify.} Two.\n\\end{enumerate}\n\\end{mainbox}\n\n`;
  const doc = inDocument(body, preamble);
  assert.ok(doc.length > 30_000);
  const state = visualState(doc);
  const ends = [...doc.matchAll(/\\end\{mainbox\}/g)].map((match) => match.index!);
  assert.equal(ends.length, 40);
  const kinds = constructKinds(state);
  const unfolded = ends.filter((at) => !kinds.some((kind) => { const [name, from, to] = kind.split(":"); return name === "env-end" && Number(from) <= at && Number(to) > at; }));
  assert.deepEqual(unfolded, [], "every \\end{mainbox} line is folded");
  assert.deepEqual(leftCommands(state).filter((name) => name === "end"), []);
});

test("a framed prose box (framed, shaded, leftbar) in the text is a frame around its lines, its begin and end folded", () => {
  const doc = inDocument("Before.\n\n\\begin{framed}\nFramed prose with $x^2$.\n\\end{framed}\n\nAfter.", "\\usepackage{framed}\n");
  const state = visualState(doc);
  assert.deepEqual(leftCommands(state), []);
  const view = mountView(doc);
  assert.ok(view.contentDOM.querySelector(".cm-vis-box"), "its lines carry the frame");
  assert.doesNotMatch(view.contentDOM.textContent ?? "", /\\begin\{framed\}|\\end\{framed\}/);
  // The cursor on the folded `\begin` line shows its source: it stays editable.
  view.dispatch({ selection: { anchor: doc.indexOf("\\begin{framed}") + 3 } });
  assert.match(view.contentDOM.textContent ?? "", /\\begin\{framed\}/);
  view.destroy();
});

/* ---- 2. Wrappers around a tabular, a box saved for later --------------------------------------------------------- */

test("hep-th 2611.09538: adjustbox around a tabular outside a float is transparent, its begin and end folded", () => {
  const doc = inDocument("\\begin{center}\\small\n\\begin{adjustbox}{max width=\\textwidth}\\begin{tabular}{@{}lll@{}}\n\\toprule\n& Parent & Quotient \\\\\n\\midrule\naffine group & $1728$ & 8 \\\\\n\\bottomrule\n\\end{tabular}\\end{adjustbox}\n\\end{center}", "\\usepackage{adjustbox,booktabs}\n");
  const state = visualState(doc);
  assert.deepEqual(leftCommands(state), []);
  const { text, html } = mounted(doc);
  assert.match(html, /cm-vis-table-cell/);
  assert.doesNotMatch(text, /adjustbox|max width/);
  // Editable: the cursor in the folded `\begin{adjustbox}{…}` shows it.
  const view = mountView(doc, doc.indexOf("max width") + 2);
  assert.match(view.contentDOM.textContent ?? "", /\\begin\{adjustbox\}\{max width=\\textwidth\}/);
  view.destroy();
});

test("a table inside a transparent wrapper stays editable: a click on a cell opens it in place", () => {
  const doc = inDocument("\\begin{adjustbox}{max width=\\textwidth}\\begin{tabular}{ll}\na & b \\\\\nc & d\n\\end{tabular}\\end{adjustbox}", "\\usepackage{adjustbox}\n");
  const view = mountView(doc);
  const cells = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-table-cell[data-row]")];
  assert.equal(cells.length, 4);
  cells[0].dispatchEvent(new dom.window.MouseEvent("mousedown", { button: 0, bubbles: true }));
  assert.equal(cells[0].getAttribute("contenteditable"), "true");
  view.destroy();
});

test("bare \\resizebox / \\scalebox around a tabular, and threeparttable with tablenotes outside a float, leave no command", () => {
  const body = "\\resizebox{\\textwidth}{!}{%\n\\begin{tabular}{ll}\na & b \\\\\n\\end{tabular}}\n\n\\begin{center}\n\\scalebox{0.9}{\\begin{tabular}{ll}\na & b \\\\\n\\end{tabular}}\n\\end{center}\n\n\\begin{threeparttable}\n\\begin{tabular}{ll}\na\\tnote{1} & b \\\\\n\\end{tabular}\n\\begin{tablenotes}\n\\item[1] A note.\n\\item[2] Another note.\n\\end{tablenotes}\n\\end{threeparttable}";
  const doc = inDocument(body, "\\usepackage{graphicx,threeparttable}\n");
  assert.deepEqual(leftCommands(visualState(doc)), []);
  const view = mountView(doc);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-table-cell[data-row]").length >= 4, true);
  assert.doesNotMatch(view.contentDOM.textContent ?? "", /\\resizebox|\\scalebox|tablenotes/);
  // The cursor in the hidden `\resizebox{…}{!}{` shows it.
  view.dispatch({ selection: { anchor: doc.indexOf("\\resizebox") + 4 } });
  assert.match(view.contentDOM.textContent ?? "", /\\resizebox\{\\textwidth\}\{!\}/);
  view.destroy();
});

test("sideways, multicols and adjustwidth are transparent; their arguments fold with the begin line", () => {
  const body = "\\begin{sideways}\nTurned text.\n\\end{sideways}\n\n\\begin{multicols}{2}[\\section*{Two columns}]\nColumn text.\n\\end{multicols}\n\n\\begin{adjustwidth}{1cm}{1cm}\nIndented text.\n\\end{adjustwidth}\n";
  const doc = inDocument(body, "\\usepackage{rotating,multicol,changepage}\n");
  const state = visualState(doc);
  assert.deepEqual(leftCommands(state).filter((name) => /begin|end|textwidth/.test(name)), []);
  const { text } = mounted(doc);
  assert.match(text, /Turned text\./);
  assert.match(text, /Column text\./);
  assert.doesNotMatch(text, /\\begin\{(?:sideways|multicols|adjustwidth)\}/);
});

test("cs.CL 2611.11316 toc.tex: \\newsavebox, lrbox, \\counterwithin* and \\newcounter are definitions that fold; the lrbox content is faded", () => {
  const body = "\\newsavebox{\\ArticleHoldoutCoverage}\n\\begin{lrbox}{\\ArticleHoldoutCoverage}\n\\begin{minipage}{\\columnwidth}\nSaved text.\n\\end{minipage}\n\\end{lrbox}\n\\newcounter{note}[section]\n\\counterwithin*{table}{section}\n\\counterwithin{figure}{section}\n\\setcounter{note}{2}\n\nBody paragraph.";
  const doc = inDocument(body, "\\usepackage{chngcntr}\n");
  const state = visualState(doc);
  assert.deepEqual(leftCommands(state).filter((name) => !/^(?:usebox|ArticleHoldoutCoverage)$/.test(name)), []);
  const { html, text } = mounted(doc);
  assert.match(html, /cm-vis-disabled/, "the box's content is faded, not hidden");
  assert.match(text, /Saved text\./);
  assert.doesNotMatch(text, /\\newsavebox|\\counterwithin|\\newcounter/);
  // The cursor on a folded declaration shows it.
  const view = mountView(doc, doc.indexOf("\\counterwithin*") + 4);
  assert.match(view.contentDOM.textContent ?? "", /\\counterwithin\*\{table\}\{section\}/);
  view.destroy();
});

/* ---- 3. LaTeX's own list and trivlist ------------------------------------------------------------------------------- */

test("astro-ph.GA 2611.07227 getgaia2.tex: \\begin{list}{}{\\setlength…} with \\item[Tier 1.] is a list with its labels", () => {
  const doc = inDocument("\\begin{list}{}{\\setlength{\\labelwidth}{3.0em}\\setlength{\\leftmargin}{3.4em}\\setlength{\\labelsep}{0.4em}\\setlength{\\itemsep}{1pt}\\setlength{\\parsep}{0pt}\\setlength{\\topsep}{3pt}}\n\\item[Tier 1.] The position alone (blind mode).\n\\item[Tier 2.] The position and the literature distance.\n\\item The unlabeled one.\n\\end{list}\n\nAfter the list.");
  const state = visualState(doc);
  assert.deepEqual(leftCommands(state), []);
  const view = mountView(doc);
  const labels = [...view.contentDOM.querySelectorAll(".cm-vis-item")].map((item) => item.textContent);
  assert.deepEqual(labels, ["Tier 1.", "Tier 2.", ""]);
  assert.doesNotMatch(view.contentDOM.textContent ?? "", /setlength|labelwidth|\\begin\{list\}/);
  // Editable: the cursor on the folded opening shows the layout arguments.
  view.dispatch({ selection: { anchor: doc.indexOf("labelwidth") } });
  assert.match(view.contentDOM.textContent ?? "", /\\begin\{list\}\{\}\{\\setlength\{\\labelwidth\}/);
  view.destroy();
});

test("list: a bullet label, a counter label with \\usecounter, and a \\makelabel are read; a label it does not know stays source", () => {
  const doc = inDocument([
    "\\begin{list}{$\\bullet$}{\\setlength{\\leftmargin}{1em}}\n\\item first bullet\n\\item second bullet\n\\end{list}",
    "\\begin{list}{\\arabic{cnt}.}{\\usecounter{cnt}\\setlength{\\leftmargin}{2em}}\n\\item counted one\n\\item counted two\n\\end{list}",
    "\\begin{list}{\\textbf{(\\roman{cnt2})}}{\\usecounter{cnt2}\\renewcommand{\\makelabel}[1]{\\textbf{#1}}}\n\\item roman one\n\\item roman two\n\\end{list}",
    "\\begin{list}{\\theenumi}{\\setlength{\\leftmargin}{2em}}\n\\item unknown label\n\\end{list}",
  ].join("\n\n"), "\\newcounter{cnt}\n\\newcounter{cnt2}\n");
  const state = visualState(doc);
  // The last list's label reads another counter: it is left as source, whole (its begin, items and end).
  assert.deepEqual(leftCommands(state).sort(), ["begin{list}", "end", "item", "setlength", "leftmargin"].sort());
  const view = mountView(doc);
  const labels = [...view.contentDOM.querySelectorAll(".cm-vis-item")].map((item) => item.textContent);
  assert.deepEqual(labels.slice(2, 6), ["1.", "2.", "(i)", "(ii)"]);
  view.destroy();
});

test("trivlist and paralist's compactenum / inparaenum are lists too", () => {
  const doc = inDocument("\\begin{trivlist}\n\\item First trivial item.\n\\item[\\textbf{Note.}] Second trivial item.\n\\end{trivlist}\n\n\\begin{compactenum}\n\\item compact one\n\\item compact two\n\\end{compactenum}\n\nRun-in \\begin{inparaenum}[(i)]\\item one\\item two\\end{inparaenum} text.", "\\usepackage{paralist}\n");
  assert.deepEqual(leftCommands(visualState(doc)), []);
});

test("a list of the document's own name `list` keeps the document's definition", () => {
  const doc = inDocument("\\begin{list}\n\\item kept\n\\end{list}", "\\newenvironment{list}{\\begin{itemize}}{\\end{itemize}}\n");
  assert.doesNotMatch(mounted(doc).text, /\\setlength/);
});

/* ---- 4. A file of table rows with no table around it -------------------------------------------------------------- */

test("astro-ph.GA 2611.07227 tables/synthetic_grid.tex: \\midrule and \\bottomrule in a bare fragment are rule lines, rows stay text", () => {
  const fragment = "DR3 & 1 & 1--3 & 100 & 99 \\\\\nDR3 & 3 & 3--8 & 99 & 98 \\\\\n\\midrule\nDR4 & 1 & 1--3 & 100 & 100 \\\\\nDR4 & 3 & 3--8 & 100 & 99 \\\\ \\hline\n\\cmidrule(lr){2-3}\n\\toprule\n";
  const state = visualState(fragment);
  const doc = state.doc.toString();
  const kinds = constructKinds(state);
  for (const rule of ["\\midrule", "\\cmidrule(lr){2-3}", "\\toprule", "\\hline"]) {
    const at = doc.indexOf(rule);
    assert.ok(kinds.some((kind) => { const [, from, to] = kind.split(":"); return Number(from) <= at && Number(to) > at; }), `${rule} is drawn`);
  }
  const view = mountView(fragment, 3);
  assert.ok(view.contentDOM.querySelector(".cm-vis-rule-row"), "a rule alone on its line is a line");
  assert.ok(view.contentDOM.querySelector(".cm-vis-rule-below"), "a rule after a row's `\\\\` is a border under it");
  const text = view.contentDOM.textContent ?? "";
  assert.match(text, /DR3 & 1 & 1–3/, "the rows are text");
  assert.doesNotMatch(text, /\\midrule|\\hline|\\cmidrule/);
  // The cursor on a rule line shows its source: it stays editable.
  view.dispatch({ selection: { anchor: doc.indexOf("\\midrule") + 2 } });
  assert.match(view.contentDOM.textContent ?? "", /\\midrule/);
  view.destroy();
});

test("rules inside a tabular are left to the table: a drawn table has no rule lines of its own", () => {
  const doc = inDocument("\\begin{tabular}{ll}\n\\toprule\na & b \\\\\n\\midrule\nc & d \\\\\n\\bottomrule\n\\end{tabular}", "\\usepackage{booktabs}\n");
  const { html } = mounted(doc);
  assert.match(html, /cm-vis-table-cell/);
  assert.doesNotMatch(html, /cm-vis-rule-row/);
  assert.deepEqual(leftCommands(visualState(doc)), []);
});

/* ---- 5. Common environments still render and stay editable ---------------------------------------------------------- */

test("abstract, quote, verse, center, minipage, theorems, proof, longtable, tabularx and column types draw with no command left", () => {
  const preamble = "\\usepackage{amsthm,booktabs,longtable,tabularx,tabulary,multirow,makecell,array,siunitx}\n\\newtheorem{thm}[equation]{Theorem}\n\\newtheorem{lem}{Lemma}\n";
  const body = [
    "\\begin{abstract}\nWe study things.\n\\end{abstract}",
    "\\section{Intro}\\label{sec:intro}",
    "\\begin{quote}\nA quoted line.\n\\end{quote}",
    "\\begin{quotation}\nA longer quotation.\n\\end{quotation}",
    "\\begin{verse}\nRoses are red \\\\\nViolets are blue\n\\end{verse}",
    "\\begin{center}\nCentered.\n\\end{center}",
    "\\begin{flushleft}\nLeft.\n\\end{flushleft}",
    "\\begin{flushright}\nRight.\n\\end{flushright}",
    "\\begin{minipage}{0.5\\textwidth}\nMinipage text.\n\\end{minipage}",
    "\\begin{thm}[Main]\\label{thm:main}\nEvery thing is a thing.\n\\end{thm}",
    "\\begin{proof}[Proof of Theorem~\\ref{thm:main}]\nTrivial.\n\\end{proof}",
    "\\begin{longtable}{lcr}\n\\toprule\nA & B & C \\\\\n\\midrule\n\\endhead\n1 & 2 & 3 \\\\\n\\bottomrule\n\\end{longtable}",
    "\\begin{tabularx}{\\textwidth}{lX}\n\\hline\na & b \\\\\n\\hline\n\\end{tabularx}",
    "\\begin{tabulary}{\\textwidth}{LL}\na & b \\\\\n\\end{tabulary}",
    "\\begin{tabular}{@{}>{\\bfseries}p{3cm}S[table-format=2.1]@{}}\n\\toprule\n\\multicolumn{2}{c}{Header} \\\\\nName & {Value} \\\\\n\\multirow{2}{*}{Group} & 1.5 \\\\\n & 22.0 \\\\\n\\makecell{two\\\\lines} & 3.0 \\\\\n\\bottomrule\n\\end{tabular}",
  ].join("\n\n");
  const doc = inDocument(body, preamble);
  assert.deepEqual(leftCommands(visualState(doc)), []);
});
