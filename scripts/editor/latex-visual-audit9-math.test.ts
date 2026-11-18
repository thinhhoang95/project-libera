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
import { setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Audit round 9, math: AASTeX's angle and time marks (astro-ph.EP 2611.16046, astro-ph.SR 2611.19134), siunitx units with a font command
 * and a user macro (hep-ex 2611.16397, 2611.16454), plain TeX's barred letter (math.QA 2611.13129), `\baselineskip` lengths (math.MG 2611.13338)
 * and tikz-cd's `sloped` labels (math.QA 2611.13239). Every new rendering is checked for click-to-source. */

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

const doc = (body: string, preamble = "") => `\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;
const renders = (latex: string) => {
  try { katex.renderToString(forKatex(latex), { throwOnError: true, strict: "ignore", macros: { ...KATEX_MACROS } }); return true; } catch { return false; }
};
const widgetsOf = (view: EditorView) => [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-math")];
const click = (el: HTMLElement, alt = true) => el.dispatchEvent(new dom.window.MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true, altKey: alt }));

/** An Alt-click on the formula widget at `index` (a plain click opens the formula editor) opens its source, the caret inside `[from, to]`. */
function opensToSource(view: EditorView, index: number, from: number, to: number) {
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  refreshVisualWidgets(view);
  const widget = widgetsOf(view)[index];
  assert.ok(widget, `no widget ${index}`);
  click(widget, true);
  const head = view.state.selection.main.head;
  assert.ok(head >= from && head <= to, `caret ${head} not in ${from}-${to}`);
}

/** The text a document shows in its content, widgets included. */
const shown = (view: EditorView) => view.contentDOM.textContent ?? "";

/** Every non-editable widget, clicked in turn (plain, then Alt), must reveal its source. */
function everyWidgetOpens(text: string) {
  const { view, done } = mount(text);
  const nodes = [...view.contentDOM.querySelectorAll<HTMLElement>("*")].filter((node) => {
    if (node.contentEditable !== "false") return false;
    for (let up = node.parentElement; up && up !== view.contentDOM; up = up.parentElement) if (up.contentEditable === "false") return false;
    return true;
  });
  const failures: string[] = [];
  for (const node of nodes) {
    const pos = view.posAtDOM(node);
    for (const alt of [false, true]) {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      refreshVisualWidgets(view);
      node.dispatchEvent(new dom.window.MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true, altKey: alt }));
      const { revealed } = view.state.field(structuralField);
      const selection = view.state.selection.main;
      const opened = [...revealed.values()].some((range) => range.from <= pos && range.to >= pos) || (!selection.empty && selection.from <= pos && selection.to > pos);
      if (opened) break;
      if (alt) failures.push(`${node.className} at ${pos}`);
    }
  }
  done();
  return { count: nodes.length, failures };
}

test("AASTeX's `\\arcdeg` and `\\fs` in text and in a formula are drawn (astro-ph.EP 2611.16046)", () => {
  const body = String.raw`The position angle is 250\arcdeg, and 8.7\arcdeg{} in length. At $2^{\rm h}32^{\rm m}08\fs59$, Dec $+26\arcdeg36'45\farcs8$, with $i < 45\arcdeg$.`;
  assert.ok(renders(String.raw`2^{\rm h}32^{\rm m}08\fs59, +26\arcdeg36'45\farcs8, i < 45\arcdeg`));
  const { view, done } = mount(doc(body, "\\usepackage{amsmath}"));
  assert.equal(widgetsOf(view).length, 3, view.contentDOM.innerHTML);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  assert.ok(!shown(view).includes("\\arcdeg"), shown(view));
  assert.ok(shown(view).includes("250°,"), shown(view));
  done();
  const result = everyWidgetOpens(doc(body, "\\usepackage{amsmath}"));
  assert.ok(result.count >= 5, String(result.count));
  assert.deepEqual(result.failures, []);
});

test("AASTeX's `\\fdg`, `\\farcm`, `\\fd`, `\\fh`, `\\fp` and `\\arcmin` are drawn (astro-ph.SR 2611.19134)", () => {
  assert.ok(renders(String.raw`(l, b)=(0\fdg 3539,-2\fdg 2520)`));
  assert.ok(renders(String.raw`1\farcm5, 3\fd2, 4\fh5, 6\fp1, 2\arcmin, 3\arcsec`));
  const { view, done } = mount(doc(String.raw`The location $(l, b)=(0\fdg 3539,-2\fdg 2520)$ is near 5\farcm2 of it.`));
  assert.equal(widgetsOf(view).length, 1);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  assert.ok(shown(view).includes("5.′2"), shown(view));
  done();
});

test("a user's own `\\arcdeg` wins over AASTeX's (astro-ph.EP 2611.16046)", () => {
  const { view, done } = mount(doc(String.raw`Turn by 5\arcdeg now.`, String.raw`\newcommand{\arcdeg}{ degrees}`));
  assert.ok(shown(view).includes("5 degrees"), shown(view));
  assert.ok(!shown(view).includes("5°"), shown(view));
  done();
});

test("a siunitx unit with a font command, `GeV/\\textit{c}^2`, is drawn in text and in a formula (hep-ex 2611.16397)", () => {
  assert.ok(renders(String.raw`m_X\gtrsim\SI{3.0}{GeV/\textit{c}^2}`));
  const body = String.raw`Approximately $m_X\gtrsim\SI{3.0}{GeV/\textit{c}^2}$, a beam of \SI{190}{GeV/\textit{c}}, a range \SI{0.1}{(GeV/\textit{c})^2} $<t^\prime<$ \SI{1.0}{(GeV/\textit{c})^2} and \SI{60}{m}.`;
  const { view, done } = mount(doc(body, "\\usepackage{siunitx}"));
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  assert.ok(!shown(view).includes("\\SI"), shown(view));
  assert.ok(widgetsOf(view).length >= 6, String(widgetsOf(view).length));
  done();
  const result = everyWidgetOpens(doc(body, "\\usepackage{siunitx}"));
  assert.deepEqual(result.failures, []);
});

test("siunitx units that are the collaboration's macros expanding to text are drawn (hep-ex 2611.16454)", () => {
  const preamble = String.raw`\usepackage{siunitx}
\usepackage{xspace}
\newcommand*{\electronvolt}{eV}
\newcommand*{\GeV}{\ensuremath{\text{G\electronvolt}}\xspace}
\newcommand*{\TeV}{\ensuremath{\text{T\electronvolt}}\xspace}
\newcommand*{\ET}{\ensuremath{E_{\text{T}}}\xspace}`;
  const body = String.raw`Collisions at \SI{13.6}{\TeV} with $\ET \lesssim \SI{40}{\GeV}$, a field of \qty{2}{\tesla}, \SI{25}{\GeV}, a pitch of \si{\micro\meter} and \qty{6.0}{\tesla\metre}.`;
  const { view, done } = mount(doc(body, preamble));
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  assert.ok(!shown(view).includes("\\SI") && !shown(view).includes("\\qty") && !shown(view).includes("\\si{"), shown(view));
  assert.ok(shown(view).includes("13.6") && shown(view).includes("TeV") && shown(view).includes("GeV"), shown(view));
  done();
  assert.deepEqual(everyWidgetOpens(doc(body, preamble)).failures, []);
});

test("`{\\mathchar'26\\mkern-9mu d}` is a barred d and `\\mathchar'26\\mkern-9mu h` is `\\hbar` (math.QA 2611.13129)", () => {
  assert.ok(renders(String.raw`{\mathchar'26\mkern-9mu d}x = \hbar`));
  assert.ok(renders(String.raw`{\mathchar'26\mkern -9mu h}`));
  assert.ok(!renders(String.raw`\mathchar"0141`));
  assert.ok(!renders(String.raw`{\mathchar'26\mkern-9mu 3}`));
  const body = String.raw`Write ${"$"}{\mathchar'26\mkern-9mu d} f = [F, f]$ and
\begin{equation}
{\mathchar'26\mkern-9mu d} f = i[F, f]
\end{equation}
End.`;
  const { view, done } = mount(doc(body));
  assert.equal(widgetsOf(view).length, 2);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  const source = view.state.doc.toString();
  opensToSource(view, 0, source.indexOf("${"), source.indexOf("$ and") + 1);
  opensToSource(view, 1, source.indexOf("\\begin{equation}"), source.indexOf("\\end{equation}") + 14);
  done();
});

test("lengths in `\\baselineskip` draw the restriction corner (math.MG 2611.13338)", () => {
  assert.ok(renders(String.raw`T \hspace{.1\baselineskip} \rule{.5pt}{.5 \baselineskip}\rule{.5\baselineskip}{.5pt} \hspace{.2\baselineskip} B_{r}\left( p\right) =P+R`));
  assert.ok(renders(String.raw`a\hspace{\baselineskip}b\kern 2\normalbaselineskip c`));
  assert.ok(!renders(String.raw`a\hspace{.5\textwidth}b`));
  const body = String.raw`Then $T \hspace{.1\baselineskip} \rule{.5pt}{.5 \baselineskip}\rule{.5\baselineskip}{.5pt} \hspace{.2\baselineskip} B_{r}\left( p\right) =P+R$ holds.`;
  const { view, done } = mount(doc(body));
  assert.equal(widgetsOf(view).length, 1);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  const source = view.state.doc.toString();
  opensToSource(view, 0, source.indexOf("$T"), source.indexOf("$ holds") + 1);
  done();
});

test("a tikz-cd square whose labels are `{sloped}` is drawn and opens to its source (math.QA 2611.13239)", () => {
  const diagram = String.raw`\begin{tikzcd}
A \arrow[r, "f"] \arrow[d, "\sim"'{sloped}] & B \arrow[d, "\sim"{sloped}] \\
C \arrow[r, "g"'] & D
\end{tikzcd}`;
  assert.ok(renders(diagram));
  const body = String.raw`Consider
\[
${diagram}
\]
done.`;
  const { view, done } = mount(doc(body));
  assert.equal(widgetsOf(view).length, 1);
  assert.equal(view.contentDOM.querySelectorAll(".cm-vis-math-source").length, 0);
  const source = view.state.doc.toString();
  opensToSource(view, 0, source.indexOf("\\["), source.indexOf("\\]") + 2);
  done();
});

test("a tikz-cd triangle with diagonal `{sloped}` arrows is source or a diagram, never junk (math.QA 2611.13239)", () => {
  const diagram = String.raw`\begin{tikzcd}
& X \arrow[ld, "\phi'"', "\sim"'{sloped}] \arrow[rd, "\psi"] & \\
A \arrow[rr, "\delta"'] & & B
\end{tikzcd}`;
  const { view, done } = mount(doc(`\\[\n${diagram}\n\\]`));
  // The diagonals are not drawn by KaTeX's arrays: the display stays source, its text unchanged.
  assert.equal(widgetsOf(view).length, 0);
  assert.ok(shown(view).includes("\\arrow[ld"), shown(view));
  done();
});
