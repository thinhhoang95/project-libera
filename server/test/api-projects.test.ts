import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { EventKind, type AuthResponse, type Invitation, type Member, type ProjectSummary } from "../src/protocol.js";
import { json } from "./helpers.js";
import { createProject, errorCode, register, request, startApi, team, type ApiHarness } from "./support/api-harness.js";

let h: ApiHarness;
before(async () => {
  h = await startApi();
});
after(() => h.close());

describe("projects", () => {
  test("create makes an owner membership and an empty manifest document", async () => {
    const owner = await register(h, "p-owner");
    const project = await createProject(h, owner, "Thesis");
    assert.equal(project.role, "owner");
    assert.equal(project.ownerId, owner.id);
    const manifest = await request(h, "GET", `/v1/documents/${project.manifestDocId}`, owner);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.body.kind, "manifest");
    assert.equal(manifest.body.lastServerSeq, 0);

    const list = await request(h, "GET", "/v1/projects", owner);
    assert.deepEqual(
      (list.body as ProjectSummary[]).map((entry) => [entry.id, entry.role]),
      [[project.id, "owner"]],
    );
    const one = await request(h, "GET", `/v1/projects/${project.id}`, owner);
    assert.equal(one.body.name, "Thesis");
    const empty = await request(h, "POST", "/v1/projects", owner, { name: "  " });
    assert.equal(empty.status, 400);
  });

  test("non-members get 404 and members see their role", async () => {
    const { project, viewer, outsider } = await team(h);
    assert.equal((await request(h, "GET", `/v1/projects/${project.id}`, outsider)).status, 404);
    const seen = await request(h, "GET", `/v1/projects/${project.id}`, viewer);
    assert.equal(seen.body.role, "viewer");
  });

  test("rename is owner only and AI hints cannot do it", async () => {
    const { project, owner, editor } = await team(h);
    const byEditor = await request(h, "PATCH", `/v1/projects/${project.id}`, editor, { name: "Mine now" });
    assert.equal(byEditor.status, 403);
    assert.equal(errorCode(byEditor), "forbidden");
    const byAi = await request(h, "PATCH", `/v1/projects/${project.id}`, owner, { name: "AI", ai: { feature: "agent" } });
    assert.equal(byAi.status, 403);
    assert.equal(errorCode(byAi), "ai-cannot-decide");
    const renamed = await request(h, "PATCH", `/v1/projects/${project.id}`, owner, { name: "Renamed" });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, "Renamed");
  });

  test("delete is owner only, erases server records, and closes every document", async () => {
    const { project, owner, editor, commenter, viewer, outsider } = await team(h);
    const doc = await request(h, "POST", `/v1/projects/${project.id}/documents`, editor, {
      docId: "doc_for_delete_1",
      fileId: "file_for_delete_1",
      kind: "markdown",
    });
    assert.equal(doc.status, 201);
    for (const member of [editor, commenter, viewer]) {
      assert.equal((await request(h, "DELETE", `/v1/projects/${project.id}`, member)).status, 403);
    }
    assert.equal((await request(h, "DELETE", `/v1/projects/${project.id}`, outsider)).status, 404);
    assert.equal((await request(h, "DELETE", `/v1/projects/${project.id}`)).status, 401);
    const invitation = await request(h, "POST", `/v1/projects/${project.id}/invitations`, owner, { email: outsider.email, role: "viewer" });
    const db = h.context.db;
    await db.insertInto("revisions").values({ id: "rev_delete", doc_id: doc.body.id, server_seq: 0, kind: "review-base" }).execute();
    await db.insertInto("reviews").values({
      id: "revw_delete", doc_id: doc.body.id, project_id: project.id, requested_by: owner.id,
      base_revision_id: "rev_delete", scope: { kind: "document" }, status: "open",
    }).execute();
    await db.insertInto("review_assignments").values({ review_id: "revw_delete", account_id: editor.id, decided_revision_id: "rev_delete" }).execute();
    await db.insertInto("threads").values({
      id: "thr_delete", doc_id: doc.body.id, project_id: project.id, anchor_id: "anchor_delete", quote_text: "text",
      status: "open", actor: { kind: "user", userId: owner.id }, account_id: owner.id,
    }).execute();
    await db.insertInto("messages").values({
      id: "msg_delete", thread_id: "thr_delete", actor: { kind: "user", userId: owner.id }, account_id: owner.id, body: "comment", mentions: [],
    }).execute();
    await db.insertInto("suggestions").values({
      id: "sug_delete", doc_id: doc.body.id, project_id: project.id, actor: { kind: "user", userId: owner.id },
      account_id: owner.id, base_quote: "text", replacement: "new", status: "pending", thread_ids: [],
    }).execute();
    await db.insertInto("blobs").values({ project_id: project.id, hash: "a".repeat(64), size: 1, mime: "image/png" }).execute();
    await db.insertInto("doc_updates").values({
      doc_id: doc.body.id, subdoc: "content", server_seq: 1, client_id: "client_delete", client_seq: 1, update: new Uint8Array([0, 0]), size: 2,
    }).execute();
    await db.insertInto("doc_snapshots").values({
      doc_id: doc.body.id, subdoc: "content", upto_server_seq: 1, state: new Uint8Array([0, 0]), state_vector: new Uint8Array([0]),
    }).execute();
    h.rooms.calls.length = 0;
    h.events.length = 0;
    assert.equal((await request(h, "DELETE", `/v1/projects/${project.id}`, owner)).status, 204);
    const closed = h.rooms.calls.filter((call) => call.method === "documentDeleted").map((call) => call.args[0]);
    assert.deepEqual(closed.sort(), [project.manifestDocId, "doc_for_delete_1"].sort());
    assert.ok(h.events.some((event) => event.kind === EventKind.ProjectDeleted && event.id === project.id));
    assert.equal((await request(h, "GET", `/v1/projects/${project.id}`, owner)).status, 404);
    for (const member of [owner, editor, commenter, viewer]) {
      assert.ok(h.events.some((event) => event.scope === "user" && event.id === member.id && event.kind === EventKind.ProjectDeleted));
      assert.deepEqual((await request(h, "GET", "/v1/projects", member)).body, []);
    }
    assert.equal(await db.selectFrom("projects").select("id").where("id", "=", project.id).executeTakeFirst(), undefined);
    for (const table of ["memberships", "invitations", "documents", "blobs", "threads", "suggestions", "reviews", "notifications", "audit_log"] as const) {
      assert.equal((await db.selectFrom(table).selectAll().where("project_id", "=", project.id).execute()).length, 0, `${table} erased`);
    }
    for (const table of ["doc_updates", "doc_snapshots", "revisions"] as const) {
      assert.equal((await db.selectFrom(table).selectAll().where("doc_id", "=", doc.body.id).execute()).length, 0, `${table} erased`);
    }
    assert.equal((await db.selectFrom("review_assignments").selectAll().where("review_id", "=", "revw_delete").execute()).length, 0);
    assert.equal((await db.selectFrom("messages").selectAll().where("thread_id", "=", "thr_delete").execute()).length, 0);
    assert.equal((await request(h, "GET", `/v1/documents/${doc.body.id}`, editor)).status, 404);
    assert.equal((await json(h.url, `/v1/invitations/token/${invitation.body.token}`)).status, 404);
  });
});

describe("members", () => {
  test("list, change role, remove and leave, with membershipChanged and events", async () => {
    const { project, owner, editor, commenter, viewer } = await team(h);
    const members = await request(h, "GET", `/v1/projects/${project.id}/members`, viewer);
    assert.equal(members.status, 200);
    assert.deepEqual(
      (members.body as Member[]).map((member) => member.role).sort(),
      ["commenter", "editor", "owner", "viewer"],
    );
    assert.ok((members.body as Member[]).every((member) => member.email && member.displayName && member.color));

    h.rooms.calls.length = 0;
    h.events.length = 0;
    const promoted = await request(h, "PATCH", `/v1/projects/${project.id}/members/${viewer.id}`, owner, { role: "editor" });
    assert.equal(promoted.status, 200);
    assert.equal(promoted.body.role, "editor");
    assert.deepEqual(h.rooms.calls, [{ method: "membershipChanged", args: [project.id, viewer.id, "editor"] }]);
    assert.ok(
      h.events.some(
        (event) => event.scope === "project" && event.id === project.id && event.kind === EventKind.RoleChanged,
      ),
    );

    h.rooms.calls.length = 0;
    const removed = await request(h, "DELETE", `/v1/projects/${project.id}/members/${viewer.id}`, owner);
    assert.equal(removed.status, 204);
    assert.deepEqual(h.rooms.calls, [{ method: "membershipChanged", args: [project.id, viewer.id, null] }]);
    assert.ok(h.events.some((event) => event.kind === EventKind.MemberRemoved && event.scope === "project"));
    assert.equal((await request(h, "GET", `/v1/projects/${project.id}`, viewer)).status, 404);

    h.rooms.calls.length = 0;
    const left = await request(h, "DELETE", `/v1/projects/${project.id}/members/${commenter.id}`, commenter);
    assert.equal(left.status, 204);
    assert.deepEqual(h.rooms.calls, [{ method: "membershipChanged", args: [project.id, commenter.id, null] }]);

    const ownerLeaves = await request(h, "DELETE", `/v1/projects/${project.id}/members/${owner.id}`, owner);
    assert.equal(ownerLeaves.status, 403);
    const editorRemovesOwner = await request(h, "DELETE", `/v1/projects/${project.id}/members/${owner.id}`, editor);
    assert.equal(editorRemovesOwner.status, 403);
  });

  test("only the owner changes roles, and never the owner's own", async () => {
    const { project, owner, editor, commenter, viewer } = await team(h);
    const byCommenter = await request(h, "PATCH", `/v1/projects/${project.id}/members/${viewer.id}`, commenter, { role: "editor" });
    assert.equal(byCommenter.status, 403);
    const byEditor = await request(h, "PATCH", `/v1/projects/${project.id}/members/${viewer.id}`, editor, { role: "editor" });
    assert.equal(byEditor.status, 403);
    const demoteSelf = await request(h, "PATCH", `/v1/projects/${project.id}/members/${owner.id}`, owner, { role: "viewer" });
    assert.equal(demoteSelf.status, 403);
    const makeOwner = await request(h, "PATCH", `/v1/projects/${project.id}/members/${viewer.id}`, owner, { role: "owner" });
    assert.equal(makeOwner.status, 400);
    const unknownRole = await request(h, "PATCH", `/v1/projects/${project.id}/members/${viewer.id}`, owner, { role: "admin" });
    assert.equal(unknownRole.status, 400);
    const byAi = await request(h, "PATCH", `/v1/projects/${project.id}/members/${viewer.id}`, owner, {
      role: "editor",
      ai: { feature: "agent", model: "x" },
    });
    assert.equal(byAi.status, 403);
    assert.equal(errorCode(byAi), "ai-cannot-decide");
    const missing = await request(h, "PATCH", `/v1/projects/${project.id}/members/acc_nobody`, owner, { role: "editor" });
    assert.equal(missing.status, 404);
  });

  test("a failing sync service does not fail the request", async () => {
    const { project, owner, viewer } = await team(h);
    h.rooms.failing = true;
    try {
      const changed = await request(h, "PATCH", `/v1/projects/${project.id}/members/${viewer.id}`, owner, { role: "commenter" });
      assert.equal(changed.status, 200);
      const removed = await request(h, "DELETE", `/v1/projects/${project.id}/members/${viewer.id}`, owner);
      assert.equal(removed.status, 204);
    } finally {
      h.rooms.failing = false;
    }
  });
});

describe("invitations", () => {
  test("end to end: create, email, preview, register with the token", async () => {
    const { project, owner, editor } = await team(h);
    const byEditor = await request(h, "POST", `/v1/projects/${project.id}/invitations`, editor, { email: "x@example.test", role: "viewer" });
    assert.equal(byEditor.status, 403);
    const byAi = await request(h, "POST", `/v1/projects/${project.id}/invitations`, owner, {
      email: "x@example.test",
      role: "viewer",
      ai: { feature: "agent" },
    });
    assert.equal(errorCode(byAi), "ai-cannot-decide");

    h.mail.length = 0;
    const created = await request(h, "POST", `/v1/projects/${project.id}/invitations`, owner, {
      email: "New.Person@Example.test",
      role: "commenter",
    });
    assert.equal(created.status, 201);
    const invitation = created.body as Invitation;
    assert.ok(invitation.token);
    assert.equal(invitation.url, `https://collab.test/invite/${invitation.token}`);
    assert.equal(invitation.email, "new.person@example.test");
    assert.equal(h.mail.length, 1);
    assert.equal(h.mail[0].to, "new.person@example.test");
    assert.ok(h.mail[0].text.includes(invitation.url!), "the email carries the link");

    const listed = await request(h, "GET", `/v1/projects/${project.id}/invitations`, owner);
    assert.equal(listed.status, 200);
    assert.equal(listed.body[0].id, invitation.id);
    assert.equal(listed.body[0].token, undefined, "the token is only shown once");

    const preview = await json(h.url, `/v1/invitations/token/${invitation.token}`);
    assert.equal(preview.status, 200);
    assert.equal((preview.body as any).projectName, project.name);
    assert.equal((preview.body as any).inviter.id, owner.id);
    assert.equal((preview.body as any).role, "commenter");

    const mismatch = await json(h.url, "/v1/auth/register", {
      body: { email: "someone.else@example.test", password: "long enough", displayName: "S", invitationToken: invitation.token },
    });
    assert.equal(mismatch.status, 403);
    assert.equal(
      await h.context.db.selectFrom("accounts").select("id").where("email", "=", "someone.else@example.test").executeTakeFirst(),
      undefined,
      "no account is left behind",
    );

    h.rooms.calls.length = 0;
    const joined = await json<AuthResponse>(h.url, "/v1/auth/register", {
      body: { email: "NEW.person@example.test", password: "long enough", displayName: "New", invitationToken: invitation.token },
    });
    assert.equal(joined.status, 201);
    const role = await request(h, "GET", `/v1/projects/${project.id}`, { id: "", email: "", token: joined.body.accessToken, auth: joined.body });
    assert.equal(role.body.role, "commenter");
    assert.deepEqual(h.rooms.calls, [{ method: "membershipChanged", args: [project.id, joined.body.account.id, "commenter"] }]);

    const reused = await json(h.url, `/v1/invitations/token/${invitation.token}`);
    assert.equal(reused.status, 404);
    assert.equal(errorCode(reused), "invalid-invitation");
  });

  test("accept by an existing account, with notification, email check and expiry", async () => {
    const { project, owner } = await team(h);
    const invitee = await register(h, "invitee");
    const stranger = await register(h, "stranger");
    const created = await request(h, "POST", `/v1/projects/${project.id}/invitations`, owner, {
      email: invitee.email.toUpperCase(),
      role: "editor",
    });
    assert.equal(created.status, 201);
    const token = created.body.token as string;

    const notes = await request(h, "GET", "/v1/notifications", invitee);
    assert.equal(notes.body[0].kind, "invited");
    assert.equal(notes.body[0].payload.token, token);
    assert.ok(h.events.some((event) => event.scope === "user" && event.id === invitee.id && event.kind === EventKind.Notification));

    const wrongPerson = await request(h, "POST", `/v1/invitations/token/${token}/accept`, stranger);
    assert.equal(wrongPerson.status, 403);
    const noAuth = await request(h, "POST", `/v1/invitations/token/${token}/accept`);
    assert.equal(noAuth.status, 401);

    const accepted = await request(h, "POST", `/v1/invitations/token/${token}/accept`, invitee);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.role, "editor");
    const again = await request(h, "POST", `/v1/invitations/token/${token}/accept`, invitee);
    assert.equal(again.status, 200, "accepting twice is harmless");

    const already = await request(h, "POST", `/v1/projects/${project.id}/invitations`, owner, { email: invitee.email, role: "viewer" });
    assert.equal(already.status, 409);

    const late = await request(h, "POST", `/v1/projects/${project.id}/invitations`, owner, { email: stranger.email, role: "viewer" });
    await h.context.db
      .updateTable("invitations")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("id", "=", late.body.id)
      .execute();
    const expired = await request(h, "POST", `/v1/invitations/token/${late.body.token}/accept`, stranger);
    assert.equal(expired.status, 404);
    assert.equal(errorCode(expired), "invalid-invitation");
  });

  test("expiry follows INVITATION_TTL_DAYS and revoked invitations stop working", async () => {
    const { project, owner } = await team(h);
    const created = await request(h, "POST", `/v1/projects/${project.id}/invitations`, owner, { email: "rev@example.test", role: "viewer" });
    const ttl = Date.parse(created.body.expiresAt) - Date.parse(created.body.createdAt);
    assert.equal(Math.round(ttl / 86_400_000), h.context.config.INVITATION_TTL_DAYS);
    assert.equal((await request(h, "DELETE", `/v1/invitations/${created.body.id}`, owner)).status, 204);
    assert.equal((await json(h.url, `/v1/invitations/token/${created.body.token}`)).status, 404);
    const listed = await request(h, "GET", `/v1/projects/${project.id}/invitations`, owner);
    assert.equal(listed.body.length, 0);
  });
});

describe("audit", () => {
  test("owner reads entries for roles, removals, invitations, renames and deletes", async () => {
    const { project, owner, editor, viewer } = await team(h);
    await request(h, "PATCH", `/v1/projects/${project.id}`, owner, { name: "Audited" });
    await request(h, "PATCH", `/v1/projects/${project.id}/members/${viewer.id}`, owner, { role: "commenter" });
    await request(h, "DELETE", `/v1/projects/${project.id}/members/${viewer.id}`, owner);
    await request(h, "POST", `/v1/projects/${project.id}/invitations`, owner, { email: "aud@example.test", role: "viewer" });
    await request(h, "POST", `/v1/projects/${project.id}/documents`, editor, { docId: "doc_audit_0001", fileId: "file_audit_01", kind: "text" });
    await request(h, "DELETE", "/v1/documents/doc_audit_0001", editor);

    assert.equal((await request(h, "GET", `/v1/projects/${project.id}/audit`, editor)).status, 403);
    const audit = await request(h, "GET", `/v1/projects/${project.id}/audit`, owner);
    assert.equal(audit.status, 200);
    const actions = (audit.body as any[]).map((entry) => entry.action);
    for (const action of ["project.create", "project.rename", "member.role", "member.remove", "invitation.create", "document.delete"]) {
      assert.ok(actions.includes(action), `audit has ${action}`);
    }
    const role = (audit.body as any[]).find((entry) => entry.action === "member.role");
    assert.deepEqual(role.details, { from: "viewer", to: "commenter" });
    assert.deepEqual(role.actor, { kind: "user", userId: owner.id });

    const page = await request(h, "GET", `/v1/projects/${project.id}/audit?limit=2`, owner);
    assert.equal(page.body.length, 2);
    const next = await request(h, "GET", `/v1/projects/${project.id}/audit?limit=2&before=${page.body[1].id}`, owner);
    assert.ok(Number(next.body[0].id) < Number(page.body[1].id));
  });
});
