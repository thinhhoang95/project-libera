import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { diagramsForKatex } from "../../src/lib/latex/codemirror/visual/math-diagram";
import { citationNoteText, citationNotes, citationText } from "../../src/lib/latex/codemirror/visual/references";
import { forKatex, renderKatex } from "../../src/lib/latex/codemirror/visual/math-render";
import { expandLatexMacros } from "../../src/lib/latex/macros/expand";
import { readLatexDefinitions } from "../../src/lib/latex/macros/definitions";

/* Commutative diagrams (xy's \xymatrix, tikz-cd) drawn as arrays of objects and arrows, \arraystretch / \arraycolsep in
 * a formula, and opaque TikZ pictures and verbatim blocks (math.AG 2611.06861, stat.ME 2611.07519). */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function visualState(doc: string) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" })] });
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

/** Constructs as "kind:from:to". */
function constructs(state: EditorState) {
  const list: string[] = [];
  state.field(structuralField).extents.between(0, state.doc.length, (from, to, mark) => { list.push(`${mark.kind}:${from}:${to}`); });
  return list;
}

const doc = (body: string, preamble = "") => `\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;

/** A formula as the Visual mode draws it (macros expanded, then KaTeX); null when it stays source. */
function drawn(formula: string, display = true, preamble = "") {
  const defs = readLatexDefinitions(`${preamble}\n\\begin{document}\\end{document}`);
  const expanded = expandLatexMacros(formula, defs, { mode: "math", pos: 0 });
  return expanded.ok ? renderKatex(expanded.text, display) : null;
}

const text = (html: string | null) => (html ?? "").replace(/<[^>]*>/g, "").replace(/[​\s]+/g, " ");

test("an xymatrix square is an array of objects and arrows (2611.06861)", () => {
  const square = "\\xymatrix@C+1pc{\n X\\ar@{-->}[r]^{\\varphi}\\ar[d]_{\\pi_X}  & Y\\ar[d]^{\\pi_Y}\\\\\n B_X\\ar@{-->}[r]^{\\sigma} & B_Y\n}";
  const array = diagramsForKatex(square);
  assert.match(array, /^\\begin\{array\}\{ccc\}/);
  // Dashed arrows with their labels above; vertical arrows with the label of `_` on the left, of `^` on the right.
  assert.ok(array.includes("\\overset{\\varphi}{\\dashrightarrow}") && array.includes("\\overset{\\sigma}{\\dashrightarrow}"));
  assert.ok(array.includes("\\mathllap{\\scriptstyle \\pi_X\\,}\\Big\\downarrow") && array.includes("\\Big\\downarrow\\mathrlap{\\,\\scriptstyle \\pi_Y}"));
  const html = drawn(square);
  assert.ok(html && !html.includes("cm-vis-math-source"), "KaTeX draws it whole");
  assert.match(text(html), /X[\s\S]*φ[\s\S]*Y/);
  // Plain arrows, a long diagonal (`dll`) and `{\rm pt}` cells.
  const links = drawn("\\xymatrix{ && T\\ar@{->}[dll]_{\\eta}\\ar@{->}[d]^{\\pi}\\\\ S\\ar[d]&& B\\ar[dll]\\\\ {\\rm pt} && }");
  assert.ok(links && !links.includes("cm-vis-math-source"));
  assert.ok(diagramsForKatex("\\xymatrix{ & T\\ar[dl]_{a}\\ar[dr]^{b} & \\\\ S & & S' }").includes("\\overset{a}{\\swarrow}"), "`_` is the right-hand side of the direction: above, going down-left");
  // A reversed arrow, a hooked one and a double one change the glyph.
  const kinds = diagramsForKatex("\\xymatrix{ A \\ar@{<-}[r] & B \\ar@{^{(}->}[r] & C \\ar@{=>}[r] & D \\ar@{->>}[r] & E }");
  for (const piece of ["\\xleftarrow{}", "\\xhookrightarrow{}", "\\xRightarrow{}", "\\xtwoheadrightarrow{}"]) assert.ok(kinds.includes(piece), piece);
});

test("a diagram with an arrow or cell that is not understood stays source", () => {
  for (const diagram of [
    "\\xymatrix{ A \\ar@/^/[r] & B }", // curved
    "\\xymatrix{ A \\ar@<1ex>[r] & B }", // shifted
    "\\xymatrix{ A \\ar[r]|{f} & B }", // label on the arrow
    "\\xymatrix{ A \\ar[r]^{f}_{g}_{h} & B }", // two labels on one side
    "\\xymatrix{ A \\ar[rr] & B }", // to a cell outside the grid
    "\\xymatrix{ A \\ar[r] & *+[F]{B} }", // a decorated cell
    "\\xymatrix{ A \\ar@{~>}[r] & B }", // a style it does not know
    "\\xymatrix{ A \\ar@{-->}[d] \\\\ B }", // dashed vertical: no such glyph
    "\\xymatrix{ A \\ar[rr] & C & B }", // would cross a cell with content
    "\\xymatrix{ A \\ar[dr] & B \\ar[dl] \\\\ C & D }", // two arrows crossing in one slot
    "\\xymatrix{ A \\ar[r] \\ar[r] & B }", // two arrows in one slot
    "\\xymatrix{ A \\ar[r] & B \\\\[2ex] C & D }",
    "\\xymatrix@=+{ A \\ar[r] B }",
  ]) {
    assert.equal(diagramsForKatex(diagram), diagram, diagram);
    assert.equal(drawn(diagram), null, diagram);
  }
  for (const diagram of [
    "\\begin{tikzcd} A \\arrow[r, bend left] & B \\end{tikzcd}",
    "\\begin{tikzcd} A \\arrow[r, \"f\"{description}] & B \\end{tikzcd}",
    "\\begin{tikzcd} A \\arrow[from=1-1, to=1-2] & B \\end{tikzcd}",
    "\\begin{tikzcd}[execute at end picture={\\draw (0,0);}] A \\arrow[r] & B \\end{tikzcd}",
  ]) assert.equal(diagramsForKatex(diagram), diagram, diagram);
});

test("a tikz-cd diagram: the new and the older argument forms, options, labels and their sides (2611.06861)", () => {
  const sequence = "\\begin{tikzcd}\n 1 \n \\ar{r} \n & \n {T_{F}} \n \\ar{r} \n & \n \\mathrm{Aut}(S) \n \\ar{r}{\\Phi} \n & \n D_6 \n \\ar{r} \n & 1\n\\end{tikzcd}";
  const html = drawn(sequence);
  assert.ok(html && !html.includes("cm-vis-math-source"));
  assert.match(text(html), /Φ/);
  const modern = diagramsForKatex("\\begin{tikzcd}[row sep=large, column sep=small]\n A \\arrow[r, \"f\", hook] \\arrow[d, \"\\pi\"'] & B \\arrow[d, \"i\"] \\\\ C \\arrow[r, two heads, \"g\", swap] & D\n\\end{tikzcd}");
  assert.ok(modern.includes("\\xhookrightarrow{f}"), modern);
  // `"\pi"'` is on the right-hand side of a downward arrow, the page's left; `"i"` on its left-hand side, the page's right.
  assert.ok(modern.includes("\\Big\\downarrow\\mathrlap{\\,\\scriptstyle i}") && modern.includes("\\mathllap{\\scriptstyle \\pi\\,}"), modern);
  // `swap` puts the label under a rightward arrow.
  assert.ok(modern.includes("\\xtwoheadrightarrow[g]{}"), modern);
  // An arrow KaTeX has no glyph for (a hooked vertical one) stays source.
  const hooked = "\\begin{tikzcd} A \\arrow[d, hook] \\\\ B \\end{tikzcd}";
  assert.equal(diagramsForKatex(hooked), hooked);
  // `ampersand replacement=\&`.
  const replaced = diagramsForKatex("\\begin{tikzcd}[ampersand replacement=\\&]\n A \\arrow[r] \\& B\n\\end{tikzcd}");
  assert.match(replaced, /^\\begin\{array\}\{ccc\} A & \\xrightarrow\{\} & B/);
  // In an equation it is a display, numbered as the equation is not (tikzcd is its own environment).
  assert.ok(drawn("\\begin{tikzcd} A \\arrow[r, \"f\"] & B \\end{tikzcd}"));
});

test("a diagram in a document is drawn as a formula, and a click on it shows its source", () => {
  const body = "Before.\n\\[\\xymatrix{ A \\ar[r]^{f} \\ar[d]_{g} & B \\ar[d]^{h} \\\\ C \\ar[r]_{k} & D }\\]\n\nAfter.\n\\begin{tikzcd}\nA \\arrow[r] & B\n\\end{tikzcd}\n";
  const source = doc(body);
  const state = visualState(source);
  assert.equal(constructs(state).filter((item) => item.startsWith("math:")).length, 2, "both diagrams are drawn");
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state, parent });
  refreshVisualWidgets(view);
  const formulas = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-math")];
  assert.equal(formulas.length, 2);
  assert.ok(formulas.every((formula) => formula.querySelector(".katex") && !formula.querySelector(".cm-vis-math-source")));
  const from = source.indexOf("\\[\\xymatrix");
  const to = source.indexOf("}\\]") + 3;
  formulas[0].dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  assert.equal(document.querySelectorAll(".cm-vis-math-editor").length, 0, "no MathLive panel: a diagram is edited as source");
  const head = view.state.selection.main.head;
  assert.ok(head > from && head < to, "the click puts the cursor inside the formula: its source shows");
  // Alt-click does the same.
  view.dispatch({ selection: { anchor: source.length } });
  refreshVisualWidgets(view);
  [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-math")][0].dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, altKey: true }));
  assert.ok(view.state.selection.main.head > from && view.state.selection.main.head < to);
  view.destroy();
  parent.remove();
});

test("\\renewcommand{\\arraystretch} and \\setlength{\\arraycolsep} inside a display do not make KaTeX fail (2611.06861)", () => {
  const formula = "\\renewcommand{\\arraystretch}{1.6}\n\\setlength{\\arraycolsep}{7pt}\n\\begin{array}{|c|c|} \\hline a & b \\\\ \\hline c & d \\end{array}";
  assert.equal(forKatex(formula).includes("renewcommand"), false);
  assert.equal(forKatex(formula).includes("arraycolsep"), false);
  const stretched = drawn(formula);
  const plain = drawn("\\begin{array}{|c|c|} \\hline a & b \\\\ \\hline c & d \\end{array}");
  assert.ok(stretched && plain && stretched !== plain, "the row spacing is the stretch's");
  assert.ok(drawn("\\tabcolsep=3pt \\begin{array}{cc} a & b \\end{array}"));
  // Not a number: dropped from nothing, KaTeX rejects it and the formula stays source.
  assert.equal(drawn("\\renewcommand{\\arraystretch}{\\foo}\\begin{array}{c} a \\end{array}"), null);
});

test("a tikzpicture is opaque: no math, commands or \\end inside it are read (2611.06861)", () => {
  const picture = [
    "\\begin{figure}[ht]", "\\centering", "\\begin{subfigure}{0.31\\textwidth}", "\\centering", "\\begin{tikzpicture}",
    "\\newdimen\\R", "\\R=2.6cm", "\\draw (0:\\R) \\foreach \\x in {60,120,...,360} {  -- (\\x:\\R) };",
    "\\foreach \\start/\\end/\\label in", "{ 0/60/$F_3\\ \\ $,", "60/120/$E_1$ }", "\\draw (\\start:\\R) -- (\\end:\\R) node[midway, above, fill=white] {\\label};",
    "\\draw[<->] ($(60:\\C)!0.5!(120:\\C)$) -- ($(240:\\C)!0.5!(300:\\C)$) node[pos=0.6] {\\( h \\)};", "\\end{tikzpicture}",
    "\\caption{$G\\simeq\\mathbb{Z}/6$}", "\\end{subfigure}", "\\end{figure}", "Then $x$ and a later \\emph{word}.",
  ].join("\n");
  const source = doc(picture, "\\usepackage{subcaption}");
  const state = visualState(source);
  const tree = syntaxTree(state);
  const errors: string[] = [];
  tree.iterate({ enter: (node) => { if (node.type.isError) errors.push(`${node.name}@${node.from}`); } });
  assert.deepEqual(errors, [], "the picture parses without error nodes");
  const kinds = constructs(state);
  const start = source.indexOf("\\begin{tikzpicture}");
  const end = source.indexOf("\\end{tikzpicture}");
  assert.deepEqual(kinds.filter((item) => item.startsWith("math:")).map((item) => Number(item.split(":")[1])).filter((from) => from > start && from < end), [], "no formula inside the picture");
  assert.equal(kinds.filter((item) => item.startsWith("figure:")).length, 1, "the float is drawn, the picture a drawing in it");
  assert.equal(kinds.filter((item) => item.startsWith("math:")).length, 1, "only the formula after the float (the caption's is drawn in the float)");
  // On its own in the body, the picture is source lines, as before, and nothing in it is a widget.
  const alone = visualState(doc("\\begin{tikzpicture}\n\\foreach \\a/\\end in {1/2} \\node {$x$};\n\\end{tikzpicture}\nAfter $y$."));
  assert.equal(constructs(alone).filter((item) => item.startsWith("math:")).length, 1);
});

test("verbatim, lstlisting, minted and \\verb hide their $ from the math scanner (2611.07519)", () => {
  const body = [
    "\\begin{verbatim}", "c(", "  selected_mean = fit$mu_best,", "  model_averaged_mean = fit$mu_aic", ")", "\\end{verbatim}", "",
    "\\begin{verbatim}", "data.frame(", "  time = t_eval, hazard = fit$haz_best", ")", "\\end{verbatim}", "",
    "\\begin{lstlisting}", "x <- fit$a + fit$b", "\\end{lstlisting}", "",
    "\\begin{minted}{r}", "y <- fit$c", "\\end{minted}", "",
    "Use \\verb|fit$mu| and \\lstinline|fit$sigma| with $z$.", "",
  ].join("\n");
  const state = visualState(doc(body));
  const kinds = constructs(state);
  assert.equal(kinds.filter((item) => item.startsWith("math:")).length, 1, `only $z$ is math: ${kinds.join(" ")}`);
  assert.equal(kinds.filter((item) => item.startsWith("code-begin:")).length, 4, "the four blocks are code");
  const errors: string[] = [];
  syntaxTree(state).iterate({ enter: (node) => { if (node.type.isError) errors.push(node.name); } });
  assert.deepEqual(errors, []);
});

test("a citation note with a formula and a document unit macro is drawn (astro-ph 2611.07227)", () => {
  const preamble = "\\newcommand{\\masyr}{\\,{\\rm mas\\,yr^{-1}}}\n\\providecommand{\\degree}{^{\\circ}}\n\\newcommand{\\getgaia}{\\textsc{GetGaia}}";
  const body = "Fornax \\citet[the first version of \\getgaia{}: $(+0.380 \\pm 0.001, -0.361 \\pm 0.002)\\masyr$]{Martinez2021} within $0.002\\masyr$ and \\citep[at $0.5\\degree$]{Pace2019} here, \\citep[$M_{\\rm V}$]{Odd2020} stays.";
  const source = doc(body, preamble);
  const state = visualState(source);
  const kinds = constructs(state);
  assert.equal(kinds.filter((item) => item.startsWith("cite:")).length, 2, `two citations are chips, the one with a formula that is not text is not: ${kinds.join(" ")}`);
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state, parent });
  refreshVisualWidgets(view);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-cite").length, 2);
  // What the chips print, with a bibliography entry to name the authors.
  const defs = readLatexDefinitions(source);
  const printed = (optionals: string[]) => citationText({ command: "\\citet", keys: ["Pace2019"], ...citationNotes(optionals, defs, source.length) }, { citations: {}, labels: {} } as never, () => ({ author: "Pace, A.", year: "2019" }));
  assert.equal(printed(["$(+0.380 \\pm 0.001, -0.361 \\pm 0.002)\\masyr$"]), "Pace (2019, (+0.380 ± 0.001, -0.361 ± 0.002) mas yr⁻¹)");
  assert.equal(printed(["at $0.5\\degree$"]), "Pace (2019, at 0.5°)", "a degree is a degree sign");
  assert.equal(printed(["the first version of \\getgaia{}: $0.1\\masyr$"]), "Pace (2019, the first version of GetGaia: 0.1 mas yr⁻¹)", "text macros in the note expand too");
  // A subscript that is not a digit or sign is not text: the note is not understood and its citation stays source.
  assert.equal(citationNoteText("$M_{\\rm V}$"), null);
  assert.equal(citationNoteText("$\\frac{a}{b}$"), null);
  // `$0.002\masyr$` is a formula of its own, drawn.
  assert.ok(kinds.some((item) => item.startsWith("math:")), "the formula between the citations is drawn");
  view.destroy();
  parent.remove();
});

test("a \\bibitem label with a macro is printed as text, or the item stays source (cs.DS 2611.07622's \\etalchar)", () => {
  const preamble = "\\newcommand{\\etalchar}[1]{$^{#1}$}";
  const bibliography = (label: string) => doc(`\\begin{thebibliography}{99}\n\\bibitem[${label}]{key} A. Author. A paper.\n\\end{thebibliography}`, preamble);
  const marker = (source: string) => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: visualState(source), parent });
    refreshVisualWidgets(view);
    const text = view.contentDOM.textContent ?? "";
    view.destroy();
    parent.remove();
    return text;
  };
  assert.match(marker(bibliography("CGK{\\etalchar{+}}20")), /\[CGK⁺20\]/);
  assert.match(marker(bibliography("Abr87")), /\[Abr87\]/);
  // A label that is not text keeps its source, not a marker with LaTeX in it.
  assert.match(marker(bibliography("\\mystery{x}")), /\\bibitem\[\\mystery\{x\}\]/);
  assert.doesNotMatch(marker(bibliography("CGK{\\etalchar{+}}20")), /\\bibitem/);
});
