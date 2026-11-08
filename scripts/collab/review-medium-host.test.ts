// Regressions for the November 2026 collaboration review's Medium findings,
// through the real host and server: explicit requests after a stop (R22),
// album cleanup on a follower (R24), ink following renames (R25), a notebook
// folder renamed while running (R32), a deleted sharing marker (R33), and
// what a scan does not share: provider conflict copies (R40) and LaTeX build
// products (R41).

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { FetchLike } from "../../electron/collab/core";
import { readManifest } from "../../electron/collab/notebooks/layout";
import { readNotebookLifecycle, type NotebookMarker } from "../../src/lib/collab/local-notebook-state";
import { invalidateSharedNotebookCache, isSharedNotebookPath } from "../../src/lib/collab/shared-notebook";
import { ControlRoutes, type HostEvent } from "../../src/lib/collab/local-api";
import { api, closePeer, invite, makePeer, register, tempRoot, until, writeTree, type Peer, type PeerOptions } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

const MARKER = ".libera-shared.json";

/** A small valid JPEG (as in albums-host.test.ts; importing that file would run its tests). */
function jpegWithExif(marker: string): Buffer {
  const exif = Buffer.concat([
    Buffer.from("Exif\0\0", "binary"),
    Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from(`GPS:${marker}`, "binary"),
  ]);
  const segment = (code: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, code, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe1, exif),
    segment(0xdb, Buffer.from([0x00, ...new Array(64).fill(1)])),
    segment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])),
    Buffer.from(`image-data-${marker}`, "binary"),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function manifestPaths(peer: Peer, projectId: string): string[] {
  const project = peer.service.project(projectId);
  assert.ok(project, `${projectId} runs on ${peer.name}`);
  const hub = peer.host.acquire(project.info.manifestDocId);
  try {
    return [...readManifest(hub.getDoc("manifest")).values()].map((entry) => entry.path).sort();
  } finally {
    peer.host.release(project.info.manifestDocId);
  }
}

const INK = `${JSON.stringify({ format: "libera-ink", version: 1, author: { key: "aaaaaa" }, frame: { unit: "pt", width: 612, height: 792 }, strokes: [], erased: [], revision: 1 })}\n`;

test("review: medium findings through the host", { timeout: 300_000 }, async (t) => {
  const temp = tempRoot("libera-review-medium-");
  const server = await startServerProcess();
  let serial = 0;
  try {
    const ownerAuth = await register(server, "MediumOwner");
    const memberAuth = await register(server, "MediumMember");

    async function scenario(name: string, body: (peer: (auth?: typeof ownerAuth, options?: PeerOptions) => Promise<Peer>, close: (peer: Peer) => Promise<void>) => Promise<void>) {
      await t.test(name, { timeout: 90_000 }, async () => {
        const peers: Peer[] = [];
        const closed = new Set<Peer>();
        const peer = async (auth = ownerAuth, options: PeerOptions = {}) => {
          const created = await makePeer(temp.dir, `medium-${++serial}`, server, auth, options);
          peers.push(created);
          return created;
        };
        const close = async (target: Peer) => {
          closed.add(target);
          await closePeer(target);
        };
        try {
          await body(peer, close);
        } finally {
          for (const value of peers.reverse()) if (!closed.has(value)) await closePeer(value).catch(() => undefined);
        }
      });
    }

    await scenario("R22: an explicit change queued when the notebook stops is refused, not reported as done", async (peer) => {
      const owner = await peer();
      writeTree(path.join(owner.library, "Queued"), { "note.md": "note\n" });
      const shared = await owner.service.share({ notebook: "Queued" });
      const project = owner.service.project(shared.projectId)!;
      await project.whenIdle();
      let release = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      void (project as unknown as { enqueue(task: () => Promise<void>): Promise<void> }).enqueue(() => gate);
      const creating = project.fileOp({ op: "create-file", path: "late.md", content: "late\n" });
      creating.catch(() => undefined);
      const stopping = project.stop();
      release();
      await assert.rejects(creating, (error: { status?: number }) => error.status === 503);
      await stopping;
    });

    await scenario("R25: a file's ink follows it through an app rename and a Finder rename", async (peer) => {
      const owner = await peer();
      const root = path.join(owner.library, "Inked");
      writeTree(root, { "paper.pdf": "%PDF-1.4 inked\n", "_ink/paper.pdf/page-0001.aaaaaa.ink": INK, "other.pdf": "%PDF-1.4 other\n", "_ink/other.pdf/page-0001.aaaaaa.ink": INK });
      const shared = await owner.service.share({ notebook: "Inked" });
      const project = owner.service.project(shared.projectId)!;
      await project.whenIdle();
      assert.ok(manifestPaths(owner, shared.projectId).includes("_ink/paper.pdf/page-0001.aaaaaa.ink"));

      const renamed = await owner.router.call("POST", ControlRoutes.files(shared.projectId), { op: "rename", path: "paper.pdf", to: "renamed.pdf" });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
      const afterApp = manifestPaths(owner, shared.projectId);
      assert.ok(afterApp.includes("_ink/renamed.pdf/page-0001.aaaaaa.ink"), afterApp.join(", "));
      assert.ok(!afterApp.some((entry) => entry.startsWith("_ink/paper.pdf")), "nothing stays at the old ink path");
      await until(() => existsSync(path.join(root, "_ink", "renamed.pdf", "page-0001.aaaaaa.ink")), "the ink to move on disk");

      renameSync(path.join(root, "renamed.pdf"), path.join(root, "final.pdf"));
      await until(() => manifestPaths(owner, shared.projectId).includes("_ink/final.pdf/page-0001.aaaaaa.ink"), "the ink to follow a Finder rename");
      await until(() => existsSync(path.join(root, "_ink", "final.pdf", "page-0001.aaaaaa.ink")), "the ink to move on disk again");
      assert.equal(readFileSync(path.join(root, "_ink", "final.pdf", "page-0001.aaaaaa.ink"), "utf8"), INK);

      // Deleting a file on purpose takes its ink along; a change of type drops it.
      const deleted = await owner.router.call("POST", ControlRoutes.files(shared.projectId), { op: "delete", path: "final.pdf" });
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
      const retyped = await owner.router.call("POST", ControlRoutes.files(shared.projectId), { op: "rename", path: "other.pdf", to: "other.png" });
      assert.equal(retyped.status, 200, JSON.stringify(retyped.body));
      const remaining = manifestPaths(owner, shared.projectId);
      assert.ok(!remaining.some((entry) => entry.startsWith("_ink/")), remaining.join(", "));
    });

    await scenario("R32: a shared notebook folder renamed while Libera runs continues at its new name", async (peer) => {
      const owner = await peer(ownerAuth, { leaseTtlMs: 900 });
      writeTree(path.join(owner.library, "Moving"), { "note.md": "moving\n" });
      const shared = await owner.service.share({ notebook: "Moving" });
      await owner.service.project(shared.projectId)!.whenIdle();
      renameSync(path.join(owner.library, "Moving"), path.join(owner.library, "Moved"));
      await until(() => owner.service.localProjects().some((project) => project.projectId === shared.projectId && project.notebook === "Moved"), "the project to rebind to the new folder");
      writeFileSync(path.join(owner.library, "Moved", "after.md"), "made after the move\n");
      await until(() => owner.service.resolvePath("Moved/after.md") !== null, "a file in the new folder to be shared");
      assert.equal(owner.host.store.getProject(shared.projectId)?.localRoot, path.join(owner.library, "Moved"));
    });

    await scenario("R33: a sharing marker deleted by hand comes back once it stays missing", async (peer) => {
      const owner = await peer(ownerAuth, { leaseTtlMs: 900 });
      (owner.service as unknown as { markerRepairDelayMs: number }).markerRepairDelayMs = 400;
      const root = path.join(owner.library, "Marked");
      writeTree(root, { "note.md": "marked\n" });
      const shared = await owner.service.share({ notebook: "Marked" });
      await owner.service.project(shared.projectId)!.whenIdle();
      rmSync(path.join(root, MARKER));
      await until(() => existsSync(path.join(root, MARKER)), "the marker to be restored");
      const marker = JSON.parse(readFileSync(path.join(root, MARKER), "utf8")) as { projectId: string; manifestDocId: string };
      assert.equal(marker.projectId, shared.projectId);
      assert.equal(marker.manifestDocId, owner.service.project(shared.projectId)!.info.manifestDocId);
      writeFileSync(path.join(root, "after.md"), "after the repair\n");
      await until(() => owner.service.resolvePath("Marked/after.md") !== null, "sync to resume");
    });

    await scenario("R40/R41: conflict copies are set aside and LaTeX build products are not shared", async (peer) => {
      const owner = await peer();
      const root = path.join(owner.library, "Conflicts");
      writeTree(root, { "note.md": "first version\n" });
      const shared = await owner.service.share({ notebook: "Conflicts" });
      const project = owner.service.project(shared.projectId)!;
      await project.whenIdle();
      writeFileSync(path.join(root, "note.md"), "second version\n");
      await until(async () => { await project.whenIdle(); return manifestPaths(owner, shared.projectId).includes("note.md") && readFileSync(path.join(root, "note.md"), "utf8") === "second version\n"; }, "the edit to be imported");
      await until(() => {
        const resolved = owner.service.resolvePath("Conflicts/note.md");
        if (!resolved) return false;
        const hub = owner.host.acquire(resolved.docId);
        try { return hub.getText("content") === "second version\n"; } finally { owner.host.release(resolved.docId); }
      }, "the shared text to take the edit");

      const dropbox = "note (Bob's conflicted copy 2026-11-07).md";
      writeFileSync(path.join(root, "note-OtherMac.md"), "first version\n");
      writeFileSync(path.join(root, dropbox), "something else\n");
      writeFileSync(path.join(root, "note-backup.md"), "second version\n");
      writeFileSync(path.join(root, "paper.aux"), "\\relax\n");
      writeFileSync(path.join(root, "paper.tex"), "\\section{x}\n");

      await until(() => {
        const paths = manifestPaths(owner, shared.projectId);
        return paths.includes("note-backup.md") && paths.includes("paper.tex");
      }, "the person's new files to be shared");
      await until(() => existsSync(path.join(root, "_archive", "note-OtherMac.md")) && existsSync(path.join(root, "_archive", dropbox)), "conflict copies to be set aside");
      await project.whenIdle();
      const paths = manifestPaths(owner, shared.projectId);
      for (const absent of ["note-OtherMac.md", dropbox, "paper.aux"]) assert.ok(!paths.includes(absent), `${absent} is not shared`);
      assert.ok(existsSync(path.join(root, "paper.aux")), "the build product stays on disk");
      const archived = owner.events.filter((event): event is Extract<HostEvent, { t: "file-archived" }> => event.t === "file-archived");
      assert.deepEqual(archived.map((event) => event.reason).sort(), ["conflict-copy", "conflict-copy"]);
    });

    await scenario("R45: an old marker copy without a folder id does not lock a taken-down notebook again", async (peer) => {
      const owner = await peer();
      const root = path.join(owner.library, "Legacy");
      writeTree(root, { "note.md": "legacy\n" });
      const shared = await owner.service.share({ notebook: "Legacy" });
      await owner.service.project(shared.projectId)!.whenIdle();
      const marker = JSON.parse(readFileSync(path.join(root, MARKER), "utf8")) as Record<string, unknown>;
      assert.ok(marker.folderId, "a modern marker");
      const taken = await owner.router.call("DELETE", ControlRoutes.project(shared.projectId));
      assert.equal(taken.status, 204, JSON.stringify(taken.body));
      assert.ok(!existsSync(path.join(root, MARKER)));

      // A cloud provider delivers a copy of the marker from before it had a folder id.
      const legacy = { ...marker };
      delete legacy.folderId;
      delete legacy.writer;
      writeFileSync(path.join(root, MARKER), JSON.stringify(legacy));
      assert.equal(readNotebookLifecycle(owner.service.lifecycleDirectory, legacy as unknown as NotebookMarker), "local");
      const saved = { data: process.env.LIBERA_DATA_DIR, lifecycle: process.env.LIBERA_COLLAB_LIFECYCLE_DIR };
      process.env.LIBERA_DATA_DIR = path.dirname(path.dirname(owner.library));
      process.env.LIBERA_COLLAB_LIFECYCLE_DIR = owner.service.lifecycleDirectory;
      invalidateSharedNotebookCache();
      try {
        assert.equal(isSharedNotebookPath("Legacy/note.md"), false, "the storage guard lets the local notebook be edited");
      } finally {
        for (const [key, value] of [["LIBERA_DATA_DIR", saved.data], ["LIBERA_COLLAB_LIFECYCLE_DIR", saved.lifecycle]] as const) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        invalidateSharedNotebookCache();
      }
    });

    await scenario("R24: when album access ends, a follower whose writer is away still cleans up", async (peer, close) => {
      const owner = await peer();
      const member = await peer(memberAuth, { leaseTtlMs: 1500 });
      const ownerAlbum = path.join(owner.library, "..", "..", "gallery", "Shore");
      writeTree(ownerAlbum, { "beach.jpg": jpegWithExif("beach") });
      const shared = await owner.router.call("POST", ControlRoutes.albumShare, { folder: "Shore", name: "Shore", photos: [{ name: "beach.jpg" }] });
      assert.equal(shared.status, 200, JSON.stringify(shared.body));
      const { projectId } = shared.body as { projectId: string };
      const joined = await member.router.call("POST", ControlRoutes.join, { invitation: await invite(server, ownerAuth, projectId, memberAuth.account.email) });
      assert.equal(joined.status, 200, JSON.stringify(joined.body));
      const memberAlbum = path.join(member.library, "..", "..", "gallery", (joined.body as { notebook: string }).notebook);
      await until(() => existsSync(path.join(memberAlbum, "beach.jpg")), "the owner's photo to arrive");
      writeFileSync(path.join(memberAlbum, "mine.jpg"), jpegWithExif("mine"));
      await until(() => existsSync(path.join(ownerAlbum, "mine.jpg")), "the member's photo to reach the owner");
      await member.service.project(projectId)!.whenIdle();

      // The same account on another device, on the same synced gallery, that cannot take the lease.
      const twinFetch: FetchLike = (url, init) => (url.includes("/folder-lease") ? Promise.reject(new Error("offline")) : fetch(url, init));
      const twin = await peer(memberAuth, { library: member.library, leaseTtlMs: 1500, fetch: twinFetch });
      await until(() => twin.service.localProjects().some((project) => project.projectId === projectId), "the twin to adopt the album");
      await until(() => twin.service.project(projectId)?.albumState().photos.length === 2, "the twin to know both photos");
      assert.equal(twin.service.project(projectId)?.follower, true);

      await close(member);
      const removed = await api(server, `/v1/projects/${projectId}/members/${memberAuth.account.id}`, undefined, ownerAuth.accessToken, "DELETE");
      assert.ok(removed.status === 204 || removed.status === 200, JSON.stringify(removed));
      await until(() => !existsSync(path.join(memberAlbum, "beach.jpg")), "the follower to remove the owner's photo");
      assert.ok(existsSync(path.join(memberAlbum, "mine.jpg")), "the member's own photo stays");
      await until(() => !existsSync(path.join(memberAlbum, MARKER)), "the folder to become an ordinary album");
      assert.ok(!readdirSync(memberAlbum).includes(".libera"));
    });
  } finally {
    await server.stop();
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
