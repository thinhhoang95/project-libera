// SharedReviewStore across two real hosts and the real server (plan M2.1–M2.3):
// comment, reply, edit, resolve, reattach and delete with live events, the
// server's permission rules mirrored in the projection, anchors following
// concurrent edits and detaching on delete, reattach (selection and "found
// similar text"), and mentions turning into notifications.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { listAnchors, readAnchor } from "../../src/lib/collab/anchors";
import { ControlRoutes, type HostEvent, type Member } from "../../src/lib/collab/local-api";
import type { Thread } from "../../src/lib/collab/protocol/api";
import type { SharedReviewProjection, SharedReviewThread } from "../../src/lib/collab/review-store/types";
import { commentAuthorLabel } from "../../src/lib/collab/review-store/authors";
import { filterMentionCandidates } from "../../src/lib/collab/review-store/mentions";
import { joinNotebook, resolvePath, shareNotebook, startPeer, until, type P2Peer } from "./support/p2-peers";
import { removeDataDir, startServerProcess } from "./support/server-process";

const TEXT = "# Notes\n\nAlpha paragraph about cats.\n\nBeta paragraph about dogs.\n\nGamma closing words.\n";

function thread(projection: SharedReviewProjection, id: string): SharedReviewThread | undefined {
  return projection.threads.find((item) => item.id === id);
}

test("shared comments between two hosts with live events", { timeout: 240_000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "libera-p2-review-"));
  const server = await startServerProcess();
  const peers: P2Peer[] = [];
  try {
    const alice = await startPeer(root, "Alice", server);
    const bob = await startPeer(root, "Bob", server);
    const carol = await startPeer(root, "Carol", server);
    peers.push(alice, bob, carol);
    const projectId = await shareNotebook(alice, "Shared", { "notes.md": TEXT });
    const bobNotebook = await joinNotebook(alice, bob, projectId, "editor");
    const carolNotebook = await joinNotebook(alice, carol, projectId, "commenter");

    const aliceDoc = await resolvePath(alice, "Shared/notes.md");
    const bobDoc = await resolvePath(bob, `${bobNotebook}/notes.md`);
    const carolDoc = await resolvePath(carol, `${carolNotebook}/notes.md`);
    assert.equal(aliceDoc.docId, bobDoc.docId);
    const aliceReplica = await alice.replica(aliceDoc.docId);
    const bobReplica = await bob.replica(bobDoc.docId);
    const carolReplica = await carol.replica(carolDoc.docId);
    await until(() => bobReplica.text() === TEXT && carolReplica.text() === TEXT, "replicas to load the text");
    const A = alice.store(aliceDoc, aliceReplica);
    const B = bob.store(bobDoc, bobReplica);
    const C = carol.store(carolDoc, carolReplica);
    await Promise.all([A.load(), B.load(), C.load()]);
    assert.equal(A.getProjection().threads.length, 0);

    let threadId = "";
    const beta = TEXT.indexOf("Beta paragraph about dogs.");

    await t.test("a comment with a mention reaches the other host live and notifies", async () => {
      const members = (await alice.call<Member[]>("GET", ControlRoutes.members(projectId))).body;
      // The picker offers members by name, never the author.
      const offered = filterMentionCandidates(members, "bo", alice.account.id);
      assert.deepEqual(offered.map((member) => member.id), [bob.account.id]);
      await A.comment({ range: { start: beta, end: beta + "Beta paragraph about dogs.".length }, text: "Should this mention **wolves**? @Bob", mentions: [bob.account.id] });
      threadId = A.lastCreatedThreadId() ?? "";
      assert.ok(threadId);
      const own = thread(A.flush(), threadId)!;
      assert.equal(own.shared.pending, null, "the direct create confirmed the thread");
      assert.equal(own.anchor.state, "attached");
      assert.equal(readAnchor(aliceReplica.annotations, own.shared.anchorId)?.createdBy, alice.account.id);
      await until(() => thread(B.getProjection(), threadId)?.anchor.state === "attached", "Bob to see the thread anchored");
      const seen = thread(B.getProjection(), threadId)!;
      assert.equal(TEXT.slice(seen.anchor.start, seen.anchor.end), "Beta paragraph about dogs.");
      assert.equal(seen.messages[0].text, "Should this mention **wolves**? @Bob");
      assert.equal(seen.messages[0].shared.author.displayName, "Alice");
      assert.equal(seen.messages[0].shared.author.color, alice.account.color);
      assert.equal(commentAuthorLabel(seen.messages[0].shared.actor, seen.messages[0].shared.author), "Alice");
      assert.deepEqual(seen.messages[0].shared.mentions, [bob.account.id]);
      assert.equal(seen.messages[0].shared.canEdit, false, "Bob cannot edit Alice's message");
      assert.equal(seen.shared.canManage, true, "an editor manages any thread");
      await until(() => bob.events.some((event: HostEvent) => event.t === "notification" && event.notification.kind === "mention"), "Bob's mention notification");
      const listed = await bob.client.notifications({ unread: true });
      assert.ok(listed.some((item) => item.kind === "mention" && item.docId === aliceDoc.docId && item.payload.threadId === threadId));
    });

    let replyId = "";
    await t.test("reply and edit follow the server's authorship rules", async () => {
      await B.reply({ threadId, text: "Wolves are a separate note." });
      await until(() => (thread(A.getProjection(), threadId)?.messages.length ?? 0) === 2, "Alice to see Bob's reply");
      const reply = thread(A.getProjection(), threadId)!.messages[1];
      replyId = reply.id;
      assert.equal(reply.shared.author.id, bob.account.id);
      assert.equal(reply.shared.canEdit, false);
      assert.equal(reply.shared.canDelete, true, "the owner may delete anyone's message");
      await assert.rejects(B.edit({ threadId, messageId: threadId, text: "hijack" }), /your own messages/);
      // The server refuses it too.
      const forged = await bob.call("PATCH", ControlRoutes.message(threadId), { body: "hijack" });
      assert.equal(forged.status, 403);
      await A.edit({ threadId, messageId: threadId, text: "Should this mention wolves at all?" });
      await until(() => thread(B.getProjection(), threadId)?.messages[0].text === "Should this mention wolves at all?", "Bob to see the edit");
      assert.ok(thread(B.getProjection(), threadId)!.messages[0].shared.editedAt);
      // Carol (commenter) sees the thread but cannot manage it.
      await until(() => !!thread(C.getProjection(), threadId), "Carol to load the thread");
      assert.equal(thread(C.getProjection(), threadId)!.shared.canManage, false);
      await assert.rejects(C.resolve({ threadId, resolved: true }), /author or an editor/);
    });

    await t.test("resolve and reopen", async () => {
      await B.resolve({ threadId, resolved: true });
      await until(() => thread(A.getProjection(), threadId)?.status === "resolved", "Alice to see the thread resolved");
      assert.equal(thread(A.getProjection(), threadId)!.shared.status, "resolved");
      await A.resolve({ threadId, resolved: false });
      await until(() => thread(B.getProjection(), threadId)?.status === "open", "Bob to see it reopened");
    });

    await t.test("anchors follow concurrent edits on both sides", async () => {
      aliceReplica.ytext.insert(0, "Intro line from Alice.\n\n");
      const inside = bobReplica.text().indexOf("dogs.");
      bobReplica.ytext.insert(inside, "big ");
      await until(() => aliceReplica.text() === bobReplica.text() && aliceReplica.text().includes("Intro line") && aliceReplica.text().includes("big dogs"), "the edits to converge");
      for (const store of [A, B]) {
        await until(() => {
          const view = thread(store.getProjection(), threadId);
          return !!view && view.anchor.state === "attached" && store.getProjection().text.slice(view.anchor.start, view.anchor.end) === "Beta paragraph about big dogs.";
        }, "the anchor to cover the edited paragraph");
      }
    });

    await t.test("deleting the text detaches the thread; reattach to a similar passage", async () => {
      const text = bobReplica.text();
      const start = text.indexOf("Beta paragraph");
      const end = text.indexOf("\n\nGamma");
      // Cut…
      bobReplica.ytext.delete(start, end - start);
      for (const store of [A, B]) {
        await until(() => thread(store.getProjection(), threadId)?.shared.detachReason === "deleted", "the thread to detach");
      }
      const detached = thread(A.getProjection(), threadId)!;
      assert.equal(detached.anchor.state, "orphaned");
      assert.equal(detached.anchor.quote, "Beta paragraph about dogs.", "the stored quote stays");
      await until(async () => (await alice.threads.list(aliceDoc.docId)).find((item: Thread) => item.id === threadId)?.status === "detached", "the server to mark it detached");
      // …and paste further down: the quote search offers it.
      bobReplica.ytext.insert(bobReplica.text().length, "\nBeta paragraph about dogs.\n");
      await until(() => A.getProjection().text.includes("\nBeta paragraph about dogs.\n"), "Alice to get the pasted text");
      const [candidate] = A.reattachCandidates(threadId);
      assert.ok(candidate);
      assert.equal(A.getProjection().text.slice(candidate.start, candidate.end), "Beta paragraph about dogs.");
      const previousAnchor = detached.shared.anchorId;
      await A.reattach({ threadId, range: { start: candidate.start, end: candidate.end } });
      for (const store of [A, B]) {
        await until(() => thread(store.getProjection(), threadId)?.anchor.state === "attached", "the reattached anchor");
      }
      const server = (await bob.threads.list(bobDoc.docId)).find((item) => item.id === threadId)!;
      assert.equal(server.status, "open");
      assert.notEqual(server.anchorId, previousAnchor);
      await until(() => !readAnchor(bobReplica.annotations, previousAnchor), "the old anchor to be removed");
    });

    await t.test("copy-paste does not duplicate anchors", async () => {
      const before = listAnchors(aliceReplica.annotations).length;
      const view = thread(A.getProjection(), threadId)!;
      aliceReplica.ytext.insert(0, A.getProjection().text.slice(view.anchor.start, view.anchor.end) + "\n\n");
      await until(() => A.getProjection().text.startsWith("Beta paragraph"), "the copy");
      assert.equal(listAnchors(aliceReplica.annotations).length, before);
      const after = thread(A.getProjection(), threadId)!;
      assert.ok(after.anchor.start > 0, "the anchor stays on the original characters");
    });

    await t.test("deleting messages and the thread", async () => {
      await A.deleteMessage(replyId);
      await until(() => thread(B.getProjection(), threadId)?.messages.length === 1, "Bob to see his reply removed by the owner");
      const anchorId = thread(A.getProjection(), threadId)!.shared.anchorId;
      await A.delete({ threadId });
      await until(() => !thread(B.getProjection(), threadId), "Bob to see the thread deleted");
      await until(() => !readAnchor(bobReplica.annotations, anchorId), "the anchor to go with it");
      assert.equal((await alice.threads.list(aliceDoc.docId)).length, 0);
    });
  } finally {
    for (const peer of peers) await peer.close().catch(() => undefined);
    await server.stop();
    removeDataDir(server.dataDir);
    rmSync(root, { recursive: true, force: true });
  }
});
