import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";

import * as Y from "yjs";

import { ManifestKeys, MessageType, PdfKeys, pdfDocIdFromDigest, pdfDocIdSeed, SyncLimits, type Subdoc } from "../src/protocol.js";
import { json } from "./helpers.js";
import type { SyncTestClient } from "./support/sync-client.js";
import { startSyncEnv, type AccountFixture, type SyncEnv } from "./support/sync-fixtures.js";

const pdfDocId = (projectId: string, fileId: string) =>
  pdfDocIdFromDigest(createHash("sha256").update(pdfDocIdSeed(projectId, fileId)).digest("base64url"));

let counter = 0;
const nextFile = () => `fil_test_pdf_${(counter += 1)}`;

function mark(id: string, createdBy: string, overrides: Record<string, unknown> = {}) {
  return (doc: Y.Doc) => {
    const map = new Y.Map<unknown>();
    const fields: Record<string, unknown> = {
      id,
      type: "highlight",
      createdAt: "2026-11-06T10:00:00.000Z",
      updatedAt: "2026-11-06T10:00:00.000Z",
      createdBy,
      updatedBy: createdBy,
      geometry: { pageNumber: 1, rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }], quote: "a passage" },
      style: { color: "#fde047" },
      ...overrides,
    };
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) map.set(key, value);
    doc.getMap(PdfKeys.marks).set(id, map);
  };
}

function field(id: string, key: string, value: unknown, editor?: string) {
  return (doc: Y.Doc) => {
    const mark = doc.getMap(PdfKeys.marks).get(id) as Y.Map<unknown>;
    mark.set(key, value);
    if (editor) mark.set("updatedBy", editor);
  };
}

const annotations: Subdoc = "annotations";

describe("shared PDF documents", () => {
  let env: SyncEnv;
  before(async () => {
    env = await startSyncEnv({ SYNC_CONNECTIONS_PER_MINUTE: 1000, SYNC_MAX_SOCKETS_PER_ACCOUNT: 100 });
  });
  after(() => env.close());

  async function openPdf(account?: AccountFixture, fileId = nextFile()): Promise<{ client: SyncTestClient; docId: string; fileId: string }> {
    const client = await env.connect(account);
    const docId = pdfDocId(env.project.id, fileId);
    await client.open(docId, { projectId: env.project.id, fileId });
    return { client, docId, fileId };
  }

  test("the first open makes the document, for any member, once", async () => {
    const viewer = await env.member("viewer");
    const { docId, fileId } = await openPdf(viewer);
    const row = await env.db.selectFrom("documents").selectAll().where("id", "=", docId).executeTakeFirstOrThrow();
    assert.equal(row.kind, "pdf");
    assert.equal(row.file_id, fileId);
    assert.equal(row.project_id, env.project.id);
    await openPdf(undefined, fileId);
    const rows = await env.db.selectFrom("documents").select("id").where("file_id", "=", fileId).execute();
    assert.equal(rows.length, 1);
  });

  test("a document id that does not match the project and file makes nothing", async () => {
    const client = await env.connect();
    const docId = pdfDocId(env.project.id, "fil_some_other_file");
    await assert.rejects(client.open(docId, { projectId: env.project.id, fileId: nextFile() }), /Open refused/);
    assert.equal(await env.db.selectFrom("documents").select("id").where("id", "=", docId).executeTakeFirst(), undefined);
  });

  test("a non-member cannot make a document in someone's project", async () => {
    const outsider = await (async () => {
      const member = await env.member("viewer");
      await env.db.deleteFrom("memberships").where("account_id", "=", member.id).execute();
      return member;
    })();
    const client = await env.connect(outsider);
    const fileId = nextFile();
    const docId = pdfDocId(env.project.id, fileId);
    await assert.rejects(client.open(docId, { projectId: env.project.id, fileId }), /Open refused/);
    assert.equal(await env.db.selectFrom("documents").select("id").where("id", "=", docId).executeTakeFirst(), undefined);
  });

  test("commenters change anyone's marks, viewers cannot write, and marks reach everyone", async () => {
    const commenter = await env.member("commenter");
    const viewer = await env.member("viewer");
    const owner = await openPdf();
    const other = await env.connect(commenter);
    await other.open(owner.docId, { projectId: env.project.id, fileId: owner.fileId });
    await owner.client.acked(owner.client.edit(owner.docId, annotations, mark("m1", env.owner.id)));
    await other.waitFor((message) => message.type === MessageType.Remote && message.docId === owner.docId);
    await other.acked(other.edit(owner.docId, annotations, field("m1", "style", { color: "#22c55e" }, commenter.id)));
    await other.acked(other.edit(owner.docId, annotations, field("m1", "deleted", { by: commenter.id, at: "2026-11-06T10:01:00.000Z" }, commenter.id)));
    await other.acked(other.edit(owner.docId, annotations, mark("m2", commenter.id, { type: "ink", geometry: { pageNumber: 2, points: [{ x: 0.1, y: 0.2 }] }, style: { color: "#111111", strokeWidth: 2 } })));

    const reader = await env.connect(viewer);
    await reader.open(owner.docId, { projectId: env.project.id, fileId: owner.fileId });
    const marks = reader.doc(owner.docId, annotations).getMap<Y.Map<unknown>>(PdfKeys.marks);
    assert.deepEqual(marks.get("m1")?.get("style"), { color: "#22c55e" });
    assert.equal(marks.size, 2);
    const refused = await reader.rejected(reader.edit(owner.docId, annotations, mark("m3", viewer.id)));
    assert.equal(refused.reason, "forbidden");
  });

  test("malformed marks are refused", async () => {
    const cases: Array<[string, (client: SyncTestClient, docId: string) => void | Promise<void>, (doc: Y.Doc) => void]> = [
      ["no geometry", () => {}, mark("bad-1", env.owner.id, { geometry: undefined })],
      ["bad colour", () => {}, mark("bad-2", env.owner.id, { style: { color: "url(evil)" } })],
      ["bad page", () => {}, mark("bad-3", env.owner.id, { geometry: { pageNumber: 0, rects: [{ x: 0, y: 0, width: 1, height: 1 }] } })],
      ["someone else's name", () => {}, mark("bad-4", "acc_someone_else")],
      ["id mismatch", () => {}, (doc) => { mark("bad-5", env.owner.id, { id: "other" })(doc); }],
      ["unknown field", () => {}, (doc) => { const map = new Y.Map<unknown>(); map.set("oops", 1); doc.getMap(PdfKeys.marks).set("bad-6", map); }],
      ["a plain value as a mark", () => {}, (doc) => doc.getMap(PdfKeys.marks).set("bad-7", { id: "bad-7" })],
    ];
    for (const [name, , change] of cases) {
      const { client, docId } = await openPdf();
      const refused = await client.rejected(client.edit(docId, annotations, change));
      assert.equal(refused.reason, "annotation-ownership", name);
    }
  });

  test("marks are never removed, and who made them never changes", async () => {
    const { client, docId } = await openPdf();
    await client.acked(client.edit(docId, annotations, mark("keep", env.owner.id)));
    assert.equal((await client.rejected(client.edit(docId, annotations, field("keep", "createdBy", "acc_other")))).reason, "annotation-ownership");
    await client.rollback(docId);
    assert.equal((await client.rejected(client.edit(docId, annotations, (doc) => doc.getMap(PdfKeys.marks).delete("keep")))).reason, "annotation-ownership");
  });

  test("notes hold a Y.Text that merges character by character, within the length limit", async () => {
    const editor = await env.member("editor");
    const first = await openPdf();
    const second = await env.connect(editor);
    await second.open(first.docId, { projectId: env.project.id, fileId: first.fileId });
    await first.client.acked(first.client.edit(first.docId, annotations, (doc) => {
      mark("note", env.owner.id, { type: "text", geometry: { pageNumber: 1, rect: { x: 0, y: 0, width: 0.2, height: 0.1 } }, style: { fontSize: 10 } })(doc);
      const text = new Y.Text("hello");
      (doc.getMap(PdfKeys.marks).get("note") as Y.Map<unknown>).set("text", text);
    }));
    await second.waitFor((message) => message.type === MessageType.Remote && message.docId === first.docId);
    const insert = (at: number, value: string) => (doc: Y.Doc) => ((doc.getMap(PdfKeys.marks).get("note") as Y.Map<unknown>).get("text") as Y.Text).insert(at, value);
    const a = first.client.edit(first.docId, annotations, insert(0, "A "));
    const b = second.edit(first.docId, annotations, (doc) => {
      insert(5, " B")(doc);
      (doc.getMap(PdfKeys.marks).get("note") as Y.Map<unknown>).set("updatedBy", editor.id);
    });
    await Promise.all([first.client.acked(a), second.acked(b)]);
    const text = await env.server.server.context.rooms.withDocs(first.docId, (docs) => ((docs.annotations.getMap(PdfKeys.marks).get("note") as Y.Map<unknown>).get("text") as Y.Text).toString());
    assert.equal(text, "A hello B");
    assert.equal((await first.client.rejected(first.client.edit(first.docId, annotations, insert(0, "x".repeat(10_001))))).reason, "annotation-ownership");
  });

  test("two people changing one mark at once are both accepted, whichever write wins", async () => {
    const editor = await env.member("editor");
    // Yjs picks the winner of a concurrent write by client id, which is random
    // per connection, so a single run only sees one side of the race.
    for (let round = 0; round < 12; round += 1) {
      const first = await openPdf();
      const second = await env.connect(editor);
      await second.open(first.docId, { projectId: env.project.id, fileId: first.fileId });
      await first.client.acked(first.client.edit(first.docId, annotations, mark("m", env.owner.id)));
      await second.waitFor((message) => message.type === MessageType.Remote && message.docId === first.docId);
      const left = first.client.edit(first.docId, annotations, field("m", "style", { color: "#22c55e" }, env.owner.id));
      const right = second.edit(first.docId, annotations, round % 2
        ? field("m", "deleted", { by: editor.id, at: "2026-11-06T10:01:00.000Z" }, editor.id)
        : field("m", "style", { color: "#ef4444" }, editor.id));
      await Promise.all([first.client.acked(left), second.acked(right)]);
      await second.close();
      await first.client.close();
    }
  });

  test("a change to a mark cannot be credited to someone else", async () => {
    const editor = await env.member("editor");
    const first = await openPdf();
    const second = await env.connect(editor);
    await second.open(first.docId, { projectId: env.project.id, fileId: first.fileId });
    await first.client.acked(first.client.edit(first.docId, annotations, mark("m", env.owner.id)));
    await second.waitFor((message) => message.type === MessageType.Remote && message.docId === first.docId);
    const silent = await second.rejected(second.edit(first.docId, annotations, field("m", "style", { color: "#ef4444" })));
    assert.equal(silent.reason, "annotation-ownership");
  });

  test("F6: concurrent server imports retain the one nested map and its acknowledged edits", async () => {
    const first = await openPdf();
    const second = await env.member("commenter");
    const note = { id: "imported", type: "text", pageNumber: 1, rect: { x: 0, y: 0, width: 0.2, height: 0.1 }, fontSize: 10, text: "base", createdAt: "2026-11-06T10:00:00.000Z", updatedAt: "2026-11-06T10:00:00.000Z" };
    const endpoint = `/v1/documents/${first.docId}/pdf-import`;
    const imported = await json(env.server.url, endpoint, { body: { marks: [note] }, token: env.owner.token });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    await first.client.waitFor((message) => message.type === MessageType.Remote && message.docId === first.docId);
    await first.client.acked(first.client.edit(first.docId, annotations, (doc) => ((doc.getMap(PdfKeys.marks).get("imported") as Y.Map<unknown>).get("text") as Y.Text).insert(4, " acknowledged")));
    const results = await Promise.all([env.owner, second].map((account) => json(env.server.url, endpoint, { body: { marks: [note] }, token: account.token })));
    assert.deepEqual(results.map((result) => result.status), [200, 200]);
    const text = await env.server.server.context.rooms.withDocs(first.docId, (docs) => ((docs.annotations.getMap(PdfKeys.marks).get("imported") as Y.Map<unknown>).get("text") as Y.Text).toString());
    assert.equal(text, "base acknowledged");
  });

  test("import records name their importer", async () => {
    const { client, docId } = await openPdf();
    await client.acked(client.edit(docId, annotations, (doc) => doc.getMap(PdfKeys.imports).set("abc", { by: env.owner.id, at: "2026-11-06T10:00:00.000Z" })));
    assert.equal((await client.rejected(client.edit(docId, annotations, (doc) => doc.getMap(PdfKeys.imports).set("def", { by: "acc_other", at: "x" })))).reason, "annotation-ownership");
  });

  test("the rules stay out of other documents: a Markdown document's commenter still cannot write marks", async () => {
    const commenter = await env.member("commenter");
    const client = await env.connect(commenter);
    await client.open(env.docId);
    assert.equal((await client.rejected(client.edit(env.docId, annotations, mark("m", commenter.id)))).reason, "annotation-ownership");
  });

  test("deleting the PDF from the manifest deletes its document and closes editors", async () => {
    const manifest = { id: env.project.manifestDocId };
    const { client, docId, fileId } = await openPdf();
    await client.open(manifest.id);
    const entry = { fileId, path: "paper.pdf", kind: "blob", blobHash: "a".repeat(64), createdBy: env.owner.id, createdAt: 1, updatedAt: 1 };
    await client.acked(client.edit(manifest.id, "manifest", (doc) => doc.getMap(ManifestKeys.files).set(fileId, entry)));
    await client.acked(client.edit(manifest.id, "manifest", (doc) => doc.getMap(ManifestKeys.files).set(fileId, { ...entry, path: "renamed.pdf" })));
    assert.equal((await env.db.selectFrom("documents").select("deleted_at").where("id", "=", docId).executeTakeFirstOrThrow()).deleted_at, null, "a rename keeps the document");
    await client.acked(client.edit(manifest.id, "manifest", (doc) => doc.getMap(ManifestKeys.files).delete(fileId)));
    await client.waitFor((message) => message.type === MessageType.Closed && message.docId === docId && message.reason === "document-deleted");
    assert.notEqual((await env.db.selectFrom("documents").select("deleted_at").where("id", "=", docId).executeTakeFirstOrThrow()).deleted_at, null);
    const late = await env.connect();
    await assert.rejects(late.open(docId, { projectId: env.project.id, fileId }), /document-deleted/);
  });

  test("a version of the marks can be named and restored as a forward change", async () => {
    const { client, docId, fileId } = await openPdf();
    await client.acked(client.edit(docId, annotations, mark("kept", env.owner.id)));
    await client.acked(client.edit(docId, annotations, (doc) => {
      mark("note", env.owner.id, { type: "text", geometry: { pageNumber: 1, rect: { x: 0, y: 0, width: 0.2, height: 0.1 } }, style: { fontSize: 10 } })(doc);
      (doc.getMap(PdfKeys.marks).get("note") as Y.Map<unknown>).set("text", new Y.Text("first"));
    }));
    const named = await json<{ id: string }>(env.server.url, `/v1/documents/${docId}/revisions`, { body: { kind: "named", label: "Before edits" }, token: env.owner.token });
    assert.equal(named.status, 201, JSON.stringify(named.body));

    await client.acked(client.edit(docId, annotations, field("kept", "style", { color: "#22c55e" })));
    await client.acked(client.edit(docId, annotations, field("kept", "deleted", { by: env.owner.id, at: "2026-11-06T11:00:00.000Z" })));
    await client.acked(client.edit(docId, annotations, (doc) => ((doc.getMap(PdfKeys.marks).get("note") as Y.Map<unknown>).get("text") as Y.Text).insert(5, " and more")));
    await client.acked(client.edit(docId, annotations, mark("later", env.owner.id)));

    const commenter = await env.member("commenter");
    const refused = await json(env.server.url, `/v1/documents/${docId}/restore`, { body: { revisionId: named.body.id }, token: commenter.token });
    assert.equal(refused.status, 403);
    const restored = await json(env.server.url, `/v1/documents/${docId}/restore`, { body: { revisionId: named.body.id }, token: env.owner.token });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));

    const reader = await env.connect();
    await reader.open(docId, { projectId: env.project.id, fileId });
    const marks = reader.doc(docId, annotations).getMap<Y.Map<unknown>>(PdfKeys.marks);
    assert.deepEqual(marks.get("kept")?.get("style"), { color: "#fde047" });
    assert.equal(marks.get("kept")?.has("deleted"), false);
    assert.equal((marks.get("note")?.get("text") as Y.Text).toString(), "first");
    assert.ok(marks.get("later")?.has("deleted"), "a mark added since is deleted, not removed");
  });

  test("a PDF can be sent for review and decided", async () => {
    const reviewer = await env.member("commenter");
    const { client, docId } = await openPdf();
    await client.acked(client.edit(docId, annotations, mark("m", env.owner.id)));
    const created = await json<{ id: string; status: string }>(env.server.url, `/v1/documents/${docId}/reviews`, { body: { scope: { kind: "document" }, assignees: [reviewer.id] }, token: env.owner.token });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const decided = await json<{ status: string }>(env.server.url, `/v1/reviews/${created.body.id}/decision`, { body: { decision: "approved" }, token: reviewer.token });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal(decided.body.status, "approved");
  });

  test("the server says it supports live PDFs, and its digest covers their marks", async () => {
    const version = await json<{ livePdfs?: boolean }>(env.server.url, "/v1/version");
    assert.equal(version.body.livePdfs, true);
    const { client, docId } = await openPdf();
    const before = await json<{ contentSha256: string }>(env.server.url, `/v1/documents/${docId}/digest`, { token: env.owner.token });
    await client.acked(client.edit(docId, annotations, mark("digested", env.owner.id)));
    const after = await json<{ contentSha256: string }>(env.server.url, `/v1/documents/${docId}/digest`, { token: env.owner.token });
    assert.notEqual(after.body.contentSha256, before.body.contentSha256);
  });

  test("only the owner turns on live PDFs, and it stays on", async () => {
    const editor = await env.member("editor");
    const owner = await env.connect();
    await owner.open(env.project.manifestDocId);
    const member = await env.connect(editor);
    await member.open(env.project.manifestDocId);
    assert.equal((await member.rejected(member.edit(env.project.manifestDocId, "manifest", (doc) => doc.getMap(ManifestKeys.settings).set("pdfLive", true)))).reason, "invalid-update");
    await owner.acked(owner.edit(env.project.manifestDocId, "manifest", (doc) => doc.getMap(ManifestKeys.settings).set("pdfLive", true)));
    assert.equal((await owner.rejected(owner.edit(env.project.manifestDocId, "manifest", (doc) => doc.getMap(ManifestKeys.settings).set("pdfLive", false)))).reason, "invalid-update");
  });

  test("awareness is rate limited without closing the socket", async () => {
    const { client, docId, fileId } = await openPdf();
    const watcher = await env.connect();
    await watcher.open(docId, { projectId: env.project.id, fileId });
    const started = Date.now();
    const { encodeAwarenessUpdate, Awareness } = await import("y-protocols/awareness");
    const awareness = new Awareness(new Y.Doc());
    for (let index = 0; index < 400; index += 1) {
      awareness.setLocalStateField("n", index);
      client.send({ type: MessageType.Awareness, docId, update: encodeAwarenessUpdate(awareness, [awareness.clientID]) });
    }
    await client.acked(client.edit(docId, annotations, mark("still-open", env.owner.id)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const delivered = watcher.received.filter((message) => message.type === MessageType.Awareness && message.docId === docId).length;
    const allowed = SyncLimits.awarenessBurst + Math.ceil(((Date.now() - started) / 1000) * SyncLimits.awarenessPerSecond);
    assert.ok(delivered > 0, "updates within the allowance reach the others");
    assert.ok(delivered <= allowed, `${delivered} updates delivered, ${allowed} allowed`);
  });

  test("F7: replacing containers and forging editor/deleter identities are refused", async () => {
    const { client, docId } = await openPdf();
    await client.acked(client.edit(docId, annotations, mark("protected", env.owner.id)));
    for (const change of [mark("protected", env.owner.id), field("protected", "updatedBy", "acc_forged"), field("protected", "deleted", { by: "acc_forged", at: "2026-11-06T10:00:00.000Z" })]) {
      assert.equal((await client.rejected(client.edit(docId, annotations, change))).reason, "annotation-ownership");
      await client.rollback(docId);
    }
    const reader = await env.connect();
    await reader.open(docId);
    assert.equal((reader.doc(docId, annotations).getMap(PdfKeys.marks).get("protected") as Y.Map<unknown>).get("createdBy"), env.owner.id);
    const commenter = await env.member("commenter");
    const other = await env.connect(commenter);
    await other.open(docId);
    assert.equal((await other.rejected(other.edit(docId, annotations, field("protected", "style", { color: "#22c55e" })))).reason, "annotation-ownership", "changing someone else's mark also requires the sender's editor identity");
    await other.rollback(docId);
    await other.acked(other.edit(docId, annotations, field("protected", "style", { color: "#22c55e" }, commenter.id)));
  });

  test("F8: incomplete spaces, geometry overrides and malformed nested anchors are refused", async () => {
    const changes = [
      mark("space", env.owner.id, { type: "space", geometry: { pageNumber: 1, y: 0.5, height: 0.2 } }),
      mark("override", env.owner.id, { style: { color: "#111111", rects: null } }),
      (doc: Y.Doc) => doc.getMap(PdfKeys.anchors).set("anchor", { createdBy: env.owner.id, quote: "", segments: [] }),
      (doc: Y.Doc) => doc.getMap(PdfKeys.anchors).set("anchor", { createdBy: env.owner.id, quote: "", segments: [{ pageNumber: 1, rects: [null] }] }),
    ];
    for (const change of changes) {
      const { client, docId } = await openPdf();
      assert.equal((await client.rejected(client.edit(docId, annotations, change))).reason, "annotation-ownership");
    }
  });

  test("F9: a restore queued before demotion reauthorizes inside the room", async () => {
    const { client, docId } = await openPdf();
    const editor = await env.member("editor");
    await client.acked(client.edit(docId, annotations, mark("restore", env.owner.id)));
    const named = await json<{ id: string }>(env.server.url, `/v1/documents/${docId}/revisions`, { body: { kind: "named" }, token: env.owner.token });
    await client.acked(client.edit(docId, annotations, field("restore", "style", { color: "#111111" })));
    const rooms = env.server.server.context.rooms;
    const batch = rooms.batch;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    rooms.batch = (id, task) => { entered(); return batch(id, async (room) => { await gate; return task(room); }); };
    try {
      const request = json(env.server.url, `/v1/documents/${docId}/restore`, { body: { revisionId: named.body.id }, token: editor.token });
      await waiting;
      await env.db.updateTable("memberships").set({ role: "viewer" }).where("project_id", "=", env.project.id).where("account_id", "=", editor.id).execute();
      release();
      assert.equal((await request).status, 403);
      assert.deepEqual(await rooms.withDocs(docId, (docs) => (docs.annotations.getMap(PdfKeys.marks).get("restore") as Y.Map<unknown>).get("style")), { color: "#111111" });
    } finally { release(); rooms.batch = batch; }
  });

  test("F9: a membership change after queued authorization is fenced at persistence", async () => {
    const { client, docId } = await openPdf();
    const editor = await env.member("editor");
    await client.acked(client.edit(docId, annotations, mark("restore", env.owner.id)));
    const named = await json<{ id: string }>(env.server.url, `/v1/documents/${docId}/revisions`, { body: { kind: "named" }, token: env.owner.token });
    await client.acked(client.edit(docId, annotations, field("restore", "style", { color: "#111111" })));
    const rooms = env.server.server.context.rooms;
    const batch = rooms.batch;
    rooms.batch = (id, task) => batch(id, (room) => task({ ...room, transact: async (...args) => {
      await env.db.updateTable("memberships").set({ role: "viewer" }).where("project_id", "=", env.project.id).where("account_id", "=", editor.id).execute();
      return room.transact(...args);
    } }));
    try {
      const response = await json(env.server.url, `/v1/documents/${docId}/restore`, { body: { revisionId: named.body.id }, token: editor.token });
      assert.equal(response.status, 403, JSON.stringify(response.body));
      assert.deepEqual(await rooms.withDocs(docId, (docs) => (docs.annotations.getMap(PdfKeys.marks).get("restore") as Y.Map<unknown>).get("style")), { color: "#111111" });
    } finally { rooms.batch = batch; }
  });

  test("F16: REST imports validate complete marks before creating anything", async () => {
    const { docId } = await openPdf();
    const note = { id: "invalid", type: "text", pageNumber: 1, rect: { x: 0, y: 0, width: 0.2, height: 0.1 }, fontSize: 10, text: "x".repeat(10_001), createdAt: "2026-11-06T10:00:00.000Z", updatedAt: "invalid" };
    const result = await json(env.server.url, `/v1/documents/${docId}/pdf-import`, { body: { marks: [note] }, token: env.owner.token });
    assert.equal(result.status, 400);
    assert.equal(await env.server.server.context.rooms.withDocs(docId, (docs) => docs.annotations.getMap(PdfKeys.marks).size), 0);
  });

  test("F18: simultaneous imports by different accounts create one immutable anchor and thread", async () => {
    const { docId } = await openPdf();
    const other = await env.member("commenter");
    const local = { id: "old-thread", anchor: { quote: "passage", segments: [{ pageNumber: 1, rects: [{ x: 0, y: 0, width: 0.2, height: 0.02 }] }] }, status: "open", messages: [{ id: "old-message", text: "First" }, { id: "reply", text: "Reply" }] };
    const requests = [env.owner, other].map((account) => json(env.server.url, `/v1/documents/${docId}/pdf-import`, { body: { marks: [], comments: [local] }, token: account.token }));
    assert.deepEqual((await Promise.all(requests)).map((result) => result.status), [200, 200]);
    assert.equal((await env.db.selectFrom("threads").selectAll().where("doc_id", "=", docId).execute()).length, 1);
    const rows = await env.db.selectFrom("messages").innerJoin("threads", "threads.id", "messages.thread_id").select("messages.id").where("threads.doc_id", "=", docId).execute();
    assert.equal(rows.length, 2);
    assert.equal(await env.server.server.context.rooms.withDocs(docId, (docs) => docs.annotations.getMap(PdfKeys.anchors).size), 1);
  });

  test("F19: deleting a never-opened PDF tombstones late opens and stale blob re-adds", async () => {
    const client = await env.connect();
    const manifestId = env.project.manifestDocId;
    await client.open(manifestId);
    const fileId = nextFile();
    const docId = pdfDocId(env.project.id, fileId);
    const entry = { fileId, path: "never-opened.pdf", kind: "blob", blobHash: "a".repeat(64), createdBy: env.owner.id, createdAt: 1, updatedAt: 1 };
    await client.acked(client.edit(manifestId, "manifest", (doc) => doc.getMap(ManifestKeys.files).set(fileId, entry)));
    const stale = await env.connect();
    await stale.open(manifestId);
    let offlineRename!: Uint8Array;
    const offlineDoc = stale.doc(manifestId, "manifest");
    const capture = (update: Uint8Array) => { offlineRename = update; };
    offlineDoc.on("update", capture);
    offlineDoc.getMap(ManifestKeys.files).set(fileId, { ...entry, path: "stale.pdf" });
    offlineDoc.off("update", capture);
    await client.acked(client.edit(manifestId, "manifest", (doc) => doc.getMap(ManifestKeys.files).delete(fileId)));
    const row = await env.db.selectFrom("documents").selectAll().where("id", "=", docId).executeTakeFirstOrThrow();
    assert.ok(row.deleted_at);
    const late = await env.connect();
    await assert.rejects(late.open(docId, { projectId: env.project.id, fileId }), /document-deleted/);
    const sent = stale.sendUpdate({ docId: manifestId, subdoc: "manifest", clientSeq: stale.nextSeq(), update: offlineRename });
    assert.equal((await stale.rejected(sent)).reason, "invalid-update");
  });

});
