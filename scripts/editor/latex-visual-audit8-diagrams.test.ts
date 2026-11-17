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
import { diagramsForKatex } from "../../src/lib/latex/codemirror/visual/math-diagram";
import { forKatex, KATEX_MACROS } from "../../src/lib/latex/codemirror/visual/math-render";
import { setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Audit round 8, commutative diagrams: quiver's tikz-cd output (`from=1-1, to=1-2`, `squiggly`, `"f"'{description}`,
 * pullback corners; math.LO 2611.11828) and xy's adjunction pairs (`\ar@<1.1ex>[r]`, `\ar@{}[r]|-{\perp}`;
 * math.CT 2611.03553). What cannot be drawn as written stays source. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function visualState(text: string) {
  let state = EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" })] });
  ensureSyntaxTree(state, text.length, 5000);
  for (let guard = 0; state.field(structuralField).pending.length && guard < 500; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

function mount(text: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(text), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return { view, done: () => { view.destroy(); parent.remove(); } };
}

const doc = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
const widgetsOf = (view: EditorView) => [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-math")];
const click = (el: HTMLElement, alt: boolean) => el.dispatchEvent(new dom.window.MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true, altKey: alt }));
/** The diagram as KaTeX draws it, or null when KaTeX rejects it (the diagram stays source). */
const drawn = (latex: string) => {
  try { return katex.renderToString(forKatex(latex), { throwOnError: true, strict: "ignore", macros: { ...KATEX_MACROS } }); } catch { return null; }
};

test("quiver's `from=, to=` arrows with squiggly, primed and description labels, braced and empty cells are drawn (math.LO 2611.11828)", () => {
  const diagram = String.raw`\begin{tikzcd}
	{\langle f(A), g(c) \rangle} & {} & {B \wedge C} \\
	{D.} && {}
	\arrow["\mathrm{refl}", squiggly, from=1-1, to=1-3]
	\arrow["{\mathrm{ap}_{f \circ g}(c)}"', from=1-3, to=2-3]
	\arrow["{g^{-1}}"{description}, from=1-1, to=2-1]
	\arrow[dashed, from=2-1, to=2-3]
\end{tikzcd}`;
  const array = diagramsForKatex(diagram);
  assert.ok(!array.includes("tikzcd"), array);
  assert.ok(array.includes("\\rightsquigarrow") && array.includes("\\dashrightarrow"), array);
  assert.ok(drawn(diagram), "KaTeX accepts the array");
  // `"f"'` is the label on the other side: under a rightward arrow.
  assert.ok(/\\underset\{[^}]*refl/.test(diagramsForKatex(diagram.replace('"\\mathrm{refl}"', '"\\mathrm{refl}"\'').replace("squiggly, from=1-1, to=1-3", "squiggly, from=1-1, to=1-3"))));
});

test("a horizontal squiggly arrow is drawn; a vertical or leftward one is not, as KaTeX has no such arrow (math.LO 2611.11828)", () => {
  const right = diagramsForKatex("\\begin{tikzcd}\n\tx & y\n\t\\arrow[\"p\", squiggly, from=1-1, to=1-2]\n\\end{tikzcd}");
  assert.ok(right.includes("\\overset{p}{\\rightsquigarrow}"), right);
  for (const source of [
    "\\begin{tikzcd}\n\tx \\\\\n\tz\n\t\\arrow[squiggly, from=1-1, to=2-1]\n\\end{tikzcd}",
    "\\begin{tikzcd}\n\tx & y\n\t\\arrow[squiggly, from=1-2, to=1-1]\n\\end{tikzcd}",
  ]) assert.equal(diagramsForKatex(source), source);
});

test("a pullback corner (`draw=none`, `\\lrcorner`, `rotate=180`) is drawn as the turned corner in its square (math.LO 2611.11828)", () => {
  const square = String.raw`\begin{tikzcd}
	A & B \\
	C & D
	\arrow[from=1-1, to=1-2]
	\arrow[from=1-1, to=2-1]
	\arrow[from=1-2, to=2-2]
	\arrow[from=2-1, to=2-2]
	\arrow["\lrcorner"{anchor=center, pos=0.125, rotate=180}, draw=none, from=2-2, to=1-1]
\end{tikzcd}`;
  const array = diagramsForKatex(square);
  assert.ok(!array.includes("tikzcd"), array);
  assert.ok(array.includes("\\ulcorner") && !array.includes("\\lrcorner"), array);
  const plain = diagramsForKatex(square.replace("rotate=180", "rotate=0"));
  assert.ok(plain.includes("\\lrcorner"), plain);
  // A corner turned by an angle that is not a quarter turn, or drawn where an arrow is, is not understood.
  const odd = square.replace("rotate=180", "rotate=-135");
  assert.equal(diagramsForKatex(odd), odd);
  const crowded = square.replace("\\arrow[from=2-1, to=2-2]", "\\arrow[from=2-1, to=2-2]\n\t\\arrow[dashed, from=2-1, to=1-2]");
  assert.equal(diagramsForKatex(crowded), crowded, "the second diagonal arrow shares the corner's slot");
});

test("what the renderer cannot draw faithfully stays source: 2-cells, `between`, curves, far diagonals (math.LO 2611.11828)", () => {
  const cases = [
    "\\begin{tikzcd}\n\tx & y & z\n\t\\arrow[\"p\", squiggly, from=1-2, to=1-3]\n\t\\arrow[\"\\eta\"', Rightarrow, from=0, to=1]\n\\end{tikzcd}",
    "\\begin{tikzcd}\n\ta & b \\\\\n\tc & d\n\t\\arrow[between={0.3}{0.7}, Rightarrow, from=1-2, to=2-1]\n\\end{tikzcd}",
    "\\begin{tikzcd}\n\ta & b\n\t\\arrow[\"f\", curve={height=-6pt}, from=1-1, to=1-2]\n\\end{tikzcd}",
    "\\begin{tikzcd}\n\ta & b \\\\\n\tc & d \\\\\n\t& & e\n\t\\arrow[from=1-2, to=3-3]\n\\end{tikzcd}",
    "\\begin{tikzcd}\n\ta & b\n\t\\arrow[hook, two heads, from=1-1, to=1-2]\n\\end{tikzcd}",
    "\\begin{tikzcd}\n\ta & b\n\t\\arrow[\"f\"{pos=0.3}, from=1-1, to=1-2]\n\\end{tikzcd}",
  ];
  for (const source of cases) assert.equal(diagramsForKatex(source), source);
});

test("an arrow written in the last cell reaches across empty cells but not across an object (math.LO 2611.11828)", () => {
  const across = diagramsForKatex("\\begin{tikzcd}\n\ta & {} & b\n\t\\arrow[\"f\", from=1-1, to=1-3]\n\\end{tikzcd}");
  assert.ok(!across.includes("tikzcd") && across.includes("\\xrightarrow"), across);
  const blocked = "\\begin{tikzcd}\n\ta & c & b\n\t\\arrow[\"f\", from=1-1, to=1-3]\n\\end{tikzcd}";
  assert.equal(diagramsForKatex(blocked), blocked);
});

test("`\\xymatrix@C=70pt@R=45pt` with shifted adjunction arrows and `@{}` symbols between them is drawn (math.CT 2611.03553)", () => {
  const diagram = String.raw`\xymatrix@C=70pt@R=45pt{
A
    \ar@<1.1ex>[r]^-{F}
    \ar@{}[r]|-{\perp}
    \ar@<1.1ex>[d]^-{D}
    \ar@{}[d]|-{\vdash}
& B
    \ar@<1.1ex>[l]^-{G}
    \ar@<1.1ex>[d]^-{D'}
    \ar@{}[d]|-{\vdash}
\\
C
    \ar@<1.1ex>[r]^-{F'}
    \ar@{}[r]|-{\perp}
    \ar@<1.1ex>[u]^-{T}
& E
    \ar@<1.1ex>[l]^-{G'}
    \ar@<1.1ex>[u]^-{T'}
}`;
  const array = diagramsForKatex(diagram);
  assert.ok(!array.includes("xymatrix"), array);
  assert.ok(drawn(diagram), "KaTeX accepts the array");
  // Top row: the right arrow with F above it, the symbol, the left arrow with G below it (the outer sides).
  assert.ok(/\\xrightarrow\{F\} \\\\\[-0\.5em\] \\perp \\\\\[-0\.5em\] \\xleftarrow\[G\]\{\}/.test(array), array);
  // The first column: the arrow up on the page's left, the symbol, the arrow down on the right.
  assert.ok(/\\mathllap\{\\scriptstyle T\\,\}\\Big\\uparrow\\,\\vdash\\,\\Big\\downarrow\\mathrlap\{\\,\\scriptstyle D\}/.test(array), array);
  // Two arrows shifted to the same side, or a lone symbol-less pair with an inner label, are not an adjunction.
  const same = "\\xymatrix{A \\ar@<1ex>[r]^{f} \\ar@<1ex>[r]^{g} & B}";
  assert.equal(diagramsForKatex(same), same);
  const inner = "\\xymatrix{A \\ar@<1ex>[r]^{f} & B \\ar@<1ex>[l]_{g}}";
  assert.equal(diagramsForKatex(inner), inner);
  const lone = "\\xymatrix{A \\ar@{}[r]|-{\\perp} \\ar[r]^f & B}";
  assert.equal(diagramsForKatex(lone), lone);
});

test("a rendered tikz-cd diagram opens its source on click, Alt-click and a formula is its one widget (math.LO 2611.11828)", () => {
  const body = "Text.\n\\[\\begin{tikzcd}\n\tA & B \\\\\n\tC & D\n\t\\arrow[\"f\", from=1-1, to=1-2]\n\t\\arrow[\"g\"', from=1-1, to=2-1]\n\\end{tikzcd}\\]\nAfter.";
  for (const alt of [false, true]) {
    const { view, done } = mount(doc(body));
    const widgets = widgetsOf(view);
    assert.equal(widgets.length, 1, view.contentDOM.innerHTML);
    assert.ok(!(view.contentDOM.textContent ?? "").includes("tikzcd"), "drawn, not source");
    assert.ok(widgets[0].querySelector(".katex"), "KaTeX drew the diagram");
    click(widgets[0], alt);
    const source = view.state.doc.toString();
    const head = view.state.selection.main.head;
    assert.ok(head > source.indexOf("\\["), `caret ${head}`);
    assert.ok((view.contentDOM.textContent ?? "").includes("tikzcd"), `source shows after ${alt ? "Alt-" : ""}click`);
    done();
  }
});

test("a rendered xymatrix adjunction opens its source on click and Alt-click (math.CT 2611.03553)", () => {
  const body = "Text.\n$$\n\\xymatrix@C=70pt@R=45pt{\nA \\ar@<1.1ex>[r]^-{F} \\ar@{}[r]|-{\\perp} & B \\ar@<1.1ex>[l]^-{G}\n}\n$$\nAfter.";
  for (const alt of [false, true]) {
    const { view, done } = mount(doc(body));
    const widgets = widgetsOf(view);
    assert.equal(widgets.length, 1, view.contentDOM.innerHTML);
    assert.ok(!(view.contentDOM.textContent ?? "").includes("xymatrix"), "drawn, not source");
    click(widgets[0], alt);
    assert.ok((view.contentDOM.textContent ?? "").includes("xymatrix"), `source shows after ${alt ? "Alt-" : ""}click`);
    done();
  }
});
