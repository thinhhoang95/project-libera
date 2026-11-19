// Audit 2026-11-19, findings 8, 18 and 33: takedown fences server writes and
// lifts the fence when abandoned; transcripts move to and from the shared
// companion location with the notebook; a share whose manifest never reached
// the server stays pending, and big manifest writes are split.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { FetchLike } from "../../electron/collab/core";
import { manifestEntryBytes, MANIFEST_BATCH_BYTES, splitManifestBatches } from "../../electron/collab/notebooks/layout";
import { convertLocalTranscripts } from "../../electron/collab/notebooks/transcript-conversion";
import { ControlRoutes } from "../../src/lib/collab/local-api";
import { SyncLimits } from "../../src/lib/collab/protocol/version";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { readTranscript } from "../../src/lib/storage/transcripts";
import { TRANSCRIPT_VERSION, type Transcript } from "../../src/lib/transcription/types";
import {
  closePeer, invite, makePeer, readText, register, tempRoot, until, writeTree, type Peer,
} from "./support/notebooks-harness";
import { removeDataDir, startServerProcess, type ServerProcess } from "./support/server-process";

const TRANSCRIPT: Transcript = {
  version: TRANSCRIPT_VERSION,
  createdAt: "2026-10-19T10:00:00.000Z",
  audio: { size: 9, modifiedAt: "", duration: 12 },
  engine: { kind: "local", model: "Parakeet TDT 0.6B v3" },
  language: "en",
  diarization: null,
  speakers: [{ name: "Vy", talkSeconds: 10, share: 1, segments: 1 }],
  segments: [{ start: 1, end: 5, speaker: 0, text: "The budget is approved." }],
  stats: { words: 4, chunks: 1, elapsedMs: 5 },
};

test("finding 33: a large manifest write is split into transactions well under the update limit", () => {
  const entries = Array.from({ length: 20_000 }, (_, index) => ({
    fileId: `fil_${String(index).padStart(10, "0")}`,
    path: `folder-${index % 50}/a-fairly-long-file-name-for-a-large-notebook-${index}.md`,
    kind: "doc" as const,
    docId: `doc_${String(index).padStart(10, "0")}`,
    docKind: "markdown" as const,
    createdBy: "acc_00000000",
    createdAt: 1,
    updatedAt: 1,
  }));
  const batches = splitManifestBatches(entries, manifestEntryBytes);
  assert.ok(batches.length > 1, "one transaction would not fit");
  assert.equal(batches.flat().length, entries.length, "nothing is lost");
  assert.deepEqual(batches.flat().map((entry) => entry.fileId), entries.map((entry) => entry.fileId), "order is kept");
  for (const batch of batches) {
    assert.ok(batch.reduce((sum, entry) => sum + manifestEntryBytes(entry), 0) <= MANIFEST_BATCH_BYTES);
    assert.ok(MANIFEST_BATCH_BYTES * 8 < SyncLimits.maxUpdateBytes, "far below the server's limit");
  }
  assert.equal(splitManifestBatches([], manifestEntryBytes).length, 0);
  assert.equal(splitManifestBatches([1], () => MANIFEST_BATCH_BYTES * 3).length, 1, "an item over the budget still gets a batch of its own");
});

test("finding 18: initial share turns local transcript sidecars into companions beside the recordings", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "libera-share-transcripts-"));
  try {
    mkdirSync(path.join(root, "memos"), { recursive: true });
    writeFileSync(path.join(root, "memos", "talk.m4a"), "m4a audio");
    mkdirSync(path.join(root, ".libera", "transcripts", "by-path", "memos"), { recursive: true });
    writeFileSync(path.join(root, ".libera", "transcripts", "by-path", "memos", "talk.m4a.json"), JSON.stringify({ ...TRANSCRIPT, _liberaPendingShare: { create: true } }));
    // A sidecar whose recording is gone, and one that is not a transcript, stay local.
    writeFileSync(path.join(root, ".libera", "transcripts", "by-path", "gone.m4a.json"), JSON.stringify(TRANSCRIPT));
    writeFileSync(path.join(root, "other.m4a"), "m4a audio");
    writeFileSync(path.join(root, ".libera", "transcripts", "by-path", "other.m4a.json"), "{}");
    const guard = { root, canCommit: async () => true };
    const converted = await convertLocalTranscripts(root, guard);
    assert.deepEqual(converted.companions, ["memos/talk.m4a.transcript"]);
    const companion = JSON.parse(readFileSync(path.join(root, "memos", "talk.m4a.transcript"), "utf8")) as Record<string, unknown>;
    assert.equal(companion.version, TRANSCRIPT_VERSION);
    assert.equal(companion._liberaPendingShare, undefined, "the local pending mark does not travel");
    assert.equal(converted.sidecars.length, 1);
    // An existing companion is never replaced.
    writeFileSync(path.join(root, "memos", "talk.m4a.transcript"), "newer");
    await convertLocalTranscripts(root, guard);
    assert.equal(readFileSync(path.join(root, "memos", "talk.m4a.transcript"), "utf8"), "newer");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("finding 18: after a takedown the local reader finds the companion beside the recording", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "libera-takedown-transcript-"));
  const saved = process.env.LIBERA_DATA_DIR;
  const notebook = path.join(dataDir, "users", "admin", "Local");
  mkdirSync(notebook, { recursive: true });
  writeFileSync(path.join(notebook, "talk.m4a"), "m4a audio");
  // What takedown leaves: the shared companion, no marker, no local sidecar.
  writeFileSync(path.join(notebook, "talk.m4a.transcript"), JSON.stringify(TRANSCRIPT));
  process.env.LIBERA_DATA_DIR = dataDir;
  invalidateSharedNotebookCache();
  try {
    const read = await readTranscript("Local/talk.m4a");
    assert.equal(read.transcript?.speakers[0].name, "Vy");
    // Adopted as the local sidecar, so it follows renames and later edits.
    assert.ok(existsSync(path.join(notebook, ".libera", "transcripts", "by-path", "talk.m4a.json")));
  } finally {
    if (saved === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = saved;
    invalidateSharedNotebookCache();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("finding 33 and 18: a share whose manifest never reached the server stays pending, then completes with its transcripts", { timeout: 240_000 }, async () => {
  const temp = tempRoot("libera-share-unfinished-");
  // The host's timers do not keep the process alive; with the server gone nothing else would.
  const keepAlive = setInterval(() => undefined, 100);
  let server: ServerProcess = await startServerProcess();
  const { port, dataDir } = server;
  const peers: Peer[] = [];
  try {
    const aliceAuth = await register(server, "Alice");
    const bobAuth = await register(server, "Bob");
    // The server goes away right after the uploads, before the manifest can be sent.
    let killServer = false;
    const flaky: FetchLike = async (url, init) => {
      const response = await fetch(url, init);
      if (killServer && init.method === "GET" && /^\/v1\/projects\/[^/]+$/.test(new URL(url).pathname)) {
        killServer = false;
        void server.kill();
      }
      return response;
    };
    const alice = await makePeer(temp.dir, "alice", server, aliceAuth, { fetch: flaky });
    const bob = await makePeer(temp.dir, "bob", server, bobAuth);
    peers.push(alice, bob);
    (alice.service as unknown as { shareSyncTimeoutMs: number }).shareSyncTimeoutMs = 1_500;
    const root = path.join(alice.library, "Memos");
    writeTree(root, { "note.md": "A note\n", "talk.m4a": "m4a audio" });
    mkdirSync(path.join(root, ".libera", "transcripts", "by-path"), { recursive: true });
    writeFileSync(path.join(root, ".libera", "transcripts", "by-path", "talk.m4a.json"), JSON.stringify(TRANSCRIPT));

    killServer = true;
    const unfinished = await alice.router.call("POST", ControlRoutes.share, { notebook: "Memos" });
    assert.equal(unfinished.status, 503, JSON.stringify(unfinished.body));
    assert.equal((unfinished.body as { error: { code: string } }).error.code, "share-unfinished");
    assert.equal(existsSync(path.join(root, ".libera-shared.json")), false, "no marker for a share that never reached the server");
    assert.ok(existsSync(path.join(root, ".libera-share-pending.json")), "the share stays pending and retryable");
    assert.deepEqual(alice.service.localProjects(), []);

    server = await startServerProcess({ port, dataDir });
    (alice.service as unknown as { shareSyncTimeoutMs: number }).shareSyncTimeoutMs = 20_000;
    const finished = await alice.router.call("POST", ControlRoutes.share, { notebook: "Memos" });
    assert.equal(finished.status, 200, JSON.stringify(finished.body));
    assert.equal((finished.body as { synced: boolean }).synced, true);
    assert.ok(existsSync(path.join(root, ".libera-shared.json")));
    assert.ok(JSON.parse(readFileSync(path.join(root, "talk.m4a.transcript"), "utf8")).segments.length === 1, "the transcript is a shared companion beside the recording");
    assert.equal(existsSync(path.join(root, ".libera", "transcripts", "by-path", "talk.m4a.json")), false, "the stale local copy is gone");

    const { projectId } = finished.body as { projectId: string };
    const link = await invite(server, aliceAuth, projectId, "bob@example.test", "editor");
    const joined = await bob.router.call("POST", ControlRoutes.join, { invitation: link });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const bobRoot = path.join(bob.library, (joined.body as { notebook: string }).notebook);
    await until(() => existsSync(path.join(bobRoot, "talk.m4a.transcript")), "Bob to receive the shared transcript");
    assert.equal(readText(bobRoot, "note.md"), "A note\n");
  } finally {
    for (const peer of peers) await closePeer(peer).catch(() => undefined);
    await server.stop().catch(() => undefined);
    clearInterval(keepAlive);
    removeDataDir(dataDir);
    temp.cleanup();
  }
});

test("finding 8: takedown fences the server before deleting, and lifts the fence when it is abandoned", { timeout: 240_000 }, async () => {
  const temp = tempRoot("libera-takedown-fence-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const aliceAuth = await register(server, "Alice");
    const bobAuth = await register(server, "Bob");
    const calls: string[] = [];
    let failDelete = false;
    const recording: FetchLike = async (url, init) => {
      const route = new URL(url).pathname;
      if (/\/v1\/projects\/[^/]+\/closing$/.test(route)) calls.push(`${init.method} closing`);
      const deleting = init.method === "DELETE" && /\/v1\/projects\/[^/]+$/.test(route);
      if (deleting) {
        calls.push("DELETE project");
        if (failDelete) throw new TypeError("fetch failed (injected)");
      }
      return fetch(url, init);
    };
    const alice = await makePeer(temp.dir, "alice", server, aliceAuth, { fetch: recording });
    const bob = await makePeer(temp.dir, "bob", server, bobAuth);
    peers.push(alice, bob);
    const root = path.join(alice.library, "Research");
    writeTree(root, { "note.md": "Keep this note\n" });
    const shared = await alice.router.call("POST", ControlRoutes.share, { notebook: "Research" });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    const { projectId } = shared.body as { projectId: string };
    const link = await invite(server, aliceAuth, projectId, "bob@example.test", "editor");
    const joined = await bob.router.call("POST", ControlRoutes.join, { invitation: link });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const bobRoot = path.join(bob.library, (joined.body as { notebook: string }).notebook);
    await until(() => existsSync(path.join(bobRoot, "note.md")), "Bob's files to materialize");

    // The delete fails: the takedown is abandoned and the fence must not stay up.
    failDelete = true;
    const failed = await alice.router.call("DELETE", ControlRoutes.project(projectId));
    assert.equal(failed.status, 503);
    assert.deepEqual(calls, ["POST closing", "DELETE project", "DELETE closing"], "fence first, delete, then the fence is lifted");
    failDelete = false;
    // Edits are accepted again: Bob's change reaches Alice's copy.
    writeFileSync(path.join(bobRoot, "note.md"), "Keep this note\nBob's edit after the aborted takedown\n");
    await until(() => readText(root, "note.md")?.includes("Bob's edit") === true, "Bob's edit to be stored after the fence was lifted");

    calls.length = 0;
    const removed = await alice.router.call("DELETE", ControlRoutes.project(projectId));
    assert.equal(removed.status, 204, JSON.stringify(removed.body));
    assert.deepEqual(calls, ["POST closing", "DELETE project"], "a completed takedown has no fence to lift");
    assert.match(readText(root, "note.md") ?? "", /Bob's edit after the aborted takedown/, "the final export holds the latest text");
    assert.equal(existsSync(path.join(root, ".libera-shared.json")), false);
  } finally {
    for (const peer of peers) await closePeer(peer).catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
