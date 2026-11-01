import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { FetchLike } from "../../electron/collab/core";
import { createMemoryPortPair } from "../../electron/collab/core/ports";
import { openReplica } from "../../src/lib/collab/client/replica";
import { ControlRoutes } from "../../src/lib/collab/local-api";
import { ContentKeys, ManifestKeys } from "../../src/lib/collab/protocol/schema";
import { api, closePeer, invite, makePeer, readText, register, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";
import { browserPort } from "./support/wire-harness";

test("rejoin recovers offline work separately from the current authorized shared text", { timeout: 90_000 }, async () => {
  const temp = tempRoot("libera-rejoin-recovery-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const auth = await register(server, "RecoveryOwner");
    const memberAuth = await register(server, "RecoveryMember");
    const owner = await makePeer(temp.dir, "owner", server, auth);
    const member = await makePeer(temp.dir, "member", server, memberAuth);
    peers.push(owner, member);
    writeTree(path.join(owner.library, "Recovery"), { "note.md": "base\n" });
    const shared = await owner.service.share({ notebook: "Recovery" });
    const joined = await member.service.join({ invitation: await invite(server, auth, shared.projectId, memberAuth.account.email) });
    const docId = member.service.resolvePath(`${joined.notebook}/note.md`)!.docId;
    const local = member.host.acquire(docId);
    const remote = owner.host.acquire(docId);
    try {
      member.host.setAccount(null);
      local.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, "private offline\n"), { source: "typing" });
      remote.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, "current shared\n"), { source: "typing" });
      await until(() => remote.pendingCount === 0, "owner's text acknowledged");
      assert.equal((await api(server, `/v1/projects/${shared.projectId}/members/${memberAuth.account.id}`, undefined, auth.accessToken, "DELETE")).status, 204);
      member.host.setAccount({ accountId: memberAuth.account.id, serverUrl: server.url, tokenProvider: {
        getAccessToken: async () => memberAuth.accessToken, refresh: async () => null,
      } });
      await until(() => member.service.localProjects()[0]?.revoked === true, "revocation after reconnect");
      assert.ok(local.pendingCount > 0);
      const oldRoot = path.join(member.library, joined.notebook);
      const rejoined = await member.service.join({ invitation: await invite(server, auth, shared.projectId, memberAuth.account.email) });
      await until(() => local.canSync() && local.getText() === "current shared\nbase\n" && local.pendingCount === 0, "current shared version after rejoin");
      assert.notEqual(rejoined.notebook, joined.notebook);
      assert.equal(readText(oldRoot, "note.md"), "private offline\nbase\n");
      assert.equal(readText(path.join(member.library, rejoined.notebook), "note.md"), "current shared\nbase\n");
      assert.ok(member.host.store.listRejected(docId).some((edit) => edit.rejectedText === "private offline\nbase\n"));
      assert.equal(remote.getText(), "current shared\nbase\n", "pre-revocation work is never silently uploaded on rejoin");
      const ports = createMemoryPortPair();
      const attached = member.host.attachReplica(docId, ports.hub);
      const replica = openReplica(docId, browserPort(ports.replica), { schedule: queueMicrotask });
      try {
        await replica.whenAttached();
        await until(() => replica.text() === "current shared\nbase\n", "editor replica loads after historical recovery notice");
        assert.equal(replica.canEditContent(), true);
      } finally { replica.destroy(); attached.detach(); }
    } finally { member.host.release(docId); owner.host.release(docId); }
  } finally {
    for (const peer of peers) await closePeer(peer);
    await server.stop(); removeDataDir(server.dataDir); temp.cleanup();
  }
});

test("late transfers cannot resurrect a deleted entry or write into a replacement root", { timeout: 90_000 }, async () => {
  const temp = tempRoot("libera-transfer-fencing-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  let releaseUpload = () => {};
  let releaseDownload = () => {};
  try {
    const auth = await register(server, "TransferOwner");
    const memberAuth = await register(server, "TransferMember");
    let blockUpload = false;
    let uploadStarted!: () => void;
    const uploadSeen = new Promise<void>((resolve) => { uploadStarted = resolve; });
    const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve; });
    let blockDownload = false;
    let downloadStarted!: () => void;
    const downloadSeen = new Promise<void>((resolve) => { downloadStarted = resolve; });
    const downloadGate = new Promise<void>((resolve) => { releaseDownload = resolve; });
    const ownerFetch: FetchLike = async (url, init) => {
      if (blockUpload && init.method === "PUT" && url.includes("/blobs/")) { uploadStarted(); await uploadGate; }
      return fetch(url, init);
    };
    const memberFetch: FetchLike = async (url, init) => {
      if (blockDownload && init.method === "GET" && url.includes("/blobs/")) { downloadStarted(); await downloadGate; }
      return fetch(url, init);
    };
    const owner = await makePeer(temp.dir, "owner", server, auth, { fetch: ownerFetch });
    const member = await makePeer(temp.dir, "member", server, memberAuth, { fetch: memberFetch });
    peers.push(owner, member);
    const root = path.join(owner.library, "Transfers");
    writeTree(root, { "deleted.png": Buffer.from([1, 2, 3]), "replaced.png": Buffer.from([4, 5, 6]) });
    const shared = await owner.service.share({ notebook: "Transfers" });
    const joined = await member.service.join({ invitation: await invite(server, auth, shared.projectId, memberAuth.account.email) });
    blockUpload = true;
    const writing = owner.router.call("POST", ControlRoutes.files(shared.projectId), { op: "write-blob", path: "deleted.png", contentBase64: Buffer.from([7, 8, 9]).toString("base64") });
    await uploadSeen;
    await member.service.fileOp(shared.projectId, { op: "delete", path: "deleted.png" });
    const manifest = owner.host.acquire(owner.service.project(shared.projectId)!.info.manifestDocId);
    try {
      await until(() => ![...manifest.getDoc("manifest").getMap<{ path: string }>(ManifestKeys.files).values()].some((entry) => entry.path === "deleted.png"), "remote deletion reaches uploader");
      releaseUpload();
      assert.equal((await writing).status, 409);
      assert.ok(![...manifest.getDoc("manifest").getMap<{ path: string }>(ManifestKeys.files).values()].some((entry) => entry.path === "deleted.png"));
    } finally { owner.host.release(manifest.docId); }
    blockUpload = false;
    blockDownload = true;
    await owner.service.fileOp(shared.projectId, { op: "write-blob", path: "replaced.png", contentBase64: Buffer.from([10, 11, 12]).toString("base64") });
    await downloadSeen;
    const memberRoot = path.join(member.library, joined.notebook);
    const marker = JSON.parse(readFileSync(path.join(memberRoot, ".libera-shared.json"), "utf8"));
    rmSync(memberRoot, { recursive: true });
    mkdirSync(memberRoot);
    const replacement = { ...marker, projectId: "prj_replacement", folderId: "fld_replacement" };
    writeFileSync(path.join(memberRoot, ".libera-shared.json"), JSON.stringify(replacement));
    writeFileSync(path.join(memberRoot, "replaced.png"), "foreign copy");
    releaseDownload();
    await member.service.project(shared.projectId)!.whenIdle();
    assert.equal(readText(memberRoot, "replaced.png"), "foreign copy");
    assert.deepEqual(JSON.parse(readFileSync(path.join(memberRoot, ".libera-shared.json"), "utf8")), replacement);
    assert.equal(existsSync(path.join(memberRoot, ".libera")), false, "no stale state/base writes reach the replacement root");
  } finally {
    releaseUpload(); releaseDownload();
    for (const peer of peers) await closePeer(peer);
    await server.stop(); removeDataDir(server.dataDir); temp.cleanup();
  }
});
