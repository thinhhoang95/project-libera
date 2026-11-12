// Additional review probes. Assertions retain the required matrix behavior.
// Accounts, servers and all filesystem roots are disposable fixtures.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, promises as fs, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { ContentKeys, ManifestKeys } from "../../../src/lib/collab/protocol/schema.ts";
import { api, closePeer, invite, makePeer, register, sleep, tempRoot, until, writeTree } from "../support/notebooks-harness.ts";
import { removeDataDir, startServerProcess } from "../support/server-process.ts";

const observe = (name, value) => console.log(`LIFECYCLE ${name} ${JSON.stringify(value)}`);
const quiet = (project) => {
  project.watcher?.close();
  project.watcher = null;
  if (project.pollTimer) clearInterval(project.pollTimer);
  project.pollTimer = null;
  if (project.scanTimer) clearTimeout(project.scanTimer);
  project.scanTimer = null;
};
const archiveContains = (root, bytes) => {
  const directory = path.join(root, "_archive");
  return existsSync(directory) && readdirSync(directory).some((name) => {
    try { return readFileSync(path.join(directory, name)).equals(Buffer.from(bytes)); } catch { return false; }
  });
};

async function acknowledged(peer, docId) {
  const hub = peer.host.acquire(docId);
  try { await until(() => hub.pendingCount === 0, "server acknowledgement"); }
  finally { peer.host.release(docId); }
}

test("remaining sync lifecycle boundaries", { timeout: 150_000 }, async (t) => {
  const temp = tempRoot("libera-lifecycle-review-");
  const server = await startServerProcess();
  let serial = 0;
  try {
    const ownerAuth = await register(server, "LifecycleReviewOwner");
    const memberAuth = await register(server, "LifecycleReviewMember");
    async function scenario(name, body) {
      await t.test(name, { timeout: 35_000 }, async () => {
        const peers = [];
        const peer = async (auth = ownerAuth, options = {}) => {
          const value = await makePeer(temp.dir, `lifecycle-${++serial}`, server, auth, options);
          peers.push(value);
          return value;
        };
        try { await body(peer); }
        finally { for (const value of peers.reverse()) await closePeer(value); }
      });
    }

    await scenario("text materialization preserves an external edit arriving during temp-file IO", async (peer) => {
      const owner = await peer();
      const root = path.join(owner.library, "TextCommit");
      writeTree(root, { "note.md": "original\n" });
      const shared = await owner.service.share({ notebook: "TextCommit" });
      const project = owner.service.project(shared.projectId);
      await project.whenIdle();
      quiet(project);
      const docId = owner.service.resolvePath("TextCommit/note.md").docId;
      const write = fs.writeFile;
      let held = false;
      let release = () => {};
      const gate = new Promise((resolve) => { release = resolve; });
      fs.writeFile = async (target, ...args) => {
        if (path.dirname(String(target)) === root && path.basename(String(target)).startsWith(".libera-tmp-") && !held) {
          held = true;
          await gate;
        }
        return write(target, ...args);
      };
      const external = "external edit during materialization\n";
      const hub = owner.host.acquire(docId);
      try {
        hub.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, "shared change\n"), { source: "typing" });
        await until(() => held, "pending temp-file write");
        writeFileSync(path.join(root, "note.md"), external);
        release();
        await project.whenIdle();
        await acknowledged(owner, docId);
        const disk = readFileSync(path.join(root, "note.md"), "utf8");
        const reconciliations = await project.reconciliations();
        const preserved = disk === external || archiveContains(root, external) || reconciliations.some((item) => item.disk === external);
        observe("text-commit", { disk, hub: hub.getText("content"), archivedExternal: archiveContains(root, external), reconciliations: reconciliations.length });
        assert.equal(preserved, true, "a text write must retain bytes changed after its initial disk observation");
      } finally { release(); fs.writeFile = write; owner.host.release(docId); }
    });

    await scenario("a new file cannot overwrite external bytes delivered while its server creation waits", async (peer) => {
      let delay = false;
      let started = false;
      let release = () => {};
      const gate = new Promise((resolve) => { release = resolve; });
      const owner = await peer(ownerAuth, { fetch: async (url, init) => {
        if (delay && init.method === "POST" && url.endsWith("/documents")) { started = true; await gate; }
        return fetch(url, init);
      } });
      const root = path.join(owner.library, "CreateCommit");
      writeTree(root, { "existing.md": "baseline\n" });
      const shared = await owner.service.share({ notebook: "CreateCommit" });
      const project = owner.service.project(shared.projectId);
      await project.whenIdle();
      quiet(project);
      delay = true;
      const creating = owner.service.fileOp(shared.projectId, { op: "create-file", path: "new.md", content: "Libera input\n" }).then(
        (result) => ({ status: 200, result }), (error) => ({ status: error.status, error: error.message }),
      );
      const external = "independent cloud arrival\n";
      try {
        await until(() => started, "server creation held");
        writeFileSync(path.join(root, "new.md"), external);
        release();
        const result = await creating;
        await project.whenIdle();
        const disk = readFileSync(path.join(root, "new.md"), "utf8");
        const preserved = disk === external || archiveContains(root, external);
        observe("create-over-arrival", { result, disk, archivedExternal: archiveContains(root, external) });
        assert.equal(preserved, true, "the once-empty destination changed during HTTP and must be preserved or refused");
      } finally { delay = false; release(); await creating; }
    });

    await scenario("a fresh share cannot adopt another project's existing membership just by matching its name", async (peer) => {
      const owner = await peer();
      const member = await peer(memberAuth);
      const name = "SameTitleDifferentNotebook";
      const existing = await api(server, "/v1/projects", { name }, ownerAuth.accessToken);
      assert.equal(existing.status, 201);
      const joined = await member.service.join({ invitation: await invite(server, ownerAuth, existing.body.id, memberAuth.account.email) });
      const root = path.join(owner.library, "PrivateNotebook");
      const secret = "private material intended for a new membership\n";
      writeTree(root, { "private.md": secret });
      const shared = await owner.service.share({ notebook: "PrivateNotebook", name });
      await owner.service.project(shared.projectId).whenIdle();
      await acknowledged(owner, owner.service.project(shared.projectId).info.manifestDocId);
      await sleep(200);
      const resolved = member.service.resolvePath(`${joined.notebook}/private.md`);
      let visible = null;
      if (resolved) {
        const hub = member.host.acquire(resolved.docId);
        try { visible = hub.getText("content"); }
        finally { member.host.release(resolved.docId); }
      }
      observe("orphan-name-collision", { existingId: existing.body.id, returnedId: shared.projectId, oldMemberText: visible });
      assert.notEqual(shared.projectId, existing.body.id, "fresh share must not inherit an unrelated project's invitations/membership");
      assert.equal(visible, null);
    });

    await scenario("an initial share cannot recreate a notebook removed during upload", async (peer) => {
      let delay = false;
      let started = false;
      let release = () => {};
      const gate = new Promise((resolve) => { release = resolve; });
      const owner = await peer(ownerAuth, { fetch: async (url, init) => {
        if (delay && init.method === "PUT" && url.includes("/blobs/")) { started = true; await gate; }
        return fetch(url, init);
      } });
      const root = path.join(owner.library, "RemovedDuringShare");
      writeTree(root, { "note.md": "retained input\n", "image.png": Buffer.from([1, 2, 3, 4]) });
      delay = true;
      const sharing = owner.service.share({ notebook: "RemovedDuringShare" }).then(
        (result) => ({ status: 200, result }), (error) => ({ status: error.status, error: error.message }),
      );
      try {
        await until(() => started, "initial upload held");
        rmSync(root, { recursive: true, force: true });
        release();
        const result = await sharing;
        if (result.status === 200) await owner.service.project(result.result.projectId).whenIdle();
        observe("share-removed-root", { status: result.status, rootExists: existsSync(root), markerExists: existsSync(path.join(root, ".libera-shared.json")) });
        assert.equal(existsSync(root), false, "initial-share bookkeeping must not recreate a deliberately removed root");
      } finally { delay = false; release(); await sharing; }
    });

    await scenario("an initial share cannot overwrite another shared identity delivered during upload", async (peer) => {
      let delay = false;
      let started = false;
      let release = () => {};
      const gate = new Promise((resolve) => { release = resolve; });
      const owner = await peer(ownerAuth, { fetch: async (url, init) => {
        if (delay && init.method === "PUT" && url.includes("/blobs/")) { started = true; await gate; }
        return fetch(url, init);
      } });
      const other = await peer();
      const foreignRoot = path.join(other.library, "ForeignSource");
      writeTree(foreignRoot, { "note.md": "belongs to a different notebook\n" });
      const foreign = await other.service.share({ notebook: "ForeignSource" });
      await other.service.project(foreign.projectId).whenIdle();
      const foreignMarker = readFileSync(path.join(foreignRoot, ".libera-shared.json"), "utf8");
      const root = path.join(owner.library, "ReplacedDuringShare");
      writeTree(root, { "note.md": "planned public bytes\n", "image.png": Buffer.from([4, 3, 2, 1]) });
      delay = true;
      const sharing = owner.service.share({ notebook: "ReplacedDuringShare" }).then(
        (result) => ({ status: 200, result }), (error) => ({ status: error.status, error: error.message }),
      );
      try {
        await until(() => started, "initial upload held");
        rmSync(root, { recursive: true, force: true });
        cpSync(foreignRoot, root, { recursive: true });
        release();
        const result = await sharing;
        if (result.status === 200) await owner.service.project(result.result.projectId).whenIdle();
        const marker = JSON.parse(readFileSync(path.join(root, ".libera-shared.json"), "utf8"));
        observe("share-replaced-root", { status: result.status, foreignProjectId: foreign.projectId, markerProjectId: marker.projectId });
        assert.equal(readFileSync(path.join(root, ".libera-shared.json"), "utf8"), foreignMarker, "a suspended initial share must leave the newly delivered project's marker and bookkeeping untouched");
      } finally { delay = false; release(); await sharing; }
    });

    await scenario("control: pending HTTP uploads refuse a plan from another account", async (peer) => {
      const original = await peer(ownerAuth, { fetch: async (url, init) => {
        if (init.method === "PUT" && url.includes("/blobs/")) throw new Error("interrupted initial share");
        return fetch(url, init);
      } });
      const root = path.join(original.library, "AccountPlan");
      writeTree(root, { "note.md": "old account input\n", "image.png": Buffer.from([1, 3, 5, 7]) });
      await assert.rejects(original.service.share({ notebook: "AccountPlan" }));
      const planFile = path.join(root, ".libera-share-pending.json");
      const plan = JSON.parse(readFileSync(planFile, "utf8"));
      assert.ok(plan.projectId);
      assert.ok(plan.files.some((file) => file.kind === "doc" && file.uploaded));
      await closePeer(original);
      const next = await peer(memberAuth, { library: original.library });
      next.service.shareSyncTimeoutMs = 250; // Only shorten the acknowledgement wait.
      const result = await next.service.share({ notebook: "AccountPlan" }).then(
        (value) => ({ status: 200, value }), (error) => ({ status: error.status, error: error.message }),
      );
      const access = result.status === 200 ? await api(server, `/v1/projects/${result.value.projectId}`, undefined, memberAuth.accessToken) : null;
      observe("share-plan-account-switch", { result, plannedProjectId: plan.projectId, newAccountProjectStatus: access?.status, originalPlanStillPresent: existsSync(planFile) });
      assert.ok(result.status !== 200 || access?.status === 200, "a resumed share must be authorized for its current account, or fail while preserving its old checkpoint");
      if (result.status !== 200) assert.equal(existsSync(planFile), true, "a refused resume retains its checkpoint");
    });

    await scenario("an entirely uploaded checkpoint still requires current-account authorization before publication", async (peer) => {
      const original = await peer();
      const root = path.join(original.library, "UploadedAccountPlan");
      const planFile = path.join(root, ".libera-share-pending.json");
      writeTree(root, { "note.md": "uploaded for the first account\n" });
      // Completions are journaled (one appended record per upload) rather than
      // rewriting the plan: interrupt right after the last one is durable. The
      // interrupted share then compacts the journal into the plan file.
      const append = fs.appendFile;
      let interrupted = false;
      fs.appendFile = async (target, ...args) => {
        await append(target, ...args);
        if (!interrupted && path.basename(String(target)) === ".libera-share-uploaded.jsonl") {
          interrupted = true;
          throw new Error("simulated interruption after durable final upload checkpoint");
        }
      };
      try { await assert.rejects(original.service.share({ notebook: "UploadedAccountPlan" })); }
      finally { fs.appendFile = append; }
      assert.equal(interrupted, true);
      const plan = JSON.parse(readFileSync(planFile, "utf8"));
      assert.equal(plan.files.every((file) => file.uploaded), true);
      assert.equal(existsSync(path.join(root, ".libera-shared.json")), false);
      await closePeer(original);
      const next = await peer(memberAuth, { library: original.library });
      next.service.shareSyncTimeoutMs = 250;
      const result = await next.service.share({ notebook: "UploadedAccountPlan" }).then(
        (value) => ({ status: 200, value }), (error) => ({ status: error.status, error: error.message }),
      );
      const access = result.status === 200 ? await api(server, `/v1/projects/${result.value.projectId}`, undefined, memberAuth.accessToken) : null;
      const markerFile = path.join(root, ".libera-shared.json");
      observe("uploaded-plan-account-switch", {
        result, plannedProjectId: plan.projectId, newAccountProjectStatus: access?.status,
        originalPlanStillPresent: existsSync(planFile),
        marker: existsSync(markerFile) ? JSON.parse(readFileSync(markerFile, "utf8")) : null,
        localProjects: next.service.localProjects().map(({ projectId, role, revoked }) => ({ projectId, role, revoked })),
      });
      assert.ok(result.status !== 200 || access?.status === 200, "skipping uploaded files cannot skip authorization of the persisted project identity");
      if (result.status !== 200) assert.equal(existsSync(planFile), true, "a refused resume retains the previous account's checkpoint");
    });

    await scenario("control: concurrent collaborative creates retain both documents through collision layout", async (peer) => {
      let delay = false;
      let started = false;
      let release = () => {};
      const gate = new Promise((resolve) => { release = resolve; });
      const owner = await peer(ownerAuth, { fetch: async (url, init) => {
        if (delay && init.method === "POST" && url.endsWith("/documents")) { started = true; await gate; }
        return fetch(url, init);
      } });
      const root = path.join(owner.library, "ConcurrentCreate");
      writeTree(root, { "baseline.md": "baseline\n" });
      const shared = await owner.service.share({ notebook: "ConcurrentCreate" });
      const project = owner.service.project(shared.projectId);
      await project.whenIdle();
      const library = path.join(temp.dir, "concurrent-cloud-copy");
      mkdirSync(library);
      cpSync(root, path.join(library, "ConcurrentCreate"), { recursive: true });
      const twin = await peer(ownerAuth, { library });
      await until(() => twin.service.project(shared.projectId)?.manifestReady(), "collision peer's authoritative manifest loads");
      delay = true;
      const creating = owner.service.fileOp(shared.projectId, { op: "create-file", path: "same.md", content: "from first\n" });
      try {
        await until(() => started, "first creation held");
        await twin.service.fileOp(shared.projectId, { op: "create-file", path: "same.md", content: "from second\n" });
        release();
        await creating;
        await until(() => project.isMaterialized(), "both documents placed");
        await project.whenIdle();
        const hub = owner.host.acquire(project.info.manifestDocId);
        try {
          const entries = [...hub.getDoc("manifest").getMap(ManifestKeys.files).values()].filter((entry) => entry.path === "same.md");
          const disk = readdirSync(root).filter((name) => /^same(?: \(2\))?\.md$/.test(name)).map((name) => readFileSync(path.join(root, name), "utf8")).sort();
          observe("concurrent-create-control", { liveDocuments: entries.length, disk });
          assert.equal(new Set(entries.map((entry) => entry.docId)).size, 2);
          assert.deepEqual(disk, ["from first\n", "from second\n"]);
        } finally { owner.host.release(hub.docId); }
      } finally { delay = false; release(); await creating.catch(() => {}); }
    });
  } finally { await server.stop(); removeDataDir(server.dataDir); temp.cleanup(); }
});
