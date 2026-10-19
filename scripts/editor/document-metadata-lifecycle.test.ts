import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNotebook, deleteNotebook, renameNotebook } from "../../src/lib/storage/notebooks";
import { readLastNotebookName, writeLastNotebookName } from "../../src/lib/storage/last-notebook";
import { deleteMarkdownImageSource, getMarkdownImageAsset, pruneUnusedMarkdownImageAssets, writeMarkdownImageAsset } from "../../src/lib/storage/markdown-assets";
import { filePathFromParts, getAdminRoot, notebookPath } from "../../src/lib/storage/paths";
import { refreshNotebookCitations } from "../../src/lib/storage/reference-citations";
import { getTree } from "../../src/lib/storage/tree";
import { populateRelatedNotebooks } from "../../src/lib/storage/notebook-links";

async function withLibrary(run: () => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-document-metadata-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try { await createNotebook("Alpha"); await run(); }
  finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test("notebook relationships reflect same-size external edits with restored timestamps", () => withLibrary(async () => {
  await createNotebook("Bravo"); await createNotebook("Delta");
  await writeFile(filePathFromParts("Bravo", ["target.md"]), "target");
  await writeFile(filePathFromParts("Delta", ["target.md"]), "target");
  const target = filePathFromParts("Alpha", ["note.md"]);
  await writeFile(target, "[target](../Bravo/target.md)");
  const related = async () => (await getTree()).notebooks.find((notebook) => notebook.name === "Alpha")!.relatedNotebookNames;
  assert.deepEqual(await related(), ["Bravo"]);
  const before = await stat(target);
  await writeFile(target, "[target](../Delta/target.md)");
  await utimes(target, before.atime, before.mtime);
  assert.deepEqual(await related(), ["Delta"]);
}));

test("citation indexes refresh equal-size edits with restored timestamps and reuse unchanged parses", () => withLibrary(async () => {
  const target = filePathFromParts("Alpha", ["note.md"]);
  await writeFile(target, "[@first]");
  const fixedTime = new Date("2026-10-01T00:00:00.000Z");
  await utimes(target, fixedTime, fixedTime);
  assert.deepEqual((await refreshNotebookCitations("Alpha")).byFile["Alpha/note.md"], ["first"]);
  const before = await stat(target);
  await writeFile(target, "[@other]");
  await utimes(target, before.atime, before.mtime);
  const changed = await refreshNotebookCitations("Alpha");
  assert.deepEqual(changed.byFile["Alpha/note.md"], ["other"]);
  const repeated = await refreshNotebookCitations("Alpha");
  assert.equal(repeated.stats.read, 0);
  assert.equal(repeated.stats.written, false);
}));

test("renaming and deleting the remembered notebook updates the stored preference", () => withLibrary(async () => {
  await createNotebook("Other");
  await writeLastNotebookName("Alpha");
  await renameNotebook("Alpha", "Renamed");
  assert.equal(await readLastNotebookName(), "Renamed");
  await assert.rejects(writeLastNotebookName("Alpha"));
  assert.equal(await readLastNotebookName(), "Renamed", "a stale window cannot save the old notebook name again");
  assert.equal((await getTree()).lastNotebookName, "Renamed");
  await deleteNotebook("Renamed");
  assert.equal(await readLastNotebookName(), "");
  const preference = JSON.parse(await readFile(path.join(getAdminRoot(), ".libera", "last-notebook.json"), "utf8"));
  assert.equal(preference.notebook, "");
}));

test("changing a different notebook leaves the user's latest selection alone", () => withLibrary(async () => {
  await createNotebook("Other");
  await writeLastNotebookName("Other");
  await renameNotebook("Alpha", "Renamed");
  assert.equal(await readLastNotebookName(), "Other");
  await deleteNotebook("Renamed");
  assert.equal(await readLastNotebookName(), "Other");
}));

test("externally removed notebooks are not returned as the remembered selection", () => withLibrary(async () => {
  await writeLastNotebookName("Alpha");
  await rm(notebookPath("Alpha"), { recursive: true });
  assert.equal(await readLastNotebookName(), "");
}));

test("pruning removed Markdown images also removes empty asset folders", () => withLibrary(async () => {
  const document = filePathFromParts("Alpha", ["note.md"]);
  await writeFile(document, "text");
  const asset = await writeMarkdownImageAsset("Alpha/note.md", new File(["image"], "pic.png"));
  assert.equal((await getMarkdownImageAsset("Alpha/note.md", asset.assetPath)).body.toString(), "image");
  await pruneUnusedMarkdownImageAssets("Alpha/note.md", "text");
  assert.ok(!existsSync(path.join(notebookPath("Alpha"), "_assets")));
}));

test("a source removed during a library scan neither breaks the refresh nor retains old relationships", () => withLibrary(async () => {
  await createNotebook("Bravo");
  await writeFile(filePathFromParts("Bravo", ["target.md"]), "target");
  const target = filePathFromParts("Alpha", ["note.md"]);
  await writeFile(target, "[target](../Bravo/target.md)");
  const tree = await getTree();
  const alpha = tree.notebooks.find((notebook) => notebook.name === "Alpha")!;
  const source = alpha.children.find((node) => node.path === "Alpha/note.md")!;
  assert.ok(source.kind === "file" && source.linkedFilePaths?.length);
  await rm(target);
  await populateRelatedNotebooks(tree.notebooks);
  assert.deepEqual(alpha.relatedNotebookNames, []);
  assert.ok(source.kind === "file" && !source.linkedFilePaths);
  await rm(notebookPath("Alpha"), { recursive: true });
  await populateRelatedNotebooks(tree.notebooks);
  assert.ok(!existsSync(notebookPath("Alpha")), "index rebuilding cannot recreate the removed notebook");
}));

test("nested asset cleanup removes empty parents and preserves another document's live image", () => withLibrary(async () => {
  await mkdir(filePathFromParts("Alpha", ["a", "b"]), { recursive: true });
  await writeFile(filePathFromParts("Alpha", ["a", "b", "note.md"]), "text");
  await writeFile(filePathFromParts("Alpha", ["other.md"]), "text");
  const nested = await writeMarkdownImageAsset("Alpha/a/b/note.md", new File(["nested"], "pic.png"));
  const other = await writeMarkdownImageAsset("Alpha/other.md", new File(["keep"], "pic.png"));
  await pruneUnusedMarkdownImageAssets("Alpha/a/b/note.md", "text");
  assert.ok(!existsSync(path.join(notebookPath("Alpha"), "_assets", "a")));
  assert.equal((await getMarkdownImageAsset("Alpha/other.md", other.assetPath)).body.toString(), "keep");
  await deleteMarkdownImageSource({ documentPath: "Alpha/other.md", imageSource: other.assetPath });
  assert.ok(!existsSync(path.join(notebookPath("Alpha"), "_assets")));
  assert.ok(existsSync(filePathFromParts("Alpha", ["a", "b", "note.md"])));
  assert.ok(nested.assetPath.includes("a/b/"));
}));
