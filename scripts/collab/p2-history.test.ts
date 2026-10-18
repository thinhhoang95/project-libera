// Version history and restore (plan M2.4, M2.5) through the control routes,
// with real hosts and the real server: revision list and content, named
// versions, attribution of a diff by author with AI provenance, restore of
// a section and of the whole document, role gating, and session-end
// checkpoints when the last shared tab of an edited document closes.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createMemoryPortPair } from "../../electron/collab/core/ports";
import { SharedDocRegistry } from "../../src/lib/collab/client/registry";
import { ControlRoutes, type ApplyEditsResponse, type EnqueueCommandResponse, type Member } from "../../src/lib/collab/local-api";
import type { RestoreResponse, Revision, UserSummary } from "../../src/lib/collab/protocol/api";
import { can } from "../../src/lib/collab/protocol/roles";
import { attributeUpdates } from "../../src/components/libera/collab/history/attribution";
import { contentUpdates, createHistoryApi } from "../../src/components/libera/collab/history/history-api";
import { startSessionEndRevisions } from "../../src/components/libera/collab/history/session-end";
import { joinNotebook, resolvePath, shareNotebook, startPeer, until, type P2Peer } from "./support/p2-peers";
import { removeDataDir, startServerProcess } from "./support/server-process";
import { browserPort } from "./support/wire-harness";

const ORIGINAL = "# Plan\n\nFirst paragraph stays.\n\nSecond paragraph is short.\n\nThird paragraph ends it.\n\nFourth paragraph closes.\n";

test("revisions, attributed diffs, restore and session-end checkpoints", { timeout: 240_000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "libera-p2-history-"));
  const server = await startServerProcess();
  const peers: P2Peer[] = [];
  try {
    const alice = await startPeer(root, "Alice", server);
    const bob = await startPeer(root, "Bob", server);
    const carol = await startPeer(root, "Carol", server);
    peers.push(alice, bob, carol);
    const projectId = await shareNotebook(alice, "Plans", { "plan.md": ORIGINAL });
    const bobNotebook = await joinNotebook(alice, bob, projectId, "editor");
    await joinNotebook(alice, carol, projectId, "commenter");
    const doc = await resolvePath(alice, "Plans/plan.md");
    const bobDoc = await resolvePath(bob, `${bobNotebook}/plan.md`);
    const aliceApi = createHistoryApi(alice.client.request);
    const bobApi = createHistoryApi(bob.client.request);
    const carolApi = createHistoryApi(carol.client.request);
    const bobReplica = await bob.replica(bobDoc.docId);

    let draft1: Revision;
    let draft2: Revision;
    let edited = "";

    await t.test("named versions and the revision list", async () => {
      draft1 = await aliceApi.nameVersion(doc.docId, "Draft 1");
      assert.equal(draft1.kind, "named");
      assert.equal(draft1.createdBy?.displayName, "Alice");
      assert.equal(can("commenter", "name-revision"), false);
      await assert.rejects(carolApi.nameVersion(doc.docId, "Mine"), (error: Error & { status?: number }) => error.status === 403);
      assert.equal((await alice.call("POST", ControlRoutes.revisions(doc.docId), { kind: "named" })).status, 400, "a named version needs a label");

      // Alice types, an AI rewrite runs on her behalf, Bob types.
      let result = await alice.call<ApplyEditsResponse>("POST", ControlRoutes.docEdits(doc.docId), {
        edits: [{ start: ORIGINAL.indexOf("Plan"), end: ORIGINAL.indexOf("Plan") + "Plan".length, text: "Plan, edited by Alice", before: "Plan" }],
        provenance: { source: "typing" },
      });
      assert.equal(result.body.applied, true);
      const current = result.body.text;
      const short = current.indexOf("is short.");
      result = await alice.call<ApplyEditsResponse>("POST", ControlRoutes.docEdits(doc.docId), {
        edits: [{ start: short, end: short + "is short.".length, text: "was rewritten by the model.", before: "is short." }],
        provenance: { source: "ai", feature: "rewrite", model: "test/model" },
      });
      assert.equal(result.body.applied, true);
      await until(() => bobReplica.text() === result.body.text, "Bob to get Alice's edits");
      bobReplica.ytext.insert(bobReplica.text().indexOf("ends it."), "really ");
      edited = bobReplica.text();
      await until(async () => (await alice.call<{ text: string; status: { state: string } }>("GET", ControlRoutes.docText(doc.docId))).body.text === edited, "Alice's host to get Bob's edit");
      await until(() => bobReplica.getSnapshot().status?.state === "saved-remote", "Bob's edit to reach the server");
      draft2 = await bobApi.nameVersion(doc.docId, "Draft 2");

      const list = await aliceApi.revisions(doc.docId);
      const named = list.filter((revision) => revision.kind === "named");
      assert.deepEqual(named.map((revision) => revision.label), ["Draft 2", "Draft 1"], "newest first");
      assert.equal(named[0].createdBy?.displayName, "Bob");
      assert.equal((await aliceApi.content(doc.docId, draft1.id)).text, ORIGINAL);
      assert.equal((await carolApi.content(doc.docId, draft2.id)).text, edited, "viewers and commenters can read history");
    });

    await t.test("the diff between two versions is attributed by author, AI as the feature on behalf of its user", async () => {
      const members = (await alice.call<Member[]>("GET", ControlRoutes.members(projectId))).body;
      const users = new Map<string, UserSummary>(members.map((member) => [member.id, member]));
      const page = await contentUpdates(aliceApi, doc.docId, draft2.serverSeq);
      const attribution = attributeUpdates(page, draft1.serverSeq, draft2.serverSeq, users);
      assert.equal(attribution.before, ORIGINAL);
      assert.equal(attribution.after, edited);
      const text = (label: string) => attribution.ranges.filter((range) => range.author.label === label).map((range) => attribution.after.slice(range.start, range.end)).join("|");
      assert.equal(text("AI rewrite · Alice"), "was rewritten by the model.");
      assert.ok(text("Alice").includes(", edited by Alice"), text("Alice"));
      assert.equal(text("Bob"), "really ");
      assert.deepEqual(attribution.authors.map((author) => author.kind).sort(), ["ai", "user", "user"]);
      const ai = attribution.authors.find((author) => author.kind === "ai")!;
      assert.equal(ai.color, alice.account.color, "AI edits take their user's colour");

      // Against now (no upper bound) the same ranges appear.
      const now = attributeUpdates(await contentUpdates(aliceApi, doc.docId, null), draft1.serverSeq, null, users);
      assert.equal(now.after, edited);
    });

    await t.test("restore a section, then the whole document; commenters cannot", async () => {
      assert.equal(can("commenter", "restore"), false);
      assert.equal(can("editor", "restore"), true);
      await assert.rejects(carolApi.restore(doc.docId, { revisionId: draft1.id }), (error: Error & { status?: number }) => error.status === 403);
      // Bob restores only the second paragraph of Draft 1.
      const start = ORIGINAL.indexOf("Second paragraph");
      const end = ORIGINAL.indexOf("short.") + "short.".length;
      const section: RestoreResponse = await bobApi.restore(doc.docId, { revisionId: draft1.id, range: { start, end } });
      assert.ok(section.checkpointRevisionId);
      const expected = edited.replace("Second paragraph was rewritten by the model.", "Second paragraph is short.");
      await until(() => bobReplica.text() === expected, "the section restore to arrive");
      const list = await bobApi.revisions(doc.docId);
      const checkpoint = list.find((revision) => revision.id === section.checkpointRevisionId);
      assert.equal(checkpoint?.kind, "pre-restore");
      assert.equal((await bobApi.content(doc.docId, checkpoint!.id)).text, edited, "the checkpoint keeps the text before the restore");

      await aliceApi.restore(doc.docId, { revisionId: draft1.id });
      await until(() => bobReplica.text() === ORIGINAL, "the whole restore to arrive");
      const feed = await contentUpdates(aliceApi, doc.docId, null);
      const restore = feed.updates.at(-1)!;
      assert.equal(restore.actor?.kind, "system");
      assert.equal((restore.actor as { reason?: string }).reason, "restore");
    });

    await t.test("closing the last tab of an edited shared document asks for a session-end checkpoint", async () => {
      const registry = new SharedDocRegistry({
        resolve: async () => bobDoc,
        attach: async (docId) => {
          const pair = createMemoryPortPair();
          bob.app.runtime.host.attachReplica(docId, pair.hub);
          return browserPort(pair.replica);
        },
        subscribeEvents: (listener) => bob.subscribe(listener),
        available: () => true,
        replicaOptions: { schedule: queueMicrotask },
      });
      const asked: string[] = [];
      const stop = startSessionEndRevisions(registry, (docId) => {
        asked.push(docId);
        void bob.call<EnqueueCommandResponse>("POST", ControlRoutes.revisions(docId), { kind: "session-end" }).then((response) => {
          assert.equal(response.status, 202, "session-end checkpoints are queued");
        });
      });
      try {
        // A tab that only reads asks for nothing.
        await registry.bindTab("read-only", `${bobNotebook}/plan.md`);
        await until(() => !!registry.readTabText("read-only"), "the tab to attach");
        registry.releaseTab("read-only");
        assert.deepEqual(asked, []);

        await registry.bindTab("tab-1", `${bobNotebook}/plan.md`);
        await registry.bindTab("tab-2", `${bobNotebook}/plan.md`);
        await until(() => !!registry.readTabText("tab-1"), "the tabs to attach");
        const session = registry.sessionForTab("tab-1")!;
        session.replica.ytext.insert(session.replica.ytext.length, "Closing words.\n");
        await until(() => bob.app.runtime.host.registry.get(bobDoc.docId)?.getText().endsWith("Closing words.\n") === true, "the edit to reach Bob's host");
        registry.releaseTab("tab-1");
        assert.deepEqual(asked, [], "another tab still shows it");
        registry.releaseTab("tab-2");
        assert.deepEqual(asked, [bobDoc.docId]);
        await until(async () => (await bobApi.revisions(doc.docId)).some((revision) => revision.kind === "session-end"), "the checkpoint to reach the server");
        const checkpoint = (await bobApi.revisions(doc.docId)).find((revision) => revision.kind === "session-end")!;
        assert.equal(checkpoint.createdBy?.displayName, "Bob");
        assert.ok((await bobApi.content(doc.docId, checkpoint.id)).text.endsWith("Closing words.\n"));
      } finally {
        stop();
        registry.destroy();
      }
    });
  } finally {
    for (const peer of peers) await peer.close().catch(() => undefined);
    await server.stop();
    removeDataDir(server.dataDir);
    rmSync(root, { recursive: true, force: true });
  }
});
