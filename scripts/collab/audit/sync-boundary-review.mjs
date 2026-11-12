// Review reproductions: assertions describe the required matrix behavior.
// All data, accounts, and servers are disposable; no application data is used.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { CollabRuntime } from "../../../electron/collab/control/runtime.ts";
import { sha256 } from "../../../electron/collab/notebooks/fs-ops.ts";
import { ContentKeys, ManifestKeys } from "../../../src/lib/collab/protocol/schema.ts";
import { api, closePeer, intermittent, makePeer, register, sleep, tempRoot, until, writeTree } from "../support/notebooks-harness.ts";
import { removeDataDir, startServerProcess } from "../support/server-process.ts";

const observe = (name, value) => console.log(`BOUNDARY ${name} ${JSON.stringify(value)}`);

function entries(peer, projectId) {
  const hub = peer.host.acquire(peer.service.project(projectId).info.manifestDocId);
  try { return [...hub.getDoc("manifest").getMap(ManifestKeys.files).values()]; }
  finally { peer.host.release(hub.docId); }
}

async function acknowledged(peer, docId) {
  const hub = peer.host.acquire(docId);
  try { await until(() => hub.pendingCount === 0, "server acknowledgement"); }
  finally { peer.host.release(docId); }
}

function pauseDisk(project) {
  project.watcher?.close();
  project.watcher = null;
  if (project.pollTimer) clearInterval(project.pollTimer);
  project.pollTimer = null;
  if (project.scanTimer) clearTimeout(project.scanTimer);
  project.scanTimer = null;
}

test("sync boundary review", { timeout: 120_000 }, async (t) => {
  const temp = tempRoot("libera-boundary-review-");
  const server = await startServerProcess();
  let serial = 0;
  try {
    const auth = await register(server, "BoundaryOwner");
    async function scenario(name, body) {
      await t.test(name, { timeout: 30_000 }, async () => {
        const peers = [];
        const peer = async (options = {}) => {
          const result = await makePeer(temp.dir, `boundary-${++serial}`, server, auth, options);
          peers.push(result);
          return result;
        };
        try { await body(peer); }
        finally { for (const value of peers.reverse()) await closePeer(value); }
      });
    }

    await scenario("a late cloud copy cannot recreate a shared-deleted file after restart", async (peer) => {
      const owner = await peer();
      const root = path.join(owner.library, "LateCopy");
      writeTree(root, { "note.md": "deleted shared content\n" });
      const shared = await owner.service.share({ notebook: "LateCopy" });
      await owner.service.project(shared.projectId).whenIdle();
      const oldDocId = owner.service.resolvePath("LateCopy/note.md").docId;
      const cloudRoot = path.join(temp.dir, "late-cloud-copy");
      cpSync(root, cloudRoot, { recursive: true });
      await owner.service.fileOp(shared.projectId, { op: "delete", path: "note.md" });
      await acknowledged(owner, owner.service.project(shared.projectId).info.manifestDocId);
      await owner.service.stop();
      await owner.service.start();
      const project = owner.service.project(shared.projectId);
      await project.whenIdle();
      pauseDisk(project);
      assert.equal(entries(owner, shared.projectId).length, 0);
      // Independent cloud delivery arrives after the authoritative deletion.
      cpSync(path.join(cloudRoot, "note.md"), path.join(root, "note.md"));
      await project.enqueue(() => project.scan());
      await acknowledged(owner, project.info.manifestDocId);
      const current = entries(owner, shared.projectId);
      observe("late-deleted-file", {
        oldDocId,
        oldDocumentStatus: (await api(server, `/v1/documents/${oldDocId}`, undefined, auth.accessToken)).status,
        current: current.map(({ fileId, docId, path }) => ({ fileId, docId, path })),
        newDocumentStatus: current[0]?.docId ? (await api(server, `/v1/documents/${current[0].docId}`, undefined, auth.accessToken)).status : null,
        archiveExists: existsSync(path.join(root, "_archive/note.md")),
      });
      assert.equal(current.some((entry) => entry.path === "note.md"), false, "late cloud bytes need recovery/intent, not automatic shared creation");
    });

    await scenario("an inferred rename waiting on another upload cannot resurrect a remotely deleted blob", async (peer) => {
      let delayed = false;
      let started = false;
      let release = () => {};
      const gate = new Promise((resolve) => { release = resolve; });
      const owner = await peer({ fetch: async (url, init) => {
        if (delayed && init.method === "PUT" && url.includes("/blobs/")) { started = true; await gate; }
        return fetch(url, init);
      } });
      const root = path.join(owner.library, "ScanRename");
      writeTree(root, { "image.png": Buffer.from([1, 2, 3, 4]) });
      const shared = await owner.service.share({ notebook: "ScanRename" });
      const project = owner.service.project(shared.projectId);
      await project.whenIdle();
      pauseDisk(project);
      const library = path.join(temp.dir, "rename-cloud-copy");
      mkdirSync(library);
      cpSync(root, path.join(library, "ScanRename"), { recursive: true });
      const twin = await peer({ library });
      await until(() => entries(twin, shared.projectId).length === 1, "follower manifest");
      const originalId = entries(owner, shared.projectId)[0].fileId;
      renameSync(path.join(root, "image.png"), path.join(root, "renamed.png"));
      writeFileSync(path.join(root, "new.png"), Buffer.from([9, 8, 7, 6]));
      // A new file is shared once it has been quiet (Timings.importQuietMs, 300 ms in the harness):
      // wait it out, so the rename and the new file's upload are in the same scan.
      await sleep(400);
      delayed = true;
      const scanning = project.enqueue(() => project.scan());
      try {
        await until(() => started, "unrelated new-file upload");
        await twin.service.fileOp(shared.projectId, { op: "delete", path: "image.png" });
        await until(() => entries(owner, shared.projectId).every((entry) => entry.fileId !== originalId), "remote delete reaches scanning host");
        release();
        await scanning;
        await acknowledged(owner, project.info.manifestDocId);
        await until(() => entries(twin, shared.projectId).some((entry) => entry.path === "new.png"), "scan reaches server and follower");
        const current = entries(twin, shared.projectId);
        observe("scan-rename-delete", { originalId, current: current.map(({ fileId, path }) => ({ fileId, path })) });
        assert.equal(current.some((entry) => entry.fileId === originalId), false, "a disk-scan snapshot must not reinsert an entry deleted during its await");
      } finally { delayed = false; release(); await scanning.catch(() => {}); }
    });

    await scenario("a hanging lease response cannot block account changes indefinitely", async (peer) => {
      let hold = false;
      let started = false;
      let suppliedSignal = false;
      let release = () => {};
      const gate = new Promise((resolve) => { release = resolve; });
      const owner = await peer({ fetch: async (url, init) => {
        if (hold && init.method === "POST" && url.includes("/folder-lease")) {
          started = true;
          suppliedSignal = init.signal != null;
          // Like native fetch, the delayed transport honors cancellation if
          // the client supplies it. The current client supplies no signal.
          await new Promise((resolve, reject) => {
            const abort = () => reject(init.signal?.reason ?? new Error("Request aborted"));
            if (init.signal?.aborted) { abort(); return; }
            init.signal?.addEventListener("abort", abort, { once: true });
            void gate.then(() => {
              init.signal?.removeEventListener("abort", abort);
              resolve();
            });
          });
        }
        return fetch(url, init);
      } });
      writeTree(path.join(owner.library, "HangingLease"), { "note.md": "durable\n" });
      await owner.service.share({ notebook: "HangingLease" });
      hold = true;
      const ticking = owner.service.tick();
      let changing;
      try {
        await until(() => started, "pending lease HTTP response");
        let completed = false;
        changing = owner.service.beforeAccountChange().then(() => { completed = true; });
        await sleep(600);
        observe("lease-account-change", { completedWhileHttpHangs: completed, requestHasAbortSignal: suppliedSignal });
        assert.equal(completed, true, "account changes must cancel the pending background lease request");
      } finally {
        hold = false;
        release();
        await ticking;
        await changing;
      }
    });

    await scenario("a binary edit arriving during download is preserved before replacement", async (peer) => {
      let delay = false;
      let started = false;
      let release = () => {};
      const gate = new Promise((resolve) => { release = resolve; });
      const owner = await peer({ fetch: async (url, init) => {
        if (delay && init.method === "GET" && url.includes("/blobs/")) { started = true; await gate; }
        return fetch(url, init);
      } });
      const root = path.join(owner.library, "DownloadEdit");
      const original = Buffer.from([1, 2, 3, 4]);
      const replacement = Buffer.from([5, 6, 7, 8]);
      const external = Buffer.from([9, 10, 11, 12]);
      writeTree(root, { "image.png": original });
      const shared = await owner.service.share({ notebook: "DownloadEdit" });
      const project = owner.service.project(shared.projectId);
      await project.whenIdle();
      pauseDisk(project);
      const library = path.join(temp.dir, "download-cloud-copy");
      mkdirSync(library);
      cpSync(root, path.join(library, "DownloadEdit"), { recursive: true });
      const twin = await peer({ library });
      await until(() => entries(twin, shared.projectId).length === 1, "follower manifest");
      delay = true;
      try {
        await twin.service.fileOp(shared.projectId, { op: "write-blob", path: "image.png", contentBase64: replacement.toString("base64") });
        await until(() => started, "new blob download on writer");
        writeFileSync(path.join(root, "image.png"), external);
        release();
        await project.whenIdle();
        const archive = path.join(root, "_archive/image.png");
        const archived = existsSync(archive) ? readFileSync(archive) : null;
        observe("external-edit-during-download", {
          disk: [...readFileSync(path.join(root, "image.png"))],
          archived: archived ? [...archived] : null,
          expectedExternal: [...external],
        });
        assert.ok(archived?.equals(external), "download commit must reread/preserve the external bytes that arrived during its await");
      } finally { delay = false; release(); }
    });
  } finally {
    await server.stop();
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});

test("matching account IDs on separate servers do not reuse local sync authority", { timeout: 90_000, skip: intermittent }, async () => {
  const temp = tempRoot("libera-server-identity-review-");
  const seed = await startServerProcess();
  let serverA;
  let serverB;
  let runtime;
  const replicaData = path.join(temp.dir, "server-b");
  try {
    const seedAuth = await register(seed, "ServerIdentityOwner");
    await seed.stop();
    serverA = await startServerProcess({ dataDir: seed.dataDir });
    const credentials = { email: seedAuth.account.email, password: "correct horse battery" };
    const authA = await api(serverA, "/v1/auth/login", credentials);
    assert.equal(authA.status, 200);
    const library = path.join(temp.dir, "library", "users", "admin");
    mkdirSync(library, { recursive: true });
    runtime = new CollabRuntime({
      collabDir: path.join(temp.dir, "runtime"), libraryRoot: library,
      installationId: "inst_boundary_server", appVersion: "test", emit() {},
      host: { compaction: false }, logger: { warn() {}, error() {} },
      secrets: { encrypt: async (value) => `test:${Buffer.from(value).toString("base64")}`,
        decrypt: async (value) => Buffer.from(value.slice(5), "base64").toString() },
    });
    await runtime.start();
    await runtime.signedIn(serverA.url, authA.body);
    const root = path.join(library, "ServerBound");
    writeTree(root, { "note.md": "common " });
    const shared = await runtime.notebooks.share({ notebook: "ServerBound" });
    await runtime.notebooks.project(shared.projectId).whenIdle();
    const docId = runtime.notebooks.resolvePath("ServerBound/note.md").docId;
    const seedHub = runtime.host.acquire(docId);
    try {
      seedHub.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(7, "baseline\n"), { source: "typing" });
      await until(() => seedHub.pendingCount === 0, "pre-backup edit acknowledged");
    } finally { runtime.host.release(docId); }
    // A legitimate backup preserves account/document IDs, but each server is
    // now a separate authority. Only A subsequently receives the private edit.
    const serverAPort = serverA.port;
    await serverA.stop();
    cpSync(seed.dataDir, replicaData, { recursive: true });
    serverA = await startServerProcess({ dataDir: seed.dataDir, port: serverAPort });
    serverB = await startServerProcess({ dataDir: replicaData });
    const authB = await api(serverB, "/v1/auth/login", credentials);
    assert.equal(authB.status, 200);
    assert.equal(authA.body.account.id, authB.body.account.id);
    runtime.nudge();
    const hub = runtime.host.acquire(docId);
    try {
      hub.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, "private on A\n"), { source: "typing" });
      await until(() => hub.pendingCount === 0, "A-only edit acknowledged");
    } finally { runtime.host.release(docId); }
    const digestRoute = `/v1/documents/${docId}/digest`;
    const baseline = (await api(serverB, digestRoute, undefined, authB.body.accessToken)).body.contentSha256;
    assert.equal(baseline, sha256(Buffer.from("common baseline\n")));
    const databaseA = runtime.host.store.path;
    const markerBefore = readFileSync(path.join(root, ".libera-shared.json"), "utf8");
    await runtime.signedIn(serverB.url, authB.body);
    const databaseB = runtime.host.store.path;
    await sleep(1200);
    const markerFile = path.join(root, ".libera-shared.json");
    const observed = {
      databaseReused: databaseA === databaseB,
      markerUnchanged: existsSync(markerFile) && readFileSync(markerFile, "utf8") === markerBefore,
      originalProjectStatus: (await api(serverA, `/v1/projects/${shared.projectId}`, undefined, seedAuth.accessToken)).status,
      switchedServerProjectStatus: (await api(serverB, `/v1/projects/${shared.projectId}`, undefined, authB.body.accessToken)).status,
      serverBBaselineDigest: baseline,
      serverBDigestAfterSwitch: (await api(serverB, digestRoute, undefined, authB.body.accessToken)).body.contentSha256,
      privateEditDigest: sha256(Buffer.from("private on A\ncommon baseline\n")),
      localProjects: runtime.notebooks.localProjects().map(({ projectId, revoked }) => ({ projectId, revoked })),
    };
    observe("same-id-different-server", observed);
    assert.equal(observed.serverBDigestAfterSwitch, baseline, "signing into B must not publish acknowledged A-only edits into B");
    assert.equal(observed.markerUnchanged, true, "server B's not-found response must not detach server A's live working folder");
    assert.notEqual(databaseA, databaseB, "database and outbound queues must include server identity");
    // A backup includes prior client sequence numbers. Fresh B state must
    // use a distinct client namespace, while returning to A resumes A's own.
    const bHub = runtime.host.acquire(docId, { projectId: shared.projectId });
    try {
      await until(() => bHub.getStatus().connected && bHub.getText("content") === "common baseline\n", "B baseline opened");
      bHub.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, "only on B\n"), { source: "typing" });
      await until(() => bHub.pendingCount === 0, "fresh B edit acknowledged");
      assert.equal((await api(serverB, digestRoute, undefined, authB.body.accessToken)).body.contentSha256, sha256(Buffer.from("only on B\ncommon baseline\n")));
    } finally { runtime.host.release(docId); }
    const returning = await api(serverA, "/v1/auth/login", credentials);
    assert.equal(returning.status, 200);
    await runtime.signedIn(serverA.url, returning.body);
    assert.equal(runtime.host.store.path, databaseA);
    assert.equal((await api(serverA, digestRoute, undefined, returning.body.accessToken)).body.contentSha256, observed.privateEditDigest);
  } finally {
    if (runtime) await runtime.stop();
    if (serverB) await serverB.stop();
    if (serverA) await serverA.stop();
    await seed.stop();
    removeDataDir(seed.dataDir);
    temp.cleanup();
  }
});
