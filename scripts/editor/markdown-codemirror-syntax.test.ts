import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { analyzeLiberaSyntax, liberaMathMarkers, scanLiberaBoxLine, scanLiberaInline } from "../../src/lib/markdown-codemirror/libera-syntax";
import { markdownSourceSetup } from "../../src/lib/markdown-codemirror/setup";

/* The CodeMirror Source editor's decoration layer recognises Libera's syntax:
 * text colours, colour-prefixed highlights, coloured boxes, math with the
 * configured markers, underlines and numeric text-style spans, and leaves code
 * alone. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) {
  Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
}
Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() });
after(() => dom.window.close());

const kinds = (text: string) => scanLiberaInline(text).map((match) => [match.kind, text.slice(match.contentFrom, match.contentTo)]);

test("inline Libera syntax is recognised with its content and colour", () => {
  assert.deepEqual(kinds("a [color=#dc2626]red text[/color] b"), [["color", "red text"]]);
  assert.equal(scanLiberaInline("[color=#2563eb]x[/color]")[0].color, "#2563eb");
  assert.deepEqual(kinds(">>>plain<<< and r>>>red<<< and ==marked=="), [["highlight", "plain"], ["highlight", "red"], ["highlight", "marked"]]);
  const [yellow, red] = scanLiberaInline(">>>plain<<< r>>>red<<<");
  assert.equal(yellow.color, "#fef08a");
  assert.equal(red.color, "#dc2626");
  assert.deepEqual(kinds("x <u>under</u> y"), [["underline", "under"]]);
  const style = scanLiberaInline('<span data-font-size="24" data-line-height="2">big</span>');
  assert.deepEqual(style.map((match) => [match.kind, match.title]), [["text-style", "Font size 24px, Line spacing 2"]]);
  assert.deepEqual(kinds("Euler: $e^{i\\pi}+1=0$ and $$x$$"), [["math", "e^{i\\pi}+1=0"], ["math", "x"]]);
  assert.deepEqual(kinds("$$\nx = y\n$$"), [["math", "\nx = y\n"]]);
  assert.deepEqual(kinds("\\[a+b\\] and \\(c\\)"), [["math", "a+b"], ["math", "c"]]);
});

test("math follows the configured markers and hides other syntax inside it", () => {
  assert.deepEqual(kinds("$a [color=#000]b[/color]$"), [["math", "a [color=#000]b[/color]"]]);
  const custom = scanLiberaInline("@@x@@ and $y$", 0, { mathMarkers: { inlineMathMarkers: "@@ @@", blockMathMarkers: "" } });
  assert.deepEqual(custom.map((match) => match.kind), ["math"]);
  assert.equal(scanLiberaInline("price \\$5 and \\$6").length, 0, "escaped dollars are text");
  assert.equal(scanLiberaInline("$a\n\nb$").length, 0, "math never crosses a blank line");
});

test("code spans passed as skip ranges are left alone", () => {
  const text = "`[color=#000]x[/color]` and <u>y</u>";
  const matches = scanLiberaInline(text, 0, { skip: [{ from: 0, to: 23 }] });
  assert.deepEqual(matches.map((match) => match.kind), ["underline"]);
});

test("coloured box lines are recognised by their prefix", () => {
  assert.deepEqual(scanLiberaBoxLine("y> Remember", 10), { kind: "box", from: 10, to: 21, contentFrom: 13, contentTo: 21, color: "#fef08a" });
  assert.equal(scanLiberaBoxLine("b>")?.color, "#2563eb");
  assert.equal(scanLiberaBoxLine("> plain quote"), null);
  assert.equal(scanLiberaBoxLine("y>>>highlight<<<"), null);
  assert.equal(scanLiberaBoxLine("x> not a colour"), null);
});

test("line tones and constructs come from the Markdown tree, skipping code", () => {
  const doc = [
    "# Title",
    "## Section",
    "Text with r>>>red<<< and $x$.",
    "",
    "y> **Boxed**",
    "y>",
    "",
    "> quote",
    "",
    "```md",
    "# not a heading",
    "y> not a box [color=#000]x[/color]",
    "```",
    "",
    "Inline `<u>code</u>` and <u>real</u>.",
    "#### Deep",
  ].join("\n");
  const state = EditorState.create({ doc, extensions: markdownSourceSetup() });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const result = analyzeLiberaSyntax(state);
  const toneOf = (lineNumber: number) => result.lines.find((line) => line.from === state.doc.line(lineNumber).from)?.tone;
  assert.equal(toneOf(1), "heading-1");
  assert.equal(toneOf(2), "heading-2");
  assert.equal(toneOf(5), "box");
  assert.equal(toneOf(6), "box");
  assert.equal(toneOf(8), "quote");
  assert.equal(toneOf(11), undefined, "a # line inside a fence is code");
  assert.equal(toneOf(12), undefined, "a box prefix inside a fence is code");
  assert.equal(toneOf(16), "heading-4");
  const inline = result.inline.map((match) => [match.kind, state.sliceDoc(match.contentFrom, match.contentTo)]);
  assert.deepEqual(inline, [["highlight", "red"], ["math", "x"], ["underline", "real"]]);
});

test("the view draws the decorations with the app's classes", () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({ doc: "# Head\n\ny> box with g>>>green<<< and [color=#16a34a]ok[/color]\n\n$a+b$ <u>u</u>", extensions: [markdownSourceSetup(), liberaMathMarkers.of({})] }),
    parent,
  });
  try {
    const html = view.contentDOM.innerHTML;
    for (const name of ["cm-md-heading-1", "cm-libera-box", "cm-libera-highlight", "cm-libera-color", "cm-libera-math", "cm-libera-underline", "cm-libera-marker"]) {
      assert.match(html, new RegExp(name), `${name} is drawn`);
    }
    assert.match(html, /--libera-box-color: #fef08a/);
    assert.match(html, /--libera-highlight-color: #15803d/);
    // jsdom normalises the inline colour.
    assert.match(html, /color: (?:#16a34a|rgb\(22, 163, 74\))/);
  } finally {
    view.destroy();
    parent.remove();
  }
});
