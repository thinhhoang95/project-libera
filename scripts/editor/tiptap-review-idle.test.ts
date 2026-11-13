import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { TiptapChanges, tiptapChangesKey, type TiptapChangesMeta, type TrackedChange } from "../../src/lib/tiptap-changes";
import { TiptapReview, tiptapReviewChanges } from "../../src/lib/tiptap-review";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "DOMParser", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, key, { value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true });
after(() => dom.window.close());

const source = "# Title\n\nFirst paragraph here.\n\nSecond paragraph here.";
function mount() {
  return new Editor({ extensions: [...createMarkdownExtensions("Notes/a.md"), TiptapReview, TiptapChanges.configure({ documentPath: "Notes/a.md" })], content: source, contentType: "markdown" });
}
const state = (editor: Editor) => tiptapChangesKey.getState(editor.state)!;
const preview = (editor: Editor, changes: TrackedChange[], decide = () => {}) =>
  editor.view.dispatch(editor.state.tr.setMeta(tiptapChangesKey, { type: "preview", changes, decide } satisfies TiptapChangesMeta));
const firstEdit = () => { const start = source.indexOf("First"); return { start, end: start + 5, before: "First", after: "Third" }; };

test("tiptapReviewChanges with no suggestions returns [] without parsing the note", () => {
  const editor = mount();
  try {
    const parse = editor.markdown!.parse;
    let calls = 0;
    editor.markdown!.parse = ((...args: Parameters<typeof parse>) => { calls++; return parse.apply(editor.markdown, args); }) as typeof parse;
    assert.deepEqual(tiptapReviewChanges(editor, source, []), []);
    assert.equal(calls, 0);
  } finally { editor.destroy(); }
});

test("tiptapReviewChanges still previews a pending suggestion", () => {
  const editor = mount();
  try {
    const changes = tiptapReviewChanges(editor, source, [{ id: "s1", label: "Change 1", edits: [firstEdit()] }]);
    assert.equal(changes.length, 1);
    const [change] = changes;
    assert.equal(change.group, "s1");
    assert.equal(change.mode, "preview");
    assert.equal(change.label, "Change 1");
    assert.equal(change.block, false);
    assert.equal(change.showActions, true);
    assert.equal(editor.state.doc.textBetween(change.from, change.to), "First");
    assert.equal(change.other!.textBetween(0, change.other!.size), "Third");
  } finally { editor.destroy(); }
});

test("an empty preview onto a state without previews keeps the changes identity, and still clears real previews", () => {
  const editor = mount();
  try {
    const initial = state(editor).changes;
    const decide = () => {};
    preview(editor, [], decide);
    assert.equal(state(editor).changes, initial);
    assert.equal(state(editor).decide, decide);
    const next = () => {};
    preview(editor, [], next);
    assert.equal(state(editor).changes, initial);
    assert.equal(state(editor).decide, next);

    const changes = tiptapReviewChanges(editor, source, [{ id: "s1", label: "Change 1", edits: [firstEdit()] }]);
    preview(editor, changes, decide);
    assert.equal(state(editor).changes.length, 1);
    assert.ok(state(editor).decorations.find().length > 0);
    preview(editor, [], decide);
    assert.equal(state(editor).changes.length, 0);
    assert.equal(state(editor).decorations.find().length, 0);
  } finally { editor.destroy(); }
});
