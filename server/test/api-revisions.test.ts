// Revisions (M2.4), automatic checkpoints and restore (M2.5), against the
// real sync service.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import fc from "fast-check";
import * as Y from "yjs";

import { MessageType, type EventMessage } from "../src/protocol.js";
import { applyEdits, diffText } from "../src/text/diff.js";
import { locateSection } from "../src/text/locate.js";
import { anchor, at, edit, serverText, startCollab, waitUntil, type CollabEnv } from "./support/decisions-env.js";

describe("text helpers", () => {
  test("diffText produces edits that turn one text into the other", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 60 }), fc.string({ unit: "binary", maxLength: 60 }), (a, b) => {
        const edits = diffText(a, b);
        assert.equal(applyEdits(a, edits), b);
        for (let index = 1; index < edits.length; index += 1) {
          assert.ok(edits[index].start > edits[index - 1].start + edits[index - 1].deleteCount - 1);
        }
      }),
      { numRuns: 500 },
    );
  });

  test("diffText is minimal for local changes and never splits surrogate pairs", () => {
    const before = "The quick brown fox jumps over the lazy dog.";
    const after = "The quick red fox jumps over the lazy cat.";
    const edits = diffText(before, after);
    const touched = edits.reduce((sum, edit) => sum + edit.deleteCount + edit.insert.length, 0);
    assert.ok(touched <= 14, `diff touched ${touched} code units`);
    const emoji = diffText("a😀b", "a😃b");
    assert.equal(applyEdits("a😀b", emoji), "a😃b");
    for (const item of emoji) {
      assert.ok(!/^[\udc00-\udfff]/.test(item.insert) && !/[\ud800-\udbff]$/.test(item.insert));
    }
  });

  test("locateSection finds a changed section by its context", () => {
    const old = "# Intro\nHello world.\n# Methods\nWe measured things.\n# End\nBye.\n";
    const start = old.indexOf("We measured");
    const end = start + "We measured things.".length;
    const current = "# Intro\nHello there, world!\n# Methods\nWe guessed.\n# End\nBye.\n";
    const located = locateSection(old, start, end, current);
    assert.deepEqual(located && current.slice(located.start, located.end), "We guessed.");
    assert.equal(locateSection(old, start, end, "completely different"), null);
    assert.deepEqual(locateSection(old, 0, 7, old.replace("# Intro", "# Introduction")), { start: 0, end: 14 });
  });
});

describe("revisions", () => {
  let env: CollabEnv;
  before(async () => {
    env = await startCollab({ LOG_RETENTION_DAYS: 30, SNAPSHOT_EVERY_UPDATES: 3 });
  });
  after(() => env.close());

  test("revisions record the serverSeq and their content is rebuilt at several points, also after compaction", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "one");
    const texts: string[] = [];
    const revisions: string[] = [];
    for (const word of [" two", " three", " four", " five"]) {
      await edit(client, docId, client.text(docId).length, client.text(docId).length, word);
      const created = await env.api("POST", `/v1/documents/${docId}/revisions`, env.editor, { label: `after${word}` });
      assert.equal(created.status, 201);
      assert.equal(created.body.kind, "named");
      assert.equal(created.body.createdBy.id, env.editor.id);
      assert.equal(created.body.serverSeq, await env.server.server.context.rooms.currentServerSeq(docId));
      revisions.push(created.body.id);
      texts.push(client.text(docId));
    }
    await edit(client, docId, 0, 3, "ONE");

    const list = await env.api("GET", `/v1/documents/${docId}/revisions`, env.viewer);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.map((revision: { id: string }) => revision.id), [...revisions].reverse());

    const contentOf = async (id: string) => {
      const response = await env.api("GET", `/v1/documents/${docId}/revisions/${id}/content`, env.viewer);
      assert.equal(response.status, 200);
      return response.body.text as string;
    };
    for (const [index, id] of revisions.entries()) assert.equal(await contentOf(id), texts[index]);

    // Age the log past retention and compact: updates are pruned, revisions still rebuild.
    await env.db.updateTable("doc_updates").set({ received_at: new Date(Date.now() - 40 * 86_400_000) }).where("doc_id", "=", docId).execute();
    await env.server.server.jobs.runNow("compaction");
    const left = await env.db.selectFrom("doc_updates").select("server_seq").where("doc_id", "=", docId).execute();
    assert.equal(left.length, 0, "the old log was pruned");
    for (const [index, id] of revisions.entries()) assert.equal(await contentOf(id), texts[index]);
    assert.equal(await serverText(env, docId), "ONE two three four five");
  });

  test("roles: named needs an editor, checkpoints any writer; viewers create nothing; events are published", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "text");
    const watcher = await env.connect(env.viewer);
    await watcher.open(docId);

    assert.equal((await env.api("POST", `/v1/documents/${docId}/revisions`, env.commenter, { label: "mine" })).status, 403);
    const auto = await env.api("POST", `/v1/documents/${docId}/revisions`, env.commenter, { kind: "session-end" });
    assert.equal(auto.status, 201);
    // The same state checkpointed again is the same revision.
    const again = await env.api("POST", `/v1/documents/${docId}/revisions`, env.editor, { kind: "session-end" });
    assert.equal(again.status, 200);
    assert.equal(again.body.id, auto.body.id);
    assert.equal((await env.api("POST", `/v1/documents/${docId}/revisions`, env.viewer, { kind: "auto" })).status, 403);
    assert.equal((await env.api("GET", `/v1/documents/${docId}/revisions`, null)).status, 401);

    const event = await watcher.waitFor<EventMessage>((m) => m.type === MessageType.Event && m.kind === "revision.created");
    assert.equal((event.payload as { revision: { id: string } }).revision.id, auto.body.id);

    // Offline replay through /v1/commands.
    await edit(client, docId, 0, 0, "x");
    const command = await env.api("POST", "/v1/commands", env.editor, {
      id: "cmd_revision_create_1",
      kind: "revision.create",
      docId,
      body: { label: "from offline" },
    });
    assert.equal(command.status, 200);
    assert.equal(command.body.status, 201);
    assert.equal(command.body.body.label, "from offline");
  });

  test("the checkpoint job creates an auto revision for idle documents changed since their latest revision", async () => {
    const client = await env.connect(env.editor);
    const idle = await env.document(client, "idle text");
    const busy = await env.document(client, "busy text");
    const checkpointed = await env.document(client, "already saved");
    await env.api("POST", `/v1/documents/${checkpointed}/revisions`, env.editor, { label: "saved" });
    const old = new Date(Date.now() - 6 * 60_000);
    for (const docId of [idle, checkpointed]) {
      await env.db.updateTable("doc_updates").set({ received_at: old }).where("doc_id", "=", docId).execute();
    }

    const autos = (docId: string) =>
      env.db.selectFrom("revisions").selectAll().where("doc_id", "=", docId).where("kind", "=", "auto").execute();
    await env.server.server.jobs.runNow("checkpoints");
    const created = await autos(idle);
    assert.equal(created.length, 1);
    assert.equal(created[0].server_seq, await env.server.server.context.rooms.currentServerSeq(idle));
    assert.equal(created[0].created_by, null);
    assert.equal((await autos(busy)).length, 0, "a document edited in the last 5 minutes is not checkpointed");
    assert.equal((await autos(checkpointed)).length, 0, "nothing changed since the named revision");

    await env.server.server.jobs.runNow("checkpoints");
    assert.equal((await autos(idle)).length, 1, "no second checkpoint without new edits");
  });
});

describe("restore", () => {
  let env: CollabEnv;
  before(async () => {
    env = await startCollab();
  });
  after(() => env.close());

  const revision = async (docId: string) => (await env.api("POST", `/v1/documents/${docId}/revisions`, env.editor, { label: "v" })).body.id as string;

  test("restoring a whole document applies minimal forward edits as system:restore", async () => {
    const client = await env.connect(env.editor);
    const original = "Alpha paragraph stays.\nBeta was the original.\nGamma stays too.\n";
    const docId = await env.document(client, original);
    const target = await revision(docId);
    const comment = await anchor(client, docId, env.editor, at(client, docId, "Gamma"), at(client, docId, "Gamma") + 5);
    await edit(client, docId, at(client, docId, "was the original"), at(client, docId, "was the original") + 16, "got rewritten");

    const response = await env.api("POST", `/v1/documents/${docId}/restore`, env.editor, { revisionId: target });
    assert.equal(response.status, 200);
    await waitUntil(() => client.text(docId) === original, "the client receives the restore");
    assert.equal(await serverText(env, docId), original);

    const checkpoint = await env.db.selectFrom("revisions").selectAll().where("id", "=", response.body.checkpointRevisionId).executeTakeFirstOrThrow();
    assert.equal(checkpoint.kind, "pre-restore");
    const pre = await env.api("GET", `/v1/documents/${docId}/revisions/${checkpoint.id}/content`, env.editor);
    assert.equal(pre.body.text, original.replace("was the original", "got rewritten"));

    const row = await env.db
      .selectFrom("doc_updates")
      .selectAll()
      .where("doc_id", "=", docId)
      .where("server_seq", "=", response.body.serverSeq)
      .executeTakeFirstOrThrow();
    assert.deepEqual(row.actor, { kind: "system", reason: "restore", onBehalfOf: env.editor.id });
    assert.deepEqual(row.provenance, { source: "restore" });
    // Minimal: the update deletes only a handful of characters, not the text.
    const decoded = Y.decodeUpdate(row.update);
    let deleted = 0;
    for (const ranges of decoded.ds.clients.values()) for (const range of ranges) deleted += range.len;
    assert.ok(deleted > 0 && deleted < 16, `restore deleted ${deleted} characters`);
    // An anchor on untouched text still points at it.
    const text = client.doc(docId, "content").getText("source");
    const resolved = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(comment.start), client.doc(docId, "content"));
    assert.equal(text.toString().slice(resolved!.index, resolved!.index + 5), "Gamma");

    const audit = await env.db.selectFrom("audit_log").selectAll().where("action", "=", "document.restore").where("target", "=", docId).execute();
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].actor, { kind: "user", userId: env.editor.id });
  });

  test("restoring a section keeps concurrent edits elsewhere", async () => {
    const alice = await env.connect(env.editor);
    const bob = await env.connect(env.editor2);
    const docId = await env.document(alice, "# One\nFirst section text.\n# Two\nSecond section text.\n# Three\nThird.\n");
    await bob.open(docId);
    const target = await revision(docId);
    const revText = alice.text(docId);
    const sectionStart = revText.indexOf("Second section text.");
    const sectionEnd = sectionStart + "Second section text.".length;

    await edit(alice, docId, at(alice, docId, "Second section"), at(alice, docId, "Second section") + 20, "Totally different now.");
    await edit(alice, docId, at(alice, docId, "First"), at(alice, docId, "First") + 5, "Initial");
    await waitUntil(() => bob.text(docId) === alice.text(docId), "bob catches up");

    // Bob edits the third section while the restore runs.
    const bobEdit = bob.edit(docId, "content", (doc) => {
      const text = doc.getText("source");
      text.insert(text.toString().indexOf("Third.") + 5, " and last");
    });
    const [response] = await Promise.all([
      env.api("POST", `/v1/documents/${docId}/restore`, env.editor, { revisionId: target, range: { start: sectionStart, end: sectionEnd } }),
      bob.acked(bobEdit),
    ]);
    assert.equal(response.status, 200);
    const expected = "# One\nInitial section text.\n# Two\nSecond section text.\n# Three\nThird and last.\n";
    await waitUntil(async () => (await serverText(env, docId)) === expected, "restored section plus both edits");
    await waitUntil(() => alice.text(docId) === expected && bob.text(docId) === expected, "clients converge");
  });

  test("a section that cannot be located is a 409, and nothing is written", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "Before context. The section. After context.");
    const target = await revision(docId);
    const text = client.text(docId);
    await edit(client, docId, 0, text.length, "Nothing in common at all");
    const seq = await env.server.server.context.rooms.currentServerSeq(docId);
    const start = text.indexOf("The section.");
    const response = await env.api("POST", `/v1/documents/${docId}/restore`, env.editor, {
      revisionId: target,
      range: { start, end: start + "The section.".length },
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "conflict");
    assert.equal(await env.server.server.context.rooms.currentServerSeq(docId), seq);
    const checkpoints = await env.db.selectFrom("revisions").select("id").where("doc_id", "=", docId).where("kind", "=", "pre-restore").execute();
    assert.equal(checkpoints.length, 0);
  });

  test("commenters and AI actors cannot restore", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "x");
    const target = await revision(docId);
    const commenter = await env.api("POST", `/v1/documents/${docId}/restore`, env.commenter, { revisionId: target });
    assert.equal(commenter.status, 403);
    const ai = await env.api("POST", `/v1/documents/${docId}/restore`, env.editor, { revisionId: target, ai: { feature: "agent" } });
    assert.equal(ai.status, 403);
    assert.equal(ai.body.error.code, "ai-cannot-decide");
    const missing = await env.api("POST", `/v1/documents/${docId}/restore`, env.editor, { revisionId: "rev_missing" });
    assert.equal(missing.status, 404);
  });
});
