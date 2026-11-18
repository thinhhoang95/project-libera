import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { Editor, type JSONContent } from "@tiptap/core";
import { undoDepth } from "@tiptap/pm/history";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { createMathExtensions } from "../../src/lib/tiptap-math";
import type { MathMarkerSettings } from "../../src/lib/math-markers";
import { compileFind, compileFindReplacement, DEFAULT_FIND_OPTIONS, type Finder, type FindOptions, type Replacer } from "../../src/lib/find";
import { findTiptapTextMatches, TiptapFind, tiptapFindPluginKey, updateTiptapFind, type TiptapFindMatch, type TiptapFindRange } from "../../src/lib/tiptap-find";
import { replaceAllTiptapFindInTransaction, replaceTiptapFindMatches, type TiptapReplaceResult } from "../../src/lib/tiptap-find-replace";

/* Find & replace in the rich editor: readings of math atoms, captures,
 * the three replacement paths, scopes and In selection
 * (docs/find-replace-patterns-plan.md §10). */

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "DOMParser", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
after(() => dom.window.close());

// `\( \)` first, so inline math reads as `\(…\)`.
const PARENS: MathMarkerSettings = { inlineMathMarkers: "\\( \\)\n$ $", blockMathMarkers: "\\[ \\]\n$$ $$" };

function mount(content: string, mathMarkers: MathMarkerSettings = PARENS) {
  return new Editor({
    extensions: [...createMarkdownExtensions("Notes/find.md"), ...createMathExtensions(mathMarkers), TiptapFind.configure({ mathMarkers })],
    content,
    contentType: "markdown",
  });
}

function finderFor(query: string, options: Partial<FindOptions> = {}): Finder {
  const compiled = compileFind(query, { ...DEFAULT_FIND_OPTIONS, flavor: "markdown", ...options });
  assert.ok(compiled.ok, `${query}: ${JSON.stringify(!compiled.ok && compiled.error)}`);
  return compiled.finder;
}

function replacerFor(finder: Finder, replacement: string): Replacer {
  const compiled = compileFindReplacement(finder, replacement, false);
  assert.ok(compiled.ok, replacement);
  return compiled.replacer;
}

function search(editor: Editor, finder: Finder, within: TiptapFindRange[] | null = null): TiptapFindMatch[] {
  updateTiptapFind(editor, { finder, within, activeMatchIndex: 0 });
  return tiptapFindPluginKey.getState(editor.state)!.matches;
}

function replaceAll(editor: Editor, finder: Finder, replacement: string, markdown = false): TiptapReplaceResult {
  const matches = search(editor, finder);
  return replaceTiptapFindMatches(editor, matches, { replacer: replacerFor(finder, replacement), markdown });
}

const textOf = (editor: Editor, from: number, to: number) => editor.state.doc.textBetween(from, to, "\n", "\n");
const blocks = (editor: Editor): JSONContent[] => editor.getJSON().content ?? [];

test("matches carry their captures in document positions", () => {
  const editor = mount("Swap (alpha,beta) and (c,d).");
  try {
    const matches = search(editor, finderFor("(*,*)", { mode: "pattern" }));
    assert.equal(matches.length, 2);
    const captured = matches.map((match) => match.captures.map((capture) => textOf(editor, capture.from, capture.to)));
    assert.deepEqual(captured, [["alpha", "beta"], ["c", "d"]]);
    assert.deepEqual(matches.map((match) => textOf(editor, match.from, match.to)), ["(alpha,beta)", "(c,d)"]);
    assert.deepEqual(findTiptapTextMatches(editor.state.doc, finderFor("(*,*)", { mode: "pattern" }), { reading: tiptapFindPluginKey.getState(editor.state)!.reading }), matches);
  } finally { editor.destroy(); }
});

test("inline math reads with its markers, display math with the display markers", () => {
  const parens = mount("A \\(4x+3\\) b\n\n\\[\ny^2\n\\]");
  const dollars = mount("A $4x+3$ b", {});
  try {
    assert.equal(search(parens, finderFor("\\(4x+3\\)")).length, 1);
    assert.equal(search(parens, finderFor("\\[y^2\\]")).length, 1);
    assert.equal(search(dollars, finderFor("$4x+3$")).length, 1);
    assert.equal(search(dollars, finderFor("\\(4x+3\\)")).length, 0);
    // A match may not cut through an atom's delimiters.
    assert.equal(search(parens, finderFor("\\(4x")).length, 0);
    assert.equal(search(parens, finderFor("+3\\) b")).length, 0);
    assert.equal(search(parens, finderFor("A \\(4x+3\\) b")).length, 1);
    // The reading is the find plugin's: copying the text is unchanged.
    assert.equal(parens.state.doc.textBetween(0, parens.state.doc.content.size, "\n").includes("4x+3"), false);
  } finally { parens.destroy(); dollars.destroy(); }
});

test("math reads with the delimiters it was written with, whatever the settings prefer", () => {
  // Default settings prefer `$`, but a formula typed as `\(…\)` is found (and replaced) as typed.
  const editor = mount("Let \\(4x+3,3y\\) be", {});
  try {
    assert.equal(search(editor, finderFor("$4x+3,3y$")).length, 0);
    const result = replaceAll(editor, finderFor("\\(*,*\\)", { mode: "pattern" }), "\\(@2,@1\\)");
    assert.equal(result.replaced, 1);
    const inline = blocks(editor).flatMap((block) => block.content ?? []).filter((node) => node.type === "inlineMath");
    assert.deepEqual(inline.map((node) => node.attrs?.latex), ["3y,4x+3"]);
  } finally { editor.destroy(); }
});

test("a match inside an atom decorates the atom", () => {
  const editor = mount("Words \\(x+x\\) and x");
  try {
    const matches = search(editor, finderFor("x"));
    assert.equal(matches.length, 3);
    assert.deepEqual(matches.map((match) => match.insideMath), [true, true, false]);
    assert.equal(matches[0].from, matches[1].from);
    const atom = editor.view.dom.querySelector("[data-type='inline-math']")!;
    assert.ok(atom.classList.contains("markdown-editor-find-match-active"));
    assert.equal(editor.view.dom.querySelectorAll("span.markdown-editor-find-match:not([data-type])").length, 1);
  } finally { editor.destroy(); }
});

test("\\(*\\) → \\[@1\\] turns inline math into display math", () => {
  const editor = mount("Before \\(4x+3\\) after");
  try {
    const result = replaceAll(editor, finderFor("\\(*\\)", { mode: "pattern" }), "\\[@1\\]");
    assert.deepEqual({ replaced: result.replaced, skipped: result.skipped }, { replaced: 1, skipped: 0 });
    const types = blocks(editor).map((block) => block.type);
    assert.deepEqual(types, ["paragraph", "blockMath", "paragraph"]);
    assert.equal(blocks(editor)[1].attrs?.latex, "4x+3");
    // And back: display math to inline.
    replaceAll(editor, finderFor("\\[*\\]", { mode: "pattern" }), "\\(@1\\)");
    const inline = blocks(editor).flatMap((block) => block.content ?? []).filter((node) => node.type === "inlineMath");
    assert.deepEqual(inline.map((node) => node.attrs?.latex), ["4x+3"]);
  } finally { editor.destroy(); }
});

test("a match inside math rewrites the atom's LaTeX and leaves prose alone", () => {
  const editor = mount("Prose \\alpha and \\(\\alpha + \\alpha_1\\)\n\n\\[\n\\alpha^2\n\\]");
  try {
    const result = replaceAll(editor, finderFor("\\alpha", { scope: "insideMath" }), "\\beta");
    assert.equal(result.replaced, 3);
    const [paragraph, display] = blocks(editor);
    const inline = (paragraph.content ?? []).find((node) => node.type === "inlineMath");
    assert.equal(inline?.attrs?.latex, "\\beta + \\beta_1");
    assert.equal(display.attrs?.latex, "\\beta^2");
    assert.ok(editor.state.doc.textContent.startsWith("Prose \\alpha"));
    // Anywhere also reaches inside math, through the same attribute rewrite.
    replaceAll(editor, finderFor("\\beta"), "\\gamma");
    assert.equal(blocks(editor)[1].attrs?.latex, "\\gamma^2");
  } finally { editor.destroy(); }
});

test("swapping captures keeps each part's formatting", () => {
  const editor = mount("**bold**, plain");
  try {
    replaceAll(editor, finderFor("(\\w+), (\\w+)", { mode: "regex" }), "@2, @1");
    const nodes = blocks(editor)[0].content ?? [];
    assert.equal(nodes.map((node) => node.text).join(""), "plain, bold");
    const plain = nodes.find((node) => node.text === "plain");
    const bold = nodes.find((node) => node.text?.endsWith("bold"));
    assert.equal(plain?.marks, undefined, "a capture keeps its own (absent) marks");
    assert.deepEqual(bold?.marks?.map((mark) => mark.type), ["bold"]);
  } finally { editor.destroy(); }
});

test("Replacement is Markdown parses the replacement; otherwise it is literal", () => {
  const editor = mount("make key strong");
  try {
    const finder = finderFor("key", { mode: "pattern" });
    replaceAll(editor, finder, "**@0**", true);
    const nodes = blocks(editor)[0].content ?? [];
    assert.deepEqual(nodes.find((node) => node.text === "key")?.marks?.map((mark) => mark.type), ["bold"]);
    editor.commands.undo();
    replaceAll(editor, finder, "**@0**");
    assert.equal(editor.state.doc.textContent, "make **key** strong");
  } finally { editor.destroy(); }
});

test("Replace All is one undo step and numbers matches with @#", () => {
  const original = "TODO one\n\nTODO two **TODO** three";
  const editor = mount(original);
  try {
    const before = undoDepth(editor.state);
    const result = replaceAll(editor, finderFor("TODO", { mode: "pattern", matchCase: true }), "TODO-@#");
    assert.equal(result.replaced, 3);
    assert.equal(editor.getMarkdown(), "TODO-1 one\n\nTODO-2 two **TODO-3** three");
    assert.equal(undoDepth(editor.state), before + 1);
    editor.commands.undo();
    assert.equal(editor.getMarkdown(), original);
  } finally { editor.destroy(); }
});

test("single replace uses the active match's number", () => {
  const editor = mount("TODO TODO TODO");
  try {
    const finder = finderFor("TODO", { mode: "pattern", matchCase: true });
    const matches = search(editor, finder);
    replaceTiptapFindMatches(editor, [matches[1]], { replacer: replacerFor(finder, "TODO-@#"), firstCounter: 2 });
    assert.equal(editor.state.doc.textContent, "TODO TODO-2 TODO");
  } finally { editor.destroy(); }
});

test("matches whose replacement fails are skipped and counted", () => {
  const editor = mount("3 apples");
  try {
    const result = replaceAll(editor, finderFor("@x:word", { mode: "pattern" }), "@(x*2)");
    assert.deepEqual({ replaced: result.replaced, skipped: result.skipped }, { replaced: 1, skipped: 1 });
    assert.equal(editor.state.doc.textContent, "6 apples");
  } finally { editor.destroy(); }
});

test("Where scopes: outside math, inside math, skip code", () => {
  const editor = mount("x and \\(x+1\\) and \\\\(x\\\\)\n\nfoo `foo` foo\n\n```\nfoo\n```");
  try {
    const outside = search(editor, finderFor("x", { scope: "outsideMath" }));
    assert.deepEqual(outside.map((match) => match.insideMath), [false]);
    // Literal delimiters typed as text count as math too.
    const inside = search(editor, finderFor("x", { scope: "insideMath" }));
    assert.equal(inside.length, 2);
    // Outside math still finds whole formulas.
    assert.equal(search(editor, finderFor("\\(*\\)", { mode: "pattern", scope: "outsideMath" })).length, 2);
    assert.equal(search(editor, finderFor("foo")).length, 4);
    const clear = search(editor, finderFor("foo", { scope: "skipCommentsAndCode" }));
    assert.deepEqual(clear.map((match) => textOf(editor, match.from, match.to)), ["foo", "foo"]);
    assert.ok(clear.every((match) => !editor.state.doc.rangeHasMark(match.from, match.to, editor.schema.marks.code)));
  } finally { editor.destroy(); }
});

test("In selection limits matches to the selection, mapped through edits", () => {
  const editor = mount("foo one\n\nfoo two foo\n\nfoo three");
  try {
    const finder = finderFor("foo");
    assert.equal(search(editor, finder).length, 4);
    let second = 0;
    editor.state.doc.forEach((node, offset) => { if (node.textContent.includes("two")) second = offset; });
    const size = editor.state.doc.child(1).nodeSize;
    const within: TiptapFindRange[] = [{ from: second + 1, to: second + size - 1 }];
    const limited = search(editor, finder, within);
    assert.equal(limited.length, 2);
    // Part of a block: only the matches inside the selected part.
    assert.equal(search(editor, finder, [{ from: second + 1, to: second + 8 }]).length, 1);
    updateTiptapFind(editor, { within });
    editor.view.dispatch(editor.state.tr.insertText("foo ", 1));
    const state = tiptapFindPluginKey.getState(editor.state)!;
    assert.equal(state.matches.length, 2);
    assert.deepEqual(state.within, [{ from: second + 5, to: second + size + 3 }]);
    const result = replaceTiptapFindMatches(editor, state.matches, { replacer: replacerFor(finder, "bar") });
    assert.equal(result.replaced, 2);
    assert.equal(editor.getMarkdown(), "foo foo one\n\nbar two bar\n\nfoo three");
  } finally { editor.destroy(); }
});

test("several find/replace pairs can run in one transaction", () => {
  const editor = mount("a \\(x\\) b");
  try {
    const tr = editor.state.tr;
    const first = finderFor("\\(*\\)", { mode: "pattern" });
    replaceAllTiptapFindInTransaction(editor, tr, first, { replacer: replacerFor(first, "\\(@1+1\\)") });
    const second = finderFor("x", { scope: "insideMath" });
    replaceAllTiptapFindInTransaction(editor, tr, second, { replacer: replacerFor(second, "y") });
    editor.view.dispatch(tr);
    const inline = (blocks(editor)[0].content ?? []).find((node) => node.type === "inlineMath");
    assert.equal(inline?.attrs?.latex, "y+1");
  } finally { editor.destroy(); }
});
