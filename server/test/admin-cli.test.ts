// The admin recovery CLI (implementation plan §7) against a real server on
// in-memory PGlite: inspect, text, rebuild as a forward edit, quarantine,
// export, snapshot, accounts and audit. verify has its own file.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import * as Y from "yjs";

import { runCli } from "../src/admin/cli.js";
import { getBlobStore } from "../src/blobs/index.js";
import { newId } from "../src/ids.js";
import { CloseCode, ManifestKeys, type ManifestEntry } from "../src/protocol.js";
import { json } from "./helpers.js";
import { edit, startCollab, waitUntil, type CollabEnv } from "./support/decisions-env.js";
import type { SyncTestClient } from "./support/sync-client.js";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  json: any;
}

let env: CollabEnv;
let blobDir: string;

async function cli(...argv: string[]): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    [...argv, "--server", env.server.url],
    { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) },
    { database: env.server.server.context.database, config: { BLOB_DIR: blobDir, PORT: 0 } },
  );
  let parsed: unknown;
  if (argv.includes("--json")) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = undefined;
    }
  }
  return { code, stdout, stderr, json: parsed };
}

/** Closes the client and waits until the server has unloaded the document's room. */
async function unload(client: SyncTestClient, docId: string): Promise<void> {
  await client.close();
  await waitUntil(() => !env.server.server.context.rooms.isLoaded(docId), "room did not unload", 5000);
}

async function seqOf(docId: string): Promise<number> {
  return env.server.server.context.rooms.currentServerSeq(docId);
}

before(async () => {
  blobDir = await mkdtemp(join(tmpdir(), "libera-admin-blobs-"));
  env = await startCollab({ ROOM_IDLE_MS: 50, BLOB_DIR: blobDir });
});
after(async () => {
  await env.close();
  await rm(blobDir, { recursive: true, force: true });
});

describe("admin CLI: usage and inspection", () => {
  test("usage errors exit 2 and unknown documents exit 1", async () => {
    assert.equal((await cli()).code, 2);
    assert.equal((await cli("doc", "frobnicate")).code, 2);
    const missing = await cli("doc", "inspect", "doc_missing", "--json");
    assert.equal(missing.code, 1);
    assert.match(missing.json.error, /does not exist/);
  });

  test("doc inspect summarizes the log by user, day and provenance and prints a range of entries", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "Hello");
    await edit(client, docId, 5, 5, " world");
    await client.acked(client.edit(docId, "content", (doc) => doc.getText("source").insert(0, "AI: "), { source: "ai", feature: "rewrite" }));
    const other = await env.connect(env.editor2);
    await other.open(docId);
    await edit(other, docId, 0, 0, "> ");

    const run = await cli("doc", "inspect", docId, "--updates", "1..2", "--json");
    assert.equal(run.code, 0, run.stderr);
    const info = run.json;
    assert.equal(info.kind, "markdown");
    assert.equal(info.lastServerSeq, 4);
    const users = Object.fromEntries(info.byUser.map((row: any) => [`${row.accountId}/${row.actor}`, row.updates]));
    assert.equal(users[`${env.editor.id}/user`], 2);
    assert.equal(users[`${env.editor.id}/ai:rewrite`], 1);
    assert.equal(users[`${env.editor2.id}/user`], 1);
    assert.equal(info.byDay.length, 1);
    assert.equal(info.byDay[0].updates, 4);
    assert.deepEqual(
      Object.fromEntries(info.byProvenance.map((row: any) => [row.source, row.updates])),
      { "-": 3, ai: 1 },
    );
    assert.deepEqual(info.updates.map((u: any) => u.serverSeq), [1, 2]);
    assert.equal(info.log[0].subdoc, "content");

    const human = await cli("doc", "inspect", docId);
    assert.match(human.stdout, /By user/);
    assert.match(human.stdout, /ai:rewrite/);

    const now = await cli("doc", "text", docId);
    assert.equal(now.stdout, "> AI: Hello world\n");
    const at2 = await cli("doc", "text", docId, "--at", "2", "--json");
    assert.equal(at2.json.text, "Hello world");
    assert.equal((await cli("doc", "text", docId, "--at", "99")).code, 1);
  });
});

describe("admin CLI: doc rebuild", () => {
  test("restores an old state as a new forward update by system:migration and keeps history", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "The first draft.");
    const good = await seqOf(docId);
    await edit(client, docId, 4, 9, "broken");
    await edit(client, docId, 0, 0, "XXX ");
    const before = await seqOf(docId);
    const wrong = client.text(docId);

    const dry = await cli("doc", "rebuild", docId, "--to", String(good), "--dry-run", "--json");
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(dry.json.changed, true);
    assert.equal(await seqOf(docId), before, "a dry run writes nothing");
    const dryText = await cli("doc", "rebuild", docId, "--to", String(good), "--dry-run");
    assert.match(dryText.stdout, /- XXX The broken draft\./);
    assert.match(dryText.stdout, /\+ The first draft\./);

    const refused = await cli("doc", "rebuild", docId, "--to", String(good));
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /is loaded on the running server/);

    await unload(client, docId);
    const run = await cli("doc", "rebuild", docId, "--to", String(good), "--json");
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.json.serverSeq, before + 1);
    assert.ok(run.json.checkpointRevisionId);

    const rows = await env.db.selectFrom("doc_updates").selectAll().where("doc_id", "=", docId).orderBy("server_seq").execute();
    assert.equal(rows.length, before + 1, "nothing was deleted or rewritten");
    const last = rows[rows.length - 1];
    assert.deepEqual(last.actor, { kind: "system", reason: "migration" });
    assert.equal(last.client_id, "server");
    assert.equal(last.account_id, null);
    assert.equal((await cli("doc", "text", docId)).stdout, "The first draft.\n");
    assert.equal((await cli("doc", "text", docId, "--at", String(before))).stdout, `${wrong}\n`);

    // A client reopening gets the rebuilt text, and the checkpoint undoes it.
    const again = await env.connect(env.editor);
    await again.open(docId);
    assert.equal(again.text(docId), "The first draft.");
    const restore = await env.api("POST", `/v1/documents/${docId}/restore`, env.editor, { revisionId: run.json.checkpointRevisionId });
    assert.equal(restore.status, 200);
    await waitUntil(() => again.text(docId) === wrong, "restore of the checkpoint did not arrive");

    const audit = await cli("audit", "tail", "--project", env.project.id, "--json");
    assert.ok(audit.json.entries.some((entry: any) => entry.action === "admin.document.rebuild" && entry.target === docId));
    await unload(again, docId);

    const same = await cli("doc", "rebuild", docId, "--to", String(await seqOf(docId)), "--json");
    assert.equal(same.json.changed, false);
  });

  test("rebuilds annotations (map keys) too and refuses unreachable seqs", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "text");
    await client.acked(client.edit(docId, "meta", (doc) => doc.getMap("meta").set("schemaVersion", 1)));
    const good = await seqOf(docId);
    await client.acked(client.edit(docId, "meta", (doc) => doc.getMap("meta").set("extra", "x")));
    await unload(client, docId);
    const run = await cli("doc", "rebuild", docId, "--to", String(good), "--subdoc", "meta", "--json");
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.json.changes[0].maps, [{ map: "meta", key: "extra", change: "removed" }]);
    const meta = await env.server.server.context.rooms.withDocs(docId, (docs) => docs.meta.getMap("meta").toJSON());
    assert.deepEqual(meta, { schemaVersion: 1 });
    assert.equal((await cli("doc", "rebuild", docId, "--to", "999")).code, 1);
    assert.equal((await cli("doc", "rebuild", docId, "--to", "1", "--subdoc", "manifest")).code, 1);
  });
});

describe("admin CLI: doc quarantine", () => {
  test("moves a range and the updates that depend on it, rebuilds the snapshot, and the document keeps working", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "Good start. ");
    const other = await env.connect(env.editor2);
    await other.open(docId);
    // The bad update, then one that builds on it (typed right after it), then an independent one.
    const bad = await edit(client, docId, client.text(docId).length, client.text(docId).length, "GARBAGE");
    await waitUntil(() => other.text(docId).includes("GARBAGE"), "other did not get the bad update");
    const dependent = await edit(client, docId, client.text(docId).length, client.text(docId).length, " more garbage");
    const independent = await edit(other, docId, 0, 0, "Title\n");
    await client.acked(client.edit(docId, "meta", (doc) => doc.getMap("meta").set("schemaVersion", 1)));
    await env.server.server.jobs.runNow("compaction");
    await cli("doc", "snapshot", docId);

    assert.equal((await cli("doc", "quarantine", docId, "--range", `${bad}..${bad}`)).code, 1, "needs --yes");
    const refused = await cli("doc", "quarantine", docId, "--range", `${bad}..${bad}`, "--yes");
    assert.match(refused.stderr, /is loaded on the running server/);

    await other.close();
    await unload(client, docId);
    const dry = await cli("doc", "quarantine", docId, "--range", `${bad}..${bad}`, "--dry-run", "--json");
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual(dry.json.subdocs, [{ subdoc: "content", baseSeq: null, rangeSeqs: [bad], dependentSeqs: [dependent] }]);
    assert.equal(
      Number((await env.db.selectFrom("doc_updates").select((eb) => eb.fn.countAll().as("n")).where("doc_id", "=", docId).executeTakeFirst())?.n),
      await seqOf(docId),
      "a dry run moves nothing",
    );

    const run = await cli("doc", "quarantine", docId, "--range", `${bad}..${bad}`, "--yes", "--json");
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.json.moved, 2);
    const quarantined = await env.db.selectFrom("quarantined_updates").selectAll().where("doc_id", "=", docId).orderBy("server_seq").execute();
    assert.deepEqual(
      quarantined.map((row) => [Number(row.server_seq), row.reason]),
      [
        [bad, "range"],
        [dependent, "dependent"],
      ],
    );
    assert.ok(quarantined.every((row) => row.quarantine_id === run.json.quarantineId));
    const remaining = await env.db.selectFrom("doc_updates").select("server_seq").where("doc_id", "=", docId).execute();
    assert.ok(!remaining.some((row) => Number(row.server_seq) === bad || Number(row.server_seq) === dependent));
    assert.ok(remaining.some((row) => Number(row.server_seq) === independent));
    const snapshots = await env.db.selectFrom("doc_snapshots").select(["subdoc", "upto_server_seq"]).where("doc_id", "=", docId).where("subdoc", "=", "content").execute();
    assert.deepEqual(snapshots.map((row) => Number(row.upto_server_seq)), [await seqOf(docId)]);

    assert.equal((await cli("doc", "text", docId)).stdout, "Title\nGood start. \n");
    const verify = await cli("verify", "--doc", docId, "--json");
    assert.equal(verify.json.ok, true, JSON.stringify(verify.json.failures));

    // A fresh client loads the document and can keep editing.
    const fresh = await env.connect(env.editor);
    await fresh.open(docId);
    assert.equal(fresh.text(docId), "Title\nGood start. ");
    await edit(fresh, docId, fresh.text(docId).length, fresh.text(docId).length, "Fine.");
    assert.equal((await cli("doc", "inspect", docId, "--json")).json.quarantinedUpdates, 2);
    await fresh.close();
  });

  test("refuses ranges with no updates or compacted by retention", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "abc");
    await unload(client, docId);
    assert.match((await cli("doc", "quarantine", docId, "--range", "50..60", "--yes")).stderr, /No retained updates/);
    assert.equal((await cli("doc", "quarantine", docId, "--range", "1..", "--yes")).code, 1);
    // Simulate retention: snapshot at 1, update 1 pruned, then a new update.
    await cli("doc", "snapshot", docId);
    const again = await env.connect(env.editor);
    await again.open(docId);
    await edit(again, docId, 3, 3, "d");
    await unload(again, docId);
    await env.db.deleteFrom("doc_updates").where("doc_id", "=", docId).where("server_seq", "=", 1).execute();
    const run = await cli("doc", "quarantine", docId, "--range", "1..2", "--yes");
    assert.equal(run.code, 1);
    assert.match(run.stderr, /compacted|No retained/);
  });
});

describe("admin CLI: export and snapshot", () => {
  test("project export writes every manifest entry at its path plus blobs", async () => {
    const context = env.server.server.context;
    const client = await env.connect(env.editor);
    const notes = await env.document(client, "# Notes\n");
    const chapter = await env.document(client, "\\section{One}\n");
    const orphan = await env.document(client, "not in the manifest");
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const hash = createHash("sha256").update(png).digest("hex");
    await getBlobStore(context).put(hash, png, "image/png");
    await env.db.insertInto("blobs").values({ project_id: env.project.id, hash, size: png.length, mime: "image/png", created_by: env.owner.id }).execute();
    const spare = new Uint8Array([1, 2, 3, 4]);
    const spareHash = createHash("sha256").update(spare).digest("hex");
    await getBlobStore(context).put(spareHash, spare, "application/octet-stream");
    await env.db.insertInto("blobs").values({ project_id: env.project.id, hash: spareHash, size: 4, mime: "application/octet-stream", created_by: env.owner.id }).execute();

    const entry = (path: string, extra: Partial<ManifestEntry>): ManifestEntry => ({
      fileId: newId("fil"),
      path,
      kind: "doc",
      createdBy: env.owner.id,
      createdAt: 1,
      updatedAt: 1,
      ...extra,
    });
    const entries = [
      entry("notes.md", { docId: notes, docKind: "markdown" }),
      entry("thesis/chapter1.tex", { docId: chapter, docKind: "latex" }),
      entry("thesis/figures", { kind: "folder" }),
      entry("thesis/figures/plot.png", { kind: "blob", blobHash: hash, size: png.length }),
      entry("../escape.md", { docId: notes }),
    ];
    await context.rooms.transact(env.project.manifestDocId, "manifest", { kind: "system", reason: "import" }, { source: "import" }, (doc: Y.Doc) => {
      for (const item of entries) doc.getMap(ManifestKeys.files).set(item.fileId, item);
    });

    const list = await cli("docs", "list", "--project", env.project.id, "--json");
    const paths = Object.fromEntries(list.json.documents.map((doc: any) => [doc.id, doc.path]));
    assert.equal(paths[notes], "notes.md");
    assert.equal(paths[env.project.manifestDocId], "(manifest)");
    assert.equal(paths[orphan], null);

    const out = await mkdtemp(join(tmpdir(), "libera-export-"));
    try {
      const target = join(out, "project");
      const run = await cli("project", "export", env.project.id, "--out", target, "--json");
      assert.equal(run.code, 0, run.stderr);
      assert.equal(await readFile(join(target, "notes.md"), "utf8"), "# Notes\n");
      assert.equal(await readFile(join(target, "thesis", "chapter1.tex"), "utf8"), "\\section{One}\n");
      assert.deepEqual(new Uint8Array(await readFile(join(target, "thesis", "figures", "plot.png"))), png);
      assert.deepEqual(new Uint8Array(await readFile(join(target, ".libera-export", "blobs", spareHash))), spare);
      assert.equal(await readFile(join(target, ".libera-export", "unlisted", `${orphan}.md`), "utf8"), "not in the manifest");
      const manifest = JSON.parse(await readFile(join(target, ".libera-export", "manifest.json"), "utf8"));
      assert.equal(manifest.entries.length, 5);
      assert.deepEqual(run.json.skipped.map((skip: any) => skip.path), ["../escape.md"]);
      assert.ok(!(await readdir(out)).includes("escape.md"));
      assert.equal((await cli("project", "export", env.project.id, "--out", target)).code, 1, "refuses a non-empty directory");

      const file = join(out, "one.md");
      const single = await cli("doc", "export", notes, "--out", file, "--json");
      assert.equal(single.code, 0, single.stderr);
      assert.equal(await readFile(file, "utf8"), "# Notes\n");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("doc snapshot writes a snapshot of every sub-document at the current seq", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "snap");
    const run = await cli("doc", "snapshot", docId, "--json");
    assert.equal(run.code, 0, run.stderr);
    const seq = await seqOf(docId);
    assert.deepEqual(
      run.json.snapshots.map((s: any) => [s.subdoc, s.uptoServerSeq]),
      [
        ["content", seq],
        ["annotations", seq],
        ["meta", seq],
      ],
    );
    const rows = await env.db.selectFrom("doc_snapshots").select("subdoc").where("doc_id", "=", docId).execute();
    assert.equal(rows.length, 3);
  });
});

describe("admin CLI: accounts and audit", () => {
  test("account disable revokes sessions and closes open sockets; enable and reset-password work", async () => {
    const email = `admin-${Date.now()}@example.test`;
    const registered = await json<any>(env.server.url, "/v1/auth/register", {
      body: { email, password: "correct horse battery", displayName: "Disposable" },
    });
    assert.equal(registered.status, 201);
    const accountId = registered.body.account.id;
    const socket = await env.connect({ id: accountId, familyId: "", token: registered.body.accessToken });
    assert.ok(socket.welcome);

    const list = await cli("accounts", "list", "--json");
    const row = list.json.accounts.find((account: any) => account.email === email);
    assert.equal(row.activeSessions, 1);

    const disabled = await cli("account", "disable", email.toUpperCase(), "--json");
    assert.equal(disabled.code, 0, disabled.stderr);
    assert.equal(disabled.json.revokedSessions, 1);
    assert.equal(disabled.json.socketsClosed, true);
    assert.equal((await socket.closed).code, CloseCode.AuthRevoked);
    const refresh = await json(env.server.url, "/v1/auth/refresh", { body: { refreshToken: registered.body.refreshToken } });
    assert.equal(refresh.status, 401);
    const login = await json(env.server.url, "/v1/auth/login", { body: { email, password: "correct horse battery" } });
    assert.equal(login.status, 401);

    assert.equal((await cli("account", "enable", email)).code, 0);
    const reset = await cli("account", "reset-password", email, "--json");
    assert.equal(reset.code, 0, reset.stderr);
    const password = reset.json.temporaryPassword as string;
    assert.match(password, /^[A-Za-z2-9]{20}$/);
    assert.equal((await json(env.server.url, "/v1/auth/login", { body: { email, password: "correct horse battery" } })).status, 401);
    assert.equal((await json(env.server.url, "/v1/auth/login", { body: { email, password } })).status, 200);

    const audit = await cli("audit", "tail", "--limit", "5", "--json");
    const actions = audit.json.entries.map((entry: any) => entry.action);
    assert.deepEqual(actions.slice(-3), ["admin.account.disable", "admin.account.enable", "admin.account.reset-password"]);
    assert.equal((await cli("account", "disable", "nobody@example.test")).code, 1);
    const human = await cli("audit", "tail", "--limit", "1");
    assert.match(human.stdout, /admin\.account\.reset-password/);
  });

  test("signup-code create prints a code once; list and revoke manage it", async () => {
    const created = await cli("signup-code", "create", "--note", "for Sam", "--uses", "2", "--json");
    assert.equal(created.code, 0, created.stderr);
    const code = created.json.code as string;
    assert.match(code, /^LBR-[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);
    const id = created.json.id as string;
    const listed = await cli("signup-code", "list", "--json");
    const row = (listed.json.codes as any[]).find((c) => c.id === id);
    assert.equal(row.status, "active");
    assert.equal(row.maxUses, 2);
    assert.ok(!JSON.stringify(listed.json).includes(code), "the code itself is never listed");
    assert.equal((await cli("signup-code", "revoke", id)).code, 0);
    assert.equal((await cli("signup-code", "revoke", id)).code, 1, "already revoked");
    const after = await cli("signup-code", "list", "--json");
    assert.equal((after.json.codes as any[]).find((c) => c.id === id).status, "revoked");
    assert.equal((await cli("signup-code", "create", "--uses", "0")).code, 1);
  });

  test("account create makes an owner-to-be with a one-time password, even with sign-up closed", async () => {
    const email = `First.Owner-${Date.now()}@Example.test`;
    const created = await cli("account", "create", email, "--name", "First Owner", "--json");
    assert.equal(created.code, 0, created.stderr);
    assert.equal(created.json.email, email.toLowerCase());
    assert.equal(created.json.displayName, "First Owner");
    const password = created.json.temporaryPassword as string;
    assert.match(password, /^[A-Za-z2-9]{20}$/);
    const login = await json<any>(env.server.url, "/v1/auth/login", { body: { email, password } });
    assert.equal(login.status, 200);
    assert.equal(login.body.account.displayName, "First Owner");
    assert.equal((await cli("account", "create", email.toUpperCase())).code, 1, "a second account with the same email is refused");
    assert.equal((await cli("account", "create", "not-an-email")).code, 1);
    const audit = await cli("audit", "tail", "--limit", "3", "--json");
    assert.ok(audit.json.entries.some((entry: any) => entry.action === "admin.account.create"));
  });
});
