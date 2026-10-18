// The hard cases of implementation plan §6.2, end to end with real sync
// clients, each asserting the outcome the plan documents.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { AnnotationKeys, type SuggestionRecord } from "../src/protocol.js";
import {
  at,
  decide,
  edit,
  outcomes,
  serverRecord,
  serverText,
  startCollab,
  suggest,
  waitUntil,
  type CollabEnv,
} from "./support/decisions-env.js";

describe("hard cases (plan §6.2)", () => {
  let env: CollabEnv;
  before(async () => {
    env = await startCollab();
  });
  after(() => env.close());

  const contentUpdatesAfter = (docId: string, seq: number) =>
    env.db
      .selectFrom("doc_updates")
      .selectAll()
      .where("doc_id", "=", docId)
      .where("subdoc", "=", "content")
      .where("server_seq", ">", seq)
      .orderBy("server_seq")
      .execute();
  const mirrorRow = async (docId: string, id: string) => {
    const list = await env.api("GET", `/v1/documents/${docId}/suggestions`, env.viewer);
    return (list.body as Array<Record<string, any>>).find((row) => row.id === id);
  };

  test("1: Alice suggests deleting a sentence while Bob edits inside it", async () => {
    const bob = await env.connect(env.editor);
    const docId = await env.document(bob, "Keep this. Delete this sentence please. Keep that.");
    const alice = await env.connect(env.commenter);
    await alice.open(docId);
    const sentence = "Delete this sentence please. ";
    const deletion = await suggest(alice, docId, env.commenter, { quote: sentence, replacement: "" });

    // Bob's edit lands in content.
    await edit(bob, docId, at(bob, docId, "sentence"), at(bob, docId, "sentence"), "long ");
    assert.equal(await serverText(env, docId), "Keep this. Delete this long sentence please. Keep that.");

    const response = await decide(env, env.editor, docId, [[deletion.id, "accept"]]);
    assert.deepEqual(outcomes(response), { [deletion.id]: "stale" });
    assert.equal(await serverText(env, docId), "Keep this. Delete this long sentence please. Keep that.", "nothing deleted");
    const overlay = await serverRecord(env, docId, deletion.id);
    assert.equal(overlay?.status, "stale");
    assert.equal(overlay?.staleReason, "text-changed");
    // The overlay still spans the sentence, now with Bob's words: old and new text are both available.
    await waitUntil(() => alice.text(docId).includes("long"), "alice has Bob's edit");
    const content = alice.doc(docId, "content");
    const { resolveRange } = await import("../src/text/ytext.js");
    const range = resolveRange(content, overlay!.start, overlay!.end)!;
    assert.equal(alice.text(docId).slice(range.start, range.end), "Delete this long sentence please. ");
    assert.equal(overlay?.baseQuote, sentence);
    assert.equal((await mirrorRow(docId, deletion.id))?.staleReason, "text-changed");
  });

  test("2: Bob cannot edit inside Alice's pending insertion; it is not part of content", async () => {
    const editor = await env.connect(env.editor);
    const docId = await env.document(editor, "Hello world.");
    const alice = await env.connect(env.commenter);
    await alice.open(docId);
    const insertion = await suggest(alice, docId, env.commenter, {
      start: at(alice, docId, " world"),
      end: at(alice, docId, " world"),
      replacement: " brave new",
    });
    assert.equal(await serverText(env, docId), "Hello world.", "the insertion is not in content");
    const revision = await env.api("POST", `/v1/documents/${docId}/revisions`, env.editor, { label: "now" });
    const text = await env.api("GET", `/v1/documents/${docId}/revisions/${revision.body.id}/content`, env.editor);
    assert.equal(text.body.text, "Hello world.", "readers see the accepted truth");

    // Another commenter (Bob) cannot change Alice's suggestion text.
    const bobAccount = await env.member("commenter");
    const bob = await env.connect(bobAccount);
    await bob.open(docId);
    const tamper = bob.edit(docId, "annotations", (doc) => {
      const map = doc.getMap<SuggestionRecord>(AnnotationKeys.suggestions);
      map.set(insertion.id, { ...map.get(insertion.id)!, replacement: " cruel" });
    });
    assert.equal((await bob.rejected(tamper)).reason, "annotation-ownership");
    // Alice can, and the edited text is what gets applied.
    await alice.acked(
      alice.edit(docId, "annotations", (doc) => {
        const map = doc.getMap<SuggestionRecord>(AnnotationKeys.suggestions);
        map.set(insertion.id, { ...map.get(insertion.id)!, replacement: " bright", updatedAt: Date.now() });
      }),
    );
    assert.deepEqual(outcomes(await decide(env, env.editor, docId, [[insertion.id, "accept"]])), { [insertion.id]: "applied" });
    assert.equal(await serverText(env, docId), "Hello bright world.");
  });

  test("3: two reviewers deciding opposite ways at once: the first wins, the second learns who", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "A contested phrase.");
    const record = await suggest(client, docId, env.editor, { quote: "contested", replacement: "settled" });
    const seq = await env.server.server.context.rooms.currentServerSeq(docId);

    const [accept, reject] = await Promise.all([
      decide(env, env.editor, docId, [[record.id, "accept"]]),
      decide(env, env.editor2, docId, [[record.id, "reject"]]),
    ]);
    const results = [accept, reject].map((response) => response.body.results[0]);
    const winnerIndex = results.findIndex((result) => result.outcome !== "already-decided");
    assert.ok(winnerIndex >= 0, "one decision wins");
    const loser = results[1 - winnerIndex];
    const winner = winnerIndex === 0 ? env.editor : env.editor2;
    assert.equal(loser.outcome, "already-decided");
    assert.equal(loser.decidedBy.id, winner.id);

    const applied = await contentUpdatesAfter(docId, seq);
    if (winnerIndex === 0) {
      assert.equal(await serverText(env, docId), "A settled phrase.");
      assert.equal(applied.length, 1, "applied exactly once");
      assert.equal((await serverRecord(env, docId, record.id))?.status, "accepted");
    } else {
      assert.equal(await serverText(env, docId), "A contested phrase.");
      assert.equal(applied.length, 0);
      assert.equal((await serverRecord(env, docId, record.id))?.status, "rejected");
    }
    assert.equal((await serverRecord(env, docId, record.id))?.decidedBy, winner.id);
  });

  test("4: deleting a block that holds several suggestions makes each stale (target removed)", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "Before.\nBlock one two three.\nAfter.\n");
    const commenter = await env.connect(env.commenter);
    await commenter.open(docId);
    const one = await suggest(commenter, docId, env.commenter, { quote: "one", replacement: "1" });
    const two = await suggest(client, docId, env.editor, { quote: "two", replacement: "2" });
    const three = await suggest(commenter, docId, env.commenter, { quote: "three", replacement: "3" });
    const blockStart = at(client, docId, "Block");
    await edit(client, docId, blockStart, blockStart + "Block one two three.\n".length, "");
    const seq = await env.server.server.context.rooms.currentServerSeq(docId);

    const response = await decide(env, env.editor, docId, [[one.id, "accept"], [two.id, "accept"], [three.id, "accept"]]);
    assert.deepEqual(outcomes(response), { [one.id]: "stale", [two.id]: "stale", [three.id]: "stale" });
    assert.equal(await serverText(env, docId), "Before.\nAfter.\n");
    assert.equal((await contentUpdatesAfter(docId, seq)).length, 0, "none is applied");
    for (const record of [one, two, three]) {
      assert.equal((await serverRecord(env, docId, record.id))?.staleReason, "target-removed");
      assert.equal((await mirrorRow(docId, record.id))?.status, "stale");
    }
  });

  test("5: an offline accept of a suggestion that changed since is replayed and marked stale", async () => {
    const reviewer = await env.connect(env.editor2);
    const docId = await env.document(reviewer, "Offline review of this wording.");
    const author = await env.connect(env.commenter);
    await author.open(docId);
    const record = await suggest(author, docId, env.commenter, { quote: "this wording", replacement: "that phrasing" });
    await waitUntil(() => reviewer.doc(docId, "annotations").getMap(AnnotationKeys.suggestions).has(record.id), "reviewer sees it");
    // The reviewer goes offline and accepts; meanwhile an editor changes the text.
    await reviewer.close();
    const editor = await env.connect(env.editor);
    await editor.open(docId);
    await edit(editor, docId, at(editor, docId, "wording"), at(editor, docId, "wording") + 7, "phrase");

    // Reconnect: pending_commands replays the decision.
    const replay = await env.api("POST", "/v1/commands", env.editor2, {
      id: "cmd_hardcase5_accept",
      kind: "suggestions.decide",
      docId,
      body: { decisions: [{ suggestionId: record.id, decision: "accept" }] },
    });
    assert.equal(replay.body.status, 200);
    assert.deepEqual(outcomes({ body: replay.body.body }), { [record.id]: "stale" });
    assert.equal(await serverText(env, docId), "Offline review of this phrase.");
    assert.equal((await serverRecord(env, docId, record.id))?.status, "stale");
    assert.equal((await serverRecord(env, docId, record.id))?.staleReason, "text-changed");
  });

  test("6: accept-all across several authors checkpoints, applies in order, skips stale, and one restore undoes it", async () => {
    const editor = await env.connect(env.editor);
    const docId = await env.document(editor, "alpha beta gamma delta");
    const commenter = await env.connect(env.commenter);
    await commenter.open(docId);
    const second = await env.connect(env.editor2);
    await second.open(docId);
    const a = await suggest(commenter, docId, env.commenter, { quote: "alpha", replacement: "A" });
    const b = await suggest(second, docId, env.editor2, { quote: "beta", replacement: "B" });
    const g = await suggest(commenter, docId, env.commenter, {
      quote: "gamma",
      replacement: "G",
      actor: { kind: "ai", onBehalfOf: env.commenter.id, feature: "rewrite", model: "m" },
    });
    const d = await suggest(editor, docId, env.editor, { quote: "delta", replacement: "D" });
    await edit(editor, docId, at(editor, docId, "beta"), at(editor, docId, "beta") + 1, "B");
    const before = await serverText(env, docId);

    const response = await decide(env, env.editor, docId, [[d.id, "accept"], [g.id, "accept"], [b.id, "accept"], [a.id, "accept"]]);
    assert.deepEqual(outcomes(response), { [a.id]: "applied", [b.id]: "stale", [g.id]: "applied", [d.id]: "applied" });
    assert.equal(await serverText(env, docId), "A Beta G D");
    assert.ok(response.body.checkpointRevisionId);

    const undo = await env.api("POST", `/v1/documents/${docId}/restore`, env.editor, { revisionId: response.body.checkpointRevisionId });
    assert.equal(undo.status, 200);
    assert.equal(await serverText(env, docId), before, "one step restores the text before the batch");
  });

  test("7: an AI suggestion computed on an old snapshot: matching edits are live, others stale at once", async () => {
    const editor = await env.connect(env.editor);
    const docId = await env.document(editor, "The model is fast. The data is clean.");
    // The AI read this snapshot 40 s ago; the text has changed since.
    const ai = await env.connect(env.commenter);
    await ai.open(docId);
    await edit(editor, docId, at(editor, docId, "clean"), at(editor, docId, "clean") + 5, "noisy");
    await waitUntil(() => ai.text(docId).includes("noisy"), "the AI's client is live");
    const actor = { kind: "ai" as const, onBehalfOf: env.commenter.id, feature: "agentic-review" as const, model: "m", runId: "run_1" };

    const matched = await suggest(ai, docId, env.commenter, { quote: "fast", replacement: "quick", actor, groupId: "grp_run_1" });
    // The client library creates non-matching edits as stale ("conflicted")...
    const conflicted = await suggest(ai, docId, env.commenter, {
      quote: "noisy",
      baseQuote: "clean",
      replacement: "spotless",
      actor,
      status: "stale",
    });
    // ...and a client that sends one as pending gets it marked stale by the server.
    const late = await suggest(ai, docId, env.commenter, { quote: "noisy", baseQuote: "clean", replacement: "pristine", actor });

    await waitUntil(async () => (await serverRecord(env, docId, late.id))?.status === "stale", "the server marks it stale on arrival");
    assert.equal((await serverRecord(env, docId, late.id))?.staleReason, "text-changed");
    assert.equal((await serverRecord(env, docId, matched.id))?.status, "pending");
    const rows = Object.fromEntries(
      ((await env.api("GET", `/v1/documents/${docId}/suggestions`, env.viewer)).body as Array<Record<string, any>>).map((row) => [row.id, row]),
    );
    assert.equal(rows[matched.id].status, "pending");
    assert.equal(rows[conflicted.id].status, "stale");
    assert.equal(rows[late.id].status, "stale");
    assert.deepEqual(rows[matched.id].actor, { kind: "ai", onBehalfOf: env.commenter.id, feature: "agentic-review", model: "m", runId: "run_1" });

    // AI cannot accept, even when acting for an editor; the editor can.
    const byAi = await decide(env, env.editor, docId, [[matched.id, "accept"]], { ai: { feature: "agentic-review" } });
    assert.equal(byAi.body.error.code, "ai-cannot-decide");
    const response = await decide(env, env.editor, docId, [[matched.id, "accept"], [late.id, "accept"]]);
    assert.deepEqual(outcomes(response), { [matched.id]: "applied", [late.id]: "stale" });
    assert.equal(await serverText(env, docId), "The model is quick. The data is noisy.");
  });
});
