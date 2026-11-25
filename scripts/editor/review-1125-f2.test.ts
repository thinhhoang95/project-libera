import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { bibTetherStatePath } from "../../src/lib/references/bib-tether";
import { destinationRecords } from "../../src/lib/storage/destination-records";
import { StorageError } from "../../src/lib/storage/errors";
import { archiveFile, copyFileToDirectory, deleteFile, findAvailableCopyPath, moveFile, moveFileToDirectory } from "../../src/lib/storage/files";
import { writeMarkdownImageAsset } from "../../src/lib/storage/markdown-assets";
import { legacyPythonSidecarPath } from "../../src/lib/python/sidecar";
import { pathExists } from "../../src/lib/storage/fs-utils";
import { getStateRoot, filePathFromParts, legacyFlatPdfAnnotationsPath, orphanedSidecarsDirectoryPath } from "../../src/lib/storage/paths";
import { localFileIdentity } from "../../src/lib/storage/file-identity";
import { stat, writeFile } from "node:fs/promises";
import { assertNotebookSound, splitLibraryPath, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

// F2 of the 2026-11-25 file-moving review: single-file operations and destination records.

const refused = (error: unknown) => error instanceof StorageError && error.status === 409;
const stateFile = (...parts: string[]) => path.join(getStateRoot(), ...parts);

test("L-C1: a damaged review index stops findAvailableCopyPath instead of looping", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a.md", "# a\n");
  await writeAt(stateFile(".libera", "reviews", "index.json"), "{ not json");
  await assert.rejects(Promise.race([
    findAvailableCopyPath("Nb", [], "a.md", "markdown"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("still looping")), 5000).unref()),
  ]), refused);
}));

test("L-C4: delete refuses a file replaced after the identity was read, under the lock", () => withTemporaryLibrary(["Nb"], async () => {
  const target = await writeLibraryFile("Nb/a.md", "# a\n");
  const stats = await stat(target);
  const id = localFileIdentity({ createdAt: stats.birthtime.toISOString(), size: stats.size });
  // Another file of another size took the path.
  await writeFile(target, "# a much longer replacement\n");
  await assert.rejects(deleteFile("Nb/a.md", { expectedFileId: id }), refused);
  assert.ok(await pathExists(target));
  // The file the person chose is deleted.
  const now = await stat(target);
  await deleteFile("Nb/a.md", { expectedFileId: localFileIdentity({ createdAt: now.birthtime.toISOString(), size: now.size }) });
  assert.equal(await pathExists(target), false);
  await assertNotebookSound("Nb");
}));

test("L-C4: archive skips a name that holds records of an older layout", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a.pdf", "%PDF-1.4 a");

  // The archive name "a.pdf" would be given the notes written under that name in the older layout: another name is used.
  await writeAt(legacyFlatPdfAnnotationsPath("Nb", "a.pdf"), JSON.stringify({ annotations: [] }));
  const moved = await archiveFile("Nb/a.pdf");
  assert.ok(await pathExists(filePathFromParts("Nb", ["_archive", moved.file.name])));
}));

test("L-C4: archive retries a name taken meanwhile", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a.md", "# a\n");
  await writeLibraryFile("Nb/_archive/a.md", "# earlier\n");
  const moved = await archiveFile("Nb/a.md");
  assert.equal(moved.file.name, "a-1.md");
  assert.equal(await readFile(filePathFromParts("Nb", ["_archive", "a.md"]), "utf8"), "# earlier\n");
  await assertNotebookSound("Nb");
}));

test("L-H5: a .bib tether, a hash-less set-aside record, an undo snapshot, legacy Python code and unreadable stores count at a destination", () => withTemporaryLibrary(["Nb"], async () => {
  // .bib tether naming Nb/refs.bib
  await writeAt(bibTetherStatePath("Nb"), JSON.stringify({
    version: 1, target: { kind: "notebook", path: "refs.bib" }, dialect: "bibtex", prefer: "library", tetheredAt: new Date().toISOString(),
    status: { state: "synced", warnings: [] }, base: null,
  }));
  let records = await destinationRecords();
  assert.equal(records.blocker, null);
  assert.deepEqual(await records.at("Nb", ["refs.bib"], "bibtex"), [".bib tether"]);

  // Set-aside record without an identity
  await writeAt(path.join(orphanedSidecarsDirectoryPath("Nb", "annotations"), "1-x-b.pdf.json"), JSON.stringify({ kind: "annotations", originalPath: "Nb/b.pdf", orphanedAt: new Date().toISOString(), source: null, sidecar: { annotations: [] } }));
  records = await destinationRecords();
  assert.ok((await records.at("Nb", ["b.pdf"], "pdf")).includes("set-aside side file"));
  // Not for another name.
  assert.deepEqual(await records.at("Nb", ["c.pdf"], "pdf"), []);

  // Undo snapshot of an agent run
  await writeAt(stateFile(".libera", "agent-runs", "run-12345678.json"), JSON.stringify({ version: 1, runId: "run-12345678", createdAt: new Date().toISOString(), files: { "Nb/u.md": { existed: false, written: "" } } }));
  records = await destinationRecords();
  assert.ok((await records.at("Nb", ["u.md"], "markdown")).includes("undo history"));

  // Legacy Python code of a note
  await writeLibraryFile(legacyPythonSidecarPath("Nb/py.md"), "print(1)\n");
  records = await destinationRecords();
  assert.ok((await records.at("Nb", ["py.md"], "markdown")).includes("Python code"));

  // An unreadable store is a blocker, and a move onto a path is refused rather than judged free.
  await writeAt(stateFile(".libera", "agent-runs", "bad-run-1.json"), "{ nope");
  records = await destinationRecords();
  assert.ok(records.blocker);
  await writeLibraryFile("Nb/m.md", "# m\n");
  await assert.rejects(moveFile("Nb/m.md", "Nb", "free.md"), refused);
  await assert.rejects(findAvailableCopyPath("Nb", [], "m.md", "markdown"), refused);
  assert.ok(await pathExists(filePathFromParts("Nb", ["m.md"])));
}));

test("L-H5: a move onto a hash-less set-aside record's path is refused", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a.pdf", "%PDF-1.4 a");
  await writeAt(path.join(orphanedSidecarsDirectoryPath("Nb", "annotations"), "1-x-b.pdf.json"), JSON.stringify({ kind: "annotations", originalPath: "Nb/b.pdf", orphanedAt: new Date().toISOString(), source: null, sidecar: { annotations: [] } }));
  await assert.rejects(moveFile("Nb/a.pdf", "Nb", "b.pdf"), refused);
  assert.ok(await pathExists(filePathFromParts("Nb", ["a.pdf"])));
}));

test("L-M4: a file moved onto its own path is a no-op success", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a.md", "# a\n");
  const result = await moveFile("Nb/a.md", "Nb", "a.md");
  assert.equal(result.file.path, "Nb/a.md");
  assert.equal(await readFile(filePathFromParts("Nb", ["a.md"]), "utf8"), "# a\n");
  await assertNotebookSound("Nb");
}));

test("L-M4: a copy skips a name whose records exist (the metadata rollback itself is not forced here)", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a.pdf", "%PDF-1.4 a");
  // A file where the copy's annotations folder would be makes the metadata copy fail.
  await writeLibraryFile("Nb/a.pdf.sidecar-source", "x");
  const { pdfAnnotationsPath } = await import("../../src/lib/storage/paths");
  await writeAt(pdfAnnotationsPath("Nb", ["a.pdf"]), JSON.stringify({ annotations: [] }));
  const blocked = pdfAnnotationsPath("Nb", ["a copy.pdf"]);
  await mkdir(path.dirname(blocked), { recursive: true });
  await mkdir(blocked, { recursive: true });
  await writeAt(path.join(blocked, "keep"), "x");
  // The destination holds records (a folder at the annotations path): the name is skipped, not overwritten.
  const copy = await copyFileToDirectory("Nb/a.pdf", "Nb", "a copy.pdf");
  assert.notEqual(copy.file.name, "a copy.pdf");
  await rm(blocked, { recursive: true, force: true });
}));

test("L-M4: a .md to .txt rename that strands _assets images is refused", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a.md", "# a\n");
  const upload = await writeMarkdownImageAsset("Nb/a.md", new File(["photo"], "photo.png"));
  await writeLibraryFile("Nb/a.md", `# a\n\n${upload.markdown}\n`);
  await assert.rejects(moveFile("Nb/a.md", "Nb", "a.txt"), refused);
  assert.ok(await pathExists(filePathFromParts("Nb", ["a.md"])));
  await writeLibraryFile("Nb/b.md", "# b\n");
  await moveFile("Nb/b.md", "Nb", "b.txt");
  await assertNotebookSound("Nb");
}));

test("L-M4: a cross-notebook note move rewrites its images atomically", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  await writeLibraryFile("Nb/a.md", "# a\n");
  const upload = await writeMarkdownImageAsset("Nb/a.md", new File(["photo"], "photo.png"));
  await writeLibraryFile("Nb/a.md", `# a\n\n${upload.markdown}\n`);
  const moved = await moveFileToDirectory("Nb/a.md", "Other");
  assert.equal(moved.file.path, "Other/a.md");
  const { notebook, parts } = splitLibraryPath("Other/a.md");
  assert.ok((await readFile(filePathFromParts(notebook, parts), "utf8")).includes("!["));
  // No staged file is left beside it.
  assert.deepEqual((await readdir(path.dirname(filePathFromParts(notebook, parts)))).filter((name) => name.endsWith(".tmp")), []);
  await assertNotebookSound("Other");
}));
