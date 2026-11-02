import assert from "node:assert/strict";
import { existsSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import * as Y from "yjs";

import { databaseKey, databasePath } from "../../electron/collab/control/databases";
import { CollabRuntime } from "../../electron/collab/control/runtime";
import { ApiClient, ApiClientError } from "../../electron/collab/core/api-client";
import { syncClientId } from "../../electron/collab/core/host";
import { HostStore } from "../../electron/collab/core/store";
import { openDatabase } from "../../electron/collab/core/sqlite";
import { sha256 } from "../../electron/collab/notebooks/fs-ops";
import { ContentKeys, ManifestKeys, type ManifestEntry } from "../../src/lib/collab/protocol/schema";
import { api, closePeer, intermittent, makePeer, register, sleep, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

const quiet = { warn() {}, error() {} };
const tokens = { getAccessToken: async () => "token", refresh: async () => null };
const networkFailure = (error: unknown) => error instanceof ApiClientError && error.transient && error.status === 0;

test("REST deadlines cover unfinished bodies and token acquisition; cancellation leaves the client usable", async () => {
  for (const status of [200, 503]) {
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const api = new ApiClient({ baseUrl: "http://example.test", tokenProvider: tokens, timeoutMs: 30,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { status }),
    });
    try { await Promise.all([assert.rejects(api.request("GET", "/unfinished-body"), networkFailure), sleep(60)]); }
    finally { stream?.close(); }
  }
  let fetches = 0;
  let releaseToken: (value: string) => void = () => {};
  const token = new Promise<string>((resolve) => { releaseToken = resolve; });
  const delayed = new ApiClient({ baseUrl: "http://example.test", timeoutMs: 30,
    tokenProvider: { getAccessToken: () => token, refresh: async () => null },
    fetch: async () => { fetches += 1; return Response.json({ ok: true }); },
  });
  await Promise.all([assert.rejects(delayed.request("POST", "/mutation"), networkFailure), sleep(60)]);
  releaseToken("late-token");
  await sleep(10);
  assert.equal(fetches, 0, "a late token cannot start an already-cancelled mutation");

  let hang = true;
  let started = false;
  const cancellable = new ApiClient({ baseUrl: "http://example.test", tokenProvider: tokens,
    fetch: async () => {
      started = true;
      if (hang) return new Promise<Response>(() => {}); // Even a broken adapter must be bounded.
      return Response.json({ ok: true });
    },
  });
  const pending = assert.rejects(cancellable.request("GET", "/pending"), networkFailure);
  await until(() => started, "request starts");
  cancellable.cancelPending();
  await pending;
  hang = false;
  assert.deepEqual(await cancellable.request("GET", "/fresh"), { ok: true });
});

test("legacy database ownership preserves pending bytes and cannot be reassigned by a matching account ID", async () => {
  const temp = tempRoot("libera-legacy-authority-");
  const a = { accountId: "acc_same", serverUrl: "https://a.example.test" };
  const b = { ...a, serverUrl: "https://b.example.test" };
  const legacy = path.join(temp.dir, `${databaseKey(a.accountId)}.sqlite`);
  const doc = new Y.Doc();
  doc.getText("source").insert(0, "pending A-only work");
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  try {
    const initial = new HostStore({ path: legacy });
    initial.appendLocal("doc_pending", "content", bytes);
    initial.close();
    // Exercise the actual shipped schema upgrade, including durable work.
    const old = openDatabase(legacy);
    old.exec("DROP TABLE retired_paths; DROP TABLE database_authority; PRAGMA user_version = 1");
    old.close();
    assert.equal(await databasePath(temp.dir, a, a, quiet), legacy);
    const scopedB = await databasePath(temp.dir, b, b, quiet);
    assert.notEqual(scopedB, legacy);
    const isolated = new HostStore({ path: scopedB });
    assert.equal(isolated.unbatchedUpdates("doc_pending").length, 0);
    isolated.close();
    assert.equal(await databasePath(temp.dir, a, b, quiet), legacy);
    const reopened = new HostStore({ path: legacy });
    assert.deepEqual(reopened.databaseAuthority(), a);
    assert.deepEqual(Buffer.from(reopened.unbatchedUpdates("doc_pending")[0].update), Buffer.from(bytes));
    reopened.close();
    assert.equal(databaseKey(a.accountId, "https://A.example.test:443/"), databaseKey(a.accountId, a.serverUrl));
  } finally { temp.cleanup(); }
});

test("an ambiguous legacy database stays preserved after a later remembered sign-in", async () => {
  const temp = tempRoot("libera-unassigned-legacy-");
  const account = { accountId: "acc_ambiguous", serverUrl: "https://new.example.test" };
  const legacy = path.join(temp.dir, `${databaseKey(account.accountId)}.sqlite`);
  try {
    const store = new HostStore({ path: legacy });
    store.appendLocal("doc_unknown", "content", new Uint8Array([0, 0]));
    store.close();
    const scoped = await databasePath(temp.dir, account, null, quiet);
    assert.notEqual(scoped, legacy);
    assert.equal(await databasePath(temp.dir, account, account, quiet), scoped);
    const preserved = new HostStore({ path: legacy });
    assert.equal(preserved.databaseAuthority(), null);
    assert.equal(preserved.unbatchedUpdates("doc_unknown").length, 1);
    preserved.close();
  } finally { temp.cleanup(); }
});

test("failed placement after archiving keeps external binary bytes and cannot infer deletion", { timeout: 40_000 }, async () => {
  const temp = tempRoot("libera-blob-archive-retry-");
  const server = await startServerProcess();
  let peer: Peer | undefined;
  const rename = fs.rename;
  let fail = false;
  try {
    const auth = await register(server, "BlobArchiveRetry");
    peer = await makePeer(temp.dir, "owner", server, auth, { timings: { retryMs: 80, pollMs: 80 } });
    const root = path.join(peer.library, "ArchiveRetry");
    writeTree(root, { "image.png": Buffer.from([1, 2, 3, 4]) });
    const shared = await peer.service.share({ notebook: "ArchiveRetry" });
    const project = peer.service.project(shared.projectId)!;
    await project.whenIdle();
    const external = Buffer.from([9, 10, 11, 12]);
    const replacement = Buffer.from([5, 6, 7, 8]);
    await peer.host.api!.uploadBlob(shared.projectId, replacement, "image/png");
    writeFileSync(path.join(root, "image.png"), external);
    fail = true;
    fs.rename = async (from, to) => {
      if (fail && String(from).includes(".libera-tmp-") && to === path.join(root, "image.png")) {
        throw Object.assign(new Error("injected final placement failure"), { code: "EIO" });
      }
      return rename(from, to);
    };
    const hub = peer.host.acquire(project.info.manifestDocId);
    try {
      hub.applyLocalChange("manifest", (doc) => {
        const map = doc.getMap<ManifestEntry>(ManifestKeys.files);
        const entry = [...map.values()][0];
        map.set(entry.fileId, { ...entry, blobHash: sha256(replacement) });
      }, { source: "typing" });
      await until(() => existsSync(path.join(root, "_archive/image.png")) && !existsSync(path.join(root, "image.png")), "archived bytes and interrupted placement");
      await sleep(800); // Beyond delete grace, with repeated scans and retries.
      assert.equal(hub.getDoc("manifest").getMap(ManifestKeys.files).size, 1);
      assert.deepEqual(readFileSync(path.join(root, "_archive/image.png")), external);
      fail = false;
      await until(() => { try { return readFileSync(path.join(root, "image.png")).equals(replacement); } catch { return false; } }, "placement retry");
    } finally { peer.host.release(hub.docId); }
  } finally {
    fail = false;
    fs.rename = rename;
    if (peer) await closePeer(peer);
    await server.stop(); removeDataDir(server.dataDir); temp.cleanup();
  }
});

test("retired paths survive host restart while explicit recreation and ordinary new files still work", { timeout: 40_000 }, async () => {
  const temp = tempRoot("libera-retired-path-restart-");
  const server = await startServerProcess();
  let peer: Peer | undefined;
  try {
    const auth = await register(server, "RetiredRestart");
    peer = await makePeer(temp.dir, "owner", server, auth, { timings: { pollMs: 50 } });
    const root = path.join(peer.library, "Retired");
    writeTree(root, { "note.md": "retired bytes\n" });
    const shared = await peer.service.share({ notebook: "Retired" });
    await peer.service.project(shared.projectId)!.whenIdle();
    await peer.service.fileOp(shared.projectId, { op: "delete", path: "note.md" });
    const manifestId = peer.service.project(shared.projectId)!.info.manifestDocId;
    const before = peer.host.acquire(manifestId);
    try { await until(() => before.pendingCount === 0, "delete acknowledged"); }
    finally { peer.host.release(manifestId); }
    await closePeer(peer);
    peer = await makePeer(temp.dir, "owner", server, auth, { timings: { pollMs: 50 } });
    writeFileSync(path.join(root, "note.md"), "retired bytes\n");
    await until(() => !existsSync(path.join(root, "note.md")), "late copy quarantined");
    assert.equal(peer.service.resolvePath("Retired/note.md"), null);
    assert.ok(existsSync(path.join(root, "_archive/note (2).md")));
    await peer.service.fileOp(shared.projectId, { op: "create-file", path: "note.md", content: "explicit new content\n" });
    assert.equal(readFileSync(path.join(root, "note.md"), "utf8"), "explicit new content\n");
    writeFileSync(path.join(root, "new.md"), "ordinary external creation\n");
    await until(() => peer!.service.resolvePath("Retired/new.md") !== null, "ordinary file imported");
  } finally {
    if (peer) await closePeer(peer);
    await server.stop(); removeDataDir(server.dataDir); temp.cleanup();
  }
});

test("a legacy host's offline edits resume with its original client sequence identity", { timeout: 40_000, skip: intermittent }, async () => {
  const temp = tempRoot("libera-legacy-offline-resume-");
  const server = await startServerProcess();
  let peer: Peer | undefined;
  let runtime: CollabRuntime | undefined;
  try {
    const auth = await register(server, "LegacyOfflineResume");
    peer = await makePeer(temp.dir, "legacy", server, auth);
    const library = peer.library;
    const installation = peer.host.installationId;
    writeTree(path.join(library, "Legacy"), { "note.md": "base\n" });
    const shared = await peer.service.share({ notebook: "Legacy" });
    await peer.service.project(shared.projectId)!.whenIdle();
    const docId = peer.service.resolvePath("Legacy/note.md")!.docId;
    const hub = peer.host.acquire(docId);
    try {
      hub.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, "common\n"), { source: "typing" });
      await until(() => hub.pendingCount === 0, "legacy sequence acknowledged");
      peer.host.setAccount(null);
      hub.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, "pending\n"), { source: "typing" });
      assert.ok(hub.pendingCount > 0);
    } finally { peer.host.release(docId); }
    const original = peer.host.dbPath;
    await closePeer(peer);
    peer = undefined;
    const directory = path.join(temp.dir, "upgraded-runtime");
    await fs.mkdir(directory);
    const legacyFile = path.join(directory, `${databaseKey(auth.account.id)}.sqlite`);
    await fs.copyFile(original, legacyFile);
    runtime = new CollabRuntime({
      collabDir: directory, libraryRoot: library, installationId: installation, appVersion: "test", emit() {}, logger: quiet,
      host: { compaction: false },
      secrets: { encrypt: async (value) => `test:${Buffer.from(value).toString("base64")}`,
        decrypt: async (value) => Buffer.from(value.slice(5), "base64").toString() },
    });
    await runtime.start();
    const session = await api(server, "/v1/auth/login", { email: auth.account.email, password: "correct horse battery" });
    assert.equal(session.status, 200);
    await runtime.signedIn(server.url, session.body as Parameters<CollabRuntime["signedIn"]>[1]);
    assert.equal(runtime.host.dbPath, legacyFile);
    assert.equal(runtime.clientId, syncClientId(installation, auth.account.id));
    const resumed = runtime.host.acquire(docId);
    try {
      await until(() => resumed.pendingCount === 0 && resumed.getStatus().connected, "offline work acknowledged after upgrade");
      const digest = await api<{ contentSha256: string }>(server, `/v1/documents/${docId}/digest`, undefined, auth.accessToken);
      assert.equal(digest.body.contentSha256, sha256(Buffer.from("pending\ncommon\nbase\n")));
    } finally { runtime.host.release(docId); }
  } finally {
    if (runtime) await runtime.stop();
    if (peer) await closePeer(peer);
    await server.stop(); removeDataDir(server.dataDir); temp.cleanup();
  }
});
