// Suggestions: the table mirror, decisions (M3.3) and revert, with
// suggestions written into annotations by real sync clients the way the
// client library writes them.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { MessageType, type EventMessage } from "../src/protocol.js";
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

describe("suggestions", () => {
  let env: CollabEnv;
  before(async () => {
    env = await startCollab();
  });
  after(() => env.close());

  const list = async (docId: string) => {
    const response = await env.api("GET", `/v1/documents/${docId}/suggestions`, env.viewer);
    assert.equal(response.status, 200);
    return response.body as Array<Record<string, any>>;
  };
  const updateAt = (docId: string, serverSeq: number) =>
    env.db.selectFrom("doc_updates").selectAll().where("doc_id", "=", docId).where("server_seq", "=", serverSeq).executeTakeFirstOrThrow();

  test("an overlay written by a commenter is mirrored, and accepting applies it once with attribution", async () => {
    const editorClient = await env.connect(env.editor);
    const docId = await env.document(editorClient, "The cat sat on the mat.");
    const commenter = await env.connect(env.commenter);
    await commenter.open(docId);
    const record = await suggest(commenter, docId, env.commenter, { quote: "cat", replacement: "dog" });
    assert.equal(await serverText(env, docId), "The cat sat on the mat.", "a pending suggestion is not content");

    // The persisted-update hook mirrors it without anyone listing.
    await waitUntil(
      async () => (await env.db.selectFrom("suggestions").select("id").where("id", "=", record.id).executeTakeFirst()) !== undefined,
      "the hook mirrors the suggestion",
    );
    const [mirrored] = await list(docId);
    assert.equal(mirrored.id, record.id);
    assert.equal(mirrored.status, "pending");
    assert.equal(mirrored.baseQuote, "cat");
    assert.equal(mirrored.replacement, "dog");
    assert.equal(mirrored.createdBy.id, env.commenter.id);
    assert.deepEqual(mirrored.actor, { kind: "user", userId: env.commenter.id });

    const accepted = await decide(env, env.editor, docId, [[record.id, "accept"]]);
    assert.equal(accepted.status, 200);
    assert.deepEqual(outcomes(accepted), { [record.id]: "applied" });
    assert.equal(accepted.body.checkpointRevisionId, null);
    assert.equal(await serverText(env, docId), "The dog sat on the mat.");
    await waitUntil(() => editorClient.text(docId) === "The dog sat on the mat.", "the editor receives the change");

    const updates = await env.db
      .selectFrom("doc_updates")
      .selectAll()
      .where("doc_id", "=", docId)
      .where("subdoc", "=", "content")
      .where("client_id", "=", "server")
      .execute();
    assert.equal(updates.length, 1, "applied exactly once");
    assert.deepEqual(updates[0].actor, { kind: "user", userId: env.editor.id });
    assert.equal(updates[0].account_id, env.editor.id);
    assert.deepEqual(updates[0].provenance, {
      source: "suggestion",
      suggestionId: record.id,
      suggestedBy: { kind: "user", userId: env.commenter.id },
    });

    const overlay = await serverRecord(env, docId, record.id);
    assert.equal(overlay?.status, "accepted");
    assert.equal(overlay?.decidedBy, env.editor.id);
    assert.ok(overlay?.appliedStart && overlay.appliedEnd);
    const [row] = await list(docId);
    assert.equal(row.status, "accepted");
    assert.equal(row.decidedBy.id, env.editor.id);
    const stored = await env.db.selectFrom("suggestions").select("decision_server_seq").where("id", "=", record.id).executeTakeFirstOrThrow();
    assert.equal(stored.decision_server_seq, updates[0].server_seq);

    const event = await editorClient.waitFor<EventMessage>((m) => m.type === MessageType.Event && m.kind === "suggestion.decided");
    assert.deepEqual(event.payload, {
      suggestionId: record.id,
      outcome: "applied",
      decidedBy: { id: env.editor.id, displayName: env.editor.id, color: "#3366ff" },
    });

    // A second accept (or a reject) changes nothing.
    const again = await decide(env, env.editor2, docId, [[record.id, "reject"]]);
    assert.deepEqual(outcomes(again), { [record.id]: "already-decided" });
    assert.equal(again.body.results[0].decidedBy.id, env.editor.id);
    assert.equal(await serverText(env, docId), "The dog sat on the mat.");

    const audit = await env.db.selectFrom("audit_log").selectAll().where("action", "=", "suggestion.decide").where("target", "=", record.id).execute();
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].actor, { kind: "user", userId: env.editor.id });
    assert.equal((audit[0].details as Record<string, unknown>).outcome, "applied");
  });

  test("reject only records the decision", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "Keep this sentence.");
    const record = await suggest(client, docId, env.editor, { quote: "Keep", replacement: "Drop" });
    const seq = await env.server.server.context.rooms.currentServerSeq(docId);
    const rejected = await decide(env, env.owner, docId, [[record.id, "reject"]]);
    assert.deepEqual(outcomes(rejected), { [record.id]: "rejected" });
    assert.equal(await serverText(env, docId), "Keep this sentence.");
    const contentUpdates = await env.db
      .selectFrom("doc_updates")
      .select("server_seq")
      .where("doc_id", "=", docId)
      .where("subdoc", "=", "content")
      .where("server_seq", ">", seq)
      .execute();
    assert.equal(contentUpdates.length, 0);
    assert.equal((await serverRecord(env, docId, record.id))?.status, "rejected");
    assert.equal((await list(docId))[0].status, "rejected");
  });

  test("a changed target makes the suggestion stale (text-changed); a deleted one target-removed", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "One two three four five.");
    const changed = await suggest(client, docId, env.editor, { quote: "two three", replacement: "2 3" });
    const removed = await suggest(client, docId, env.editor, { quote: "five", replacement: "5" });
    await edit(client, docId, at(client, docId, "three"), at(client, docId, "three") + 5, "THREE");
    await edit(client, docId, at(client, docId, "five"), at(client, docId, "five") + 4, "");

    const response = await decide(env, env.editor, docId, [[changed.id, "accept"], [removed.id, "accept"]]);
    assert.deepEqual(outcomes(response), { [changed.id]: "stale", [removed.id]: "stale" });
    assert.equal(await serverText(env, docId), "One two THREE four .");
    assert.equal((await serverRecord(env, docId, changed.id))?.staleReason, "text-changed");
    assert.equal((await serverRecord(env, docId, removed.id))?.staleReason, "target-removed");
    const rows = Object.fromEntries((await list(docId)).map((row) => [row.id, row]));
    assert.equal(rows[changed.id].status, "stale");
    assert.equal(rows[changed.id].staleReason, "text-changed");
    assert.equal(rows[removed.id].staleReason, "target-removed");
    // A stale suggestion can still be dismissed.
    assert.deepEqual(outcomes(await decide(env, env.editor, docId, [[changed.id, "reject"]])), { [changed.id]: "rejected" });
  });

  test("insertion suggestions follow the client's neighbour rules", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "ab cd ef gh");
    const point = (needle: string) => at(client, docId, needle) + 1;
    const applies = await suggest(client, docId, env.editor, { start: point("ab"), end: point("ab"), replacement: "X" });
    const oneGone = await suggest(client, docId, env.editor, { start: point("cd"), end: point("cd"), replacement: "Y" });
    const bothGone = await suggest(client, docId, env.editor, { start: point("ef"), end: point("ef"), replacement: "Z" });
    const typedAt = await suggest(client, docId, env.editor, { start: point("gh"), end: point("gh"), replacement: "W" });
    assert.equal(applies.baseQuote, "");
    assert.equal(applies.start.assoc, -1);
    assert.equal(applies.end.assoc ?? 0, 0);

    await edit(client, docId, at(client, docId, "cd"), at(client, docId, "cd") + 1, ""); // c gone, d stays
    await edit(client, docId, at(client, docId, "ef"), at(client, docId, "ef") + 2, ""); // both neighbours gone
    await edit(client, docId, point("gh"), point("gh"), "!"); // typed at the point

    const response = await decide(env, env.editor, docId, [
      [applies.id, "accept"],
      [oneGone.id, "accept"],
      [bothGone.id, "accept"],
      [typedAt.id, "accept"],
    ]);
    assert.deepEqual(outcomes(response), {
      [applies.id]: "applied",
      [oneGone.id]: "stale",
      [bothGone.id]: "stale",
      [typedAt.id]: "stale",
    });
    assert.equal(await serverText(env, docId), "aXb d  g!h");
    assert.equal((await serverRecord(env, docId, oneGone.id))?.staleReason, "text-changed");
    assert.equal((await serverRecord(env, docId, bothGone.id))?.staleReason, "target-removed");
    assert.equal((await serverRecord(env, docId, typedAt.id))?.staleReason, "text-changed");
  });

  test("linked suggestions are decided together, all or nothing", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "alpha beta gamma delta");
    const ok1 = await suggest(client, docId, env.editor, { quote: "alpha", replacement: "ALPHA", groupId: "grp_ok" });
    const ok2 = await suggest(client, docId, env.editor, { quote: "gamma", replacement: "GAMMA", groupId: "grp_ok" });
    const bad1 = await suggest(client, docId, env.editor, { quote: "beta", replacement: "BETA", groupId: "grp_bad" });
    const bad2 = await suggest(client, docId, env.editor, { quote: "delta", replacement: "DELTA", groupId: "grp_bad" });
    await edit(client, docId, at(client, docId, "delta"), at(client, docId, "delta") + 1, "D");

    // Deciding one member decides the group.
    const good = await decide(env, env.editor, docId, [[ok2.id, "accept"]]);
    assert.deepEqual(outcomes(good), { [ok2.id]: "applied", [ok1.id]: "applied" });
    const broken = await decide(env, env.editor, docId, [[bad1.id, "accept"]]);
    assert.deepEqual(outcomes(broken), { [bad1.id]: "stale", [bad2.id]: "stale" });
    assert.equal(await serverText(env, docId), "ALPHA beta GAMMA Delta", "no member of the stale group was applied");
    assert.equal((await serverRecord(env, docId, bad1.id))?.status, "stale");

    const conflicting = await decide(env, env.editor, docId, [[bad1.id, "accept"], [bad2.id, "reject"]]);
    assert.equal(conflicting.status, 400);
  });

  test("accept-all checkpoints first, applies in document order and skips stale suggestions", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "first second third fourth");
    const commenter = await env.connect(env.commenter);
    await commenter.open(docId);
    const fourth = await suggest(commenter, docId, env.commenter, { quote: "fourth", replacement: "4th" });
    const first = await suggest(client, docId, env.editor, { quote: "first", replacement: "1st" });
    const third = await suggest(commenter, docId, env.commenter, {
      quote: "third",
      replacement: "3rd",
      actor: { kind: "ai", onBehalfOf: env.commenter.id, feature: "agentic-review", model: "m" },
    });
    const second = await suggest(client, docId, env.editor, { quote: "second", replacement: "2nd" });
    await edit(client, docId, at(client, docId, "second"), at(client, docId, "second") + 6, "SECOND");
    const before = await serverText(env, docId);
    const seq = await env.server.server.context.rooms.currentServerSeq(docId);

    const response = await decide(env, env.editor, docId, [
      [fourth.id, "accept"],
      [third.id, "accept"],
      [second.id, "accept"],
      [first.id, "accept"],
    ]);
    assert.deepEqual(outcomes(response), { [fourth.id]: "applied", [third.id]: "applied", [second.id]: "stale", [first.id]: "applied" });
    assert.equal(await serverText(env, docId), "1st SECOND 3rd 4th");

    const checkpoint = await env.api("GET", `/v1/documents/${docId}/revisions/${response.body.checkpointRevisionId}/content`, env.editor);
    assert.equal(checkpoint.body.revision.kind, "pre-accept-all");
    assert.equal(checkpoint.body.revision.serverSeq, seq);
    assert.equal(checkpoint.body.text, before);

    const applied = await env.db
      .selectFrom("doc_updates")
      .select(["server_seq", "provenance"])
      .where("doc_id", "=", docId)
      .where("subdoc", "=", "content")
      .where("server_seq", ">", seq)
      .orderBy("server_seq")
      .execute();
    assert.deepEqual(
      applied.map((row) => (row.provenance as { suggestionId: string }).suggestionId),
      [first.id, third.id, fourth.id],
      "document order",
    );
    assert.deepEqual((applied[1].provenance as { suggestedBy: unknown }).suggestedBy, {
      kind: "ai",
      onBehalfOf: env.commenter.id,
      feature: "agentic-review",
      model: "m",
    });
    const summary = await env.db.selectFrom("audit_log").selectAll().where("action", "=", "suggestions.decide-all").where("target", "=", docId).execute();
    assert.equal(summary.length, 1);
  });

  test("checkpoint: true takes a checkpoint for a single decision", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "solo");
    const record = await suggest(client, docId, env.editor, { quote: "solo", replacement: "SOLO" });
    const response = await decide(env, env.editor, docId, [[record.id, "accept"]], { checkpoint: true });
    assert.ok(response.body.checkpointRevisionId);
  });

  test("revert restores baseQuote when the replacement is untouched, and reports a conflict otherwise", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "red green blue");
    const green = await suggest(client, docId, env.editor, { quote: "green", replacement: "teal" });
    const blue = await suggest(client, docId, env.editor, { quote: " blue", replacement: "" });
    await decide(env, env.editor, docId, [[green.id, "accept"], [blue.id, "accept"]]);
    assert.equal(await serverText(env, docId), "red teal");

    const reverted = await env.api("POST", `/v1/suggestions/${blue.id}/revert`, env.editor2, {});
    assert.equal(reverted.status, 200);
    assert.equal(reverted.body.outcome, "reverted");
    assert.equal(await serverText(env, docId), "red teal blue");
    const row = await updateAt(docId, reverted.body.serverSeq);
    assert.deepEqual(row.actor, { kind: "user", userId: env.editor2.id });
    assert.equal((await serverRecord(env, docId, blue.id))?.status, "pending");
    // Reverted suggestions can be decided again.
    assert.deepEqual(outcomes(await decide(env, env.editor, docId, [[blue.id, "accept"]])), { [blue.id]: "applied" });
    assert.equal(await serverText(env, docId), "red teal");

    await waitUntil(() => client.text(docId) === "red teal", "client caught up");
    await edit(client, docId, at(client, docId, "teal"), at(client, docId, "teal") + 4, "cyan");
    const conflict = await env.api("POST", `/v1/suggestions/${green.id}/revert`, env.editor, {});
    assert.equal(conflict.status, 200);
    assert.equal(conflict.body.outcome, "conflict");
    assert.equal(await serverText(env, docId), "red cyan");

    const pending = await suggest(client, docId, env.editor, { quote: "red", replacement: "RED" });
    await env.api("GET", `/v1/documents/${docId}/suggestions`, env.editor);
    assert.equal((await env.api("POST", `/v1/suggestions/${pending.id}/revert`, env.editor, {})).status, 409);
    const audit = await env.db.selectFrom("audit_log").select("details").where("action", "=", "suggestion.revert").execute();
    assert.ok(audit.length >= 2);
  });

  test("AI actors, commenters and viewers cannot decide", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "guarded text");
    const record = await suggest(client, docId, env.editor, { quote: "guarded", replacement: "open" });
    const ai = await decide(env, env.editor, docId, [[record.id, "accept"]], { ai: { feature: "agent", model: "m" } });
    assert.equal(ai.status, 403);
    assert.equal(ai.body.error.code, "ai-cannot-decide");
    assert.equal((await decide(env, env.commenter, docId, [[record.id, "accept"]])).status, 403);
    assert.equal((await decide(env, env.viewer, docId, [[record.id, "reject"]])).status, 403);
    await env.api("GET", `/v1/documents/${docId}/suggestions`, env.editor);
    const revertAi = await env.api("POST", `/v1/suggestions/${record.id}/revert`, env.editor, { ai: { feature: "agent" } });
    assert.equal(revertAi.body.error.code, "ai-cannot-decide");
    assert.equal(await serverText(env, docId), "guarded text");
    assert.equal((await serverRecord(env, docId, record.id))?.status, "pending");
    const unknown = await decide(env, env.editor, docId, [["sg_does_not_exist", "accept"]]);
    assert.deepEqual(outcomes(unknown), { sg_does_not_exist: "not-found" });
  });

  test("an offline decision replayed through /v1/commands is validated against the text as it is then", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "Offline target here.");
    const record = await suggest(client, docId, env.editor, { quote: "target", replacement: "goal" });
    // The reviewer decided offline; meanwhile the text changed.
    await edit(client, docId, at(client, docId, "target"), at(client, docId, "target") + 6, "aim");
    const command = { id: "cmd_offline_accept_1", kind: "suggestions.decide", docId, body: { decisions: [{ suggestionId: record.id, decision: "accept" }] } };
    const replay = await env.api("POST", "/v1/commands", env.editor2, command);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.status, 200);
    assert.deepEqual(outcomes({ body: replay.body.body }), { [record.id]: "stale" });
    assert.equal(await serverText(env, docId), "Offline aim here.");
    // The replay of the replay returns the stored result.
    assert.deepEqual(await env.api("POST", "/v1/commands", env.editor2, command), replay);
  });
});
