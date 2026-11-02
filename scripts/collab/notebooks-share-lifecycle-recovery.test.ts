import assert from "node:assert/strict";
import { cpSync, existsSync, promises as fs, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { FetchLike } from "../../electron/collab/core";
import { contentGuard, sha256, writeFileAtomic, WriteCancelledError } from "../../electron/collab/notebooks/fs-ops";
import type { SharePlan } from "../../electron/collab/notebooks/state";
import { ControlRoutes } from "../../src/lib/collab/local-api";
import type { AuthResponse, ProjectSummary } from "../../src/lib/collab/protocol/api";
import { ContentKeys } from "../../src/lib/collab/protocol/schema";
import { api, closePeer, intermittent, makePeer, register, tempRoot, until, writeTree, type Peer, type PeerOptions } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

test("a busy text destination is rechecked before retrying its rename", async () => {
  const temp = tempRoot("libera-text-content-retry-");
  const target = path.join(temp.dir, "note.md");
  const rename = fs.rename;
  let attempts = 0;
  try {
    writeFileSync(target, "observed\n");
    fs.rename = async (from, to) => {
      if (to === target) {
        attempts += 1;
        writeFileSync(target, "late external bytes\n");
        throw Object.assign(new Error("injected sharing violation"), { code: "EBUSY" });
      }
      return rename(from, to);
    };
    await assert.rejects(writeFileAtomic(target, Buffer.from("shared text\n"), contentGuard(target,
      sha256(Buffer.from("observed\n")), { root: temp.dir, canCommit: async () => true })), WriteCancelledError);
    assert.equal(attempts, 1);
    assert.equal(readFileSync(target, "utf8"), "late external bytes\n");
    assert.deepEqual(readdirSync(temp.dir), ["note.md"], "temporary output is cleaned up");
  } finally { fs.rename = rename; temp.cleanup(); }
});

test("share checkpoint recovery boundaries", { timeout: 150_000 }, async (t) => {
  const temp = tempRoot("libera-share-recovery-");
  const server = await startServerProcess();
  const peers = new Set<Peer>();
  let serial = 0;
  try {
    const owner = await register(server, "ShareRecoveryOwner");
    const other = await register(server, "ShareRecoveryOther");
    const peer = async (auth = owner, options: PeerOptions = {}) => {
      const value = await makePeer(temp.dir, `recovery-${++serial}`, server, auth, options);
      peers.add(value);
      return value;
    };
    const close = async (value: Peer) => { await closePeer(value); peers.delete(value); };
    const pendingPath = (root: string) => path.join(root, ".libera-share-pending.json");
    const readPlan = (root: string): SharePlan => JSON.parse(readFileSync(pendingPath(root), "utf8"));
    const refuseLookup: FetchLike = async (url, init) => init.method === "GET" && /\/v1\/projects\/[^/]+$/.test(new URL(url).pathname)
      ? Response.json({ error: { code: "not-found", message: "injected interruption before publication" } }, { status: 404 })
      : fetch(url, init);

    await t.test("an older server cannot start an ambiguous project; upgrading resumes the saved key", async () => {
      let old = true;
      let creates = 0;
      const value = await peer(owner, { fetch: async (url, init) => {
        if (new URL(url).pathname === "/v1/version" && old) return Response.json({ protocolVersion: 1 });
        if (init.method === "POST" && new URL(url).pathname === "/v1/projects") creates += 1;
        return fetch(url, init);
      } });
      const root = path.join(value.library, "Upgrade");
      writeTree(root, { "note.md": "private new share\n" });
      const refused = await value.router.call("POST", ControlRoutes.share, { notebook: "Upgrade" });
      assert.equal(refused.status, 409);
      assert.equal(creates, 0);
      const plan = readPlan(root);
      assert.equal(plan.accountId, owner.account.id);
      assert.equal(plan.serverUrl, server.url);
      assert.ok(plan.operationId);
      const recovery = path.join(value.service.lifecycleDirectory, "share-attempts", `${plan.operationId}.json`);
      assert.equal(JSON.parse(readFileSync(recovery, "utf8")).plan.operationId, plan.operationId);
      const renamed = await value.router.call("POST", ControlRoutes.share, { notebook: "Upgrade", name: "Changed" });
      assert.equal(renamed.status, 409);
      assert.equal(readPlan(root).name, "Upgrade");
      old = false;
      const result = await value.router.call("POST", ControlRoutes.share, { notebook: "Upgrade" });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(creates, 1);
      assert.equal(existsSync(pendingPath(root)), false);
      assert.equal(existsSync(recovery), false);
      await close(value);
    });

    await t.test("legacy uploaded plans require fresh ownership and matching manifest before they can be bound", async () => {
      const original = await peer(owner, { fetch: refuseLookup });
      const root = path.join(original.library, "Legacy");
      writeTree(root, { "note.md": "uploaded legacy input\n" });
      await assert.rejects(original.service.share({ notebook: "Legacy" }));
      const plan = readPlan(root);
      assert.ok(plan.projectId);
      assert.equal(plan.files.every((file) => file.uploaded), true);
      delete plan.operationId; delete plan.accountId; delete plan.serverUrl; delete plan.kind;
      writeFileSync(pendingPath(root), JSON.stringify(plan));
      await close(original);
      const unchanged = readFileSync(pendingPath(root));
      const wrong = await peer(other, { library: original.library });
      const denied = await wrong.router.call("POST", ControlRoutes.share, { notebook: "Legacy" });
      assert.equal(denied.status, 404);
      assert.deepEqual(readFileSync(pendingPath(root)), unchanged);
      assert.equal(existsSync(path.join(root, ".libera-shared.json")), false);
      await close(wrong);
      const resumed = await peer(owner, { library: original.library });
      writeFileSync(pendingPath(root), JSON.stringify({ ...plan, manifestDocId: "doc_wrong_manifest" }));
      const mismatch = readFileSync(pendingPath(root));
      assert.equal((await resumed.router.call("POST", ControlRoutes.share, { notebook: "Legacy" })).status, 409);
      assert.deepEqual(readFileSync(pendingPath(root)), mismatch);
      writeFileSync(pendingPath(root), unchanged);
      const completed = await resumed.service.share({ notebook: "Legacy" });
      assert.equal(completed.projectId, plan.projectId);
      assert.equal(completed.synced, true);
      assert.equal(readFileSync(path.join(root, "note.md"), "utf8"), "uploaded legacy input\n");
      await close(resumed);
    });

    await t.test("foreign-server and malformed operation identities leave a checkpoint byte-for-byte intact", async () => {
      const value = await peer(owner, { fetch: refuseLookup });
      const root = path.join(value.library, "Authority");
      writeTree(root, { "note.md": "authority input\n" });
      await assert.rejects(value.service.share({ notebook: "Authority" }));
      const plan = readPlan(root);
      for (const changed of [{ ...plan, serverUrl: "https://other.example.test" }, { ...plan, operationId: "../../outside-checkpoint" }]) {
        writeFileSync(pendingPath(root), JSON.stringify(changed));
        const before = readFileSync(pendingPath(root));
        assert.equal((await value.router.call("POST", ControlRoutes.share, { notebook: "Authority" })).status, 409);
        assert.deepEqual(readFileSync(pendingPath(root)), before);
      }
      assert.equal(existsSync(path.join(root, ".libera-shared.json")), false);
      await close(value);
    });

    await t.test("a removed cloud root has a profile recovery checkpoint that resumes the same project", async () => {
      let remove = true;
      let root = "";
      const value = await peer(owner, { fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (remove && init.method === "PUT" && url.includes("/blobs/")) {
          remove = false; rmSync(root, { recursive: true, force: true });
        }
        return response;
      } });
      root = path.join(value.library, "Removed");
      const files = { "note.md": "recover input\n", "image.png": Buffer.from([1, 2, 3, 4]) };
      writeTree(root, files);
      assert.equal((await value.router.call("POST", ControlRoutes.share, { notebook: "Removed" })).status, 409);
      assert.equal(existsSync(root), false);
      const directory = path.join(value.service.lifecycleDirectory, "share-attempts");
      const recovery = readdirSync(directory).filter((file) => file.endsWith(".json")).map((file) =>
        JSON.parse(readFileSync(path.join(directory, file), "utf8")) as { root: string; plan: SharePlan }).find((entry) => entry.root === root)!;
      assert.equal(recovery.root, root);
      assert.ok(recovery.plan.projectId);
      assert.equal(recovery.plan.files.every((file) => file.uploaded), true);
      writeTree(root, files);
      writeFileSync(pendingPath(root), JSON.stringify(recovery.plan));
      const completed = await value.service.share({ notebook: "Removed" });
      assert.equal(completed.projectId, recovery.plan.projectId);
      assert.equal(existsSync(path.join(directory, `${recovery.plan.operationId}.json`)), false);
      await close(value);
    });

    await t.test("changing accounts during the final authority check cannot publish the old account's share", async () => {
      let changed = false;
      const nextAccount = (auth: AuthResponse) => ({ accountId: auth.account.id, serverUrl: server.url,
        tokenProvider: { getAccessToken: async () => auth.accessToken, refresh: async () => null } });
      const value: Peer = await peer(owner, { fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (!changed && init.method === "GET" && /\/v1\/projects\/[^/]+$/.test(new URL(url).pathname)) {
          changed = true; value.host.setAccount(nextAccount(other));
        }
        return response;
      } });
      const root = path.join(value.library, "Switch");
      writeTree(root, { "note.md": "old account input\n" });
      assert.equal((await value.router.call("POST", ControlRoutes.share, { notebook: "Switch" })).status, 409);
      assert.equal(changed, true);
      assert.equal(readPlan(root).accountId, owner.account.id);
      assert.equal(existsSync(path.join(root, ".libera-shared.json")), false);
      assert.deepEqual(value.service.localProjects(), []);
      await close(value);
    });

    await t.test("two devices resuming one checkpoint use one project identity and one writer lease", async () => {
      let upgrade = false;
      const first = await peer(owner, { fetch: async (url, init) => {
        if (!upgrade && new URL(url).pathname === "/v1/version") return Response.json({ protocolVersion: 1 });
        return fetch(url, init);
      } });
      const root = path.join(first.library, "Copied");
      writeTree(root, { "note.md": "copied checkpoint\n" });
      await assert.rejects(first.service.share({ notebook: "Copied" }));
      const second = await peer();
      const secondRoot = path.join(second.library, "Copied");
      cpSync(root, secondRoot, { recursive: true });
      upgrade = true;
      const [a, b] = await Promise.all([first.service.share({ notebook: "Copied" }), second.service.share({ notebook: "Copied" })]);
      assert.equal(a.projectId, b.projectId);
      const markers = [root, secondRoot].map((folder) => JSON.parse(readFileSync(path.join(folder, ".libera-shared.json"), "utf8")));
      assert.equal(markers[0].folderId, markers[1].folderId);
      assert.equal([first, second].filter((device) => !device.service.project(a.projectId)!.info.follower).length, 1);
      const listed = await api<ProjectSummary[]>(server, "/v1/projects", undefined, owner.accessToken);
      assert.equal(listed.body.filter((project) => project.id === a.projectId).length, 1);
      await close(first); await close(second);
    });

    await t.test("terminal text preservation keeps a late external edit and archives the latest shared text", { skip: intermittent }, async () => {
      const value = await peer();
      const root = path.join(value.library, "Terminal");
      writeTree(root, { "note.md": "base\n" });
      const shared = await value.service.share({ notebook: "Terminal" });
      const project = value.service.project(shared.projectId)!;
      await project.whenIdle();
      const docId = value.service.resolvePath("Terminal/note.md")!.docId;
      const hub = value.host.acquire(docId);
      const write = fs.writeFile;
      let arrived = false;
      try {
        fs.writeFile = async (target, ...args) => {
          if (!arrived && path.dirname(String(target)) === root && path.basename(String(target)).startsWith(".libera-tmp-")) {
            arrived = true; writeFileSync(path.join(root, "note.md"), "late terminal input\n");
          }
          return write(target, ...args);
        };
        hub.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, "latest shared\n"), { source: "typing" });
        await project.stop({ preserveContent: true });
        assert.equal(arrived, true);
        assert.equal(readFileSync(path.join(root, "note.md"), "utf8"), "late terminal input\n");
        assert.ok(readdirSync(path.join(root, "_archive")).some((file) => readFileSync(path.join(root, "_archive", file), "utf8") === "latest shared\nbase\n"));
      } finally { fs.writeFile = write; value.host.release(docId); }
      await close(value);
    });

    await t.test("a disk change during merge resolution retains the chosen shared text and the new disk input", async () => {
      const value = await peer(owner, { timings: { writeDebounceMs: 500, pollMs: 50 } });
      const root = path.join(value.library, "Merge");
      writeTree(root, { "note.md": "base\n" });
      const shared = await value.service.share({ notebook: "Merge" });
      const project = value.service.project(shared.projectId)!;
      await project.whenIdle();
      const docId = value.service.resolvePath("Merge/note.md")!.docId;
      const hub = value.host.acquire(docId);
      const write = fs.writeFile;
      let arrived = false;
      try {
        hub.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, "remote\n"), { source: "typing" });
        writeFileSync(path.join(root, "note.md"), "initial external\n");
        await until(async () => (await project.reconciliations()).length > 0, "merge reconciliation");
        const [item] = await project.reconciliations();
        fs.writeFile = async (target, ...args) => {
          if (!arrived && path.dirname(String(target)) === root && path.basename(String(target)).startsWith(".libera-tmp-")) {
            arrived = true; writeFileSync(path.join(root, "note.md"), "new disk input during merge\n");
          }
          return write(target, ...args);
        };
        await assert.rejects(project.resolveReconciliation(item.id, "chosen merge\n"), (error: { status?: number }) => error.status === 409);
        assert.equal(arrived, true);
        assert.equal(hub.getText("content"), "chosen merge\n");
        assert.equal(readFileSync(path.join(root, "note.md"), "utf8"), "new disk input during merge\n");
        await until(async () => (await project.reconciliations()).some((entry) => entry.disk === "new disk input during merge\n"), "new disk input retained for reconciliation");
      } finally { fs.writeFile = write; value.host.release(docId); }
      await close(value);
    });
  } finally {
    for (const value of peers) await closePeer(value);
    await server.stop(); removeDataDir(server.dataDir); temp.cleanup();
  }
});
