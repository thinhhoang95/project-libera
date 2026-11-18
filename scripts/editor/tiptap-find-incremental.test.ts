import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { createMathExtensions } from "../../src/lib/tiptap-math";
import { compileFind, DEFAULT_FIND_OPTIONS, type Finder, type FindOptions } from "../../src/lib/find";
import { TiptapFind, createFindState, tiptapFindPluginKey, tiptapFindWork, updateTiptapFind, type TiptapFindRange, type TiptapFindState } from "../../src/lib/tiptap-find";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "DOMParser", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
after(() => dom.window.close());

function random(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}
const WORDS = ["foo", "bar", "fo", "oo", "baz", "Foo", "foofoo", "x"];
function sampleMarkdown(next: () => number, paragraphs: number) {
  const pick = <T,>(list: T[]) => list[Math.floor(next() * list.length)];
  const words = () => Array.from({ length: 3 + Math.floor(next() * 8) }, () => pick(WORDS)).join(" ");
  return Array.from({ length: paragraphs }, (_, index) => {
    const kind = index % 7;
    if (kind === 0) return `# ${words()}`;
    if (kind === 3) return `- ${words()}\n- ${words()}`;
    if (kind === 5) return `> ${words()}`;
    return words();
  }).join("\n\n");
}
function mount(content: string) {
  return new Editor({ extensions: [...createMarkdownExtensions("Notes/a.md"), ...createMathExtensions(), TiptapFind], content, contentType: "markdown" });
}
function finderFor(query: string, options: Partial<FindOptions> = {}): Finder {
  const compiled = compileFind(query, { ...DEFAULT_FIND_OPTIONS, flavor: "markdown", ...options });
  assert.ok(compiled.ok, query);
  return compiled.finder;
}
const findState = (editor: Editor) => tiptapFindPluginKey.getState(editor.state)!;
const describe = (state: TiptapFindState) => ({
  active: state.activeMatchIndex,
  matches: state.matches,
  decorations: state.decorations.find().map((decoration) => `${decoration.from}-${decoration.to}:${(decoration as unknown as { type: { attrs: { class: string } } }).type.attrs.class}`).sort(),
});
function textPositions(doc: ProseMirrorNode) {
  const positions: number[] = [];
  doc.descendants((node, pos) => { if (node.isTextblock) for (let offset = 0; offset <= node.content.size; offset++) positions.push(pos + 1 + offset); });
  return positions;
}

type RandomCase = { label: string; finder: Finder; math?: boolean; within?: boolean };
const RANDOM_CASES: RandomCase[] = [
  { label: "plain", finder: finderFor("foo") },
  { label: "pattern", finder: finderFor("fo*r", { mode: "pattern" }) },
  { label: "short", finder: finderFor("o") },
  { label: "captures", finder: finderFor("(\\w+) (\\w+)", { mode: "regex" }) },
  { label: "math", finder: finderFor("$*$", { mode: "pattern" }), math: true },
  { label: "inside math", finder: finderFor("x", { scope: "insideMath" }), math: true },
  { label: "in selection", finder: finderFor("foo"), within: true },
];
const MATH = ["$x+foo$", "$fo x$", "\\[\nx^2 bar\n\\]"];

for (const { label, finder, math, within: limited } of RANDOM_CASES) {
  test(`incremental Find equals the full rebuild after random edits (${label})`, () => {
    const next = random(label.length * 7919);
    const source = sampleMarkdown(next, 40);
    const editor = mount(math ? source.split("\n\n").map((block, index) => `${block}\n\n${MATH[index % MATH.length]}`).join("\n\n") : source);
    try {
      const size = editor.state.doc.content.size;
      const within: TiptapFindRange[] | null = limited ? [{ from: Math.floor(size / 4), to: Math.floor(size * 3 / 4) }] : null;
      updateTiptapFind(editor, { finder, within });
      let hits = 0;
      Object.assign(tiptapFindWork, { incremental: 0, fallback: 0 });
      for (let step = 0; step < 400; step++) {
        const before = findState(editor);
        const positions = textPositions(editor.state.doc);
        const pick = () => positions[Math.floor(next() * positions.length)];
        const tr = editor.state.tr;
        const rounds = 1 + Math.floor(next() * 3);
        for (let round = 0; round < rounds; round++) {
          const kind = next();
          const at = Math.min(pick(), tr.doc.content.size - 1);
          const clamp = (position: number) => Math.max(1, Math.min(position, tr.doc.content.size - 1));
          try {
            if (kind < 0.3) tr.insertText(WORDS[Math.floor(next() * WORDS.length)], clamp(at));
            else if (kind < 0.5) tr.delete(clamp(at), clamp(at + 1 + Math.floor(next() * 12)));
            else if (kind < 0.6) tr.delete(clamp(at), clamp(at + 30 + Math.floor(next() * 200)));
            else if (kind < 0.75) tr.split(clamp(at));
            else if (kind < 0.85) tr.replaceWith(clamp(at), clamp(at + 3), editor.schema.text("foo bar foo"));
            else if (kind < 0.92) tr.addMark(clamp(at), clamp(at + 6), editor.schema.marks.bold.create());
            else if (kind < 0.96) {
              const node = tr.doc.nodeAt(clamp(at));
              if (node?.type.name === "inlineMath") tr.setNodeMarkup(clamp(at), undefined, { ...node.attrs, latex: `${node.attrs.latex} x` });
              else tr.insertText("x", clamp(at));
            } else tr.insertText("", clamp(at), clamp(at));
          } catch { /* an edit that does not apply to this document shape */ }
        }
        if (next() < 0.3) tr.setMeta(tiptapFindPluginKey, { activeMatchIndex: Math.floor(next() * 50) });
        const update = tr.getMeta(tiptapFindPluginKey) as { activeMatchIndex?: number } | undefined;
        editor.view.dispatch(tr);
        const after = findState(editor);
        const expected = createFindState(editor.state.doc, finder, update?.activeMatchIndex ?? before.activeMatchIndex, { within: after.within });
        assert.deepEqual(describe(after), describe(expected), `step ${step}`);
        hits += after.matches.length;
      }
      assert.ok(hits > 0);
      assert.ok(tiptapFindWork.incremental > 200, `incremental path ran ${tiptapFindWork.incremental} times`);
      assert.ok(tiptapFindWork.fallback < tiptapFindWork.incremental, "only mark-only edits fall back");
    } finally { editor.destroy(); }
  });
}

test("an edit in one block searches only that block and creates only its decorations", () => {
  const next = random(11);
  const editor = mount(sampleMarkdown(next, 300));
  try {
    const finder = finderFor("foo");
    updateTiptapFind(editor, { finder });
    const total = findState(editor).matches.length;
    assert.ok(total > 100);
    let target = 0;
    editor.state.doc.descendants((node, pos) => { if (!target && node.isTextblock && pos > editor.state.doc.content.size / 2 && node.textContent.includes("foo")) target = pos + 1; });
    Object.assign(tiptapFindWork, { incremental: 0, fallback: 0, blocksVisited: 0, decorationsCreated: 0 });
    editor.view.dispatch(editor.state.tr.insertText("foo ", target));
    assert.deepEqual({ incremental: tiptapFindWork.incremental, fallback: tiptapFindWork.fallback }, { incremental: 1, fallback: 0 });
    assert.ok(tiptapFindWork.blocksVisited <= 2, `visited ${tiptapFindWork.blocksVisited} text blocks`);
    assert.ok(tiptapFindWork.decorationsCreated <= 12, `created ${tiptapFindWork.decorationsCreated} decorations`);
    const full = createFindState(editor.state.doc, finder, 0);
    assert.deepEqual(describe(findState(editor)), describe(full));
    // A full rebuild visits every block and creates every decoration.
    Object.assign(tiptapFindWork, { blocksVisited: 0 });
    createFindState(editor.state.doc, finder);
    assert.ok(tiptapFindWork.blocksVisited > 250);
  } finally { editor.destroy(); }
});
