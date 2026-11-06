import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";

import * as Y from "yjs";

import { ManifestKeys, MessageType, PdfKeys, pdfDocIdFromDigest, pdfDocIdSeed, type Subdoc } from "../src/protocol.js";
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

function field(id: string, key: string, value: unknown) {
  return (doc: Y.Doc) => (doc.getMap(PdfKeys.marks).get(id) as Y.Map<unknown>).set(key, value);
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
    await other.acked(other.edit(owner.docId, annotations, field("m1", "style", { color: "#22c55e" })));
    await other.acked(other.edit(owner.docId, annotations, field("m1", "deleted", { by: commenter.id, at: "2026-11-06T10:01:00.000Z" })));
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
    const b = second.edit(first.docId, annotations, insert(5, " B"));
    await Promise.all([first.client.acked(a), second.acked(b)]);
    const text = await env.server.server.context.rooms.withDocs(first.docId, (docs) => ((docs.annotations.getMap(PdfKeys.marks).get("note") as Y.Map<unknown>).get("text") as Y.Text).toString());
    assert.equal(text, "A hello B");
    assert.equal((await first.client.rejected(first.client.edit(first.docId, annotations, insert(0, "x".repeat(10_001))))).reason, "annotation-ownership");
  });

  test("two devices importing one sidecar can both create a mark", async () => {
    const first = await openPdf();
    const second = await env.connect();
    await second.open(first.docId, { projectId: env.project.id, fileId: first.fileId });
    const a = first.client.edit(first.docId, annotations, mark("imported", env.owner.id));
    const b = second.edit(first.docId, annotations, mark("imported", env.owner.id));
    await Promise.all([first.client.acked(a), second.acked(b)]);
    assert.equal(await env.server.server.context.rooms.withDocs(first.docId, (docs) => docs.annotations.getMap(PdfKeys.marks).size), 1);
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

  test("awareness is rate limited without closing the socket", async () => {
    const { client, docId } = await openPdf();
    const { encodeAwarenessUpdate, Awareness } = await import("y-protocols/awareness");
    const awareness = new Awareness(new Y.Doc());
    for (let index = 0; index < 400; index += 1) {
      awareness.setLocalStateField("n", index);
      client.send({ type: MessageType.Awareness, docId, update: encodeAwarenessUpdate(awareness, [awareness.clientID]) });
    }
    await client.acked(client.edit(docId, annotations, mark("still-open", env.owner.id)));
  });
});
