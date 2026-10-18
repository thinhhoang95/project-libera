// One-time move of local review comments to a shared notebook: anchors from
// each thread's stored range when the quote still matches (else detached),
// threads authored by the owner with their messages in order, local copies
// marked migratedTo and kept, owner only, and idempotent on a second run.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readAnchor, resolveAnchor } from "../../src/lib/collab/anchors";
import { ControlRoutes, type LocalCommentsSummary, type MigrateCommentsResponse } from "../../src/lib/collab/local-api";
import { anchorAt, newReview, type ReviewDocument } from "../../src/lib/markdown-review";
import type { MigratableDocument } from "../../electron/collab/control/review-migration";
import { joinNotebook, resolvePath, shareNotebook, startPeer, until, type P2Peer } from "./support/p2-peers";
import { removeDataDir, startServerProcess } from "./support/server-process";

const BEFORE = "# Notes\n\nAlpha paragraph.\n\nRemoved sentence.\n\nGamma paragraph.\n";
const NOW = "# Notes\n\nIntro added later.\n\nAlpha paragraph.\n\nGamma paragraph.\n";

function localReviews(): ReviewDocument[] {
  const doc = newReview("Shared/notes.md", BEFORE, "review-notes");
  const at = (quote: string) => anchorAt(BEFORE, { start: BEFORE.indexOf(quote), end: BEFORE.indexOf(quote) + quote.length });
  doc.enabled = true;
  doc.threads = [
    { id: "local-1", anchor: at("Alpha paragraph."), status: "resolved", messages: [
      { id: "m1", text: "First local comment", createdAt: "2026-09-01T10:00:00.000Z" },
      { id: "m2", text: "A reply, second", createdAt: "2026-09-01T11:00:00.000Z" },
      { id: "m3", text: "And a third", createdAt: "2026-09-01T12:00:00.000Z" },
    ] },
    { id: "local-2", anchor: at("Removed sentence."), status: "open", messages: [{ id: "m4", text: "This one lost its text", createdAt: "2026-09-02T10:00:00.000Z" }] },
    { id: "local-3", anchor: at("Gamma paragraph."), status: "open", messages: [{ id: "m5", text: "Left by the agent", createdAt: "2026-09-03T10:00:00.000Z", author: "agent" }] },
  ];
  // Not in the shared notebook, or not a shared file: left alone.
  const other = newReview("Private/x.md", "Private text", "review-private");
  other.threads = [{ id: "private-1", anchor: anchorAt("Private text", { start: 0, end: 7 }), status: "open", messages: [{ id: "p1", text: "Stays local", createdAt: "2026-09-04T10:00:00.000Z" }] }];
  return [doc, other];
}

test("moving local review comments to a shared notebook", { timeout: 240_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "libera-p2-migrate-"));
  const server = await startServerProcess();
  const peers: P2Peer[] = [];
  try {
    const alice = await startPeer(root, "Alice", server);
    const bob = await startPeer(root, "Bob", server);
    peers.push(alice, bob);
    const projectId = await shareNotebook(alice, "Shared", { "notes.md": NOW });
    const bobNotebook = await joinNotebook(alice, bob, projectId, "editor");
    const database = path.join(alice.library, ".libera", "markdown-reviews.json");
    mkdirSync(path.dirname(database), { recursive: true });
    writeFileSync(database, JSON.stringify({ schemaVersion: 1, documents: localReviews() }));

    // Owner only, in the host and in the UI.
    const refused = await bob.call("POST", ControlRoutes.migrateComments(projectId));
    assert.equal(refused.status, 403);

    const summary = await alice.call<LocalCommentsSummary>("GET", ControlRoutes.migrateComments(projectId));
    assert.deepEqual(summary.body, { documents: 1, threads: 3 });

    const moved = await alice.call<MigrateCommentsResponse>("POST", ControlRoutes.migrateComments(projectId));
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual(moved.body, { documents: 1, threads: 3, detached: 1, skipped: 0 });

    const doc = await resolvePath(alice, "Shared/notes.md");
    const threads = await alice.threads.list(doc.docId);
    assert.equal(threads.length, 3);
    const byFirst = new Map(threads.map((thread) => [thread.messages[0].body, thread]));
    const first = byFirst.get("First local comment")!;
    assert.deepEqual(first.messages.map((message) => message.body), ["First local comment", "A reply, second", "And a third"], "message order and text are kept");
    assert.ok(first.messages.every((message) => message.author.id === alice.account.id), "authored by the owner");
    assert.equal(first.status, "resolved");
    assert.equal(first.quote, "Alpha paragraph.");
    assert.equal(byFirst.get("This one lost its text")!.status, "detached");
    const agent = byFirst.get("Left by the agent")!;
    assert.deepEqual({ kind: agent.actor.kind, feature: (agent.actor as { feature?: string }).feature, onBehalfOf: (agent.actor as { onBehalfOf?: string }).onBehalfOf }, { kind: "ai", feature: "review-comments", onBehalfOf: alice.account.id });

    // The anchors are in the document's annotations, where the quotes are now.
    const replica = await bob.replica((await resolvePath(bob, `${bobNotebook}/notes.md`)).docId);
    await until(() => !!readAnchor(replica.annotations, first.anchorId) && !!readAnchor(replica.annotations, agent.anchorId), "the anchors to sync to Bob");
    for (const thread of [first, agent]) {
      const resolved = resolveAnchor(replica.ytext, readAnchor(replica.annotations, thread.anchorId)!);
      assert.equal(resolved.state, "attached");
      assert.equal(NOW.slice(resolved.start, resolved.end), thread.quote);
    }
    assert.equal(readAnchor(replica.annotations, byFirst.get("This one lost its text")!.anchorId), null, "no anchor for text that is gone");

    // Local copies are marked, not deleted.
    const stored = JSON.parse(readFileSync(database, "utf8")) as { documents: MigratableDocument[] };
    assert.equal(stored.documents.length, 2);
    const local = stored.documents.find((item) => item.id === "review-notes")!;
    assert.equal(local.threads.length, 3);
    assert.ok(local.threads.every((thread) => thread.migratedTo?.docId === doc.docId));
    assert.deepEqual(new Set(local.threads.map((thread) => thread.migratedTo!.threadId)), new Set(threads.map((thread) => thread.id)));
    assert.equal(local.revision, 1, "the revision moves so open windows reload");
    assert.equal(stored.documents.find((item) => item.id === "review-private")!.threads[0].migratedTo, undefined);

    // Nothing left to move; a second run changes nothing.
    assert.deepEqual((await alice.call<LocalCommentsSummary>("GET", ControlRoutes.migrateComments(projectId))).body, { documents: 0, threads: 0 });
    const again = await alice.call<MigrateCommentsResponse>("POST", ControlRoutes.migrateComments(projectId));
    assert.deepEqual(again.body, { documents: 0, threads: 0, detached: 0, skipped: 0 });
    assert.equal((await alice.threads.list(doc.docId)).length, 3);
  } finally {
    for (const peer of peers) await peer.close().catch(() => undefined);
    await server.stop();
    removeDataDir(server.dataDir);
    rmSync(root, { recursive: true, force: true });
  }
});
