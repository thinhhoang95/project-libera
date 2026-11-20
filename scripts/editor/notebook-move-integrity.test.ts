import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import fsp, { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { DELETE as deleteFileRoute, PATCH as patchFile } from "../../src/app/api/files/route";
import { listPendingReviews, pruneReviews, withReviewWrite } from "../../src/lib/agent/review-store";
import { listRunFiles, RunSnapshots, undoRun } from "../../src/lib/agent/snapshots";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import type { ReviewDocument } from "../../src/lib/markdown-review";
import { pythonSidecarPath } from "../../src/lib/python/sidecar";
import { StorageError } from "../../src/lib/storage/errors";
import { localFileIdentity } from "../../src/lib/storage/file-identity";
import { archiveFile, archiveFolder, assertLocalFileIdentity, createFolder, moveFile, moveFileToDirectory, MoveCommittedError, readLiberaFile, renameFolder, textVersion, updateMarkdownFile } from "../../src/lib/storage/files";
import { inkFolderPath } from "../../src/lib/storage/ink";
import { addReviewThreads, findReview, loadReview } from "../../src/lib/storage/markdown-reviews";
import { writeMarkdownImageAsset } from "../../src/lib/storage/markdown-assets";
import { filePathFromParts, getAdminRoot, getStateRoot, pdfAnnotationsPath, transcriptPath, workspaceMetadataPath } from "../../src/lib/storage/paths";
import { inspectReviewDocuments } from "../../src/lib/storage/review-files";
import { readWorkspaceMetadata, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";
import { assertNotebookSound, SEEDED_INK, seeded, splitLibraryPath, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

// Moves made in the app carry the records that point at a file's path: the
// agent's pending review, its undo history, and nothing left at the
// destination by a file deleted outside the app is taken over or destroyed.
// The notebook check is the oracle (as in notebook-operations-integrity.test.ts).

const sound = (notebook: string) => assertNotebookSound(notebook, { severities: ["error", "warning", "info"], allow: ["info indexes: "] });
const disk = (relative: string) => { const { notebook, parts } = splitLibraryPath(relative); return filePathFromParts(notebook, parts); };
const exists = (target: string) => stat(target).then(() => true, () => false);
const pythonCode = (note: string) => path.join(getAdminRoot(), ...pythonSidecarPath(note).split("/"));

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

// ---- Direct moves under races (package A1) ----

const resolved = (target: unknown) => path.resolve(String(target));

/**
 * Runs `action` right after the first existence check of `target` answers, as
 * another window or a sync client acting between the move's check and its
 * publish would.
 */
function afterFirstCheck(t: TestContext, target: string, action: () => void | Promise<void>) {
  const original = fsp.access;
  let done = false;
  t.mock.method(fsp, "access", async (...args: Parameters<typeof fsp.access>) => {
    try { return await original(...args); }
    finally {
      if (!done && resolved(args[0]) === resolved(target)) { done = true; await action(); }
    }
  });
}

const is409 = (error: unknown) => error instanceof StorageError && error.status === 409;

test("a file that arrives at the destination after the check is kept by a move, a rename and an archive", async (t) => {
  const operations: [string, () => Promise<unknown>, string][] = [
    ["move", () => moveFileToDirectory("Nb/a.md", "Nb/sub"), "Nb/sub/a.md"],
    ["rename", () => moveFile("Nb/a.md", "Nb", "b.md"), "Nb/b.md"],
    ["archive", () => archiveFile("Nb/a.md"), "Nb/_archive/a.md"],
  ];
  for (const [label, run, destination] of operations) {
    await withTemporaryLibrary(["Nb"], async () => {
      await createFolder("Nb", "sub");
      await writeLibraryFile("Nb/a.md", "source");
      afterFirstCheck(t, disk(destination), () => writeFileSync(disk(destination), "arrival"));
      await assert.rejects(run(), is409, label);
      assert.equal(await readFile(disk("Nb/a.md"), "utf8"), "source", `${label}: the source stays`);
      assert.equal(await readFile(disk(destination), "utf8"), "arrival", `${label}: the arrival is kept`);
    });
    t.mock.restoreAll();
  }
});

test("a side file that arrives at the destination after the check is kept, and the note goes back", async (t) => {
  const pdf = ["papers", "a.pdf"];
  // Built inside each library: the paths name its data folder.
  const cases = (): { label: string; file: string; seed: () => Promise<void>; arrive: () => void; arrivedAt: string; sourceKept: string }[] => [
    {
      label: "annotations", file: "Nb/papers/a.pdf",
      seed: async () => { await writeAt(pdfAnnotationsPath("Nb", pdf), JSON.stringify({ annotations: [], comments: [], seed: "m1" })); },
      arrivedAt: pdfAnnotationsPath("Nb", ["sub", "a.pdf"]),
      arrive: () => { mkdirSync(path.dirname(pdfAnnotationsPath("Nb", ["sub", "a.pdf"])), { recursive: true }); writeFileSync(pdfAnnotationsPath("Nb", ["sub", "a.pdf"]), "{\"arrival\":true}"); },
      sourceKept: pdfAnnotationsPath("Nb", pdf),
    },
    {
      label: "ink", file: "Nb/papers/a.pdf",
      seed: async () => { await writeAt(path.join(inkFolderPath("Nb", pdf), SEEDED_INK), seeded("pdf-ink")); },
      arrivedAt: path.join(inkFolderPath("Nb", ["sub", "a.pdf"]), SEEDED_INK),
      arrive: () => { mkdirSync(inkFolderPath("Nb", ["sub", "a.pdf"]), { recursive: true }); writeFileSync(path.join(inkFolderPath("Nb", ["sub", "a.pdf"]), SEEDED_INK), "arrival"); },
      sourceKept: path.join(inkFolderPath("Nb", pdf), SEEDED_INK),
    },
    {
      label: "Python code", file: "Nb/notes/n.md",
      seed: async () => { await writeAt(pythonCode("Nb/notes/n.md"), "print('mine')\n"); },
      arrivedAt: pythonCode("Nb/sub/n.md"),
      arrive: () => { mkdirSync(path.dirname(pythonCode("Nb/sub/n.md")), { recursive: true }); writeFileSync(pythonCode("Nb/sub/n.md"), "print('arrival')\n"); },
      sourceKept: pythonCode("Nb/notes/n.md"),
    },
  ];
  for (let index = 0; index < cases().length; index += 1) {
    await withTemporaryLibrary(["Nb"], async () => {
      const item = cases()[index];
      await createFolder("Nb", "sub");
      await writeLibraryFile(item.file, item.file.endsWith(".pdf") ? "%PDF-1.4 a" : "# N\n");
      await item.seed();
      // The side file's slot is looked at once (the leftover check); the arrival comes right after it.
      const watched = item.label === "ink" ? inkFolderPath("Nb", ["sub", "a.pdf"]) : item.arrivedAt;
      afterFirstCheck(t, watched, item.arrive);
      await assert.rejects(moveFileToDirectory(item.file, "Nb/sub"), is409, item.label);
      assert.equal(await exists(disk(item.file)), true, `${item.label}: the file is back where it was`);
      assert.equal(await exists(disk(`Nb/sub/${item.file.split("/").at(-1)}`)), false, `${item.label}: nothing is left at the destination`);
      assert.equal(await exists(item.sourceKept), true, `${item.label}: its own record stays with it`);
      assert.match(await readFile(item.arrivedAt, "utf8"), /arrival/, `${item.label}: the arrival is not replaced`);
    });
    t.mock.restoreAll();
  }
});

test("a move, an archive or a delete bound to the chosen file refuses a file that took its path", () => withTemporaryLibrary(["Nb"], async () => {
  await createFolder("Nb", "sub");
  await writeLibraryFile("Nb/A/paper.pdf", "%PDF-1.4 chosen");
  const chosen = localFileIdentity((await readLiberaFile("Nb/A/paper.pdf")).file);
  // Moved away in Explorer, and a sync client puts another file at the path.
  await rm(disk("Nb/A/paper.pdf"));
  await writeLibraryFile("Nb/A/paper.pdf", "%PDF-1.4 a different file that took the path");

  const refused = (error: unknown) => is409(error) && /changed since it was read/.test((error as Error).message);
  await assert.rejects(moveFileToDirectory("Nb/A/paper.pdf", "Nb/sub", undefined, { expectedFileId: chosen }), refused);
  await assert.rejects(moveFile("Nb/A/paper.pdf", "Nb", "renamed.pdf", { expectedFileId: chosen }), refused);
  await assert.rejects(archiveFile("Nb/A/paper.pdf", { expectedFileId: chosen }), refused);
  await assert.rejects(assertLocalFileIdentity("Nb/A/paper.pdf", chosen), refused);
  assert.equal(await readFile(disk("Nb/A/paper.pdf"), "utf8"), "%PDF-1.4 a different file that took the path");
  assert.equal(await exists(disk("Nb/sub/paper.pdf")) || await exists(disk("Nb/_archive/paper.pdf")) || await exists(disk("Nb/A/renamed.pdf")), false);

  // The file the person sees now is the one that moves.
  const now = localFileIdentity((await readLiberaFile("Nb/A/paper.pdf")).file);
  await assertLocalFileIdentity("Nb/A/paper.pdf", now);
  await moveFileToDirectory("Nb/A/paper.pdf", "Nb/sub", undefined, { expectedFileId: now });
  assert.equal(await exists(disk("Nb/sub/paper.pdf")), true);
  await sound("Nb");
}));

test("a source replaced during the move is refused right before the file moves", (t) => withTemporaryLibrary(["Nb"], async () => {
  await createFolder("Nb", "sub");
  await writeLibraryFile("Nb/papers/a.pdf", "%PDF-1.4 chosen");
  // The first look at the destination's side files is after the move began.
  afterFirstCheck(t, pdfAnnotationsPath("Nb", ["sub", "a.pdf"]), async () => {
    await rm(disk("Nb/papers/a.pdf"));
    await writeLibraryFile("Nb/papers/a.pdf", "%PDF-1.4 a replacement that is longer");
  });
  await assert.rejects(moveFileToDirectory("Nb/papers/a.pdf", "Nb/sub"), is409);
  assert.equal(await readFile(disk("Nb/papers/a.pdf"), "utf8"), "%PDF-1.4 a replacement that is longer");
  assert.equal(await exists(disk("Nb/sub/a.pdf")), false);
}));

test("a late bookkeeping failure after the file moved still returns the move and what did not follow", (t) => withTemporaryLibrary(["Nb"], async () => {
  await createFolder("Nb", "sub");
  await writeLibraryFile("Nb/a.md", "# A\n");
  await setStarredFilePath("Nb/a.md", true);
  const original = fsp.rename;
  t.mock.method(fsp, "rename", async (...args: Parameters<typeof fsp.rename>) => {
    if (resolved(args[1]) === resolved(workspaceMetadataPath())) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return original(...args);
  });
  const result = await moveFileToDirectory("Nb/a.md", "Nb/sub");
  assert.equal(result.file.path, "Nb/sub/a.md");
  assert.deepEqual(result.moved, { from: "Nb/a.md", to: "Nb/sub/a.md" });
  assert.deepEqual(result.unfinished?.map((step) => [step.step, step.status]), [["metadata", "failed"]]);
  assert.match(result.unfinished?.[0].message ?? "", /disk full/);
  assert.equal(await exists(disk("Nb/a.md")), false);
  // The star stayed at the old path: Try to fix pairs it by name.
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Nb/a.md"]);
}));

test("a move whose result cannot be read afterwards still says where the file is", (t) => withTemporaryLibrary(["Nb"], async () => {
  await createFolder("Nb", "sub");
  await writeLibraryFile("Nb/a.md", "# A\n");
  const original = fsp.stat;
  t.mock.method(fsp, "stat", async (...args: Parameters<typeof fsp.stat>) => {
    if (resolved(args[0]) === resolved(disk("Nb/sub/a.md"))) throw Object.assign(new Error("provider unavailable"), { code: "EIO" });
    return original(...args);
  });
  await assert.rejects(moveFileToDirectory("Nb/a.md", "Nb/sub"), (error: unknown) =>
    error instanceof MoveCommittedError && error.moved.to === "Nb/sub/a.md" && error.moved.from === "Nb/a.md" && /was moved to Nb\/sub\/a\.md/.test(error.message));
  assert.equal(await readFile(disk("Nb/sub/a.md"), "utf8"), "# A\n");
}));

test("a review that gained comments at the destination during the move is reported as held", (t) => withTemporaryLibrary(["Nb"], async () => {
  await createFolder("Nb", "reading");
  await writeLibraryFile("Nb/notes/e.md", "hello world\n");
  await addReviewThreads("Nb/notes/e.md", "hello world\n", [{ range: { start: 0, end: 5 }, text: "a comment" }]);
  // The second look at the source is the one right before the file moves; the destination gets its comments then.
  const original = fsp.stat;
  let looks = 0;
  t.mock.method(fsp, "stat", async (...args: Parameters<typeof fsp.stat>) => {
    const result = await original(...args);
    if (resolved(args[0]) === resolved(disk("Nb/notes/e.md")) && ++looks === 2) {
      await addReviewThreads("Nb/reading/e.md", "hello world\n", [{ range: { start: 0, end: 5 }, text: "written meanwhile" }]);
    }
    return result;
  });
  const result = await moveFileToDirectory("Nb/notes/e.md", "Nb/reading");
  assert.deepEqual(result.unfinished?.map((step) => [step.step, step.status]), [["reviews", "held"]]);
  assert.deepEqual(result.moved, { from: "Nb/notes/e.md", to: "Nb/reading/e.md" });
  assert.notEqual(await findReview("Nb/notes/e.md"), null, "the held review stays at the old path");
  assert.equal((await findReview("Nb/reading/e.md"))?.threads.length, 1, "the destination keeps its own comments");
}));

test("archiving a recording whose transcript cannot follow leaves the recording where it was", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/audio/memo.m4a", Buffer.from("audio"));
  await writeAt(transcriptPath("Nb", ["audio", "memo.m4a"]), seeded("transcript"));
  // A regular file where the archive's transcript folder would be.
  await writeAt(path.dirname(transcriptPath("Nb", ["_archive", "memo.m4a"])), "in the way");
  await assert.rejects(archiveFile("Nb/audio/memo.m4a"), is409);
  assert.equal(await exists(disk("Nb/audio/memo.m4a")), true);
  assert.equal(await exists(disk("Nb/_archive/memo.m4a")), false);
  assert.equal(await exists(transcriptPath("Nb", ["audio", "memo.m4a"])), true);
  await sound("Nb");
}));

/** Holds the staged temporary file of a save until `release` is called. */
function pauseSave(t: TestContext) {
  const original = fsp.writeFile;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const paused = new Promise<void>((resolve) => { reached = resolve; });
  let held = false;
  t.mock.method(fsp, "writeFile", async (...args: Parameters<typeof fsp.writeFile>) => {
    const result = await original(...args);
    if (!held && String(args[0]).includes(".libera-tmp-")) { held = true; reached(); await gate; }
    return result;
  });
  return { paused, release };
}

test("a save paused before publishing cannot recreate the old path after a move of the same file", (t) => withTemporaryLibrary(["Nb"], async () => {
  await createFolder("Nb", "sub");
  await writeLibraryFile("Nb/a.md", "first");
  const pause = pauseSave(t);
  const save = updateMarkdownFile("Nb/a.md", "saved text", textVersion("first"));
  await pause.paused;
  const move = moveFileToDirectory("Nb/a.md", "Nb/sub");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await exists(disk("Nb/sub/a.md")), false, "the move waits for the save");
  pause.release();
  await save;
  await move;
  assert.equal(await exists(disk("Nb/a.md")), false, "the save did not bring the old name back");
  assert.equal(await readFile(disk("Nb/sub/a.md"), "utf8"), "saved text");
  await sound("Nb");
  // A save from a tab that did not hear of the move is refused, not applied at the old path.
  await assert.rejects(updateMarkdownFile("Nb/a.md", "late", textVersion("saved text")), is409);
  assert.equal(await exists(disk("Nb/a.md")), false);
}));

test("a save paused before publishing does not overwrite a file put at the name meanwhile", (t) => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a.md", "first");
  const pause = pauseSave(t);
  const save = updateMarkdownFile("Nb/a.md", "saved text", textVersion("first"));
  await pause.paused;
  await writeFile(disk("Nb/a.md"), "from a sync client");
  pause.release();
  await assert.rejects(save, is409);
  assert.equal(await readFile(disk("Nb/a.md"), "utf8"), "from a sync client");
}));

test("PATCH /api/files refuses a direct move to another notebook, and a delete bound to a replaced file", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  await writeLibraryFile("Nb/a.md", "# A\n");
  const headers = { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}`, "content-type": "application/json" };
  const patch = (body: object) => patchFile(new NextRequest("http://localhost/api/files", { method: "PATCH", headers, body: JSON.stringify(body) }));

  assert.equal((await patch({ path: "Nb/a.md", destinationDirectory: "Other" })).status, 409);
  assert.equal((await patch({ path: "Nb/a.md", destinationNotebook: "Other", destinationName: "a.md" })).status, 409);
  assert.equal(await exists(disk("Other/a.md")), false);
  assert.equal(await exists(disk("Nb/a.md")), true);
  // Inside the notebook both shapes still work.
  assert.equal((await patch({ path: "Nb/a.md", destinationNotebook: "Nb", destinationName: "b.md" })).status, 200);
  assert.equal((await patch({ path: "Nb/b.md", destinationDirectory: "Nb", destinationName: "c.md" })).status, 200);
  await sound("Nb");
  await sound("Other");

  const chosen = localFileIdentity((await readLiberaFile("Nb/c.md")).file);
  await rm(disk("Nb/c.md"));
  await writeLibraryFile("Nb/c.md", "# a different, longer file\n");
  const stale = await deleteFileRoute(new NextRequest(`http://localhost/api/files?path=${encodeURIComponent("Nb/c.md")}&fileId=${encodeURIComponent(chosen)}`, { method: "DELETE", headers }));
  assert.equal(stale.status, 409);
  assert.equal(await exists(disk("Nb/c.md")), true);
}));
