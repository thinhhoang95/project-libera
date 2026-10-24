import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import type * as Y from "yjs";

import { ManifestKeys, type ProjectSummary } from "../src/protocol.js";
import { addMember, createProject, register, request, startApi, type ApiHarness } from "./support/api-harness.js";
import { startSyncEnv, type SyncEnv } from "./support/sync-fixtures.js";

function setEntry(map: string, key: string, value: unknown) {
  return (doc: Y.Doc) => doc.getMap(map).set(key, value);
}

describe("shared albums: projects", () => {
  let h: ApiHarness;
  before(async () => {
    h = await startApi();
  });
  after(async () => {
    await h.close();
  });

  test("a project is a notebook unless created as an album, and lists say which", async () => {
    const owner = await register(h, "owner");
    const notebook = await createProject(h, owner, "Notes");
    assert.equal(notebook.kind, "notebook");
    const created = await request(h, "POST", "/v1/projects", owner, { name: "Trip", kind: "album" });
    assert.equal(created.status, 201);
    assert.equal((created.body as ProjectSummary).kind, "album");
    const listed = await request(h, "GET", "/v1/projects", owner);
    assert.deepEqual(
      (listed.body as ProjectSummary[]).map((project) => [project.name, project.kind]),
      [["Notes", "notebook"], ["Trip", "album"]],
    );
    const single = await request(h, "GET", `/v1/projects/${created.body.id}`, owner);
    assert.equal(single.body.kind, "album");
    const unknown = await request(h, "POST", "/v1/projects", owner, { name: "X", kind: "folder" });
    assert.equal(unknown.status, 400);
  });

  test("photo activity notifies the other members once, merging later additions while unread", async () => {
    const owner = await register(h, "owner");
    const editor = await register(h, "editor");
    const viewer = await register(h, "viewer");
    const album = (await request(h, "POST", "/v1/projects", owner, { name: "Holidays", kind: "album" })).body as ProjectSummary;
    await addMember(h, album.id, editor, "editor");
    await addMember(h, album.id, viewer, "viewer");

    assert.equal((await request(h, "POST", `/v1/projects/${album.id}/album-activity`, editor, { added: 3, fileIds: ["fil_a", "fil_b"] })).status, 204);
    assert.equal((await request(h, "POST", `/v1/projects/${album.id}/album-activity`, editor, { added: 2, fileIds: ["fil_c"] })).status, 204);

    const forViewer = (await request(h, "GET", "/v1/notifications", viewer)).body as Array<{ kind: string; payload: any; docId: string }>;
    assert.equal(forViewer.length, 1);
    assert.equal(forViewer[0].kind, "album-photos-added");
    assert.equal(forViewer[0].payload.count, 5);
    assert.equal(forViewer[0].payload.albumName, "Holidays");
    assert.equal(forViewer[0].docId, album.manifestDocId);
    assert.deepEqual(forViewer[0].payload.fileIds, ["fil_c", "fil_a", "fil_b"]);
    const forOwner = (await request(h, "GET", "/v1/notifications", owner)).body as unknown[];
    assert.equal(forOwner.length, 1);
    const forEditor = (await request(h, "GET", "/v1/notifications", editor)).body as unknown[];
    assert.equal(forEditor.length, 0, "the member who added the photos is not told");

    // Viewers cannot add photos, so they cannot report adding them.
    assert.equal((await request(h, "POST", `/v1/projects/${album.id}/album-activity`, viewer, { added: 1 })).status, 403);
    const notebook = await createProject(h, owner, "Not an album");
    assert.equal((await request(h, "POST", `/v1/projects/${notebook.id}/album-activity`, owner, { added: 1 })).status, 400);
  });
});

describe("shared albums: manifest rules", () => {
  let env: SyncEnv;
  before(async () => {
    env = await startSyncEnv();
    await env.db.updateTable("projects").set({ kind: "album" }).where("id", "=", env.project.id).execute();
  });
  after(async () => {
    await env.close();
  });

  const photo = (path: string, extra: Record<string, unknown> = {}) => ({
    fileId: "f1",
    path,
    kind: "blob",
    blobHash: "a".repeat(64),
    mime: "image/jpeg",
    createdBy: env.owner.id,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  });

  test("an album takes flat photo entries only", async () => {
    const client = await env.connect();
    await client.open(env.project.manifestDocId);
    const refused = [
      photo("trip/beach.jpg"),
      photo("notes.md", { mime: "text/markdown" }),
      photo("drawing.svg", { mime: "image/svg+xml" }),
      photo("beach.jpg", { kind: "doc", docId: "d1", docKind: "markdown" }),
      photo("beach.jpg", { mime: "image/png" }),
    ];
    for (const entry of refused) {
      const rejected = await client.rejected(client.edit(env.project.manifestDocId, "manifest", setEntry(ManifestKeys.files, "f1", entry)));
      assert.equal(rejected.reason, "invalid-update", JSON.stringify(entry));
      await client.rollback(env.project.manifestDocId);
    }
    await client.acked(client.edit(env.project.manifestDocId, "manifest", setEntry(ManifestKeys.files, "f1", photo("Beach.JPG"))));
    await client.close();
  });

  test("photo details describe a photo of the album and are plain records", async () => {
    const client = await env.connect();
    await client.open(env.project.manifestDocId);
    const details = (extra: Record<string, unknown> = {}) => ({ fileId: "f1", addedBy: env.owner.id, updatedAt: 1, ...extra });
    for (const [key, value] of [
      ["missing", { ...details(), fileId: "missing" }],
      ["f1", details({ fileId: "f2" })],
      ["f1", details({ caption: "x".repeat(2001) })],
      ["f1", details({ originalHash: "not-a-hash" })],
      ["f1", details({ updatedBy: "someone-else" })],
      ["f1", { fileId: "f1" }],
    ] as const) {
      const rejected = await client.rejected(client.edit(env.project.manifestDocId, "manifest", setEntry(ManifestKeys.photos, key, value)));
      assert.equal(rejected.reason, "invalid-update", JSON.stringify(value));
      await client.rollback(env.project.manifestDocId);
    }
    await client.acked(
      client.edit(env.project.manifestDocId, "manifest", setEntry(ManifestKeys.photos, "f1", details({ caption: "Sunset", updatedBy: env.owner.id, originalHash: "b".repeat(64) }))),
    );
    await client.close();
  });

  test("viewers cannot change an album", async () => {
    const viewer = await env.member("viewer");
    const client = await env.connect(viewer);
    await client.open(env.project.manifestDocId);
    const rejected = await client.rejected(
      client.edit(env.project.manifestDocId, "manifest", setEntry(ManifestKeys.photos, "f1", { fileId: "f1", addedBy: viewer.id, updatedAt: 2 })),
    );
    assert.equal(rejected.reason, "forbidden");
    await client.close();
  });
});

describe("notebook manifests", () => {
  let env: SyncEnv;
  before(async () => {
    env = await startSyncEnv();
  });
  after(async () => {
    await env.close();
  });

  test("have no photo details", async () => {
    const client = await env.connect();
    await client.open(env.project.manifestDocId);
    const rejected = await client.rejected(
      client.edit(env.project.manifestDocId, "manifest", setEntry(ManifestKeys.photos, "f1", { fileId: "f1", addedBy: env.owner.id, updatedAt: 1 })),
    );
    assert.equal(rejected.reason, "invalid-update");
    await client.close();
  });
});
