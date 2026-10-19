import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { registerCommandHandler } from "../src/api/commands.js";
import { runDigest } from "../src/jobs/digest.js";
import { EventKind, type CommandResult, type NotificationInfo, type Thread, type ThreadMessage } from "../src/protocol.js";
import { errorCode, request, startApi, team, type ApiHarness, type TestUser } from "./support/api-harness.js";

let h: ApiHarness;
before(async () => {
  h = await startApi();
});
after(() => h.close());

let sequence = 0;
function id(prefix: string): string {
  sequence += 1;
  return `${prefix}_${String(sequence).padStart(8, "0")}`;
}

async function setup() {
  const people = await team(h);
  const docId = id("doc");
  const created = await request(h, "POST", `/v1/projects/${people.project.id}/documents`, people.editor, {
    docId,
    fileId: id("file"),
    kind: "markdown",
  });
  assert.equal(created.status, 201);
  return { ...people, docId };
}

async function notifications(user: TestUser, query = ""): Promise<NotificationInfo[]> {
  return (await request(h, "GET", `/v1/notifications${query}`, user)).body;
}

describe("threads", () => {
  test("viewers cannot comment; commenters create threads idempotently", async () => {
    const { docId, viewer, commenter, editor } = await setup();
    const threadId = id("thr");
    const body = { id: threadId, anchorId: id("anc"), quote: "some text", body: "Is this right?", mentions: [editor.id] };

    const byViewer = await request(h, "POST", `/v1/documents/${docId}/threads`, viewer, body);
    assert.equal(byViewer.status, 403);
    assert.equal(errorCode(byViewer), "forbidden");

    h.events.length = 0;
    const created = await request(h, "POST", `/v1/documents/${docId}/threads`, commenter, body);
    assert.equal(created.status, 201);
    const thread = created.body as Thread;
    assert.equal(thread.status, "open");
    assert.equal(thread.createdBy.id, commenter.id);
    assert.equal(thread.createdBy.displayName, "commenter");
    assert.deepEqual(thread.actor, { kind: "user", userId: commenter.id });
    assert.equal(thread.messages.length, 1);
    assert.equal(thread.messages[0].id, threadId, "the opening message shares the thread id");
    assert.equal(thread.messages[0].author.id, commenter.id);
    assert.deepEqual(thread.messages[0].mentions, [editor.id]);
    const event = h.events.find((entry) => entry.kind === EventKind.ThreadChanged);
    assert.equal(event?.scope, "doc");
    assert.equal(event?.id, docId);
    assert.equal((event?.payload as { thread: Thread }).thread.id, threadId);

    const replay = await request(h, "POST", `/v1/documents/${docId}/threads`, commenter, body);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, threadId);
    const count = await h.context.db.selectFrom("messages").select("id").where("thread_id", "=", threadId).execute();
    assert.equal(count.length, 1);
    const stolen = await request(h, "POST", `/v1/documents/${docId}/threads`, editor, body);
    assert.equal(stolen.status, 409);

    const list = await request(h, "GET", `/v1/documents/${docId}/threads`, viewer);
    assert.equal(list.status, 200);
    assert.deepEqual((list.body as Thread[]).map((entry) => entry.id), [threadId]);
    assert.equal((await request(h, "GET", `/v1/threads/${threadId}`, viewer)).body.id, threadId);

    const mention = (await notifications(editor)).find((entry) => entry.kind === "mention");
    assert.equal(mention?.payload.threadId, threadId);
    assert.equal(mention?.docId, docId);
    assert.ok(h.events.some((entry) => entry.scope === "user" && entry.id === editor.id && entry.kind === EventKind.Notification));
  });

  test("AI-authored comments carry an AI actor bound to the caller", async () => {
    const { docId, commenter, outsider } = await setup();
    const created = await request(h, "POST", `/v1/documents/${docId}/threads`, commenter, {
      id: id("thr"),
      anchorId: id("anc"),
      quote: "q",
      body: "AI note",
      ai: { feature: "review-comments", model: "some/model", runId: "run-1" },
      mentions: [outsider.id],
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.actor, { kind: "ai", onBehalfOf: commenter.id, feature: "review-comments", model: "some/model", runId: "run-1" });
    assert.deepEqual(created.body.messages[0].mentions, [], "non-members are not mentioned");
    const badFeature = await request(h, "POST", `/v1/documents/${docId}/threads`, commenter, {
      id: id("thr"),
      anchorId: id("anc"),
      quote: "q",
      body: "x",
      ai: { feature: "hack" },
    });
    assert.equal(badFeature.status, 400);
  });

  test("replies notify the thread author and earlier repliers", async () => {
    const { docId, owner, editor, commenter } = await setup();
    const threadId = id("thr");
    await request(h, "POST", `/v1/documents/${docId}/threads`, commenter, { id: threadId, anchorId: id("anc"), quote: "q", body: "first" });

    const reply = { id: id("msg"), body: "a reply" };
    const byOwner = await request(h, "POST", `/v1/threads/${threadId}/messages`, owner, reply);
    assert.equal(byOwner.status, 201);
    assert.equal((byOwner.body as ThreadMessage).author.id, owner.id);
    assert.equal((await request(h, "POST", `/v1/threads/${threadId}/messages`, owner, reply)).status, 200, "idempotent");

    await request(h, "POST", `/v1/threads/${threadId}/messages`, editor, { id: id("msg"), body: "me too", mentions: [owner.id] });

    const commenterNotes = await notifications(commenter);
    assert.deepEqual(commenterNotes.map((entry) => entry.kind), ["reply", "reply"], "author hears about both replies");
    const ownerNotes = await notifications(owner);
    assert.deepEqual(ownerNotes.map((entry) => entry.kind), ["mention"], "a mention replaces the reply notice");
    assert.deepEqual(await notifications(editor), []);

    const thread = (await request(h, "GET", `/v1/threads/${threadId}`, editor)).body as Thread;
    assert.equal(thread.messages.length, 3);
  });

  test("edit and delete messages: own only, owners may delete any", async () => {
    const { docId, owner, editor, commenter } = await setup();
    const threadId = id("thr");
    await request(h, "POST", `/v1/documents/${docId}/threads`, commenter, { id: threadId, anchorId: id("anc"), quote: "q", body: "orig" });
    const replyId = id("msg");
    await request(h, "POST", `/v1/threads/${threadId}/messages`, editor, { id: replyId, body: "editor reply" });

    assert.equal((await request(h, "PATCH", `/v1/messages/${threadId}`, editor, { body: "hijack" })).status, 403);
    const edited = await request(h, "PATCH", `/v1/messages/${threadId}`, commenter, { body: "edited", mentions: [owner.id] });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.body, "edited");
    assert.ok(edited.body.editedAt);
    assert.equal((await notifications(owner, "?unread=1")).filter((entry) => entry.kind === "mention").length, 1);

    assert.equal((await request(h, "DELETE", `/v1/messages/${replyId}`, commenter)).status, 403);
    assert.equal((await request(h, "DELETE", `/v1/messages/${replyId}`, owner)).status, 204, "owner moderates");
    assert.equal((await request(h, "DELETE", `/v1/messages/${threadId}`, commenter)).status, 204);
    const thread = (await request(h, "GET", `/v1/threads/${threadId}`, owner)).body as Thread;
    assert.ok(thread.messages.every((message) => message.deletedAt && message.body === ""));
    assert.equal((await request(h, "PATCH", `/v1/messages/${threadId}`, commenter, { body: "back" })).status, 404);
  });

  test("status, reattach and delete", async () => {
    const { docId, editor, commenter, viewer } = await setup();
    const mine = id("thr");
    const theirs = id("thr");
    await request(h, "POST", `/v1/documents/${docId}/threads`, commenter, { id: mine, anchorId: id("anc"), quote: "q", body: "mine" });
    await request(h, "POST", `/v1/documents/${docId}/threads`, editor, { id: theirs, anchorId: id("anc"), quote: "q", body: "theirs" });

    assert.equal((await request(h, "POST", `/v1/threads/${theirs}/status`, commenter, { status: "resolved" })).status, 403);
    assert.equal((await request(h, "POST", `/v1/threads/${mine}/status`, viewer, { status: "resolved" })).status, 403);
    const resolved = await request(h, "POST", `/v1/threads/${mine}/status`, editor, { status: "resolved" });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.resolvedBy.id, editor.id);
    const resolvedNote = (await notifications(commenter)).find((entry) => entry.kind === "thread-resolved");
    assert.equal(resolvedNote?.payload.threadId, mine);

    const selfResolved = await request(h, "POST", `/v1/threads/${theirs}/status`, editor, { status: "resolved" });
    assert.equal(selfResolved.status, 200);
    const reopened = await request(h, "POST", `/v1/threads/${mine}/status`, commenter, { status: "detached" });
    assert.equal(reopened.body.status, "detached");
    assert.equal(reopened.body.resolvedBy, null);

    const newAnchor = id("anc");
    const reattached = await request(h, "POST", `/v1/threads/${mine}/reattach`, commenter, { anchorId: newAnchor, quote: "new quote" });
    assert.equal(reattached.status, 200);
    assert.deepEqual([reattached.body.anchorId, reattached.body.quote, reattached.body.status], [newAnchor, "new quote", "open"]);

    assert.equal((await request(h, "DELETE", `/v1/threads/${theirs}`, commenter)).status, 403);
    h.events.length = 0;
    assert.equal((await request(h, "DELETE", `/v1/threads/${mine}`, commenter)).status, 204);
    const deleted = h.events.find((entry) => entry.kind === EventKind.ThreadDeleted);
    assert.equal((deleted?.payload as { thread: Thread }).thread.id, mine);
    assert.equal((await request(h, "DELETE", `/v1/threads/${theirs}`, editor)).status, 204);
    assert.deepEqual((await request(h, "GET", `/v1/documents/${docId}/threads`, viewer)).body, []);
    assert.equal((await request(h, "GET", `/v1/threads/${mine}`, viewer)).status, 404);
  });
});

describe("notifications", () => {
  test("list unread and mark read", async () => {
    const { docId, owner, commenter } = await setup();
    for (let index = 0; index < 3; index += 1) {
      await request(h, "POST", `/v1/documents/${docId}/threads`, commenter, {
        id: id("thr"),
        anchorId: id("anc"),
        quote: "q",
        body: `ping ${index}`,
        mentions: [owner.id],
      });
    }
    const all = await notifications(owner);
    assert.equal(all.length, 3);
    assert.equal((await notifications(owner, "?limit=2")).length, 2);
    const one = await request(h, "POST", "/v1/notifications/read", owner, { ids: [all[0].id] });
    assert.equal(one.body.updated, 1);
    assert.equal((await notifications(owner, "?unread=1")).length, 2);
    assert.equal((await request(h, "POST", "/v1/notifications/read", owner, {})).status, 400);
    const rest = await request(h, "POST", "/v1/notifications/read", owner, { all: true });
    assert.equal(rest.body.updated, 2);
    assert.equal((await notifications(owner, "?unread=1")).length, 0);
    // Other people's notifications cannot be marked.
    const notMine = await request(h, "POST", "/v1/notifications/read", commenter, { ids: [all[1].id] });
    assert.equal(notMine.body.updated, 0);
  });

  test("the digest emails settled unread notifications once a day", async () => {
    const { docId, owner, commenter } = await setup();
    await request(h, "POST", `/v1/documents/${docId}/threads`, commenter, {
      id: id("thr"),
      anchorId: id("anc"),
      quote: "q",
      body: "please look",
      mentions: [owner.id],
    });
    h.mail.length = 0;
    assert.equal(await runDigest(h.context), 0, "too fresh");

    const past = new Date(Date.now() - 20 * 60_000);
    await h.context.db.updateTable("notifications").set({ created_at: past }).where("account_id", "=", owner.id).execute();
    assert.ok((await runDigest(h.context)) >= 1);
    const mail = h.mail.find((entry) => entry.to === owner.email);
    assert.ok(mail, "owner got a digest");
    assert.match(mail!.text, /mentioned you in "Notebook": please look/);
    const rows = await h.context.db.selectFrom("notifications").select("emailed_at").where("account_id", "=", owner.id).execute();
    assert.ok(rows.every((row) => row.emailed_at));

    // A new notification inside the 24 h window waits.
    await request(h, "POST", `/v1/documents/${docId}/threads`, commenter, {
      id: id("thr"),
      anchorId: id("anc"),
      quote: "q",
      body: "again",
      mentions: [owner.id],
    });
    await h.context.db.updateTable("notifications").set({ created_at: past }).where("account_id", "=", owner.id).execute();
    h.mail.length = 0;
    await runDigest(h.context);
    assert.equal(h.mail.filter((entry) => entry.to === owner.email).length, 0);
    assert.equal((await runDigest(h.context, new Date(Date.now() + 25 * 3600_000))) >= 1, true, "sent after a day");
  });
});

describe("commands", () => {
  async function command(user: TestUser, body: Record<string, unknown>) {
    const response = await request(h, "POST", "/v1/commands", user, body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body as CommandResult;
  }

  test("thread commands run the route handlers and replay their stored result", async () => {
    const { docId, commenter, viewer } = await setup();
    const threadId = id("thr");
    const create = { id: id("cmd"), kind: "thread.create", docId, body: { id: threadId, anchorId: id("anc"), quote: "q", body: "offline" } };
    const first = await command(commenter, create);
    assert.equal(first.status, 201);
    assert.equal((first.body as Thread).id, threadId);
    const replay = await command(commenter, create);
    assert.deepEqual(replay, first, "the stored result comes back unchanged");

    const reply = await command(commenter, { id: id("cmd"), kind: "message.create", threadId, body: { id: id("msg"), body: "more" } });
    assert.equal(reply.status, 201);
    const status = await command(commenter, { id: id("cmd"), kind: "thread.status", threadId, body: { status: "resolved" } });
    assert.equal(status.status, 200);
    assert.equal((status.body as Thread).status, "resolved");
    const edit = await command(commenter, { id: id("cmd"), kind: "message.edit", messageId: threadId, body: { body: "fixed" } });
    assert.equal(edit.status, 200);
    const reattach = await command(commenter, { id: id("cmd"), kind: "thread.reattach", threadId, body: { anchorId: id("anc"), quote: "z" } });
    assert.equal(reattach.status, 200);
    const delMessage = await command(commenter, { id: id("cmd"), kind: "message.delete", messageId: threadId });
    assert.equal(delMessage.status, 204);
    const delThread = await command(commenter, { id: id("cmd"), kind: "thread.delete", threadId });
    assert.equal(delThread.status, 204);

    // A definitive failure is stored too, so a replay gives the same answer.
    const denied = { id: id("cmd"), kind: "thread.create", docId, body: { id: id("thr"), anchorId: id("anc"), quote: "q", body: "x" } };
    const firstDenied = await command(viewer, denied);
    assert.equal(firstDenied.status, 403);
    await h.context.db.updateTable("memberships").set({ role: "commenter" }).where("account_id", "=", viewer.id).execute();
    assert.deepEqual(await command(viewer, denied), firstDenied);

    // Ids are per account: someone else's command id is a different command.
    const sameIdOtherUser = await command(viewer, { ...create, body: { ...create.body, id: id("thr") } });
    assert.equal(sameIdOtherUser.status, 201);
  });

  test("results that failed for the attempt are not stored, so a replay can succeed", async () => {
    const { docId, editor } = await setup();
    const cmd = { id: id("cmd"), kind: "revision.create", docId, body: { label: "v1" } };
    // The harness's stub sync service cannot answer, so the real handler fails with a 500.
    const first = await request(h, "POST", "/v1/commands", editor, cmd);
    assert.equal(first.status, 500);
    const stored = await h.context.db.selectFrom("commands").select("id").where("id", "=", cmd.id).execute();
    assert.equal(stored.length, 0);

    registerCommandHandler("revision.create", async (_context, accountId, received) => ({
      status: 201,
      body: { label: received.body.label, by: accountId },
    }));
    const later = await command(editor, cmd);
    assert.deepEqual(later, { id: cmd.id, status: 201, body: { label: "v1", by: editor.id } });
    assert.deepEqual(await command(editor, cmd), later);
  });

  test("malformed commands are rejected outright", async () => {
    const { editor } = await setup();
    assert.equal((await request(h, "POST", "/v1/commands", editor, { id: "short", kind: "thread.create" })).status, 400);
    assert.equal((await request(h, "POST", "/v1/commands", editor, { id: id("cmd"), kind: "drop.tables" })).status, 400);
    assert.equal((await request(h, "POST", "/v1/commands", null, { id: id("cmd"), kind: "thread.delete" })).status, 401);
  });
});
