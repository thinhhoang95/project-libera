import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { encodeInkSamples, sampleBounds } from "../../src/lib/ink/codec";
import { INK_VERSION, type InkStroke } from "../../src/lib/ink/types";
import { archiveFile, archiveFolder, copyFileToDirectory, createFolder, deleteFile, deleteFolder, moveFile, moveFileToDirectory, renameFolder } from "../../src/lib/storage/files";
import { inkAuthor, inkFolderPath, readInk, reconcileInkFolders, resetInkStorageForTests, writeInk } from "../../src/lib/storage/ink";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { filePathFromParts, notebookPath } from "../../src/lib/storage/paths";
import { ORPHAN_GRACE_MS } from "../../src/lib/storage/pdf-sidecars";
import { getTree } from "../../src/lib/storage/tree";

const FRAME = { unit: "pt", width: 612, height: 792 };

async function withLibrary(run: () => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-ink-storage-"));
  const previous = { data: process.env.LIBERA_DATA_DIR, config: process.env.LIBERA_CONFIG_PATH };
  process.env.LIBERA_DATA_DIR = path.join(directory, "master");
  // The author key lives beside the per-computer config, not in the master directory.
  process.env.LIBERA_CONFIG_PATH = path.join(directory, "user-data", "config.json");
  resetInkStorageForTests();
  try { await createNotebook("Notes"); await run(); }
  finally {
    for (const [key, value] of [["LIBERA_DATA_DIR", previous.data], ["LIBERA_CONFIG_PATH", previous.config]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetInkStorageForTests();
    await rm(directory, { recursive: true, force: true });
  }
}

async function file(relative: string, body = "%PDF-1.4 test") {
  const [notebook, ...parts] = relative.split("/");
  const target = filePathFromParts(notebook, parts);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
  return target;
}

let counter = 0;
function stroke(overrides: Partial<InkStroke> = {}): InkStroke {
  counter += 1;
  const samples = [{ x: 10, y: 10 + counter, pressure: 0.4 }, { x: 60, y: 12 + counter, pressure: 0.7 }];
  return {
    id: `t${counter}x`,
    brush: "pen",
    color: "#1f2328",
    opacity: 1,
    width: 1,
    lineStyle: "solid",
    points: encodeInkSamples(samples),
    bounds: sampleBounds(samples),
    createdAt: new Date(1_700_000_000_000 + counter).toISOString(),
    ...overrides,
  };
}

const ids = async (relative: string, chunk = "page-0001") =>
  (await readInk(relative, [chunk])).chunks[0].strokes.map((item) => item.stroke.id);

test("ink is written per chunk and author, beside the file's path in _ink", () => withLibrary(async () => {
  await file("Notes/Papers/attention.pdf");
  const first = stroke();
  const saved = await writeInk("Notes/Papers/attention.pdf", "page-0001", { add: [first] }, FRAME);
  const { key } = await inkAuthor();
  assert.equal(saved.author, key);
  assert.equal(saved.chunks[0].revision, 1);
  assert.deepEqual(saved.chunks[0].strokes.map((item) => item.stroke.id), [first.id]);

  const onDisk = path.join(notebookPath("Notes"), "_ink", "Papers", "attention.pdf", `page-0001.${key}.ink`);
  const json = JSON.parse(await readFile(onDisk, "utf8"));
  assert.equal(json.format, "libera-ink");
  assert.equal(json.source.size, "%PDF-1.4 test".length);
  assert.match(json.source.sha256, /^[0-9a-f]{64}$/);
  assert.ok(!existsSync(path.join(process.env.LIBERA_DATA_DIR!, "ink-author.json")), "the author key is not in the master directory");

  // Pages without ink read as empty; every inked page is listed when none are asked for.
  await writeInk("Notes/Papers/attention.pdf", "page-0003", { add: [stroke()] }, FRAME);
  const all = await readInk("Notes/Papers/attention.pdf");
  assert.deepEqual(all.chunks.map((chunk) => chunk.chunk), ["page-0001", "page-0003"]);
  assert.deepEqual((await readInk("Notes/Papers/attention.pdf", ["page-0002"])).chunks[0], { chunk: "page-0002", frame: null, strokes: [], revision: 0 });
}));

test("ink writes are checked against the kind of file and the surface", () => withLibrary(async () => {
  await file("Notes/paper.pdf");
  await file("Notes/lecture.md", "# Lecture");
  await file("Notes/map.png", "png");
  await file("Notes/draft.tex", "\\section{x}");
  await assert.rejects(writeInk("Notes/paper.pdf", "image", { add: [stroke()] }, FRAME), /does not belong/);
  await assert.rejects(writeInk("Notes/paper.pdf", "page-0001", { add: [stroke()] }, null), /frame/);
  await assert.rejects(writeInk("Notes/paper.pdf", "page-0001", { add: [{ ...stroke(), color: "red" }] }, FRAME), /malformed/);
  await assert.rejects(writeInk("Notes/draft.tex", "text", { add: [stroke()] }, FRAME), /does not take ink/);
  await assert.rejects(writeInk("Notes/missing.pdf", "page-0001", { add: [stroke()] }, FRAME));
  await writeInk("Notes/lecture.md", "block-7f3c2a", { add: [stroke()] }, { unit: "px", width: 720, height: 240 });
  await writeInk("Notes/lecture.md", "text", { add: [stroke()] }, { unit: "px", width: 720, height: 1 });
  await writeInk("Notes/map.png", "image", { add: [stroke()] }, { unit: "px", width: 4000, height: 3000 });
  assert.equal((await readInk("Notes/lecture.md")).chunks.length, 2);
}));

test("another author's ink is merged in, and erasing it changes only this author's file", () => withLibrary(async () => {
  await file("Notes/paper.pdf");
  const theirs = stroke();
  const folder = inkFolderPath("Notes", ["paper.pdf"]);
  await mkdir(folder, { recursive: true });
  const otherFile = path.join(folder, "page-0001.zzzzzz.ink");
  const other = JSON.stringify({ format: "libera-ink", version: 1, author: { key: "zzzzzz" }, frame: FRAME, strokes: [theirs], erased: [], revision: 4 });
  await writeFile(otherFile, other);
  // A file whose name claims another author is ignored.
  await writeFile(path.join(folder, "page-0001.yyyyyy.ink"), other);

  const mine = stroke();
  await writeInk("Notes/paper.pdf", "page-0001", { add: [mine] }, FRAME);
  assert.deepEqual((await ids("Notes/paper.pdf")).sort(), [mine.id, theirs.id].sort());

  const erased = await writeInk("Notes/paper.pdf", "page-0001", { erase: [theirs.id] }, FRAME);
  assert.deepEqual(erased.chunks[0].strokes.map((item) => item.stroke.id), [mine.id]);
  assert.equal(await readFile(otherFile, "utf8"), other, "the other author's file is never written");
  assert.deepEqual(await ids("Notes/paper.pdf"), [mine.id]);

  // Undo brings it back.
  await writeInk("Notes/paper.pdf", "page-0001", { unerase: [theirs] }, FRAME);
  assert.deepEqual((await ids("Notes/paper.pdf")).sort(), [mine.id, theirs.id].sort());
}));

test("concurrent writes from several windows all land", () => withLibrary(async () => {
  await file("Notes/paper.pdf");
  const strokes = Array.from({ length: 20 }, () => stroke());
  await Promise.all(strokes.map((item) => writeInk("Notes/paper.pdf", "page-0001", { add: [item] }, FRAME)));
  assert.deepEqual((await ids("Notes/paper.pdf")).sort(), strokes.map((item) => item.id).sort());
  assert.equal((await readInk("Notes/paper.pdf", ["page-0001"])).chunks[0].revision, 20);
}));

test("ink written by a newer Libera is not overwritten", () => withLibrary(async () => {
  await file("Notes/paper.pdf");
  await writeInk("Notes/paper.pdf", "page-0001", { add: [stroke()] }, FRAME);
  const { key } = await inkAuthor();
  const own = path.join(inkFolderPath("Notes", ["paper.pdf"]), `page-0001.${key}.ink`);
  const json = JSON.parse(await readFile(own, "utf8"));
  await writeFile(own, JSON.stringify({ ...json, version: INK_VERSION + 1 }));
  await assert.rejects(writeInk("Notes/paper.pdf", "page-0001", { add: [stroke()] }, FRAME), /newer version/);
}));

test("ink follows files and folders through renames, moves, copies, archive and deletion", () => withLibrary(async () => {
  await file("Notes/old/paper.pdf");
  const kept = stroke();
  await writeInk("Notes/old/paper.pdf", "page-0001", { add: [kept] }, FRAME);

  await moveFile("Notes/old/paper.pdf", "Notes", "renamed.pdf");
  assert.deepEqual(await ids("Notes/old/renamed.pdf"), [kept.id]);
  await renameFolder("Notes/old", "new");
  assert.deepEqual(await ids("Notes/new/renamed.pdf"), [kept.id]);
  await copyFileToDirectory("Notes/new/renamed.pdf", "Notes", "copy.pdf");
  assert.deepEqual(await ids("Notes/copy.pdf"), [kept.id]);
  assert.deepEqual(await ids("Notes/new/renamed.pdf"), [kept.id], "copying keeps the original's ink");

  await createNotebook("Other");
  await moveFileToDirectory("Notes/copy.pdf", "Other");
  assert.deepEqual(await ids("Other/copy.pdf"), [kept.id]);
  await archiveFile("Other/copy.pdf");
  assert.deepEqual(await ids("Other/_archive/copy.pdf"), [kept.id]);
  await archiveFolder("Notes/new");
  assert.deepEqual(await ids("Notes/_archive/new/renamed.pdf"), [kept.id]);

  await deleteFile("Other/_archive/copy.pdf");
  await file("Other/_archive/copy.pdf");
  assert.deepEqual(await ids("Other/_archive/copy.pdf"), [], "a new file does not inherit deleted ink");
  await deleteFolder("Notes/_archive/new");
  await file("Notes/_archive/new/renamed.pdf");
  assert.deepEqual(await ids("Notes/_archive/new/renamed.pdf"), []);
  assert.deepEqual(await readdir(path.join(notebookPath("Notes"), "_ink", "_archive")).catch(() => []), []);
}));

test("_ink is hidden from the tree and reserved as a name", () => withLibrary(async () => {
  await file("Notes/paper.pdf");
  await writeInk("Notes/paper.pdf", "page-0001", { add: [stroke()] }, FRAME);
  const tree = await getTree();
  const notes = tree.notebooks.find((notebook) => notebook.name === "Notes")!;
  assert.deepEqual(notes.children.map((child) => child.name), ["paper.pdf"]);
  await assert.rejects(createFolder("Notes", "_ink"), /reserved/);
}));

test("ink finds a PDF renamed outside Libera by its bytes, and waits for a deleted one", () => withLibrary(async () => {
  await file("Notes/paper.pdf", "%PDF-1.4 unique bytes");
  const kept = stroke();
  await writeInk("Notes/paper.pdf", "page-0001", { add: [kept] }, FRAME);
  const files = (paths: string[]) => paths.map((item) => ({ path: item, size: "%PDF-1.4 unique bytes".length }));

  await rename(filePathFromParts("Notes", ["paper.pdf"]), filePathFromParts("Notes", ["moved.pdf"]));
  assert.deepEqual(await reconcileInkFolders("Notes", files(["Notes/moved.pdf"])), { reattached: 1, setAside: 0 });
  assert.deepEqual(await ids("Notes/moved.pdf"), [kept.id]);

  // Deleted outside Libera: set aside after a grace period, then restored when it comes back.
  const bytes = await readFile(filePathFromParts("Notes", ["moved.pdf"]));
  await rm(filePathFromParts("Notes", ["moved.pdf"]));
  const now = Date.now();
  assert.deepEqual(await reconcileInkFolders("Notes", [], { now }), { reattached: 0, setAside: 0 });
  assert.deepEqual(await reconcileInkFolders("Notes", [], { now: now + ORPHAN_GRACE_MS }), { reattached: 0, setAside: 1 });
  assert.ok(!existsSync(inkFolderPath("Notes", ["moved.pdf"])));

  await writeFile(filePathFromParts("Notes", ["back again.pdf"]), bytes);
  assert.deepEqual(await reconcileInkFolders("Notes", files(["Notes/back again.pdf"]), { now: now + ORPHAN_GRACE_MS + 1 }), { reattached: 1, setAside: 0 });
  assert.deepEqual(await ids("Notes/back again.pdf"), [kept.id]);
}));
