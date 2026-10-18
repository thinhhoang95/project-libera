// Offline comments (plan M2.6) with real hosts and the real server: while the
// server is down a comment and a reply are queued in the host's
// pending_commands and shown with a "pending" chip; the anchor is in the
// annotations at once and syncs through the CRDT. After a restart the queue
// delivers them, `command-settled` clears the chips and the other host sees
// the thread. A command the server refuses keeps its card with Retry and
// Discard.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readAnchor } from "../../src/lib/collab/anchors";
import { ControlRoutes, type CommandsState, type HostEvent, type HostStatus } from "../../src/lib/collab/local-api";
import { EventKind } from "../../src/lib/collab/protocol/messages";
import { SharedReviewStore } from "../../src/lib/collab/review-store/shared";
import { joinNotebook, resolvePath, shareNotebook, startPeer, until, type P2Peer } from "./support/p2-peers";
import { removeDataDir, startServerProcess, type ServerProcess } from "./support/server-process";

const TEXT = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";

test("offline comments are queued, shown pending and delivered", { timeout: 240_000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "libera-p2-offline-"));
  let server: ServerProcess = await startServerProcess();
  const peers: P2Peer[] = [];
  try {
    const alice = await startPeer(root, "Alice", server);
    const bob = await startPeer(root, "Bob", server);
    peers.push(alice, bob);
    const projectId = await shareNotebook(alice, "Notes", { "draft.md": TEXT });
    const bobNotebook = await joinNotebook(alice, bob, projectId, "editor");
    const aliceDoc = await resolvePath(alice, "Notes/draft.md");
    const bobDoc = await resolvePath(bob, `${bobNotebook}/draft.md`);
    const aliceReplica = await alice.replica(aliceDoc.docId);
    const bobReplica = await bob.replica(bobDoc.docId);
    const A = alice.store(aliceDoc, aliceReplica);
    const B = bob.store(bobDoc, bobReplica);
    await Promise.all([A.load(), B.load()]);

    const first = TEXT.indexOf("First paragraph.");
    await A.comment({ range: { start: first, end: first + "First paragraph.".length }, text: "Online comment" });
    const onlineThread = A.lastCreatedThreadId()!;
    await until(() => B.getProjection().threads.some((item) => item.id === onlineThread), "Bob to see the online thread");

    let offlineThread = "";
    await t.test("offline: queued with a pending chip, anchor written at once", async () => {
      const { port, dataDir } = server;
      await server.kill();
      await until(() => alice.app.runtime.host.connectionState !== "connected", "Alice's host to notice");
      alice.online = false;
      const third = aliceReplica.text().indexOf("Third paragraph.");
      await A.comment({ range: { start: third, end: third + "Third paragraph.".length }, text: "Made on the train" });
      offlineThread = A.lastCreatedThreadId()!;
      await A.reply({ threadId: onlineThread, text: "Reply from the train" });
      const projection = A.flush();
      const queued = projection.threads.find((item) => item.id === offlineThread)!;
      assert.equal(queued.shared.pending?.state, "queued", "the new thread shows pending");
      assert.equal(queued.anchor.state, "attached");
      assert.ok(readAnchor(aliceReplica.annotations, queued.shared.anchorId), "the anchor is in the annotations already");
      const reply = projection.threads.find((item) => item.id === onlineThread)!.messages[1];
      assert.equal(reply.text, "Reply from the train");
      assert.equal(reply.shared.pending?.state, "queued");
      const commands = (await alice.call<CommandsState>("GET", ControlRoutes.commands)).body;
      assert.deepEqual(commands.pending.map((entry) => entry.command.kind), ["thread.create", "message.create"]);
      const status = (await alice.call<HostStatus>("GET", ControlRoutes.status)).body;
      assert.equal(status.pendingCommands, 2);

      // A window opened meanwhile rebuilds the chips from the host's queue.
      const reopened = new SharedReviewStore({
        docId: aliceDoc.docId, projectId, key: aliceDoc.path, replica: aliceReplica,
        me: () => alice.account, role: () => "owner", online: () => false, api: alice.threads, subscribeEvents: alice.subscribe,
      });
      await reopened.load();
      assert.equal(reopened.flush().threads.find((item) => item.id === offlineThread)?.shared.pending?.state, "queued");
      reopened.destroy();

      server = await startServerProcess({ port, dataDir });
      alice.app.runtime.nudge();
      bob.app.runtime.nudge();
    });

    await t.test("back online: delivered, chips cleared by command-settled, the other host sees it", async () => {
      await until(() => alice.events.some((event: HostEvent) => event.t === "command-settled" && event.ok && event.kind === "thread.create"), "the queued create to settle", 40_000);
      alice.online = true;
      await until(() => {
        const projection = A.getProjection();
        const created = projection.threads.find((item) => item.id === offlineThread);
        const replied = projection.threads.find((item) => item.id === onlineThread);
        return !!created && created.shared.pending === null && replied?.messages[1]?.shared.pending === null;
      }, "the chips to clear", 40_000);
      await until(() => {
        const seen = B.getProjection().threads.find((item) => item.id === offlineThread);
        return seen?.anchor.state === "attached" && seen.messages[0].text === "Made on the train";
      }, "Bob to see the offline thread anchored", 40_000);
      await until(async () => (await alice.call<CommandsState>("GET", ControlRoutes.commands)).body.pending.length === 0, "the queue to empty");
    });

    await t.test("a refused command keeps its card with Retry and Discard", async () => {
      // Bob does not hear that Alice deleted the thread before his reply is replayed.
      const muted = (listener: (event: HostEvent) => void) => bob.subscribe((event) => {
        if (event.t === "server-event" && event.kind === EventKind.ThreadDeleted) return;
        listener(event);
      });
      const stale = new SharedReviewStore({
        docId: bobDoc.docId, projectId, key: bobDoc.path, replica: bobReplica,
        me: () => bob.account, role: () => "editor", online: () => false, api: bob.threads, subscribeEvents: muted,
      });
      await stale.load();
      await A.delete({ threadId: onlineThread });
      await stale.reply({ threadId: onlineThread, text: "Too late" });
      const failedReply = () => stale.getProjection().threads.find((item) => item.id === onlineThread)?.messages.find((message) => message.text === "Too late");
      await until(() => failedReply()?.shared.pending?.state === "failed", "the reply to be refused");
      const commandId = failedReply()!.shared.pending!.commandId;
      assert.match(failedReply()!.shared.pending!.error ?? "", /not found/i);
      const failed = (await bob.call<CommandsState>("GET", ControlRoutes.commands)).body.failed;
      assert.ok(failed.some((entry) => entry.command.id === commandId), "the host remembers the refusal");

      await stale.retry(commandId);
      await until(() => {
        const pending = failedReply()?.shared.pending;
        return pending?.state === "failed" && pending.commandId !== commandId;
      }, "the retry to be refused again");
      const retried = failedReply()!.shared.pending!.commandId;
      stale.discard(retried);
      assert.equal(failedReply(), undefined, "discarded");
      await until(async () => !(await bob.call<CommandsState>("GET", ControlRoutes.commands)).body.failed.some((entry) => entry.command.id === retried || entry.command.id === commandId), "the host to forget both");
      stale.destroy();
    });
  } finally {
    for (const peer of peers) await peer.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    rmSync(root, { recursive: true, force: true });
  }
});
