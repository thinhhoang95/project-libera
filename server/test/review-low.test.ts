// Regression for the November 2026 collaboration review's Low server finding:
// a taken-down project's blob objects are reclaimed after a grace period,
// while ones another project still references stay (R46).
import assert from "node:assert/strict";
import type { Readable } from "node:stream";
import { after, before, test } from "node:test";

import { collectOrphanedBlobs } from "../src/blobs/gc.js";
import { setBlobStore, type BlobStore } from "../src/blobs/index.js";
import { json } from "./helpers.js";
import { createProject } from "./support/sync-fixtures.js";
import { startSyncEnv, type SyncEnv } from "./support/sync-fixtures.js";

const ONLY = "a".repeat(64);
const SHARED = "b".repeat(64);

let env: SyncEnv;
const stored = new Set<string>([ONLY, SHARED]);
before(async () => {
  env = await startSyncEnv();
  const store: BlobStore = {
    async put(hash) { stored.add(hash); },
    async get(): Promise<Readable | null> { return null; },
    async has(hash) { return stored.has(hash); },
    async delete(hash) { stored.delete(hash); },
  };
  setBlobStore(env.server.server.context, store);
});
after(async () => {
  await env.close();
});

test("R46: a taken-down project's own blobs are reclaimed after the grace period; shared ones stay", async () => {
  const other = await createProject(env.db, env.owner.id);
  const row = (projectId: string, hash: string) => ({ project_id: projectId, hash, size: 3, mime: "image/png", created_by: env.owner.id });
  await env.db.insertInto("blobs").values([row(env.project.id, ONLY), row(env.project.id, SHARED), row(other.id, SHARED)]).execute();

  const deleted = await json(env.server.url, `/v1/projects/${env.project.id}`, { method: "DELETE", token: env.owner.token });
  assert.ok(deleted.status === 204 || deleted.status === 200, JSON.stringify(deleted));
  const orphans = (await env.db.selectFrom("blob_orphans").select("hash").execute()).map((entry) => entry.hash);
  assert.deepEqual(orphans, [ONLY], "only the hash no project references");

  // Within the grace period nothing goes.
  assert.equal(await collectOrphanedBlobs(env.server.server.context), 0);
  assert.ok(stored.has(ONLY));

  assert.equal(await collectOrphanedBlobs(env.server.server.context, { olderThanMs: -1_000 }), 1);
  assert.deepEqual([stored.has(ONLY), stored.has(SHARED)], [false, true]);
  assert.deepEqual(await env.db.selectFrom("blob_orphans").selectAll().execute(), []);
});

test("R46: a hash referenced again before collection is kept", async () => {
  const project = await createProject(env.db, env.owner.id);
  const hash = "c".repeat(64);
  stored.add(hash);
  await env.db.insertInto("blob_orphans").values({ hash }).execute();
  await env.db.insertInto("blobs").values({ project_id: project.id, hash, size: 3, mime: "image/png", created_by: env.owner.id }).execute();
  assert.equal(await collectOrphanedBlobs(env.server.server.context, { olderThanMs: -1_000 }), 0);
  assert.ok(stored.has(hash));
  assert.deepEqual(await env.db.selectFrom("blob_orphans").selectAll().execute(), []);
});
