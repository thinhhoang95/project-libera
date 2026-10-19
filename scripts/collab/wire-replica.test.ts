import { dom } from "./edlib-dom";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import { remoteUsers, setLocalUser } from "../../src/lib/collab/awareness";
import type { CollabReplica } from "../../src/lib/collab/client/replica";
import { applyTextToSession, applyTextToYText } from "../../src/lib/collab/client/apply-text";
import { sharedCodeMirrorSource } from "../../src/lib/collab/bindings/react-codemirror";
import { SharedEditOrigin } from "../../src/lib/collab/client/registry";
import { createHarness } from "./support/wire-harness";
import { settle, waitFor } from "./support/host-helpers";

after(() => dom.window.close());

test("a replica attaches with state vectors and two replicas converge through the hub", async () => {
  const harness = createHarness({ text: "Hello" });
  try {
    const a = harness.replica();
    const b = harness.replica();
    await Promise.all([a.whenAttached(), b.whenAttached()]);
    assert.equal(a.text(), "Hello", "attach brings the hub's state");
    assert.equal(a.getSnapshot().meta?.role, "editor");
    assert.ok(a.getSnapshot().status, "status arrives after attach");

    for (let index = 0; index < 10; index += 1) {
      a.ytext.insert(a.ytext.length, "a");
      b.ytext.insert(0, "b");
    }
    await waitFor(() => a.text() === b.text() && a.text() === harness.hub.getText() && a.text().length === 25, 3000, "convergence");
    assert.ok(harness.store.allUpdates("d1").length >= 2, "local updates were committed by the hub");
  } finally {
    harness.close();
  }
});

test("hub updates are not echoed back, and queued typing is batched into few messages", async () => {
  const harness = createHarness();
  try {
    const a = harness.replica();
    const b = harness.replica();
    await Promise.all([a.whenAttached(), b.whenAttached()]);
    const before = harness.store.allUpdates("d1").length;
    for (const char of "typing a word") a.ytext.insert(a.ytext.length, char);
    await waitFor(() => b.text() === "typing a word");
    await settle();
    const rows = harness.store.allUpdates("d1").length - before;
    assert.equal(rows, 1, "one frame of typing is one update");
    await settle();
    assert.equal(harness.store.allUpdates("d1").length - before, 1, "b did not send a's update back");
  } finally {
    harness.close();
  }
});

test("provenance of binding and programmatic edits arrives at the hub", async () => {
  const harness = createHarness({ text: "Hello world\n" });
  try {
    const replica = harness.replica();
    await replica.whenAttached();
    const seen: unknown[] = [];
    harness.hub.observe("content", (change) => { if (change.origin === "replica") seen.push(change.provenance); });

    applyTextToYText(replica.ytext, "Hello brave world\n", { source: "ai", feature: "rewrite" });
    await waitFor(() => seen.length === 1);
    assert.deepEqual(seen[0], { source: "ai", feature: "rewrite" });

    // A CodeMirror paste through the binding.
    const editors = createHarnessView(replica);
    editors.view.dispatch({ changes: { from: 0, insert: "> " }, userEvent: "input.paste" });
    editors.view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" });
    await waitFor(() => seen.length === 3);
    assert.deepEqual(seen.slice(1), [{ source: "paste" }, { source: "typing" }], "a provenance change is a separate update");
    const rows = harness.store.allUpdates("d1").map((row) => row.origin?.kind === "local" ? row.origin.provenance?.source : null);
    assert.deepEqual(rows.slice(-3), ["ai", "paste", "typing"]);
    editors.destroy();
  } finally {
    harness.close();
  }
});

function createHarnessView(replica: CollabReplica) {
  const binding = sharedCodeMirrorSource(sessionFor(replica)).create();
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: EditorState.create({ doc: binding.initialText, extensions: [binding.extension] }), parent });
  binding.attach(view);
  return { view, destroy() { binding.destroy(); view.destroy(); parent.remove(); } };
}

/** A session as the registry builds it, for tests that use one replica directly. */
function sessionFor(replica: CollabReplica) {
  const editOrigin = new SharedEditOrigin(replica.docId);
  return {
    docId: replica.docId,
    replica,
    editOrigin,
    undoManager: new Y.UndoManager(replica.ytext, { trackedOrigins: new Set([editOrigin]) }),
    resolved: { docId: replica.docId, projectId: "p1", fileId: "f1", path: "Shared/note.md", kind: "markdown" as const, role: "editor" as const, readOnly: false },
  };
}

test("a rejection rebuilds the sub-document, keeps the refused text, and editing continues", async () => {
  const harness = createHarness({ text: "base" });
  try {
    const replica = harness.replica();
    await replica.whenAttached();
    const rebuilt: string[] = [];
    replica.onRebuild((subdoc) => rebuilt.push(subdoc));
    replica.ytext.insert(4, " plus mine");
    await waitFor(() => harness.hub.getText() === "base plus mine");
    const oldText = replica.ytext;

    harness.hub.rollback("content", "forbidden", "Your role changed.");
    await waitFor(() => replica.getSnapshot().rejection !== null);
    await settle();
    const snapshot = replica.getSnapshot();
    assert.deepEqual(rebuilt, ["content"]);
    assert.equal(snapshot.generation, 1);
    assert.equal(snapshot.rejection?.rejectedText, "base plus mine");
    assert.notEqual(replica.ytext, oldText, "a fresh Y.Doc");
    assert.equal(replica.text(), harness.hub.getText(), "the replica follows the hub's reloaded state");

    // The hub repeats stored rejections on every attach; that must not loop.
    await settle(40);
    assert.equal(replica.getSnapshot().generation, 1);

    replica.ytext.insert(0, "again");
    await waitFor(() => harness.hub.getText().startsWith("again"), 3000, "edits after the rebuild");
    replica.dismissRejection();
    assert.equal(replica.getSnapshot().rejection, null);
  } finally {
    harness.close();
  }
});

test("read-only meta blocks programmatic and editor edits", async () => {
  const harness = createHarness({ role: "viewer", text: "read me" });
  try {
    const replica = harness.replica();
    await replica.whenAttached();
    assert.equal(replica.getSnapshot().meta?.readOnly, true);
    assert.equal(replica.canEditContent(), false);
    const session = sessionFor(replica);
    assert.deepEqual(applyTextToSession(session, "changed", { source: "ai", feature: "rewrite" }), { applied: false, reason: "read-only" });

    const binding = sharedCodeMirrorSource(session).create();
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: EditorState.create({ doc: binding.initialText, extensions: [binding.extension] }), parent });
    binding.attach(view);
    view.dispatch({ changes: { from: 0, insert: "nope " } });
    assert.equal(view.state.doc.toString(), "read me", "the editor refuses local edits");
    assert.equal(replica.text(), "read me");
    binding.destroy();
    view.destroy();
  } finally {
    harness.close();
  }
});

test("presence is relayed between replicas", async () => {
  const harness = createHarness();
  try {
    const a = harness.replica();
    const b = harness.replica();
    await Promise.all([a.whenAttached(), b.whenAttached()]);
    setLocalUser(a.awareness, { name: "Ada", color: "#ff0000" });
    await waitFor(() => remoteUsers(b.awareness).some((user) => user.name === "Ada"), 3000, "presence");
    a.destroy();
    await waitFor(() => !remoteUsers(b.awareness).some((user) => user.name === "Ada"), 3000, "presence removed on destroy");
  } finally {
    harness.close();
  }
});
