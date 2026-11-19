// Audit 2026-11-19, package P8 (writer promotion and materialization): a writer
// does no disk work before the server has answered (finding 2), a follower
// tracks every arrival and never silently stops waiting (finding 23), a text
// flush leaves a file another program is still writing to the scanner
// (finding 28), identical bytes and unchanged state are not written again
// (finding 39), and a document whose move is pending is not written at its old
// path (round A follow-up).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { STATE_DIRECTORY } from "../../electron/collab/notebooks/fs-ops";
import { ControlRoutes } from "../../src/lib/collab/local-api";
import { closePeer, makePeer, register, sleep, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

interface Internals {
  info: { manifestDocId: string; follower?: boolean };
  docs: Map<string, unknown>;
  state: { layout: Record<string, { path: string; hash?: string; size?: number; mtimeMs?: number }> };
  follower: boolean;
  materializeDoc(docId: string): Promise<void>;
  saveSoon(delay?: number): void;
  awaitedOnDisk: Map<string, unknown>;
  isMaterialized(): boolean;
  whenIdle(): Promise<boolean>;
}

const internals = (peer: Peer, projectId: string) => peer.service.project(projectId) as unknown as Internals;

const stateFile = (root: string) => path.join(root, ...STATE_DIRECTORY, "state.json");
const archived = (root: string): string[] => (existsSync(path.join(root, "_archive")) ? readdirSync(path.join(root, "_archive")) : []);

test("audit 1119 P8 finding 2: a writer starting offline leaves a newer file and its bookkeeping alone", { timeout: 120_000 }, async () => {
  const temp = tempRoot("libera-audit-1119-p8a-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const auth = await register(server, "Stale");
    const first = await makePeer(temp.dir, "owner", server, auth, { timings: { pollMs: 5_000 } });
    const root = path.join(first.library, "Cache");
    writeTree(root, { "note.md": "v1\n" });
    const shared = await first.service.share({ notebook: "Cache" });
    await internals(first, shared.projectId).whenIdle();
    await closePeer(first);

    // The cloud folder delivered a newer file and the state.json that goes with it; the SQLite cache is older.
    const note = path.join(root, "note.md");
    writeFileSync(note, "v2 newer\n");
    const state = JSON.parse(readFileSync(stateFile(root), "utf8")) as Internals["state"];
    for (const record of Object.values(state.layout)) {
      if (record.path === "note.md") Object.assign(record, { hash: sha("v2 newer\n"), size: undefined, mtimeMs: undefined });
    }
    writeFileSync(stateFile(root), JSON.stringify(state));

    // Restarted with the server unreachable, so it has only the cache (and, without a lease, follows).
    await server.stop();
    const offline = await makePeer(temp.dir, "owner", server, auth, { timings: { pollMs: 5_000, retryMs: 300 } });
    peers.push(offline);
    await until(() => internals(offline, shared.projectId) !== null, "the project to open");
    const project = internals(offline, shared.projectId);
    await until(() => project.docs.size > 0, "the document hubs to open from the cache");
    // Promoted to writer while still offline: the lease alone must not start disk work.
    const handle = (offline.service as unknown as { projects: Map<string, { writer: boolean; leaseDeadline?: number }> }).projects.get(shared.projectId)!;
    handle.writer = true;
    handle.leaseDeadline = performance.now() + 3_600_000;
    project.info.follower = false;
    project.state = state;
    assert.equal(project.follower, false);
    const docId = [...project.docs.keys()][0];
    await project.materializeDoc(docId);
    await sleep(1_500);
    assert.equal(readFileSync(note, "utf8"), "v2 newer\n", "the cached text must not replace the newer file before the server has answered");
  } finally {
    for (const peer of peers) await closePeer(peer);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});

test("audit 1119 P8: writer materialization", { timeout: 240_000 }, async (t) => {
  const temp = tempRoot("libera-audit-1119-p8b-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const auth = await register(server, "Materialize");
    const owner = await makePeer(temp.dir, "owner", server, auth, { timings: { pollMs: 5_000, retryMs: 300, importQuietMs: 1_500 } });
    peers.push(owner);
    const root = path.join(owner.library, "Mat");
    writeTree(root, { "note.md": "mine\n", "other.md": "other\n" });
    const shared = await owner.service.share({ notebook: "Mat" });
    const project = internals(owner, shared.projectId);
    await project.whenIdle();
    const noteDoc = owner.service.resolvePath("Mat/note.md")!.docId;
    const note = path.join(root, "note.md");

    await t.test("finding 28: a text flush does not adopt a file another program is still writing", async () => {
      const ready = owner.host.acquire(noteDoc);
      try { await until(() => ready.getText("content") === "mine\n" && ready.getStatus().state === "saved-remote", "the document to be synced"); }
      finally { owner.host.release(noteDoc); }
      await project.whenIdle();
      writeFileSync(note, "external edit\n");
      await project.materializeDoc(noteDoc);
      const hub = owner.host.acquire(noteDoc);
      try {
        assert.equal(hub.getText("content"), "mine\n", "the edit waits for the scanner's quiet period");
        await until(() => hub.getText("content") === "external edit\n", "the scanner to take the quiet edit in", 30_000);
      } finally {
        owner.host.release(noteDoc);
      }
    });

    await t.test("finding 39: adopting identical text schedules no bookkeeping write", async () => {
      await project.whenIdle();
      await project.materializeDoc(noteDoc);
      const calls: Array<number | undefined> = [];
      const original = project.saveSoon;
      project.saveSoon = function patched(this: Internals, delay?: number) { calls.push(delay); return original.call(this, delay); };
      try {
        await project.materializeDoc(noteDoc);
        await project.materializeDoc(noteDoc);
      } finally {
        project.saveSoon = original;
      }
      assert.deepEqual(calls, [], "the file and the record already agree");
    });

    await t.test("finding 39: text flushes share one state.json write", async () => {
      await project.whenIdle();
      await sleep(2_600);
      const inodes = new Set<number>();
      const sample = () => { try { inodes.add(statSync(stateFile(root)).ino); } catch { /* being replaced */ } };
      sample();
      const hub = owner.host.acquire(noteDoc);
      try {
        for (let index = 0; index < 4; index += 1) {
          hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, `e${index}`));
          await sleep(150);
          sample();
        }
        const until1 = Date.now() + 700;
        while (Date.now() < until1) { sample(); await sleep(20); }
      } finally {
        owner.host.release(noteDoc);
      }
      assert.ok(inodes.size <= 2, `state.json was rewritten ${inodes.size - 1} times while the text flushed`);
      await until(() => readFileSync(note, "utf8").startsWith("e3e2e1e0"), "the text to reach the file");
    });

    await t.test("round A follow-up: a document whose move is pending is not written at its old path", async () => {
      await project.whenIdle();
      const fileId = Object.keys(project.state.layout).find((key) => project.state.layout[key].path === "other.md")!;
      const otherDoc = owner.service.resolvePath("Mat/other.md")!.docId;
      const renamed = await owner.router.call("POST", ControlRoutes.files(shared.projectId), { op: "rename", path: "other.md", to: "moved.md" });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
      await until(() => existsSync(path.join(root, "moved.md")), "the rename to be applied");
      await project.whenIdle();
      // As after a move that failed: the layout record keeps the old path, and something else sits there.
      const record = project.state.layout[fileId];
      Object.assign(record, { path: "other.md", hash: undefined, size: undefined, mtimeMs: undefined });
      writeFileSync(path.join(root, "other.md"), "somebody else's file\n");
      const before = archived(root).length;
      await project.materializeDoc(otherDoc);
      assert.equal(readFileSync(path.join(root, "other.md"), "utf8"), "somebody else's file\n");
      assert.equal(archived(root).length, before, "nothing at the old path was archived or replaced");
      Object.assign(record, { path: "moved.md" });
    });
  } finally {
    for (const peer of peers) await closePeer(peer);
    await server.stop();
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});

test("audit 1119 P8 finding 23: a follower tracks every arrival and never silently stops waiting", { timeout: 180_000 }, async (t) => {
  const temp = tempRoot("libera-audit-1119-p8c-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const auth = await register(server, "Follow");
    const alice = await makePeer(temp.dir, "alice", server, auth, { leaseTtlMs: 4_000, timings: { pollMs: 5_000 } });
    peers.push(alice);
    const root = path.join(alice.library, "Lag");
    writeTree(root, { "note.md": "hi\n", "pic.bin": Buffer.from([1, 2, 3]) });
    const shared = await alice.service.share({ notebook: "Lag" });
    const { projectId } = shared;
    await internals(alice, projectId).whenIdle();

    // A second installation whose disk has only part of the notebook yet.
    const twinLibrary = path.join(temp.dir, "twin-library");
    const twinRoot = path.join(twinLibrary, "Lag");
    mkdirSync(twinRoot, { recursive: true });
    cpSync(path.join(root, ".libera-shared.json"), path.join(twinRoot, ".libera-shared.json"));
    writeFileSync(path.join(twinRoot, "note.md"), "hi\n");
    const twin = await makePeer(temp.dir, "alice-twin", server, auth, { library: twinLibrary, leaseTtlMs: 4_000, timings: { followerDiskMs: 40, followerDiskWaitMs: 200 } });
    peers.push(twin);
    twin.host.store.upsertProject({ projectId, name: "Lag", localRoot: twinRoot, role: "owner" });
    await twin.service.accountChanged();
    await until(() => twin.service.project(projectId)?.follower === true, "the second installation to follow");
    const follower = internals(twin, projectId);
    const heard = (liberaPath: string) => twin.events.some((event) => event.t === "files-changed" && event.paths.includes(liberaPath));

    await t.test("the first manifest is tracked: not materialized until its files are on the disk, and the wait outlasts its first window", async () => {
      await sleep(1_200);
      assert.equal(follower.isMaterialized(), false, "pic.bin has not arrived");
      assert.ok(follower.awaitedOnDisk.has("pic.bin"));
      writeFileSync(path.join(twinRoot, "pic.bin"), Buffer.from([1, 2, 3]));
      await until(() => follower.isMaterialized(), "the arrival to be noticed after the first wait expired", 30_000);
      await until(() => heard("Lag/pic.bin"), "the arrival to be announced");
    });

    await t.test("a same-path replacement is found although the delivery keeps size and mtime", async () => {
      const replaced = await alice.router.call("POST", ControlRoutes.files(projectId), { op: "write-blob", path: "pic.bin", contentBase64: Buffer.from([7, 7, 7]).toString("base64") });
      assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
      const target = path.join(twinRoot, "pic.bin");
      await until(() => follower.awaitedOnDisk.has("pic.bin"), "the replacement to be awaited");
      // A wrong file of the right size first (looked at once), then the right bytes under the same mtime.
      const stamp = statSync(target).mtime;
      writeFileSync(target, Buffer.from([5, 5, 5]));
      utimesSync(target, stamp, stamp);
      await sleep(400);
      twin.events.length = 0;
      writeFileSync(target, Buffer.from([7, 7, 7]));
      utimesSync(target, stamp, stamp);
      await until(() => heard("Lag/pic.bin"), "the delivery to be noticed", 30_000);
    });
  } finally {
    for (const peer of peers) await closePeer(peer);
    await server.stop();
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
