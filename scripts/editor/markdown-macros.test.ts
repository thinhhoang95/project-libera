import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownRenderer } from "../../src/components/markdown-renderer";
import { prepareMarkdownPreview } from "../../src/lib/markdown-preview";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { createMathExtensions } from "../../src/lib/tiptap-math";
import { TiptapMarkdownMacros, tiptapMacrosKey } from "../../src/lib/tiptap-macros";
import { collectMarkdownMacros, expandMarkdownMacros, markdownMacroScopes, parseMacroDefinitions } from "../../src/lib/markdown-macros";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "DOMParser", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
after(() => dom.window.close());

const FENCE = "```";
const MACROS = [
  `${FENCE}libera-macro`,
  String.raw`\fset = $\mathcal{F}$`,
  String.raw`\R = $\mathbb{R}$`,
  String.raw`\norm = $\lVert #1 \rVert$`,
  String.raw`\energy = $$E = mc^2$$`,
  "% a comment",
  String.raw`\newcommand{\theorem}[2]{**Theorem \counter-theorem (#1).** *#2*}`,
  String.raw`\lab = Libera Lab`,
  FENCE,
].join("\n");
const DOCUMENT = `${MACROS}\n\n${String.raw`Let \fset be a family over $\R^n$ with $\norm{x} \le 1$.

\theorem{Pythagoras}{Given $a, b, c$ in \R, $a^2+b^2=c^2$.}

\theorem{Euclid}{There are infinitely many primes.}`}\n`;

test("macro blocks define value, math and \\newcommand macros, with problems listed by line", () => {
  const definitions = parseMacroDefinitions([
    String.raw`\fset = $\mathcal{F}$`,
    String.raw`\energy = $$E = mc^2$$`,
    String.raw`\newcommand{\pair}[2]{(#1, #2)}`,
    String.raw`\newcommand\boxed{Boxed text}`,
    String.raw`\def\twice#1{#1#1}`,
    "% a comment",
    String.raw`\bad[1] = #2`,
    "not a definition",
    String.raw`\newcommand{\multi}[1]{First #1`,
    String.raw`and second}`,
  ].join("\n"));
  assert.deepEqual([...definitions.macros.keys()], ["fset", "energy", "pair", "boxed", "twice", "multi"]);
  assert.deepEqual({ ...definitions.macros.get("fset")!, line: 0 }, { name: "fset", arity: 0, body: String.raw`\mathcal{F}`, math: "inline", line: 0 });
  assert.equal(definitions.macros.get("energy")!.math, "display");
  assert.equal(definitions.macros.get("pair")!.arity, 2);
  assert.equal(definitions.macros.get("twice")!.arity, 1);
  assert.equal(definitions.macros.get("multi")!.body, "First #1\nand second");
  assert.deepEqual(definitions.errors.map((error) => error.line), [7, 8]);
});

test("expansion fills math and text macros, numbers counters and drops the macro block", () => {
  const expansion = expandMarkdownMacros(DOCUMENT)!;
  assert.equal(expansion.markdown.trim(), String.raw`Let $\mathcal{F}$ be a family over $\mathbb{R}^n$ with $\lVert x \rVert \le 1$.

**Theorem 1 (Pythagoras).** *Given $a, b, c$ in $\mathbb{R}$, $a^2+b^2=c^2$.*

**Theorem 2 (Euclid).** *There are infinitely many primes.*`);
  assert.deepEqual(expansion.counters, { theorem: 2 });
  assert.ok(!expansion.markdown.includes("libera-macro"));
});

test("counters need no definition, and code, escapes and unknown commands stay as written", () => {
  const source = String.raw`Figure \counter-figure, figure \counter-figure, table \counter-table. \alpha, \\counter-figure and ${"`"}\counter-figure${"`"}.

${FENCE}latex
\counter-figure
${FENCE}`;
  assert.equal(expandMarkdownMacros(source)!.markdown, String.raw`Figure 1, figure 2, table 1. \alpha, \\counter-figure and ${"`"}\counter-figure${"`"}.

${FENCE}latex
\counter-figure
${FENCE}`);
  assert.equal(expandMarkdownMacros("No macros here."), null);
});

test("a display macro alone on its line becomes a display block, and expansions keep their list or quote", () => {
  const source = `${MACROS}\n\n\\energy\n\n- \\theorem{A}{B}\n\n> \\theorem{Quoted}{With\n> two lines}\n`;
  const expanded = expandMarkdownMacros(source, { mathMarkers: { inlineMathMarkers: "$ $", blockMathMarkers: "$$ $$" } })!.markdown;
  assert.match(expanded, /\n\$\$\nE = mc\^2\n\$\$\n/);
  assert.match(expanded, /- \*\*Theorem 1 \(A\)\.\*\* \*B\*/);
  assert.match(expanded, /> \*\*Theorem 2 \(Quoted\)\.\*\* \*With\n> two lines\*/);
});

test("macros defined in terms of macros expand, and recursion stops", () => {
  const source = `${FENCE}libera-macro\n\\F = $\\mathcal{F}$\n\\FF = $\\F \\times \\F$\n\\loop = \\loop!\n${FENCE}\n\n$\\FF$ and \\loop\n`;
  const expanded = expandMarkdownMacros(source)!.markdown;
  assert.ok(expanded.includes(String.raw`$\mathcal{F} \times \mathcal{F}$ and `));
  assert.ok(expanded.trimEnd().endsWith("\\loop" + "!".repeat(17)));
});

test("the preview renders expansions while keeping source positions of the original", () => {
  const html = renderToStaticMarkup(createElement(MarkdownRenderer, { content: DOCUMENT }));
  assert.ok(html.includes("Theorem 1 (Pythagoras)."));
  assert.ok(html.includes("Theorem 2 (Euclid)."));
  assert.ok(html.includes("𝓕") || html.includes("mathcal"), "\\fset is typeset");
  assert.ok(!html.includes("libera-macro"));
  const paragraph = DOCUMENT.indexOf("\\theorem{Pythagoras}");
  assert.ok(html.includes(`data-source-start="${paragraph}"`), "the theorem paragraph points at its invocation");

  const tree = prepareMarkdownPreview(DOCUMENT);
  const starts: string[] = JSON.stringify(tree).match(/"data-source-start":"\d+"/g) ?? [];
  assert.ok(starts.includes(`"data-source-start":"${DOCUMENT.indexOf("\\theorem{Euclid}")}"`));
});

test("slide scopes share a deck's definitions and continue its counters", () => {
  const parts = [MACROS, "\\theorem{A}{a}", "\\theorem{B}{b}"];
  const scopes = markdownMacroScopes(parts.join("\n\n"), parts);
  assert.deepEqual(scopes.map((scope) => scope.counters), [{}, {}, { theorem: 1 }]);
  assert.ok(expandMarkdownMacros(parts[2], { scope: scopes[2] })!.markdown.includes("Theorem 2 (B)"));
  assert.equal(collectMarkdownMacros(parts.join("\n\n")).macros.size, 6);
});

function mount(content: string) {
  return new Editor({
    extensions: [...createMarkdownExtensions("Notes/a.md"), ...createMathExtensions(), TiptapMarkdownMacros],
    content, contentType: "markdown",
  });
}

test("the Visual editor shows expansions, reveals the source at the caret and saves the macros as written", () => {
  const editor = mount(DOCUMENT);
  try {
    const state = tiptapMacrosKey.getState(editor.state)!;
    assert.deepEqual(state.invocations.map((invocation) => invocation.markdown), [
      String.raw`$\mathcal{F}$`,
      String.raw`**Theorem 1 (Pythagoras).** *Given $a, b, c$ in $\mathbb{R}$, $a^2+b^2=c^2$.*`,
      "**Theorem 2 (Euclid).** *There are infinitely many primes.*",
    ]);
    assert.deepEqual([...state.math.values()], [String.raw`\mathbb{R}^n`, String.raw`\lVert x \rVert \le 1`]);
    const dom = editor.view.dom;
    assert.equal(dom.querySelectorAll(".libera-macro-hidden").length >= 3, true);
    assert.ok([...dom.querySelectorAll(".libera-macro-expansion")].some((element) => element.textContent?.includes("Theorem 1 (Pythagoras).")));
    assert.ok([...dom.querySelectorAll("[data-type=inline-math]")].some((math) => math.getAttribute("data-latex") === String.raw`\R^n` && math.querySelector(".katex")?.textContent?.includes("R")));

    const theorem = state.invocations[1];
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, theorem.from + 2)));
    assert.ok(editor.view.dom.querySelector(".libera-macro-source")?.textContent?.startsWith("\\theorem{Pythagoras}"));

    assert.equal(editor.getMarkdown().trim(), DOCUMENT.trim());
    assert.equal(expandMarkdownMacros(editor.getMarkdown())!.markdown.trim(), expandMarkdownMacros(DOCUMENT)!.markdown.trim());
  } finally {
    editor.destroy();
  }
});

test("the Visual editor writes a backslash before a letter as typed, and still escapes punctuation", () => {
  // `\\fset` and `\fset` are the same text once parsed: a literal macro name belongs in inline code.
  const source = String.raw`Use \fset, \alpha, \* and \_ here, and ${"`"}\fset${"`"}.`;
  const editor = mount(source);
  try {
    assert.equal(editor.state.doc.textContent, String.raw`Use \fset, \alpha, * and _ here, and \fset.`);
    assert.equal(editor.getMarkdown().trim(), source);
  } finally {
    editor.destroy();
  }
});

test("editing a definition updates every use in the Visual editor", () => {
  const editor = mount(DOCUMENT);
  try {
    let block = -1;
    editor.state.doc.descendants((node, pos) => { if (block < 0 && node.type.name === "codeBlock") block = pos; });
    const text = editor.state.doc.nodeAt(block)!.textContent;
    const at = block + 1 + text.indexOf("\\mathbb{R}") + "\\mathbb{".length;
    editor.view.dispatch(editor.state.tr.insertText("Q", at, at + 1));
    assert.ok([...tiptapMacrosKey.getState(editor.state)!.math.values()].includes(String.raw`\mathbb{Q}^n`));
    const rendered = [...editor.view.dom.querySelectorAll("[data-type=inline-math]")].find((math) => math.getAttribute("data-latex") === String.raw`\R^n`);
    assert.ok(rendered?.querySelector(".katex")?.textContent?.includes("Q"), "the formula re-renders with the new definition");
  } finally {
    editor.destroy();
  }
});

test("typing ```libera-macro starts a macro block", () => {
  const editor = mount("");
  try {

    const { view } = editor;
    for (const char of "```libera-macro ") {
      const { from, to } = view.state.selection;
      const handled = view.someProp("handleTextInput", (handle) => handle(view, from, to, char, () => view.state.tr.insertText(char, from, to)));
      if (!handled) view.dispatch(view.state.tr.insertText(char, from, to));
    }
    const block = view.state.doc.firstChild!;
    assert.equal(block.type.name, "codeBlock");
    assert.equal(block.attrs.language, "libera-macro");
  } finally {
    editor.destroy();
  }
});
