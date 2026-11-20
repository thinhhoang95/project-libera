// Collaboration integrity review 2026-11-20, package H3 (materialization and the
// host's core durability): S46 (source proof for a staged move), S47 (a displaced
// local-only file keeps an identity-bound mapping), S48 (a stage survives until a
// caught-up manifest decides), S50 (oversized updates are cut, never retried in a
// loop), S52 (folder placement is confirmed), S53 (catch-up is per generation),
// S54 (a change only in memory is not a success), S55 (a failed durable step in
// Opened reopens on a backoff).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import * as Y from "yjs";

import { MessageType, type AckMessage, type OpenedMessage, type UpdateMessage } from "../../src/lib/collab/protocol/messages";
import { DocHub, type HubTransport } from "../../electron/collab/core/doc-hub";
import { splitUpdate } from "../../electron/collab/core/outbound";
import { HostStore } from "../../electron/collab/core/store";
import { ControlError } from "../../electron/collab/control/types";
import { STATE_DIRECTORY } from "../../electron/collab/notebooks/fs-ops";
import { entryRecord } from "../../electron/collab/notebooks/layout";
import { ManifestIntents } from "../../electron/collab/notebooks/manifest-intents";
import { placeStagedMoves, writeMoveJournal } from "../../electron/collab/notebooks/move-journal";
import { SharedProject } from "../../electron/collab/notebooks/project";
import { ManualClock, quietLogger, settle, tempDir } from "./support/host-helpers";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const EMPTY = Y.encodeStateVector(new Y.Doc());

function fakeTransport() {
  const sent: UpdateMessage[] = [];
  let reopens = 0;
  const transport: HubTransport = {
    send: (message) => { sent.push(message); return true; },
    sendAwareness: () => {},
    reopen: () => { reopens += 1; },
  };
  return { transport, sent, reopens: () => reopens };
}

function opened(docId: string, subdoc: "content" | "manifest", serverSeq = 1): OpenedMessage {
  return { type: MessageType.Opened, docId, projectId: "p1", role: "editor", schemaVersion: 1, serverSeq, subdocs: [{ subdoc, diff: new Uint8Array(), stateVector: EMPTY }] };
}

// A SharedProject without its constructor: only the fields a tested method reads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bare = (fields: Record<string, unknown>): any => Object.assign(Object.create(SharedProject.prototype), fields);

// ------------------------------------------------------------------ S50

test("S50: splitUpdate cuts an oversized single-client update into pieces that rebuild the same state", () => {
  const source = new Y.Doc();
  const files = source.getMap("files");
  source.transact(() => { for (let index = 0; index < 400; index += 1) files.set(`k${index}`, { p: index }); });
  const base = Y.encodeStateAsUpdate(source);
  let update: Uint8Array = new Uint8Array();
  source.on("update", (value: Uint8Array) => { update = value; });
  source.transact(() => {
    for (let index = 0; index < 1500; index += 1) files.set(`k${index}`, { path: `a/long/path/number/${index}.md`, kind: "doc", n: index });
    files.delete("k3");
  });
  const pieces = splitUpdate(update, 8_000);
  assert.ok(pieces && pieces.length > 4, "several pieces");
  assert.ok(pieces.every((piece) => piece.length < 16_000));
  const peer = new Y.Doc();
  Y.applyUpdate(peer, base);
  for (const piece of pieces) Y.applyUpdate(peer, piece);
  assert.deepEqual(peer.getMap("files").toJSON(), files.toJSON());
  assert.equal(peer.store.pendingStructs, null);
  assert.equal(peer.store.pendingDs, null);
  // A single struct bigger than a piece cannot be cut: reported as uncuttable, not guessed at.
  const big = new Y.Doc();
  let bigUpdate: Uint8Array = new Uint8Array();
  big.on("update", (value: Uint8Array) => { bigUpdate = value; });
  big.getText("t").insert(0, "x".repeat(50_000));
  assert.equal(splitUpdate(bigUpdate, 8_000), null);
});

test("S50: an oversized manifest update is sent as acknowledged pieces, pending until the last is acknowledged", async () => {
  const store = new HostStore({ path: ":memory:" });
  const hub = new DocHub({ docId: "m1", kind: "manifest", store, logger: quietLogger, limits: { maxUpdateBytes: 6_000, batchMaxBytes: 1 } });
  const link = fakeTransport();
  hub.connectionChanged(link.transport);
  hub.handleOpened(opened("m1", "manifest"));
  hub.applyLocalChange("manifest", (doc) => {
    const files = doc.getMap("files");
    for (let index = 0; index < 300; index += 1) files.set(`f${index}`, { path: `dir/with/a/long/name/${index}.md`, kind: "doc", n: index });
  });
  await hub.flushOutbound();
  await settle();
  assert.ok(link.sent.length > 1, `cut into pieces: ${link.sent.length}`);
  assert.ok(link.sent.every((message) => message.update.length <= 6_000), "nothing over the limit reaches the socket");
  assert.equal(hub.syncBlockedDetail, undefined, "nothing is quarantined: the document is not blocked");
  const server = new Y.Doc();
  for (const message of link.sent) Y.applyUpdate(server, message.update);
  assert.deepEqual(server.getMap("files").toJSON(), hub.getDoc("manifest").getMap("files").toJSON());
  for (const message of link.sent.slice(0, -1)) hub.handleAck({ type: MessageType.Ack, docId: "m1", clientSeq: message.clientSeq, serverSeq: 1 } as AckMessage);
  assert.equal(hub.pendingCount, 1, "still pending until the last piece is acknowledged");
  const last = link.sent[link.sent.length - 1];
  hub.handleAck({ type: MessageType.Ack, docId: "m1", clientSeq: last.clientSeq, serverSeq: 2 } as AckMessage);
  assert.equal(hub.pendingCount, 0);
  hub.close();
  store.close();
});

test("S50: an uncuttable update is reported once and never retried in a loop", async () => {
  const store = new HostStore({ path: ":memory:" });
  const hub = new DocHub({ docId: "d1", store, logger: quietLogger, limits: { maxUpdateBytes: 2_000, batchMaxBytes: 1 } });
  const link = fakeTransport();
  hub.connectionChanged(link.transport);
  hub.handleOpened(opened("d1", "content"));
  hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, "x".repeat(9_000)));
  for (let round = 0; round < 5; round += 1) { await hub.flushOutbound(); await settle(); }
  assert.equal(link.sent.length, 0, "nothing is sent for it");
  assert.ok(hub.syncBlockedDetail?.includes("cannot be synced"), "visible error");
  hub.close();
  store.close();
});

// ------------------------------------------------------------------ S55 and S53

test("S55: a failed durable step in Opened leaves the document in catch-up and reopens on a doubling, capped backoff", () => {
  const clock = new ManualClock();
  const store = new HostStore({ path: ":memory:" });
  const hub = new DocHub({ docId: "d1", store, logger: quietLogger, clock });
  const link = fakeTransport();
  hub.connectionChanged(link.transport);
  const real = store.noteServerSeq.bind(store);
  let failures = 2;
  store.noteServerSeq = (...args: Parameters<typeof real>) => {
    if (failures > 0) { failures -= 1; throw new Error("SQLITE_BUSY"); }
    return real(...args);
  };
  assert.doesNotThrow(() => hub.handleOpened(opened("d1", "content")));
  assert.equal(hub.hasOpened, false);
  assert.equal(hub.caughtUp, false, "an explicit catch-up state");
  assert.ok(hub.getStatus().detail, "status says why");
  clock.advance(999);
  assert.equal(link.reopens(), 0);
  clock.advance(1);
  assert.equal(link.reopens(), 1, "first retry after 1 s");
  hub.handleOpened(opened("d1", "content"));
  assert.equal(hub.hasOpened, false);
  clock.advance(1_999);
  assert.equal(link.reopens(), 1, "the second wait is doubled");
  clock.advance(1);
  assert.equal(link.reopens(), 2);
  hub.handleOpened(opened("d1", "content"));
  assert.equal(hub.hasOpened, true);
  assert.equal(hub.caughtUp, true);
  hub.close();
  store.close();
});

test("S55: a failed metadata write in Opened is retried too", () => {
  const clock = new ManualClock();
  const store = new HostStore({ path: ":memory:" });
  const hub = new DocHub({ docId: "d1", store, logger: quietLogger, clock });
  const link = fakeTransport();
  hub.connectionChanged(link.transport);
  const real = store.updateDocMeta.bind(store);
  let failures = 1;
  store.updateDocMeta = (...args: Parameters<typeof real>) => {
    if (failures > 0) { failures -= 1; throw new Error("SQLITE_BUSY"); }
    return real(...args);
  };
  hub.handleOpened(opened("d1", "content"));
  assert.equal(hub.caughtUp, false);
  clock.advance(1_000);
  assert.equal(link.reopens(), 1);
  hub.handleOpened(opened("d1", "content"));
  assert.equal(hub.caughtUp, true);
  hub.close();
  store.close();
});

test("S53: caught up is per generation: a new connection, and a rollback, reset it until the server answered again", () => {
  const store = new HostStore({ path: ":memory:" });
  const hub = new DocHub({ docId: "d1", store, logger: quietLogger });
  const link = fakeTransport();
  assert.equal(hub.caughtUp, false, "never opened");
  hub.connectionChanged(link.transport);
  assert.equal(hub.caughtUp, false, "connected but not answered");
  hub.handleOpened(opened("d1", "content"));
  assert.equal(hub.caughtUp, true);
  const first = hub.catchUpGeneration;
  hub.connectionChanged(null, "offline");
  assert.equal(hub.caughtUp, true, "an offline writer keeps what it already heard");
  hub.connectionChanged(link.transport);
  assert.equal(hub.caughtUp, false, "the replacement connection has not been heard yet");
  assert.ok(hub.catchUpGeneration > first);
  hub.handleOpened(opened("d1", "content", 2));
  assert.equal(hub.caughtUp, true);
  hub.rollback("content", "invalid-update", "rejected");
  assert.equal(hub.caughtUp, false, "rolled back: the replacement state is still loading");
  hub.handleOpened(opened("d1", "content", 3));
  assert.equal(hub.caughtUp, true);
  hub.close();
  store.close();
});

// ------------------------------------------------------------------ S54

test("S54: a manifest change SQLite refused is not reported as saved, and disk work waits for the retry", () => {
  const clock = new ManualClock();
  const store = new HostStore({ path: ":memory:" });
  const hub = new DocHub({ docId: "m1", kind: "manifest", store, logger: quietLogger, clock });
  const project = bare({
    info: { album: false, follower: false }, ctx: {}, manifestHub: hub, manifestIntents: new ManifestIntents(),
    caughtUp: new Map(), entries: new Map(), durableWaiting: false,
  });
  const real = store.appendLocal.bind(store);
  let failing = true;
  store.appendLocal = (...args: Parameters<typeof real>) => {
    if (failing) throw new Error("SQLITE_BUSY");
    return real(...args);
  };
  const entry = { fileId: "fil1", path: "a.png", kind: "blob", blobHash: sha("x"), size: 1, createdBy: "u", createdAt: 1, updatedAt: 1 } as const;
  return project.writeManifest((map: Y.Map<unknown>) => map.set(entry.fileId, entryRecord(entry)), { source: "typing" }).then(
    () => assert.fail("must not report success"),
    (error: unknown) => {
      assert.ok(error instanceof ControlError);
      assert.equal(error.status, 503);
      assert.equal(error.code, "not-saved");
      assert.equal(hub.unpersistedCount, 1, "applied in memory only");
      assert.equal(project.durableWaiting, true, "disk work and follow-up are held");
      assert.equal(hub.flushDurable(), false);
      failing = false;
      assert.equal(hub.flushDurable(), true, "durable once SQLite takes it");
      assert.equal(hub.unpersistedCount, 0);
      hub.close();
      store.close();
    },
  );
});

test("S54: an automatic import (scan) is not failed by an undurable change but holds disk work", async () => {
  const store = new HostStore({ path: ":memory:" });
  const hub = new DocHub({ docId: "m1", kind: "manifest", store, logger: quietLogger });
  const link = fakeTransport();
  hub.connectionChanged(link.transport);
  hub.handleOpened(opened("m1", "manifest"));
  const project = bare({
    info: { album: false, follower: false }, ctx: {}, manifestHub: hub, manifestIntents: new ManifestIntents(),
    caughtUp: new Map(), entries: new Map(), durableWaiting: false,
  });
  const real = store.appendLocal.bind(store);
  store.appendLocal = () => { throw new Error("SQLITE_BUSY"); };
  await project.writeManifest((map: Y.Map<unknown>) => map.set("fil2", { fileId: "fil2", path: "b.png", kind: "folder", createdBy: "u", createdAt: 1, updatedAt: 1 }), { source: "external-file" });
  assert.equal(project.durableWaiting, true);
  store.appendLocal = real;
  hub.close();
  store.close();
});

// ------------------------------------------------------------------ S46

test("S46: a replacement with the same size and mtime is not the entry's content; the move is fenced to the verified source", async () => {
  const dir = tempDir("libera-h3-s46-");
  try {
    const source = path.join(dir.dir, "a.bin");
    writeFileSync(source, "old-bytes");
    const stats = (await import("node:fs")).statSync(source);
    const record = { path: "a.bin", kind: "blob", hash: sha("old-bytes"), size: stats.size, mtimeMs: stats.mtimeMs };
    const project = bare({ info: { root: dir.dir }, diskGuard: () => ({ root: dir.dir, canCommit: async () => true }) });
    const proof = await project.holdsOwnBytes(source, record);
    assert.ok(proof && proof.hash === sha("old-bytes"), "the entry's own bytes are proven by hash");
    const guard = project.sourceGuard(source, proof.key);
    assert.equal(await guard.canCommit(), true);
    // Replaced after the hash observation: the stage operation refuses.
    writeFileSync(source, "new-bytes");
    assert.equal(await guard.canCommit(), false, "a replaced source is not moved");
    // Same size, same mtime, other bytes: the old stat shortcut accepted this.
    writeFileSync(source, "evil-bytz");
    utimesSync(source, stats.atime, stats.mtime);
    assert.equal(await project.holdsOwnBytes(source, record), false);
  } finally {
    dir.cleanup();
  }
});

// ------------------------------------------------------------------ S47

test("S47: a local-only file archived for an incoming entry gets an identity-bound mapping and a move for Next", async () => {
  const dir = tempDir("libera-h3-s47-");
  try {
    writeFileSync(path.join(dir.dir, "b.png"), "local annotated image");
    const emitted: unknown[] = [];
    let saved = 0;
    const store = new HostStore({ path: ":memory:" });
    const project = bare({
      info: { root: dir.dir, album: false, projectId: "p1", notebook: "NB" },
      state: { layout: {}, reconciliations: [] },
      ctx: { emit: (event: unknown) => emitted.push(event), host: { store }, logger: quietLogger },
      diskGuard: () => ({ root: dir.dir, canCommit: async () => true }),
      saveSoon: () => { saved += 1; },
      liberaPath: (relative: string) => `NB/${relative}`,
    });
    const archivedAs = await project.archive("b.png");
    assert.equal(archivedAs, "_archive/b.png");
    project.displacedPath("b.png", archivedAs);
    assert.equal(project.state.displaced.length, 1);
    assert.equal(project.state.displaced[0].from, "b.png");
    assert.equal(project.state.displaced[0].to, "_archive/b.png");
    assert.ok(saved > 0);
    const event = emitted[0] as { t: string; moves: Array<{ from: string; to: string; fileId: string }> };
    assert.equal(event.t, "tree-changed");
    assert.deepEqual(event.moves.map((move) => [move.from, move.to]), [["NB/b.png", "NB/_archive/b.png"]]);
    assert.match(event.moves[0].fileId, /^displaced-[0-9a-f]{24}$/);
    // Wiring (H3 to B2): the same move is in the durable transition log, in the same table and sequence as the manifest's moves, so Next's next drain moves the records with the displaced file.
    const logged = store.transitionsAfter("p1");
    assert.deepEqual(logged.map((row) => [row.fileId, row.kind, row.from, row.to]), [[event.moves[0].fileId, "file", "b.png", "_archive/b.png"]]);
    // Nothing archived: nothing to tell.
    project.displacedPath("c.png", null);
    assert.equal(emitted.length, 1);
    assert.equal(store.transitionsAfter("p1").length, 1);
  } finally {
    dir.cleanup();
  }
});

// ------------------------------------------------------------------ S48

test("S48: a stage is placed at the entry's current destination, not the journal's obsolete one, and kept while the manifest still lists it", async () => {
  const dir = tempDir("libera-h3-s48-");
  try {
    const root = dir.dir;
    const moving = path.join(root, ...STATE_DIRECTORY, "moving");
    mkdirSync(moving, { recursive: true });
    writeFileSync(path.join(moving, "stage1"), "staged bytes");
    await writeMoveJournal(root, { fileId: "fil1", source: "a.md", destination: "b.md", staged: "stage1", hash: sha("staged bytes"), stagedAt: Date.now() });
    // A peer moved the same id again to c.md; b.md happens to hold identical bytes (the old startup recovery dropped the stage here).
    writeFileSync(path.join(root, "b.md"), "staged bytes");
    // Listed but not placeable now: kept.
    const kept = await placeStagedMoves(root, new Map(), undefined, { listed: new Set(["fil1"]) });
    assert.ok(kept.waiting.has("fil1"));
    assert.equal(existsSync(path.join(moving, "stage1")), true, "the stage survives");
    // A caught-up manifest supplies the current destination.
    const placed = await placeStagedMoves(root, new Map([["fil1", "c.md"]]));
    assert.equal(placed.placed[0]?.outcome, "placed");
    assert.equal(readFileSync(path.join(root, "c.md"), "utf8"), "staged bytes");
    // Removal confirmed (not listed anywhere): archived, never deleted.
    writeFileSync(path.join(moving, "stage2"), "other staged");
    await writeMoveJournal(root, { fileId: "fil2", source: "x.md", destination: "y.md", staged: "stage2", stagedAt: Date.now() });
    const removed = await placeStagedMoves(root, new Map(), undefined, { listed: new Set() });
    assert.equal(removed.placed[0]?.outcome, "archived");
    assert.ok(readdirSync(path.join(root, "_archive")).some((name) => name.includes("interrupted move")));
  } finally {
    dir.cleanup();
  }
  const source = readFileSync(path.join(process.cwd(), "electron/collab/notebooks/project.ts"), "utf8");
  assert.ok(!source.includes("recoverInterruptedMoves("), "opening a project no longer consumes stages before the manifest has caught up");
});

// ------------------------------------------------------------------ S52

test("S52: a folder counts as materialized only once its placement was confirmed; a failure has an actionable message", () => {
  const entries = new Map([["fil1", { fileId: "fil1", path: "empty", kind: "folder", createdBy: "u", createdAt: 1, updatedAt: 1 }]]);
  const project = bare({
    info: { follower: false }, ctx: {}, state: { layout: { fil1: { path: "empty", kind: "folder" } } },
    manifestReady: () => true, manifestCaughtUp: () => true, readEntries: () => entries,
    placedFolders: new Set<string>(), folderErrors: new Map<string, string>(),
  });
  assert.equal(project.isMaterialized(), false, "a record alone is not placement");
  project.placedFolders.add("empty");
  assert.equal(project.isMaterialized(), true);
  project.placedFolders.delete("empty");
  project.folderErrors.set("empty", "EACCES: permission denied");
  assert.equal(project.isMaterialized(), false);
  const problem = project.placementProblem() as string;
  assert.match(problem, /"empty"/);
  assert.match(problem, /permission denied/);
  assert.match(problem, /tries again/);
});
