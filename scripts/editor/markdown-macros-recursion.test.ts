import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownRenderer } from "../../src/components/markdown-renderer";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { createMathExtensions } from "../../src/lib/tiptap-math";
import { TiptapMarkdownMacros, tiptapMacrosKey } from "../../src/lib/tiptap-macros";
import { combinedMacroScope, expandMacroLatex, expandMarkdownMacros, parseMacroDefinitions } from "../../src/lib/markdown-macros";

// A macro that uses itself, and definitions that grow without a cycle, must
// leave every expander (preview, chat, Visual editor) with bounded work and
// output. Unbounded, the Visual editor ran out of memory on `\x = $y$\x and \x`.

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "DOMParser", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
after(() => dom.window.close());

const FENCE = "```";
const note = (definitions: string[], text: string) => `${FENCE}libera-macro\n${definitions.join("\n")}\n${FENCE}\n\n${text}\n`;
/** Generous for a slow machine, and far below the minutes (or the crash) of an unbounded expansion. */
const QUICK_MS = 2000;

function expandQuickly(definitions: string[], text: string) {
  const started = performance.now();
  const expansion = expandMarkdownMacros(note(definitions, text));
  const elapsed = performance.now() - started;
  assert.ok(elapsed < QUICK_MS, `expanded in ${Math.round(elapsed)} ms`);
  return expansion?.markdown.trim() ?? text;
}

test("a macro that uses itself expands once, and its own use stays as written", () => {
  assert.equal(expandQuickly([String.raw`\loop = \loop!`], String.raw`A \loop.`), String.raw`A \loop!.`);
  // The reported crash: two uses of itself doubled the text at each of 16 levels.
  assert.equal(expandQuickly([String.raw`\x = $y$\x and \x`], String.raw`Use \x here`), String.raw`Use $y$\x and \x here`);
  assert.equal(expandQuickly([String.raw`\x = \x \x \x \x \x \x \x \x`], String.raw`\x`), String.raw`\x \x \x \x \x \x \x \x`);
  // In math, as a math macro and inside a formula.
  assert.equal(expandQuickly([String.raw`\s = $\s + \s + 1$`], String.raw`\s and $2\s$`), String.raw`$\s + \s + 1$ and $2\s + \s + 1$`);
  // With arguments, a use with the same arguments again is the cycle.
  assert.equal(expandQuickly([String.raw`\newcommand{\again}[1]{(#1) \again{#1}}`], String.raw`\again{a}`), String.raw`(a) \again{a}`);
  // Counters still count once per expansion.
  assert.equal(expandQuickly([String.raw`\n = \counter-n, \n`], String.raw`\n and \n`), String.raw`1, \n and 2, \n`);
});

test("macros that use each other stop where the cycle closes", () => {
  assert.equal(expandQuickly([String.raw`\a = A\b`, String.raw`\b = B\a`], String.raw`\a | \b`), String.raw`AB\a | BA\b`);
  assert.equal(expandQuickly([String.raw`\a = <\b\b>`, String.raw`\b = [\c\c]`, String.raw`\c = (\a\a)`], String.raw`\a`), String.raw`<[(\a\a)(\a\a)][(\a\a)(\a\a)]>`);
  assert.equal(expandQuickly([String.raw`\p = $\q + 1$`, String.raw`\q = $\p + 2$`], String.raw`\p and $\q$`), String.raw`$\p + 2 + 1$ and $\q + 1 + 2$`);
  // A macro outside the cycle that uses it expands as usual around it.
  assert.equal(expandQuickly([String.raw`\a = A\b`, String.raw`\b = B\a`, String.raw`\title = **\a** done`], String.raw`\title`), String.raw`**AB\a** done`);
});

test("nesting without a cycle expands as before: chains, repeated uses and a macro in its own argument", () => {
  // Twelve macros deep, each using the next.
  const names = [..."abcdefghijkl"].map((letter) => `l${letter}`);
  const chain = names.map((name, index) => index < names.length - 1 ? `\\${name} = ${index}(\\${names[index + 1]})` : `\\${name} = end`);
  assert.equal(expandQuickly(chain, String.raw`\la`), "0(1(2(3(4(5(6(7(8(9(10(end)))))))))))");
  // The same macro many times, and at two levels.
  assert.equal(expandQuickly([String.raw`\F = $\mathcal{F}$`, String.raw`\FF = $\F \times \F$`, String.raw`\row = \FF, \FF, \FF and \F`], String.raw`\row; \row`),
    [1, 2].map(() => String.raw`$\mathcal{F} \times \mathcal{F}$, $\mathcal{F} \times \mathcal{F}$, $\mathcal{F} \times \mathcal{F}$ and $\mathcal{F}$`).join("; "));
  const wide = expandQuickly([String.raw`\w = word`, `\\line = ${String.raw`\w `.repeat(200).trim()}`, `\\page = ${String.raw`\line `.repeat(40).trim()}`], String.raw`\page`);
  assert.equal(wide, "word ".repeat(8000).trim());
  // A macro applied to itself is not a cycle: the arguments differ.
  assert.equal(expandQuickly([String.raw`\norm = $\lVert #1 \rVert$`, String.raw`\paren[1] = (#1)`], String.raw`$\norm{\norm{\norm{x}}}$ \paren{\paren{\paren{y}}}`),
    String.raw`$\lVert \lVert \lVert x \rVert \rVert \rVert$ (((y)))`);
  const definitions = parseMacroDefinitions(String.raw`\norm = $\lVert #1 \rVert$`);
  assert.equal(expandMacroLatex(String.raw`\norm{\norm{x}}`, definitions, new Map()), String.raw`\lVert \lVert x \rVert \rVert`);
});

test("an expansion that grows without a cycle stays as written, and the rest of the note expands", () => {
  // Eight uses at each of five levels: 32768 formulas.
  const tree = [..."abcdef"].map((letter, index, letters) => `\\t${letter} = ${index < letters.length - 1 ? `\\t${letters[index + 1]}`.repeat(8) : "$y$ and "}`);
  assert.equal(expandQuickly([...tree, String.raw`\ok = fine`], String.raw`\ta then \ok and \ta, \ok`), String.raw`\ta then fine and \ta, fine`);
  // An argument repeated at each level of a recursion that never repeats itself.
  assert.equal(expandQuickly([String.raw`\newcommand{\d}[1]{\d{#1#1#1#1#1#1#1#1}}`, String.raw`\ok = fine`], String.raw`\d{q} \ok`), String.raw`\d{q} fine`);
  // Empty macros give no text, and are bounded all the same.
  const empty = [..."abcdefgh"].map((letter, index, letters) => `\\newcommand{\\e${letter}}{${index < letters.length - 1 ? `\\e${letters[index + 1]}`.repeat(8) : ""}}`);
  assert.equal(expandQuickly(empty, String.raw`[\ea]`), String.raw`[\ea]`);
  // The counters of an expansion that is dropped go back.
  assert.equal(expandQuickly([...tree, String.raw`\big = \counter-k \counter-k \ta`], String.raw`\counter-k, \big, \counter-k`), String.raw`1, \big, 2`);
  // Recursion that changes its argument a little stops at the depth limit, as before.
  assert.equal(expandQuickly([String.raw`\newcommand{\grow}[1]{\grow{#1x}}`], String.raw`\grow{q}`), `\\grow{q${"x".repeat(17)}}`);
});

test("a note's expansions together are bounded", () => {
  // Each use is 81000 characters, allowed on its own; 150 of them are not.
  const definitions = [`\\u = ${"u".repeat(1000)}`, `\\m = ${String.raw`\u`.repeat(9)}`, `\\big = ${String.raw`\m`.repeat(9)}`];
  const started = performance.now();
  const expanded = expandMarkdownMacros(note(definitions, Array.from({ length: 150 }, () => String.raw`\big`).join("\n\n")))!.markdown;
  assert.ok(performance.now() - started < QUICK_MS * 2);
  assert.ok(expanded.startsWith(`\n${"u".repeat(81_000)}\n`));
  assert.ok(expanded.length > 4_000_000 && expanded.length < 5_500_000, `expanded to ${expanded.length} characters`);
  assert.ok(expanded.trimEnd().endsWith(String.raw`\big`), "what no longer fits stays as written");
});

test("the Visual editor shows a macro that uses itself, and one made to while editing", () => {
  const started = performance.now();
  const editor = new Editor({
    extensions: [...createMarkdownExtensions("Notes/a.md"), ...createMathExtensions(), TiptapMarkdownMacros],
    content: note([String.raw`\x = $y$\x and \x`, String.raw`\a = A\b`, String.raw`\b = B\a`, String.raw`\ok = fine`], String.raw`Use \x and \a here, \ok.`),
    contentType: "markdown",
  });
  try {
    const invocations = () => tiptapMacrosKey.getState(editor.state)!.invocations.map((invocation) => invocation.markdown);
    assert.deepEqual(invocations(), [String.raw`$y$\x and \x`, String.raw`AB\a`, "fine"]);
    assert.ok(editor.view.dom.querySelectorAll(".libera-macro-expansion").length >= 3);
    assert.ok(editor.view.dom.textContent!.length < 500);

    // Typing a use of the macro into its own definition, as an edit of the macro block may.
    let end = 0;
    editor.state.doc.descendants((node, pos) => { if (node.type.spec.code) end = pos + node.nodeSize - 1; });
    editor.view.dispatch(editor.state.tr.insertText(String.raw` \ok \ok \ok`, end));
    assert.deepEqual(invocations(), [String.raw`$y$\x and \x`, String.raw`AB\a`, String.raw`fine \ok \ok \ok`]);
    assert.ok(editor.view.dom.textContent!.length < 500);
    assert.ok(performance.now() - started < QUICK_MS * 2);
  } finally {
    editor.destroy();
  }
});

test("the preview and chat replies render recursive macros bounded", () => {
  const document = note([String.raw`\x = $y$\x and \x`, String.raw`\a = A\b`, String.raw`\b = B\a`], String.raw`Use \x and \a here.`);
  const started = performance.now();
  const preview = renderToStaticMarkup(createElement(MarkdownRenderer, { content: document }));
  assert.ok(preview.includes(String.raw`\x and \x`) && preview.includes(String.raw`AB\a`));
  assert.ok(preview.length < 20_000, `rendered ${preview.length} characters`);

  const scope = combinedMacroScope([document])!;
  const reply = renderToStaticMarkup(createElement(MarkdownRenderer, { content: String.raw`Then \x holds, by \b.`, macroScope: scope }));
  assert.ok(reply.includes(String.raw`\x and \x`) && reply.includes(String.raw`BA\b`));
  assert.ok(reply.length < 20_000, `rendered ${reply.length} characters`);
  assert.ok(performance.now() - started < QUICK_MS * 2);
});
