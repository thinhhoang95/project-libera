import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fc from "fast-check";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, Text } from "@codemirror/state";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { boxEnvironments } from "../../src/lib/latex/codemirror/visual/walk";
import { emptyLatexDefinitions } from "../../src/lib/latex/macros/definitions";

/* The decoration build's cached box environments and a backtracking-prone pattern (performance audit, walk.ts). */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
after(() => dom.window.close());

const extensions = () => [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" })];

test("boxEnvironments keeps both the defs and the no-defs shape per document", () => {
  const doc = Text.of(["\\newtcolorbox{prompt}[1][]{title=#1}", "text"]);
  const defs = emptyLatexDefinitions();
  defs.boxes = new Map([["projectbox", { title: null, arity: 0, optional: false, counter: false, within: null }]]);
  const withDefs = boxEnvironments(doc, defs);
  const without = boxEnvironments(doc);
  assert.notEqual(withDefs, without);
  assert.equal(boxEnvironments(doc, defs), withDefs);
  assert.equal(boxEnvironments(doc, undefined), without);
  assert.deepEqual([...withDefs.keys()], ["tcolorbox", "mdframed", "projectbox", "prompt"]);
  assert.deepEqual([...without.keys()], ["tcolorbox", "mdframed", "prompt"]);
});

test("boxes carried across edits equal a fresh computation", () => {
  const pieces = ["\\newtcol", "orbox{b}", "\\newmdenv{n}", "\n", "x", "\\", "newtcolorbox", "{c}", " ", "\\renewtcolorbox{d}"];
  const edit = fc.record({ at: fc.nat(1000), len: fc.nat(8), piece: fc.constantFrom(...pieces) });
  fc.assert(fc.property(fc.array(edit, { minLength: 1, maxLength: 12 }), (edits) => {
    let state = EditorState.create({ doc: "\\documentclass{article}\n\\begin{document}\nplain text\nmore\n\\end{document}\n", extensions: extensions() });
    boxEnvironments(state.doc);
    for (const { at, len, piece } of edits) {
      const from = at % (state.doc.length + 1);
      state = state.update({ changes: { from, to: Math.min(state.doc.length, from + len), insert: piece } }).state;
      const fresh = boxEnvironments(Text.of(state.doc.toString().split("\n")));
      assert.deepEqual([...boxEnvironments(state.doc)], [...fresh]);
    }
  }), { numRuns: 300 });
});

test("an IEEEbiography name made of many control words does not backtrack", () => {
  const name = "\\textbf ".repeat(40) + "Ada $";
  const doc = `\\documentclass{IEEEtran}\n\\begin{document}\n\\begin{IEEEbiographynophoto}{${name}\nBio text.\n\\end{IEEEbiographynophoto}\n\\end{document}\n`;
  const started = Date.now();
  let state = EditorState.create({ doc, extensions: extensions() });
  ensureSyntaxTree(state, doc.length, 5000);
  for (let guard = 0; state.field(structuralField).pending.length && guard < 50; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  assert.ok(Date.now() - started < 3000);
});
