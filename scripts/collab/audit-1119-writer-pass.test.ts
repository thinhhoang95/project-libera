// Audit 2026-11-19, package P2 (writer materialization pass): a removal that can
// still roll back must not tombstone a document (finding 3), a move only carries
// the entry's own bytes and never replaces its destination (finding 4), and a
// failed move or archive leaves a pending state a later pass retries (finding 29).

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, promises as fs, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as Y from "yjs";

import { STATE_DIRECTORY } from "../../electron/collab/notebooks/fs-ops";
import { MOVE_CONFLICT_GRACE_MS, placeStagedMoves, writeMoveJournal } from "../../electron/collab/notebooks/move-journal";
import { MessageType } from "../../src/lib/collab/protocol/messages";
import { ManifestKeys } from "../../src/lib/collab/protocol/schema";
import { closePeer, makePeer, register, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

let seq = 1_000_000;

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
    hub.handleRemote({ type: MessageType.Remote, docId: manifestDocId, subdoc: "manifest", serverSeq: seq, update, userId: "", clientId: "audit-1119" });
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

test("audit 1119 P2: writer materialization pass", { timeout: 240_000 }, async (t) => {
  const temp = tempRoot("libera-audit-1119-p2-");
  const server = await startServerProcess();
  let peer: Peer | undefined;
  const locked: string[] = [];
  try {
    const auth = await register(server, "WriterPass");
    peer = await makePeer(temp.dir, "owner", server, auth, { timings: { pollMs: 5_000, retryMs: 300 } });
    const owner = peer;
    const root = path.join(owner.library, "Pass");
    writeTree(root, { "note.md": "mine\n", "data.bin": Buffer.from("blob mine"), "sub/keep.md": "kept\n", "sub/other.md": "other\n", "b.md": "bee\n" });
    const shared = await owner.service.share({ notebook: "Pass" });
    const project = owner.service.project(shared.projectId)!;
    await project.whenIdle();
    const manifestDocId = project.info.manifestDocId;
    const noteDoc = owner.service.resolvePath("Pass/note.md")!.docId;

    await t.test("finding 3: a local removal that rolls back leaves the document openable", async () => {
      const { key, record } = entryFor(owner, manifestDocId, "note.md");
      deliverManifest(owner, manifestDocId, (files) => files.delete(key));
      await until(() => archived(root).some((name) => name.startsWith("note")), "the removal to be applied");
      await project.whenIdle();
      assert.notEqual(owner.host.store.getDocMeta(noteDoc)?.readOnlyReason, "document-deleted", "a removal the server has not confirmed is not a tombstone");
      deliverManifest(owner, manifestDocId, (files) => files.set(key, record));
      await until(() => existsSync(path.join(root, "note.md")), "the restored entry to be written again");
      await project.whenIdle();
      const hub = owner.host.acquire(noteDoc);
      try {
        assert.equal(hub.getMeta().readOnlyReason, undefined);
        hub.applyLocalChange("content", (doc) => doc.getText("content").insert(0, "still editable "));
      } finally {
        owner.host.release(noteDoc);
      }
    });

    await t.test("finding 3: a tombstone left by an earlier removal is cleared when the manifest lists the document", async () => {
      const hub = owner.host.acquire(noteDoc);
      try {
        hub.markDeleted();
        assert.equal(owner.host.store.getDocMeta(noteDoc)?.readOnlyReason, "document-deleted");
        await owner.service.fileOp(shared.projectId, { op: "create-file", path: "poke.md", content: "poke\n" });
        await until(() => owner.host.store.getDocMeta(noteDoc)?.readOnlyReason !== "document-deleted", "the tombstone to be cleared");
        assert.equal(hub.getMeta().readOnlyReason, undefined);
      } finally {
        owner.host.release(noteDoc);
      }
    });

    await t.test("finding 4: a move leaves a different file at the old name alone", async () => {
      await project.whenIdle();
      const base = readFileSync(path.join(root, "note.md"), "utf8");
      const { key, record } = entryFor(owner, manifestDocId, "note.md");
      // A sync client reused the old name for new content just before the rename arrived.
      writeFileSync(path.join(root, "note.md"), "someone else's new file\n");
      deliverManifest(owner, manifestDocId, (files) => files.set(key, { ...record, path: "renamed.md" }));
      await until(() => existsSync(path.join(root, "renamed.md")), "the renamed file to be written");
      await project.whenIdle();
      assert.equal(readFileSync(path.join(root, "renamed.md"), "utf8"), base, "the entry is materialized from authority at its destination");
      assert.ok(existsSync(path.join(root, "note.md")) || archived(root).length > 0);
      const stray = [path.join(root, "note.md"), ...archived(root).map((name) => path.join(root, "_archive", name))].some((file) => existsSync(file) && readFileSync(file, "utf8") === "someone else's new file\n");
      assert.ok(stray, "the other file was kept, not moved into the entry's new place");
    });

    await t.test("finding 4: the same holds for a binary file", async () => {
      await project.whenIdle();
      const { key, record } = entryFor(owner, manifestDocId, "data.bin");
      writeFileSync(path.join(root, "data.bin"), "a different binary");
      deliverManifest(owner, manifestDocId, (files) => files.set(key, { ...record, path: "moved.bin" }));
      await until(() => existsSync(path.join(root, "moved.bin")), "the moved binary to be placed");
      await project.whenIdle();
      assert.equal(readFileSync(path.join(root, "moved.bin"), "utf8"), "blob mine");
    });

    await t.test("finding 29: a move that cannot stage keeps the old path until it can", async () => {
      await project.whenIdle();
      const { key, record } = entryFor(owner, manifestDocId, "sub/keep.md");
      const directory = path.join(root, "sub");
      chmodSync(directory, 0o555);
      locked.push(directory);
      deliverManifest(owner, manifestDocId, (files) => files.set(key, { ...record, path: "sub/kept-now.md" }));
      await new Promise((resolve) => setTimeout(resolve, 700));
      await project.whenIdle();
      assert.ok(owner.service.resolvePath("Pass/sub/keep.md"), "the layout stays at the path the bytes are at");
      assert.equal(owner.service.resolvePath("Pass/sub/kept-now.md"), null);
      chmodSync(directory, 0o755);
      await until(() => existsSync(path.join(root, "sub", "kept-now.md")), "the pending move to be retried");
      await project.whenIdle();
      assert.ok(!existsSync(path.join(root, "sub", "keep.md")));
      assert.equal(readFileSync(path.join(root, "sub", "kept-now.md"), "utf8"), "kept\n");
      assert.ok(owner.service.resolvePath("Pass/sub/kept-now.md"));
    });

    await t.test("finding 29: one failing archive does not stop the other removals, and is retried", async () => {
      await project.whenIdle();
      const stuck = entryFor(owner, manifestDocId, "sub/other.md");
      const free = entryFor(owner, manifestDocId, "b.md");
      const directory = path.join(root, "sub");
      chmodSync(directory, 0o555);
      locked.push(directory);
      deliverManifest(owner, manifestDocId, (files) => { files.delete(stuck.key); files.delete(free.key); });
      await until(() => archived(root).some((name) => name.startsWith("b")), "the removable file to be archived despite the other failing");
      assert.ok(existsSync(path.join(root, "sub", "other.md")), "the blocked file is still there");
      chmodSync(directory, 0o755);
      await until(() => !existsSync(path.join(root, "sub", "other.md")), "the blocked archive to be retried");
      assert.ok(archived(root).some((name) => name.startsWith("other")));
    });
  } finally {
    for (const directory of locked) { try { chmodSync(directory, 0o755); } catch { /* gone */ } }
    if (peer) await closePeer(peer).catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});

async function stage(root: string, fileId: string, destination: string, bytes: string, stagedAt: number): Promise<{ staged: string; journal: string }> {
  const moving = path.join(root, ...STATE_DIRECTORY, "moving");
  mkdirSync(moving, { recursive: true });
  const staged = `${fileId}-move_x`;
  writeFileSync(path.join(moving, staged), bytes);
  await writeMoveJournal(root, { fileId, source: "old.md", destination, staged, stagedAt });
  return { staged: path.join(moving, staged), journal: path.join(moving, `${staged}.journal`) };
}

test("finding 29: staged bytes are retried by the journal and never replace a destination", async () => {
  const temp = tempRoot("libera-audit-1119-journal-");
  try {
    const root = temp.dir;
    const now = 10_000_000;
    const one = await stage(root, "fil_one", "new.md", "staged bytes\n", now);
    writeFileSync(path.join(root, "new.md"), "occupant\n");
    // A taken destination keeps the bytes and the journal.
    let results = await placeStagedMoves(root, new Map([["fil_one", "new.md"]]), undefined, { now: now + 1000 });
    assert.deepEqual([...results.waiting], ["fil_one"]);
    assert.equal(readFileSync(one.staged, "utf8"), "staged bytes\n");
    assert.equal(readFileSync(path.join(root, "new.md"), "utf8"), "occupant\n");
    // Once the destination is free, a later pass places them (even at a newer wanted path).
    await fs.rm(path.join(root, "new.md"));
    results = await placeStagedMoves(root, new Map([["fil_one", "newer/name.md"]]), undefined, { now: now + 2000 });
    assert.deepEqual(results.placed.map((item) => [item.destination, item.outcome]), [["newer/name.md", "placed"]]);
    assert.equal(readFileSync(path.join(root, "newer", "name.md"), "utf8"), "staged bytes\n");
    assert.ok(!existsSync(one.journal) && !existsSync(one.staged));

    // A destination that stays taken is waited out, then the bytes are archived, never written over it.
    const two = await stage(root, "fil_two", "held.md", "second\n", now);
    writeFileSync(path.join(root, "held.md"), "still there\n");
    results = await placeStagedMoves(root, new Map([["fil_two", "held.md"]]), undefined, { now: now + MOVE_CONFLICT_GRACE_MS });
    assert.deepEqual(results.placed.map((item) => item.outcome), ["archived"]);
    assert.equal(readFileSync(path.join(root, "held.md"), "utf8"), "still there\n");
    assert.equal(readFileSync(path.join(root, "_archive", "held (interrupted move).md"), "utf8"), "second\n");
    assert.ok(!existsSync(two.journal) && !existsSync(two.staged));

    // The same bytes already at the destination drop the staged copy; a file the manifest lost is archived.
    await stage(root, "fil_three", "same.md", "same\n", now);
    writeFileSync(path.join(root, "same.md"), "same\n");
    await stage(root, "fil_gone", "gone.md", "orphan\n", now);
    results = await placeStagedMoves(root, new Map([["fil_three", "same.md"]]), undefined, { now: now + 1 });
    assert.deepEqual(results.placed.map((item) => item.outcome).sort(), ["archived", "duplicate-removed"]);
    assert.equal(readFileSync(path.join(root, "_archive", "gone (interrupted move).md"), "utf8"), "orphan\n");
  } finally { temp.cleanup(); }
});
