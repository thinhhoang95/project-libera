// Regressions for the 2026-11-19 sync audit's tree event findings: the host's
// tree-changed event names each moved file by its id, so the UI joins a file's
// steps by identity (a swap stays a swap) instead of by path.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import type { HostEvent } from "../../src/lib/collab/local-api";
import { ControlRoutes } from "../../src/lib/collab/local-api";
import { planMoves } from "../../src/lib/collab/ui/tree-changes";
import { closePeer, invite, makePeer, readText, register, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

type TreeChanged = Extract<HostEvent, { t: "tree-changed" }>;

const treeEvents = (peer: Peer) => peer.events.filter((event): event is TreeChanged => event.t === "tree-changed");

test("a collaborator's rename reaches my tree event with the file's id", { timeout: 180_000 }, async () => {
  const temp = tempRoot("libera-audit-1119-tree-ids-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const aliceAuth = await register(server, "Alice");
    const bobAuth = await register(server, "Bob");
    const alice = await makePeer(temp.dir, "alice", server, aliceAuth);
    const bob = await makePeer(temp.dir, "bob", server, bobAuth);
    peers.push(alice, bob);
    writeTree(path.join(alice.library, "Lab"), { "a.md": "# A\n", "b.md": "# B\n" });
    const shared = await alice.router.call("POST", ControlRoutes.share, { notebook: "Lab" });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    const projectId = (shared.body as { projectId: string }).projectId;
    const link = await invite(server, aliceAuth, projectId, "bob@example.test");
    const joined = await bob.router.call("POST", ControlRoutes.join, { invitation: link });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const notebook = (joined.body as { notebook: string }).notebook;
    const bobRoot = path.join(bob.library, notebook);
    await until(() => readText(bobRoot, "a.md") === "# A\n" && readText(bobRoot, "b.md") === "# B\n", "Bob's copies");
    const files = ControlRoutes.files(projectId);

    bob.events.length = 0;
    const renamed = await alice.router.call("POST", files, { op: "rename", path: "a.md", to: "c.md" });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    const moveOf = () => treeEvents(bob).flatMap((event) => event.moves).find((move) => move.from === `${notebook}/a.md` && move.to === `${notebook}/c.md`);
    await until(() => Boolean(moveOf()), "tree-changed with the move");
    const first = moveOf()!;
    assert.ok(first.fileId && first.fileId.length > 0, "the move carries the file's id");

    // The same file renamed again keeps its id, so the UI can join the two steps; the other file has a different one.
    bob.events.length = 0;
    const again = await alice.router.call("POST", files, { op: "rename", path: "c.md", to: "d.md" });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const moveTo = (name: string) => treeEvents(bob).flatMap((event) => event.moves).find((move) => move.to === `${notebook}/${name}`);
    await until(() => Boolean(moveTo("d.md")), "the second move");
    const second = moveTo("d.md")!;
    assert.equal(second.fileId, first.fileId);
    const other = await alice.router.call("POST", files, { op: "rename", path: "b.md", to: "e.md" });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    await until(() => Boolean(moveTo("e.md")), "the other file move");
    const third = moveTo("e.md")!;
    assert.ok(third.fileId && third.fileId !== first.fileId);

    // Joined by id, a rename chain is one step and an unrelated file's move is kept apart.
    assert.deepEqual(planMoves([first, second, third]).map((move) => [move.from, move.to]), [[`${notebook}/a.md`, `${notebook}/d.md`], [`${notebook}/b.md`, `${notebook}/e.md`]]);
  } finally {
    for (const peer of peers) await closePeer(peer);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
