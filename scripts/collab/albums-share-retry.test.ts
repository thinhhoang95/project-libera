import assert from "node:assert/strict";
import { appendFileSync, existsSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { readSharePlan } from "../../electron/collab/notebooks/state";
import type { FetchLike } from "../../electron/collab/core";
import { ControlRoutes, type ShareAlbumResult } from "../../src/lib/collab/local-api";
import { closePeer, makePeer, register, tempRoot, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

test("album uploads checkpoint incrementally and resume after interruption and changed bytes", { timeout: 90_000 }, async (t) => {
  const temp = tempRoot("libera-album-retry-");
  const server = await startServerProcess();
  let peer: Peer | undefined;
  try {
    const auth = await register(server, "AlbumRetry");
    const uploads: string[] = [];
    let fail = true;
    const flaky: FetchLike = async (url, init) => {
      if (init.method === "PUT" && new URL(url).pathname.includes("/blobs/")) {
        if (fail && uploads.length === 10) throw new TypeError("interrupted album upload");
        uploads.push(new URL(url).pathname);
      }
      return fetch(url, init);
    };
    peer = await makePeer(temp.dir, "owner", server, auth, { fetch: flaky });
    const root = path.join(peer.library, "..", "..", "gallery", "Trip");
    writeTree(root, Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`photo-${i}.png`, `photo-${i}`])));
    const originalWriteFile = fs.writeFile;
    let planWrites = 0;
    const writes = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
      if (path.dirname(String(args[0])) === root) {
        try {
          const value = JSON.parse(String(args[1]));
          if (Array.isArray(value.files) && value.startedAt) planWrites++;
        } catch { /* Photo bytes are not JSON. */ }
      }
      return originalWriteFile(...args);
    });
    try {
      const failed = await peer.router.call("POST", ControlRoutes.albumShare, { folder: "Trip" });
      assert.equal(failed.status, 503);
      assert.equal(planWrites, 2, "one plan and one project checkpoint, regardless of uploaded photo count");
      const plan = await readSharePlan(root);
      assert.ok(plan?.projectId);
      assert.equal(plan.files.filter((file) => file.uploaded).length, 10);
      const changed = plan.files.find((file) => file.uploaded)!;
      writeFileSync(path.join(root, changed.path), "changed since checkpoint");
      // A crash in the middle of an append does not invalidate earlier records or later appends.
      appendFileSync(path.join(root, ".libera-share-uploaded.jsonl"), '{"fileId":');
      fail = false;
      const resumed = await peer.router.call("POST", ControlRoutes.albumShare, { folder: "Trip" });
      assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
      assert.equal((resumed.body as ShareAlbumResult).projectId, plan.projectId);
      assert.equal((resumed.body as ShareAlbumResult).photos, 40);
      assert.equal(planWrites, 3, "resuming rewrites the full plan only once");
      assert.equal(uploads.length, 41, "only the changed completed photo is uploaded again");
      assert.equal(new Set(uploads).size, 41);
      const marker = JSON.parse(readFileSync(path.join(root, ".libera-shared.json"), "utf8"));
      assert.equal(marker.projectId, plan.projectId);
      assert.equal(existsSync(path.join(root, ".libera-share-pending.json")), false);
      assert.equal(existsSync(path.join(root, ".libera-share-uploaded.jsonl")), false);
    } finally { writes.mock.restore(); }
  } finally {
    if (peer) await closePeer(peer);
    await server.stop();
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
