// Files a collaborator creates, renames or deletes reach the other machine's
// disk and announce themselves with tree-changed (so the Notebooks tree
// refreshes), and a collaborator typing does not write the working copy once
// per keystroke.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { HostEvent } from "../../src/lib/collab/local-api";
import { ControlRoutes } from "../../src/lib/collab/local-api";
import { ContentKeys } from "../../src/lib/collab/protocol/schema";
import { closePeer, invite, makePeer, readText, register, sleep, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

type TreeChanged = Extract<HostEvent, { t: "tree-changed" }>;

const treeEvents = (peer: Peer) => peer.events.filter((event): event is TreeChanged => event.t === "tree-changed");
const fileWrites = (peer: Peer, liberaPath: string) =>
  peer.events.filter((event) => event.t === "files-changed" && event.paths.includes(liberaPath)).length;

test("a collaborator's new, renamed and deleted files reach my disk and my tree", { timeout: 180_000 }, async () => {
  const temp = tempRoot("libera-tree-events-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const aliceAuth = await register(server, "Alice");
    const bobAuth = await register(server, "Bob");
    const alice = await makePeer(temp.dir, "alice", server, aliceAuth);
    const bob = await makePeer(temp.dir, "bob", server, bobAuth);
    peers.push(alice, bob);
    writeTree(path.join(alice.library, "Lab"), { "notes.md": "# Lab\n" });
    const shared = await alice.router.call("POST", ControlRoutes.share, { notebook: "Lab" });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    const projectId = (shared.body as { projectId: string }).projectId;
    const link = await invite(server, aliceAuth, projectId, "bob@example.test");
    const joined = await bob.router.call("POST", ControlRoutes.join, { invitation: link });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const bobNotebook = (joined.body as { notebook: string }).notebook;
    const bobRoot = path.join(bob.library, bobNotebook);
    const files = ControlRoutes.files(projectId);

    // Alice creates a file: it appears on Bob's disk, and Bob's windows are told the tree changed.
    bob.events.length = 0;
    const created = await alice.router.call("POST", files, { op: "create-file", path: "drafts/idea.md", content: "An idea\n" });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    await until(() => readText(bobRoot, "drafts/idea.md") === "An idea\n", "Bob's copy of the new file");
    await until(() => treeEvents(bob).some((event) => event.added.includes(`${bobNotebook}/drafts/idea.md`)), "tree-changed for the new file");
    assert.ok(bob.service.resolvePath(`${bobNotebook}/drafts/idea.md`), "the new file resolves to a shared document");

    // A rename moves Bob's file and reports the move, so an open tab can follow it.
    bob.events.length = 0;
    const renamed = await alice.router.call("POST", files, { op: "rename", path: "drafts/idea.md", to: "drafts/plan.md" });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    await until(() => readText(bobRoot, "drafts/plan.md") === "An idea\n" && !existsSync(path.join(bobRoot, "drafts", "idea.md")), "Bob's renamed copy");
    await until(
      () => treeEvents(bob).some((event) => event.moves.some((move) => move.from === `${bobNotebook}/drafts/idea.md` && move.to === `${bobNotebook}/drafts/plan.md`)),
      "tree-changed with the move",
    );

    // A delete removes it from Bob's tree.
    bob.events.length = 0;
    const deleted = await alice.router.call("POST", files, { op: "delete", path: "drafts/plan.md" });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    await until(() => treeEvents(bob).some((event) => event.removed.includes(`${bobNotebook}/drafts/plan.md`)), "tree-changed for the delete");
    await until(() => !existsSync(path.join(bobRoot, "drafts", "plan.md")), "Bob's copy gone");

    // Text edits alone never announce a tree change.
    bob.events.length = 0;
    const resolved = alice.service.resolvePath("Lab/notes.md")!;
    const hub = alice.host.acquire(resolved.docId);
    hub.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(doc.getText(ContentKeys.source).length, "more\n"), { source: "typing" });
    await until(() => readText(bobRoot, "notes.md") === "# Lab\nmore\n", "Bob's copy of the edit");
    alice.host.release(resolved.docId);
    assert.equal(treeEvents(bob).length, 0, "text edits do not refresh the tree");
  } finally {
    for (const peer of peers) await closePeer(peer);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});

test("a collaborator typing steadily does not write my working copy per keystroke", { timeout: 180_000 }, async () => {
  const temp = tempRoot("libera-write-cadence-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const aliceAuth = await register(server, "Alice");
    const bobAuth = await register(server, "Bob");
    const alice = await makePeer(temp.dir, "alice", server, aliceAuth);
    // Bob's machine uses production-like cadence (scaled down): write after
    // 300 ms of quiet, at most every 1 s.
    const bob = await makePeer(temp.dir, "bob", server, bobAuth, { timings: { writeDebounceMs: 300, writeMaxWaitMs: 1_000 } });
    peers.push(alice, bob);
    writeTree(path.join(alice.library, "Lab"), { "notes.md": "" });
    const shared = await alice.router.call("POST", ControlRoutes.share, { notebook: "Lab" });
    const projectId = (shared.body as { projectId: string }).projectId;
    const joined = await bob.router.call("POST", ControlRoutes.join, { invitation: await invite(server, aliceAuth, projectId, "bob@example.test") });
    const bobNotebook = (joined.body as { notebook: string }).notebook;
    const bobRoot = path.join(bob.library, bobNotebook);
    const resolved = alice.service.resolvePath("Lab/notes.md")!;
    const hub = alice.host.acquire(resolved.docId);
    await until(() => bob.service.resolvePath(`${bobNotebook}/notes.md`) !== null, "Bob has the document");

    bob.events.length = 0;
    const keystrokes = 40;
    for (let index = 0; index < keystrokes; index += 1) {
      hub.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(doc.getText(ContentKeys.source).length, "x"), { source: "typing" });
      await sleep(100); // ~4 s of steady typing at 10 keys per second
    }
    const expected = "x".repeat(keystrokes);
    await until(() => readText(bobRoot, "notes.md") === expected, "Bob's copy catches up after typing stops");
    const writes = fileWrites(bob, `${bobNotebook}/notes.md`);
    // About one write per second of typing (max wait) plus the final one, far from 40.
    assert.ok(writes >= 2 && writes <= 8, `wrote the working copy ${writes} times for ${keystrokes} keystrokes`);
    alice.host.release(resolved.docId);
  } finally {
    for (const peer of peers) await closePeer(peer);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
