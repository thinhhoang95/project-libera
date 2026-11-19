// Finding 35: the server accepts a manifest update only when its changed
// entries have the desktop's entry shape and point at a document or blob of
// this project, and only new or renamed names must leave room for sidecars.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import * as Y from "yjs";

import { ManifestKeys, MessageType } from "../src/protocol.js";
import { createDocument, startSyncEnv, type SyncEnv } from "./support/sync-fixtures.js";

const HASH = "b".repeat(64);
let counter = 0;
const nextFile = () => `fil_validation_${++counter}`;

describe("manifest validation (finding 35)", () => {
  let env: SyncEnv;
  before(async () => { env = await startSyncEnv({ SYNC_CONNECTIONS_PER_MINUTE: 1000, SYNC_MAX_SOCKETS_PER_ACCOUNT: 100 }); });
  after(() => env.close());

  async function submit(fileId: string, entry: Record<string, unknown>): Promise<string> {
    const client = await env.connect();
    try {
      const manifest = env.project.manifestDocId;
      await client.open(manifest);
      const sent = client.edit(manifest, "manifest", (doc: Y.Doc) => doc.getMap(ManifestKeys.files).set(fileId, { fileId, createdBy: env.owner.id, createdAt: 1, updatedAt: 1, ...entry }));
      const result = await client.result(sent);
      return result.type === MessageType.Reject ? result.reason : "acked";
    } finally { await client.close(); }
  }

  async function uploadBlob(hash: string, projectId = env.project.id): Promise<void> {
    await env.db.insertInto("blobs").values({ project_id: projectId, hash, size: 1, mime: "image/png" }).onConflict((oc) => oc.doNothing()).execute();
  }

  test("a document entry must name a document of this project with the same kind", async () => {
    const docId = await createDocument(env.db, env.project.id, { kind: "latex" });
    assert.equal(await submit(nextFile(), { path: "wrong-kind.md", kind: "doc", docKind: "markdown", docId }), "invalid-update");
    assert.equal(await submit(nextFile(), { path: "missing.md", kind: "doc", docKind: "markdown", docId: "doc_does_not_exist_anywhere" }), "invalid-update");
    assert.equal(await submit(nextFile(), { path: "ok.tex", kind: "doc", docKind: "latex", docId }), "acked");
  });

  test("a document of another project is not a valid reference", async () => {
    await env.db.insertInto("projects").values({ id: "prj_other_validation", name: "Other", owner_id: env.owner.id, manifest_doc_id: "prj_other_validation_manifest" }).onConflict((oc) => oc.doNothing()).execute();
    const foreign = await createDocument(env.db, "prj_other_validation");
    assert.equal(await submit(nextFile(), { path: "foreign.md", kind: "doc", docKind: "markdown", docId: foreign }), "invalid-update");
  });

  test("a blob entry needs a blob uploaded to this project", async () => {
    assert.equal(await submit(nextFile(), { path: "never-uploaded.png", kind: "blob", blobHash: HASH }), "invalid-update");
    await env.db.insertInto("projects").values({ id: "prj_other_blob", name: "Other", owner_id: env.owner.id, manifest_doc_id: "prj_other_blob_manifest" }).onConflict((oc) => oc.doNothing()).execute();
    await uploadBlob(HASH, "prj_other_blob");
    assert.equal(await submit(nextFile(), { path: "other-project.png", kind: "blob", blobHash: HASH }), "invalid-update");
    await uploadBlob(HASH);
    assert.equal(await submit(nextFile(), { path: "uploaded.png", kind: "blob", blobHash: HASH }), "acked");
  });

  test("entries the desktop would skip are rejected", async () => {
    for (const entry of [
      { path: 5, kind: "folder" },
      { path: "a", kind: "symlink" },
      { path: "a.md", kind: "doc", docKind: "pdf", docId: "doc_abcdefghijkl" },
      { path: "a.md", kind: "doc", docKind: "markdown" },
      { path: "a.png", kind: "blob", blobHash: "XYZ" },
    ]) assert.equal(await submit(nextFile(), entry), "invalid-update", JSON.stringify(entry));
    assert.equal(await submit("bad id/with slash", { path: "folder", kind: "folder" }), "invalid-update");
  });

  test("a new name must leave room for sidecars; an existing long name stays valid", async () => {
    const long = `${"a".repeat(250)}.md`;
    assert.equal(await submit(nextFile(), { path: long, kind: "folder" }), "invalid-update", "a new name at the limit is refused");
    // An entry that already sits at the limit (made before the rule) can still change other fields and move folders.
    const fileId = nextFile();
    await env.server.server.context.rooms.transact(env.project.manifestDocId, "manifest", { kind: "system", reason: "import" }, { source: "import" }, (doc: Y.Doc) =>
      doc.getMap(ManifestKeys.files).set(fileId, { fileId, path: long, kind: "folder", createdBy: env.owner.id, createdAt: 1, updatedAt: 1 }));
    assert.equal(await submit(fileId, { path: `moved/${long}`, kind: "folder", updatedAt: 2 }), "acked", "same name, new folder");
    assert.equal(await submit(fileId, { path: `moved/${"b".repeat(250)}.md`, kind: "folder" }), "invalid-update", "a renamed long name is refused");
  });
});
