// File-moving review 2026-11-25, package S3 (S-C2, host side): a rename or delete through fileOp that the server has
// not acknowledged is not in the transition log, is reported as awaiting the server (the answer and the file list),
// and is announced (`transitions-recorded`) when the acknowledgement records it, so the records kept on this computer
// follow it once and never before.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { ManifestKeys } from "../../src/lib/collab/protocol/schema";
import { ControlRoutes, type FileListResponse, type FileOpResult } from "../../src/lib/collab/local-api";
import { closePeer, makePeer, register, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

interface Internals { manifestCaughtUp(): boolean }

test("S-C2: an unacknowledged rename is awaited, not logged, and announced when the server has it", { timeout: 240_000 }, async () => {
  const temp = tempRoot("libera-review-1125-s3-");
  const server = await startServerProcess();
  let peer: Peer | undefined;
  try {
    const auth = await register(server, "S3");
    peer = await makePeer(temp.dir, "owner", server, auth, { timings: { pollMs: 5_000, retryMs: 300 } });
    const owner = peer;
    writeTree(path.join(owner.library, "Lab"), { "a.md": "# A\n", "b.md": "# B\n" });
    const shared = await owner.service.share({ notebook: "Lab" });
    const project = owner.service.project(shared.projectId)!;
    await project.whenIdle();
    const projectId = shared.projectId;
    const files = ControlRoutes.files(projectId);
    const runtime = project as unknown as Internals;
    const log = () => owner.host.store.transitionsAfter(projectId);

    // Acknowledged: in the log when the answer comes (nothing waits).
    const quick = await owner.router.call("POST", files, { op: "rename", path: "b.md", to: "c.md" });
    assert.equal(quick.status, 200, JSON.stringify(quick.body));
    const quickBody = quick.body as FileOpResult;
    if (quickBody.acknowledged) assert.ok(log().some((row) => row.to?.endsWith("c.md")), "an acknowledged change is already logged");
    await until(() => log().some((row) => row.to?.endsWith("c.md")), "the first move in the log");

    // The socket is between connections: the edit is in memory and unacknowledged.
    runtime.manifestCaughtUp = () => false;
    let renamed: FileOpResult;
    try {
      const response = await owner.router.call("POST", files, { op: "rename", path: "a.md", to: "d.md" });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      renamed = response.body as FileOpResult;
      assert.equal(renamed.acknowledged, false, "the server does not have it yet");
      assert.ok(!log().some((row) => row.to?.endsWith("d.md")), "no row before the server has the change");
      const listed = await owner.router.call("GET", ControlRoutes.fileEntries(projectId));
      assert.equal((listed.body as FileListResponse).awaitingServer, 1, "the list says a change awaits the server");
    } finally {
      delete (runtime as Partial<Internals>).manifestCaughtUp;
    }

    // The next edit goes out and its acknowledgement releases the deferred work: the row is recorded and announced.
    const before = owner.events.filter((event) => event.t === "transitions-recorded").length;
    const hub = owner.host.acquire(project.info.manifestDocId);
    try {
      hub.applyLocalChange("manifest", (doc) => {
        const map = doc.getMap<unknown>(ManifestKeys.files);
        for (const [key, value] of map.entries()) {
          const record = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
          if (record.path === "d.md") map.set(key, { ...record, updatedAt: Date.now() });
        }
      }, { source: "typing" });
      await until(() => log().some((row) => row.to?.endsWith("d.md")), "the acknowledged move to be logged", 15_000);
    } finally {
      owner.host.release(project.info.manifestDocId);
    }
    await until(() => owner.events.filter((event) => event.t === "transitions-recorded").length > before, "the announcement");
    const after = await owner.router.call("GET", ControlRoutes.fileEntries(projectId));
    assert.equal((after.body as FileListResponse).awaitingServer, undefined, "nothing awaits once logged");
  } finally {
    if (peer) await closePeer(peer).catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
