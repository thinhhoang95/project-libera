// Overlay suggestion model, including the plan §6.2 hard cases that are
// decided on the client: 1, 2, 4 and 7. Cases 3 (concurrent opposite
// decisions), 5 (offline accept of a changed suggestion) and 6 (accept-all
// with a checkpoint) are serialized by the server's decision command and are
// tested there; `validateDecision` below is only the optimistic mirror.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import {
  applySuggestionToText, createSuggestion, editSuggestionReplacement, getSuggestion, groupSuggestions, listSuggestions, mapSnapshotEdits,
  previewAcceptedText, refreshSuggestion, resolveSuggestion, resolveSuggestions, suggestionsFromSnapshotEdits, validateDecision,
  validateGroupDecision, withdrawSuggestion,
} from "../../src/lib/collab/suggestions/model";
import type { Actor } from "../../src/lib/collab/protocol";

const alice: Actor = { kind: "user", userId: "alice" };
const bob: Actor = { kind: "user", userId: "bob" };
const aiForAlice: Actor = { kind: "ai", onBehalfOf: "alice", feature: "agentic-review", model: "m" };

function setup(text: string) {
  const content = new Y.Doc();
  const ytext = content.getText("source");
  ytext.insert(0, text);
  return { content, ytext, annotations: new Y.Doc() };
}

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

let ids = 0;
const id = () => `s${++ids}`;

test("create, list and resolve replacement, deletion and insertion suggestions", () => {
  const { ytext, annotations } = setup("The cat sat on the mat.");
  const replace = createSuggestion(annotations, { ytext, start: 4, end: 7, replacement: "dog", actor: alice, id: id(), now: 1 });
  const remove = createSuggestion(annotations, { ytext, start: 14, end: 18, replacement: "", actor: bob, id: id(), now: 2 });
  const insert = createSuggestion(annotations, { ytext, start: 11, end: 11, replacement: " quietly", actor: aiForAlice, id: id(), now: 3 });
  assert.equal(replace.baseQuote, "cat");
  assert.equal(replace.status, "pending");
  assert.equal(remove.createdBy, "bob");
  assert.equal(insert.createdBy, "alice", "an AI suggestion uses the rights of the user it acts for");
  assert.deepEqual(listSuggestions(annotations).map((record) => record.id), [replace.id, remove.id, insert.id]);
  assert.deepEqual(listSuggestions(annotations, { createdBy: "bob" }).map((record) => record.id), [remove.id]);

  const resolved = resolveSuggestions(ytext, listSuggestions(annotations));
  assert.deepEqual(resolved.map((item) => [item.start, item.end, item.currentText, item.isStale, item.isInsertion]), [
    [4, 7, "cat", false, false], [11, 11, "", false, true], [14, 18, " the", false, false],
  ]);
  assert.equal(applySuggestionToText(ytext.toString(), resolved[0]), "The dog sat on the mat.");
  assert.equal(applySuggestionToText("The bat sat on the mat.", resolved[0]), null);
  assert.deepEqual(previewAcceptedText(ytext, annotations), { text: "The dog sat quietly on mat.", applied: [replace.id, insert.id, remove.id], skipped: [] });
  assert.equal(ytext.toString(), "The cat sat on the mat.", "suggestions never touch content");

  // A replica sees the same suggestions through the annotations doc.
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(annotations));
  assert.deepEqual(getSuggestion(replica, replace.id), replace);
});

test("stale detection: text changed, target removed, and insertion points", () => {
  const { ytext, annotations } = setup("Alpha beta gamma delta.");
  const word = createSuggestion(annotations, { ytext, start: 6, end: 10, replacement: "BETA", actor: alice, id: id() });
  const point = createSuggestion(annotations, { ytext, start: 16, end: 16, replacement: ",", actor: alice, id: id() });
  ytext.insert(0, ">> ");
  ytext.insert(ytext.toString().indexOf("gamma") + 5, " ");
  assert.equal(resolveSuggestion(ytext, getSuggestion(annotations, word.id)!).isStale, false, "edits outside keep it live");
  const typedAtPoint = resolveSuggestion(ytext, point);
  assert.deepEqual([typedAtPoint.isStale, typedAtPoint.staleReason, typedAtPoint.currentText], [true, "text-changed", " "]);

  ytext.insert(ytext.toString().indexOf("beta") + 2, "e");
  assert.deepEqual([resolveSuggestion(ytext, word).isStale, resolveSuggestion(ytext, word).staleReason, resolveSuggestion(ytext, word).currentText], [true, "text-changed", "beeta"]);
  ytext.delete(ytext.toString().indexOf("beeta"), 5);
  assert.equal(resolveSuggestion(ytext, word).staleReason, "target-removed");

  const { ytext: other, annotations: otherAnnotations } = setup("one two three");
  const insertion = createSuggestion(otherAnnotations, { ytext: other, start: 7, end: 7, replacement: "!", actor: alice, id: id() });
  other.delete(6, 1);
  assert.equal(resolveSuggestion(other, insertion).staleReason, "text-changed", "one neighbour deleted");
  other.delete(3, 5);
  assert.equal(resolveSuggestion(other, insertion).staleReason, "target-removed", "both neighbours deleted");
});

test("only the creator may withdraw or edit a suggestion", () => {
  const { ytext, annotations } = setup("Some text here.");
  const record = createSuggestion(annotations, { ytext, start: 5, end: 9, replacement: "words", actor: alice, id: id() });
  assert.deepEqual(editSuggestionReplacement(annotations, record.id, "bob", "nope"), { ok: false, reason: "not-owner" });
  assert.deepEqual(withdrawSuggestion(annotations, record.id, "bob"), { ok: false, reason: "not-owner" });
  const edited = editSuggestionReplacement(annotations, record.id, "alice", "prose", 50);
  assert.ok(edited.ok && edited.record.replacement === "prose" && edited.record.updatedAt === 50);
  const withdrawn = withdrawSuggestion(annotations, record.id, "alice", 60);
  assert.ok(withdrawn.ok && withdrawn.record.status === "withdrawn");
  assert.deepEqual(editSuggestionReplacement(annotations, record.id, "alice", "again"), { ok: false, reason: "not-pending" });
  assert.deepEqual(withdrawSuggestion(annotations, "missing", "alice"), { ok: false, reason: "not-found" });
  // AI suggestions belong to the user the AI acted for.
  const ai = createSuggestion(annotations, { ytext, start: 0, end: 4, replacement: "Any", actor: aiForAlice, id: id() });
  assert.ok(withdrawSuggestion(annotations, ai.id, "alice").ok);
});

test("groups are decided together and one stale member blocks the group", () => {
  const { ytext, annotations } = setup("First line.\nSecond line.\nThird line.\n");
  const a = createSuggestion(annotations, { ytext, start: 0, end: 5, replacement: "1st", actor: aiForAlice, groupId: "g1", id: id(), now: 1 });
  const b = createSuggestion(annotations, { ytext, start: 12, end: 18, replacement: "2nd", actor: aiForAlice, groupId: "g1", id: id(), now: 2 });
  const c = createSuggestion(annotations, { ytext, start: 25, end: 30, replacement: "3rd", actor: bob, id: id(), now: 3 });
  let groups = groupSuggestions(resolveSuggestions(ytext, listSuggestions(annotations)));
  assert.deepEqual(groups.map((group) => [group.id, group.suggestions.map((item) => item.record.id), group.isStale]), [["g1", [a.id, b.id], false], [c.id, [c.id], false]]);
  assert.deepEqual(listSuggestions(annotations, { groupId: "g1" }).map((record) => record.id), [a.id, b.id]);
  assert.deepEqual(validateGroupDecision({ role: "editor", actor: bob, decision: "accept", group: groups[0] }), { ok: true, outcome: "applied" });

  ytext.insert(14, "x"); // inside "Second"
  groups = groupSuggestions(resolveSuggestions(ytext, listSuggestions(annotations)));
  assert.equal(groups[0].isStale, true);
  assert.deepEqual(validateGroupDecision({ role: "editor", actor: bob, decision: "accept", group: groups[0] }), { ok: false, code: "stale" });
  assert.deepEqual(validateGroupDecision({ role: "editor", actor: bob, decision: "reject", group: groups[0] }), { ok: true, outcome: "rejected" });
  const preview = previewAcceptedText(ytext, annotations);
  assert.deepEqual(preview.applied, [c.id]);
  assert.deepEqual(preview.skipped.sort(), [a.id, b.id].sort());
});

test("decision checks mirror the server: AI never decides, commenters cannot, decided ones are final", () => {
  const { ytext, annotations } = setup("Decide me.");
  const record = createSuggestion(annotations, { ytext, start: 0, end: 6, replacement: "Accept", actor: bob, id: id() });
  const resolved = resolveSuggestion(ytext, record);
  assert.deepEqual(validateDecision({ role: "owner", actor: aiForAlice, decision: "accept", suggestion: resolved }), { ok: false, code: "ai-cannot-decide" });
  assert.deepEqual(validateDecision({ role: "commenter", actor: bob, decision: "reject", suggestion: resolved }), { ok: false, code: "forbidden" });
  assert.deepEqual(validateDecision({ role: "editor", actor: alice, decision: "accept", suggestion: resolved }), { ok: true, outcome: "applied" });
  assert.deepEqual(validateDecision({ role: "editor", actor: alice, decision: "accept", suggestion: null }), { ok: false, code: "not-found" });
  assert.deepEqual(validateDecision({ role: "editor", actor: alice, decision: "accept", suggestion: { ...resolved, record: { ...record, status: "accepted" } } }), { ok: false, code: "already-decided" });
});

test("hard case 1: Alice suggests deleting a sentence while Bob edits inside it", () => {
  const { content, ytext, annotations } = setup("Keep this. Remove this sentence entirely. Keep that.");
  const bobDoc = new Y.Doc();
  Y.applyUpdate(bobDoc, Y.encodeStateAsUpdate(content));
  const start = ytext.toString().indexOf("Remove");
  const end = ytext.toString().indexOf(" Keep that");
  const record = createSuggestion(annotations, { ytext, start, end, replacement: "", actor: alice, id: id() });
  const bobText = bobDoc.getText("source");
  bobText.insert(bobText.toString().indexOf(" entirely"), " (really)");
  sync(content, bobDoc);

  const resolved = resolveSuggestion(ytext, record);
  assert.equal(ytext.toString(), "Keep this. Remove this sentence (really) entirely. Keep that.", "Bob's edit lands in content");
  assert.deepEqual([resolved.isStale, resolved.staleReason], [true, "text-changed"]);
  assert.equal(resolved.currentText, "Remove this sentence (really) entirely.", "the anchor still spans the sentence");
  assert.equal(resolved.record.baseQuote, "Remove this sentence entirely.");
  assert.equal(previewAcceptedText(ytext, annotations).text, ytext.toString(), "a stale suggestion is never applied");

  assert.deepEqual(refreshSuggestion(annotations, ytext, record.id, { accountId: "carol", role: "commenter" }), { ok: false, reason: "not-owner" });
  const refreshed = refreshSuggestion(annotations, ytext, record.id, { accountId: "alice", role: "commenter" });
  assert.ok(refreshed.ok);
  const live = resolveSuggestion(ytext, refreshed.record);
  assert.deepEqual([live.isStale, live.record.baseQuote], [false, "Remove this sentence (really) entirely."]);
  assert.ok(refreshSuggestion(annotations, ytext, record.id, { accountId: "dan", role: "editor" }).ok, "an editor may refresh too");
});

test("hard case 2: Bob cannot edit inside Alice's pending insertion", () => {
  const { ytext, annotations } = setup("Hello world.");
  const insertion = createSuggestion(annotations, { ytext, start: 5, end: 5, replacement: " dear", actor: alice, id: id() });
  assert.deepEqual(editSuggestionReplacement(annotations, insertion.id, "bob", " darling"), { ok: false, reason: "not-owner" });
  assert.equal(ytext.toString(), "Hello world.", "the insertion is not in content, so there is nothing for Bob to edit");
  const competing = createSuggestion(annotations, { ytext, start: 5, end: 5, replacement: " my", actor: bob, id: id() });
  const resolved = resolveSuggestions(ytext, listSuggestions(annotations));
  assert.deepEqual(resolved.map((item) => [item.record.id, item.start, item.isStale]), [[insertion.id, 5, false], [competing.id, 5, false]]);
  assert.equal(getSuggestion(annotations, insertion.id)!.replacement, " dear");
  // Overlapping insertions at one point are not both previewed.
  assert.deepEqual(previewAcceptedText(ytext, annotations), { text: "Hello dear world.", applied: [insertion.id], skipped: [competing.id] });
});

test("hard case 4: deleting a block with several suggestions makes each stale (target removed)", () => {
  const { ytext, annotations } = setup("Intro.\n\nA block with words to change and more words.\n\nOutro.");
  const block = ytext.toString().indexOf("A block");
  const records = [
    createSuggestion(annotations, { ytext, start: block + 8, end: block + 13, replacement: "terms", actor: alice, id: id() }),
    createSuggestion(annotations, { ytext, start: block + 17, end: block + 23, replacement: "", actor: bob, id: id() }),
    createSuggestion(annotations, { ytext, start: block + 27, end: block + 27, replacement: " many", actor: aiForAlice, id: id() }),
  ];
  ytext.delete(block, "A block with words to change and more words.\n\n".length);
  for (const record of records) {
    const resolved = resolveSuggestion(ytext, record);
    assert.deepEqual([resolved.isStale, resolved.staleReason], [true, "target-removed"], record.id);
  }
  assert.deepEqual(previewAcceptedText(ytext, annotations), { text: "Intro.\n\nOutro.", applied: [], skipped: records.map((record) => record.id) });
});

test("hard case 7: agentic-review edits on an old snapshot become live or conflicted suggestions", () => {
  const snapshot = "# Title\n\nFirst paragraph is fine.\n\nSecond paragraph has a typo teh.\n\nThird paragraph ends here.\n";
  const edits = [
    { start: snapshot.indexOf("fine"), end: snapshot.indexOf("fine") + 4, before: "fine", after: "good" },
    { start: snapshot.indexOf("teh"), end: snapshot.indexOf("teh") + 3, before: "teh", after: "the" },
    { start: snapshot.indexOf("ends here"), end: snapshot.indexOf("ends here") + 9, before: "ends here", after: "concludes" },
  ];
  // During the 40 s generation a collaborator fixed the typo differently and
  // added a paragraph at the top.
  const { ytext, annotations } = setup(snapshot);
  ytext.insert(snapshot.indexOf("First"), "New opening paragraph.\n\n");
  const typo = ytext.toString().indexOf("teh");
  ytext.delete(typo, 3);
  ytext.insert(typo, "tea");
  const live = ytext.toString();

  const mapped = mapSnapshotEdits(live, snapshot, edits);
  assert.deepEqual(mapped.map((item) => item.matched), [true, false, true]);
  assert.equal(live.slice(mapped[0].start, mapped[0].end), "fine");
  assert.equal(live.slice(mapped[2].start, mapped[2].end), "ends here");

  const result = suggestionsFromSnapshotEdits(live, snapshot, edits, { ytext, target: annotations, actor: aiForAlice, groupId: "proposal-1", title: "Polish", makeId: id, now: 5 });
  assert.equal(result.suggestions.length, 3);
  assert.deepEqual(result.matched.map((record) => record.replacement), ["good", "concludes"]);
  assert.equal(result.conflicted.length, 1);
  const conflicted = result.conflicted[0];
  assert.deepEqual([conflicted.status, conflicted.staleReason, conflicted.baseQuote], ["stale", "text-changed", "teh"]);
  assert.ok(result.suggestions.every((record) => record.groupId === "proposal-1" && record.actor.kind === "ai"));
  const resolvedConflict = resolveSuggestion(ytext, conflicted);
  assert.equal(resolvedConflict.isStale, true);
  assert.equal(resolvedConflict.currentText, "tea", "the conflicted suggestion shows what is there now");
  assert.equal(listSuggestions(annotations, { groupId: "proposal-1" }).length, 3);
  assert.equal(groupSuggestions(resolveSuggestions(ytext, result.suggestions))[0].isStale, true, "the linked proposal cannot be accepted as a whole");

  // A passage that moved is still found by its unique quote.
  const moved = "Third paragraph ends here.\n\n# Title\n\nFirst paragraph is fine.\n\nSecond paragraph has a typo teh.\n";
  const remapped = mapSnapshotEdits(moved, snapshot, edits);
  assert.deepEqual(remapped.map((item) => [item.matched, item.via]), [[true, "diff"], [true, "diff"], [true, "quote"]]);
  assert.equal(moved.slice(remapped[2].start, remapped[2].end), "ends here");
  // An edit that does not match its own snapshot is conflicted.
  assert.equal(mapSnapshotEdits(snapshot, snapshot, [{ start: 0, end: 3, before: "nope", after: "x" }])[0].matched, false);
  assert.throws(() => suggestionsFromSnapshotEdits("other", snapshot, edits, { ytext, actor: aiForAlice }));
});
