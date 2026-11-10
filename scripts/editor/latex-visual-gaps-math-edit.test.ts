import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fc from "fast-check";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { canEditInMathLive, formulaTarget } from "../../src/lib/latex/codemirror/visual/math-edit";
import { formulaLayout, pieceForMathLive, pieceFromMathLive, pieceIndexAt, pieceReason, sameFormula, sourceChanges, writablePiece, type FormulaLayout } from "../../src/lib/latex/codemirror/visual/math-pieces";
import { applyTexChanges, canonicalTokens, texDiff } from "../../src/lib/latex/codemirror/visual/tex-tokens";

/* Editing formulas piece by piece (math-pieces.ts): rows and cells of alignments, labelled and multi-line
 * formulas, and macros MathLive cannot read. MathLive itself does not run under jsdom: these test what is
 * editable, how a formula splits, and the splice an edit produces. MathLive's spellings used below
 * (`f^{\prime}`, `\operatorname{\mathrm{…}}`, `\bm`, opaque macros kept by name) were read from MathLive
 * 0.111 in a browser. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function mount(doc: string) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" })] });
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({ state, parent });
}

const texts = (content: string, layout: FormulaLayout) => layout.pieces.map((piece) => `${piece.row}:${piece.cell}:${content.slice(piece.from, piece.to)}`);

/** The content after writing `edited` into piece `index` the way the editor does (token diff of the piece). */
function edit(content: string, layout: FormulaLayout, index: number, edited: string) {
  const piece = layout.pieces[index];
  return applyTexChanges(content, texDiff(content.slice(piece.from, piece.to), edited, piece.from));
}

test("an align splits into its cells; \\label, \\tag, \\nonumber, comments, & and \\\\ are never in a piece", () => {
  const content = String.raw`
  a &= b + c \label{eq:one} \\[2pt]
  &= d % the second step
  \nonumber \\
  e &= f \tag{$*$}
`;
  const layout = formulaLayout(content, "align");
  assert.equal(layout.env, "align");
  assert.deepEqual(texts(content, layout), ["0:0:a", "0:1:= b + c", "1:0:", "1:1:= d", "2:0:e", "2:1:= f"]);
  assert.ok(layout.pieces.every((piece) => piece.reason === null));
  // Editing a row's right side writes only there: the label, row gap, comment and tag stay byte for byte.
  const after = edit(content, layout, 1, "=b+2c");
  // (An insertion goes after the token before it, keeping the spaces as written.)
  assert.equal(after, content.replace("b + c", "b +2 c"));
  // The empty left side of `&= d` can be filled.
  assert.equal(edit(content, layout, 2, "x"), content.replace("\n  &= d", "\n  x&= d"));
});

test("a labelled or tagged single formula edits its body; trailing comments stay", () => {
  const content = "\n  E = mc^2 \\label{eq:e} % famous\n";
  const layout = formulaLayout(content, "equation");
  assert.deepEqual(texts(content, layout), ["0:0:E = mc^2"]);
  assert.equal(edit(content, layout, 0, "E=mc^{3}"), content.replace("mc^2", "mc^{3}"));
  const tagged = " x = 1 \\tag{A} ";
  assert.deepEqual(texts(tagged, formulaLayout(tagged, null)), ["0:0:x = 1"]);
});

test("a multi-line formula is one piece and keeps its line structure", () => {
  const content = "\n  a + b\n  + c\n  = d\n";
  const layout = formulaLayout(content, null);
  assert.equal(layout.pieces.length, 1);
  assert.equal(layout.pieces[0].reason, null);
  assert.equal(edit(content, layout, 0, "a+b+x=d"), "\n  a + b\n  + x\n  = d\n");
});

test("a formula that is one alignment environment splits at that environment's rows", () => {
  const split = String.raw`\begin{split} a &= b \\ &= c \end{split} \label{eq:s}`;
  const layout = formulaLayout(split, "equation");
  assert.equal(layout.env, "split");
  assert.deepEqual(texts(split, layout), ["0:0:a", "0:1:= b", "1:0:", "1:1:= c"]);
  const matrix = String.raw` \begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix} `;
  assert.deepEqual(texts(matrix, formulaLayout(matrix, null)), ["0:0:1", "0:1:2", "1:0:3", "1:1:4"]);
  // The column spec of an array is not a cell.
  const array = String.raw`\begin{array}{c|c} x & y \\ \hline z & w \end{array}`;
  assert.deepEqual(texts(array, formulaLayout(array, null)), ["0:0:x", "0:1:y", "1:0:z", "1:1:w"]);
  const cases = String.raw`\begin{cases} 1 & x > 0 \\ 0 & \text{else} \end{cases}`;
  assert.equal(formulaLayout(cases, null).env, "cases");
  // A formula with more than the environment is one piece: MathLive edits the matrix inside it.
  const mixed = String.raw`A = \begin{pmatrix} 1 & 2 \end{pmatrix}`;
  assert.deepEqual(texts(mixed, formulaLayout(mixed, null)), [`0:0:${mixed}`]);
});

test("a nested environment stays inside its row; a row MathLive cannot read is source for that row only", () => {
  const content = String.raw`f &= \begin{cases} a & b \\ c & d \end{cases} \\ g &= \left( 1 \\ h &= 2 \right)`;
  const layout = formulaLayout(content, "align*");
  assert.deepEqual(texts(content, layout), ["0:0:f", "0:1:= \\begin{cases} a & b \\\\ c & d \\end{cases}", "1:0:g", "1:1:= \\left( 1", "2:0:h", "2:1:= 2 \\right)"]);
  assert.deepEqual(layout.pieces.map((piece) => !!piece.reason), [false, false, false, true, false, true]);
});

test("pieces at a click: drawn row and column to source piece", () => {
  const content = String.raw`a &= b \\ c &= d \\`;
  const layout = formulaLayout(content, "align");
  assert.equal(layout.pieces.length, 4, "the final \\\\ makes no row");
  assert.equal(pieceIndexAt(layout, 1, 1), 3);
  assert.equal(pieceIndexAt(layout, 0, 0), 0);
  assert.equal(pieceIndexAt(layout, 5, 0), 2, "past the last row: the last row");
  // eqnarray's `a &=& b` is drawn as two columns: the right one opens the right-hand side.
  const eqnarray = String.raw`a &=& b \\ c &=& d`;
  const eq = formulaLayout(eqnarray, "eqnarray");
  assert.equal(eqnarray.slice(eq.pieces[pieceIndexAt(eq, 1, 1)].from, eq.pieces[pieceIndexAt(eq, 1, 1)].to), "d");
});

test("MathLive's spellings of untouched parts are not written (primes, \\operatorname, \\bm)", () => {
  assert.ok(sameFormula("f'(x) + g''", "f^{\\prime}(x)+g^{\\prime\\prime}"));
  assert.ok(sameFormula(String.raw`\operatorname{argmin}_x`, String.raw`\operatorname{\mathrm{argmin}}_{x}`));
  assert.ok(sameFormula(String.raw`\boldsymbol{\theta}`, pieceFromMathLive(String.raw`\bm{\theta}`, {}, String.raw`\boldsymbol{\theta}`)));
  assert.equal(pieceFromMathLive(String.raw`\bm{\theta}+1`, {}, String.raw`\boldsymbol{\theta}`), String.raw`\boldsymbol{\theta}+1`, "no \\bm (the bm package) is written");
  const original = "f'(x) + 1";
  assert.equal(applyTexChanges(original, texDiff(original, "f^{\\prime}(x)+2")), "f'(x) + 2");
  assert.ok(!sameFormula("a+b", "a-b"));
});

test("macros MathLive cannot read are opaque atoms written back by name (optional arguments, xparse, physics)", () => {
  const doc = String.raw`\documentclass{article}
\usepackage{physics}
\NewDocumentCommand\E{o m}{\mathbb{E}\IfValueT{#1}{_{#1}}[#2]}
\begin{document}
\begin{align}
  y &= \dv[2]{f}{x} + \E[t]{X} \label{eq:a} \\
  z &= \qty(a + b) + \abs{c}
\end{align}
\end{document}`;
  const view = mount(doc);
  const from = doc.indexOf("\\begin{align}");
  const target = formulaTarget(view, from)!;
  assert.ok(target, "the align is a formula");
  assert.equal(target.layout.env, "align");
  assert.ok(canEditInMathLive(view, from), "a labelled align with physics macros opens in MathLive");
  const uses = target.macros.opaque.map((use) => target.text.slice(use.from, use.to));
  assert.ok(uses.includes(String.raw`\dv[2]{f}{x}`), uses.join(" | "));
  assert.ok(uses.includes(String.raw`\E[t]{X}`), uses.join(" | "));
  assert.ok(uses.includes(String.raw`\qty(a + b)`), uses.join(" | "));
  const piece = target.layout.pieces.find((item) => target.text.slice(item.from, item.to).includes("\\dv"))!;
  const prepared = pieceForMathLive(target.text, piece, target.macros.opaque, target.render)!;
  assert.equal(prepared.value, String.raw`= \LiberaAtomA + \LiberaAtomB`);
  assert.ok(!/\\physics@|IfValue/.test(Object.values(prepared.atoms).map((atom) => atom.def).join(" ")), "atoms draw as their expansion");
  // MathLive writes the atoms back by name; the user changed `+` into `-`.
  const original = target.text.slice(piece.from, piece.to);
  const edited = pieceFromMathLive(String.raw`=\LiberaAtomA-\LiberaAtomB`, prepared.atoms, original);
  assert.equal(edited, String.raw`=\dv[2]{f}{x}-\E[t]{X}`);
  const changes = texDiff(original, edited, target.from + piece.from);
  assert.deepEqual(changes.map((change) => change.insert), ["-"], "only the sign is written");
  assert.ok(sameFormula(pieceFromMathLive(prepared.value, prepared.atoms, original), original), "an unchanged piece reads back as itself");
  view.destroy();
});

test("text that would break the formula around a piece is not written", () => {
  for (const bad of ["a}", "{a", "\\left( a", "a $ b", "a \\] b", "\\end{align}", "\\begin{cases} a"]) assert.equal(writablePiece(bad), false, bad);
  for (const good of ["a + b", "\\{a\\}", "\\$5", "\\begin{cases} a & b \\end{cases}"]) assert.equal(writablePiece(good), true, good);
  assert.ok(pieceReason("\\text{a % b}"));
  // A piece edited as source writes exactly what was typed, only where it differs.
  assert.deepEqual(sourceChanges("\\foo{a}  b", "\\foo{a}  c", 10), [{ from: 19, to: 20, insert: "c" }]);
});

test("property: editing any cell of an alignment changes only that cell, and typesets as the edit", () => {
  const atoms = fc.constantFrom("x", "y", "2", "+", "=", "\\alpha", "^", "_", "{a}", "\\frac{1}{2}", " ", "f'", "\\left(b\\right)");
  const cell = fc.array(atoms, { minLength: 1, maxLength: 6 }).map((parts) => parts.join(""));
  const extras = fc.constantFrom("", " \\label{eq:x}", " \\nonumber", " % note\n", " \\tag{1}");
  const row = fc.tuple(cell, cell, extras);
  fc.assert(fc.property(fc.array(row, { minLength: 1, maxLength: 4 }), fc.nat(), fc.array(atoms, { maxLength: 6 }), (rows, pick, replacement) => {
    const content = `\n${rows.map(([left, right, extra]) => `  ${left} &${right}${extra}`).join(" \\\\\n")}\n`;
    const layout = formulaLayout(content, "align");
    const editable = layout.pieces.map((piece, index) => ({ piece, index })).filter(({ piece }) => !piece.reason);
    if (!editable.length) return;
    const { piece, index } = editable[pick % editable.length];
    const edited = replacement.join("").trim();
    const after = edit(content, layout, index, edited);
    const prefix = content.slice(0, piece.from);
    const suffix = content.slice(piece.to);
    assert.ok(after.startsWith(prefix) && after.endsWith(suffix), "the text around the piece is unchanged");
    const written = after.slice(prefix.length, after.length - suffix.length);
    assert.deepEqual(canonicalTokens(written).map((token) => token.text), canonicalTokens(edited).map((token) => token.text));
  }), { numRuns: 150 });
});
