import { dom } from "./edlib-dom";
import "../editor/setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { createMathExtensions } from "../../src/lib/tiptap-math";
import { TiptapChanges, decideTiptapChanges, tiptapChangeUnits, tiptapChangesKey } from "../../src/lib/tiptap-changes";
import { createSuggestion, listSuggestions, resolveSuggestions } from "../../src/lib/collab/suggestions/model";
import { overlaySuggestionsToTrackedChanges, suggestionEdit, tiptapSuggestionPreview } from "../../src/lib/collab/suggestions/tiptap";
import type { Actor, SuggestionRecord } from "../../src/lib/collab/protocol";

after(() => dom.window.close());

const people: Record<string, { name: string; color: string }> = { alice: { name: "Alice", color: "#3366ff" }, bob: { name: "Bob", color: "#22aa66" } };
const author = (record: SuggestionRecord) => people[record.createdBy];
const alice: Actor = { kind: "user", userId: "alice" };
const bob: Actor = { kind: "user", userId: "bob" };
const aiForBob: Actor = { kind: "ai", onBehalfOf: "bob", feature: "agentic-review", model: "m" };

function mount(content: string) {
  return new Editor({ extensions: [...createMarkdownExtensions("Notes/a.md"), ...createMathExtensions(), TiptapChanges.configure({ documentPath: "Notes/a.md" })], content, contentType: "markdown" });
}

test("overlay suggestions become preview TrackedChanges carrying their authors", () => {
  const source = "# Title\n\nThe quick brown fox jumps.\n\nSecond paragraph here.\n\nThird one.";
  const doc = new Y.Doc();
  const ytext = doc.getText("source");
  ytext.insert(0, source);
  const annotations = new Y.Doc();
  createSuggestion(annotations, { ytext, start: source.indexOf("quick"), end: source.indexOf("quick") + 5, replacement: "slow", actor: alice, id: "a1", now: 10 });
  const end = source.indexOf(" here.") + 5;
  createSuggestion(annotations, { ytext, start: end, end, replacement: " and there", actor: aiForBob, groupId: "g", id: "b1", now: 20 });
  createSuggestion(annotations, { ytext, start: source.indexOf("Third"), end: source.indexOf("Third") + 5, replacement: "Final", actor: aiForBob, groupId: "g", id: "b2", now: 21 });
  createSuggestion(annotations, { ytext, start: 0, end: 2, replacement: "", actor: bob, id: "stale", now: 30 });
  ytext.insert(1, "#"); // makes "stale" stale
  const live = ytext.toString();

  const editor = mount(live);
  try {
    const changes = tiptapSuggestionPreview(editor, ytext, annotations, { author });
    assert.ok(changes.length >= 3);
    assert.ok(changes.every((change) => change.mode === "preview" && change.source === "review"));
    assert.deepEqual([...new Set(changes.map((change) => change.group))], ["a1", "g"], "stale suggestions stay in the panel");
    const byGroup = (group: string) => changes.filter((change) => change.group === group);
    assert.deepEqual(byGroup("a1")[0].author, { name: "Alice", color: "#3366ff", kind: "user" });
    assert.deepEqual(byGroup("g")[0].author, { name: "Bob", color: "#22aa66", kind: "ai" });
    assert.equal(byGroup("g")[0].createdAt, 20);
    assert.deepEqual(tiptapChangeUnits(changes).map((unit) => [unit.group, unit.author?.name]), [["a1", "Alice"], ["g", "Bob"]]);

    const decided: [string[], string][] = [];
    editor.view.dispatch(editor.state.tr.setMeta(tiptapChangesKey, { type: "preview", changes, decide: (groups: string[], decision: string) => decided.push([groups, decision]) }));
    assert.equal(editor.getMarkdown(), live, "previews never change the document");
    const labels = [...editor.view.dom.querySelectorAll(".libera-change-author")].map((element) => element.textContent);
    assert.deepEqual(labels, ["Alice", "AI · on behalf of Bob"]);
    const inserted = [...editor.view.dom.querySelectorAll(".libera-change-inserted")].map((element) => element.textContent).join("|");
    assert.match(inserted, /slow/);
    assert.match(inserted, /there/);
    assert.match(inserted, /Final/);
    assert.match(editor.view.dom.querySelector(".libera-change-deleted")?.getAttribute("style") ?? "", /--libera-change-author: #3366ff/);
    decideTiptapChanges(editor.view, byGroup("g").map((change) => change.id), "accept");
    assert.deepEqual(decided, [[["g"], "accept"]]);
  } finally { editor.destroy(); }
});

test("insertions are widened into their block and suggestions that do not match the source are skipped", () => {
  const source = "Para one.\n\nPara two.";
  const doc = new Y.Doc();
  const ytext = doc.getText("source");
  ytext.insert(0, source);
  const annotations = new Y.Doc();
  const atEnd = createSuggestion(annotations, { ytext, start: 9, end: 9, replacement: " More.", actor: alice, id: "i1" });
  const atStart = createSuggestion(annotations, { ytext, start: 0, end: 0, replacement: "> ", actor: alice, id: "i0" });
  const resolved = resolveSuggestions(ytext, [atEnd, atStart]);
  assert.deepEqual(suggestionEdit(source, resolved.find((item) => item.record.id === "i1")!), { start: 8, end: 9, before: ".", after: ". More." });
  assert.deepEqual(suggestionEdit(source, resolved.find((item) => item.record.id === "i0")!), { start: 0, end: 1, before: "P", after: "> P" });
  const editor = mount(source);
  try {
    const changes = overlaySuggestionsToTrackedChanges(editor, source, resolveSuggestions(ytext, listSuggestions(annotations)), { author, label: () => "Suggestion" });
    assert.deepEqual([...new Set(changes.map((change) => change.group))].sort(), ["i0", "i1"]);
    assert.ok(changes.every((change) => change.label === "Suggestion" && change.author?.name === "Alice"));
    // A source that no longer matches the suggestion's base text yields nothing.
    assert.deepEqual(overlaySuggestionsToTrackedChanges(editor, "Other text.", resolveSuggestions(ytext, [createSuggestion(annotations, { ytext, start: 11, end: 15, replacement: "Item", actor: bob, id: "x" })]), { author }), []);
  } finally { editor.destroy(); }
});
