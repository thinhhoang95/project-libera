// Regressions for the 2026-11-20 collaboration review, package B1 (S31, S35):
// the host keeps a durable per-project log of the manifest's moves and removals,
// keyed by file ID, on a writer and on a follower. It survives a restart, a
// follower that restarts after a move reads it as a move (not an addition), and
// acknowledging trims it.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { HostStore } from "../../electron/collab/core/store";
import { diffManifestPaths, type RecordedPath } from "../../electron/collab/notebooks/transition-log";
import { ControlRoutes, type TransitionsResponse } from "../../src/lib/collab/local-api";
import { closePeer, invite, makePeer, readText, register, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

const file = (p: string): RecordedPath => ({ path: p, kind: "file" });

test("the manifest diff is by file ID: a move is a move, a new entry is only remembered, an empty manifest is not a mass delete", () => {
  const recorded = new Map([["f1", file("a.md")], ["f2", file("b.md")]]);
  const diff = diffManifestPaths(recorded, new Map([["f1", file("c.md")], ["f3", file("d.md")]]), 7);
  assert.deepEqual(diff.transitions.map(({ fileId, from, to }) => [fileId, from, to]), [["f1", "a.md", "c.md"], ["f2", "b.md", null]]);
  assert.deepEqual(diff.upserts.map((item) => item.fileId), ["f1", "f3"]);
  assert.deepEqual(diffManifestPaths(recorded, new Map(), 7), { upserts: [], removals: [], transitions: [] });
  assert.deepEqual(diffManifestPaths(recorded, recorded, 7), { upserts: [], removals: [], transitions: [] }, "nothing changed: nothing to write");
});

test("the log survives a host restart, is read after a cursor, and acknowledging trims it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "libera-transition-log-"));
  const dbPath = path.join(dir, "host.sqlite");
  try {
    let store = new HostStore({ path: dbPath });
    store.commitManifestPaths("p1", { upserts: [{ fileId: "f1", path: "a.md", kind: "file" }], removals: [], transitions: [] });
    const rows = store.commitManifestPaths("p1", {
      upserts: [{ fileId: "f1", path: "b.md", kind: "file" }],
      removals: ["f2"],
      transitions: [{ fileId: "f1", kind: "file", from: "a.md", to: "b.md", at: 1 }, { fileId: "f2", kind: "file", from: "x.md", to: null, at: 2 }],
    });
    assert.deepEqual(rows.map((row) => row.seq), [1, 2]);
    store.close();

    store = new HostStore({ path: dbPath });
    assert.equal(store.manifestPaths("p1").get("f1")?.path, "b.md", "the last-seen paths are persisted");
    assert.deepEqual(store.transitionsAfter("p1").map((row) => [row.fileId, row.from, row.to]), [["f1", "a.md", "b.md"], ["f2", "x.md", null]]);
    assert.deepEqual(store.transitionsAfter("p1", 1).map((row) => row.fileId), ["f2"]);
    assert.deepEqual(store.transitionsAfter("p2"), [], "another project's log is its own");
    assert.equal(store.acknowledgeTransitions("p1", { seqs: [1] }), 1);
    assert.deepEqual(store.transitionsAfter("p1").map((row) => row.seq), [2]);
    assert.equal(store.acknowledgeTransitions("p1", { seqs: [1] }), 0, "acknowledging twice is harmless");
    assert.equal(store.acknowledgeTransitions("p1", { upTo: 5 }), 1);
    assert.deepEqual(store.transitionsAfter("p1"), []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S35: a follower that restarts after a move reads a move, on the writer too, and the control route trims", { timeout: 180_000 }, async () => {
  const temp = tempRoot("libera-transition-log-peers-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const aliceAuth = await register(server, "Alice");
    const bobAuth = await register(server, "Bob");
    const alice = await makePeer(temp.dir, "alice", server, aliceAuth);
    let bob = await makePeer(temp.dir, "bob", server, bobAuth);
    peers.push(alice);
    writeTree(path.join(alice.library, "Lab"), { "a.md": "# A\n", "b.md": "# B\n" });
    const shared = await alice.router.call("POST", ControlRoutes.share, { notebook: "Lab" });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    const projectId = (shared.body as { projectId: string }).projectId;
    const link = await invite(server, aliceAuth, projectId, "bob@example.test");
    const joined = await bob.router.call("POST", ControlRoutes.join, { invitation: link });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const notebook = (joined.body as { notebook: string }).notebook;
    await until(() => readText(path.join(bob.library, notebook), "a.md") === "# A\n", "Bob's copy");
    const files = ControlRoutes.files(projectId);

    const renamed = await alice.router.call("POST", files, { op: "rename", path: "a.md", to: "c.md" });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    // The writer's own log has the move before its response (the wrapper reads it right after the commit).
    assert.deepEqual(alice.host.store.transitionsAfter(projectId).map((row) => [row.from, row.to]), [["a.md", "c.md"]]);
    await until(() => bob.host.store.transitionsAfter(projectId).length === 1, "the follower's log");
    const fileId = alice.host.store.transitionsAfter(projectId)[0].fileId;
    assert.equal(bob.host.store.transitionsAfter(projectId)[0].fileId, fileId, "the same file ID on both");

    // The route answers with Libera paths.
    const listed = await bob.router.call("GET", ControlRoutes.transitions(projectId));
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const page = listed.body as TransitionsResponse;
    assert.deepEqual(page.transitions.map((item) => [item.from, item.to]), [[`${notebook}/a.md`, `${notebook}/c.md`]]);

    // Bob's Next applied it and says so: the log is trimmed.
    const ack = await bob.router.call("POST", ControlRoutes.transitionsAck(projectId), { seqs: page.transitions.map((item) => item.seq) });
    assert.equal(ack.status, 200, JSON.stringify(ack.body));
    assert.deepEqual(bob.host.store.transitionsAfter(projectId), []);

    // Bob goes away; Alice moves the file twice more and deletes the other; Bob comes back with an empty in-memory layout.
    await closePeer(bob);
    for (const [from, to] of [["c.md", "d.md"], ["d.md", "e.md"]]) {
      const step = await alice.router.call("POST", files, { op: "rename", path: from, to });
      assert.equal(step.status, 200, JSON.stringify(step.body));
    }
    const deleted = await alice.router.call("POST", files, { op: "delete", path: "b.md" });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));

    bob = await makePeer(temp.dir, "bob", server, bobAuth);
    peers.push(bob);
    await until(() => bob.host.store.transitionsAfter(projectId).some((row) => row.to === null), "the restarted follower's log");
    const moves = bob.host.store.transitionsAfter(projectId).map((row) => [row.fileId === fileId ? "moved-file" : "other", row.from, row.to]);
    // Seen as one move (from where it was last recorded) and one removal, not as additions.
    assert.deepEqual(moves.filter((move) => move[0] === "moved-file"), [["moved-file", "c.md", "e.md"]]);
    assert.deepEqual(moves.filter((move) => move[0] === "other"), [["other", "b.md", null]]);
  } finally {
    for (const peer of peers) await closePeer(peer);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
