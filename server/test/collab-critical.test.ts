import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { ManifestKeys } from "../src/protocol.js";
import { json } from "./helpers.js";
import { startSyncEnv } from "./support/sync-fixtures.js";

for (const kind of ["blob", "folder"] as const) test(`R19: an offline ${kind} rename cannot resurrect a retired file identity`, async () => {
  const env = await startSyncEnv();
  const client = await env.connect();
  const offline = new Y.Doc();
  const id = `fil_retired_${kind}`;
  const docId = env.project.manifestDocId;
  try {
    await client.open(docId);
    const entry = { fileId: id, kind, path: kind === "blob" ? "photo.png" : "folder", ...(kind === "blob" ? { blobHash: "a".repeat(64) } : {}) };
    await client.acked(client.edit(docId, "manifest", (doc) => doc.getMap(ManifestKeys.files).set(id, entry)));
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(client.doc(docId, "manifest")));
    const base = Y.encodeStateVector(offline);
    offline.getMap(ManifestKeys.files).set(id, { ...entry, path: kind === "blob" ? "renamed.png" : "renamed" });
    const update = Y.encodeStateAsUpdate(offline, base);
    await client.acked(client.edit(docId, "manifest", (doc) => doc.getMap(ManifestKeys.files).delete(id)));
    assert.ok(await env.db.selectFrom("file_tombstones").select("file_id").where("project_id", "=", env.project.id).where("file_id", "=", id).executeTakeFirst());
    // Simulate a deletion made before the SQL tombstone migration. The Yjs
    // manifest still carries its retired map key through snapshots.
    await env.db.deleteFrom("file_tombstones").where("project_id", "=", env.project.id).where("file_id", "=", id).execute();
    const rejected = await client.rejected(client.sendUpdate({ docId, subdoc: "manifest", clientSeq: client.nextSeq(), update }));
    assert.equal(rejected.reason, "invalid-update");
    await client.rollback(docId);
    assert.equal(client.doc(docId, "manifest").getMap(ManifestKeys.files).has(id), false);
    await client.acked(client.edit(docId, "manifest", (doc) => doc.getMap(ManifestKeys.files).set(`${id}_new`, { ...entry, fileId: `${id}_new` })));
  } finally { offline.destroy(); await client.close(); await env.close(); }
});

test("R15: server deletion rejects an export from an older manifest sequence", async () => {
  const env = await startSyncEnv();
  const client = await env.connect();
  try {
    await client.open(env.project.manifestDocId);
    const ack = await client.acked(client.edit(env.project.manifestDocId, "manifest", (doc) => doc.getMap(ManifestKeys.files).set("fil_export", { kind: "folder", path: "new-folder" })));
    const route = `/v1/projects/${env.project.id}`;
    const stale = await json(env.server.url, route, { method: "DELETE", token: env.owner.token, body: { expectedManifestSeq: 0 } });
    assert.equal(stale.status, 409);
    assert.equal((await json(env.server.url, route, { token: env.owner.token })).status, 200);
    const latest = await json(env.server.url, route, { method: "DELETE", token: env.owner.token, body: { expectedManifestSeq: ack.serverSeq } });
    assert.equal(latest.status, 204);
  } finally { await client.close(); await env.close(); }
});
