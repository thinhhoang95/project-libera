import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { FetchLike } from "../../electron/collab/core";
import { ControlRoutes } from "../../src/lib/collab/local-api";
import type { ProjectSummary } from "../../src/lib/collab/protocol/api";
import {
  api, closePeer, invite, makePeer, register, sameTree, snapshotTree, tempRoot, until, writeTree, type Peer,
} from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

test("takedown preserves local files, revokes collaborators, and allows sharing again", { timeout: 120_000 }, async () => {
  const temp = tempRoot("libera-notebooks-takedown-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const aliceAuth = await register(server, "Alice");
    const bobAuth = await register(server, "Bob");
    let failDelete = false;
    let dropDeleteResponse = false;
    const flaky: FetchLike = async (url, init) => {
      const deleting = init.method === "DELETE" && /\/v1\/projects\/[^/]+$/.test(new URL(url).pathname);
      if (deleting && failDelete) throw new TypeError("fetch failed (injected)");
      const response = await fetch(url, init);
      if (deleting && dropDeleteResponse) {
        dropDeleteResponse = false;
        throw new TypeError("lost delete response (injected)");
      }
      return response;
    };
    const alice = await makePeer(temp.dir, "alice", server, aliceAuth, { fetch: flaky });
    const bob = await makePeer(temp.dir, "bob", server, bobAuth);
    peers.push(alice, bob);
    const root = path.join(alice.library, "Research");
    writeTree(root, { "note.md": "Keep this note\n", "nested/data.json": '{"keep":true}\n', "_archive/old.md": "Keep the archive\n" });
    const shared = await alice.router.call("POST", ControlRoutes.share, { notebook: "Research" });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    const { projectId } = shared.body as { projectId: string };
    const link = await invite(server, aliceAuth, projectId, "bob@example.test", "editor");
    const joined = await bob.router.call("POST", ControlRoutes.join, { invitation: link });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const bobNotebook = (joined.body as { notebook: string }).notebook;
    const bobRoot = path.join(bob.library, bobNotebook);
    await until(() => existsSync(path.join(bobRoot, "note.md")), "Bob's files to materialize");
    const before = snapshotTree(root);
    const bobBefore = snapshotTree(bobRoot);

    const forbidden = await bob.router.call("DELETE", ControlRoutes.project(projectId));
    assert.equal(forbidden.status, 403);
    assert.equal((await api(server, `/v1/projects/${projectId}`, undefined, aliceAuth.accessToken)).status, 200);

    failDelete = true;
    const failed = await alice.router.call("DELETE", ControlRoutes.project(projectId));
    assert.equal(failed.status, 503);
    assert.equal(alice.service.localProjects().length, 1);
    assert.ok(existsSync(path.join(root, ".libera-shared.json")), "failed requests keep the share marker");
    failDelete = false;

    // The delete commits but its response is lost. Verify it committed before cleanup.
    dropDeleteResponse = true;
    const removed = await alice.router.call("DELETE", ControlRoutes.project(projectId));
    assert.equal(removed.status, 204, JSON.stringify(removed.body));
    assert.deepEqual(alice.service.localProjects(), []);
    assert.equal(alice.service.resolvePath("Research/note.md"), null);
    assert.equal(alice.host.store.getProject(projectId), null);
    assert.equal(existsSync(path.join(root, ".libera-shared.json")), false);
    assert.equal(sameTree(before, snapshotTree(root)), null, "the owner's files are preserved");
    assert.equal(readFileSync(path.join(root, "_archive/old.md"), "utf8"), "Keep the archive\n");
    assert.deepEqual((await api<ProjectSummary[]>(server, "/v1/projects", undefined, aliceAuth.accessToken)).body, []);
    await until(() => bob.service.localProjects()[0]?.revoked === true, "Bob to lose shared access");
    assert.equal(bob.service.resolvePath(`${bobNotebook}/note.md`)?.readOnly, true);
    assert.equal(sameTree(bobBefore, snapshotTree(bobRoot)), null, "the collaborator's files are preserved");

    await alice.service.stop();
    await alice.service.start();
    assert.deepEqual(alice.service.localProjects(), [], "a restart does not restore the old share");
    const reshared = await alice.router.call("POST", ControlRoutes.share, { notebook: "Research" });
    assert.equal(reshared.status, 200, JSON.stringify(reshared.body));
    assert.notEqual((reshared.body as { projectId: string }).projectId, projectId);
    assert.equal(alice.service.resolvePath("Research/note.md")?.readOnly, false);
    assert.equal(sameTree(before, snapshotTree(root)), null, "sharing again preserves all content");

    // Deletion from another device still permits finishing this device's cleanup.
    const secondId = (reshared.body as { projectId: string }).projectId;
    assert.equal((await api(server, `/v1/projects/${secondId}`, undefined, aliceAuth.accessToken, "DELETE")).status, 204);
    await until(() => alice.service.localProjects()[0]?.revoked === true, "the other device's deletion to arrive");
    assert.equal((await alice.router.call("DELETE", ControlRoutes.project(secondId))).status, 204);
    assert.equal(existsSync(path.join(root, ".libera-shared.json")), false);
    assert.deepEqual(alice.service.localProjects(), []);
  } finally {
    for (const peer of peers) await closePeer(peer).catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
