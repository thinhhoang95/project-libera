// Battery: work that shared documents no longer do.
//
// - An acknowledgement wakes the durability channel but not the registry
//   version (which re-renders the whole window).
// - The comment projection keeps unchanged threads as the same objects, does
//   not wake comment listeners for edits that change no thread, and does not
//   materialize the source text for a document without comments.

import assert from "node:assert/strict";
import test from "node:test";

import * as Y from "yjs";

import { SharedDocRegistry } from "../../src/lib/collab/client/registry";
import type { ResolvedDoc } from "../../src/lib/collab/local-api";
import type { Thread, UserSummary } from "../../src/lib/collab/protocol/api";
import type { ThreadApi } from "../../src/lib/collab/review-store/api";
import { SharedReviewStore, type SharedReplicaLike } from "../../src/lib/collab/review-store/shared";
import type { SharedReviewProjection } from "../../src/lib/collab/review-store/types";

const docId = "doc_battery";
const resolved: ResolvedDoc = { docId, projectId: "p1", fileId: "f1", path: "Shared/note.md", kind: "markdown", role: "editor", readOnly: false };

test("an acknowledgement fires the durability listener without bumping the registry version", async () => {
  // A hand-driven port: the hub's messages are delivered by the test, so the
  // acknowledgement arrives alone, without the status pushes a real hub adds.
  const delivered = new Set<(event: { data: unknown }) => void>();
  const sent: Array<{ t: string; seq?: number }> = [];
  const port = {
    postMessage: (message: { t: string; seq?: number }) => { sent.push(message); },
    addEventListener: (_type: "message", listener: (event: { data: unknown }) => void) => { delivered.add(listener); },
    removeEventListener: (_type: "message", listener: (event: { data: unknown }) => void) => { delivered.delete(listener); },
    close: () => {},
  };
  const hub = (data: unknown) => { for (const listener of [...delivered]) listener({ data }); };
  const registry = new SharedDocRegistry({
    resolve: async () => resolved,
    attach: async () => port as never,
    subscribeEvents: () => () => {},
    replicaOptions: { schedule: queueMicrotask },
    available: () => true,
  });
  try {
    const { replica } = await registry.acquire(resolved, "tab:1").ready;
    hub({ t: "status", docId, status: { state: "saved-remote", pending: 0, oldestPendingAgeMs: 0, lastAckAt: null, connected: true } });
    let versionWakes = 0;
    let durabilityWakes = 0;
    let replicaWakes = 0;
    registry.subscribe(() => { versionWakes += 1; });
    registry.subscribeDurability(() => { durabilityWakes += 1; });
    replica.subscribe(() => { replicaWakes += 1; });
    const version = registry.getVersion();
    const snapshot = replica.getSnapshot();

    replica.ytext.insert(0, "abc");
    await Promise.resolve();
    const update = sent.find((message) => message.t === "update");
    assert.ok(update?.seq, "the edit was sent with a sequence number");
    assert.equal(registry.unconfirmedDocumentCount(), 1);

    hub({ t: "ack", docId, seq: update.seq });

    assert.equal(registry.unconfirmedDocumentCount(), 0);
    assert.equal(durabilityWakes, 1, "the unconfirmed count's observers hear of the acknowledgement");
    assert.equal(replicaWakes, 1, "replica.subscribe still wakes on an acknowledgement");
    assert.equal(registry.getVersion(), version, "the registry version did not change on the acknowledgement");
    assert.equal(versionWakes, 0, "version subscribers were not woken");
    assert.equal(replica.getSnapshot(), snapshot, "no snapshot field changed, so the snapshot keeps its identity");

    // Sync status alone leaves the version alone (the replica's own subscribers still hear it).
    hub({ t: "status", docId, status: { state: "offline", pending: 0, oldestPendingAgeMs: 0, lastAckAt: null, connected: false } });
    assert.equal(registry.getVersion(), version);
    assert.equal(replicaWakes, 2);

    // A structural snapshot change still bumps the version.
    hub({ t: "closed", docId, reason: "hub-shutdown" });
    assert.equal(registry.getVersion(), version + 1);
    assert.equal(versionWakes, 1);
  } finally {
    registry.destroy();
  }
});

const TEXT = "First paragraph about cats.\n\nSecond paragraph about dogs.\n";
const ALICE: UserSummary = { id: "acc_alice", displayName: "Alice", color: "#2563eb" };

function replica(): SharedReplicaLike {
  const content = new Y.Doc();
  const ytext = content.getText("source");
  ytext.insert(0, TEXT);
  return { ytext, annotations: new Y.Doc(), onRebuild: () => () => {} };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function fakeApi(overrides: Partial<ThreadApi>): ThreadApi {
  const never = () => new Promise<never>(() => {});
  return {
    list: async () => [],
    createThread: never,
    addMessage: never,
    editMessage: never,
    deleteMessage: never,
    setStatus: never,
    reattach: never,
    deleteThread: never,
    enqueue: never,
    commands: async () => ({ pending: [], failed: [] }),
    discard: async () => {},
    ...overrides,
  } as ThreadApi;
}

/** Counts ytext.toString() calls from now on. */
function countToString(ytext: Y.Text) {
  const original = ytext.toString.bind(ytext);
  const counter = { calls: 0 };
  ytext.toString = () => { counter.calls += 1; return original(); };
  return counter;
}

function newStore(shared: SharedReplicaLike, api: ThreadApi) {
  return new SharedReviewStore({
    docId: "doc_1", projectId: "prj_1", key: "Team/note.md", replica: shared,
    me: () => ALICE, role: () => "owner", online: () => true, api, subscribeEvents: () => () => {},
  });
}

test("typing in a document without comments does not materialize the text, and every edit is still announced", async () => {
  const shared = replica();
  const store = newStore(shared, fakeApi({}));
  await store.load();
  await turn();
  const published: SharedReviewProjection[] = [];
  store.subscribeProjection((projection) => published.push(projection));
  const counter = countToString(shared.ytext);
  try {
    // The first rebuild after subscribing announces itself once.
    shared.ytext.insert(0, "x");
    await turn();
    const woken = published.length;
    counter.calls = 0;
    for (let index = 0; index < 30; index += 1) {
      shared.ytext.insert(shared.ytext.length, "y");
      await turn();
    }
    assert.equal(counter.calls, 0, "no toString per keystroke");
    assert.equal(published.length, woken + 30, "each edit is announced: the pending selection follows the text");
    assert.equal(store.getProjection().text, shared.ytext.toString(), "the text is still correct on demand");
    assert.equal(counter.calls >= 1, true);
  } finally {
    store.destroy();
  }
});

test("unchanged threads keep their identity through edits that move no thread", async () => {
  const shared = replica();
  // Far enough after the comment that its 80-character context does not reach it.
  shared.ytext.insert(shared.ytext.length, "\n" + "Filler sentence. ".repeat(20));
  const start = TEXT.indexOf("Second");
  const end = TEXT.indexOf("\n", start);
  const api = fakeApi({
    createThread: async (_docId, body) => {
      const created = body as { id: string; anchorId: string; quote: string; body: string };
      const now = new Date().toISOString();
      const actor = { kind: "user", userId: ALICE.id, clientId: "c" } as Thread["actor"];
      return {
        id: created.id, docId: "doc_1", anchorId: created.anchorId, quote: created.quote, status: "open", actor, createdBy: ALICE,
        createdAt: now, updatedAt: now, resolvedBy: null, resolvedAt: null, suggestionIds: [],
        messages: [{ id: created.id, threadId: created.id, actor, author: ALICE, body: created.body, mentions: [], createdAt: now, editedAt: null, deletedAt: null }],
      } satisfies Thread;
    },
  });
  const store = newStore(shared, api);
  await store.load();
  await store.comment({ range: { start, end }, text: "Nice dogs" });
  await turn();
  const published: SharedReviewProjection[] = [];
  store.subscribeProjection((projection) => published.push(projection));
  try {
    const before = store.getProjection();
    assert.equal(before.threads.length, 1);
    assert.equal(before.threads[0].anchor.state, "attached");

    // An edit after the comment: its anchor and context are unchanged.
    shared.ytext.insert(shared.ytext.length, " Third.");
    await turn();
    const after = store.getProjection();
    assert.notEqual(after, before, "the projection itself is rebuilt");
    assert.equal(after.threads[0], before.threads[0], "the unchanged thread is the same object");
    assert.equal(published.length, 1, "the edit is announced");
    assert.equal(published[0].threads[0], before.threads[0], "with the same thread object");
    assert.equal(after.text, shared.ytext.toString(), "text reflects the edit");

    // An edit before the comment moves its anchor: a new object, announced.
    shared.ytext.insert(0, "Intro. ");
    await turn();
    const moved = store.getProjection();
    assert.notEqual(moved.threads[0], before.threads[0]);
    assert.equal(moved.threads[0].anchor.start, before.threads[0].anchor.start + "Intro. ".length);
    assert.equal(published.length, 2, "and so is the edit that moved the thread");
  } finally {
    store.destroy();
  }
});
