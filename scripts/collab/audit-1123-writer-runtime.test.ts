// Audit 2026-11-23, package WR (writer runtime and manifest follow): a lapsed
// writer lease defers the manifest pass instead of rebuilding the layout (C1),
// a file enters the layout only once the manifest holds it (C4), a rollback
// that brings no state clears the rebuilt flags (H2), an archive that cannot
// reach the root keeps its record (M10), and retirements and transition rows
// wait until the server has the local manifest edit (M23, part 1).

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as Y from "yjs";

import { WriteCancelledError } from "../../electron/collab/notebooks/fs-ops";
import { MessageType } from "../../src/lib/collab/protocol/messages";
import { ManifestKeys } from "../../src/lib/collab/protocol/schema";
import { closePeer, makePeer, register, sleep, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

let seq = 2_000_000;

/** Delivers a manifest change the way the server's broadcast does, without the server learning of it. */
function deliverManifest(peer: Peer, manifestDocId: string, mutate: (files: Y.Map<unknown>) => void): void {
  const hub = peer.host.acquire(manifestDocId);
  try {
    const clone = new Y.Doc();
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(hub.getDoc("manifest")));
    let update: Uint8Array | null = null;
    clone.on("update", (value: Uint8Array) => { update = value; });
    clone.transact(() => mutate(clone.getMap<unknown>(ManifestKeys.files)));
    assert.ok(update, "the change produced an update");
    seq += 1;
    hub.handleRemote({ type: MessageType.Remote, docId: manifestDocId, subdoc: "manifest", serverSeq: seq, update, userId: "", clientId: "audit-1123" });
  } finally {
    peer.host.release(manifestDocId);
  }
}

function entryFor(peer: Peer, manifestDocId: string, liberaPath: string): { key: string; record: Record<string, unknown> } {
  const hub = peer.host.acquire(manifestDocId);
  try {
    const files = hub.getDoc("manifest").getMap<unknown>(ManifestKeys.files);
    for (const [key, value] of files.entries()) {
      const record = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
      if (record.path === liberaPath) return { key, record };
    }
  } finally {
    peer.host.release(manifestDocId);
  }
  throw new Error(`no manifest entry for ${liberaPath}`);
}

const archived = (root: string): string[] => (existsSync(path.join(root, "_archive")) ? readdirSync(path.join(root, "_archive")) : []);

interface Record_ { path: string; kind: string; docId?: string; hash?: string }
interface Internals {
  ctx: { canWriteDisk?: (projectId: string) => boolean };
  state: { layout: Record<string, Record_> };
  docs: Map<string, { rebuilt: boolean; hub: { caughtUp: boolean; rollback(subdoc: string, reason: string, message: string): unknown } }>;
  retired: Map<string, Set<string>>;
  recordedPaths: Map<string, unknown>;
  manifestRebuilt: boolean;
  manifestCaughtUp(): boolean;
  rootAvailable(): Promise<boolean>;
  createFromDisk(...args: unknown[]): Promise<unknown>;
  archiveRemoved(record: Record_): Promise<void>;
  applyManifestPass(): Promise<void>;
  enqueue<T>(task: () => Promise<T>): Promise<T>;
  leaseConfirmed(): void;
  docReady(runtime: unknown): boolean;
  manifestReady(): boolean;
}

test("audit 1123 WR: writer runtime and manifest follow", { timeout: 240_000 }, async (t) => {
  const temp = tempRoot("libera-audit-1123-wr-");
  const server = await startServerProcess();
  let peer: Peer | undefined;
  try {
    const auth = await register(server, "WriterRuntime");
    peer = await makePeer(temp.dir, "owner", server, auth, { timings: { pollMs: 5_000, retryMs: 300 } });
    const owner = peer;
    const root = path.join(owner.library, "Runtime");
    writeTree(root, { "note.md": "mine\n", "data.bin": Buffer.from("blob mine"), "gone.md": "to be removed\n" });
    const shared = await owner.service.share({ notebook: "Runtime" });
    const project = owner.service.project(shared.projectId)!;
    await project.whenIdle();
    const manifestDocId = project.info.manifestDocId;
    const runtime = project as unknown as Internals;
    const hashes = () => Object.fromEntries(Object.values(runtime.state.layout).filter((record) => record.kind !== "folder").map((record) => [record.path, record.hash]));

    await t.test("C1: a lapsed writer lease defers the manifest pass and keeps the layout's hashes", async () => {
      const before = hashes();
      assert.ok(before["note.md"] && before["data.bin"], "the writer's layout holds hashes");
      const real = runtime.ctx.canWriteDisk;
      runtime.ctx.canWriteDisk = () => false;
      try {
        const { key, record } = entryFor(owner, manifestDocId, "note.md");
        deliverManifest(owner, manifestDocId, (files) => files.set(key, { ...record, path: "renamed.md" }));
        await sleep(500);
        await project.whenIdle();
        assert.deepEqual(Object.keys(hashes()).sort(), Object.keys(before).sort(), "the layout was not rebuilt from the manifest");
        assert.equal(hashes()["data.bin"], before["data.bin"], "an unrelated file keeps its hash");
        assert.ok(existsSync(path.join(root, "note.md")), "the disk is untouched while the lease is lapsed");
        assert.ok(!existsSync(path.join(root, "renamed.md")));
      } finally {
        runtime.ctx.canWriteDisk = real;
      }
      runtime.leaseConfirmed();
      await until(() => existsSync(path.join(root, "renamed.md")), "the deferred pass to run once the lease is confirmed");
      await project.whenIdle();
      assert.ok(!existsSync(path.join(root, "note.md")));
      assert.equal(hashes()["data.bin"], before["data.bin"]);
      assert.ok(hashes()["renamed.md"], "the moved file keeps its hash");
      assert.deepEqual(archived(root), [], "nothing was archived");
    });

    await t.test("C4: a cancelled write of a new file leaves it out of the layout and on disk", async () => {
      let fired = false;
      const original = runtime.createFromDisk.bind(runtime);
      runtime.createFromDisk = async (...args: unknown[]) => {
        const created = await original(...args);
        // The socket reconnects while the upload was in flight: the manifest write is cancelled.
        runtime.manifestCaughtUp = () => false;
        fired = true;
        return created;
      };
      try {
        writeTree(root, { "fresh.md": "brand new\n" });
        await until(() => fired, "the new file to be imported", 15_000);
        await sleep(100);
        assert.ok(!Object.values(runtime.state.layout).some((record) => record.path === "fresh.md"), "the layout does not hold a file the manifest never got");
      } finally {
        delete (runtime as Partial<Internals>).manifestCaughtUp;
        delete (runtime as Partial<Internals>).createFromDisk;
      }
      await runtime.enqueue(() => runtime.applyManifestPass());
      await project.whenIdle();
      assert.equal(readFileSync(path.join(root, "fresh.md"), "utf8"), "brand new\n", "the user's file is still there");
      assert.ok(!archived(root).some((name) => name.startsWith("fresh")), "and was not archived");
      assert.ok(!runtime.retired.has("fresh.md"), "its path was not retired");
    });

    await t.test("H2: a rollback that brings no state clears the rebuilt flag", async () => {
      await owner.service.fileOp(shared.projectId, { op: "create-file", path: "empty.md", content: "" });
      await until(() => Object.values(runtime.state.layout).some((record) => record.path === "empty.md" && record.docId), "the empty document to be placed");
      await project.whenIdle();
      const docId = Object.values(runtime.state.layout).find((record) => record.path === "empty.md")!.docId!;
      const doc = runtime.docs.get(docId)!;
      doc.hub.rollback("content", "invalid", "audit");
      assert.equal(doc.rebuilt, true, "a rollback marks the document rebuilt");
      await until(() => doc.hub.caughtUp, "the rolled-back document to hear the server again");
      await until(() => runtime.docReady(doc), "the rebuilt flag to clear", 5_000);
      assert.equal(doc.rebuilt, false);
      assert.equal(runtime.docReady(doc), true);
    });

    await t.test("H2: a rollback of the manifest that brings no state clears the rebuilt flag", async () => {
      const hub = owner.host.acquire(manifestDocId);
      try {
        // The server's answer carries nothing new: Yjs raises no update for it.
        hub.rollback("manifest", "invalid", "audit");
        assert.equal(runtime.manifestRebuilt, true);
        await until(() => hub.caughtUp, "the manifest to hear the server again");
        await until(() => runtime.manifestReady(), "the manifest's rebuilt flag to clear", 5_000);
        assert.equal(runtime.manifestRebuilt, false);
      } finally {
        owner.host.release(manifestDocId);
      }
    });

    await t.test("M10: an archive that cannot reach the root is cancelled, not dropped", async () => {
      const record = Object.values(runtime.state.layout).find((entry) => entry.path === "gone.md")!;
      const real = runtime.rootAvailable;
      runtime.rootAvailable = async () => false;
      try {
        await assert.rejects(runtime.archiveRemoved(record), WriteCancelledError);
      } finally {
        runtime.rootAvailable = real;
      }
    });

    await t.test("M10: a removal whose archive hits an unavailable root keeps its layout record until it is archived", async () => {
      await project.whenIdle();
      const { key } = entryFor(owner, manifestDocId, "gone.md");
      let calls = 0;
      const real = runtime.rootAvailable;
      // Available for the pass's own check, gone by the time the entry is archived.
      runtime.rootAvailable = async () => (calls += 1) <= 1;
      try {
        deliverManifest(owner, manifestDocId, (files) => files.delete(key));
        await until(() => calls >= 2, "the pass to reach the archive");
        await sleep(100);
        assert.ok(Object.values(runtime.state.layout).some((entry) => entry.path === "gone.md"), "the record is kept for a retry");
        assert.ok(existsSync(path.join(root, "gone.md")), "the file is still where it was");
      } finally {
        runtime.rootAvailable = real;
      }
      await until(() => archived(root).some((name) => name.startsWith("gone")), "the retry to archive it");
      await project.whenIdle();
      assert.ok(!existsSync(path.join(root, "gone.md")));
      assert.ok(!Object.values(runtime.state.layout).some((entry) => entry.path === "gone.md"));
    });

    await t.test("M23: a local manifest edit is retired and recorded as a move only once the server has it", async () => {
      const hub = owner.host.acquire(manifestDocId);
      try {
        await project.whenIdle();
        const { key, record } = entryFor(owner, manifestDocId, "data.bin");
        const recorded = () => (runtime.recordedPaths.get(key) as { path: string } | undefined)?.path;
        assert.equal(recorded(), "data.bin");
        const retired = () => (owner.host.store as unknown as { retiredPaths(projectId: string): Map<string, Set<string>> }).retiredPaths(shared.projectId);
        assert.ok(!retired().has("data.bin"));
        // The socket is between connections: the edit is in memory and unacknowledged.
        runtime.manifestCaughtUp = () => false;
        try {
          hub.applyLocalChange("manifest", (doc) => {
            doc.getMap<unknown>(ManifestKeys.files).set(key, { ...record, path: "moved.bin" });
          }, { source: "typing" });
          await sleep(300);
          assert.ok(!retired().has("data.bin"), "no retirement before the server has the edit");
          assert.equal(recorded(), "data.bin", "no transition before the server has the edit");
        } finally {
          delete (runtime as Partial<Internals>).manifestCaughtUp;
        }
        // The socket is back: the next edit goes out and its acknowledgement is what releases the deferred work.
        hub.applyLocalChange("manifest", (doc) => {
          doc.getMap<unknown>(ManifestKeys.files).set(key, { ...record, path: "moved.bin", updatedAt: Date.now() });
        }, { source: "typing" });
        await until(() => retired().has("data.bin") && recorded() === "moved.bin", `the acknowledged edit to be retired and recorded (${[...retired().keys()]} / ${recorded()} / pending ${hub.pendingCount} / ${runtime.manifestCaughtUp()})`, 15_000);
        assert.ok((retired().get("data.bin")?.size ?? 0) > 0, "with the bytes it held, not a zero-hash row");
      } finally {
        owner.host.release(manifestDocId);
      }
    });
  } finally {
    if (peer) await closePeer(peer).catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
