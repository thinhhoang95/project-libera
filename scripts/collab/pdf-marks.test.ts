import assert from "node:assert/strict";
import test from "node:test";

import * as Y from "yjs";

import { applyMarksDiff, importMarks, marksOf, readAllMarks, visibleMarks } from "../../src/lib/collab/pdf/model";
import { mergeText } from "../../src/lib/collab/pdf/merge-text";
import { pdfAnchorViolation } from "../../src/lib/collab/protocol/pdf";
import { SharedPdfStore } from "../../src/lib/collab/pdf/store";
import { PdfKeys } from "../../src/lib/collab/protocol/pdf";
import type { PdfAnnotation, PdfHighlightAnnotation, PdfInkAnnotation, PdfSpaceAnnotation, PdfTextAnnotation } from "../../src/lib/types";

const at = (n: number) => new Date(Date.UTC(2026, 10, 6, 10, 0, n)).toISOString();

function highlight(id: string, n = 0, color = "#fde047"): PdfHighlightAnnotation {
  return { id, type: "highlight", pageNumber: 1, color, rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }], quote: "words", createdAt: at(n), updatedAt: at(n) };
}

function note(id: string, text = "", n = 0, x = 0.1): PdfTextAnnotation {
  return { id, type: "text", pageNumber: 1, text, fontSize: 10, rect: { x, y: 0.2, width: 0.3, height: 0.1 }, createdAt: at(n), updatedAt: at(n) };
}

function ink(id: string, space?: string, n = 0): PdfInkAnnotation {
  return { id, type: "ink", pageNumber: 1, color: "#111111", strokeWidth: 2, points: [{ x: 0.1, y: 0.01 }, { x: 0.2, y: 0.02 }], ...(space ? { space } : {}), createdAt: at(n), updatedAt: at(n) };
}

function space(id: string, y: number, n = 0, height = 0.1): PdfSpaceAnnotation {
  return { id, type: "space", pageNumber: 1, y, height, band: { top: y, bottom: y, splits: [] }, column: 0, createdAt: at(n), updatedAt: at(n) };
}

interface Client {
  doc: Y.Doc;
  store: SharedPdfStore;
}

function client(name: string): Client {
  const doc = new Y.Doc();
  return { doc, store: new SharedPdfStore({ annotations: doc, onRebuild: () => () => {} }, `doc_${name}`, { accountId: name }) };
}

function sync(...clients: Client[]) {
  for (const a of clients) for (const b of clients) if (a !== b) Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
}

function patch(store: SharedPdfStore, id: string, change: Partial<PdfAnnotation>, key?: string) {
  store.commit(store.getSnapshot().map((mark) => mark.id === id ? { ...mark, ...change, updatedAt: at(50) } as PdfAnnotation : mark), key);
}

const add = (store: SharedPdfStore, mark: PdfAnnotation, key?: string) => store.commit([...store.getSnapshot(), mark], key);
const remove = (store: SharedPdfStore, id: string) => store.commit(store.getSnapshot().filter((mark) => mark.id !== id));
const byId = (store: SharedPdfStore, id: string) => store.getSnapshot().find((mark) => mark.id === id);

test("a mark survives the round trip through the CRDT field by field", () => {
  const a = client("a");
  const marks: PdfAnnotation[] = [highlight("h"), note("n", "**bold**"), ink("i"), space("s", 0.5), { id: "shape", type: "shape", pageNumber: 2, shape: "arrow", color: "#ff0000", strokeWidth: 3, from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, createdAt: at(0), updatedAt: at(0) }];
  for (const mark of marks) add(a.store, mark);
  for (const mark of marks) assert.deepEqual(byId(a.store, mark.id), mark);
});

test("two people changing different fields of one mark both win", () => {
  const [a, b] = [client("a"), client("b")];
  add(a.store, note("n", "text"));
  sync(a, b);
  patch(a.store, "n", { rect: { x: 0.5, y: 0.5, width: 0.3, height: 0.1 } });
  patch(b.store, "n", { color: "#22c55e" });
  sync(a, b);
  for (const client of [a, b]) {
    const mark = byId(client.store, "n") as PdfTextAnnotation;
    assert.equal(mark.rect.x, 0.5);
    assert.equal(mark.color, "#22c55e");
  }
});

test("a field two people changed converges to one value", () => {
  const [a, b] = [client("a"), client("b")];
  add(a.store, highlight("h"));
  sync(a, b);
  patch(a.store, "h", { color: "#111111" });
  patch(b.store, "h", { color: "#222222" });
  sync(a, b);
  assert.deepEqual(a.store.getSnapshot(), b.store.getSnapshot());
});

test("two people typing in one note merge by character", () => {
  const [a, b] = [client("a"), client("b")];
  add(a.store, note("n", "hello"));
  sync(a, b);
  patch(a.store, "n", { text: "A hello" });
  patch(b.store, "n", { text: "hello B" });
  sync(a, b);
  assert.equal((byId(a.store, "n") as PdfTextAnnotation).text, "A hello B");
  assert.equal((byId(b.store, "n") as PdfTextAnnotation).text, "A hello B");
});

test("a commit never rewrites a field its gesture left alone", () => {
  const [a, b] = [client("a"), client("b")];
  add(a.store, highlight("h"));
  sync(a, b);
  const stale = b.store.getSnapshot();
  patch(a.store, "h", { color: "#111111" });
  sync(a, b);
  // b's snapshot moved on; a commit built on the current list keeps a's colour.
  assert.notDeepEqual(stale, b.store.getSnapshot());
  add(b.store, highlight("h2", 1));
  sync(a, b);
  assert.equal((byId(a.store, "h") as PdfHighlightAnnotation).color, "#111111");
});

test("deleting keeps a concurrent edit in the tombstone, and Restore brings it back", () => {
  const [a, b] = [client("a"), client("b")];
  add(a.store, note("n", "start"));
  sync(a, b);
  remove(a.store, "n");
  patch(b.store, "n", { text: "start and more" });
  sync(a, b);
  assert.equal(byId(a.store, "n"), undefined);
  assert.equal(byId(b.store, "n"), undefined, "the delete wins on screen");
  assert.equal(b.store.deleted().length, 1);
  assert.equal(b.store.restore("n"), true);
  sync(a, b);
  assert.equal((byId(a.store, "n") as PdfTextAnnotation).text, "start and more");
});

test("a store tells the viewer who lost a mark", () => {
  const [a, b] = [client("a"), client("b")];
  add(a.store, note("n", "typing"));
  sync(a, b);
  const seen: string[] = [];
  b.store.subscribe((change) => seen.push(...change.removed.map((record) => record.annotation.id)));
  remove(a.store, "n");
  sync(a, b);
  assert.deepEqual(seen, ["n"]);
  b.store.keepDeletedText("n", "typing more", "typing");
  sync(a, b);
  a.store.restore("n");
  assert.equal((byId(a.store, "n") as PdfTextAnnotation).text, "typing more");
});

test("undo reverts only this person's change", () => {
  const [a, b] = [client("a"), client("b")];
  add(a.store, highlight("h"));
  sync(a, b);
  patch(a.store, "h", { color: "#111111" });
  sync(a, b);
  add(b.store, highlight("h2", 1));
  patch(b.store, "h", { quote: "edited by b" });
  sync(a, b);
  a.store.undo();
  sync(a, b);
  const mark = byId(b.store, "h") as PdfHighlightAnnotation;
  assert.equal(mark.color, "#fde047");
  assert.equal(mark.quote, "edited by b");
  assert.ok(byId(a.store, "h2"), "someone else's mark stays");
});

test("undo leaves a field someone else changed since", () => {
  const [a, b] = [client("a"), client("b")];
  add(a.store, highlight("h"));
  sync(a, b);
  patch(a.store, "h", { color: "#111111" });
  sync(a, b);
  patch(b.store, "h", { color: "#222222" });
  sync(a, b);
  a.store.undo();
  sync(a, b);
  assert.equal((byId(a.store, "h") as PdfHighlightAnnotation).color, "#222222");
});

test("undoing a create soft-deletes the mark, so others' edits are recoverable", () => {
  const [a, b] = [client("a"), client("b")];
  add(a.store, note("n", "a's"));
  sync(a, b);
  patch(b.store, "n", { text: "a's and b's" });
  sync(a, b);
  a.store.undo();
  sync(a, b);
  assert.equal(byId(b.store, "n"), undefined);
  a.store.redo();
  sync(a, b);
  assert.equal((byId(b.store, "n") as PdfTextAnnotation).text, "a's and b's");
});

test("a gesture is one undo step, and redo replays it", () => {
  const a = client("a");
  add(a.store, note("n", ""), "note:n");
  patch(a.store, "n", { text: "h" }, "note:n");
  patch(a.store, "n", { text: "he" }, "note:n");
  patch(a.store, "n", { text: "hey" }, "note:n");
  a.store.undo();
  assert.equal(byId(a.store, "n"), undefined);
  assert.equal(a.store.canUndo, false);
  a.store.redo();
  assert.equal((byId(a.store, "n") as PdfTextAnnotation).text, "hey");
});

test("deleting a space and what is in it is one undo step", () => {
  const a = client("a");
  add(a.store, space("s", 0.5));
  add(a.store, ink("i", "s", 1));
  a.store.commit(a.store.getSnapshot().filter((mark) => mark.id !== "s" && mark.id !== "i"));
  assert.equal(a.store.getSnapshot().length, 0);
  a.store.undo();
  assert.equal(a.store.getSnapshot().length, 2);
});

test("a mark drawn in a space someone deleted stays visible at the cut, and returns with the space", () => {
  const [a, b] = [client("a"), client("b")];
  add(a.store, space("s", 0.5));
  sync(a, b);
  remove(a.store, "s");
  add(b.store, ink("late", "s", 2));
  sync(a, b);
  const shown = byId(a.store, "late") as PdfInkAnnotation;
  assert.equal(shown.space, undefined);
  assert.equal(shown.points[0].y, 0.51);
  assert.deepEqual(a.store.getSnapshot(), b.store.getSnapshot());
  a.store.restore("s");
  sync(a, b);
  assert.equal((byId(b.store, "late") as PdfInkAnnotation).space, "s");
});

test("S4: overlapping spaces reconcile the same way in any arrival order", () => {
  const clients = Array.from({ length: 6 }, (_, index) => client(`c${index}`));
  const made = [space("s1", 0.3, 1), space("s2", 0.3, 2), space("s3", 0.31, 3, 0.4), space("s4", 0.5, 4, 0.5), { ...space("s5", 0.4, 5), band: { top: 0.2, bottom: 0.6, splits: [0.5] }, column: 1 }, { ...space("s6", 0.45, 6), band: { top: 0.35, bottom: 0.7, splits: [0.4] }, column: 0 }];
  clients.forEach((item, index) => add(item.store, made[index]));
  const updates = clients.map((item) => Y.encodeStateAsUpdate(item.doc));
  let reference: string | null = null;
  for (let round = 0; round < 40; round += 1) {
    const doc = new Y.Doc();
    for (const update of [...updates].sort(() => Math.random() - 0.5)) Y.applyUpdate(doc, update);
    const shown = JSON.stringify(visibleMarks(readAllMarks(doc)));
    reference ??= shown;
    assert.equal(shown, reference);
  }
});

test("reconciled spaces are never written back", () => {
  const [a, b] = [client("a"), client("b")];
  add(a.store, space("s1", 0.3, 1));
  add(b.store, space("s2", 0.3, 2));
  sync(a, b);
  const before = [...Y.encodeStateVector(a.doc)];
  sync(a, b);
  a.store.commit(a.store.getSnapshot().slice());
  assert.deepEqual([...Y.encodeStateVector(a.doc)], before);
});

test("marks of an unknown type are kept and left alone", () => {
  const a = client("a");
  add(a.store, highlight("h"));
  a.doc.transact(() => {
    const future = new Y.Map<unknown>();
    for (const [key, value] of Object.entries({ id: "f", type: "sticker", createdAt: at(1), createdBy: "x", geometry: { pageNumber: 1, emoji: "x" } })) future.set(key, value);
    marksOf(a.doc).set("f", future);
  });
  assert.equal(a.store.getSnapshot().length, 1);
  patch(a.store, "h", { color: "#111111" });
  assert.equal(marksOf(a.doc).has("f"), true);
  assert.equal(marksOf(a.doc).get("f")?.get("type"), "sticker");
});

test("unknown fields of a known mark survive an edit", () => {
  const a = client("a");
  add(a.store, { ...highlight("h"), futureField: 7 } as PdfAnnotation);
  patch(a.store, "h", { color: "#111111" });
  assert.equal((byId(a.store, "h") as unknown as { futureField: number }).futureField, 7);
});

test("invalid remote values are not shown", () => {
  const a = client("a");
  a.doc.transact(() => {
    const bad = new Y.Map<unknown>();
    for (const [key, value] of Object.entries({ id: "bad", type: "highlight", createdAt: at(1), createdBy: "x", geometry: { pageNumber: 1, rects: [] }, style: { color: "javascript:x" } })) bad.set(key, value);
    marksOf(a.doc).set("bad", bad);
  });
  assert.equal(a.store.getSnapshot().length, 0);
});

test("import is idempotent and never brings a deletion back", () => {
  const [a, b] = [client("a"), client("b")];
  const sidecar = [highlight("h1"), note("n1", "kept"), ink("i1")];
  assert.equal(importMarks(a.doc, sidecar, { accountId: "a" }, "import"), 3);
  sync(a, b);
  remove(b.store, "h1");
  sync(a, b);
  assert.equal(importMarks(a.doc, sidecar, { accountId: "a" }, "import"), 0);
  assert.equal(importMarks(b.doc, sidecar, { accountId: "b" }, "import"), 0);
  assert.equal(byId(a.store, "h1"), undefined);
});

test("large imports split into updates under the limit", () => {
  const doc = new Y.Doc();
  const sizes: number[] = [];
  doc.on("update", (update: Uint8Array) => sizes.push(update.length));
  const strokes = Array.from({ length: 300 }, (_, index): PdfInkAnnotation => ({ ...ink(`i${index}`), points: Array.from({ length: 500 }, (_, point) => ({ x: point / 500, y: 0.123456789 })) }));
  importMarks(doc, strokes, { accountId: "a" }, "import", 1024 * 1024);
  assert.ok(sizes.length > 1);
  assert.ok(Math.max(...sizes) < 4 * 1024 * 1024, `largest update ${Math.max(...sizes)}`);
});

test("S5: what a heavy stroke costs in the document", () => {
  const doc = new Y.Doc();
  const points = Array.from({ length: 500 }, (_, index) => ({ x: Math.round((index / 500) * 1e5) / 1e5, y: Math.round(Math.sin(index) * 1e5) / 1e5 }));
  applyMarksDiff(doc, [], Array.from({ length: 1000 }, (_, index): PdfAnnotation => ({ ...ink(`i${index}`), points })), { accountId: "a" }, null);
  const bytes = Y.encodeStateAsUpdate(doc).length;
  console.log(`[collab-perf] pdf-marks 1000 strokes x 500 points: ${(bytes / 1024 / 1024).toFixed(1)} MB, ${Math.round(bytes / 1000)} bytes per stroke`);
  assert.ok(bytes < 40 * 1024 * 1024);
});

test("reading 10,000 marks stays quick", () => {
  const a = client("a");
  const marks = Array.from({ length: 10_000 }, (_, index) => highlight(`h${index}`, index % 60));
  const started = performance.now();
  a.store.commit(marks);
  const commit = performance.now() - started;
  const reread = performance.now();
  patch(a.store, "h5", { color: "#111111" });
  const change = performance.now() - reread;
  console.log(`[collab-perf] pdf-marks 10,000 marks: commit ${commit.toFixed(0)} ms, one change ${change.toFixed(1)} ms`);
  assert.equal(a.store.getSnapshot().length, 10_000);
  assert.ok(change < 300);
});

test("the keys stay in the annotations sub-document's named roots", () => {
  const a = client("a");
  add(a.store, highlight("h"));
  assert.deepEqual([...a.doc.share.keys()], [PdfKeys.marks]);
});


test("F3: typing after a remote text edit starts a new undo step", () => {
  const a = client("a");
  importMarks(a.doc, [note("n", "base")], { accountId: "importer" }, "import");
  patch(a.store, "n", { text: "base A" }, "typing");
  a.doc.transact(() => (marksOf(a.doc).get("n")!.get("text") as Y.Text).insert(0, "B "), "remote");
  patch(a.store, "n", { text: "B base A C" }, "typing");
  assert.equal(a.store.undo(), true);
  assert.equal((byId(a.store, "n") as PdfTextAnnotation).text, "B base A");
  assert.equal(a.store.redo(), true);
  assert.equal((byId(a.store, "n") as PdfTextAnnotation).text, "B base A C");
});

test("F4: replacement boundaries preserve remote insertions and overlapping replacements", () => {
  assert.equal(mergeText("hello", "bye", "hello!"), "bye!");
  assert.equal(mergeText("cat", "dog", "fox"), "foxdog");
  assert.equal(mergeText("hello", "bye", "!hello"), "!bye");
  assert.equal(mergeText("abc", "", "aBc"), "B");
  assert.equal(mergeText("abc", "aXbc", "abc!"), "aXbc!");
  assert.equal(mergeText("a\nb\nc", "A\nb\nC", "Q"), "QAC");
});

test("F5: editor cleanup merges its pending text with the current tombstone", () => {
  const a = client("a");
  importMarks(a.doc, [note("n", "base")], { accountId: "importer" }, "import");
  a.doc.transact(() => {
    const mark = marksOf(a.doc).get("n")!;
    (mark.get("text") as Y.Text).insert(0, "Their ");
    mark.set("deleted", { by: "b", at: at(2) });
  }, "remote");
  a.store.keepDeletedText("n", "base mine", "base");
  assert.equal(a.store.record("n")!.deleted!.by, "b");
  assert.equal((a.store.record("n")!.annotation as PdfTextAnnotation).text, "Their base mine");
  a.store.restore("n");
  assert.equal((byId(a.store, "n") as PdfTextAnnotation).text, "Their base mine");
});

test("F7/F26: undo writes fresh deletion identity and redo only replays reversed fields", () => {
  const a = client("a");
  importMarks(a.doc, [highlight("h")], { accountId: "importer" }, "import");
  patch(a.store, "h", { color: "#111111" });
  a.doc.transact(() => marksOf(a.doc).get("h")!.set("style", { color: "#fde047" }), "remote");
  assert.equal(a.store.undo(), false);
  assert.equal(a.store.redo(), false);
  assert.equal((byId(a.store, "h") as PdfHighlightAnnotation).color, "#fde047");
  a.doc.transact(() => marksOf(a.doc).get("h")!.set("deleted", { by: "b", at: at(0) }), "remote");
  // Reintroducing a deleted mark records the old tombstone in history.
  add(a.store, highlight("h"));
  a.store.undo();
  assert.equal(a.store.record("h")!.deleted!.by, "a");
  assert.notEqual(a.store.record("h")!.deleted!.at, at(0));
  a.store.redo();
  assert.equal(a.store.record("h")!.deleted, undefined);
});

test("F8: malformed grouped values and nested anchors never reach rendering", () => {
  const a = client("a");
  importMarks(a.doc, [highlight("h"), space("s", 0.5)], { accountId: "importer" }, "import");
  a.doc.transact(() => {
    marksOf(a.doc).get("h")!.set("style", { color: "#111111", rects: null });
    marksOf(a.doc).get("s")!.set("geometry", { pageNumber: 1, y: 0.5, height: 0.2 });
  }, "remote");
  assert.deepEqual(a.store.getSnapshot(), []);
  assert.ok(pdfAnchorViolation({ segments: [], quote: "" }));
  assert.ok(pdfAnchorViolation({ segments: [{ pageNumber: 1, rects: [null] }], quote: "" }));
});

test("F16: invalid local input is refused before any part of a gesture is queued", () => {
  const a = client("a");
  const updates: Uint8Array[] = [];
  a.doc.on("update", (update: Uint8Array) => updates.push(update));
  assert.throws(() => a.store.commit([highlight("good"), note("too-long", "x".repeat(10_001))]), /too long/);
  assert.equal(updates.length, 0);
  assert.equal(marksOf(a.doc).size, 0);
  assert.throws(() => a.store.commit([{ ...note("bad-date"), updatedAt: "invalid" }]), /date/);
  assert.equal(updates.length, 0);
  add(a.store, note("valid", "x".repeat(10_000)));
  assert.equal(updates.length, 1);
});

test("redo leaves a field undo could not take back", () => {
  const [a, b] = [client("a"), client("b")];
  add(a.store, highlight("h"));
  sync(a, b);
  patch(a.store, "h", { color: "#bbbbbb" });
  sync(a, b);
  patch(b.store, "h", { color: "#fde047" });
  sync(a, b);
  a.store.undo();
  a.store.redo();
  sync(a, b);
  assert.equal((byId(b.store, "h") as PdfHighlightAnnotation).color, "#fde047");
});

test("restoring a mark and keeping marks on a new version are steps of their own", () => {
  const a = client("a");
  add(a.store, note("n", "text"));
  add(a.store, highlight("h", 1));
  remove(a.store, "n");
  a.store.restore("n");
  a.store.undo();
  assert.equal(byId(a.store, "n"), undefined, "undo takes back the restore, not an older step");
  assert.ok(byId(a.store, "h"));
  a.store.redo();
  assert.ok(byId(a.store, "n"));

  const hash = "b".repeat(64);
  a.store.acceptVersion([{ id: "h" }], hash, { history: true });
  assert.equal(a.store.record("h")?.sourceHash, hash);
  a.store.undo();
  assert.equal(a.store.record("h")?.sourceHash, undefined);
  a.store.acceptVersion([{ id: "h" }], hash);
  a.store.undo();
  assert.equal(a.store.record("h")?.sourceHash, hash, "automatic relocation is not a step to undo");
});

test("a space covers what is in it, even after someone shrinks it", () => {
  const [a, b] = [client("a"), client("b")];
  add(a.store, space("s", 0.5, 0, 0.3));
  sync(a, b);
  patch(a.store, "s", { height: 0.05 });
  add(b.store, { ...ink("low", "s", 2), points: [{ x: 0.1, y: 0.2 }, { x: 0.2, y: 0.25 }] });
  sync(a, b);
  assert.equal((byId(a.store, "s") as PdfSpaceAnnotation).height, 0.25);
  assert.deepEqual(a.store.getSnapshot(), b.store.getSnapshot());
});

test("marks in a space past the page's limits stay at its cut", () => {
  const clients = Array.from({ length: 3 }, (_, index) => client(`c${index}`));
  // Each fits alone; together they pass the page's growth limit.
  clients.forEach((item, index) => add(item.store, space(`s${index}`, 0.2 + index * 0.2, index, 0.9)));
  add(clients[2].store, ink("in-last", "s2", 5));
  for (const item of clients) for (const other of clients) if (item !== other) sync(item, other);
  const shown = clients[0].store.getSnapshot();
  const hidden = shown.find((mark) => mark.id === "s2");
  if (!hidden) {
    const stroke = shown.find((mark) => mark.id === "in-last") as PdfInkAnnotation;
    assert.equal(stroke.space, undefined);
    assert.equal(stroke.points[0].y, 0.61, "at the cut, not at the top of the page");
  }
  assert.deepEqual(clients[0].store.getSnapshot(), clients[2].store.getSnapshot());
});
