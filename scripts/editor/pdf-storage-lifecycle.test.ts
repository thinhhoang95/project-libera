import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { directoryModeStatePath, directoryStateRoot, legacyDirectoryStateRoot, readDirectoryModeState } from "../../electron/directory-mode.cjs";
import { readPdfAnnotations, writePdfAnnotations } from "../../src/lib/storage/annotations";
import { closeDirectory, openDirectory } from "../../src/lib/storage/directory-mode";
import { archiveFile, archiveFolder, copyFileToDirectory, deleteFile, deleteFolder, moveFile, moveFileToDirectory, renameFolder } from "../../src/lib/storage/files";
import { writeJsonAtomically } from "../../src/lib/storage/fs-utils";
import { createNotebook, deleteNotebook, renameNotebook } from "../../src/lib/storage/notebooks";
import { filePathFromParts, getAdminRoot, getLinkedFolder, legacyFlatPdfAnnotationsPath, legacyPdfAnnotationsPath, pdfAnnotationsPath, pdfTextCacheDirectoryPath, pdfTextCachePath } from "../../src/lib/storage/paths";
import { readFreshPdfTextCache, readPdfTextCache } from "../../src/lib/storage/pdf-text-cache";
import { readFileSignature } from "../../src/lib/storage/file-signature";
import { getTree } from "../../src/lib/storage/tree";

async function withLibrary(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "libera-pdf-lifecycle-"));
  const previous = process.env.LIBERA_DATA_DIR;
  const machine = process.env.LIBERA_MACHINE_ID;
  process.env.LIBERA_DATA_DIR = path.join(root, "library");
  process.env.LIBERA_MACHINE_ID = "computer-a";
  try { await createNotebook("Notes"); await run(root); } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    if (machine === undefined) delete process.env.LIBERA_MACHINE_ID; else process.env.LIBERA_MACHINE_ID = machine;
    await rm(root, { recursive: true, force: true });
  }
}

async function pdf(relative: string, text = "PDF body") {
  const [notebook, ...parts] = relative.split("/");
  const target = filePathFromParts(notebook, parts);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
  return target;
}

function extractor() {
  let calls = 0;
  return { get calls() { return calls; }, extractPages: async (target: string) => {
    calls++;
    return [{ pageNumber: 1, text: await readFile(target, "utf8") }];
  } };
}

function note(text: string) {
  return [{ type: "text", id: text, pageNumber: 1, text, rect: { x: 0, y: 0, width: 0.1, height: 0.1 } }];
}

async function noteText(relative: string) {
  const annotations = (await readPdfAnnotations(relative)).annotations;
  return annotations.map((annotation) => annotation.type === "text" ? annotation.text : "");
}

test("PDF annotations are independent for duplicate filenames and do not invalidate text", async () => withLibrary(async () => {
  await pdf("Notes/a/paper.pdf"); await pdf("Notes/b/paper.pdf");
  const extraction = extractor();
  await readPdfTextCache("Notes/a/paper.pdf", extraction);
  await writePdfAnnotations("Notes/a/paper.pdf", note("first"));
  await writePdfAnnotations("Notes/b/paper.pdf", note("second"));
  await readPdfTextCache("Notes/a/paper.pdf", extraction);
  assert.equal(extraction.calls, 1);
  assert.deepEqual(await noteText("Notes/a/paper.pdf"), ["first"]);
  assert.deepEqual(await noteText("Notes/b/paper.pdf"), ["second"]);
  await deleteFile("Notes/a/paper.pdf");
  assert.deepEqual(await noteText("Notes/b/paper.pdf"), ["second"]);
}));

test("text and annotations survive file/folder/notebook moves, copies and archive", async () => withLibrary(async () => {
  await pdf("Notes/a/paper.pdf");
  await writePdfAnnotations("Notes/a/paper.pdf", note("portable note"));
  const extraction = extractor();
  await readPdfTextCache("Notes/a/paper.pdf", extraction);
  await moveFile("Notes/a/paper.pdf", "Notes", "renamed.pdf");
  await readPdfTextCache("Notes/a/renamed.pdf", extraction);
  await renameFolder("Notes/a", "b");
  assert.equal((await readPdfTextCache("Notes/b/renamed.pdf", extraction)).path, "Notes/b/renamed.pdf");
  assert.deepEqual(await noteText("Notes/b/renamed.pdf"), ["portable note"]);
  await copyFileToDirectory("Notes/b/renamed.pdf", "Notes", "copy.pdf");
  await readPdfTextCache("Notes/copy.pdf", extraction);
  assert.deepEqual(await noteText("Notes/copy.pdf"), ["portable note"]);
  await createNotebook("Other");
  await moveFileToDirectory("Notes/copy.pdf", "Other");
  await readPdfTextCache("Other/copy.pdf", extraction);
  assert.deepEqual(await noteText("Other/copy.pdf"), ["portable note"]);
  await archiveFile("Other/copy.pdf");
  await readPdfTextCache("Other/_archive/copy.pdf", extraction);
  assert.deepEqual(await noteText("Other/_archive/copy.pdf"), ["portable note"]);
  await archiveFolder("Notes/b");
  await readPdfTextCache("Notes/_archive/b/renamed.pdf", extraction);
  assert.deepEqual(await noteText("Notes/_archive/b/renamed.pdf"), ["portable note"]);
  await renameNotebook("Notes", "Renamed");
  await readPdfTextCache("Renamed/_archive/b/renamed.pdf", extraction);
  assert.equal(extraction.calls, 1, "all operations reused the original extraction");
  await deleteNotebook("Other");
  assert.equal(existsSync(pdfTextCacheDirectoryPath("Other", [])), false);
}));

test("a synced library reuses text despite different paths, timestamps and file identities", async () => withLibrary(async (root) => {
  await pdf("Notes/paper.pdf"); await writePdfAnnotations("Notes/paper.pdf", note("synced"));
  const extraction = extractor();
  await readPdfTextCache("Notes/paper.pdf", extraction);
  const second = path.join(root, "computer-b-library");
  await cp(process.env.LIBERA_DATA_DIR!, second, { recursive: true });
  process.env.LIBERA_DATA_DIR = second;
  process.env.LIBERA_MACHINE_ID = "computer-b";
  assert.equal((await readFreshPdfTextCache("Notes/paper.pdf"))?.pages[0].text, "PDF body");
  await readPdfTextCache("Notes/paper.pdf", extraction);
  assert.equal(extraction.calls, 1);
  assert.deepEqual(await noteText("Notes/paper.pdf"), ["synced"]);
  await pdf("Notes/paper.pdf", "new body");
  assert.equal(await readFreshPdfTextCache("Notes/paper.pdf"), null);
  assert.equal((await readPdfTextCache("Notes/paper.pdf", extraction)).pages[0].text, "new body");
  assert.equal(extraction.calls, 2);
}));

test("folder deletion removes notes and cache, and external deletion prunes orphan caches", async () => withLibrary(async () => {
  const target = await pdf("Notes/folder/paper.pdf");
  const extraction = extractor();
  await writePdfAnnotations("Notes/folder/paper.pdf", note("old"));
  await readPdfTextCache("Notes/folder/paper.pdf", extraction);
  await deleteFolder("Notes/folder");
  await pdf("Notes/folder/paper.pdf", "replacement");
  assert.deepEqual(await noteText("Notes/folder/paper.pdf"), []);
  await readPdfTextCache("Notes/folder/paper.pdf", extraction);
  await rm(target);
  await getTree();
  assert.equal(existsSync(pdfTextCachePath("Notes", ["folder", "paper.pdf"])), false);
}));

test("stale destination cache directories do not break folder renames", async () => withLibrary(async () => {
  await pdf("Notes/old/paper.pdf");
  const extraction = extractor();
  await readPdfTextCache("Notes/old/paper.pdf", extraction);
  const destination = pdfTextCacheDirectoryPath("Notes", ["new"]);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "orphan.pdf.json"), "{}");
  await renameFolder("Notes/old", "new");
  await readPdfTextCache("Notes/new/paper.pdf", extraction);
  assert.equal(extraction.calls, 1);
  assert.equal(existsSync(filePathFromParts("Notes", ["new", "paper.pdf"])), true);
}));

test("invalid JSON, malformed entries and incomplete page sequences regenerate", async () => withLibrary(async () => {
  await pdf("Notes/paper.pdf"); const extraction = extractor();
  await readPdfTextCache("Notes/paper.pdf", extraction);
  const cachePath = pdfTextCachePath("Notes", ["paper.pdf"]);
  const original = JSON.parse(await readFile(cachePath, "utf8"));
  for (const pages of [[], [null], [{pageNumber: 1, text: null}], [{pageNumber: 2, text: "wrong"}], [{pageNumber: 1, text: "a"}, {pageNumber: 1, text: "b"}]]) {
    await writeFile(cachePath, JSON.stringify({ ...original, pages }));
    assert.equal(await readFreshPdfTextCache("Notes/paper.pdf"), null);
    assert.equal((await readPdfTextCache("Notes/paper.pdf", extraction)).pages[0].text, "PDF body");
  }
  await writeFile(cachePath, "{");
  await readPdfTextCache("Notes/paper.pdf", extraction);
  await writeFile(cachePath, JSON.stringify({ ...original, pageCount: 2 }));
  await readPdfTextCache("Notes/paper.pdf", extraction);
  assert.equal(extraction.calls, 8);
}));

test("local v2 caches upgrade without extraction, foreign v2 caches regenerate", async () => withLibrary(async () => {
  const target = await pdf("Notes/paper.pdf");
  const cachePath = pdfTextCachePath("Notes", ["paper.pdf"]);
  const metadata = await stat(target);
  const legacy = { version: 2, path: "Notes/paper.pdf", pdfUpdatedAt: metadata.mtime.toISOString(), pdfSize: metadata.size,
    pdfSignature: await readFileSignature(target), generatedAt: "2026-01-01T00:00:00Z", pages: [{pageNumber: 1, text: "Legacy extraction"}] };
  await mkdir(path.dirname(cachePath), {recursive:true}); await writeFile(cachePath, JSON.stringify(legacy));
  const extraction = extractor();
  assert.equal((await readPdfTextCache("Notes/paper.pdf", extraction)).pages[0].text, "Legacy extraction");
  assert.equal(extraction.calls, 0);
  assert.equal(JSON.parse(await readFile(cachePath, "utf8")).version, 3);
  await writeFile(cachePath, JSON.stringify({...legacy, pdfSignature: "another computer"}));
  await readPdfTextCache("Notes/paper.pdf", extraction);
  assert.equal(extraction.calls, 1);
}));

test("concurrent requests share extraction and failures remain retryable", async () => withLibrary(async () => {
  await pdf("Notes/paper.pdf");
  let calls = 0;
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const extracting = new Promise<void>((resolve) => { started = resolve; });
  const extractPages = async () => { calls++; started(); await ready; return [{pageNumber: 1, text: "shared"}]; };
  const reads = Array.from({length: 6}, () => readPdfTextCache("Notes/paper.pdf", {extractPages}));
  await extracting; release();
  const results = await Promise.all(reads);
  assert.equal(calls, 1); assert.ok(results.every((result) => result.pages[0].text === "shared"));
  await rm(pdfTextCachePath("Notes", ["paper.pdf"]));
  await assert.rejects(readPdfTextCache("Notes/paper.pdf", {extractPages: async () => { throw new Error("temporary"); }}), /temporary/);
  assert.equal((await readPdfTextCache("Notes/paper.pdf", extractor())).pages[0].text, "PDF body");
}));

test("cache storage failures preserve extracted text and leave no temporary files", async () => withLibrary(async () => {
  await pdf("Notes/paper.pdf");
  const cachePath = pdfTextCachePath("Notes", ["paper.pdf"]);
  await mkdir(cachePath, {recursive:true}); // Publishing to a directory fails on every platform.
  assert.equal((await readPdfTextCache("Notes/paper.pdf", extractor())).pages[0].text, "PDF body");
  assert.deepEqual(await readdir(path.dirname(cachePath)), ["paper.pdf.json"]);
}));

test("atomic JSON publication keeps old content visible until commit", async () => withLibrary(async (root) => {
  const target = path.join(root, "atomic.json");
  await writeFile(target, '{"old":true}');
  await writeJsonAtomically(target, {new:true}, async () => { assert.deepEqual(JSON.parse(await readFile(target, "utf8")), {old:true}); });
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), {new:true});
}));

test("changed, deleted and moved PDFs during extraction cannot publish stale caches", async () => withLibrary(async () => {
  for (const action of ["change", "delete", "move"]) {
    const relative = `Notes/${action}.pdf`;
    const target = await pdf(relative);
    await assert.rejects(readPdfTextCache(relative, {extractPages: async () => {
      if (action === "change") await writeFile(target, "changed");
      else if (action === "delete") await rm(target);
      else await rename(target, `${target}.moved`);
      return [{pageNumber:1,text:"old"}];
    }}));
    assert.equal(existsSync(pdfTextCachePath("Notes", [`${action}.pdf`])), false);
  }
}));

test("unique legacy annotations migrate before moves and folder deletion", async () => withLibrary(async () => {
  await pdf("Notes/folder/paper.pdf");
  const flat = legacyFlatPdfAnnotationsPath("Notes", "paper.pdf");
  await mkdir(path.dirname(flat), {recursive:true}); await writeFile(flat, JSON.stringify({annotations:note("legacy")}));
  await renameFolder("Notes/folder", "renamed");
  assert.deepEqual(await noteText("Notes/renamed/paper.pdf"), ["legacy"]);
  assert.equal(existsSync(flat), false);
  await pdf("Notes/renamed/second.pdf");
  await writeFile(legacyPdfAnnotationsPath("Notes", "second.pdf"), JSON.stringify({annotations:note("dot legacy")}));
  await deleteFolder("Notes/renamed");
  await pdf("Notes/renamed/second.pdf");
  assert.deepEqual(await noteText("Notes/renamed/second.pdf"), []);
}));

test("ambiguous legacy annotations are preserved for recovery and never guessed", async () => withLibrary(async () => {
  await pdf("Notes/a/paper.pdf"); await pdf("Notes/b/paper.pdf");
  const flat = legacyFlatPdfAnnotationsPath("Notes", "paper.pdf");
  await mkdir(path.dirname(flat), {recursive:true}); await writeFile(flat, JSON.stringify({annotations:note("unknown owner")}));
  assert.deepEqual(await noteText("Notes/a/paper.pdf"), []);
  const backups = (await readdir(path.dirname(flat))).filter((name) => name.startsWith("paper.pdf.json.ambiguous-"));
  assert.equal(backups.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(path.dirname(flat), backups[0]), "utf8")).annotations[0].text, "unknown owner");
  await deleteFile("Notes/a/paper.pdf");
  assert.deepEqual(await noteText("Notes/b/paper.pdf"), []);
  await writePdfAnnotations("Notes/b/paper.pdf", note("new owner"));
  assert.equal(existsSync(pdfAnnotationsPath("Notes", ["b", "paper.pdf"])), true);
}));

test("linked folder identity reconnects synced annotations and caches and retains each computer's path", async () => withLibrary(async (root) => {
  const first = path.join(root, "computer-a", "Thesis");
  const second = path.join(root, "computer-b", "Thesis");
  await mkdir(first, {recursive:true}); await writeFile(path.join(first, "paper.pdf"), "Linked body");
  const linked = await openDirectory(first);
  await writePdfAnnotations(`${linked.name}/paper.pdf`, note("linked note"));
  const extraction = extractor(); await readPdfTextCache(`${linked.name}/paper.pdf`, extraction);
  const stateRoot = getLinkedFolder(linked.name)!.stateRoot;
  await cp(first, second, {recursive:true});
  process.env.LIBERA_MACHINE_ID = "computer-b";
  const reopened = await openDirectory(second);
  assert.equal(reopened.name, linked.name);
  assert.equal(getLinkedFolder(linked.name)!.stateRoot, stateRoot);
  assert.deepEqual(await noteText(`${linked.name}/paper.pdf`), ["linked note"]);
  await readPdfTextCache(`${linked.name}/paper.pdf`, extraction);
  assert.equal(extraction.calls, 1);
  assert.equal(getLinkedFolder(linked.name)!.path, second);
  process.env.LIBERA_MACHINE_ID = "computer-a";
  assert.equal(readDirectoryModeState(getAdminRoot()).folders.find((folder) => folder.name === linked.name)!.path, first);
  // Touching settings on computer A must not discard B's location mapping.
  await openDirectory(first);
  process.env.LIBERA_MACHINE_ID = "computer-b";
  assert.equal(readDirectoryModeState(getAdminRoot()).folders.find((folder) => folder.name === linked.name)!.path, second);
  closeDirectory(linked.name);
}));

test("legacy linked-folder state migrates to its stable identity", async () => withLibrary(async (root) => {
  const folder = path.join(root, "Legacy"); await mkdir(folder);
  const legacyRoot = legacyDirectoryStateRoot(getAdminRoot(), folder);
  await mkdir(path.join(legacyRoot, ".libera"), {recursive:true});
  await writeFile(path.join(legacyRoot, ".libera", "old-state.json"), '{"keep":true}');
  await writeFile(directoryModeStatePath(getAdminRoot()), JSON.stringify({version:2,folders:[{name:"Legacy",path:folder}],recent:[]}));
  const state = readDirectoryModeState(getAdminRoot());
  assert.ok(state.folders[0].id);
  assert.equal(existsSync(path.join(folder, ".libera-folder.json")), true);
  assert.deepEqual(JSON.parse(await readFile(path.join(directoryStateRoot(getAdminRoot(),folder), ".libera", "old-state.json"), "utf8")), {keep:true});
}));

test("linked folder state follows a copied Master directory onto a second computer", async () => withLibrary(async (root) => {
  const first = path.join(root, "source", "Project");
  const second = path.join(root, "destination", "Project");
  await mkdir(first, {recursive:true}); await writeFile(path.join(first, "paper.pdf"), "linked source");
  const linked = await openDirectory(first);
  await writePdfAnnotations(`${linked.name}/paper.pdf`, note("cross-computer note"));
  const extraction = extractor(); await readPdfTextCache(`${linked.name}/paper.pdf`, extraction);
  const originalRoot = process.env.LIBERA_DATA_DIR!;
  const originalStateRoot = getLinkedFolder(linked.name)!.stateRoot;
  const secondRoot = path.join(root, "new-master");
  await cp(first, second, {recursive:true});
  await cp(originalRoot, secondRoot, {recursive:true});
  process.env.LIBERA_DATA_DIR = secondRoot;
  process.env.LIBERA_MACHINE_ID = "computer-b";
  const reopened = await openDirectory(second);
  assert.equal(reopened.name, linked.name);
  assert.equal(path.basename(getLinkedFolder(linked.name)!.stateRoot), path.basename(originalStateRoot));
  assert.deepEqual(await noteText(`${linked.name}/paper.pdf`), ["cross-computer note"]);
  await readPdfTextCache(`${linked.name}/paper.pdf`, extraction);
  assert.equal(extraction.calls, 1);
  const syncedState = await readFile(directoryModeStatePath(getAdminRoot()), "utf8");
  process.env.LIBERA_DATA_DIR = originalRoot;
  process.env.LIBERA_MACHINE_ID = "computer-a";
  await writeFile(directoryModeStatePath(getAdminRoot()), syncedState);
  assert.equal(getLinkedFolder(linked.name)!.path, first, "incoming settings preserve this computer's local path");
}));

test("foreign location mappings never connect an unrelated directory at the same path", async () => withLibrary(async (root) => {
  const original = path.join(root, "Project");
  const synced = path.join(root, "correct-copy");
  await mkdir(original); await writeFile(path.join(original, "paper.pdf"), "correct");
  const linked = await openDirectory(original);
  await writePdfAnnotations(`${linked.name}/paper.pdf`, note("correct note"));
  await rename(original, synced);
  await mkdir(original); await writeFile(path.join(original, "other.pdf"), "unrelated");
  process.env.LIBERA_MACHINE_ID = "computer-b";
  assert.equal(getLinkedFolder(linked.name)!.unresolved, true);
  const node = (await getTree()).notebooks.find((notebook) => notebook.name === linked.name)!;
  assert.equal(node.folder?.missing, true);
  assert.deepEqual(node.children, []);
  assert.throws(() => filePathFromParts(linked.name, ["other.pdf"]), /reconnect/);
  const reopened = await openDirectory(synced);
  assert.equal(reopened.name, linked.name);
  assert.deepEqual(await noteText(`${linked.name}/paper.pdf`), ["correct note"]);
}));

test("offline linked folders keep cached text until their drive returns", async () => withLibrary(async (root) => {
  const folder = path.join(root, "Drive"); await mkdir(folder);
  await writeFile(path.join(folder, "paper.pdf"), "offline body");
  const linked = await openDirectory(folder);
  const extraction = extractor(); await readPdfTextCache(`${linked.name}/paper.pdf`, extraction);
  const cachePath = pdfTextCachePath(linked.name, ["paper.pdf"]);
  await rename(folder, `${folder}-unplugged`);
  await getTree();
  assert.equal(existsSync(cachePath), true);
  await rename(`${folder}-unplugged`, folder);
  await readPdfTextCache(`${linked.name}/paper.pdf`, extraction);
  assert.equal(extraction.calls, 1);
}));

test("concurrent legacy reads preserve the same migrated annotation", async () => withLibrary(async () => {
  await pdf("Notes/paper.pdf");
  const flat = legacyFlatPdfAnnotationsPath("Notes", "paper.pdf");
  await mkdir(path.dirname(flat), {recursive:true});
  await writeFile(flat, JSON.stringify({annotations:note("legacy concurrent")}));
  const values = await Promise.all(Array.from({length: 5}, () => noteText("Notes/paper.pdf")));
  assert.ok(values.every((value) => value[0] === "legacy concurrent"));
}));

test("aborted atomic writes remove only the empty directory tree they created", async () => withLibrary(async (root) => {
  const created = path.join(root, "deleted-notebook");
  const target = path.join(created, ".libera", "pdf-text", "paper.pdf.json");
  await assert.rejects(writeJsonAtomically(target, {pages:[]}, async () => { throw new Error("source deleted"); }), /source deleted/);
  assert.equal(existsSync(created), false);
  assert.equal(existsSync(root), true);
}));

test("read-only legacy annotation storage remains readable without migration", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async () => withLibrary(async () => {
  await pdf("Notes/paper.pdf");
  const legacy = legacyFlatPdfAnnotationsPath("Notes", "paper.pdf");
  await mkdir(path.dirname(legacy), {recursive:true});
  await writeFile(legacy, JSON.stringify({annotations:note("read only")}));
  await chmod(path.dirname(legacy), 0o555);
  try {
    assert.deepEqual(await noteText("Notes/paper.pdf"), ["read only"]);
    assert.equal(existsSync(pdfAnnotationsPath("Notes", ["paper.pdf"])), false);
  } finally { await chmod(path.dirname(legacy), 0o755); }
}));

test("shapes, pen strokes and line markup round-trip, and malformed ones are dropped or repaired", async () => withLibrary(async () => {
  await pdf("Notes/drawn.pdf");
  const base = { pageNumber: 1, createdAt: "2026-10-15", updatedAt: "2026-10-15" };
  const { annotations } = await writePdfAnnotations("Notes/drawn.pdf", [
    { ...base, id: "u", type: "highlight", color: "#d92d20", markup: "underline", rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }] },
    { ...base, id: "h", type: "highlight", color: "#ffe45c", markup: "glitter", rects: [{ x: 0.1, y: 0.2, width: 0.2, height: 0.02 }] },
    { ...base, id: "a", type: "shape", shape: "arrow", color: "#1d4ed8", strokeWidth: 99, from: { x: -1, y: 0.2 }, to: { x: 0.5, y: 2 } },
    { ...base, id: "bad-shape", type: "shape", shape: "star", color: "#1d4ed8", strokeWidth: 2, from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
    { ...base, id: "i", type: "ink", color: "not a color", strokeWidth: 2, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: "x" }] },
    { ...base, id: "empty-ink", type: "ink", color: "#1d4ed8", strokeWidth: 2, points: [] },
  ]);

  assert.deepEqual(annotations.map((annotation) => annotation.id), ["u", "h", "a", "i"]);
  const [underline, highlight, arrow, ink] = annotations;
  assert.equal(underline.type === "highlight" && underline.markup, "underline");
  assert.equal(highlight.type === "highlight" && "markup" in highlight, false, "unknown markup falls back to a highlight");
  assert.deepEqual(arrow.type === "shape" && { from: arrow.from, to: arrow.to, strokeWidth: arrow.strokeWidth }, {
    from: { x: 0, y: 0.2 }, to: { x: 0.5, y: 1 }, strokeWidth: 24,
  });
  assert.deepEqual(ink.type === "ink" && { color: ink.color, points: ink.points }, {
    color: "#1d4ed8", points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0 }],
  });
  assert.deepEqual((await readPdfAnnotations("Notes/drawn.pdf")).annotations, annotations);
}));
