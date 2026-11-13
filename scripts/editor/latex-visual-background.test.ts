import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexParser } from "../../src/lib/latex/codemirror/latex-parser";
import { latexVisualMode, latexVisualState, setNumberingIncludes } from "../../src/lib/latex/codemirror/visual";
import { numberingField } from "../../src/lib/latex/codemirror/visual/model";
import { buildPendingEffect, structuralField } from "../../src/lib/latex/codemirror/visual/structural";

/* The Visual mode's background plugins: the idle filler on a file the parser does not finish, and the include parses numbering keeps. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mountWith(doc: string, listener: (effects: number) => void = () => {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }),
        EditorView.updateListener.of((update) => { for (const tr of update.transactions) if (tr.effects.some((effect) => effect.is(buildPendingEffect))) listener(1); })],
    }),
  });
}

test("the idle filler does not spin on pending pieces past what the parser has reached, and wakes up when the tree grows", async () => {
  const paragraph = "\\section{Part}\nSome text with $x^2$ and \\textbf{bold} words, then a formula \\[ a = b \\]\n\n";
  let doc = "\\documentclass{article}\n\\begin{document}\n";
  while (doc.length < 1_500_000) doc += paragraph;
  doc += "\\end{document}\n";
  let effects = 0;
  const view = mountWith(doc, (n) => { effects += n; });
  try {
    // Let the background parser and the first builds settle.
    await sleep(1500);
    const tree = syntaxTree(view.state).length;
    assert.ok(tree < doc.length, `the parser stops short of the document (tree ${tree} of ${doc.length})`);
    const pending = view.state.field(structuralField).pending;
    assert.ok(pending.length > 0 && pending[0].from >= tree - 1, `only what the parser did not reach is pending (${JSON.stringify(pending[0])}, tree ${tree})`);
    const settled = effects;
    await sleep(700);
    assert.ok(effects - settled <= 1, `no build transactions while nothing can be built (${effects - settled} dispatched in 700 ms)`);
    // The tree completes: the rest is built.
    ensureSyntaxTree(view.state, doc.length, 120_000);
    view.dispatch({});
    assert.equal(syntaxTree(view.state).length, doc.length);
    const before = effects;
    for (let i = 0; i < 400 && view.state.field(structuralField).pending.length; i++) await sleep(50);
    assert.equal(view.state.field(structuralField).pending.length, 0, "everything is built once the tree is complete");
    assert.ok(effects > before || view.state.field(structuralField).pending.length === 0);
  } finally {
    view.destroy();
  }
});

test("numbering keeps one parse per include key, replaced when its text changes", async () => {
  const parse = latexParser.parse.bind(latexParser);
  const parsed: string[] = [];
  (latexParser as unknown as { parse: typeof parse }).parse = ((...args: Parameters<typeof parse>) => { if (typeof args[0] === "string") parsed.push(args[0]); return parse(...args); }) as typeof parse;
  const view = mountWith("\\documentclass{article}\n\\begin{document}\n\\section{Main}\n\\input{a}\n\\input{b}\n\\end{document}\n");
  try {
    const textA = "\\section{Alpha}\\label{sa}";
    const textB = "\\section{Beta}\\label{sb}";
    const settle = async () => { await sleep(500); };
    view.dispatch({ effects: setNumberingIncludes.of(new Map([["input:a", textA], ["input:b", textB]])) });
    await settle();
    const count = (text: string) => parsed.filter((item) => item === text).length;
    assert.equal(count(textA), 1);
    assert.equal(count(textB), 1);
    assert.equal(view.state.field(numberingField).labels.get("sb")?.number, "3");
    // An edit in the main file: nothing included is parsed again.
    view.dispatch({ changes: { from: view.state.doc.length - 1, insert: "x" } });
    await settle();
    assert.equal(count(textA), 1);
    assert.equal(count(textB), 1);
    // A new version of `a`: it is parsed, and `b` is not.
    const textA2 = "\\section{Alpha}\\section{Alpha 2}\\label{sa}";
    view.dispatch({ effects: setNumberingIncludes.of(new Map([["input:a", textA2], ["input:b", textB]])) });
    await settle();
    assert.equal(count(textA2), 1);
    assert.equal(count(textB), 1);
    assert.equal(view.state.field(numberingField).labels.get("sb")?.number, "4");
    // `a` leaves the project and comes back with its old text: parsed again (nothing kept for a key no longer included).
    view.dispatch({ effects: setNumberingIncludes.of(new Map([["input:b", textB]])) });
    await settle();
    view.dispatch({ effects: setNumberingIncludes.of(new Map([["input:a", textA], ["input:b", textB]])) });
    await settle();
    assert.equal(count(textA), 2);
    assert.equal(count(textB), 1);
  } finally {
    view.destroy();
    delete (latexParser as unknown as { parse?: unknown }).parse;
  }
});
