import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withTemporaryLibrary, writeLibraryFile } from "./notebook-test-helpers";
import { listPendingReviews, withReviewWrite } from "../../src/lib/agent/review-store";
import { listRunFiles, RunSnapshots } from "../../src/lib/agent/snapshots";
import { archiveFolder, createMarkdownFile, deleteFolder, renameFolder } from "../../src/lib/storage/files";
import { planMigration, resumeMigration, runMigration, setMigrationFaultForTests, type MigrationRequest } from "../../src/lib/storage/migration";
import { createNotebook, deleteNotebook, renameNotebook } from "../../src/lib/storage/notebooks";
import { filePathFromParts, notebookPath } from "../../src/lib/storage/paths";
import { getTree } from "../../src/lib/storage/tree";

const withLibrary = (run: () => Promise<void>) => withTemporaryLibrary(["Src", "Dst"], run);

async function interruptTwoFileMigration() {
  await writeLibraryFile("Src/sub/a.md", "a");
  await writeLibraryFile("Src/sub/b.md", "b");
  const request: MigrationRequest = { source: "Src", paths: ["Src/sub/a.md", "Src/sub/b.md"], destination: { notebook: "Dst" } };
  const plan = await planMigration(request);
  setMigrationFaultForTests((point) => { if (point === "published:Src/sub/a.md") throw new Error("simulated crash"); });
  let result;
  try { result = await runMigration(request, plan.token); }
  finally { setMigrationFaultForTests(null); }
  assert.equal(result.state, "interrupted");
  return result;
}

test("an interrupted migration blocks renaming, archiving and deleting a folder above its files, and the notebook, but not other work", () => withLibrary(async () => {
  await writeLibraryFile("Src/other/x.md", "x");
  const interrupted = await interruptTwoFileMigration();

  await assert.rejects(renameFolder("Src/sub", "renamed"), /being moved/);
  await assert.rejects(archiveFolder("Src/sub"), /being moved/);
  await assert.rejects(deleteFolder("Src/sub"), /being moved/);
  await assert.rejects(renameNotebook("Src", "Source"), (error: { status?: number }) => error.status === 409);
  await assert.rejects(renameNotebook("Dst", "Target"), (error: { status?: number }) => error.status === 409);
  await assert.rejects(deleteNotebook("Src"), (error: { status?: number }) => error.status === 409);

  // Unrelated folders and new files beside the migrating ones are not fenced.
  await renameFolder("Src/other", "elsewhere");
  await createMarkdownFile("Src", "new.md", "", "Src/sub");
  // Changing only colour/emoji of the notebook keeps working.
  await renameNotebook("Src", "Src", { color: "#336699" });

  const resumed = await resumeMigration(interrupted.id, "continue");
  assert.equal(resumed.state, "done");
  assert.equal(await readFile(filePathFromParts("Dst", ["sub", "a.md"]), "utf8"), "a");
  assert.equal(await readFile(filePathFromParts("Dst", ["sub", "b.md"]), "utf8"), "b");
  // Once it finished, the folder and the notebook can be renamed again.
  await renameFolder("Src/sub", "renamed");
  await renameNotebook("Src", "Source");
}));

test("renaming a notebook carries pending agent reviews and undo history, and listing skips an entry whose notebook is gone", () => withLibrary(async () => {
  await createNotebook("Old");
  await writeLibraryFile("Old/n.md", "before\n");
  await withReviewWrite("Old/n.md", "before\n", "run-rename-1", async () => { await writeLibraryFile("Old/n.md", "before\nagent\n"); });
  const snapshots = new RunSnapshots("run-rename-1");
  await snapshots.recordOriginal("Old/n.md", "before\n");
  await snapshots.recordWritten("Old/n.md", "before\nagent\n");
  assert.deepEqual((await listPendingReviews()).map((review) => review.path), ["Old/n.md"]);

  await renameNotebook("Old", "New");
  assert.deepEqual((await listPendingReviews()).map((review) => review.path), ["New/n.md"]);
  assert.deepEqual((await listRunFiles()).files.map((entry) => entry.path), ["New/n.md"]);

  // An entry left under a name that is no notebook is neither an error nor dropped.
  await withReviewWrite("New/n.md", "before\n", "run-rename-2", async () => { await writeLibraryFile("New/n.md", "before\nagent two\n"); });
  await rm(notebookPath("New"), { recursive: true, force: true });
  assert.deepEqual(await listPendingReviews(), []);
  await writeLibraryFile("New/n.md", "before\nagent two\n");
  assert.deepEqual((await listPendingReviews()).map((review) => review.path), ["New/n.md"]);
}));

async function directoryIsCaseSensitive() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-case-"));
  try {
    await writeLibraryFileAt(path.join(directory, "Probe"));
    return !existsSync(path.join(directory, "probe"));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function writeLibraryFileAt(target: string) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(target);
}

test("a case-only notebook rename works and remaps its records", async (context) => {
  if (await directoryIsCaseSensitive()) { context.skip("the temporary directory is case-sensitive"); return; }
  await withTemporaryLibrary(["Case"], async () => {
    await writeLibraryFile("Case/n.md", "before\n");
    await withReviewWrite("Case/n.md", "before\n", "run-case-1", async () => { await writeLibraryFile("Case/n.md", "before\nagent\n"); });
    await renameNotebook("Case", "case");
    const tree = await getTree();
    assert.deepEqual(tree.notebooks.map((notebook: { name: string }) => notebook.name).filter((name: string) => name.toLowerCase() === "case"), ["case"]);
    assert.deepEqual((await listPendingReviews()).map((review) => review.path), ["case/n.md"]);
    assert.equal(await readFile(filePathFromParts("case", ["n.md"]), "utf8"), "before\nagent\n");
  });
});
