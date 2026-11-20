// Collaboration integrity review S71 and S72: a fenced takedown is refused unless the owner's
// device reported exporting every thread, message, suggestion and review the server holds, and
// former members can still download the final binaries for a bounded time afterwards.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { collectOrphanedBlobs } from "../src/blobs/gc.js";
import { json } from "./helpers.js";
import { startSyncEnv, type SyncEnv } from "./support/sync-fixtures.js";

let env: SyncEnv;
before(async () => { env = await startSyncEnv(); });
after(() => env.close());

const project = () => `/v1/projects/${env.project.id}`;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function upload(bytes: Buffer, token: string) {
  const response = await fetch(`${env.server.url}${project()}/blobs/${sha(bytes)}`, {
    method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body: bytes,
  });
  assert.ok(response.status === 200 || response.status === 201, `upload ${response.status}`);
}

describe("collab integrity: takedown recovery", () => {
  test("deletion needs a recovery report that covers what only the server holds, and keeps final binaries for former members", async () => {
    const editor = await env.member("editor");
    const outsider = await env.member("viewer");
    await json(env.server.url, `${project()}/members/${outsider.id}`, { method: "DELETE", token: env.owner.token });
    const bytes = Buffer.from("final binary version");
    await upload(bytes, env.owner.token);
    const created = await json(env.server.url, `/v1/documents/${env.docId}/threads`, {
      token: env.owner.token, body: { id: "thr_recovery_0001", anchorId: "anc_recovery_1", quote: "text", body: "Only on the server" },
    });
    assert.equal(created.status, 201);

    const fence = await json(env.server.url, `${project()}/closing`, { method: "POST", token: env.owner.token, body: {} });
    assert.equal(fence.status, 200);

    // No report, or a report that holds less than the server does: the project stays.
    const bare = await json(env.server.url, project(), { method: "DELETE", token: env.owner.token, body: {} });
    assert.equal(bare.status, 409, "a fenced takedown with comments needs the recovery report");
    const short = await json(env.server.url, project(), { method: "DELETE", token: env.owner.token, body: { recovery: { threads: 0, messages: 0, suggestions: 0, reviews: 0 } } });
    assert.equal(short.status, 409);
    assert.equal((await json(env.server.url, project(), { token: env.owner.token })).status, 200);

    const threads = await env.db.selectFrom("threads").select("id").where("project_id", "=", env.project.id).where("deleted_at", "is", null).execute();
    const messages = await env.db.selectFrom("messages").select("id").where("thread_id", "in", threads.map((row) => row.id)).where("deleted_at", "is", null).execute();
    const suggestions = await env.db.selectFrom("suggestions").select("id").where("project_id", "=", env.project.id).execute();
    const reviews = await env.db.selectFrom("reviews").select("id").where("project_id", "=", env.project.id).execute();
    const report = { threads: threads.length, messages: messages.length, suggestions: suggestions.length, reviews: reviews.length };
    assert.ok(report.threads >= 1 && report.messages >= 1);

    const deleted = await json(env.server.url, project(), { method: "DELETE", token: env.owner.token, body: { recovery: report } });
    assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
    assert.ok((await json(env.server.url, project(), { token: editor.token })).status >= 400, "the project is gone");

    // The normal route is gone; the recovery route serves exactly the held blob to former members only.
    const normal = await fetch(`${env.server.url}${project()}/blobs/${sha(bytes)}`, { headers: { authorization: `Bearer ${editor.token}` } });
    assert.ok(normal.status >= 400);
    const recoveryPath = `/v1/takedown-recoveries/${env.project.id}/blobs/${sha(bytes)}`;
    const recovered = await fetch(`${env.server.url}${recoveryPath}`, { headers: { authorization: `Bearer ${editor.token}` } });
    assert.equal(recovered.status, 200);
    assert.deepEqual(Buffer.from(await recovered.arrayBuffer()), bytes);
    assert.equal((await fetch(`${env.server.url}${recoveryPath}`, { headers: { authorization: `Bearer ${outsider.token}` } })).status, 404, "a stranger gets nothing");
    const other = `/v1/takedown-recoveries/${env.project.id}/blobs/${sha(Buffer.from("never held"))}`;
    assert.equal((await fetch(`${env.server.url}${other}`, { headers: { authorization: `Bearer ${editor.token}` } })).status, 404);

    // blob-gc keeps the object while the recovery names it, and lets go once it expires.
    await collectOrphanedBlobs(env.server.server.context, { olderThanMs: -1 });
    assert.equal((await fetch(`${env.server.url}${recoveryPath}`, { headers: { authorization: `Bearer ${editor.token}` } })).status, 200);
    await env.db.updateTable("takedown_recoveries").set({ expires_at: new Date(Date.now() - 1000) }).execute();
    assert.equal((await fetch(`${env.server.url}${recoveryPath}`, { headers: { authorization: `Bearer ${editor.token}` } })).status, 404, "expired");
  });
});
