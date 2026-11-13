import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { listPendingReviews, pruneReviews, withReviewWrite } from "../../src/lib/agent/review-store";
import { listRunFiles, RunSnapshots, undoRun } from "../../src/lib/agent/snapshots";
import type { ReviewDocument } from "../../src/lib/markdown-review";
import { StorageError } from "../../src/lib/storage/errors";
import { archiveFile, archiveFolder, createFolder, moveFile, moveFileToDirectory, renameFolder } from "../../src/lib/storage/files";
import { addReviewThreads, findReview, loadReview } from "../../src/lib/storage/markdown-reviews";
import { writeMarkdownImageAsset } from "../../src/lib/storage/markdown-assets";
import { filePathFromParts, getStateRoot, pdfAnnotationsPath } from "../../src/lib/storage/paths";
import { inspectReviewDocuments } from "../../src/lib/storage/review-files";
import { readWorkspaceMetadata, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";
import { assertNotebookSound, splitLibraryPath, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

// Moves made in the app carry the records that point at a file's path: the
// agent's pending review, its undo history, and nothing left at the
// destination by a file deleted outside the app is taken over or destroyed.
// The notebook check is the oracle (as in notebook-operations-integrity.test.ts).

const sound = (notebook: string) => assertNotebookSound(notebook, { severities: ["error", "warning", "info"], allow: ["info indexes: "] });
const disk = (relative: string) => { const { notebook, parts } = splitLibraryPath(relative); return filePathFromParts(notebook, parts); };

/** An agent run that edited a note: its pending review and its undo history, written the way the agent's tools do. */
async function agentEdit(filePath: string, before: string, after: string, runId: string) {
  await writeLibraryFile(filePath, before);
  const snapshots = new RunSnapshots(runId);
  await snapshots.recordOriginal(filePath, before);
  await withReviewWrite(filePath, before, runId, async () => { await writeLibraryFile(filePath, after); });
  await snapshots.recordWritten(filePath, after);
}

/** The review and the undo history follow the file to `to`; Undo restores `original` there. */
async function assertFollowed(from: string, to: string, runId: string, original: string) {
  const pending = await listPendingReviews();
  assert.deepEqual(pending.map((review) => review.path), [to]);
  assert.equal(pending[0].baseline, original);
  const recorded = (await listRunFiles()).files.filter((file) => file.runId === runId);
  assert.deepEqual(recorded.map((file) => file.path), [to]);
  assert.equal(recorded[0].recordedPath, from);
  await sound(splitLibraryPath(to).notebook);
  const [result] = await undoRun(runId);
  assert.equal(result.status, "restored");
  assert.equal(await readFile(disk(to), "utf8"), original);
  assert.deepEqual(await listPendingReviews(), []);
}

test("pending agent reviews and undo history follow a file moved, renamed or archived in the app", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  await createFolder("Nb", "sub");

  await agentEdit("Nb/notes/a.md", "# A\n", "# A\n\nagent\n", "run-move-0001");
  await moveFileToDirectory("Nb/notes/a.md", "Nb/sub");
  await assertFollowed("Nb/notes/a.md", "Nb/sub/a.md", "run-move-0001", "# A\n");

  await agentEdit("Nb/notes/b.md", "# B\n", "# B\n\nagent\n", "run-rename-01");
  await moveFile("Nb/notes/b.md", "Nb", "renamed.md");
  await assertFollowed("Nb/notes/b.md", "Nb/notes/renamed.md", "run-rename-01", "# B\n");

  await agentEdit("Nb/notes/c.md", "# C\n", "# C\n\nagent\n", "run-archive-01");
  await archiveFile("Nb/notes/c.md");
  await assertFollowed("Nb/notes/c.md", "Nb/_archive/c.md", "run-archive-01", "# C\n");

  // A file the run created: Undo deletes it where it is now, not at the old path.
  await writeLibraryFile("Nb/notes/made.md", "");
  const snapshots = new RunSnapshots("run-created-01");
  await snapshots.recordOriginal("Nb/notes/made.md", null);
  await withReviewWrite("Nb/notes/made.md", null, "run-created-01", async () => { await writeLibraryFile("Nb/notes/made.md", "new\n"); });
  await snapshots.recordWritten("Nb/notes/made.md", "new\n");
  await moveFileToDirectory("Nb/notes/made.md", "Nb/sub");
  assert.deepEqual((await listPendingReviews()).map((review) => review.path), ["Nb/sub/made.md"]);
  assert.deepEqual(await undoRun("run-created-01"), [{ path: "Nb/notes/made.md", currentPath: "Nb/sub/made.md", status: "deleted" }]);
  // The route prunes the reviews of what Undo changed.
  await pruneReviews(["Nb/sub/made.md"]);
  await sound("Nb");
}));

test("a note moved to another notebook keeps its review and undo history, with its images as they are there", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  await writeLibraryFile("Nb/notes/x.md", "# X\n");
  const upload = await writeMarkdownImageAsset("Nb/notes/x.md", new File(["photo-bytes"], "photo.png"));
  const before = `# X\n\n${upload.markdown}\n`;
  await agentEdit("Nb/notes/x.md", before, `${before}\nagent\n`, "run-cross-0001");

  const moved = await moveFileToDirectory("Nb/notes/x.md", "Other");
  const sources = Object.entries((moved as { imageSources?: Record<string, string> }).imageSources ?? {});
  assert.ok(sources.length, "the move rewrote the note's image sources");
  const [pending] = await listPendingReviews();
  assert.equal(pending.path, "Other/x.md");
  for (const [from, to] of sources) {
    assert.ok(!pending.baseline.includes(from) && pending.baseline.includes(to), "the baseline names the images where they are now");
  }
  await sound("Nb");
  await sound("Other");
  // The run wrote the note as it was before the move: Undo still finds it as the run left it.
  const [result] = await undoRun("run-cross-0001");
  assert.equal(result.status, "restored");
  assert.equal(await readFile(disk("Other/x.md"), "utf8"), pending.baseline);
}));

test("pending reviews and undo history follow the files of a renamed or archived folder", () => withTemporaryLibrary(["Nb"], async () => {
  await agentEdit("Nb/proj/one.md", "one\n", "one\nagent\n", "run-folder-001");
  await agentEdit("Nb/proj/deep/two.md", "two\n", "two\nagent\n", "run-folder-002");

  await renameFolder("Nb/proj", "work");
  assert.deepEqual((await listPendingReviews()).map((review) => review.path), ["Nb/work/deep/two.md", "Nb/work/one.md"]);
  assert.deepEqual((await listRunFiles()).files.map((file) => file.path).sort(), ["Nb/work/deep/two.md", "Nb/work/one.md"]);
  await sound("Nb");

  await archiveFolder("Nb/work");
  assert.deepEqual((await listPendingReviews()).map((review) => review.path), ["Nb/_archive/work/deep/two.md", "Nb/_archive/work/one.md"]);
  assert.deepEqual((await listRunFiles()).files.map((file) => file.path).sort(), ["Nb/_archive/work/deep/two.md", "Nb/_archive/work/one.md"]);
  await sound("Nb");

  const results = await undoRun("run-folder-001");
  assert.equal(results[0].status, "restored");
  assert.equal(await readFile(disk("Nb/_archive/work/one.md"), "utf8"), "one\n");
}));

test("a move onto a path that still has the records of a file deleted outside the app is refused", () => withTemporaryLibrary(["Nb"], async () => {
  await createFolder("Nb", "reading");
  await writeLibraryFile("Nb/papers/a.pdf", "%PDF-1.4 a");
  await writeLibraryFile("Nb/papers/b.pdf", "%PDF-1.4 b");
  // Left by a starred, annotated reading/a.pdf that was deleted in Finder.
  const leftover = JSON.stringify({ annotations: [], comments: [] });
  await writeAt(pdfAnnotationsPath("Nb", ["reading", "a.pdf"]), leftover);
  await setStarredFilePath("Nb/reading/a.pdf", true);
  await writeAt(pdfAnnotationsPath("Nb", ["papers", "b.pdf"]), JSON.stringify({ own: true }));
  const starred = (await readWorkspaceMetadata()).starredFilePaths;

  const refused = (error: unknown) => error instanceof StorageError && error.status === 409 &&
    error.message.includes("Nb/reading/a.pdf still has the annotations and star of a file that was there before") && error.message.includes("Check the notebook");
  await assert.rejects(moveFileToDirectory("Nb/papers/a.pdf", "Nb/reading"), refused);
  // Renamed in place onto the same path.
  await writeLibraryFile("Nb/reading/b.pdf", "%PDF-1.4 b");
  await assert.rejects(moveFile("Nb/reading/b.pdf", "Nb", "a.pdf"), (error: unknown) => error instanceof StorageError && error.status === 409);

  // Nothing changed: files, the file's own side file, the leftovers.
  assert.equal(await readFile(disk("Nb/papers/a.pdf"), "utf8"), "%PDF-1.4 a");
  assert.equal(await readFile(disk("Nb/reading/b.pdf"), "utf8"), "%PDF-1.4 b");
  await assert.rejects(readFile(disk("Nb/reading/a.pdf")));
  assert.equal(await readFile(pdfAnnotationsPath("Nb", ["reading", "a.pdf"]), "utf8"), leftover);
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, starred);

  // A moving file's own annotations are not in the way of a path that has none.
  await moveFileToDirectory("Nb/papers/b.pdf", "Nb/reading", "c.pdf");
  await readFile(pdfAnnotationsPath("Nb", ["reading", "c.pdf"]), "utf8");
}));

test("an empty review at the destination gives way to the moving file's review", () => withTemporaryLibrary(["Nb"], async () => {
  await createFolder("Nb", "reading");
  await writeLibraryFile("Nb/notes/e.md", "hello world\n");
  await addReviewThreads("Nb/notes/e.md", "hello world\n", [{ range: { start: 0, end: 5 }, text: "a comment" }]);
  // What opening a note at the destination left behind.
  await loadReview("Nb/reading/e.md", "");

  await moveFileToDirectory("Nb/notes/e.md", "Nb/reading");
  assert.equal(await findReview("Nb/notes/e.md"), null);
  const reviews = await inspectReviewDocuments<ReviewDocument>(getStateRoot(), "Nb/reading/e.md");
  assert.equal(reviews?.length, 1);
  assert.equal(reviews?.[0].threads.length, 1);
  await sound("Nb");
}));
