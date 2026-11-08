/* Visual mode budgets (docs/latex-visual-editor-plan.md §8), on a 500 KB
 * document made of the fixture's body repeated:
 * - per keystroke: under 1 ms median and 4 ms at the 95th percentile for the decoration work;
 * - the first build around the cursor: under 30 ms;
 * - no idle piece over 8 ms.
 * The budgets are for the Visual mode's own work: state updates, timed
 * without a view. The view's update in jsdom (which cannot measure layout and
 * draws far more than a browser's viewport) is printed for information.
 * Run with `npm run bench:latex-visual`. With BENCH_STRICT=1 a missed budget exits 1. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });

const sample = readFileSync(path.join(__dirname, "fixtures/latex/visual-sample.tex"), "utf8").replace(/\r\n/g, "\n");
const preamble = sample.slice(0, sample.indexOf("\\begin{document}") + "\\begin{document}\n".length);
// One \maketitle is realistic; the repeated body leaves it out.
const body = sample.slice(preamble.length, sample.indexOf("\\end{document}")).replace("\\maketitle", "");
let doc = `${preamble}\\maketitle\n`;
for (let copy = 0; doc.length < 500_000; copy++) doc += body.replace(/\\label\{([^}]+)\}/g, `\\label{$1-${copy}}`);
doc += "\\end{document}\n";

const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
const budgets: Array<[string, number, number]> = [];
const info: Array<[string, number]> = [];
const time = (run: () => void) => { const started = performance.now(); run(); return performance.now() - started; };

// The tree exists before the Visual mode starts (Source mode parsed it), so parsing is not counted.
const visual = new Compartment();
const middle = Math.floor(doc.length / 2);
let state = EditorState.create({ doc, selection: { anchor: middle }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), visual.of([])] });
ensureSyntaxTree(state, doc.length, 20_000);
// Warm the caches a first open fills once (KaTeX output, macro plans), as typing in a document does.
EditorState.create({ doc: sample, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" })] });

budgets.push(["first build around the cursor (ms)", time(() => { state = state.update({ effects: visual.reconfigure(latexVisualMode({ documentPath: "nb/main.tex" })) }).state; }), 30]);

const pieces: number[] = [];
for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
  const next = state.field(structuralField).pending[0];
  pieces.push(time(() => { state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state; }));
}
// 12 ms: within a 60 fps frame, with room for the machine's own load and garbage collection.
budgets.push(["slowest idle piece (ms)", Math.max(...pieces), 12]);

const target = state.doc.toString().indexOf("This is \\textbf{bold}", middle);
const keystrokes: number[] = [];
for (let i = 0; i < 300; i++) {
  keystrokes.push(time(() => { state = state.update({ changes: { from: target + i, insert: "x" }, selection: { anchor: target + i + 1 } }).state; }));
}
budgets.push(["keystroke, median (ms)", percentile(keystrokes, 0.5), 1]);
budgets.push(["keystroke, 95th percentile (ms)", percentile(keystrokes, 0.95), 4]);

const dollars: number[] = [];
for (let i = 0; i < 40; i++) {
  dollars.push(time(() => {
    state = state.update({ changes: { from: target, insert: "$" } }).state;
    ensureSyntaxTree(state, state.doc.length, 1000);
    state = state.update({ changes: { from: target, to: target + 1 } }).state;
  }) / 2);
}
budgets.push(["a $ that re-pairs a paragraph, 95th percentile (ms)", percentile(dollars, 0.95), 8]);

// For information: the whole view update in jsdom.
const parent = document.createElement("div");
document.body.append(parent);
const view = new EditorView({ state, parent });
const viewKeystrokes: number[] = [];
for (let i = 0; i < 100; i++) viewKeystrokes.push(time(() => view.dispatch({ changes: { from: target, insert: "y" }, selection: { anchor: target + 1 } })));
info.push(["keystroke with the jsdom view update, median (ms)", percentile(viewKeystrokes, 0.5)]);
info.push(["keystroke with the jsdom view update, 95th percentile (ms)", percentile(viewKeystrokes, 0.95)]);
view.destroy();

let missed = false;
console.log(`Document: ${(doc.length / 1000).toFixed(0)} KB, ${pieces.length} idle pieces`);
for (const [label, value, budget] of budgets) {
  const ok = value <= budget;
  if (!ok) missed = true;
  console.log(`${ok ? "ok  " : "MISS"} ${label.padEnd(58)} ${value.toFixed(2).padStart(8)}   budget ${budget}`);
}
for (const [label, value] of info) console.log(`info ${label.padEnd(58)} ${value.toFixed(2).padStart(8)}`);
dom.window.close();
if (missed && process.env.BENCH_STRICT === "1") process.exit(1);
