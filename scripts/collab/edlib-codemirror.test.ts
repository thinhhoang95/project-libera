import { dom } from "./edlib-dom";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import {
  collabExtension, dispatchAiEdit, insertLargeText, isLocalBindingOrigin, provenanceForTransaction, splitLargeInsert, utf8Length,
} from "../../src/lib/collab/bindings/codemirror";
import { applyAiProposal, latexReviewExtension } from "../../src/lib/latex/codemirror/review";
import { colorLight, followTarget, isQuietMode, quietMode, remoteUsers, sectionAt, sectionTracker, setLocalUser, setQuietMode, startFollowing } from "../../src/lib/collab/awareness";
import { SyncLimits, type Provenance } from "../../src/lib/collab/protocol";

type Peer = { doc: Y.Doc; ytext: Y.Text; awareness: Awareness; provenance: (Provenance | null)[]; updates: Uint8Array[] };

function peer(initial?: Y.Doc): Peer {
  const doc = new Y.Doc();
  if (initial) Y.applyUpdate(doc, Y.encodeStateAsUpdate(initial));
  const result: Peer = { doc, ytext: doc.getText("source"), awareness: new Awareness(doc), provenance: [], updates: [] };
  doc.on("update", (update: Uint8Array, origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
    if (origin === "remote") return;
    result.provenance.push(provenanceForTransaction(transaction));
    result.updates.push(update);
  });
  return result;
}

/** Live relay between two peers, like two hubs connected through the server. */
function connect(a: Peer, b: Peer) {
  a.doc.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== "remote") Y.applyUpdate(b.doc, update, "remote"); });
  b.doc.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== "remote") Y.applyUpdate(a.doc, update, "remote"); });
}

function mount(ytext: Y.Text, extensions: Extension) {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({ state: EditorState.create({ doc: ytext.toString(), extensions }), parent });
}

const cleanup: (() => void)[] = [];
after(() => {
  for (const fn of cleanup) fn();
  dom.window.close();
});

function editor(p: Peer, options: { name?: string; readOnly?: boolean; extra?: Extension } = {}) {
  const binding = collabExtension({ ytext: p.ytext, awareness: p.awareness, user: { name: options.name ?? "Alice", color: "#3366ff" }, readOnly: options.readOnly });
  const view = mount(p.ytext, [binding.extension, options.extra ?? []]);
  cleanup.push(() => { view.destroy(); binding.destroy(); p.awareness.destroy(); });
  return { binding, view };
}

test("two CodeMirror views on synced Y.Docs converge, with provenance on every update", () => {
  const seed = new Y.Doc();
  seed.getText("source").insert(0, "Hello world.\n");
  const alice = peer(seed);
  const bob = peer(seed);
  connect(alice, bob);
  const a = editor(alice, { extra: latexReviewExtension() });
  const b = editor(bob, { name: "Bob" });

  a.view.dispatch({ changes: { from: 5, insert: " there" }, userEvent: "input.type" });
  b.view.dispatch({ changes: { from: b.view.state.doc.length, insert: "Pasted line.\n" }, userEvent: "input.paste" });
  dispatchAiEdit(a.view, { changes: { from: 0, to: 5, insert: "Howdy" } }, { feature: "rewrite", model: "m-1", runId: "run-7" });
  applyAiProposal(a.view, 0, 5, "Hi", "format");
  b.view.dispatch({ changes: { from: 0, to: 2 }, userEvent: "delete.backward" });

  assert.equal(a.view.state.doc.toString(), b.view.state.doc.toString());
  assert.equal(alice.ytext.toString(), a.view.state.doc.toString());
  assert.equal(bob.ytext.toString(), alice.ytext.toString());
  assert.deepEqual(alice.provenance, [
    { source: "typing" },
    { source: "ai", feature: "rewrite", model: "m-1", runId: "run-7" },
    { source: "ai", feature: "format" },
  ]);
  assert.deepEqual(bob.provenance, [{ source: "paste" }, { source: "typing" }]);
  assert.equal(isLocalBindingOrigin(a.binding.origin), true);

  a.binding.setNextProvenance({ source: "external-file" });
  a.view.dispatch({ changes: { from: 0, insert: "!" } });
  a.view.dispatch({ changes: { from: 0, insert: "?" }, userEvent: "input.type" });
  assert.deepEqual(alice.provenance.slice(-2), [{ source: "external-file" }, { source: "typing" }]);
});

test("undo only undoes this editor's changes, and an AI edit is its own undo step", () => {
  const alice = peer();
  alice.ytext.insert(0, "base ");
  const bob = peer(alice.doc);
  connect(alice, bob);
  const a = editor(alice);
  const b = editor(bob, { name: "Bob" });
  a.view.dispatch({ changes: { from: 5, insert: "A" }, userEvent: "input.type" });
  b.view.dispatch({ changes: { from: 0, insert: "B" }, userEvent: "input.type" });
  dispatchAiEdit(a.view, { changes: { from: a.view.state.doc.length, insert: " [ai]" } }, { feature: "write" });
  assert.equal(a.view.state.doc.toString(), "Bbase A [ai]");

  a.binding.undoManager.undo();
  assert.equal(a.view.state.doc.toString(), "Bbase A", "the AI edit undoes alone");
  assert.deepEqual(alice.provenance.at(-1), { source: "undo" });
  a.binding.undoManager.undo();
  assert.equal(a.view.state.doc.toString(), "Bbase ", "Bob's B stays");
  assert.equal(b.view.state.doc.toString(), "Bbase ");
  a.binding.undoManager.redo();
  assert.equal(b.view.state.doc.toString(), "Bbase A");
});

test("viewers and read-only sync states block local edits but keep receiving remote ones", () => {
  const editorPeer = peer();
  editorPeer.ytext.insert(0, "Shared");
  const viewerPeer = peer(editorPeer.doc);
  connect(editorPeer, viewerPeer);
  const e = editor(editorPeer);
  const v = editor(viewerPeer, { name: "Vee", readOnly: true });
  assert.equal(v.view.state.readOnly, true);
  v.view.dispatch({ changes: { from: 0, insert: "nope " } });
  assert.equal(viewerPeer.ytext.toString(), "Shared");
  e.view.dispatch({ changes: { from: 6, insert: " text" }, userEvent: "input.type" });
  assert.equal(v.view.state.doc.toString(), "Shared text");

  e.binding.applySyncState(e.view, "read-only");
  e.view.dispatch({ changes: { from: 0, insert: "x" } });
  assert.equal(editorPeer.ytext.toString(), "Shared text");
  e.binding.applySyncState(e.view, "saved-remote");
  e.view.dispatch({ changes: { from: 0, insert: "x" } });
  assert.equal(editorPeer.ytext.toString(), "xShared text");
  // A viewer stays read-only whatever the sync state.
  v.binding.applySyncState(v.view, "saved-remote");
  assert.equal(v.view.state.readOnly, true);
});

test("large pastes are split into bounded updates that still undo as one step", () => {
  const p = peer();
  const { binding, view } = editor(p);
  const line = "Lorem ipsum dolor sit amet, ✓ consectetur 😀 adipiscing elit.\n";
  const big = line.repeat(Math.ceil((SyncLimits.batchMaxBytes * 2.5) / utf8Length(line)));
  const pieces = splitLargeInsert(big);
  assert.equal(pieces.join(""), big);
  assert.ok(pieces.length >= 3);
  assert.ok(pieces.every((piece) => utf8Length(piece) <= SyncLimits.batchMaxBytes && piece.endsWith("\n")));
  assert.deepEqual(splitLargeInsert("ab😀cd", 4), ["ab", "😀", "cd"]);
  assert.deepEqual(splitLargeInsert(""), []);

  // Through the editor's paste handler.
  const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => (type === "text/plain" ? big : "") } });
  view.contentDOM.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(p.ytext.toString(), big);
  assert.equal(p.updates.length, pieces.length);
  assert.ok(p.updates.every((update) => update.byteLength <= SyncLimits.batchMaxBytes + 1024));
  assert.ok(p.provenance.every((provenance) => provenance?.source === "paste"));
  binding.undoManager.undo();
  assert.equal(p.ytext.toString(), "");

  insertLargeText(view, "small");
  assert.equal(view.state.doc.toString(), "small");
});

test("awareness: user state, remote users, sections, quiet mode and follow mode", async () => {
  const seed = new Y.Doc();
  seed.getText("source").insert(0, "# Intro\n\nText.\n\n## Methods\n\nMore text here.\n");
  const alice = peer(seed);
  const bob = peer(seed);
  // Relay awareness both ways, like the hub does.
  const relay = (from: Awareness, to: Awareness) => from.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    applyAwarenessUpdate(to, encodeAwarenessUpdate(from, [...added, ...updated, ...removed]), "remote");
  });
  relay(alice.awareness, bob.awareness);
  relay(bob.awareness, alice.awareness);
  connect(alice, bob);
  const a = editor(alice, { extra: [quietMode(), sectionTracker(alice.awareness, "markdown")] });
  editor(bob, { name: "Bob", extra: sectionTracker(bob.awareness, "markdown") });
  setLocalUser(bob.awareness, { name: "Bob", color: "#22aa66", userId: "u-bob" });

  assert.equal(colorLight("#abc"), "#aabbcc33");
  assert.equal(colorLight("#3366FF", 0.5), "#3366ff80");
  assert.deepEqual(sectionAt(a.view.state, a.view.state.doc.toString().indexOf("More"), "markdown"), { title: "Methods", level: 2, offset: 16 });
  assert.equal(sectionAt(EditorState.create({ doc: "\\section{Results}\nx" }), 18, "latex")?.title, "Results");

  // Bob's cursor moves into the Methods section.
  const methods = alice.ytext.toString().indexOf("More");
  const bobCursor = Y.createRelativePositionFromTypeIndex(bob.ytext, methods);
  bob.awareness.setLocalStateField("cursor", { anchor: Y.relativePositionToJSON(bobCursor), head: Y.relativePositionToJSON(bobCursor) });
  bob.awareness.setLocalStateField("section", { title: "Methods", level: 2, offset: 16 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const users = remoteUsers(alice.awareness, alice.ytext);
  assert.equal(users.length, 1);
  assert.equal(users[0].name, "Bob");
  assert.equal(users[0].colorLight, "#22aa6633");
  assert.equal(users[0].userId, "u-bob");
  assert.deepEqual(users[0].section, { title: "Methods", level: 2, offset: 16 });
  assert.deepEqual(users[0].cursor, { anchor: methods, head: methods });
  assert.equal(followTarget(alice.awareness, alice.ytext, bob.doc.clientID), methods);

  assert.equal(isQuietMode(a.view.state), false);
  setQuietMode(a.view, true);
  assert.equal(isQuietMode(a.view.state), true);
  assert.ok(a.view.dom.classList.contains("cm-collab-quiet"));
  // Awareness keeps syncing while quiet.
  bob.awareness.setLocalStateField("section", null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(remoteUsers(alice.awareness)[0].section, null);
  setQuietMode(a.view, false);
  assert.ok(!a.view.dom.classList.contains("cm-collab-quiet"));

  const stops: string[] = [];
  const follow = startFollowing({ view: a.view, awareness: alice.awareness, ytext: alice.ytext, clientId: bob.doc.clientID, onStop: (reason) => stops.push(reason) });
  a.view.dom.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
  assert.deepEqual(stops, ["user-action"]);
  follow.stop();
  assert.deepEqual(stops, ["user-action"]);
});
