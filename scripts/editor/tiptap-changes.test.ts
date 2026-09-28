import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { TiptapChanges, decideTiptapChanges, diffDocuments, tiptapChangeUnits, tiptapChangesKey, type ChangeDecision } from "../../src/lib/tiptap-changes";
import { replaceTiptapRangeWithMarkdown } from "../../src/lib/tiptap-editor-actions";
import { tiptapReviewChanges } from "../../src/lib/tiptap-review";
import { createMathExtensions } from "../../src/lib/tiptap-math";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "DOMParser", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
after(() => dom.window.close());

function mount(content: string) {
  return new Editor({ extensions: [...createMarkdownExtensions("Notes/a.md"), ...createMathExtensions(), TiptapChanges.configure({ documentPath: "Notes/a.md" })], content, contentType: "markdown" });
}
const changesOf = (editor: Editor) => tiptapChangesKey.getState(editor.state)!.changes;
const textRange = (editor: Editor, text: string) => {
  let found: { from: number; to: number } | undefined;
  editor.state.doc.descendants((node, pos) => {
    const index = node.isText ? node.text!.indexOf(text) : -1;
    if (!found && index >= 0) found = { from: pos + index, to: pos + index + text.length };
  });
  return found!;
};
const docRange = (editor: Editor) => ({ from: 0, to: editor.state.doc.content.size });

test("word-level diff inside a paired paragraph yields readable inline hunks", () => {
  const editor = mount("Keep this. The quick brown fox jumps.\n\nUntouched paragraph.");
  try {
    const before = editor.state.doc;
    replaceTiptapRangeWithMarkdown(editor, textRange(editor, "quick brown"), "slow red");
    const hunks = diffDocuments(before, editor.state.doc);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].block, false);
    assert.equal(hunks[0].aContent.textBetween(0, hunks[0].aContent.size), "quick brown");
    assert.equal(hunks[0].bContent.textBetween(0, hunks[0].bContent.size), "slow red");
  } finally { editor.destroy(); }
});

test("tracked AI replacement shows proposal and original, and rejecting restores the exact original", () => {
  const source = "# Title\n\nThe quick brown fox jumps over the lazy dog.\n\nSecond paragraph stays.";
  const editor = mount(source);
  try {
    const original = editor.getMarkdown();
    replaceTiptapRangeWithMarkdown(editor, textRange(editor, "quick brown fox"), "swift **red** fox", "rewrite");
    assert.ok(editor.getMarkdown().includes("swift **red** fox"), "proposal is applied to the document");
    const changes = changesOf(editor);
    assert.ok(changes.length >= 1 && changes.every((change) => change.mode === "applied" && change.source === "rewrite"));
    assert.ok(editor.view.dom.querySelector(".libera-change-inserted"), "proposed text is highlighted");
    assert.match(editor.view.dom.querySelector(".libera-change-deleted")?.textContent ?? "", /quick/);
    assert.ok(editor.view.dom.querySelector(".libera-change-actions button[data-decision='accept']"));
    assert.equal(editor.getMarkdown().includes("quick"), false, "original widgets are not serialized");

    assert.equal(decideTiptapChanges(editor.view, "all", "reject"), true);
    assert.equal(editor.getMarkdown(), original);
    assert.deepEqual(changesOf(editor), []);
    assert.equal(editor.view.dom.querySelector(".libera-change"), null);
  } finally { editor.destroy(); }
});

test("individual hunks can be accepted or rejected independently", () => {
  const editor = mount("Alpha one stays here.\n\nMiddle paragraph is unchanged and fairly long.\n\nOmega two stays here.");
  try {
    replaceTiptapRangeWithMarkdown(editor, docRange(editor), "Alpha uno stays here.\n\nMiddle paragraph is unchanged and fairly long.\n\nOmega dos stays here.", "format");
    const units = tiptapChangeUnits(changesOf(editor));
    assert.equal(units.length, 2);
    decideTiptapChanges(editor.view, units[0].ids, "accept");
    decideTiptapChanges(editor.view, units[1].ids, "reject");
    assert.equal(editor.getMarkdown(), "Alpha uno stays here.\n\nMiddle paragraph is unchanged and fairly long.\n\nOmega two stays here.");
    assert.deepEqual(changesOf(editor), []);
  } finally { editor.destroy(); }
});

test("structural changes become block hunks and reject all restores them", () => {
  const source = "Intro stays.\n\nFirst item, second item, third item.\n\nOutro stays.";
  const editor = mount(source);
  try {
    const original = editor.getMarkdown();
    const range = textRange(editor, "First item, second item, third item.");
    replaceTiptapRangeWithMarkdown(editor, { from: range.from - 1, to: range.to + 1 }, "- First item\n- Second item\n- Third item", "format");
    const [change] = changesOf(editor);
    assert.equal(changesOf(editor).length, 1);
    assert.equal(change.block, true);
    assert.ok(editor.view.dom.querySelector("ul.libera-change-inserted-block"));
    assert.ok(editor.view.dom.querySelector("p.libera-change-deleted-block"));
    decideTiptapChanges(editor.view, "all", "reject");
    assert.equal(editor.getMarkdown(), original);
  } finally { editor.destroy(); }
});

test("editing inside a proposal settles it while unrelated edits keep other hunks anchored", () => {
  const editor = mount("Alpha one stays here.\n\nMiddle paragraph is unchanged and fairly long.\n\nOmega two stays here.");
  try {
    replaceTiptapRangeWithMarkdown(editor, docRange(editor), "Alpha uno stays here.\n\nMiddle paragraph is unchanged and fairly long.\n\nOmega dos stays here.", "rewrite");
    assert.equal(changesOf(editor).length, 2);
    editor.commands.insertContentAt(textRange(editor, "Middle").from, "The ");
    assert.equal(changesOf(editor).length, 2, "typing elsewhere keeps both changes");
    const uno = textRange(editor, "uno");
    editor.commands.insertContentAt(uno.from + 1, "X");
    assert.equal(changesOf(editor).length, 1, "typing inside a proposal accepts it");
    decideTiptapChanges(editor.view, "all", "reject");
    assert.equal(editor.getMarkdown(), "Alpha uXno stays here.\n\nThe Middle paragraph is unchanged and fairly long.\n\nOmega two stays here.");
  } finally { editor.destroy(); }
});

test("undoing a tracked replacement clears its indicators", () => {
  const editor = mount("One two three four five.");
  try {
    replaceTiptapRangeWithMarkdown(editor, textRange(editor, "two three"), "2 3", "rewrite");
    assert.ok(changesOf(editor).length);
    editor.commands.undo();
    assert.equal(editor.getMarkdown(), "One two three four five.");
    assert.deepEqual(changesOf(editor), []);
  } finally { editor.destroy(); }
});

test("agentic review suggestions preview inline without editing, and decisions go to the review", () => {
  const source = "# Title\n\nThe quick brown fox jumps over the lazy dog.\n\nA second paragraph.";
  const editor = mount(source);
  try {
    const start = source.indexOf("quick brown");
    const decisions: [string[], ChangeDecision][] = [];
    const changes = tiptapReviewChanges(editor, source, [
      { id: "s1", label: "Change 1", edits: [{ start, end: start + "quick brown".length, before: "quick brown", after: "slow grey" }] },
      { id: "s2", label: "Change 2", edits: [{ start: source.indexOf("A second"), end: source.length, before: "A second paragraph.", after: "- A list\n- instead" }] },
    ]);
    assert.ok(changes.length >= 2 && changes.every((change) => change.mode === "preview"));
    editor.view.dispatch(editor.state.tr.setMeta(tiptapChangesKey, { type: "preview", changes, decide: (ids: string[], decision: ChangeDecision) => decisions.push([ids, decision]) }));
    assert.equal(editor.getMarkdown(), source, "previews never change the document");
    assert.match(editor.view.dom.querySelector(".libera-change-deleted")?.textContent ?? "", /quick brown/);
    assert.match(editor.view.dom.querySelector(".libera-change-inserted")?.textContent ?? "", /slow grey/);
    assert.ok(editor.view.dom.querySelector("p.libera-change-deleted-block"));
    assert.ok(editor.view.dom.querySelector("ul.libera-change-inserted-block"));
    assert.deepEqual([...editor.view.dom.querySelectorAll(".libera-change-actions-label")].map((label) => label.textContent), ["Change 1", "Change 2"]);

    const s1 = changes.filter((change) => change.group === "s1").map((change) => change.id);
    decideTiptapChanges(editor.view, s1, "accept");
    decideTiptapChanges(editor.view, "all", "reject");
    assert.deepEqual(decisions, [[["s1"], "accept"], [["s1", "s2"], "reject"]]);
    assert.equal(editor.getMarkdown(), source);
  } finally { editor.destroy(); }
});

test("preview and applied changes coexist, and accept all settles both kinds", () => {
  const source = "First paragraph here.\n\nSecond paragraph here.";
  const editor = mount(source);
  try {
    const start = source.indexOf("Second");
    const decisions: string[][] = [];
    const changes = tiptapReviewChanges(editor, source, [{ id: "s1", label: "Change 1", edits: [{ start, end: start + 6, before: "Second", after: "Final" }] }]);
    editor.view.dispatch(editor.state.tr.setMeta(tiptapChangesKey, { type: "preview", changes, decide: (ids: string[]) => decisions.push(ids) }));
    replaceTiptapRangeWithMarkdown(editor, textRange(editor, "First"), "Opening", "rewrite");
    assert.deepEqual(new Set(changesOf(editor).map((change) => change.mode)), new Set(["applied", "preview"]));
    assert.equal(tiptapChangeUnits(changesOf(editor)).length, 2);
    decideTiptapChanges(editor.view, "all", "accept");
    assert.deepEqual(decisions, [["s1"]]);
    assert.ok(editor.getMarkdown().startsWith("Opening paragraph here."));
    assert.equal(changesOf(editor).filter((change) => change.mode === "applied").length, 0);
  } finally { editor.destroy(); }
});
