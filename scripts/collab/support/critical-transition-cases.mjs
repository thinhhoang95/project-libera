// Review probes: assert matrix requirements without changing production code.
// Network, filesystem waits and independent cloud deliveries use disposable fixtures.
import assert from "node:assert/strict";
import { cpSync, existsSync, promises as fs, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { api, closePeer, invite, makePeer, register, tempRoot, until, writeTree } from "../support/notebooks-harness.ts";
import { removeDataDir, startServerProcess } from "../support/server-process.ts";

const observe = (name, value) => console.log(`TRANSITION ${name} ${JSON.stringify(value)}`);
function quiet(project) {
  project.watcher?.close(); project.watcher = null;
  for (const key of ["pollTimer", "scanTimer", "retryTimer", "manifestTimer"]) {
    if (project[key]) clearTimeout(project[key]);
    project[key] = null;
  }
}
function containsBytes(root, bytes) {
  if (!existsSync(root)) return false;
  const wanted = Buffer.from(bytes);
  const text = wanted.toString("utf8");
  const jsonContains = (value) => typeof value === "string" ? value === text : value !== null && typeof value === "object" && Object.values(value).some(jsonContains);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory() && containsBytes(file, bytes)) return true;
    if (!entry.isFile()) continue;
    const saved = readFileSync(file);
    if (saved.equals(wanted)) return true;
    if (entry.name.endsWith(".json") && Buffer.from(text).equals(wanted)) {
      try { if (jsonContains(JSON.parse(saved.toString("utf8")))) return true; }
      catch { /* A binary or partially delivered file is not a JSON recovery record. */ }
    }
  }
  return false;
}
const resultOf = (promise) => promise.then((body) => ({ status: 200, body }), (error) => ({ status: error.status, error: error.message }));

test("R11–R14: guarded collaboration lifecycle transitions", { timeout: 180_000 }, async (t) => {
  const temp = tempRoot("libera-transition-review-");
  const server = await startServerProcess();
  let serial = 0;
  try {
    const ownerAuth = await register(server, "TransitionOwner");
    const memberAuth = await register(server, "TransitionMember");
    const otherAuth = await register(server, "TransitionOther");
    async function scenario(name, body) {
      await t.test(name, { timeout: 40_000 }, async () => {
        const peers = [];
        const peer = async (auth = ownerAuth, options = {}) => {
          const value = await makePeer(temp.dir, `transition-${++serial}`, server, auth, options);
          peers.push(value); return value;
        };
        try { await body(peer); }
        finally { for (const value of peers.reverse()) await closePeer(value); }
      });
    }

    await scenario("deleting a text file preserves an external edit arriving during archive IO", async (peer) => {
      const owner = await peer();
      const root = path.join(owner.library, "DeleteArchive");
      writeTree(root, { "note.md": "base text\n" });
      const shared = await owner.service.share({ notebook: "DeleteArchive" });
      const project = owner.service.project(shared.projectId);
      const docId = owner.service.resolvePath("DeleteArchive/note.md").docId;
      await until(() => project.docs.get(docId)?.hub.getText("content") === "base text\n", "text loaded before deletion");
      await project.whenIdle(); quiet(project);
      const write = fs.writeFile;
      let held = false;
      let release = () => {};
      const gate = new Promise((resolve) => { release = resolve; });
      const external = "external input during delete archive\n";
      fs.writeFile = async (target, ...args) => {
        if (!held && String(target).startsWith(`${root}${path.sep}`) && path.basename(String(target)).startsWith(".libera-tmp-")) {
          held = true; await gate;
        }
        return write(target, ...args);
      };
      const deleting = resultOf(owner.service.fileOp(shared.projectId, { op: "delete", path: "note.md" }));
      try {
        await until(() => held, "archive temp-file write");
        writeFileSync(path.join(root, "note.md"), external);
        release(); const result = await deleting;
        await project.whenIdle();
        const preserved = containsBytes(root, external);
        observe("delete-archive", { result, preserved, rootFiles: readdirSync(root) });
        assert.equal(preserved, true, "shared deletion must archive the intervening external input as well as the latest shared text");
      } finally { release(); fs.writeFile = write; await deleting; }
    });

    await scenario("a later rename cannot overwrite recovery bytes left by an interrupted move", async (peer) => {
      const owner = await peer();
      const root = path.join(owner.library, "MoveRecovery");
      writeTree(root, { "a.md": "shared baseline\n" });
      const shared = await owner.service.share({ notebook: "MoveRecovery" });
      const project = owner.service.project(shared.projectId);
      await project.whenIdle(); quiet(project);
      const external = "external input not yet imported before rename\n";
      writeFileSync(path.join(root, "a.md"), external);
      const rename = fs.rename;
      let failed = false;
      fs.rename = async (from, to) => {
        if (String(from).includes(`${path.sep}moving${path.sep}`) && to === path.join(root, "b.md")) {
          failed = true; throw Object.assign(new Error("injected interrupted final move"), { code: "EIO" });
        }
        return rename(from, to);
      };
      try {
        const first = await resultOf(owner.service.fileOp(shared.projectId, { op: "rename", path: "a.md", to: "b.md" }));
        await project.whenIdle();
        assert.equal(failed, true);
        const afterFailure = containsBytes(root, external);
        assert.equal(afterFailure, true, "the injected move leaves the only external copy in staging");
        fs.rename = rename;
        const second = await resultOf(owner.service.fileOp(shared.projectId, { op: "rename", path: "b.md", to: "c.md" }));
        await project.whenIdle();
        const afterNextMove = containsBytes(root, external);
        observe("move-recovery", { first, second, afterFailure, afterNextMove, finalText: readFileSync(path.join(root, "c.md"), "utf8") });
        assert.equal(afterNextMove, true, "reusing a staging path must not destroy an earlier interrupted move's recovery bytes");
      } finally { fs.rename = rename; }
    });

    for (const replacement of ["missing", "foreign"]) await scenario(`a pending join cannot commit into a ${replacement} root`, async (peer) => {
      const owner = await peer();
      const source = path.join(owner.library, `Join-${replacement}`);
      writeTree(source, { "note.md": "invited project content\n" });
      const shared = await owner.service.share({ notebook: `Join-${replacement}` });
      const foreignOwner = await peer(memberAuth);
      const foreignRoot = path.join(foreignOwner.library, `Foreign-${replacement}`);
      writeTree(foreignRoot, { "keep.md": "private content from the joining account's different project\n" });
      const foreign = await foreignOwner.service.share({ notebook: `Foreign-${replacement}` });
      await foreignOwner.service.project(foreign.projectId).whenIdle();
      const foreignMarker = readFileSync(path.join(foreignRoot, ".libera-shared.json"), "utf8");
      const member = await peer(memberAuth);
      const root = path.join(member.library, `Join-${replacement}`);
      const token = await invite(server, ownerAuth, shared.projectId, memberAuth.account.email, "editor");
      const write = fs.writeFile;
      let held = false;
      let release = () => {};
      const gate = new Promise((resolve) => { release = resolve; });
      fs.writeFile = async (target, ...args) => {
        if (!held && path.dirname(String(target)) === root && path.basename(String(target)).startsWith(".libera-tmp-")) {
          held = true; await gate;
        }
        return write(target, ...args);
      };
      const joining = resultOf(member.service.join({ invitation: token }));
      try {
        await until(() => held, "join marker parent/temp-file IO");
        rmSync(root, { recursive: true, force: true });
        if (replacement === "foreign") {
          cpSync(foreignRoot, root, { recursive: true });
          // A cloud provider delivers the marker/content before bookkeeping.
          rmSync(path.join(root, ".libera"), { recursive: true, force: true });
        }
        release(); const result = await joining;
        const marker = existsSync(path.join(root, ".libera-shared.json")) ? readFileSync(path.join(root, ".libera-shared.json"), "utf8") : null;
        let disclosed = null;
        if (replacement === "foreign" && result.status === 200 && JSON.parse(marker).projectId === shared.projectId) {
          await until(() => owner.service.resolvePath("Join-foreign/keep.md") !== null, "foreign private file imported by the resumed join");
          const docId = owner.service.resolvePath("Join-foreign/keep.md").docId;
          const hub = owner.host.acquire(docId);
          try {
            await until(() => hub.getText("content").includes("private content"), "other project's owner receives the imported private text");
            disclosed = hub.getText("content");
          } finally { owner.host.release(docId); }
        }
        const foreignAccess = await api(server, `/v1/projects/${foreign.projectId}`, undefined, ownerAuth.accessToken);
        observe(`join-${replacement}`, { result, exists: existsSync(root), markerProjectId: marker ? JSON.parse(marker).projectId : null,
          foreignProjectId: foreign.projectId, foreignAccountId: JSON.parse(foreignMarker).accountId,
          joiningAccountId: memberAuth.account.id, foreignProjectAccessForInviter: foreignAccess.status, disclosed });
        if (replacement === "missing") assert.equal(existsSync(root), false, "a suspended join must not recreate the removed root");
        else assert.equal(marker, foreignMarker, "a suspended join must retain the newly delivered project's marker");
      } finally { release(); fs.writeFile = write; await joining; }
    });

    await scenario("control: account changes cancel a pending invitation response", async (peer) => {
      const owner = await peer();
      const root = path.join(owner.library, "JoinAccount");
      writeTree(root, { "note.md": "only the invited account can open this\n" });
      const shared = await owner.service.share({ notebook: "JoinAccount" });
      let held = false;
      let release = () => {};
      const gate = new Promise((resolve) => { release = resolve; });
      const member = await peer(memberAuth, { fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (init.method === "POST" && /\/invitations\/token\/[^/]+\/accept$/.test(new URL(url).pathname)) {
          held = true; await gate;
        }
        return response;
      } });
      member.service.joinTimeoutMs = 250;
      const token = await invite(server, ownerAuth, shared.projectId, memberAuth.account.email, "editor");
      const joining = resultOf(member.service.join({ invitation: token }));
      try {
        await until(() => held, "old account's accepted invitation response");
        await member.service.beforeAccountChange();
        member.host.setAccount({ accountId: otherAuth.account.id, serverUrl: server.url,
          tokenProvider: { getAccessToken: async () => otherAuth.accessToken, refresh: async () => null } });
        await member.service.accountChanged();
        release(); const result = await joining;
        const access = await api(server, `/v1/projects/${shared.projectId}`, undefined, otherAuth.accessToken);
        const markerFile = path.join(member.library, "JoinAccount", ".libera-shared.json");
        const marker = existsSync(markerFile) ? JSON.parse(readFileSync(markerFile, "utf8")) : null;
        observe("join-account", { result, newAccountProjectStatus: access.status, marker, localProjects: member.service.localProjects() });
        assert.ok(result.status !== 200 || access.status === 200, "a stale invitation response cannot authorize another account's local join");
      } finally { release(); await joining; }
    });

    await scenario("album revocation cannot delete photos and bookkeeping from a replacement project", async (peer) => {
      const gallery = (value) => path.join(value.library, "..", "..", "gallery");
      const owner = await peer();
      const originalRoot = path.join(gallery(owner), "RevokedAlbum");
      writeTree(originalRoot, { "common.png": Buffer.from([1, 2, 3, 4]) });
      const shared = await owner.service.shareAlbum({ folder: "RevokedAlbum" });
      const member = await peer(memberAuth);
      const token = await invite(server, ownerAuth, shared.projectId, memberAuth.account.email, "editor");
      const joined = await member.service.join({ invitation: token });
      const root = path.join(gallery(member), joined.notebook);
      await member.service.project(shared.projectId).whenIdle();
      const otherDevice = await peer(memberAuth);
      const foreignRoot = path.join(gallery(otherDevice), "IndependentAlbum");
      const privatePhoto = Buffer.from([9, 10, 11, 12]);
      writeTree(foreignRoot, { "common.png": privatePhoto, "keep.png": Buffer.from([13, 14, 15, 16]) });
      const foreign = await otherDevice.service.shareAlbum({ folder: "IndependentAlbum" });
      await otherDevice.service.project(foreign.projectId).whenIdle();
      const foreignMarker = readFileSync(path.join(foreignRoot, ".libera-shared.json"), "utf8");
      const remove = fs.rm;
      let held = false;
      let release = () => {};
      const gate = new Promise((resolve) => { release = resolve; });
      fs.rm = async (target, ...args) => {
        if (!held && (target === path.join(root, "common.png") || String(target).includes(`${path.sep}album-cleanup${path.sep}`))) { held = true; await gate; }
        return remove(target, ...args);
      };
      try {
        const removed = await api(server, `/v1/projects/${shared.projectId}/members/${memberAuth.account.id}`, undefined, ownerAuth.accessToken, "DELETE");
        assert.equal(removed.status, 204);
        await until(() => held, "revoked album's first photo deletion");
        rmSync(root, { recursive: true, force: true }); cpSync(foreignRoot, root, { recursive: true });
        release();
        await until(() => !member.service.localProjects().some((project) => project.projectId === shared.projectId), "revocation cleanup completes");
        const marker = existsSync(path.join(root, ".libera-shared.json")) ? readFileSync(path.join(root, ".libera-shared.json"), "utf8") : null;
        const photo = existsSync(path.join(root, "common.png")) ? [...readFileSync(path.join(root, "common.png"))] : null;
        observe("album-cleanup-replacement", { foreignProjectId: foreign.projectId, marker, photo, statePresent: existsSync(path.join(root, ".libera", "collab", "state.json")) });
        assert.deepEqual(photo, [...privatePhoto], "a revoked album must not delete a matching photo name from a newly delivered project");
        assert.equal(marker, foreignMarker, "cleanup must preserve the replacement identity");
      } finally { release(); fs.rm = remove; }
    });

    await scenario("control: deletion preserves external input already present before archive observation", async (peer) => {
      const owner = await peer();
      const root = path.join(owner.library, "ArchiveControl");
      writeTree(root, { "note.md": "original shared text\n" });
      const shared = await owner.service.share({ notebook: "ArchiveControl" });
      const project = owner.service.project(shared.projectId);
      const docId = owner.service.resolvePath("ArchiveControl/note.md").docId;
      await until(() => project.docs.get(docId)?.hub.getText("content") === "original shared text\n", "control text loads");
      await project.whenIdle(); quiet(project);
      writeFileSync(path.join(root, "note.md"), "already present external input\n");
      const result = await owner.service.fileOp(shared.projectId, { op: "delete", path: "note.md" });
      await project.whenIdle();
      const sharedPreserved = containsBytes(root, "original shared text\n");
      const externalPreserved = containsBytes(root, "already present external input\n");
      observe("delete-archive-control", { result, sharedPreserved, externalPreserved });
      assert.equal(sharedPreserved, true);
      assert.equal(externalPreserved, true);
      assert.equal(existsSync(path.join(root, "note.md")), false);
    });
  } finally { await server.stop(); removeDataDir(server.dataDir); temp.cleanup(); }
});
