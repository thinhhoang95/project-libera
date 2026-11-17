import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { DecorationSet } from "@tiptap/pm/view";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { TiptapChanges, changeDecorationWork, changeDecorationsFull, tiptapChangesKey, type TiptapChangesMeta, type TrackedChange } from "../../src/lib/tiptap-changes";
import { replaceTiptapRangeWithMarkdown } from "../../src/lib/tiptap-editor-actions";
import { createMathExtensions } from "../../src/lib/tiptap-math";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "DOMParser", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
after(() => dom.window.close());

const PATH = "Notes/a.md";
function mount(content: string) {
  return new Editor({ extensions: [...createMarkdownExtensions(PATH), ...createMathExtensions(), TiptapChanges.configure({ documentPath: PATH })], content, contentType: "markdown" });
}
function random(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}
const stateOf = (editor: Editor) => tiptapChangesKey.getState(editor.state)!;
const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
function document(paragraphs: number) {
  return Array.from({ length: paragraphs }, (_, index) => `Paragraph ${index} ${WORDS[index % WORDS.length]} ${WORDS[(index * 3) % WORDS.length]} text here.`).join("\n\n");
}
function textRange(editor: Editor, text: string) {
  let found: { from: number; to: number } | undefined;
  editor.state.doc.descendants((node, pos) => {
    const index = node.isText ? node.text!.indexOf(text) : -1;
    if (!found && index >= 0) found = { from: pos + index, to: pos + index + text.length };
  });
  return found!;
}
// Everything a decoration shows: its range and the type's attributes or widget key/side.
function describe(set: DecorationSet) {
  return set.find().map((decoration) => {
    const type = decoration.type as unknown as { attrs?: unknown; spec?: { key?: string; side?: number } };
    return { from: decoration.from, to: decoration.to, attrs: type.attrs ?? null, key: decoration.spec?.key ?? null, side: decoration.spec?.side ?? null };
  });
}
function assertMatchesFullRebuild(editor: Editor, label: string) {
  const state = stateOf(editor);
  const full = changeDecorationsFull(editor.state.doc, state.changes, PATH);
  assert.deepEqual(describe(state.decorations), describe(full), label);
  assert.ok(state.decorations.eq(full), `${label}: set structure`);
}
function previews(doc: ProseMirrorNode, next: () => number, channel?: string) {
  const out: TrackedChange[] = [];
  const blocks: { pos: number; size: number }[] = [];
  doc.forEach((node, offset) => blocks.push({ pos: offset, size: node.nodeSize }));
  for (let index = 0; index < 4; index++) {
    const target = blocks[Math.floor(next() * blocks.length)];
    const block = next() < 0.4;
    const from = block ? target.pos : target.pos + 2, to = block ? target.pos + target.size : target.pos + 2 + Math.floor(next() * 4);
    if (to > doc.content.size) continue;
    out.push({
      id: `preview-${channel ?? "main"}-${index}-${Math.floor(next() * 1e6)}`, group: `g${index % 2}`, source: "review", mode: "preview", block,
      from, to, other: doc.slice(from, Math.min(to, from + 5)).content, showActions: next() < 0.8,
      ...(next() < 0.5 ? { author: { name: "Ada", color: "#aabbcc" } } : {}), ...(next() < 0.3 ? { label: "Suggestion" } : {}),
    });
  }
  return out;
}

test("tracked-change decorations equal the full rebuild after random edits", () => {
  const next = random(2024);
  const editor = mount(document(60));
  try {
    // A mix of inline and block hunks, plus previews on two channels.
    for (let index = 0; index < 10; index++) {
      const range = textRange(editor, `Paragraph ${index * 5 + 2} `); if (!range) console.log("MISSING", index, editor.getText().slice(0, 300));
      replaceTiptapRangeWithMarkdown(editor, range, index % 3 === 0 ? "- one\n- two\n\n" : `rewritten ${index} `, "rewrite");
    }
    editor.view.dispatch(editor.state.tr.setMeta(tiptapChangesKey, { type: "preview", changes: previews(editor.state.doc, next), decide: () => {} } satisfies TiptapChangesMeta));
    editor.view.dispatch(editor.state.tr.setMeta(tiptapChangesKey, { type: "preview", changes: previews(editor.state.doc, next, "other"), channel: "other", decide: () => {} } satisfies TiptapChangesMeta));
    assert.ok(stateOf(editor).changes.length >= 10);
    assertMatchesFullRebuild(editor, "initial");
    let built = 0;
    for (let step = 0; step < 300; step++) {
      const doc = editor.state.doc;
      const textblocks: number[] = [];
      doc.descendants((node, pos) => { if (node.isTextblock) for (let offset = 0; offset <= node.content.size; offset++) textblocks.push(pos + 1 + offset); });
      const pick = () => textblocks[Math.floor(next() * textblocks.length)];
      const tr = editor.state.tr;
      const clamp = (position: number) => Math.max(1, Math.min(position, tr.doc.content.size - 1));
      const at = pick(), kind = next();
      try {
        if (kind < 0.4) tr.insertText("zz", at);
        else if (kind < 0.55) tr.delete(clamp(at), clamp(at + 1 + Math.floor(next() * 6)));
        else if (kind < 0.65) tr.delete(clamp(at), clamp(at + 40 + Math.floor(next() * 400)));
        else if (kind < 0.8) tr.split(clamp(at));
        else if (kind < 0.9) tr.addMark(clamp(at), clamp(at + 5), editor.schema.marks.bold.create());
        else if (kind < 0.95) tr.setMeta(tiptapChangesKey, { type: "preview", changes: previews(tr.doc, next), decide: () => {} } satisfies TiptapChangesMeta);
        else if (stateOf(editor).changes.length) tr.setMeta(tiptapChangesKey, { type: "resolve", ids: [stateOf(editor).changes[Math.floor(next() * stateOf(editor).changes.length)].id] } satisfies TiptapChangesMeta);
      } catch { /* an edit that does not apply to this document shape */ }
      if (tr.docChanged && next() < 0.3) {
        try { tr.insertText("yy", clamp(pick())); } catch { /* keep the single step */ }
      }
      const before = changeDecorationWork.built;
      editor.view.dispatch(tr);
      built += changeDecorationWork.built - before;
      assertMatchesFullRebuild(editor, `step ${step}`);
      if (!stateOf(editor).changes.length) {
        let range: { from: number; to: number } | undefined;
        editor.state.doc.descendants((node, pos) => { if (!range && node.isTextblock && node.content.size > 3) range = { from: pos + 1, to: pos + 3 }; });
        if (range) replaceTiptapRangeWithMarkdown(editor, range, "again", "rewrite");
      }
    }
    assert.ok(built > 0);
  } finally { editor.destroy(); }
});

test("an edit in one block rebuilds no hunk elsewhere", () => {
  const editor = mount(document(120));
  try {
    for (let index = 0; index < 20; index++) {
      replaceTiptapRangeWithMarkdown(editor, textRange(editor, `Paragraph ${index * 5 + 10} `), index % 4 === 0 ? "- one\n- two\n\n" : `rewritten ${index} `, "rewrite");
    }
    const hunks = stateOf(editor).changes.length;
    assert.ok(hunks >= 20);
    const measure = (run: () => void) => {
      Object.assign(changeDecorationWork, { built: 0, shifted: 0 });
      run();
      return { ...changeDecorationWork };
    };
    // Typing after the last hunk moves nothing.
    const last = textRange(editor, "Paragraph 119 ");
    assert.deepEqual(measure(() => editor.view.dispatch(editor.state.tr.insertText("x", last.to + 3))), { built: 0, shifted: 0 });
    // Typing between hunks moves the later ones but rebuilds none of them.
    const middle = textRange(editor, "Paragraph 63 ");
    const moved = measure(() => editor.view.dispatch(editor.state.tr.insertText("x", middle.to + 3)));
    assert.equal(moved.built, 0);
    assert.ok(moved.shifted > 0 && moved.shifted < hunks, `${moved.shifted} of ${hunks} hunks shifted`);
    // Typing inside a hunk settles that hunk only; nothing else is rebuilt.
    const target = stateOf(editor).changes.find((change) => !change.block && change.from < change.to && change.from > 100)!;
    const settled = measure(() => editor.view.dispatch(editor.state.tr.insertText("x", target.from + 1)));
    assert.equal(settled.built, 0);
    assert.equal(stateOf(editor).changes.length, hunks - 1);
    assertMatchesFullRebuild(editor, "after the counted edits");
    // New previews are built; the hunks already shown are not.
    const rebuilt = measure(() => editor.view.dispatch(editor.state.tr.setMeta(tiptapChangesKey, { type: "preview", changes: previews(editor.state.doc, random(5)), decide: () => {} } satisfies TiptapChangesMeta)));
    assert.ok(rebuilt.built >= 1 && rebuilt.built <= 4, `built ${rebuilt.built}`);
  } finally { editor.destroy(); }
});
