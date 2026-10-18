import { dom } from "./edlib-dom";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import { collabExtension, dispatchAiEdit } from "../../src/lib/collab/bindings/codemirror";
import { nextSuggestion, previewGroups, previewSuggestions, previousSuggestion, suggestionPreview, type SuggestionGroupRef } from "../../src/lib/collab/suggestions/codemirror";
import { createSuggestion, getSuggestion, listSuggestions, resolveSuggestion } from "../../src/lib/collab/suggestions/model";
import { planSuggestOps, suggestMode } from "../../src/lib/collab/suggestions/suggest-mode";
import type { Actor, SuggestionRecord } from "../../src/lib/collab/protocol";

const alice: Extract<Actor, { kind: "user" }> = { kind: "user", userId: "alice" };
const bob: Actor = { kind: "user", userId: "bob" };
const aiForAlice: Actor = { kind: "ai", onBehalfOf: "alice", feature: "rewrite", model: "m" };
const people: Record<string, { name: string; color: string }> = { alice: { name: "Alice", color: "#3366ff" }, bob: { name: "Bob", color: "#22aa66" } };
const author = (record: SuggestionRecord) => people[record.createdBy] ?? { name: record.createdBy, color: "#888888" };

const cleanup: (() => void)[] = [];
after(() => {
  for (const fn of cleanup) fn();
  dom.window.close();
});

function mount(ytext: Y.Text, extensions: Extension) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: EditorState.create({ doc: ytext.toString(), extensions }), parent });
  cleanup.push(() => view.destroy());
  return view;
}

function setup(text: string) {
  const content = new Y.Doc();
  const ytext = content.getText("source");
  ytext.insert(0, text);
  return { content, ytext, annotations: new Y.Doc() };
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));
const texts = (view: EditorView, selector: string) => [...view.contentDOM.querySelectorAll(selector)].map((element) => element.textContent);

test("preview decorations: struck base text, replacement widgets, author labels, stale styling and actions", async () => {
  const { content, ytext, annotations } = setup("The cat sat on the mat.\nSecond line here.\n");
  createSuggestion(annotations, { ytext, start: 4, end: 7, replacement: "dog", actor: alice, id: "s1", now: 1 });
  createSuggestion(annotations, { ytext, start: 11, end: 11, replacement: " quietly", actor: aiForAlice, groupId: "g1", id: "s2", now: 2 });
  createSuggestion(annotations, { ytext, start: 14, end: 18, replacement: "", actor: aiForAlice, groupId: "g1", id: "s3", now: 3 });
  createSuggestion(annotations, { ytext, start: 24, end: 30, replacement: "Next", actor: bob, id: "s4", now: 4 });
  const calls: [string, SuggestionGroupRef][] = [];
  const binding = collabExtension({ ytext, awareness: null, user: { name: "Alice", color: "#3366ff" } });
  cleanup.push(() => binding.destroy());
  const view = mount(ytext, [binding.extension, suggestionPreview({
    ytext, annotations, author, canDecide: true,
    onAccept: (group) => calls.push(["accept", group]), onReject: (group) => calls.push(["reject", group]), onReply: (group) => calls.push(["reply", group]),
  })]);

  assert.deepEqual(texts(view, ".cm-collab-suggestion-deleted"), ["cat", " the", "Second"]);
  assert.deepEqual(texts(view, ".cm-collab-suggestion-inserted"), ["dog", " quietly", "Next"]);
  assert.deepEqual(texts(view, ".cm-collab-suggestion-label"), ["Alice", "AI · on behalf of Alice · 2 changes", "Bob"]);
  assert.equal((view.contentDOM.querySelector(".cm-collab-suggestion-deleted") as HTMLElement).style.getPropertyValue("--collab-author"), "#3366ff");
  assert.equal(view.state.doc.toString(), ytext.toString(), "preview never changes the document");

  // Buttons call back with the whole group.
  const groupActions = view.contentDOM.querySelectorAll(".cm-collab-suggestion-actions")[1];
  (groupActions.querySelector("[data-action=accept]") as HTMLElement).click();
  (groupActions.querySelector("[data-action=reply]") as HTMLElement).click();
  assert.deepEqual(calls.map(([kind, group]) => [kind, group.groupId, group.ids]), [["accept", "g1", ["s2", "s3"]], ["reply", "g1", ["s2", "s3"]]]);

  // A remote edit inside "Second" makes Bob's suggestion stale at once.
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(content));
  remote.getText("source").insert(27, "X");
  Y.applyUpdate(content, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(content)));
  const stale = view.contentDOM.querySelector(".cm-collab-suggestion-deleted.cm-collab-suggestion-stale") as HTMLElement;
  assert.equal(stale.textContent, "SecXond");
  assert.match(stale.title, /Was: "Second"\nNow: "SecXond"/);
  const bobActions = view.contentDOM.querySelectorAll(".cm-collab-suggestion-actions")[2];
  assert.equal(bobActions.querySelector("[data-action=accept]"), null, "a stale suggestion cannot be accepted");
  assert.ok(bobActions.querySelector("[data-action=reject]"));
  assert.match(bobActions.textContent ?? "", /^Stale · Bob/);

  // Edits elsewhere only move decorations.
  view.dispatch({ changes: { from: 0, insert: ">> " }, userEvent: "input.type" });
  assert.deepEqual(previewSuggestions(view.state).map((item) => [item.id, item.from, item.to]), [["s1", 7, 10], ["s2", 14, 14], ["s3", 17, 21], ["s4", 27, 34]]);
  assert.deepEqual(texts(view, ".cm-collab-suggestion-deleted"), ["cat", " the", "SecXond"]);

  // The annotations map drives the overlay: new and withdrawn suggestions appear and vanish.
  createSuggestion(annotations, { ytext, start: 0, end: 2, replacement: "»", actor: bob, id: "s5", now: 5 });
  annotations.getMap("suggestions").delete("s1");
  await flush();
  assert.deepEqual(previewSuggestions(view.state).map((item) => item.id), ["s5", "s2", "s3", "s4"]);
  assert.deepEqual(texts(view, ".cm-collab-suggestion-inserted"), ["»", " quietly", "Next"]);

  // Deleting a target collapses it; undo restores it after the exact re-resolve.
  view.dispatch({ changes: { from: 17, to: 21 }, userEvent: "delete" });
  assert.equal(previewSuggestions(view.state).find((item) => item.id === "s3")?.staleReason, "target-removed");
  binding.undoManager.undo();
  await flush();
  const restored = previewSuggestions(view.state).find((item) => item.id === "s3")!;
  assert.deepEqual([restored.isStale, restored.currentText], [false, " the"]);
});

test("stepping moves between suggestion groups in document order", () => {
  const { ytext, annotations } = setup("one two three four five");
  createSuggestion(annotations, { ytext, start: 4, end: 7, replacement: "2", actor: alice, id: "a" });
  createSuggestion(annotations, { ytext, start: 8, end: 13, replacement: "3", actor: alice, groupId: "g", id: "b" });
  createSuggestion(annotations, { ytext, start: 19, end: 23, replacement: "5", actor: alice, groupId: "g", id: "c" });
  const view = mount(ytext, suggestionPreview({ ytext, annotations, author }));
  assert.equal(view.contentDOM.querySelector("[data-action=accept]"), null, "no decide buttons without canDecide");
  assert.deepEqual(previewGroups(view.state).map((group) => group.groupId), ["a", "g"]);
  assert.equal(nextSuggestion(view)?.groupId, "a");
  assert.equal(view.state.selection.main.head, 4);
  assert.equal(nextSuggestion(view)?.groupId, "g");
  assert.equal(nextSuggestion(view)?.groupId, "a", "wraps around");
  assert.equal(previousSuggestion(view)?.groupId, "g");
  assert.equal(nextSuggestion(view, false), null);
});

test("suggest mode turns typing into overlay suggestions and leaves content untouched", async () => {
  const { content, ytext, annotations } = setup("Hello world.");
  const binding = collabExtension({ ytext, awareness: null, user: { name: "Alice", color: "#3366ff" } });
  let ids = 0;
  const suggest = suggestMode({ ytext, annotations, actor: alice, enabled: true, makeId: () => `m${++ids}`, now: () => 100 });
  cleanup.push(() => { binding.destroy(); suggest.destroy(); });
  const view = mount(ytext, [binding.extension, suggest.extension, suggestionPreview({ ytext, annotations, author, localUserId: "alice" })]);
  const type = (from: number, text: string, to = from) => view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.type" });
  const records = () => listSuggestions(annotations).map((record) => [record.id, record.baseQuote, record.replacement, record.status]);

  // Contiguous typing at a point is one insertion.
  type(5, ",");
  type(5, " my");
  type(5, " dear");
  assert.equal(ytext.toString(), "Hello world.");
  assert.equal(view.state.doc.toString(), "Hello world.");
  assert.equal(view.state.selection.main.head, 5);
  assert.deepEqual(records(), [["m1", "", ", my dear", "pending"]]);
  // Backspace trims your own suggested text.
  view.dispatch({ changes: { from: 4, to: 5 }, userEvent: "delete.backward" });
  assert.deepEqual(records(), [["m1", "", ", my dea", "pending"]]);

  // Deleting text suggests a deletion, and further backspaces grow it.
  view.dispatch({ changes: { from: 10, to: 11 }, selection: { anchor: 10 }, userEvent: "delete.backward" });
  assert.equal(view.state.selection.main.head, 10);
  view.dispatch({ changes: { from: 9, to: 10 }, userEvent: "delete.backward" });
  assert.deepEqual(records().at(-1), ["m2", "ld", "", "pending"]);
  assert.equal(view.state.selection.main.head, 9);

  // Typing over a selection suggests a replacement; typing on extends it.
  type(0, "J", 1);
  assert.equal(view.state.selection.main.head, 1);
  type(1, "e");
  assert.deepEqual(records().at(-1), ["m3", "H", "Je", "pending"]);
  assert.equal(ytext.toString(), "Hello world.", "content stays untouched");

  // Remote edits still flow in while suggesting.
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(content));
  remote.getText("source").insert(12, " Bye.");
  Y.applyUpdate(content, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(content)));
  assert.equal(view.state.doc.toString(), "Hello world. Bye.");

  // Your own pending replacement is editable in place.
  await flush();
  const widget = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-collab-suggestion-inserted")].find((element) => element.textContent === "Je")!;
  assert.equal(widget.contentEditable, "true");
  widget.textContent = "Jello";
  widget.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(getSuggestion(annotations, "m3")?.replacement, "Jello");

  // AI edits in suggest mode become AI suggestions grouped by run.
  dispatchAiEdit(view, { changes: { from: 13, to: 17, insert: "Goodbye" } }, { feature: "rewrite", model: "m", runId: "run-1" });
  const ai = getSuggestion(annotations, "m4")!;
  assert.deepEqual([ai.actor.kind, ai.groupId, ai.baseQuote, ai.replacement, ai.createdBy], ["ai", "run-1", "Bye.", "Goodbye", "alice"]);

  // Undo steps back through suggestion edits first.
  suggest.undoManager.undo();
  assert.equal(getSuggestion(annotations, "m4"), null);
  assert.equal(ytext.toString(), "Hello world. Bye.");

  // Turning suggest mode off edits content again.
  suggest.setEnabled(view, false);
  type(0, "¡");
  assert.equal(ytext.toString(), "¡Hello world. Bye.");
});

test("a commenter's editor is always in suggest mode and never extends someone else's suggestion", () => {
  const { ytext, annotations } = setup("Shared text.");
  createSuggestion(annotations, { ytext, start: 6, end: 6, replacement: " fine", actor: bob, id: "bob-1" });
  const suggest = suggestMode({ ytext, annotations, actor: alice, forced: true, makeId: () => "alice-1" });
  cleanup.push(() => suggest.destroy());
  const view = mount(ytext, [suggest.extension, suggestionPreview({ ytext, annotations, author, localUserId: "alice" })]);
  suggest.setEnabled(view, false);
  assert.equal(suggest.isEnabled(view.state), true);
  view.dispatch({ changes: { from: 6, insert: " nice" }, userEvent: "input.type" });
  assert.equal(view.state.doc.toString(), "Shared text.");
  assert.equal(getSuggestion(annotations, "bob-1")?.replacement, " fine");
  assert.deepEqual([getSuggestion(annotations, "alice-1")?.replacement, getSuggestion(annotations, "alice-1")?.createdBy], [" nice", "alice"]);
  assert.ok(view.dom.classList.contains("cm-collab-suggesting"));
  const bobWidget = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-collab-suggestion-inserted")].find((element) => element.textContent === " fine");
  assert.equal(bobWidget?.contentEditable, "false", "only the author may edit a suggestion in place");
});

test("planSuggestOps handles forward deletes and discards emptied insertions", () => {
  const { ytext, annotations } = setup("abcdef");
  const record = createSuggestion(annotations, { ytext, start: 2, end: 2, replacement: "X", actor: alice, id: "p" });
  const own = [resolveSuggestion(ytext, record)];
  assert.deepEqual(planSuggestOps([{ from: 1, to: 2, insert: "" }], own, { actor: alice, forward: false, ai: false }).ops, [{ kind: "discard", id: "p" }]);
  const forward = planSuggestOps([{ from: 2, to: 3, insert: "" }], own, { actor: alice, forward: true, ai: false });
  assert.deepEqual(forward, { ops: [{ kind: "rerange", id: "p", start: 2, end: 3, replacement: "X" }], cursor: 3 });
  const fresh = planSuggestOps([{ from: 4, to: 5, insert: "" }], [], { actor: alice, forward: true, ai: false });
  assert.deepEqual(fresh.cursor, 5);
});
