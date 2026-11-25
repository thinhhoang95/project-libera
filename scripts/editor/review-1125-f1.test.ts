import assert from "node:assert/strict";
import { linkSync } from "node:fs";
import fsp, { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inkBlockChunk, inkBlockFrame } from "../../src/lib/ink/block";
import { encodeInkSamples, sampleBounds } from "../../src/lib/ink/codec";
import type { InkStroke } from "../../src/lib/ink/types";
import { DEFINITIONS_VERSION } from "../../src/lib/definitions";
import { StorageError } from "../../src/lib/storage/errors";
import { localFileIdentity } from "../../src/lib/storage/file-identity";
import { assertLocalFileIdentity, moveFile, readLiberaFile } from "../../src/lib/storage/files";
import { isCaseOnlyRename, moveWithoutReplacing, withPathLocks } from "../../src/lib/storage/fs-utils";
import { inkFolderPath, writeInk } from "../../src/lib/storage/ink";
import { writeDefinitions } from "../../src/lib/storage/definitions";
import { definitionsPath, filePathFromParts } from "../../src/lib/storage/paths";
import { getFileNode } from "../../src/lib/storage/tree";
import { assertNotebookSound, splitLibraryPath, withTemporaryLibrary, writeLibraryFile } from "./notebook-test-helpers";

// Review 2026-11-25, package F1: fs primitives, locks and file identity.

const exists = (target: string) => stat(target).then(() => true, () => false);
const rejects409 = (promise: Promise<unknown>) => assert.rejects(promise, (error) => error instanceof StorageError && error.status === 409);

async function withScratch(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-f1-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

// ---- L-C3 -------------------------------------------------------------------------------

test("L-C3: moveWithoutReplacing clears empty folders at the destination but refuses one that holds a file", () => withScratch(async (dir) => {
  const source = path.join(dir, "source");
  await mkdir(source);
  await writeFile(path.join(source, "a.txt"), "a");
  const empty = path.join(dir, "empty", "deep", "deeper");
  await mkdir(empty, { recursive: true });
  await moveWithoutReplacing(source, path.join(dir, "empty"));
  assert.equal(await readFile(path.join(dir, "empty", "a.txt"), "utf8"), "a");
  assert.equal(await exists(path.join(dir, "empty", "deep")), false);

  const second = path.join(dir, "second");
  await mkdir(second);
  await writeFile(path.join(second, "b.txt"), "b");
  const taken = path.join(dir, "taken");
  await mkdir(path.join(taken, "inner"), { recursive: true });
  await writeFile(path.join(taken, "inner", "keep.txt"), "mine");
  await rejects409(moveWithoutReplacing(second, taken));
  assert.equal(await readFile(path.join(taken, "inner", "keep.txt"), "utf8"), "mine");
  assert.equal(await readFile(path.join(second, "b.txt"), "utf8"), "b");
}));

/** Makes a rename out of `from` fail as a move to another drive does; `before` runs first (a record arriving at the destination, say). */
async function withCrossDeviceMove(from: string, before: () => Promise<void>, run: () => Promise<void>) {
  const original = fsp.rename;
  fsp.rename = (async (source: Parameters<typeof original>[0], target: Parameters<typeof original>[1]) => {
    if (source === from) {
      await before();
      throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
    }
    return original(source, target);
  }) as typeof original;
  try { await run(); } finally { fsp.rename = original; }
}

test("L-C3: a move to another drive copies into a staging sibling and publishes it in one rename", () => withScratch(async (dir) => {
  const source = path.join(dir, "source");
  await mkdir(path.join(source, "nested"), { recursive: true });
  await writeFile(path.join(source, "nested", "a.txt"), "a");
  const destination = path.join(dir, "out", "dest");
  await withCrossDeviceMove(source, async () => undefined, () => moveWithoutReplacing(source, destination));
  assert.equal(await readFile(path.join(destination, "nested", "a.txt"), "utf8"), "a");
  assert.equal(await exists(source), false);
  assert.deepEqual(await readdir(path.join(dir, "out")), ["dest"]);
}));

test("L-C3: a record that arrives at the destination during a cross-drive move is kept and the move is a 409 that leaves nothing half-copied", () => withScratch(async (dir) => {
  const source = path.join(dir, "source");
  await mkdir(source);
  await writeFile(path.join(source, "a.txt"), "a");
  const destination = path.join(dir, "out", "dest");
  const arrive = async () => { await mkdir(destination, { recursive: true }); await writeFile(path.join(destination, "theirs.txt"), "theirs"); };
  await withCrossDeviceMove(source, arrive, async () => { await rejects409(moveWithoutReplacing(source, destination)); });
  assert.equal(await readFile(path.join(destination, "theirs.txt"), "utf8"), "theirs");
  assert.equal(await readFile(path.join(source, "a.txt"), "utf8"), "a");
  assert.deepEqual(await readdir(destination), ["theirs.txt"]);
  assert.deepEqual(await readdir(path.join(dir, "out")), ["dest"], "the staging copy is removed");
}));

// ---- L-H4 -------------------------------------------------------------------------------

test("L-H4: path locks treat an NFD and an NFC spelling (and a case change) of one name as one lock", async () => {
  const base = path.join(os.tmpdir(), "libera-f1-locks");
  const nfd = path.join(base, "Café.md");
  const nfc = path.join(base, "CAFÉ.md");
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = withPathLocks([nfd], async () => { order.push("first:start"); await gate; order.push("first:end"); });
  const second = withPathLocks([nfc], async () => { order.push("second"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first:start"], "the second waits for the first");
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

test("L-H4: an NFD name and its NFC spelling, or a case change, that are one file are a rename of that file", () => withScratch(async (dir) => {
  // NTFS keeps NFD and NFC names apart; a hard link gives two spellings of one file, as macOS does for one name.
  const nfd = path.join(dir, "Café.md");
  const upper = path.join(dir, "CAFÉ.md");
  await writeFile(nfd, "x");
  linkSync(nfd, upper);
  assert.equal(await isCaseOnlyRename(nfd, upper), true);
  // Two different files whose names fold together are not one file.
  const first = path.join(dir, "Naïve.md");
  const second = path.join(dir, "Naïve.md");
  await writeFile(first, "1");
  await writeFile(second, "2");
  assert.equal(await isCaseOnlyRename(first, second), false);
}));

// ---- U-C3 -------------------------------------------------------------------------------

test("U-C3: a file opened in a tab carries the tree's local identity, and tab-initiated moves and deletes run the identity check", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/note.md", "# one\n");
  const opened = await readLiberaFile("Nb/note.md");
  const { notebook, parts } = splitLibraryPath("Nb/note.md");
  const node = await getFileNode(notebook, parts);
  assert.equal(opened.file.fileId, localFileIdentity(opened.file));
  assert.equal(node.fileId, opened.file.fileId);

  // Another file takes the path (the first was deleted and recreated outside the app): the tab's identity no longer matches.
  await rm(filePathFromParts(notebook, parts));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeLibraryFile("Nb/note.md", "# a different, longer file\n");
  await rejects409(moveFile("Nb/note.md", "Nb", "renamed.md", { expectedFileId: opened.file.fileId }));
  await rejects409(assertLocalFileIdentity("Nb/note.md", opened.file.fileId!));
  assert.equal(await exists(filePathFromParts(notebook, parts)), true);

  const fresh = await readLiberaFile("Nb/note.md");
  await moveFile("Nb/note.md", "Nb", "renamed.md", { expectedFileId: fresh.file.fileId });
  assert.equal(await exists(filePathFromParts("Nb", ["renamed.md"])), true);
  await assertNotebookSound("Nb");
}));

// ---- L-C4 item 3 -------------------------------------------------------------------------

let strokeCount = 0;
function stroke(): InkStroke {
  strokeCount += 1;
  const samples = [{ x: 20, y: 20 + strokeCount, pressure: 0.4 }, { x: 300, y: 30 + strokeCount, pressure: 0.8 }];
  return { id: `f1s${strokeCount}x`, brush: "pen", color: "#1f2328", opacity: 1, width: 2, lineStyle: "solid", points: encodeInkSamples(samples), bounds: sampleBounds(samples), createdAt: new Date(1_700_000_000_000 + strokeCount).toISOString() };
}

test("L-C4 (3): an ink save that races a delete does not recreate the ink folder at the old path", () => withTemporaryLibrary(["Nb"], async () => {
  const target = await writeLibraryFile("Nb/note.md", "# note\n");
  const chunk = inkBlockChunk("k3f9q2m8x1c4v7b0");
  let write!: Promise<unknown>;
  // A delete holds the source's lock; the save arrives meanwhile and must wait for it, then see the file gone.
  await withPathLocks([target], async () => {
    write = writeInk("Nb/note.md", chunk, { add: [stroke()] }, inkBlockFrame());
    write.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await rm(target);
  });
  await rejects409(write);
  assert.equal(await exists(inkFolderPath("Nb", ["note.md"])), false);
  await assertNotebookSound("Nb");
}));

test("L-C4 (3): a definitions save that races a delete does not recreate the sidecar at the old path", () => withTemporaryLibrary(["Nb"], async () => {
  const target = await writeLibraryFile("Nb/note.md", "# note\n");
  const definitions = { version: DEFINITIONS_VERSION, documentPath: "Nb/note.md", generatedAt: "2026-01-01T00:00:00.000Z", source: null, entries: [] } as Parameters<typeof writeDefinitions>[1];
  let write!: Promise<unknown>;
  await withPathLocks([target], async () => {
    write = writeDefinitions("Nb/note.md", definitions);
    write.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await rm(target);
  });
  await rejects409(write);
  assert.equal(await exists(definitionsPath("Nb", ["note.md"])), false);
  await assertNotebookSound("Nb");
}));

test("L-C4 (3): saves of an existing file still go through", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/note.md", "# note\n");
  const definitions = { version: DEFINITIONS_VERSION, documentPath: "Nb/note.md", generatedAt: "2026-01-01T00:00:00.000Z", source: null, entries: [] } as Parameters<typeof writeDefinitions>[1];
  await writeDefinitions("Nb/note.md", definitions);
  await writeInk("Nb/note.md", inkBlockChunk("k3f9q2m8x1c4v7b0"), { add: [stroke()] }, inkBlockFrame());
  assert.equal(await exists(definitionsPath("Nb", ["note.md"])), true);
  assert.equal(await exists(inkFolderPath("Nb", ["note.md"])), true);
}));
