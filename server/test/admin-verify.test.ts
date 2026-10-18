// verify (server/src/admin/verify.ts): the restore drill's check that every
// document reconstructs, snapshots agree with the log and counts match.
// Runs on PGlite here; the drill runs the same code against Postgres.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { sql } from "kysely";
import * as Y from "yjs";

import { runCli } from "../src/admin/cli.js";
import { tableCounts, verifyDatabase } from "../src/admin/verify.js";
import type { BlobStore } from "../src/blobs/index.js";
import { edit, startCollab, waitUntil, type CollabEnv } from "./support/decisions-env.js";

let env: CollabEnv;

async function documentWithHistory(words: string[], snapshotEvery = true): Promise<string> {
  const client = await env.connect(env.editor);
  const docId = await env.document(client, "start");
  for (const word of words) {
    await edit(client, docId, client.text(docId).length, client.text(docId).length, ` ${word}`);
    if (snapshotEvery) await runCliQuiet("doc", "snapshot", docId);
  }
  await client.acked(client.edit(docId, "meta", (doc) => doc.getMap("meta").set("schemaVersion", 1)));
  await client.close();
  await waitUntil(() => !env.server.server.context.rooms.isLoaded(docId), "room did not unload", 5000);
  return docId;
}

async function runCliQuiet(...argv: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const code = await runCli(argv, { stdout: (text) => (stdout += text), stderr: () => undefined }, { database: env.server.server.context.database });
  return { code, stdout };
}

function checks(report: Awaited<ReturnType<typeof verifyDatabase>>, docId: string): string[] {
  return report.failures.filter((failure) => failure.docId === docId).map((failure) => `${failure.subdoc}:${failure.check}`);
}

before(async () => {
  env = await startCollab({ ROOM_IDLE_MS: 50, LOG_RETENTION_DAYS: 30, SNAPSHOT_EVERY_UPDATES: 3 });
});
after(() => env.close());

describe("verify", () => {
  test("passes on healthy documents, including after compaction and retention", async () => {
    const plain = await documentWithHistory(["one", "two", "three"], false);
    const snapshotted = await documentWithHistory(["four", "five", "six"]);
    const retained = await documentWithHistory(["seven", "eight", "nine", "ten"], false);
    const revision = await env.api("POST", `/v1/documents/${retained}/revisions`, env.editor, { label: "kept" });
    assert.equal(revision.status, 201);
    await edit(await reopen(retained), retained, 0, 0, "new ");
    // Age the first updates past LOG_RETENTION_DAYS so compaction prunes them.
    await sql`update doc_updates set received_at = now() - interval '40 days' where doc_id = ${retained} and server_seq <= 3`.execute(env.db);
    await env.server.server.jobs.runNow("compaction");
    const left = await env.db.selectFrom("doc_updates").select("server_seq").where("doc_id", "=", retained).orderBy("server_seq").execute();
    assert.ok(Number(left[0].server_seq) > 3, "retention pruned the old updates");

    const report = await verifyDatabase(env.db);
    assert.deepEqual(report.failures, []);
    assert.equal(report.ok, true);
    assert.ok(report.documents >= 4);
    assert.ok(report.snapshotsChecked > 0);
    assert.ok(report.updatesReplayed > 10);
    for (const docId of [plain, snapshotted, retained]) assert.deepEqual(checks(report, docId), []);
    assert.equal(report.counts.documents, Number((await env.db.selectFrom("documents").select((eb) => eb.fn.countAll().as("n")).executeTakeFirst())?.n));

    const cli = await runCliQuiet("verify");
    assert.equal(cli.code, 0);
    assert.match(cli.stdout, /^PASS: /);
  });

  test("finds a snapshot that disagrees with the log", async () => {
    const docId = await documentWithHistory(["alpha", "beta"]);
    const other = new Y.Doc();
    other.getText("source").insert(0, "something else entirely");
    await env.db
      .updateTable("doc_snapshots")
      .set({ state: Y.encodeStateAsUpdate(other), state_vector: Y.encodeStateVector(other) })
      .where("doc_id", "=", docId)
      .where("subdoc", "=", "content")
      .execute();
    const report = await verifyDatabase(env.db, { docId });
    assert.ok(checks(report, docId).includes("content:snapshot-log"), JSON.stringify(report.failures));
    assert.equal(report.ok, false);
  });

  test("finds a stored state vector that does not match, a wrong size and a seq behind the log", async () => {
    const docId = await documentWithHistory(["gamma"]);
    await env.db.updateTable("doc_snapshots").set({ state_vector: new Uint8Array([0]) }).where("doc_id", "=", docId).where("subdoc", "=", "content").execute();
    await env.db.updateTable("doc_updates").set({ size: 1 }).where("doc_id", "=", docId).where("server_seq", "=", 1).execute();
    await env.db.updateTable("documents").set({ last_server_seq: 1 }).where("id", "=", docId).execute();
    const found = checks(await verifyDatabase(env.db, { docId }), docId);
    assert.ok(found.includes("content:snapshot-vector"), found.join());
    assert.ok(found.includes("content:size"), found.join());
    assert.ok(found.includes("content:seq"), found.join());
  });

  test("finds a log that no longer integrates (a missing update)", async () => {
    const docId = await documentWithHistory(["delta", "epsilon", "zeta"], false);
    await env.db.deleteFrom("doc_updates").where("doc_id", "=", docId).where("server_seq", "=", 2).execute();
    const found = checks(await verifyDatabase(env.db, { docId }), docId);
    assert.ok(found.includes("content:log-pending"), found.join());
  });

  test("compares counts with the ones recorded at backup time and exits 1 on failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "libera-verify-"));
    try {
      // Restrict the document checks to a healthy one: only the counts matter here.
      const healthy = await documentWithHistory(["eta"]);
      const fresh = await tableCounts(env.db);
      const good = join(dir, "good.json");
      await writeFile(good, JSON.stringify(fresh));
      assert.equal((await runCliQuiet("verify", "--doc", healthy, "--expect", good)).code, 0);
      const bad = join(dir, "bad.json");
      await writeFile(bad, JSON.stringify({ ...fresh, doc_updates: fresh.doc_updates + 1, unknown_table: 3 }));
      const run = await runCliQuiet("verify", "--doc", healthy, "--expect", bad, "--json");
      assert.equal(run.code, 1);
      const report = JSON.parse(run.stdout);
      assert.deepEqual(report.failures.map((failure: { check: string }) => failure.check), ["count"]);
      assert.equal((await runCliQuiet("verify", "--expect", join(dir, "missing.json"))).code, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("verify --blobs", () => {
  test("reports recorded blobs that the blob store does not have", async () => {
    const present = "a".repeat(64);
    const missing = "b".repeat(64);
    for (const hash of [present, missing]) {
      await env.db.insertInto("blobs").values({ project_id: env.project.id, hash, size: 1, mime: "image/png", created_by: env.owner.id }).execute();
    }
    const store: BlobStore = { put: async () => undefined, get: async () => null, has: async (hash) => hash === present };
    const report = await verifyDatabase(env.db, { docId: "none", blobStore: store });
    assert.equal(report.blobsChecked, 2);
    assert.deepEqual(report.failures.map((failure) => failure.check), ["blob-missing"]);
    assert.match(report.failures[0].detail, new RegExp(missing));
    await env.db.deleteFrom("blobs").where("hash", "in", [present, missing]).execute();
  });
});

async function reopen(docId: string) {
  const client = await env.connect(env.editor);
  await client.open(docId);
  return client;
}
