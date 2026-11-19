// Regression for the 2026-11-19 sync audit, finding 5: a rename on one device and a
// blob replacement on another each write a whole manifest entry, and one whole
// entry wins the merge. The host records the field it changed and writes it
// again on top of the merged entry. Two Y.Docs exchange updates here; each
// "device" is a doc with its own intents, and `settle` plays the host's observer.

import assert from "node:assert/strict";
import test from "node:test";

import * as Y from "yjs";

import { ManifestIntents, trackEntryWrites, type EntryRecord } from "../../electron/collab/notebooks/manifest-intents";
import { ManifestKeys } from "../../src/lib/collab/protocol/schema";

const FILE = "f1";
const OLD = "a".repeat(64);
const NEW = "b".repeat(64);

class Device {
  readonly doc = new Y.Doc();
  readonly intents = new ManifestIntents();
  constructor(clientID: number) {
    this.doc.clientID = clientID;
  }
  get files(): Y.Map<unknown> {
    return this.doc.getMap<unknown>(ManifestKeys.files);
  }
  entry(): EntryRecord {
    return this.files.get(FILE) as EntryRecord;
  }
  /** A local whole-entry write, as every write site does it. */
  write(change: EntryRecord): void {
    trackEntryWrites(this.files, this.intents, () => this.doc.transact(() => this.files.set(FILE, { ...this.entry(), ...change })));
  }
  /** What the host does after the manifest changed. */
  settle(acknowledged = false): void {
    const rewrites = this.intents.reconcile(this.files, acknowledged);
    for (const [fileId, record] of rewrites) {
      trackEntryWrites(this.files, this.intents, () => this.doc.transact(() => this.files.set(fileId, record)));
    }
  }
}

function exchange(a: Device, b: Device): void {
  const toB = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc));
  const toA = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
  Y.applyUpdate(b.doc, toB);
  Y.applyUpdate(a.doc, toA);
}

function pair(): { a: Device; b: Device } {
  // Distinct client ids decide which whole entry wins; both orders are tried below.
  const seed = new Device(1);
  seed.doc.transact(() => seed.files.set(FILE, { fileId: FILE, path: "old.png", kind: "blob", blobHash: OLD, size: 3, mime: "image/png", createdBy: "u", createdAt: 1, updatedAt: 1 }));
  const a = new Device(100);
  const b = new Device(200);
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(seed.doc));
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(seed.doc));
  return { a, b };
}

for (const [renamerId, uploaderId] of [[100, 200], [200, 100]] as const) {
  test(`rename and upload on two devices both survive the merge (renamer client ${renamerId})`, () => {
    const { a, b } = pair();
    a.doc.clientID = renamerId;
    b.doc.clientID = uploaderId;
    a.write({ path: "new.png", updatedAt: 2 });
    b.write({ blobHash: NEW, size: 9, updatedAt: 3 });
    exchange(a, b);
    // Both docs hold the same single winner; one of the two changes is gone.
    assert.deepEqual(a.entry(), b.entry());
    a.settle();
    b.settle();
    exchange(a, b);
    a.settle();
    b.settle();
    exchange(a, b);
    for (const device of [a, b]) {
      assert.equal(device.entry().path, "new.png");
      assert.equal(device.entry().blobHash, NEW);
      assert.equal(device.entry().size, 9);
    }
    assert.deepEqual(a.entry(), b.entry());
  });
}

test("without a re-apply the merge keeps only one of the two changes (the finding)", () => {
  const { a, b } = pair();
  a.write({ path: "new.png", updatedAt: 2 });
  b.write({ blobHash: NEW, size: 9, updatedAt: 3 });
  exchange(a, b);
  const merged = a.entry();
  assert.ok(merged.path === "old.png" || merged.blobHash === OLD, "one change was undone by the whole-entry write");
});

test("a later change by another device is not overridden", () => {
  const { a, b } = pair();
  a.write({ path: "mine.png", updatedAt: 2 });
  exchange(a, b);
  a.settle();
  // The other device renames again on purpose: a third value, not a revert.
  b.write({ path: "theirs.png", updatedAt: 5 });
  exchange(a, b);
  a.settle(true);
  a.settle(true);
  exchange(a, b);
  assert.equal(a.entry().path, "theirs.png");
  assert.equal(b.entry().path, "theirs.png");
  assert.equal(a.intents.size, 0);
});

test("a plain revert to the old value, with nothing else different, is left alone", () => {
  const { a, b } = pair();
  a.write({ path: "mine.png", updatedAt: 2 });
  exchange(a, b);
  b.write({ path: "old.png", updatedAt: 5 });
  exchange(a, b);
  a.settle();
  assert.equal(a.entry().path, "old.png");
  assert.equal(a.intents.size, 0);
});

test("an intent is dropped once the server acknowledged it and the state still holds it", () => {
  const { a } = pair();
  a.write({ path: "mine.png", updatedAt: 2 });
  assert.equal(a.intents.size, 1);
  a.settle(false);
  assert.equal(a.intents.size, 1, "kept while updates are outstanding");
  a.settle(true);
  assert.equal(a.intents.size, 1, "the acknowledgement is noted first");
  a.settle(true);
  assert.equal(a.intents.size, 0);
});

test("an intent for a removed entry is dropped", () => {
  const { a } = pair();
  a.write({ path: "mine.png", updatedAt: 2 });
  a.doc.transact(() => a.files.delete(FILE));
  a.settle();
  assert.equal(a.intents.size, 0);
});

test("two renames before the merge still start from the first old path", () => {
  const { a, b } = pair();
  a.write({ path: "one.png", updatedAt: 2 });
  a.write({ path: "two.png", updatedAt: 3 });
  b.write({ blobHash: NEW, size: 9, updatedAt: 4 });
  a.doc.clientID = 100;
  exchange(a, b);
  a.settle();
  b.settle();
  exchange(a, b);
  assert.equal(a.entry().path, "two.png");
  assert.equal(a.entry().blobHash, NEW);
});

test("intents are bounded", () => {
  const intents = new ManifestIntents();
  for (let index = 0; index < 2100; index++) {
    intents.record(`f${index}`, { kind: "doc", path: "a.md" }, { kind: "doc", path: "b.md" });
  }
  assert.ok(intents.size <= 2000);
});
