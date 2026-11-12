import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { readManifest } from "../../../electron/collab/notebooks/layout.ts";
import { sha256 } from "../../../electron/collab/notebooks/fs-ops.ts";
import { ContentKeys, ManifestKeys } from "../../../src/lib/collab/protocol/schema.ts";
import { closePeer, makePeer, register, tempRoot, until, writeTree } from "./notebooks-harness.ts";
import { removeDataDir, startServerProcess } from "./server-process.ts";

function quiet(project) {
  project.watcher?.close(); project.watcher = null;
  for (const key of ["pollTimer", "scanTimer", "retryTimer", "manifestTimer"]) {
    if (project[key]) clearTimeout(project[key]); project[key] = null;
  }
  for (const doc of project.docs.values()) { if (doc.writeTimer) clearTimeout(doc.writeTimer); doc.writeTimer = null; }
}
const entries = (project) => readManifest(project.manifestHub.getDoc("manifest"));
const setText = (hub, text) => hub.applyLocalChange("content", (doc) => {
  const source = doc.getText(ContentKeys.source); source.delete(0, source.length); source.insert(0, text);
}, { source: "typing" });

test("R02–R09 and R15: authoritative notebook mutations", { timeout: 180_000 }, async (t) => {
  const temp = tempRoot("libera-critical-projects-");
  const server = await startServerProcess();
  const auth = await register(server, "CriticalOwner");
  let serial = 0;
  async function scenario(name, run) {
    await t.test(name, { timeout: 35_000 }, async () => {
      const peers = [];
      const peer = async (options = {}) => {
        const value = await makePeer(temp.dir, `critical-${++serial}`, server, auth, { leaseTtlMs: 60_000, ...options });
        peers.push(value); return value;
      };
      try { await run(peer); } finally { for (const value of peers.reverse()) await closePeer(value); }
    });
  }
  try {
    await scenario("R02: collision paths select one stable identity for replace, rename and delete", async (peer) => {
      const owner = await peer(); const root = path.join(owner.library, "Collision");
      writeTree(root, { "a.bin": Buffer.from([0, 1]), "b.bin": Buffer.from([0, 2]), "c.bin": Buffer.from([0, 3]) });
      const shared = await owner.service.share({ notebook: "Collision" }); const project = owner.service.project(shared.projectId);
      await project.whenIdle(); quiet(project);
      const original = [...entries(project).values()];
      const ids = Object.fromEntries(original.map((entry) => [entry.path, entry.fileId]));
      project.manifestHub.applyLocalChange("manifest", (doc) => {
        for (const entry of original) doc.getMap(ManifestKeys.files).set(entry.fileId, { ...entry, path: "a.bin", createdAt: entry.path.charCodeAt(0) });
      }, { source: "typing" });
      await project.whenIdle();
      assert.ok(existsSync(path.join(root, "a (3).bin")));
      const replacement = Buffer.from([0, 9]);
      await project.fileOp({ op: "write-blob", path: "a (2).bin", contentBase64: replacement.toString("base64") });
      assert.equal(entries(project).get(ids["b.bin"]).blobHash, sha256(replacement));
      assert.equal(entries(project).get(ids["a.bin"]).blobHash, sha256(Buffer.from([0, 1])));
      await project.fileOp({ op: "delete", path: "a (3).bin" });
      assert.equal(entries(project).has(ids["c.bin"]), false);
      await project.fileOp({ op: "rename", path: "a (2).bin", to: "renamed.bin" });
      assert.equal(entries(project).get(ids["b.bin"]).path, "renamed.bin");
      const b = entries(project).get(ids["b.bin"]);
      project.manifestHub.applyLocalChange("manifest", (doc) => doc.getMap(ManifestKeys.files).set(b.fileId, { ...b, path: "a.bin" }), { source: "typing" });
      await project.whenIdle();
      await project.fileOp({ op: "delete", path: "a.bin" });
      assert.equal(entries(project).has(ids["a.bin"]), false);
      assert.equal(entries(project).has(ids["b.bin"]), true, "deleting the first visible file keeps its colliding peer");
    });

    await scenario("R03: lost document-create response retains its original payload and intervening disk edits", async (peer) => {
      let drop = true;
      const owner = await peer({ fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (drop && init.method === "POST" && /\/documents$/.test(new URL(url).pathname)) { drop = false; throw new TypeError("lost successful create response"); }
        return response;
      } });
      const root = path.join(owner.library, "Replay"); writeTree(root, { "note.md": "original\n" });
      await assert.rejects(owner.service.share({ notebook: "Replay" }));
      const saved = JSON.parse(readFileSync(path.join(root, ".libera-share-pending.json"), "utf8"));
      assert.equal(saved.files[0].initialText, "original\n");
      writeFileSync(path.join(root, "note.md"), "intervening edit\n");
      await owner.service.share({ notebook: "Replay" });
      const resolved = owner.service.resolvePath("Replay/note.md");
      const hub = owner.host.acquire(resolved.docId);
      try { await until(() => hub.getText("content") === "intervening edit\n", "intervening edit preserved by replay"); }
      finally { owner.host.release(resolved.docId); }
      assert.equal(readFileSync(path.join(root, "note.md"), "utf8"), "intervening edit\n");
    });

    await scenario("R04: delayed provider absence never tombstones a materialized text or blob", async (peer) => {
      const owner = await peer({ timings: { deleteGraceMs: 0 } }); const root = path.join(owner.library, "Absence");
      writeTree(root, { "note.md": "keep text\n", "photo.bin": Buffer.from([0, 7]) });
      const shared = await owner.service.share({ notebook: "Absence" }); const project = owner.service.project(shared.projectId);
      await project.whenIdle(); quiet(project);
      const before = [...entries(project).keys()];
      rmSync(path.join(root, "note.md")); rmSync(path.join(root, "photo.bin"));
      await project.scan(); await project.scan(); await project.whenIdle();
      assert.deepEqual([...entries(project).keys()], before);
      assert.equal(readFileSync(path.join(root, "note.md"), "utf8"), "keep text\n");
      assert.deepEqual(readFileSync(path.join(root, "photo.bin")), Buffer.from([0, 7]));
    });

    await scenario("R04: a delayed album-provider deletion retains the photo manifest", async (peer) => {
      const owner = await peer({ timings: { deleteGraceMs: 0 } });
      const root = path.resolve(owner.library, "../../gallery/AbsentAlbum");
      writeTree(root, { "photo.png": Buffer.from([0, 3, 8]) });
      const shared = await owner.service.shareAlbum({ folder: "AbsentAlbum" });
      const project = owner.service.project(shared.projectId); await project.whenIdle(); quiet(project);
      const ids = [...entries(project).keys()]; rmSync(path.join(root, "photo.png"));
      await project.scan(); await project.scan(); await project.whenIdle();
      assert.deepEqual([...entries(project).keys()], ids);
      assert.deepEqual(readFileSync(path.join(root, "photo.png")), Buffer.from([0, 3, 8]));
    });

    await scenario("R05: restore while an unrelated upload waits cannot publish a shared deletion", async (peer) => {
      let hold = false, entered = false, release;
      const gate = new Promise((resolve) => { release = resolve; });
      const owner = await peer({ timings: { deleteGraceMs: 0 }, fetch: async (url, init) => {
        if (hold && init.method === "POST" && /\/documents$/.test(new URL(url).pathname)) { entered = true; await gate; }
        return fetch(url, init);
      } });
      const root = path.join(owner.library, "Restore"); writeTree(root, { "note.md": "base\n" });
      const shared = await owner.service.share({ notebook: "Restore" }); const project = owner.service.project(shared.projectId);
      await project.whenIdle(); quiet(project);
      const docId = owner.service.resolvePath("Restore/note.md").docId;
      rmSync(path.join(root, "note.md")); writeFileSync(path.join(root, "new.md"), "new upload\n");
      utimesSync(path.join(root, "new.md"), new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
      hold = true; const scan = project.scan();
      try {
        await until(() => entered, "unrelated create upload waits");
        writeFileSync(path.join(root, "note.md"), "restored while uploading\n"); release(); await scan; await project.whenIdle();
        assert.ok([...entries(project).values()].some((entry) => entry.docId === docId));
        assert.equal(readFileSync(path.join(root, "note.md"), "utf8"), "restored while uploading\n");
      } finally { release(); await scan; }
    });

    for (const changed of ["shared", "disk"]) await scenario(`R07: reconciliation rejects an unreviewed ${changed} version`, async (peer) => {
      const owner = await peer(); const root = path.join(owner.library, "Merge");
      writeTree(root, { "note.md": "base\n" }); const shared = await owner.service.share({ notebook: "Merge" });
      const project = owner.service.project(shared.projectId); await project.whenIdle(); quiet(project);
      const docId = owner.service.resolvePath("Merge/note.md").docId;
      const hub = project.docs.get(docId).hub;
      await until(() => hub.getText("content") === "base\n", "reviewed document loads");
      await project.whenIdle(); quiet(project);
      const reviewed = { shared: "base\n", disk: "reviewed disk\n" };
      writeFileSync(path.join(root, "note.md"), reviewed.disk);
      project.state.reconciliations.push({ id: "rec_stale", docId, path: "Merge/note.md", ...reviewed, base: "base\n", detectedAt: Date.now() });
      if (changed === "shared") { setText(hub, "unseen shared\n"); quiet(project); }
      else writeFileSync(path.join(root, "note.md"), "unseen disk\n");
      await assert.rejects(project.resolveReconciliation("rec_stale", "stale result\n", reviewed), (error) => error.status === 409);
      assert.equal(hub.getText("content"), changed === "shared" ? "unseen shared\n" : "base\n");
      assert.equal(readFileSync(path.join(root, "note.md"), "utf8"), changed === "disk" ? "unseen disk\n" : reviewed.disk);
    });

    await scenario("R08: missing bookkeeping on a new writer quarantines late unexplained files across restart", async (peer) => {
      const owner = await peer(); const root = path.join(owner.library, "Adoption"); writeTree(root, { "deleted.md": "deleted bytes\n" });
      const shared = await owner.service.share({ notebook: "Adoption" }); const project = owner.service.project(shared.projectId);
      await project.whenIdle(); await owner.service.fileOp(shared.projectId, { op: "delete", path: "deleted.md" }); await project.whenIdle();
      const marker = readFileSync(path.join(root, ".libera-shared.json"));
      await owner.service.stop();
      const library = path.join(temp.dir, "fresh-library", "users", "admin"); const freshRoot = path.join(library, "Adoption");
      writeTree(freshRoot, { ".libera-shared.json": marker });
      const fresh = await peer({ library });
      await until(() => fresh.service.project(shared.projectId)?.follower === false, "new installation becomes writer");
      const runtime = fresh.service.project(shared.projectId); await runtime.whenIdle(); quiet(runtime);
      writeFileSync(path.join(freshRoot, "deleted.md"), "deleted bytes\n");
      utimesSync(path.join(freshRoot, "deleted.md"), new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
      await runtime.scan(); await runtime.whenIdle();
      assert.equal(entries(runtime).size, 0, "late deleted file cannot receive a new shared identity");
      assert.equal(readFileSync(path.join(freshRoot, "deleted.md"), "utf8"), "deleted bytes\n");
      await fresh.service.stop();
      // A late provider checkpoint cannot clear the profile-local adoption fence.
      writeFileSync(path.join(freshRoot, ".libera", "collab", "state.json"), JSON.stringify({ version: 1, layout: {}, reconciliations: [] }));
      await fresh.service.start();
      await until(() => fresh.service.project(shared.projectId)?.follower === false, "writer restarted");
      await fresh.service.project(shared.projectId).whenIdle();
      assert.equal(entries(fresh.service.project(shared.projectId)).size, 0);
    });

    await scenario("R09: historical bytes with a newer mtime require reconciliation", async (peer) => {
      const owner = await peer(); const root = path.join(owner.library, "History"); writeTree(root, { "note.md": "old\n" });
      const shared = await owner.service.share({ notebook: "History" }); const project = owner.service.project(shared.projectId);
      await project.whenIdle(); const docId = owner.service.resolvePath("History/note.md").docId; const hub = project.docs.get(docId).hub;
      await until(() => hub.getText("content") === "old\n", "historical baseline loads");
      await project.whenIdle();
      setText(hub, "current\n"); await project.whenIdle(); quiet(project);
      writeFileSync(path.join(root, "note.md"), "old\n");
      utimesSync(path.join(root, "note.md"), new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
      // An externally changed file is judged once it has been quiet (Timings.importQuietMs, 300 ms in the harness).
      await new Promise((resolve) => setTimeout(resolve, 400));
      await project.scan();
      assert.equal(hub.getText("content"), "current\n");
      assert.equal(project.reconcilePending, 1);
      assert.equal((await project.reconciliations())[0].disk, "old\n");
    });

    await scenario("R15: a failed terminal blob download keeps the shared project and marker", async (peer) => {
      const owner = await peer(); const root = path.join(owner.library, "BlockedExport");
      writeTree(root, { "photo.bin": Buffer.from([0, 1]) });
      const shared = await owner.service.share({ notebook: "BlockedExport" }); await owner.service.project(shared.projectId).whenIdle();
      const library = path.join(temp.dir, "blocked-export", "users", "admin"); mkdirSync(library, { recursive: true });
      const followerRoot = path.join(library, "BlockedExport"); cpSync(root, followerRoot, { recursive: true });
      let block = false;
      const follower = await peer({ library, fetch: (url, init) => block && init.method === "GET" && /\/blobs\//.test(new URL(url).pathname) ? Promise.resolve(new Response("unavailable", { status: 503 })) : fetch(url, init) });
      await until(() => follower.service.project(shared.projectId)?.follower, "blocked-export follower ready");
      const latest = Buffer.from([0, 8]); await owner.service.fileOp(shared.projectId, { op: "write-blob", path: "photo.bin", contentBase64: latest.toString("base64") });
      await until(() => [...entries(follower.service.project(shared.projectId)).values()].some((entry) => entry.blobHash === sha256(latest)), "latest export hash arrives");
      block = true;
      await assert.rejects(follower.service.takeDown(shared.projectId));
      assert.equal((await owner.host.api.getProject(shared.projectId)).id, shared.projectId);
      assert.equal(existsSync(path.join(followerRoot, ".libera-shared.json")), true);
    });

    await scenario("R15: follower takedown preserves current and missing blobs before deleting access", async (peer) => {
      const owner = await peer(); const root = path.join(owner.library, "Export");
      writeTree(root, { "stale.bin": Buffer.from([0, 1]), "missing.bin": Buffer.from([0, 2]) });
      const shared = await owner.service.share({ notebook: "Export" }); await owner.service.project(shared.projectId).whenIdle();
      const library = path.join(temp.dir, "follower-export", "users", "admin"); mkdirSync(library, { recursive: true });
      const followerRoot = path.join(library, "Export"); cpSync(root, followerRoot, { recursive: true }); rmSync(path.join(followerRoot, "missing.bin"));
      const follower = await peer({ library }); await until(() => follower.service.project(shared.projectId)?.follower, "export follower is ready");
      await follower.service.project(shared.projectId).whenIdle();
      const latest = Buffer.from([0, 9]); await owner.service.fileOp(shared.projectId, { op: "write-blob", path: "stale.bin", contentBase64: latest.toString("base64") });
      await until(() => [...entries(follower.service.project(shared.projectId)).values()].some((entry) => entry.blobHash === sha256(latest)), "follower receives latest blob identity");
      assert.deepEqual(readFileSync(path.join(followerRoot, "stale.bin")), Buffer.from([0, 1]));
      await follower.service.takeDown(shared.projectId);
      assert.deepEqual(readFileSync(path.join(followerRoot, "stale.bin")), latest);
      assert.deepEqual(readFileSync(path.join(followerRoot, "missing.bin")), Buffer.from([0, 2]));
      assert.equal(existsSync(path.join(followerRoot, ".libera-shared.json")), false);
    });
  } finally { await server.stop(); removeDataDir(server.dataDir); temp.cleanup(); }
});
