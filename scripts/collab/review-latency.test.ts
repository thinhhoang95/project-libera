// How fast a new shared comment reaches the Comments panel, without the
// network in the way: the author's store must publish the thread (pending)
// in the same turn as `comment()`, before the server answers, and confirm it
// when the answer arrives; a collaborator's store must publish a thread
// within a turn of the thread.changed event. The end-to-end run
// (scripts/collab/e2e/two-users.ts, step 9b) checks the same in the real app
// with a 1.5 s budget per panel.

import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";

import type { HostEvent } from "../../src/lib/collab/local-api";
import { EventKind } from "../../src/lib/collab/protocol/messages";
import type { Thread, UserSummary } from "../../src/lib/collab/protocol/api";
import type { ThreadApi } from "../../src/lib/collab/review-store/api";
import { SharedReviewStore, type SharedReplicaLike } from "../../src/lib/collab/review-store/shared";
import type { SharedReviewProjection } from "../../src/lib/collab/review-store/types";

const TEXT = "First paragraph about cats.\n\nSecond paragraph about dogs.\n";
const ALICE: UserSummary = { id: "acc_alice", displayName: "Alice", color: "#2563eb" };
const BOB: UserSummary = { id: "acc_bob", displayName: "Bob", color: "#16a34a" };

function replica(): SharedReplicaLike {
  const content = new Y.Doc();
  const ytext = content.getText("source");
  ytext.insert(0, TEXT);
  return { ytext, annotations: new Y.Doc(), onRebuild: () => () => {} };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

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

/** Waits for the store's microtask-scheduled publish (no timers involved). */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("the author's panel lists a new comment at once, then confirms it when the server answers", async () => {
  const answer = deferred<Thread>();
  let sent: { id: string; anchorId: string; quote: string; body: string } | null = null;
  const api = fakeApi({
    createThread: (_docId, body) => {
      sent = body as typeof sent;
      return answer.promise;
    },
  });
  const store = new SharedReviewStore({
    docId: "doc_1", projectId: "prj_1", key: "Team/note.md", replica: replica(),
    me: () => ALICE, role: () => "owner", online: () => true, api, subscribeEvents: () => () => {},
  });
  const published: SharedReviewProjection[] = [];
  store.subscribeProjection((projection) => published.push(projection));
  await store.load();
  try {
    const start = TEXT.indexOf("Second");
    const started = performance.now();
    const done = store.comment({ range: { start, end: TEXT.indexOf("\n", start) }, text: "Nice dogs" });
    await turn();
    const pending = published.at(-1)?.threads.find((thread) => thread.messages[0]?.text === "Nice dogs");
    assert.ok(pending, "the comment is published before the server answers");
    assert.equal(pending.shared.pending?.state, "sending");
    assert.equal(pending.shared.createdBy.displayName, "Alice");
    assert.equal(pending.anchor.state, "attached");
    assert.ok(performance.now() - started < 100, "published within one turn");

    assert.ok(sent, "the create was sent");
    const created = sent as { id: string; anchorId: string; quote: string; body: string };
    const now = new Date().toISOString();
    answer.resolve({
      id: created.id, docId: "doc_1", anchorId: created.anchorId, quote: created.quote, status: "open",
      actor: { kind: "user", userId: ALICE.id, clientId: "c" } as Thread["actor"], createdBy: ALICE, createdAt: now, updatedAt: now,
      resolvedBy: null, resolvedAt: null, suggestionIds: [],
      messages: [{ id: created.id, threadId: created.id, actor: { kind: "user", userId: ALICE.id, clientId: "c" } as Thread["actor"], author: ALICE, body: "Nice dogs", mentions: [], createdAt: now, editedAt: null, deletedAt: null }],
    });
    await done;
    await turn();
    const confirmed = published.at(-1)?.threads.find((thread) => thread.id === created.id);
    assert.ok(confirmed, "still listed after the answer");
    assert.equal(confirmed.shared.pending, null, "confirmed: no pending chip");
  } finally {
    store.destroy();
  }
});

test("a collaborator's panel lists a comment within a turn of the thread.changed event", async () => {
  const listeners = new Set<(event: HostEvent) => void>();
  const shared = replica();
  const store = new SharedReviewStore({
    docId: "doc_1", projectId: "prj_1", key: "Team/note.md", replica: shared,
    me: () => BOB, role: () => "editor", online: () => true, api: fakeApi({}),
    subscribeEvents: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  });
  const published: SharedReviewProjection[] = [];
  store.subscribeProjection((projection) => published.push(projection));
  await store.load();
  try {
    const now = new Date().toISOString();
    const thread: Thread = {
      id: "thr_1", docId: "doc_1", anchorId: "anc_missing_yet", quote: "Second paragraph about dogs.", status: "open",
      actor: { kind: "user", userId: ALICE.id, clientId: "c" } as Thread["actor"], createdBy: ALICE, createdAt: now, updatedAt: now,
      resolvedBy: null, resolvedAt: null, suggestionIds: [],
      messages: [{ id: "thr_1", threadId: "thr_1", actor: { kind: "user", userId: ALICE.id, clientId: "c" } as Thread["actor"], author: ALICE, body: "Nice dogs", mentions: [], createdAt: now, editedAt: null, deletedAt: null }],
    };
    const started = performance.now();
    for (const listener of listeners) listener({ t: "server-event", scope: "doc_1", id: "evt_1", kind: EventKind.ThreadChanged, payload: { thread } });
    await turn();
    const listed = published.at(-1)?.threads.find((item) => item.id === "thr_1");
    assert.ok(listed, "listed right after the event, even before its anchor has synced");
    assert.equal(listed.shared.createdBy.displayName, "Alice");
    assert.ok(performance.now() - started < 100, "published within one turn");
  } finally {
    store.destroy();
  }
});
