// Formal review (M3.5): requests, decisions bound to revisions, outdated
// approvals, status rules, close and notifications, against the real sync
// service.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { AnnotationKeys, MessageType, type EventMessage, type Review } from "../src/protocol.js";
import { anchor, at, edit, startCollab, waitUntil, type CollabEnv } from "./support/decisions-env.js";

describe("reviews", () => {
  let env: CollabEnv;
  before(async () => {
    env = await startCollab();
  });
  after(() => env.close());

  const create = (docId: string, body: unknown, account = env.editor) => env.api("POST", `/v1/documents/${docId}/reviews`, account, body);
  const decideReview = (reviewId: string, account: typeof env.editor, body: unknown) =>
    env.api("POST", `/v1/reviews/${reviewId}/decision`, account, body);
  const reviews = async (docId: string): Promise<Review[]> => {
    const response = await env.api("GET", `/v1/documents/${docId}/reviews`, env.viewer);
    assert.equal(response.status, 200);
    return response.body;
  };
  const notifications = (account: typeof env.editor, kind: string) =>
    env.db.selectFrom("notifications").selectAll().where("account_id", "=", account.id).where("kind", "=", kind).execute();
  const audit = (action: string, target: string) =>
    env.db.selectFrom("audit_log").selectAll().where("action", "=", action).where("target", "=", target).execute();

  test("a range review: approvals stay green after edits outside the scope and go outdated after edits inside", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "Intro text.\nThe reviewed claim holds.\nOutro text.\n");
    const scopeStart = at(client, docId, "The reviewed");
    const scope = await anchor(client, docId, env.editor, scopeStart, scopeStart + "The reviewed claim holds.".length);

    const created = await create(docId, {
      scope: { kind: "range", anchorId: scope.id, quote: "The reviewed claim holds." },
      assignees: [env.editor2.id, env.commenter.id],
      note: "Please check the claim.",
    });
    assert.equal(created.status, 201);
    const review: Review = created.body;
    assert.equal(review.status, "open");
    assert.deepEqual(review.scope, { kind: "range", anchorId: scope.id, quote: "The reviewed claim holds." });
    assert.deepEqual(review.assignments.map((assignment) => assignment.decision), ["pending", "pending"]);
    const base = await env.db.selectFrom("revisions").selectAll().where("id", "=", review.baseRevisionId).executeTakeFirstOrThrow();
    assert.equal(base.kind, "review-base");
    assert.equal(base.server_seq, await env.server.server.context.rooms.currentServerSeq(docId));
    const scopes = await env.server.server.context.rooms.withDocs(docId, (docs) =>
      docs.annotations.getMap<Record<string, unknown>>(AnnotationKeys.reviewScopes).get(review.id),
    );
    assert.equal(scopes?.anchorId, scope.id);
    assert.equal((await notifications(env.editor2, "review-requested")).length, 1);
    assert.equal((await notifications(env.commenter, "review-requested")).length, 1);
    assert.equal((await audit("review.request", review.id)).length, 1);

    // Any role decides when assigned; the commenter is a reviewer here.
    const first = await decideReview(review.id, env.commenter, { decision: "approved" });
    assert.equal(first.status, 200);
    assert.equal(first.body.status, "open", "one of two approvals");
    const second = await decideReview(review.id, env.editor2, { decision: "approved", comment: "LGTM" });
    assert.equal(second.body.status, "approved");
    assert.ok(second.body.assignments.every((assignment: { decidedRevisionId: string | null }) => assignment.decidedRevisionId));
    const decided = await notifications(env.editor, "review-decided");
    assert.equal(decided.length, 2);
    assert.equal(decided.find((row) => (row.payload as { comment: string | null }).comment === "LGTM")?.payload.decision, "approved");

    // Edits outside the scope (also right next to it) leave the approvals alone.
    await edit(client, docId, 0, 5, "Opening");
    await edit(client, docId, at(client, docId, "The reviewed"), at(client, docId, "The reviewed"), ">> ");
    let [current] = await reviews(docId);
    assert.equal(current.status, "approved");
    assert.ok(current.assignments.every((assignment) => !assignment.outdated));
    assert.equal(current.changesSinceBase, 0);

    // An edit inside the scope outdates them, and the server announces it unprompted.
    const watcher = await env.connect(env.viewer);
    await watcher.open(docId);
    await edit(client, docId, at(client, docId, "holds"), at(client, docId, "holds") + 5, "fails");
    const event = await watcher.waitFor<EventMessage>(
      (m) => m.type === MessageType.Event && m.kind === "review.changed" && (m.payload as { review: Review }).review.status === "open",
    );
    assert.ok((event.payload as { review: Review }).review.assignments.every((assignment) => assignment.outdated));
    [current] = await reviews(docId);
    assert.equal(current.status, "open");
    assert.equal(current.changesSinceBase, 1);

    // Deciding again on the current text clears the reviewer's outdated flag.
    const fresh = await decideReview(review.id, env.editor2, { decision: "approved" });
    const flags = Object.fromEntries(fresh.body.assignments.map((assignment: { reviewer: { id: string }; outdated: boolean }) => [assignment.reviewer.id, assignment.outdated]));
    assert.deepEqual(flags, { [env.editor2.id]: false, [env.commenter.id]: true });
    assert.equal(fresh.body.status, "open");
  });

  test("document reviews: changes requested wins, decisions on old revisions are outdated at once", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "Whole document.");
    const created = await create(docId, { scope: { kind: "document" }, assignees: [env.editor2.id, env.owner.id] });
    const review: Review = created.body;

    const requested = await decideReview(review.id, env.owner, { decision: "changes-requested" });
    assert.equal(requested.body.status, "changes-requested");
    const approved = await decideReview(review.id, env.editor2, { decision: "approved", revisionId: review.baseRevisionId });
    assert.equal(approved.body.status, "changes-requested");

    // A decision on the base revision after the text changed is outdated immediately.
    await edit(client, docId, 0, 5, "Entire");
    const late = await decideReview(review.id, env.editor2, { decision: "approved", revisionId: review.baseRevisionId });
    const mine = late.body.assignments.find((assignment: { reviewer: { id: string } }) => assignment.reviewer.id === env.editor2.id);
    assert.equal(mine.outdated, true);
    assert.equal(mine.decidedRevisionId, review.baseRevisionId);
    const [listed] = await reviews(docId);
    assert.equal(listed.changesSinceBase, 1);

    const owner = await decideReview(review.id, env.owner, { decision: "approved" });
    assert.equal(owner.body.status, "open", "an outdated approval is not green");
    const renewed = await decideReview(review.id, env.editor2, { decision: "approved" });
    assert.equal(renewed.body.status, "approved");
  });

  test("permissions: requests need editor+, decisions need an assignment, AI never decides", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "Guarded.");
    assert.equal((await create(docId, { scope: { kind: "document" }, assignees: [env.editor2.id] }, env.commenter)).status, 403);
    const aiRequest = await create(docId, { scope: { kind: "document" }, assignees: [env.editor2.id], ai: { feature: "agentic-review" } });
    assert.equal(aiRequest.body.error.code, "ai-cannot-decide");
    const outsider = await create(docId, { scope: { kind: "document" }, assignees: ["acc_not_a_member"] });
    assert.equal(outsider.status, 400);
    const badAnchor = await create(docId, { scope: { kind: "range", anchorId: "anc_missing_1", quote: "x" }, assignees: [env.editor2.id] });
    assert.equal(badAnchor.status, 400);

    const review: Review = (await create(docId, { scope: { kind: "document" }, assignees: [env.editor2.id] })).body;
    assert.equal((await decideReview(review.id, env.commenter, { decision: "approved" })).status, 403);
    const ai = await decideReview(review.id, env.editor2, { decision: "approved", ai: { feature: "agentic-review" } });
    assert.equal(ai.status, 403);
    assert.equal(ai.body.error.code, "ai-cannot-decide");

    // Offline decision replayed through /v1/commands.
    const command = await env.api("POST", "/v1/commands", env.editor2, {
      id: "cmd_review_decide_1",
      kind: "review.decide",
      reviewId: review.id,
      body: { decision: "approved" },
    });
    assert.equal(command.body.status, 200);
    assert.equal(command.body.body.status, "approved");
    const entries = await audit("review.decide", review.id);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].actor, { kind: "user", userId: env.editor2.id });
  });

  test("close: by the requester or the owner only, and closed reviews take no decisions", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "Closing.");
    const first: Review = (await create(docId, { scope: { kind: "document" }, assignees: [env.editor2.id] })).body;
    assert.equal((await env.api("POST", `/v1/reviews/${first.id}/close`, env.editor2)).status, 403);
    const closed = await env.api("POST", `/v1/reviews/${first.id}/close`, env.editor);
    assert.equal(closed.status, 200);
    assert.equal(closed.body.status, "closed");
    assert.ok(closed.body.closedAt);
    assert.equal((await decideReview(first.id, env.editor2, { decision: "approved" })).status, 409);
    assert.equal((await audit("review.close", first.id)).length, 1);

    const second: Review = (await create(docId, { scope: { kind: "document" }, assignees: [env.editor2.id] })).body;
    const byOwner = await env.api("POST", `/v1/reviews/${second.id}/close`, env.owner);
    assert.equal(byOwner.body.status, "closed");
    assert.equal((await env.api("POST", `/v1/reviews/${second.id}/close`, env.owner)).status, 200, "closing twice is harmless");
    assert.equal((await env.api("POST", "/v1/reviews/rvw_missing/close", env.owner)).status, 404);
  });
});
