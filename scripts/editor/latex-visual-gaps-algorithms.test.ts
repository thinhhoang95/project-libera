import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { history, undo } from "@codemirror/commands";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { computeLatexNumbering, referenceText } from "../../src/lib/latex/macros/numbering";
import { algorithmLineNumbers, parseAlgorithm2e, parseAlgorithmic } from "../../src/lib/latex/codemirror/visual/algorithm";
import { statementSource } from "../../src/lib/latex/codemirror/visual/algorithm-edit";

/* Algorithms edited by their parts (a statement, the caption), one unknown statement drawn as a source line inside the
 * drawn algorithm, algorithm2e's and algorithmicx's line labels, and algorithms typed progressively. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser", "KeyboardEvent", "MouseEvent"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());
// JSDOM measures no text: the editor's measuring after a frame reads empty rectangles.
Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }) });

/** The Visual mode's state for `doc`, with every pending piece built. */
function visualState(doc: string, extra: Extension[] = []) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }), history(), ...extra] });
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

function constructs(state: EditorState) {
  const list: string[] = [];
  state.field(structuralField).extents.between(0, state.doc.length, (from, to, mark) => { list.push(`${mark.kind}:${from}:${to}`); });
  return list;
}

function mount(doc: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc), parent });
  refreshVisualWidgets(view);
  return view;
}

const rows = (view: EditorView) => [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-algorithm [data-algorithm-line]")];
const row = (view: EditorView, text: string) => rows(view).find((element) => (element.textContent ?? "").includes(text))!;
const click = (target: Element, init: Record<string, unknown> = {}) => target.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init }));
const press = (target: Element, key: string, init: Record<string, unknown> = {}) => target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
const typeInto = (area: HTMLTextAreaElement, value: string) => { area.value = value; area.dispatchEvent(new window.Event("input", { bubbles: true })); };
const editor = (view: EditorView) => view.contentDOM.querySelector<HTMLTextAreaElement>(".cm-vis-algorithm-editor");
const frame = () => new Promise((resolve) => setTimeout(resolve, 40));
const lineTexts = (spec: ReturnType<typeof parseAlgorithmic>) => spec?.lines.map((line) => `${line.depth}|${line.lead ?? ""}|${line.text}|${line.raw ? "raw" : ""}`) ?? null;

const PSEUDO = String.raw`\documentclass{article}
\usepackage{algorithm,algpseudocode}
\begin{document}
Before.
\begin{algorithm}
\caption{Train}\label{alg:train}
\begin{algorithmic}[1]
\State $x \gets 0$
\If{$x > 0$}
  \State keep \label{line:keep}
\EndIf
\State \Return $x$
\end{algorithmic}
\end{algorithm}
After.
\end{document}
`;

test("one unknown statement is a source line in the drawn algorithm; the lines after it keep their numbers", () => {
  const spec = parseAlgorithmic(String.raw`\State a
\ForEach{$v$}
\State b
\EndForEach
\State c`, "1");
  assert.deepEqual(lineTexts(spec), ["0||a|", "0||\\ForEach{$v$}|raw", "0||b|", "0||\\EndForEach|raw", "0||c|"]);
  assert.deepEqual(algorithmLineNumbers(spec!), [1, 2, 3, 4, 5]);
  // Text before the first statement, and a statement without its argument, are source lines too.
  assert.deepEqual(lineTexts(parseAlgorithmic(String.raw`Some words \State a \While \State b`, null)), ["0||Some words|raw", "0||a|", "0||\\While|raw", "0||b|"]);
  // Only unbalanced braces, or nothing known, leave the whole algorithm as source.
  assert.equal(parseAlgorithmic(String.raw`\State {a`, null), null);
  assert.equal(parseAlgorithmic(String.raw`\ForEach{x}`, null), null);
});

test("algorithm2e: an unknown statement and a definition are source lines; the rest stays drawn", () => {
  const spec = parseAlgorithm2e(String.raw`x\;
\Unknown{z}\;
\let\oldnl\nl
y\;`, { numbered: true, ends: true }, () => null)!;
  assert.deepEqual(spec.lines.map((line) => `${line.text}|${line.raw ? "raw" : ""}`), ["x|", "\\Unknown{z}|raw", "\\let\\oldnl\\nl|raw", "y|"]);
  // A definition changes the numbering in ways not read: numbers after it are not shown.
  assert.deepEqual(algorithmLineNumbers(spec), [1, 2, null, null]);
  // A block inside a one-line form: that form is source, the others are drawn.
  const inline = parseAlgorithm2e(String.raw`a\; \lIf{c}{\If{d}{x}} b\;`, { numbered: false, ends: false })!;
  assert.deepEqual(inline.lines.map((line) => `${line.text}|${line.raw ? "raw" : ""}`), ["a|", "\\lIf{c}{\\If{d}{x}}|raw", "b|"]);
});

test("algorithm2e: \\SetKwComment, \\SetKwIF, \\SetKwRepeat, \\nl and \\lnl, and \\Indp inside a block", () => {
  const spec = parseAlgorithm2e(String.raw`\SetKwComment{Comment}{/* }{ */}\SetKwIF{Si}{SinonSi}{Sinon}{si}{alors}{sinon si}{sinon}{fin si}\SetKwRepeat{Do}{do}{while}
x\; \Comment*{side}
\Comment{own line}
\eSi{c}{a\;}{b\;}
\Do{$k<3$}{k\;}
\For{$i$}{\Indp p\;}
q\;`, { numbered: false, ends: true })!;
  assert.deepEqual(spec.lines.map((line) => [line.depth, line.lead ?? "", line.text, line.trail ?? "", line.comment ?? ""].join("|")), [
    "0||x||side", "0||||own line", "0|si|c|alors|", "1||a||", "0|sinon|||", "1||b||", "0|fin si|||",
    "0|do|||", "1||k||", "0|while|$k<3$||", "0|for|$i$|do|", "2||p||", "0|end|||", "0||q||",
  ]);
  const numbered = parseAlgorithm2e(String.raw`a\; \nl b\; \lnl{l:c} c\;`, { numbered: false, ends: true })!;
  assert.equal(numbered.numberEvery, 1);
  assert.deepEqual(algorithmLineNumbers(numbered), [null, 1, 2]);
  assert.deepEqual(numbered.lines[2].labels?.map((label) => label.key), ["l:c"]);
});

test("\\ref to a label on an algorithm's line is the line number; \\cref says \"line\"", () => {
  const read = (doc: string) => {
    const state = visualState(doc);
    const defs = visualDefinitions(state);
    const numbering = computeLatexNumbering(syntaxTree(state), (from, to) => state.doc.sliceString(from, to), defs);
    return (command: string, key: string) => referenceText(command, [numbering.labels.get(key) ?? null], defs, [key]);
  };
  const pseudo = read(PSEUDO);
  assert.equal(pseudo("\\ref", "line:keep"), "3");
  assert.equal(pseudo("\\cref", "line:keep"), "line 3");
  assert.equal(pseudo("\\ref", "alg:train"), "1");
  const twoE = read(String.raw`\documentclass{article}
\usepackage[ruled,linesnumbered]{algorithm2e}
\begin{document}
\begin{algorithm}
\caption{Insert}\label{alg:ins}
a\;
\nllabel{l:b} b\;
\For(\label{l:for}){$i$}{c\;}
\end{algorithm}
\end{document}
`);
  assert.equal(twoE("\\ref", "l:b"), "2");
  assert.equal(twoE("\\ref", "l:for"), "3");
  assert.equal(twoE("\\cref", "l:for"), "line 3");
  assert.equal(twoE("\\ref", "alg:ins"), "1");
});

test("clicking a statement edits its LaTeX in place: minimal change, one undo step; Escape writes nothing; Tab goes on", async () => {
  const view = mount(PSEUDO);
  click(row(view, "keep"));
  let area = editor(view)!;
  assert.ok(area, "the statement opens in an editor");
  assert.equal(area.value, "\\State keep \\label{line:keep}");
  typeInto(area, "\\State discard \\label{line:keep}");
  press(area, "Enter");
  assert.equal(view.state.doc.toString(), PSEUDO.replace("keep \\label", "discard \\label"));
  assert.ok(row(view, "discard"), "the algorithm is drawn again with the new text");
  undo(view);
  assert.equal(view.state.doc.toString(), PSEUDO);
  click(row(view, "keep"));
  area = editor(view)!;
  typeInto(area, "\\State nothing");
  press(area, "Escape");
  assert.equal(view.state.doc.toString(), PSEUDO);
  // Tab saves and opens the next statement.
  click(row(view, "x \u2190 0") ?? rows(view)[0]);
  area = editor(view)!;
  assert.equal(area.value, "\\State $x \\gets 0$");
  press(area, "Tab");
  await frame();
  assert.equal(editor(view)?.value, "\\If{$x > 0$}");
  press(editor(view)!, "Escape");
  // Alt-click shows the line's source: the cursor goes into it.
  click(row(view, "keep"), { altKey: true });
  const at = PSEUDO.indexOf("\\State keep");
  assert.ok(view.state.selection.main.head > at && view.state.selection.main.head < at + "\\State keep \\label{line:keep}".length);
  view.destroy();
});

test("a line's menu inserts a statement inside a block and deletes a statement, or a block whole", async () => {
  const view = mount(PSEUDO);
  const menuItem = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".cm-vis-algorithm-menu button")].find((button) => button.textContent === label)!;
  row(view, "if").dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  assert.equal(menuItem("Delete block").disabled, false);
  menuItem("Insert statement below").click();
  const area = editor(view)!;
  assert.ok(area, "a field for the new statement opens");
  typeInto(area, "$y \\gets 1$");
  press(area, "Enter");
  assert.equal(view.state.doc.toString(), PSEUDO.replace("\\If{$x > 0$}\n", "\\If{$x > 0$}\n  \\State $y \\gets 1$\n"));
  undo(view);
  assert.equal(view.state.doc.toString(), PSEUDO);
  // A block's last line is not deleted alone.
  row(view, "end if").dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  assert.equal(menuItem("Delete statement").disabled, true);
  document.body.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
  // Deleting the `\If` line asks, then deletes its whole block.
  const confirm = window.confirm;
  window.confirm = () => true;
  row(view, "if").dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  menuItem("Delete block").click();
  window.confirm = confirm;
  assert.equal(view.state.doc.toString(), PSEUDO.replace("\\If{$x > 0$}\n  \\State keep \\label{line:keep}\n\\EndIf\n", ""));
  undo(view);
  row(view, "return").dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  menuItem("Delete statement").click();
  assert.equal(view.state.doc.toString(), PSEUDO.replace("\\State \\Return $x$\n", ""));
  await frame();
  view.destroy();
});

test("a new statement is written with its package's keyword, and a block with its last line", () => {
  assert.equal(statementSource("$x$", "algorithmic", false, ""), "\\State $x$");
  assert.equal(statementSource("x", "algorithmic", true, ""), "\\STATE x");
  assert.equal(statementSource("\\For{$i$}", "algorithmic", false, "  "), "\\For{$i$}\n  \\EndFor");
  assert.equal(statementSource("\\IF{$c$}", "algorithmic", true, ""), "\\IF{$c$}\n\\ENDIF");
  assert.equal(statementSource("x \\gets 1", "algorithm2e", false, ""), "x \\gets 1\\;");
  assert.equal(statementSource("\\If{c}{x\\;}", "algorithm2e", false, ""), "\\If{c}{x\\;}");
});

test("algorithm2e: an unknown statement is drawn as source inside the float; a statement and the caption are edited in place", () => {
  const doc = String.raw`\documentclass{article}
\usepackage[ruled,linesnumbered]{algorithm2e}
\begin{document}
\begin{algorithm*}
\KwIn{$G$}
$t \gets 0$\;
\MyOwn{$t$}\;
\While{$t < 3$}{$t \gets t + 1$\;}
\caption{Count}
\end{algorithm*}
\end{document}
`;
  assert.equal(constructs(visualState(doc)).filter((item) => item.startsWith("figure:")).length, 1);
  const view = mount(doc);
  const raw = view.contentDOM.querySelector(".cm-vis-algorithm-raw");
  assert.equal(raw?.textContent, "\\MyOwn{$t$}");
  // ruled: the caption is on top.
  const figure = view.contentDOM.querySelector(".cm-vis-figure")!;
  assert.ok(figure.firstElementChild?.classList.contains("cm-vis-caption"));
  click(row(view, "t ← 0") ?? rows(view)[1]);
  const area = editor(view)!;
  assert.equal(area.value, "$t \\gets 0$");
  typeInto(area, "$t \\gets 1$");
  press(area, "Enter");
  assert.equal(view.state.doc.toString(), doc.replace("$t \\gets 0$\\;", "$t \\gets 1$\\;"));
  click(view.contentDOM.querySelector("[data-algorithm-caption]")!);
  const caption = editor(view)!;
  assert.equal(caption.value, "Count");
  typeInto(caption, "Count up");
  press(caption, "Enter");
  assert.match(view.state.doc.toString(), /\\caption\{Count up\}/);
  view.destroy();
});

test("typing an algorithm: an open block is source until it is closed; the result equals a fresh build", () => {
  const head = String.raw`\documentclass{article}
\usepackage{algorithm,algpseudocode}
\begin{document}
Before.
\begin{algorithm}
\caption{T}
\begin{algorithmic}[1]
\State a
`;
  const tail = "\\end{algorithmic}\n\\end{algorithm}\nAfter.\n\\end{document}\n";
  const steps = ["\\For{$i$}\n", "\\State b\n", "\\EndFor\n"];
  // Line by line: while the `\For` is open, its lines are one source line; closed, they are drawn.
  const open = parseAlgorithmic("\\State a\n\\For{$i$}\n\\State b\n", "1")!;
  assert.deepEqual(lineTexts(open), ["0||a|", "0||\\For{$i$}\n\\State b|raw"]);
  const closed = parseAlgorithmic("\\State a\n\\For{$i$}\n\\State b\n\\EndFor\n", "1")!;
  assert.deepEqual(lineTexts(closed), ["0||a|", "0|for|$i$|", "1||b|", "0|end for||"]);
  // Character by character in the editor: every state is as a fresh build, and the paragraph around is untouched.
  let view = mount(head + tail);
  let at = head.length;
  for (const text of steps.join("")) {
    view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: view.state.doc.length } });
    at++;
  }
  const doc = view.state.doc.toString();
  assert.deepEqual(constructs(view.state), constructs(visualState(doc)));
  view.destroy();
  // A missing `\end{algorithmic}` leaves the float source.
  const unfinished = head + "\\For{$i$}\n\\end{algorithm}\nAfter.\n\\end{document}\n";
  assert.equal(constructs(visualState(unfinished)).filter((item) => item.startsWith("figure:")).length, 0);
  view = mount(head + steps.join("") + tail);
  assert.equal(view.contentDOM.querySelector(".cm-vis-algorithm-raw"), null);
  view.destroy();
});
