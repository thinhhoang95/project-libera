// Audit 2026-11-23, package PR2 (host side): H5 (the old root's binding goes when a project is rebound to a
// renamed folder, and a binding of a project that lives elsewhere does not block the path), H6 (a follower's
// legacy binding accepts the upgraded marker) and M2 (the startup rebind records the root transition).

import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { readNotebookBinding, recordNotebookBinding, type NotebookMarker } from "../../src/lib/collab/local-notebook-state";
import { pendingRootTransitions } from "../../src/lib/collab/root-transitions";
import { closePeer, makePeer, register, tempRoot, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

const MARKER = ".libera-shared.json";

interface Handle { root: string; folderId: string | null; runtime: unknown }
interface Internals {
  projects: Map<string, Handle>;
  lifecycleDirectory: string;
  unjoined: Map<string, { reason?: string }>;
  rebindMovedRoot(handle: Handle): Promise<boolean>;
  matchesMarker(handle: Handle, marker: NotebookMarker | null): boolean;
  adoptMarkers(): Promise<void>;
}
const internals = (peer: Peer) => peer.service as unknown as Internals;
const readMarkerFile = (root: string) => JSON.parse(readFileSync(path.join(root, MARKER), "utf8")) as NotebookMarker;

test("binding and root-transition audit fixes", { timeout: 300_000 }, async (t) => {
  const temp = tempRoot("libera-audit-1123-bindings-");
  const server = await startServerProcess();
  let owner!: Peer;
  try {
    const auth = await register(server, "BindOwner");
    owner = await makePeer(temp.dir, "owner", server, auth);

    await t.test("H5 and M2: a folder renamed while Libera was closed is rebound, recorded, and its old binding removed", async () => {
      writeTree(path.join(owner.library, "Moved"), { "note.md": "moved\n" });
      const shared = await owner.service.share({ notebook: "Moved" });
      await owner.service.project(shared.projectId)?.whenIdle();
      const lifecycle = internals(owner).lifecycleDirectory;
      const oldRoot = path.join(owner.library, "Moved");
      assert.ok(readNotebookBinding(lifecycle, oldRoot), "bound while it runs");
      await closePeer(owner);
      const newRoot = path.join(owner.library, "Renamed");
      renameSync(oldRoot, newRoot);
      owner = await makePeer(temp.dir, "owner", server, auth);
      assert.equal(owner.host.store.getProject(shared.projectId)?.localRoot, newRoot, "the project follows the folder");
      assert.equal(readNotebookBinding(lifecycle, oldRoot), null, "the old path is no longer bound");
      assert.ok(readNotebookBinding(lifecycle, newRoot), "the new path is bound");
      const transition = pendingRootTransitions(lifecycle).find((item) => item.projectId === shared.projectId);
      assert.deepEqual([transition?.from, transition?.to], ["Moved", "Renamed"], "the rename is recorded for the library-level records");
    });

    await t.test("H5: a running project rebound by rebindMovedRoot leaves no binding at the old path", async () => {
      writeTree(path.join(owner.library, "Live"), { "note.md": "live\n" });
      const shared = await owner.service.share({ notebook: "Live" });
      await owner.service.project(shared.projectId)?.whenIdle();
      const service = internals(owner);
      const oldRoot = path.join(owner.library, "Live");
      assert.ok(readNotebookBinding(service.lifecycleDirectory, oldRoot));
      renameSync(oldRoot, path.join(owner.library, "Live2"));
      assert.equal(await service.rebindMovedRoot(service.projects.get(shared.projectId)!), true);
      assert.equal(readNotebookBinding(service.lifecycleDirectory, oldRoot), null);
    });

    await t.test("H5: a binding of a project that runs in another folder does not make a different notebook here an ambiguous copy", async () => {
      const service = internals(owner);
      const renamed = path.join(owner.library, "Renamed");
      const stranger = path.join(owner.library, "Stranger");
      mkdirSync(stranger, { recursive: true });
      const own = readMarkerFile(renamed);
      writeFileSync(path.join(stranger, MARKER), JSON.stringify({ ...own, projectId: "prj_stranger", manifestDocId: "doc_stranger_m", folderId: "fld_stranger" }));
      // A leftover: the stranger's path is bound to the project that now runs at Renamed.
      recordNotebookBinding(service.lifecycleDirectory, stranger, own);
      await service.adoptMarkers();
      assert.notEqual(service.unjoined.get(stranger)?.reason, "ambiguous-copy", "the leftover binding is not a conflict");
      const left = readNotebookBinding(service.lifecycleDirectory, stranger);
      assert.ok(!left || left.projectId !== own.projectId, "the leftover binding was dropped");
    });

    await t.test("H6: a follower's binding without folderId accepts the upgraded marker", async () => {
      const service = internals(owner);
      const renamed = path.join(owner.library, "Renamed");
      const handle = service.projects.get(owner.host.store.listProjects().find((row) => row.localRoot === renamed)!.projectId)!;
      const upgraded = readMarkerFile(renamed);
      const legacy: NotebookMarker = { ...upgraded };
      delete legacy.folderId;
      recordNotebookBinding(service.lifecycleDirectory, renamed, legacy);
      const asFollower: Handle = Object.assign(Object.create(Object.getPrototypeOf(handle)) as object, handle, { folderId: null });
      assert.equal(service.matchesMarker(asFollower, { ...upgraded, folderId: "fld_upgraded" }), true);
      assert.equal(service.matchesMarker(asFollower, { ...upgraded, projectId: "prj_other" }), false);
    });
  } finally {
    await closePeer(owner).catch(() => undefined);
    await server.stop();
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
