import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { codeLanguageName, loadCodeLanguage } from "../../src/lib/code-languages";
import { MAX_TEXT_FILE_BYTES } from "../../src/lib/storage/constants";
import { getContentType, getFileType } from "../../src/lib/storage/file-types";
import { moveFile, readLiberaFile, updateMarkdownFile } from "../../src/lib/storage/files";
import { getTree } from "../../src/lib/storage/tree";

test("classifies code, data and extensionless text files, keeping BibTeX with LaTeX", () => {
  assert.equal(getFileType("refs.bib"), "latex");
  assert.equal(getFileType("model.PY"), "text");
  assert.equal(getFileType("data.csv"), "text");
  assert.equal(getFileType("Dockerfile"), "text");
  assert.equal(getFileType("Makefile"), "text");
  assert.equal(getFileType("notes.md"), "markdown");
  assert.equal(getFileType("archive.zip"), null);
  assert.equal(getFileType("binary.exe"), null);
  assert.equal(getContentType("page.html", "text"), "text/plain; charset=utf-8");
});

test("picks a highlighting language by file name, with overrides for ambiguous extensions", async () => {
  assert.equal(codeLanguageName("src/main.py"), "Python");
  assert.equal(codeLanguageName("solver.m"), "Octave");
  assert.equal(codeLanguageName("setup.cfg"), "Properties files");
  assert.equal(codeLanguageName("analysis.qmd"), "Markdown");
  assert.equal(codeLanguageName("Dockerfile"), "Dockerfile");
  assert.equal(codeLanguageName("Makefile"), "Plain text");
  assert.equal(codeLanguageName("notes.txt"), "Plain text");
  assert.equal(codeLanguageName("readme.text"), "Plain text");
  assert.ok(await loadCodeLanguage("index.ts"));
  assert.equal(await loadCodeLanguage("notes.txt"), null);
});

test("opens and saves text files, refusing binary or oversized ones only when opening", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-text-files-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  const root = path.join(directory, "users/admin/Alpha");
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "script.py"), "print('hi')\n");
    await writeFile(path.join(root, "blob.dat.txt"), Buffer.from([0x50, 0x4b, 0x00, 0x01]));
    await writeFile(path.join(root, "big.log"), "x".repeat(MAX_TEXT_FILE_BYTES + 1));
    await writeFile(path.join(root, "image.bin"), "ignored");

    const files = (await getTree()).notebooks[0].children.map((node) => node.name).sort();
    assert.deepEqual(files, ["big.log", "blob.dat.txt", "script.py"]);

    const script = await readLiberaFile("Alpha/script.py", { requireContent: true });
    assert.equal(script.file.fileType, "text");
    assert.equal(script.content, "print('hi')\n");
    assert.equal((await updateMarkdownFile("Alpha/script.py", "print('bye')\n")).content, "print('bye')\n");

    await assert.rejects(readLiberaFile("Alpha/blob.dat.txt", { requireContent: true }), /not a text file/);
    await assert.rejects(readLiberaFile("Alpha/big.log", { requireContent: true }), /too large/);
    const moved = await moveFile("Alpha/big.log", "Alpha", "bigger.log");
    assert.equal(moved.content, undefined);
    assert.equal(moved.file.name, "bigger.log");
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
