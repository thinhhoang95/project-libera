import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { listPendingReviews, listReviewEntryPaths, withMovedReview, withMovedReviewsUnder, withReviewWrite } from "../../src/lib/agent/review-store";
import { StorageError } from "../../src/lib/storage/errors";
import { archiveFile, archiveFolder, createFolder, deleteFile, deleteFolder } from "../../src/lib/storage/files";
import { addReviewThreads, findReview, loadReview, moveReviewPaths } from "../../src/lib/storage/markdown-reviews";
import { planMigration } from "../../src/lib/storage/migration";
import { filePathFromParts, getStateRoot } from "../../src/lib/storage/paths";
import { readWorkspaceMetadata, renameFileMetadataPath, setFileTagsForPath, setNotebookPanelExpandedPaths, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";
import { splitLibraryPath, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

// The stores that hold what points at a file's path (stars and tags, review
// comments, the agent's pending reviews), one test per way they could lose or
// misplace a record.

const disk = (relative: string) => { const { notebook, parts } = splitLibraryPath(relative); return filePathFromParts(notebook, parts); };

/** An agent edit that left a pending review, written the way the agent's tools do. */
async function agentEdit(filePath: string, before: string, after: string, runId: string) {
  await writeLibraryFile(filePath, before);
  await withReviewWrite(filePath, before, runId, async () => { await writeLibraryFile(filePath, after); });
}

/** Fails instead of hanging when an operation searches for a name for ever. */
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("did not finish: it is still looking for a free name")), 10_000); })]);
  } finally { clearTimeout(timer); }
}

test("writers of the workspace settings do not erase each other (finding 6)", () => withTemporaryLibrary(["Nb"], async () => {
  await setStarredFilePath("Nb/a.md", true);
  await setFileTagsForPath("Nb/a.md", ["tag"]);
  // A move's rekey, a star, the panel's folders and a tag all start from the same snapshot of the file.
  await Promise.all([
    renameFileMetadataPath("Nb/a.md", "Nb/b.md"),
    setStarredFilePath("Nb/c.md", true),
    setNotebookPanelExpandedPaths(["Nb/open"]),
    setFileTagsForPath("Nb/d.md", ["other"]),
  ]);
  const metadata = await readWorkspaceMetadata();
  assert.deepEqual([...metadata.starredFilePaths].sort(), ["Nb/b.md", "Nb/c.md"]);
  assert.deepEqual(metadata.fileTags, { "Nb/b.md": ["tag"], "Nb/d.md": ["other"] });
  assert.deepEqual(metadata.notebookPanelExpandedPaths, ["Nb/open"]);
}));

test("an unreadable review index stops name allocation with an error instead of looping (finding 12)", () => withTemporaryLibrary(["Nb", "Dst"], async () => {
  await writeLibraryFile("Nb/a.md", "# A\n");
  await writeLibraryFile("Nb/folder/b.md", "# B\n");
  await writeLibraryFile("Nb/m.md", "# M\n");
  await writeAt(path.join(getStateRoot(), ".libera", "reviews", "index.json"), "{ not json");

  const refused = (error: unknown) => error instanceof StorageError && error.status === 409 && error.message.includes("review comments index can't be read");
  await assert.rejects(bounded(archiveFile("Nb/a.md")), refused);
  await assert.rejects(bounded(archiveFolder("Nb/folder")), refused);
  const plan = await bounded(planMigration({ source: "Nb", paths: ["Nb/m.md"], destination: { notebook: "Dst" } }));
  assert.ok(plan.blockers.some((blocker) => blocker.includes("review comments index can't be read")), plan.blockers.join("; "));
}));

test("deleting a note or folder settles its pending agent review, so a new note at the name starts clean (finding 17)", () => withTemporaryLibrary(["Nb"], async () => {
  await agentEdit("Nb/n.md", "old\n", "old\nagent\n", "run-delete-01");
  await agentEdit("Nb/proj/one.md", "one\n", "one\nagent\n", "run-delete-02");
  assert.deepEqual((await listReviewEntryPaths()).paths, ["Nb/n.md", "Nb/proj/one.md"]);

  await deleteFile("Nb/n.md");
  await deleteFolder("Nb/proj");
  assert.deepEqual((await listReviewEntryPaths()).paths, []);

  await writeLibraryFile("Nb/n.md", "something else entirely\n");
  await writeLibraryFile("Nb/proj/one.md", "also new\n");
  assert.deepEqual(await listPendingReviews(), []);
}));

test("a review created at the destination is never written over by a move, under the locks (finding 18)", () => withTemporaryLibrary(["Nb"], async () => {
  await agentEdit("Nb/src.md", "src\n", "src\nagent\n", "run-owner-0001");

  // The destination's review appears after the caller looked, while its lock is held: the move waits for it, then sees it.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const creating = withReviewWrite("Nb/dest.md", "dest\n", "run-owner-0002", async () => { await gate; await writeLibraryFile("Nb/dest.md", "dest\nagent\n"); });
  await writeLibraryFile("Nb/dest.md", "dest\n");
  let moved = false;
  const moving = withMovedReview("Nb/src.md", "Nb/dest.md", (text) => text, async () => { moved = true; });
  release();
  await creating;
  await assert.rejects(moving, (error: unknown) => error instanceof StorageError && error.status === 409);
  assert.equal(moved, false, "the document is not moved when its review can't follow");
  const pending = await listPendingReviews();
  assert.deepEqual(pending.map((review) => [review.path, review.baseline]).sort(), [["Nb/dest.md", "dest\n"], ["Nb/src.md", "src\n"]]);
}));

test("a folder move checks every destination review before writing any (finding 18)", () => withTemporaryLibrary(["Nb"], async () => {
  await agentEdit("Nb/proj/one.md", "one\n", "one\nagent\n", "run-folder-001");
  await agentEdit("Nb/proj/two.md", "two\n", "two\nagent\n", "run-folder-002");
  await agentEdit("Nb/other/two.md", "mine\n", "mine\nagent\n", "run-folder-003");
  let moved = false;
  await assert.rejects(withMovedReviewsUnder("Nb/proj", "Nb/other", async () => { moved = true; }), (error: unknown) => error instanceof StorageError && error.status === 409);
  assert.equal(moved, false);
  assert.deepEqual((await listReviewEntryPaths()).paths, ["Nb/other/two.md", "Nb/proj/one.md", "Nb/proj/two.md"]);
}));

test("an empty review at the destination is replaced only by a real source review (finding 20)", () => withTemporaryLibrary(["Nb"], async () => {
  const empty = await loadReview("Nb/dest.md", "");
  // A star-only pair: the source has no review.
  assert.deepEqual(await moveReviewPaths(new Map([["Nb/src.md", "Nb/dest.md"]]), { replaceEmpty: true }), []);
  assert.equal((await findReview("Nb/dest.md"))?.id, empty.id);

  const source = await addReviewThreads("Nb/src.md", "text", [{ range: { start: 0, end: 4 }, text: "note" }]);
  assert.deepEqual(await moveReviewPaths(new Map([["Nb/src.md", "Nb/dest.md"]]), { replaceEmpty: true }), []);
  assert.equal((await findReview("Nb/dest.md"))?.id, source.id, "the source's review took the empty one's place");
}));

test("listing pending reviews keeps the baseline of a note moved outside the app (finding 76)", () => withTemporaryLibrary(["Nb"], async () => {
  await createFolder("Nb", "moved");
  await agentEdit("Nb/n.md", "base\n", "base\nagent\n", "run-listing-01");
  await rm(disk("Nb/n.md"));
  await writeLibraryFile("Nb/moved/n.md", "base\nagent\n");

  assert.deepEqual(await listPendingReviews(), []);
  assert.deepEqual((await listReviewEntryPaths()).paths, ["Nb/n.md"], "the baseline waits for Try to fix");
  await listPendingReviews();
  assert.deepEqual((await listReviewEntryPaths()).paths, ["Nb/n.md"]);

  // The file coming back brings the review back.
  await writeLibraryFile("Nb/n.md", "base\nagent\n");
  assert.deepEqual((await listPendingReviews()).map((review) => review.path), ["Nb/n.md"]);
}));
