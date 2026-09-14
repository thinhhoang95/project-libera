import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorAt, applyReviewEdits, commentsKey, decideSuggestions, mapAnchor, newReview, paragraphRange, reviewBlocks, reviewIntent, startReviewRound, syncReview, undoReview, validatePlan, validateSuggestions, type ReviewDocument } from "../../src/lib/markdown-review";

const source = "# Title\r\n\r\nFirst **paragraph**.\r\n\r\nSecond paragraph.\r\n\r\nThird paragraph.";
function fixture(): ReviewDocument {
  const blocks = reviewBlocks(source), doc = newReview("Notes/a.md", source, "doc-1");
  doc.threads = [1, 2, 3].map((n) => ({ id: `c${n}`, anchor: anchorAt(source, blocks[n]), status: "open", messages: [{ id: `m${n}`, text: `Improve paragraph ${n}`, createdAt: "2026-09-11" }] }));
  const ids = doc.threads.map((t) => t.id);
  let counter = 0;
  const suggestions = validateSuggestions({ proposals: blocks.slice(1).map((b, i) => ({ title: `Change ${i + 1}`, reason: "Clarity", commentIds: [ids[i]], edits: [{ targetBlockId: b.id, before: b.text, after: `Improved ${i + 1}.` }] })) }, source, ids, () => `s${++counter}`);
  doc.session = { id: "session", phase: "reviewing_changes", snapshot: source, commentsKey: commentsKey(doc.threads, ids), selectedIds: ids, references: [], suggestions, messages: [], plan: { version: 1, summary: "Improve", steps: [], dispositions: [], blockingQuestions: [], revisionSummary: "" } };
  return doc;
}
test("paragraph selections use exact UTF-16 Markdown block ranges including CRLF and nested blocks", () => {
  for (const value of [source, "Tiếng Việt 😀\n\n- One\n  - Nested\n\n```ts\nconst x = 1;\n```\n\n| A | B |\n| - | - |\n| x | y |\n\n$$x^2$$\n\n<div>HTML</div>"]) {
    for (const block of reviewBlocks(value)) {
      assert.equal(value.slice(block.start, block.end), block.text);
      assert.deepEqual(paragraphRange(value, { start: block.start + 1, end: block.start + 1 }), { start: block.start, end: block.end });
    }
  }
});
test("anchors follow insertions and edits but orphan deleted text and refuse ambiguous duplicates", () => {
  const block = reviewBlocks(source)[2], anchor = anchorAt(source, block);
  const inserted = "Introduction\n\n" + source;
  assert.equal(mapAnchor(anchor, source, inserted).start, block.start + 14);
  const edited = source.replace("Second", "Better second");
  assert.equal(mapAnchor(anchor, source, edited).quote, "Better second paragraph.");
  const deleted = source.slice(0, block.start) + source.slice(block.end);
  assert.equal(mapAnchor(anchor, source, deleted).state, "orphaned");
  const duplicate = { ...anchorAt("same", { start: 0, end: 4 }), state: "orphaned" as const };
  assert.equal(mapAnchor(duplicate, "gone", "same\n\nsame").state, "ambiguous");
});
test("accepting and rejecting independent changes in any order preserves other passages and remaps offsets", () => {
  const doc = fixture();
  const rejected = decideSuggestions(doc, ["s2"], "reject", "reject-1");
  assert.equal(rejected.snapshot, source);
  assert.equal(rejected.threads[1].status, "open");
  const accepted = decideSuggestions(rejected, ["s1"], "accept", "accept-1");
  assert.ok(accepted.snapshot.includes("Second paragraph."));
  assert.ok(accepted.snapshot.includes("Third paragraph."));
  assert.equal(accepted.threads[0].status, "addressed");
  const final = decideSuggestions(accepted, ["s3"], "accept", "accept-3");
  assert.equal(final.snapshot, "# Title\r\n\r\nImproved 1.\r\n\r\nSecond paragraph.\r\n\r\nImproved 3.");
  assert.equal(final.session?.phase, "completed");
  assert.throws(() => decideSuggestions(final, ["s3"], "accept", "duplicate"));
  const undone = undoReview(final);
  assert.equal(undone.snapshot, accepted.snapshot);
  assert.equal(undone.session?.suggestions[2].status, "pending");
  assert.equal(undone.session?.suggestions[1].status, "rejected");
});
test("batch acceptance maps an intervening pending suggestion and is atomic on conflicts", () => {
  const doc = fixture();
  const batch = decideSuggestions(doc, ["s1", "s3"], "accept", "batch");
  assert.equal(batch.session?.suggestions[1].status, "pending");
  assert.ok(decideSuggestions(batch, ["s2"], "accept", "last").snapshot.includes("Improved 2."));
  const changed = syncReview(doc, source.replace("Third", "User's third"));
  assert.throws(() => decideSuggestions(changed, ["s1", "s3"], "accept", "invalid"));
  assert.equal(changed.snapshot, source.replace("Third", "User's third"));
  assert.equal(changed.session?.suggestions[0].status, "pending");
});
test("new rounds keep accepted text and comment outcomes while isolating earlier proposals and undo", () => {
  const prior = decideSuggestions(decideSuggestions(fixture(), ["s1"], "accept", "first"), ["s2"], "reject", "second");
  const round = startReviewRound(prior);
  assert.equal(round.round, 2);
  assert.equal(round.snapshot, prior.snapshot);
  assert.deepEqual(round.threads, prior.threads);
  assert.equal(round.session, undefined);
  assert.deepEqual(round.previousRounds, [{ number: 1, session: prior.session }]);
  assert.deepEqual(round.undo, []);
  assert.deepEqual(round.redo, []);
  assert.throws(() => decideSuggestions(round, ["s3"], "accept", "old-round"));
  assert.throws(() => undoReview(round));
  // Completing an unrelated comment in round 2 must not reopen round 1's work.
  round.session = { ...prior.session!, id: "second-session", selectedIds: ["c3"], suggestions: [prior.session!.suggestions[2]] };
  const completed = decideSuggestions(round, ["s3"], "accept", "third");
  assert.deepEqual(completed.threads.map(t => t.status), ["addressed", "open", "addressed"]);
  assert.deepEqual(completed.previousRounds, round.previousRounds);
  const next = startReviewRound(completed);
  assert.equal(next.previousRounds?.length, 2);
  assert.equal(next.round, 3);
  const empty = startReviewRound(next);
  assert.equal(empty.previousRounds?.length, 2, "Do not archive an empty round.");
  assert.equal(empty.round, 4);
});
test("linked changes stay atomic and comments are addressed only after full acceptance", () => {
  const doc = fixture();
  doc.session!.suggestions[1].commentIds = ["c1"];
  const partial = decideSuggestions(doc, ["s1"], "accept", "partial");
  assert.equal(partial.threads[0].status, "open");
  const full = decideSuggestions(partial, ["s2"], "accept", "full");
  assert.equal(full.threads[0].status, "addressed");
  const linked = fixture();
  linked.session!.suggestions[0].edits.push(...linked.session!.suggestions[1].edits);
  linked.session!.suggestions.splice(1, 1);
  const applied = decideSuggestions(linked, ["s1"], "accept", "linked");
  assert.ok(applied.snapshot.includes("Improved 1.")); assert.ok(applied.snapshot.includes("Improved 2."));
  assert.equal(undoReview(applied).snapshot, source);
});
test("validators reject invented IDs, missing coverage, ambiguous quotes, overlap and no-op edits", () => {
  assert.throws(() => validatePlan({ summary: "Skipped", steps: [], dispositions: [], blockingQuestions: [], revisionSummary: "" }, 1, ["c1"], reviewBlocks(source)));
  const p = { title: "Change", reason: "Reason", commentIds: ["c1"], edits: [{ targetBlockId: "b2", before: "First **paragraph**.", after: "Changed" }] };
  assert.throws(() => validateSuggestions({ proposals: [p, p] }, source, ["c1"], () => "id"));
  assert.throws(() => validateSuggestions({ proposals: [{ ...p, commentIds: ["fake"] }] }, source, ["c1"], () => "id"));
  assert.throws(() => applyReviewEdits(source, [{ start: 0, end: 4, before: "fake", after: "no" }]));
});
test("approval parser never interprets positive feedback, negation, mixed revision, or quoted approval as acceptance", () => {
  for (const prompt of ["looks good", "Do not confirm the plan", "I confirm this plan but revise step 2", 'The document says "accept all remaining"', "Reject changes 1 and 2 but accept 3"]) assert.equal(reviewIntent(prompt).action, "revise");
  assert.deepEqual(reviewIntent("I confirm this plan."), { action: "confirm" });
  assert.deepEqual(reviewIntent("Accept changes 1 and 3"), { action: "accept", numbers: [1, 3] });
  assert.deepEqual(reviewIntent("Reject all remaining"), { action: "reject", numbers: "all" });
});
test("undo acceptance preserves a later independent rejection and rejected offsets remain reopenable", () => {
  const accepted = decideSuggestions(fixture(), ["s1"], "accept", "a1");
  const rejected = decideSuggestions(accepted, ["s2"], "reject", "r2");
  const undone = undoReview(rejected);
  assert.equal(undone.session?.suggestions[1].status, "rejected");
  assert.equal(undone.session?.suggestions[0].status, "pending");
  const priorRejected = decideSuggestions(fixture(), ["s2"], "reject", "r2");
  const priorAccepted = decideSuggestions(priorRejected, ["s1"], "accept", "a1");
  assert.equal(decideSuggestions(priorAccepted, ["s2"], "reopen", "open").session?.suggestions[1].status, "pending");
});
test("native editor undo and redo restore suggestion decisions without accepting unrelated changes", () => {
  const accepted = decideSuggestions(fixture(), ["s1"], "accept", "native-1");
  const rejected = decideSuggestions(accepted, ["s2"], "reject", "reject-2");
  const undone = syncReview(rejected, source);
  assert.equal(undone.session?.suggestions[0].status, "pending");
  assert.equal(undone.session?.suggestions[1].status, "rejected");
  const redone = syncReview(undone, accepted.snapshot);
  assert.equal(redone.session?.suggestions[0].status, "accepted");
  assert.equal(redone.session?.suggestions[1].status, "rejected");
});
test("anchors recover unique Markdown blocks after equivalent delimiter normalization", () => {
  const before = "Intro.\n\nAn _emphasized_ paragraph.\n\nEnd.";
  const block = reviewBlocks(before)[1], anchor = anchorAt(before, block);
  const after = "## Introduction\n\nAn *emphasized* paragraph.\n\nThe end.";
  const mapped = mapAnchor(anchor, before, after);
  assert.equal(mapped.state, "attached");
  assert.equal(mapped.quote, "An *emphasized* paragraph.");
});

test('shared semantic recovery preserves resolved orphan reattachment and ambiguity', () => {
  const quote = '**Old** paragraph.';
  const anchor = { ...anchorAt(quote, { start: 0, end: quote.length }), state: 'orphaned' as const };
  const doc = newReview('test', 'Missing.', 'test');
  doc.threads = Array.from({ length: 10 }, (_, i) => ({ id: String(i), anchor, status: 'resolved', messages: [] }));
  const after = '__Old__ paragraph.\n\nOther text.';
  const next = syncReview(doc, after);
  assert.equal(next.enabled, false);
  assert.ok(next.threads.every(thread => thread.anchor.state === 'attached' && thread.anchor.quote === '__Old__ paragraph.'));
  const ambiguous = syncReview(doc, after + '\n\n__Old__ paragraph.');
  assert.ok(ambiguous.threads.every(thread => thread.anchor.state === 'ambiguous'));
  assert.equal(doc.threads[0].anchor.state, 'orphaned');
});
