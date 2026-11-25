import assert from "node:assert/strict";
import fsp, { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test, { mock } from "node:test";
import { pythonSidecarPath } from "../../src/lib/python/sidecar";
import { archiveFolder, deleteFolder, moveFile, renameFolder } from "../../src/lib/storage/files";
import { withPathLocks } from "../../src/lib/storage/fs-utils";
import { movePythonSidecar } from "../../src/lib/storage/markdown-assets";
import { addReviewThreads, findReview, loadReview } from "../../src/lib/storage/markdown-reviews";
import { filePathFromParts, getAdminRoot } from "../../src/lib/storage/paths";
import { assertNotebookSound, splitLibraryPath, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

// Round 2026-11-25, package F3: folder operations and Python sidecars
// (L-C4 item 1 for folders, L-C2 folder part, L-H1).

const PYTHON = "print('hi')\n";
const pythonCode = (note: string) => path.join(getAdminRoot(), ...pythonSidecarPath(note).split("/"));
const exists = (target: string) => stat(target).then(() => true, () => false);
const disk = (relative: string) => { const { notebook, parts } = splitLibraryPath(relative); return filePathFromParts(notebook, parts); };

test("a folder operation waits for whoever holds the folder's path (L-C4)", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/old/n.md", "# N\n");
  await writeLibraryFile("Nb/gone/n.md", "# N\n");
  await writeLibraryFile("Nb/arch/n.md", "# N\n");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const holders = [disk("Nb/old"), disk("Nb/gone"), disk("Nb/arch")].map((target) => withPathLocks([target], () => held));
  const operations = [renameFolder("Nb/old", "new"), deleteFolder("Nb/gone"), archiveFolder("Nb/arch")];
  // Real disk work takes longer than a few turns of the event loop: give an unlocked operation time to finish.
  await new Promise<void>((resolve) => setTimeout(resolve, 400));
  assert.ok(await exists(disk("Nb/old/n.md")) && await exists(disk("Nb/gone/n.md")) && await exists(disk("Nb/arch/n.md")), "nothing happened while the folders were held");
  release();
  await Promise.all([...holders, ...operations]);
  assert.ok(await exists(disk("Nb/new/n.md")));
  assert.ok(!(await exists(disk("Nb/gone"))));
  assert.ok(await exists(disk("Nb/_archive/arch/n.md")));
  await assertNotebookSound("Nb");
}));

test("a folder move never replaces an empty folder made at its destination meanwhile (L-C4)", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/old/n.md", "# N\n");
  const original = fsp.rename;
  let made = false;
  // The destination appears after the checks, empty; a raw rename would take it over on POSIX.
  mock.method(fsp, "rename", async (from: string, to: string) => {
    if (!made && String(to).endsWith(`${path.sep}new`)) { made = true; await mkdir(String(to)); }
    return original(from, to);
  });
  try {
    await assert.rejects(() => renameFolder("Nb/old", "new"), (error) => (error as { status?: number }).status === 409);
  } finally { mock.restoreAll(); }
  assert.ok(made, "the destination was made meanwhile");
  assert.ok(await exists(disk("Nb/old/n.md")), "the folder stayed");
  assert.ok(await exists(disk("Nb/new")), "what arrived at the destination was kept");
}));

test("a moved folder's reviews replace an empty review already at the destination (L-C2)", () => withTemporaryLibrary(["Nb"], async () => {
  const text = "# N\n\nsome text\n";
  await writeLibraryFile("Nb/old/n.md", text);
  await writeLibraryFile("Nb/old/m.md", text);
  // Opening files that are not there yet made empty reviews at the destination, before the source had one.
  await loadReview("Nb/new/n.md", text);
  await loadReview("Nb/new/m.md", text);
  await addReviewThreads("Nb/old/n.md", text, [{ range: { start: 0, end: 3 }, text: "a comment" }]);
  await renameFolder("Nb/old", "new");
  const moved = await findReview("Nb/new/n.md");
  assert.equal(moved?.threads.length, 1, "the moved review is the one found at the new path");
  assert.equal(await findReview("Nb/old/n.md"), null);
  // The empty review of a note that had none to bring simply stays.
  assert.ok(await findReview("Nb/new/m.md"));
  await assertNotebookSound("Nb");
}));

test("a case-only folder rename with Python code succeeds (L-H1)", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/Drafts/a.md", "# A\n");
  await writeLibraryFile("Nb/Drafts/b.md", "# B\n");
  await writeAt(pythonCode("Nb/Drafts/a.md"), PYTHON);
  await writeAt(pythonCode("Nb/Drafts/b.md"), "print('b')\n");
  await renameFolder("Nb/Drafts", "drafts");
  assert.ok((await readdir(path.join(getAdminRoot(), "Nb"))).includes("drafts"), "the folder is spelled as asked");
  assert.ok((await readFile(pythonCode("Nb/drafts/a.md"), "utf8")).startsWith(PYTHON));
  assert.ok((await readFile(pythonCode("Nb/drafts/b.md"), "utf8")).startsWith("print('b')"));
  // The code sits in folders spelled like the new path, so the check finds each note's code.
  const assets = path.join(getAdminRoot(), "Nb", "_assets");
  assert.deepEqual(await readdir(assets), ["drafts"]);
  assert.deepEqual((await readdir(path.join(assets, "drafts"))).sort(), ["a.md", "b.md"]);
  await assertNotebookSound("Nb");
}));

test("a case-only file rename takes the Python code into the correctly spelled folder (L-H1)", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/notes/Analysis.md", "# A\n");
  await writeAt(pythonCode("Nb/notes/Analysis.md"), PYTHON);
  await moveFile("Nb/notes/Analysis.md", "Nb", "analysis.md");
  const folder = path.join(getAdminRoot(), "Nb", "_assets", "notes");
  assert.deepEqual(await readdir(folder), ["analysis.md"]);
  assert.deepEqual(await readdir(path.join(folder, "analysis.md")), ["analysis.py"]);
  assert.ok((await readFile(pythonCode("Nb/notes/analysis.md"), "utf8")).startsWith(PYTHON));
  await assertNotebookSound("Nb");
}));

test("a refused Python move leaves the source code unwritten, and a rollback never replaces (L-H1)", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/old/n.md", "# N\n");
  await writeAt(pythonCode("Nb/old/n.md"), PYTHON);
  await writeAt(pythonCode("Nb/new/n.md"), "theirs\n");
  await assert.rejects(() => movePythonSidecar("Nb/old/n.md", "Nb/new/n.md", { exclusive: true }), (error) => (error as { status?: number }).status === 409);
  assert.equal(await readFile(pythonCode("Nb/old/n.md"), "utf8"), PYTHON, "the source is byte for byte what it was");
  assert.equal(await movePythonSidecar("Nb/old/n.md", "Nb/new/n.md", { replace: false }), false);
  assert.equal(await readFile(pythonCode("Nb/old/n.md"), "utf8"), PYTHON);
  assert.equal(await readFile(pythonCode("Nb/new/n.md"), "utf8"), "theirs\n");
}));
