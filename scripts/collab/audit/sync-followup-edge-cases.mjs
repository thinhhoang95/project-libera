// Follow-up regressions, 2026-11-01; also run by the normal collab suite.
// All libraries, accounts and servers are disposable fixtures.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, promises as fs, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { CollabRuntime } from "../../../electron/collab/control/runtime.ts";
import { walkNotebook, sha256 } from "../../../electron/collab/notebooks/fs-ops.ts";
import { ControlRoutes } from "../../../src/lib/collab/local-api.ts";
import { ApiRoutes } from "../../../src/lib/collab/protocol/api.ts";
import { ContentKeys, ManifestKeys } from "../../../src/lib/collab/protocol/schema.ts";
import { api, closePeer, invite, makePeer, readText, register, sleep, tempRoot, until, writeTree } from "../support/notebooks-harness.ts";
import { removeDataDir, startServerProcess } from "../support/server-process.ts";

const MARKER = ".libera-shared.json";
const markerAt = (root) => JSON.parse(readFileSync(path.join(root, MARKER), "utf8"));
const stateAt = (root) => JSON.parse(readFileSync(path.join(root, ".libera/collab/state.json"), "utf8"));
const observe = (name, value) => console.log(`FOLLOWUP ${name} ${JSON.stringify(value)}`);

function textOf(peer, file) {
  const resolved = peer.service.resolvePath(file);
  if (!resolved) return null;
  const hub = peer.host.acquire(resolved.docId);
  try { return hub.getText("content"); }
  finally { peer.host.release(resolved.docId); }
}

function manifestOf(peer, id) {
  const runtime = peer.service.project(id);
  const hub = peer.host.acquire(runtime.info.manifestDocId);
  try { return [...hub.getDoc("manifest").getMap(ManifestKeys.files).values()]; }
  finally { peer.host.release(hub.docId); }
}

async function acked(peer, docId) {
  const hub = peer.host.acquire(docId);
  try { await until(() => hub.pendingCount === 0, "server acknowledgement"); }
  finally { peer.host.release(docId); }
}

async function share(peer, name, files) {
  writeTree(path.join(peer.library, name), files);
  const result = await peer.router.call("POST", ControlRoutes.share, { notebook: name });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  await peer.service.project(result.body.projectId).whenIdle();
  return result.body.projectId;
}

function account(auth, server) {
  return { accountId: auth.account.id, serverUrl: server.url, tokenProvider: {
    getAccessToken: async () => auth.accessToken, refresh: async () => null,
  } };
}

test("remaining notebook sync interactions", { timeout: 300_000 }, async (t) => {
  const temp = tempRoot("libera-followup-audit-");
  const server = await startServerProcess();
  const ownerAuth = await register(server, "FollowupOwner");
  const memberAuth = await register(server, "FollowupMember");
  let serial = 0;
  async function review(name, body) {
    await t.test(name, { timeout: 60_000 }, async () => {
      const peers = [];
      const peer = async (label, auth = ownerAuth, options = {}) => {
        const value = await makePeer(temp.dir, `${++serial}-${label}`, server, auth, options);
        peers.push(value);
        return value;
      };
      try { await body(peer); }
      finally { for (const value of peers.reverse()) await closePeer(value).catch(() => {}); }
    });
  }
  try {
    await review("an expired writer cannot infer shared deletion after another cloud root takes over", async (peer) => {
      let denyLease = false;
      const old = await peer("partition-old", ownerAuth, { leaseTtlMs: 900, fetch: async (url, init) => {
        if (denyLease && url.includes("/folder-lease")) throw new Error("simulated lease endpoint partition");
        return fetch(url, init);
      } });
      const id = await share(old, "Partition", { "note.md": "must remain shared\n" });
      const oldRoot = path.join(old.library, "Partition");
      const library = path.join(temp.dir, "partition-copy");
      mkdirSync(library);
      const newRoot = path.join(library, "Partition");
      cpSync(oldRoot, newRoot, { recursive: true });
      const next = await peer("partition-next", ownerAuth, { library, leaseTtlMs: 900 });
      assert.equal(next.service.project(id).follower, true);
      denyLease = true;
      await until(() => next.service.project(id)?.follower === false, "new writer after lease expires");
      assert.equal(old.service.project(id).follower, true, "the old root stops automatic disk work when its lease expires");
      // Model a temporary absence delivered by the independent cloud client.
      // The new writer still has the file; there was no explicit shared delete.
      rmSync(path.join(oldRoot, "note.md"));
      await sleep(1500);
      await acked(old, old.service.project(id).info.manifestDocId);
      const observed = { oldWriter: !old.service.project(id).follower, newWriter: !next.service.project(id).follower,
        manifest: manifestOf(next, id).map((entry) => entry.path), nextDisk: readText(newRoot, "note.md"), archive: readText(newRoot, "_archive/note.md") };
      observe("split-writer", observed);
      assert.ok(observed.manifest.includes("note.md"), "uncertain old-root absence must not delete the live shared file");
    });

    await review("a capped walk must not delete an existing unvisited shared file", async (peer) => {
      const owner = await peer("walk-cap");
      const id = await share(owner, "ScanCap", { "a.md": "a\n", "b.md": "b\n", "z.md": "still exists\n" });
      const root = path.join(owner.library, "ScanCap");
      const runtime = owner.service.project(id);
      const docId = owner.service.resolvePath("ScanCap/z.md").docId;
      // Use the production walker with its public limit lowered from 50,000
      // to two; only the scale changes. No missing-file result is fabricated.
      runtime.walk = async () => walkNotebook(root, 2);
      const walk = await walkNotebook(root, 2);
      assert.equal(existsSync(path.join(root, "z.md")), true);
      await runtime.enqueue(() => runtime.scan());
      await sleep(900);
      await runtime.enqueue(() => runtime.scan());
      await acked(owner, runtime.info.manifestDocId);
      const observed = { visited: walk.entries.map((entry) => entry.relative), returnedFields: Object.keys(walk),
        manifest: manifestOf(owner, id).map((entry) => entry.path), disk: readText(root, "z.md"), archive: readText(root, "_archive/z.md"),
        serverDocumentStatus: (await api(server, ApiRoutes.document(docId), undefined, ownerAuth.accessToken)).status };
      observe("walk-cap", observed);
      assert.ok(observed.manifest.includes("z.md"), "a file omitted by the walk cap must not be tombstoned");
    });

    await review("a transient unreadable subtree must not look like a completed scan of deleted files", async (peer) => {
      const owner = await peer("subtree-scan");
      const id = await share(owner, "Subtree", { "nested/note.md": "not actually deleted\n" });
      const root = path.join(owner.library, "Subtree");
      const directory = path.join(root, "nested");
      const runtime = owner.service.project(id);
      const docId = owner.service.resolvePath("Subtree/nested/note.md").docId;
      const readdir = fs.readdir;
      let incomplete = true;
      fs.readdir = async function (target, ...options) {
        if (incomplete && target === directory) throw Object.assign(new Error("simulated transient network filesystem lookup"), { code: "ENOENT" });
        return readdir.call(this, target, ...options);
      };
      try {
        assert.equal(existsSync(path.join(directory, "note.md")), true);
        await runtime.enqueue(() => runtime.scan());
        await sleep(900);
        await runtime.enqueue(() => runtime.scan());
        await acked(owner, runtime.info.manifestDocId);
        const observed = { manifest: manifestOf(owner, id).map((entry) => entry.path),
          disk: readText(root, "nested/note.md"), archive: readText(root, "_archive/note.md"),
          serverDocumentStatus: (await api(server, ApiRoutes.document(docId), undefined, ownerAuth.accessToken)).status };
        observe("incomplete-subtree", observed);
        assert.ok(observed.manifest.includes("nested/note.md"), "incomplete subtree coverage must defer shared deletion");
      } finally { incomplete = false; fs.readdir = readdir; }
    });

    await review("one malformed layout record cannot prevent healthy notebooks from starting", async (peer) => {
      const owner = await peer("bad-state");
      await share(owner, "A-corrupt", { "a.md": "a\n" });
      const healthyId = await share(owner, "Z-healthy", { "z.md": "healthy\n" });
      await owner.service.stop();
      const root = path.join(owner.library, "A-corrupt");
      writeFileSync(path.join(root, ".libera/collab/state.json"), JSON.stringify({ version: 1, layout: { broken: null }, reconciliations: [] }));
      let failure = null;
      try { await owner.service.start(); } catch (error) { failure = error; }
      observe("malformed-state", { error: failure?.message, healthyRunning: !!owner.service.project(healthyId),
        started: owner.service.started, leasePolling: owner.service.leaseTimer !== null });
      assert.equal(failure, null, "reject/quarantine the corrupt state locally and continue starting other notebooks");
      assert.ok(owner.service.project(healthyId));
    });

    await review("a partially valid marker cannot abort adoption of the whole library", async (peer) => {
      const source = await peer("marker-source");
      const id = await share(source, "SharedSource", { "note.md": "healthy copy\n" });
      const target = await peer("marker-target");
      await target.service.stop();
      const brokenRoot = path.join(target.library, "A-broken");
      mkdirSync(brokenRoot);
      // Accepted by readMarker, but missing a string serverUrl.
      writeFileSync(path.join(brokenRoot, MARKER), JSON.stringify({ projectId: "prj_partial", manifestDocId: "doc_partial", accountId: ownerAuth.account.id }));
      cpSync(path.join(source.library, "SharedSource"), path.join(target.library, "Z-healthy"), { recursive: true });
      let failure = null;
      try { await target.service.start(); } catch (error) { failure = error; }
      observe("malformed-marker", { error: failure?.message, healthyAdopted: !!target.service.project(id),
        started: target.service.started, leasePolling: target.service.leaseTimer !== null });
      assert.equal(failure, null, "an invalid marker must not abort notebook service startup");
      assert.ok(target.service.project(id));
    });

    await review("an unreadable marker cannot silently enable direct storage writes into a known share", async (peer) => {
      const owner = await peer("marker-guard");
      const id = await share(owner, "Guarded", { "note.md": "live shared text\n" });
      const root = path.join(owner.library, "Guarded");
      const guard = await import("../../../src/lib/collab/shared-notebook.ts");
      const { updateMarkdownFile } = await import("../../../src/lib/storage/files.ts");
      const oldDataDir = process.env.LIBERA_DATA_DIR;
      const oldLifecycleDir = process.env.LIBERA_COLLAB_LIFECYCLE_DIR;
      process.env.LIBERA_DATA_DIR = path.resolve(owner.library, "../..");
      process.env.LIBERA_COLLAB_LIFECYCLE_DIR = owner.service.lifecycleDirectory;
      try {
        guard.invalidateSharedNotebookCache();
        assert.ok(guard.sharedNotebookMarker("Guarded"));
        writeFileSync(path.join(root, MARKER), '{"projectId":');
        guard.invalidateSharedNotebookCache();
        let failure = null;
        try { await updateMarkdownFile("Guarded/note.md", "bypassed collaboration\n"); }
        catch (error) { failure = error; }
        observe("corrupt-marker-write", { shared: textOf(owner, "Guarded/note.md"), disk: readText(root, "note.md"),
          storageError: failure?.message, runtimeStillKnown: !!owner.service.project(id) });
        assert.ok(guard.isSharedDocumentError(failure), "a present but unreadable share marker requires a guarded recovery state");
      } finally {
        if (oldDataDir === undefined) delete process.env.LIBERA_DATA_DIR;
        else process.env.LIBERA_DATA_DIR = oldDataDir;
        if (oldLifecycleDir === undefined) delete process.env.LIBERA_COLLAB_LIFECYCLE_DIR;
        else process.env.LIBERA_COLLAB_LIFECYCLE_DIR = oldLifecycleDir;
        guard.invalidateSharedNotebookCache();
      }
    });

    await review("stale bytes older than the eight-version history cannot silently roll back shared text", async (peer) => {
      const owner = await peer("old-history");
      const name = "History";
      const first = "version 0\n";
      const id = await share(owner, name, { "note.md": first });
      const root = path.join(owner.library, name);
      const target = path.join(root, "note.md");
      const firstMtime = statSync(target).mtimeMs;
      const docId = owner.service.resolvePath(`${name}/note.md`).docId;
      for (let version = 1; version <= 10; version += 1) {
        writeFileSync(target, `version ${version}\n`);
        await until(() => textOf(owner, `${name}/note.md`) === `version ${version}\n`, `version ${version} imported`);
        await acked(owner, docId);
      }
      await owner.service.project(id).whenIdle();
      const record = Object.values(stateAt(root).layout).find((item) => item.docId === docId);
      assert.equal(record.previous.length, 8);
      assert.ok(!record.previous.some((item) => item.hash === sha256(Buffer.from(first))));
      const staging = path.join(root, ".cloud-delivery");
      writeFileSync(staging, first);
      utimesSync(staging, firstMtime / 1000, firstMtime / 1000);
      renameSync(staging, target);
      await sleep(1200);
      await acked(owner, docId);
      const observed = { shared: textOf(owner, `${name}/note.md`), disk: readText(root, "note.md"),
        reconciliations: owner.service.project(id).reconcilePending, oldMtime: firstMtime, latestMtime: record.mtimeMs,
        serverDigest: (await api(server, ApiRoutes.documentDigest(docId), undefined, ownerAuth.accessToken)).body.contentSha256,
        staleDigest: sha256(Buffer.from(first)), currentDigest: sha256(Buffer.from("version 10\n")) };
      observe("history-eviction", observed);
      assert.ok(observed.shared === "version 10\n" || observed.reconciliations > 0, "uncertain old delivery must not become an acknowledged rollback");
    });

    await review("same-size writes with preserved coarse mtime must not remain silently unsynced", async (peer) => {
      const owner = await peer("coarse-time");
      const name = "CoarseTime";
      const root = path.join(owner.library, name);
      writeTree(root, { "note.md": "AAAA\n" });
      const target = path.join(root, "note.md");
      const oldTime = Math.floor((Date.now() - 20_000) / 2000) * 2000;
      utimesSync(target, oldTime / 1000, oldTime / 1000);
      const result = await owner.service.share({ notebook: name });
      const runtime = owner.service.project(result.projectId);
      await runtime.whenIdle();
      const before = statSync(target);
      writeFileSync(target, "BBBB\n");
      utimesSync(target, before.atimeMs / 1000, before.mtimeMs / 1000);
      assert.equal(statSync(target).mtimeMs, before.mtimeMs);
      await sleep(1500);
      observe("coarse-time", { shared: textOf(owner, `${name}/note.md`), disk: readText(root, "note.md"), reconciliations: runtime.reconcilePending });
      assert.ok(textOf(owner, `${name}/note.md`) === "BBBB\n" || runtime.reconcilePending > 0, "a real external overwrite needs import or reconciliation");
    });

    await review("an externally renamed cloud notebook can be rebound without joining a duplicate", async (peer) => {
      const owner = await peer("renamed-root");
      const id = await share(owner, "BeforeRename", { "note.md": "retain identity\n" });
      await owner.service.stop();
      const newRoot = path.join(owner.library, "AfterRename");
      renameSync(path.join(owner.library, "BeforeRename"), newRoot);
      await owner.service.start();
      await owner.service.tick();
      const observed = { projects: owner.service.localProjects(), row: owner.host.store.getProject(id),
        resolved: owner.service.resolvePath("AfterRename/note.md"), marker: markerAt(newRoot).projectId };
      observe("renamed-root", observed);
      assert.ok(observed.resolved, "a matching project/folder identity must not be suppressed by its stale stored path");
    });

    await review("a late old marker cannot relock a known taken-down notebook after sign-out", async (peer) => {
      const owner = await peer("late-marker");
      const id = await share(owner, "TakenDown", { "note.md": "now local\n" });
      const root = path.join(owner.library, "TakenDown");
      const oldMarker = readFileSync(path.join(root, MARKER));
      assert.equal((await owner.router.call("DELETE", ControlRoutes.project(id))).status, 204);
      assert.equal(existsSync(path.join(root, MARKER)), false);
      await owner.service.beforeAccountChange();
      owner.host.setAccount(null);
      await owner.service.accountChanged();
      writeFileSync(path.join(root, MARKER), oldMarker);
      await owner.service.tick();
      const guard = await import("../../../src/lib/collab/shared-notebook.ts");
      const { deleteNotebook } = await import("../../../src/lib/storage/notebooks.ts");
      const oldDataDir = process.env.LIBERA_DATA_DIR;
      const oldLifecycleDir = process.env.LIBERA_COLLAB_LIFECYCLE_DIR;
      process.env.LIBERA_DATA_DIR = path.resolve(owner.library, "../..");
      process.env.LIBERA_COLLAB_LIFECYCLE_DIR = owner.service.lifecycleDirectory;
      let failure = null;
      try {
        guard.invalidateSharedNotebookCache();
        try { await deleteNotebook("TakenDown"); } catch (error) { failure = error; }
      } finally {
        if (oldDataDir === undefined) delete process.env.LIBERA_DATA_DIR;
        else process.env.LIBERA_DATA_DIR = oldDataDir;
        if (oldLifecycleDir === undefined) delete process.env.LIBERA_COLLAB_LIFECYCLE_DIR;
        else process.env.LIBERA_COLLAB_LIFECYCLE_DIR = oldLifecycleDir;
        guard.invalidateSharedNotebookCache();
      }
      const observed = { markerRevoked: existsSync(path.join(root, MARKER)) ? markerAt(root).revoked ?? false : null,
        projects: owner.service.localProjects(), row: owner.host.store.getProject(id), deletionError: failure?.message };
      observe("late-marker", observed);
      assert.equal(failure, null, "confirmed local takedown must survive stale marker delivery without needing sign-in");
    });

    await review("a late old marker cannot relock a member copy already known to be revoked", async (peer) => {
      const owner = await peer("late-revocation-owner");
      const member = await peer("late-revocation-member", memberAuth);
      const id = await share(owner, "RevokedCopy", { "note.md": "local recovery\n" });
      const joined = await member.service.join({ invitation: await invite(server, ownerAuth, id, memberAuth.account.email) });
      const root = path.join(member.library, joined.notebook);
      const oldMarker = readFileSync(path.join(root, MARKER));
      assert.equal((await api(server, `/v1/projects/${id}/members/${memberAuth.account.id}`, undefined, ownerAuth.accessToken, "DELETE")).status, 204);
      await until(() => member.service.localProjects()[0]?.revoked === true, "confirmed member revocation");
      assert.equal(markerAt(root).revoked, true);
      writeFileSync(path.join(root, MARKER), oldMarker);
      await member.service.tick();
      const guard = await import("../../../src/lib/collab/shared-notebook.ts");
      const { deleteNotebook } = await import("../../../src/lib/storage/notebooks.ts");
      const oldDataDir = process.env.LIBERA_DATA_DIR;
      const oldLifecycleDir = process.env.LIBERA_COLLAB_LIFECYCLE_DIR;
      process.env.LIBERA_DATA_DIR = path.resolve(member.library, "../..");
      process.env.LIBERA_COLLAB_LIFECYCLE_DIR = member.service.lifecycleDirectory;
      let failure = null;
      try {
        guard.invalidateSharedNotebookCache();
        try { await deleteNotebook(joined.notebook); } catch (error) { failure = error; }
      } finally {
        if (oldDataDir === undefined) delete process.env.LIBERA_DATA_DIR;
        else process.env.LIBERA_DATA_DIR = oldDataDir;
        if (oldLifecycleDir === undefined) delete process.env.LIBERA_COLLAB_LIFECYCLE_DIR;
        else process.env.LIBERA_COLLAB_LIFECYCLE_DIR = oldLifecycleDir;
        guard.invalidateSharedNotebookCache();
      }
      const observed = { localRevoked: member.service.localProjects()[0]?.revoked, deletionError: failure?.message,
        markerRevoked: existsSync(path.join(root, MARKER)) ? markerAt(root).revoked ?? false : null };
      observe("late-revocation-marker", observed);
      assert.equal(failure, null, "known revocation must override an older unrevoked cloud marker even while signed in");
    });

    await review("the real account-switch runtime keeps the previous account's notebook isolated", async () => {
      const library = path.join(temp.dir, "account-runtime-library", "users", "admin");
      mkdirSync(library, { recursive: true });
      const runtime = new CollabRuntime({ collabDir: path.join(temp.dir, "account-runtime-db"), libraryRoot: library,
        appVersion: "test", installationId: "inst_followup_runtime", emit() {}, logger: { warn() {}, error() {} },
        host: { compaction: false }, secrets: {
          encrypt: async (value) => `test:${Buffer.from(value).toString("base64")}`,
          decrypt: async (value) => Buffer.from(value.slice(5), "base64").toString(),
        } });
      try {
        await runtime.start();
        // Switching accounts logs out the previous session. Give this control
        // runtime separate sessions so it cannot invalidate other fixtures.
        const ownerSession = await api(server, "/v1/auth/login", { email: ownerAuth.account.email, password: "correct horse battery" });
        const memberSession = await api(server, "/v1/auth/login", { email: memberAuth.account.email, password: "correct horse battery" });
        assert.equal(ownerSession.status, 200);
        assert.equal(memberSession.status, 200);
        await runtime.signedIn(server.url, ownerSession.body);
        const root = path.join(library, "AccountBound");
        writeTree(root, { "note.md": "belongs to original account\n" });
        const shared = await runtime.notebooks.share({ notebook: "AccountBound" });
        await runtime.notebooks.project(shared.projectId).whenIdle();
        const oldDatabase = runtime.host.store.path;
        await runtime.signedIn(server.url, memberSession.body);
        const actual = { markerExists: existsSync(path.join(root, MARKER)), localProjects: runtime.notebooks.localProjects(),
          databaseChanged: runtime.host.store.path !== oldDatabase,
          originalProjectStatus: (await api(server, `/v1/projects/${shared.projectId}`, undefined, ownerAuth.accessToken)).status };
        observe("account-switch", actual);
        assert.equal(actual.originalProjectStatus, 200);
        assert.equal(actual.markerExists, true);
        assert.equal(actual.databaseChanged, true);
        assert.deepEqual(actual.localProjects, []);
        const nextOwnerSession = await api(server, "/v1/auth/login", { email: ownerAuth.account.email, password: "correct horse battery" });
        assert.equal(nextOwnerSession.status, 200);
        await runtime.signedIn(server.url, nextOwnerSession.body);
        await until(() => runtime.notebooks.resolvePath("AccountBound/note.md") !== null, "original project restored after switch back");
        assert.equal(runtime.host.store.path, oldDatabase);
        assert.equal(markerAt(root).revoked, undefined);
        assert.equal(runtime.notebooks.localProjects()[0]?.projectId, shared.projectId);
      } finally { await runtime.stop(); }
    });

    await review("a follower taking down a notebook recovers from a lost successful response", async (peer) => {
      const original = await peer("lost-response-original");
      const id = await share(original, "FollowerTakedown", { "note.md": "keep this local\n" });
      const library = path.join(temp.dir, "lost-response-copy");
      mkdirSync(library);
      const root = path.join(library, "FollowerTakedown");
      cpSync(path.join(original.library, "FollowerTakedown"), root, { recursive: true });
      let lost = false;
      const follower = await peer("lost-response-follower", ownerAuth, { library, fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (!lost && init.method === "DELETE" && url.endsWith(`/v1/projects/${id}`)) {
          assert.equal(response.status, 204);
          lost = true;
          throw new Error("simulated lost response after committed takedown");
        }
        return response;
      } });
      assert.equal(follower.service.project(id).follower, true);
      // Keep the runtime as a follower; its former writer goes away without
      // delivering any more cloud changes to this independent root.
      await closePeer(original);
      const result = await follower.router.call("DELETE", ControlRoutes.project(id));
      observe("follower-lost-response", { status: result.status, lost, markerExists: existsSync(path.join(root, MARKER)),
        disk: readText(root, "note.md"), projects: follower.service.localProjects() });
      assert.equal(result.status, 204);
      assert.equal(lost, true);
      assert.equal(existsSync(path.join(root, MARKER)), false);
      assert.equal(readText(root, "note.md"), "keep this local\n");
      assert.deepEqual(follower.service.localProjects(), []);
    });

    await review("sharing again under the same name keeps revoked offline edits out of the new project", async (peer) => {
      const owner = await peer("new-identity-owner");
      const member = await peer("new-identity-member", memberAuth);
      const first = await share(owner, "SameName", { "note.md": "old project\n" });
      const joined = await member.service.join({ invitation: await invite(server, ownerAuth, first, memberAuth.account.email) });
      const oldDocId = member.service.resolvePath(`${joined.notebook}/note.md`).docId;
      const oldHub = member.host.acquire(oldDocId);
      try {
        member.host.setAccount(null);
        oldHub.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, "private pending\n"), { source: "typing" });
        assert.equal((await owner.router.call("DELETE", ControlRoutes.project(first))).status, 204);
        member.host.setAccount(account(memberAuth, server));
        await until(() => member.service.localProjects().some((entry) => entry.projectId === first && entry.revoked), "old project revoked");
        const second = await share(owner, "SameName", { "note.md": "new project\n" });
        const next = await member.service.join({ invitation: await invite(server, ownerAuth, second, memberAuth.account.email) });
        assert.notEqual(first, second);
        assert.notEqual(next.notebook, joined.notebook);
        const newDocId = member.service.resolvePath(`${next.notebook}/note.md`).docId;
        assert.notEqual(newDocId, oldDocId);
        assert.equal(textOf(member, `${next.notebook}/note.md`), "new project\n");
        assert.equal(oldHub.canSync(), false);
        assert.ok(oldHub.pendingCount > 0);
        assert.equal(readText(path.join(member.library, joined.notebook), "note.md"), "private pending\nold project\n");
        observe("new-project-identity", { oldPending: oldHub.pendingCount, oldCanSync: oldHub.canSync(), oldFolder: joined.notebook, newFolder: next.notebook, newText: textOf(member, `${next.notebook}/note.md`) });
      } finally { member.host.release(oldDocId); }
    });
  } finally {
    await server.stop();
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
