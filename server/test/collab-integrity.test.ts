// Collaboration audit 2026-11-20, findings S58 to S62 (server side):
// S58 a command id is claimed before its effect, S59 a document belongs to one
// file id, S60 deleting a document is coupled to the manifest and references are
// rechecked when the update commits, S61 one project lock order, S62 the last
// reference to a blob is retired under the hash's lock.
//
// The test server runs on in-process PGlite (one connection), so lock
// interleavings cannot be reproduced here; S61 is covered by running the
// contending operations together and S62 by the lock being held.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import * as Y from "yjs";

import { COMMAND_CLAIM_LEASE_MS, registerCommandHandler } from "../src/api/commands.js";
import { recordOrphanedBlobs } from "../src/blobs/gc.js";
import { HttpError } from "../src/http/errors.js";
import { bindActor, ManifestKeys, MessageType } from "../src/protocol.js";
import { ManifestReferenceChangedError, persistUpdate } from "../src/sync/store.js";
import { json } from "./helpers.js";
import { createDocument, createProject, startSyncEnv, type SyncEnv } from "./support/sync-fixtures.js";

let env: SyncEnv;
before(async () => {
  env = await startSyncEnv({ SYNC_CONNECTIONS_PER_MINUTE: 1000, SYNC_MAX_SOCKETS_PER_ACCOUNT: 100 });
});
after(() => env.close());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let counter = 0;
const next = (prefix: string) => `${prefix}_collab_${++counter}`;

describe("S58: command claims", () => {
  let runs = 0;
  let mode: "ok" | "slow" | "transient" = "ok";
  before(() => {
    registerCommandHandler("review.decide", async () => {
      runs += 1;
      if (mode === "slow") await sleep(150);
      if (mode === "transient") throw new HttpError("internal", "try later");
      return { status: 200, body: { run: runs } };
    });
  });
  const post = (id: string) =>
    json<{ id: string; status: number; body: unknown }>(env.server.url, "/v1/commands", {
      token: env.owner.token, body: { id, kind: "review.decide", reviewId: "rev_x", body: {} },
    });

  test("overlapping submissions of one id run the effect once and everyone converges on its receipt", async () => {
    runs = 0;
    mode = "slow";
    const id = next("cmd");
    const [a, b] = await Promise.all([post(id), post(id)]);
    assert.equal(runs, 1, "the handler ran once");
    const statuses = [a.body.status, b.body.status].sort();
    assert.deepEqual(statuses, [200, 503], "the loser is told to retry");
    const replay = await post(id);
    assert.equal(replay.body.status, 200);
    assert.deepEqual(replay.body.body, { run: 1 });
    assert.equal(runs, 1);
  });

  test("a live claim blocks a duplicate; a claim past its lease is taken over", async () => {
    runs = 0;
    mode = "ok";
    const live = next("cmd");
    await env.db.insertInto("commands").values({ account_id: env.owner.id, id: live, kind: "review.decide", status: null, result: null }).execute();
    assert.equal((await post(live)).body.status, 503);
    assert.equal(runs, 0, "the effect did not run beside a live claim");

    const dead = next("cmd");
    await env.db.insertInto("commands").values({
      account_id: env.owner.id, id: dead, kind: "review.decide", status: null, result: null,
      claimed_at: new Date(Date.now() - COMMAND_CLAIM_LEASE_MS - 5_000),
    }).execute();
    const resumed = await post(dead);
    assert.equal(resumed.body.status, 200);
    assert.equal(runs, 1, "a handler that died before its receipt is resumed");
    const row = await env.db.selectFrom("commands").select("status").where("id", "=", dead).executeTakeFirstOrThrow();
    assert.equal(row.status, 200);
  });

  test("a transient failure frees the id so the replay can succeed", async () => {
    runs = 0;
    mode = "transient";
    const id = next("cmd");
    assert.equal((await post(id)).body.status, 500);
    const left = await env.db.selectFrom("commands").select("id").where("id", "=", id).executeTakeFirst();
    assert.equal(left, undefined, "no claim stays behind");
    mode = "ok";
    assert.equal((await post(id)).body.status, 200);
    assert.equal(runs, 2);
  });
});

describe("S59: a document belongs to one file id", () => {
  async function submit(edit: (files: Y.Map<unknown>) => void): Promise<string> {
    const client = await env.connect();
    try {
      const manifest = env.project.manifestDocId;
      await client.open(manifest);
      const sent = client.edit(manifest, "manifest", (doc: Y.Doc) => edit(doc.getMap(ManifestKeys.files)));
      const result = await client.result(sent);
      return result.type === MessageType.Reject ? result.reason : "acked";
    } finally { await client.close(); }
  }
  const entry = (fileId: string, docId: string, path: string) =>
    ({ fileId, path, kind: "doc", docKind: "markdown", docId, createdBy: env.owner.id, createdAt: 1, updatedAt: 1 });

  test("an entry cannot take over a document created for another file id", async () => {
    const fileId = next("fil");
    const docId = await createDocument(env.db, env.project.id, { fileId });
    const other = next("fil");
    assert.equal(await submit((files) => files.set(other, entry(other, docId, "stolen.md"))), "invalid-update");
    assert.equal(await submit((files) => files.set(fileId, entry(fileId, docId, "own.md"))), "acked");
    // Listed once, a second file id is refused as well.
    assert.equal(await submit((files) => files.set(other, entry(other, docId, "again.md"))), "invalid-update");
  });

  test("one document under two file ids is refused, in one update or across two", async () => {
    const docA = next("doc");
    const docB = next("doc");
    for (const id of [docA, docB]) await env.db.insertInto("documents").values({ id, project_id: env.project.id, kind: "markdown", file_id: null, created_by: env.owner.id }).execute();
    const [f1, f2, f3, f4] = [next("fil"), next("fil"), next("fil"), next("fil")];
    assert.equal(await submit((files) => { files.set(f1, entry(f1, docA, "a1.md")); files.set(f2, entry(f2, docA, "a2.md")); }), "invalid-update");
    assert.equal(await submit((files) => files.set(f3, entry(f3, docB, "b1.md"))), "acked");
    assert.equal(await submit((files) => files.set(f4, entry(f4, docB, "b2.md"))), "invalid-update");
  });
});

describe("S60: document deletion and the manifest", () => {
  test("the document API refuses a document the manifest lists, and deletes it once the entry is gone", async () => {
    const fileId = next("fil");
    const docId = await createDocument(env.db, env.project.id, { fileId });
    const client = await env.connect();
    const manifest = env.project.manifestDocId;
    await client.open(manifest);
    await client.acked(client.edit(manifest, "manifest", (doc) =>
      doc.getMap(ManifestKeys.files).set(fileId, { fileId, path: "listed.md", kind: "doc", docKind: "markdown", docId, createdBy: env.owner.id, createdAt: 1, updatedAt: 1 })));

    const refused = await json<{ error: { code: string } }>(env.server.url, `/v1/documents/${docId}`, { method: "DELETE", token: env.owner.token });
    assert.equal(refused.status, 409);
    const live = await env.db.selectFrom("documents").select("deleted_at").where("id", "=", docId).executeTakeFirstOrThrow();
    assert.equal(live.deleted_at, null, "the row is untouched");

    // Removing the entry retires the document in the manifest's own transaction.
    await client.acked(client.edit(manifest, "manifest", (doc) => { doc.getMap(ManifestKeys.files).delete(fileId); }));
    const gone = await env.db.selectFrom("documents").select("deleted_at").where("id", "=", docId).executeTakeFirstOrThrow();
    assert.notEqual(gone.deleted_at, null);
    await client.close();

    const orphan = await createDocument(env.db, env.project.id);
    assert.equal((await json(env.server.url, `/v1/documents/${orphan}`, { method: "DELETE", token: env.owner.token })).status, 204);
  });

  test("a reference to a document deleted after validation is refused when the update commits", async () => {
    const docId = await createDocument(env.db, env.project.id);
    await env.db.updateTable("documents").set({ deleted_at: new Date() }).where("id", "=", docId).execute();
    const before = await env.db.selectFrom("documents").select("last_server_seq").where("id", "=", env.project.manifestDocId).executeTakeFirstOrThrow();
    await assert.rejects(
      persistUpdate(env.db, {
        docId: env.project.manifestDocId, subdoc: "manifest", accountId: env.owner.id, clientId: "collab-integrity",
        actor: bindActor(env.owner.id, "collab-integrity"), provenance: undefined,
        update: Y.encodeStateAsUpdate(new Y.Doc()), requiredDocIds: [docId], addedDocIds: [docId],
      }),
      ManifestReferenceChangedError,
    );
    const after = await env.db.selectFrom("documents").select("last_server_seq").where("id", "=", env.project.manifestDocId).executeTakeFirstOrThrow();
    assert.equal(after.last_server_seq, before.last_server_seq, "the sequence number was rolled back");
  });
});

describe("S61: one project lock order", () => {
  test("a manifest change that retires a document, a fence, and a document delete run together without failing", async () => {
    const project = await createProject(env.db, env.owner.id);
    const fileId = next("fil");
    const docId = await createDocument(env.db, project.id, { fileId });
    const spare = await createDocument(env.db, project.id);
    const client = await env.connect();
    await client.open(project.manifestDocId);
    await client.acked(client.edit(project.manifestDocId, "manifest", (doc) =>
      doc.getMap(ManifestKeys.files).set(fileId, { fileId, path: "x.md", kind: "doc", docKind: "markdown", docId, createdBy: env.owner.id, createdAt: 1, updatedAt: 1 })));
    const removal = client.edit(project.manifestDocId, "manifest", (doc) => { doc.getMap(ManifestKeys.files).delete(fileId); });
    const calls = await Promise.all([
      client.result(removal),
      json(env.server.url, `/v1/projects/${project.id}/closing`, { method: "POST", token: env.owner.token, body: {} }),
      json(env.server.url, `/v1/documents/${spare}`, { method: "DELETE", token: env.owner.token }),
    ]);
    assert.ok(calls[1].status === 200, "the fence answered");
    assert.ok([204, 409].includes((calls[2] as { status: number }).status), "the delete answered");
    const takedown = await json(env.server.url, `/v1/projects/${project.id}`, { method: "DELETE", token: env.owner.token, body: {} });
    assert.equal(takedown.status, 204);
    await client.close();
  });
});

describe("S62: last-reference blob retirement", () => {
  const HASH = "c".repeat(64);
  test("two projects retiring the last two references leave the orphan recorded", async () => {
    const [one, two] = [await createProject(env.db, env.owner.id), await createProject(env.db, env.owner.id)];
    for (const project of [one, two]) await env.db.insertInto("blobs").values({ project_id: project.id, hash: HASH, size: 1, mime: "image/png" }).execute();
    const results = await Promise.all([one, two].map((project) =>
      json(env.server.url, `/v1/projects/${project.id}`, { method: "DELETE", token: env.owner.token, body: {} })));
    assert.deepEqual(results.map((result) => result.status), [204, 204]);
    const orphan = await env.db.selectFrom("blob_orphans").select("hash").where("hash", "=", HASH).executeTakeFirst();
    assert.equal(orphan?.hash, HASH, "the object stays collectable");
  });

  test("retirement holds the hash's advisory lock, so a concurrent retirement waits for it", async () => {
    await env.db.transaction().execute(async (trx) => {
      await recordOrphanedBlobs(trx, ["d".repeat(64), "e".repeat(64)]);
      const held = await trx.selectFrom("pg_locks" as never).select((eb) => eb.fn.countAll<string>().as("n")).where("locktype" as never, "=", "advisory" as never).executeTakeFirst();
      assert.ok(Number((held as { n: string }).n) >= 2, "one advisory lock per hash");
    });
  });
});
