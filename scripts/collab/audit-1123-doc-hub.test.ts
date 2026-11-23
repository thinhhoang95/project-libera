// Audit 2026-11-23, package K1: the doc hub's server path.
// C6 (reject after revocation/deletion/transient not-open wipes local text),
// C7 (delete-only server diff applied before it is persisted), H13 (stale
// Opened after a rollback marks an empty doc caught up), M11 (resync timer
// clears its flag early and ignores a failed reopen).

import assert from "node:assert/strict";
import test from "node:test";

import * as Y from "yjs";

import { MessageType } from "../../src/lib/collab/protocol/messages";
import type { OpenedMessage, RejectMessage, RemoteMessage, UpdateMessage } from "../../src/lib/collab/protocol/messages";
import type { Subdoc } from "../../src/lib/collab/protocol/roles";
import { DOC_SCHEMA_VERSION } from "../../src/lib/collab/protocol/version";
import { DocHub, type HubTransport } from "../../electron/collab/core/doc-hub";
import { HostStore } from "../../electron/collab/core/store";
import { ManualClock, quietLogger } from "./support/host-helpers";

const SUBDOCS: Subdoc[] = ["content", "annotations", "meta"];

class FakeLink implements HubTransport {
  sent: UpdateMessage[] = [];
  reopens = 0;
  reopenResult = true;
  send(message: UpdateMessage): boolean {
    this.sent.push(message);
    return true;
  }
  sendAwareness(): void {}
  reopen(): boolean {
    this.reopens += 1;
    return this.reopenResult;
  }
}

interface Rig {
  store: HostStore;
  clock: ManualClock;
  hub: DocHub;
  link: FakeLink;
}

function rig(): Rig {
  const store = new HostStore({ path: ":memory:" });
  const clock = new ManualClock();
  const hub = new DocHub({ docId: "d1", store, clock, logger: quietLogger });
  const link = new FakeLink();
  hub.connectionChanged(link);
  return { store, clock, hub, link };
}

function opened(diffs: Partial<Record<Subdoc, Uint8Array>> = {}, serverSeq = 1): OpenedMessage {
  const empty = Y.encodeStateAsUpdate(new Y.Doc());
  return {
    type: MessageType.Opened,
    docId: "d1",
    projectId: "p1",
    role: "editor",
    schemaVersion: DOC_SCHEMA_VERSION,
    serverSeq,
    subdocs: SUBDOCS.map((subdoc) => ({ subdoc, diff: diffs[subdoc] ?? empty, stateVector: new Uint8Array([0]) })),
  };
}

function reject(clientSeq: number, reason: RejectMessage["reason"]): RejectMessage {
  return { type: MessageType.Reject, docId: "d1", subdoc: "content", clientSeq, reason, message: reason };
}

/** A hub that has an unacknowledged local edit "mine" in flight. */
async function withInFlightEdit(): Promise<Rig & { clientSeq: number }> {
  const r = rig();
  r.hub.handleOpened(opened());
  r.hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, "mine"));
  await r.hub.flushOutbound();
  assert.equal(r.link.sent.length, 1, "the edit is in flight");
  return { ...r, clientSeq: r.link.sent[0].clientSeq };
}

// ------------------------------------------------------------------ C6

test("C6: a not-open reject reopens and resends instead of wiping local text", async () => {
  const r = await withInFlightEdit();
  const reopensBefore = r.link.reopens;
  r.hub.handleReject(reject(r.clientSeq, "not-open"));
  assert.equal(r.hub.getText(), "mine", "local text is kept");
  assert.equal(r.hub.getRejected().length, 0, "nothing is recorded as rejected");
  assert.equal(r.link.reopens, reopensBefore + 1, "the document is reopened");
  assert.equal(r.hub.pendingBatches().length, 1, "the batch is still pending");
  // The server answers the reopen; the pending batch is sent again.
  r.hub.handleOpened(opened());
  await r.hub.flushOutbound();
  assert.equal(r.link.sent.length, 2, "the batch was resent");
  assert.equal(r.link.sent[1].clientSeq, r.clientSeq);
  r.hub.close();
  r.store.close();
});

test("C6: rejects after access revocation or deletion keep the text", async () => {
  for (const closed of ["access-revoked", "document-deleted"] as const) {
    const r = await withInFlightEdit();
    r.hub.handleClosed({ type: MessageType.Closed, docId: "d1", reason: closed });
    for (const reason of ["not-open", "forbidden", "invalid-update"] as const) {
      r.hub.handleReject(reject(r.clientSeq, reason));
    }
    assert.equal(r.hub.getText(), "mine", `${closed}: local text is kept for export`);
    assert.equal(r.hub.getRejected().length, 0, `${closed}: no rollback`);
    r.hub.close();
    r.store.close();
  }
});

test("C6: a definitive reject of a live document still rolls back", async () => {
  const r = await withInFlightEdit();
  r.hub.handleReject(reject(r.clientSeq, "invalid-update"));
  assert.equal(r.hub.getText(), "");
  assert.equal(r.hub.getRejected()[0]?.rejectedText, "mine");
  r.hub.close();
  r.store.close();
});

// ------------------------------------------------------------------ C7

test("C7: a delete-only server diff is on disk before it changes the live doc", () => {
  const server = new Y.Doc();
  server.getText("source").insert(0, "hello world");
  const full = Y.encodeStateAsUpdate(server);
  const before = Y.encodeStateVector(server);
  server.getText("source").delete(0, 6);
  const deleteOnly = Y.encodeStateAsUpdate(server, before);

  const r = rig();
  r.hub.handleOpened(opened({ content: full }, 1));
  assert.equal(r.hub.getText(), "hello world");

  const real = r.store.appendAcked.bind(r.store);
  let fail = true;
  r.store.appendAcked = (...args: Parameters<HostStore["appendAcked"]>) => {
    if (fail) throw new Error("SQLITE_BUSY");
    return real(...args);
  };
  r.hub.handleOpened(opened({ content: deleteOnly }, 2));
  assert.equal(r.hub.getText(), "hello world", "an unsaved deletion is not applied");
  assert.equal(r.hub.caughtUp, false);

  // Storage recovers; the resync re-sends the same diff.
  fail = false;
  r.clock.advance(1000);
  assert.equal(r.link.reopens > 0, true);
  r.hub.handleOpened(opened({ content: deleteOnly }, 2));
  assert.equal(r.hub.getText(), "world");
  assert.equal(r.hub.caughtUp, true);
  r.hub.close();

  const restarted = new DocHub({ docId: "d1", store: r.store, clock: r.clock, logger: quietLogger });
  assert.equal(restarted.getText(), "world", "the deletion survives a restart");
  restarted.close();
  r.store.close();
});

test("C7: a delete-only diff that changes nothing is not stored again", () => {
  const server = new Y.Doc();
  server.getText("source").insert(0, "abc");
  server.getText("source").delete(0, 1);
  const full = Y.encodeStateAsUpdate(server);
  const deleteOnly = Y.encodeStateAsUpdate(server, Y.encodeStateVector(server));

  const r = rig();
  r.hub.handleOpened(opened({ content: full }, 1));
  const rows = r.store.allUpdates("d1").length;
  r.hub.handleOpened(opened({ content: deleteOnly }, 2));
  assert.equal(r.store.allUpdates("d1").length, rows, "no new log row");
  assert.equal(r.hub.getText(), "bc");
  r.hub.close();
  r.store.close();
});

// ------------------------------------------------------------------ H13

test("H13: an Opened that answers an Open sent before a rollback does not mark the empty doc caught up", () => {
  const r = rig();
  // The connection's first Open is in flight; a rollback sends a second one.
  r.hub.rollback("content", "invalid-update", "x");
  assert.equal(r.link.reopens, 1);
  r.hub.handleOpened(opened({}, 1));
  assert.equal(r.hub.caughtUp, false, "the stale reply does not count");
  assert.equal(r.hub.hasOpened, false);
  r.hub.handleOpened(opened({}, 1));
  assert.equal(r.hub.caughtUp, true);
  assert.equal(r.hub.hasOpened, true);
  r.hub.close();
  r.store.close();
});

// ------------------------------------------------------------------ M11

function failingRemote(r: Rig): { remote: RemoteMessage; restore: () => void } {
  const source = new Y.Doc();
  source.getText("source").insert(0, "remote");
  const real = r.store.appendAcked.bind(r.store);
  let fail = true;
  r.store.appendAcked = (...args: Parameters<HostStore["appendAcked"]>) => {
    if (fail) throw new Error("disk full");
    return real(...args);
  };
  return {
    remote: {
      type: MessageType.Remote,
      docId: "d1",
      subdoc: "content",
      serverSeq: 2,
      update: Y.encodeStateAsUpdate(source),
      userId: "u2",
      clientId: "c2",
    },
    restore: () => {
      fail = false;
    },
  };
}

test("M11: the resync stays pending until Opened arrives, so live remotes keep being ignored", () => {
  const r = rig();
  r.hub.handleOpened(opened({}, 1));
  const { remote, restore } = failingRemote(r);
  r.hub.handleRemote(remote);
  assert.equal(r.hub.caughtUp, false);
  restore();
  const reopens = r.link.reopens;
  r.clock.advance(1000);
  assert.equal(r.link.reopens, reopens + 1, "the timer reopened the document");
  assert.equal(r.hub.caughtUp, false, "still not caught up before Opened");
  r.hub.handleRemote({ ...remote, serverSeq: 3 });
  assert.equal(r.hub.getText(), "", "a live remote before Opened is not applied over the gap");
  r.hub.handleOpened(opened({ content: remote.update }, 3));
  assert.equal(r.hub.getText(), "remote");
  assert.equal(r.hub.caughtUp, true);
  r.hub.close();
  r.store.close();
});

test("M11: a reopen that could not be sent, or is never answered, is retried", () => {
  const r = rig();
  r.hub.handleOpened(opened({}, 1));
  const { remote, restore } = failingRemote(r);
  r.hub.handleRemote(remote);
  restore();
  r.link.reopenResult = false;
  const base = r.link.reopens;
  r.clock.advance(1000);
  assert.equal(r.link.reopens, base + 1);
  assert.ok(r.clock.pending().length > 0, "another attempt is scheduled");
  r.link.reopenResult = true;
  r.clock.advance(30_000);
  assert.ok(r.link.reopens >= base + 2, "the retry sent the open");
  r.hub.handleOpened(opened({ content: remote.update }, 3));
  assert.equal(r.hub.caughtUp, true);
  assert.deepEqual(r.clock.pending().filter((delay) => delay >= 1000), [], "no resync attempt stays scheduled once caught up");
  r.hub.close();
  r.store.close();
});
