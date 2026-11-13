import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { listPendingReviews, withReviewWrite } from "../../src/lib/agent/review-store";
import { listRunFiles, RunSnapshots } from "../../src/lib/agent/snapshots";
import { pythonSidecarPath } from "../../src/lib/python/sidecar";
import { readTetherTarget, settleBibTether, tetherBibFile } from "../../src/lib/references/bib-tether";
import {
  archiveFile,
  archiveFolder,
  copyFileToDirectory,
  createFolder,
  deleteFile,
  deleteFolder,
  moveFile,
  moveFileToDirectory,
  renameFolder,
} from "../../src/lib/storage/files";
import { addReviewThreads, findReview } from "../../src/lib/storage/markdown-reviews";
import { filePathFromParts, getAdminRoot } from "../../src/lib/storage/paths";
import { setFileTagsForPath, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";
import { assertNotebookSound, seedNotebook, splitLibraryPath, withTemporaryLibrary, writeAt, writeLibraryFile, writeReferenceLibrary } from "./notebook-test-helpers";

// The notebook check (storage/integrity.ts) as the oracle for the app's
// everyday file operations: after each one, on a notebook with every kind of
// record the check knows (side files, a star, tags, a reference attachment,
// review comments, a pending agent review with undo history, a note's Python
// code, a tethered .bib and a chart reading a CSV), nothing may be left
// pointing nowhere, broken, unreadable or unused, not even as a note.

const strict = { severities: ["error", "warning", "info"] as const };
// Except the link and citation indexes' lag: the app brings them up to date
// on its next tree load after an operation, which this sweep never does (the
// tree's upkeep would repair what the operations should have done themselves).
const sound = (notebook: string, allow: string[] = []) => assertNotebookSound(notebook, { severities: [...strict.severities], allow: ["info indexes: ", ...allow] });

const pythonCode = (note: string) => path.join(getAdminRoot(), ...pythonSidecarPath(note).split("/"));
const exists = (target: string) => stat(target).then(() => true, () => false);
const disk = (relative: string) => { const { notebook, parts } = splitLibraryPath(relative); return filePathFromParts(notebook, parts); };
const CHART = "```chart\ntype: bar\ndata: data.csv\n```\n";
const PYTHON = "print('hi')\n";
// The chart reads data.csv beside its note: a note moved away from its CSV, alone, reports it.
const CHART_LEFT_BEHIND = 'reads its data from "data.csv", which is missing.';

// Deleting a file keeps its agent runs' undo history (Undo can bring the file back): info, never stale.
const UNDO_KEPT = "An agent run can't be undone for this file, which is missing.";

/** An agent run that edited a note: its pending review and its undo history, written the way the agent's tools do. */
async function agentEdit(filePath: string, before: string, after: string, runId: string) {
  await writeLibraryFile(filePath, before);
  const snapshots = new RunSnapshots(runId);
  await snapshots.recordOriginal(filePath, before);
  await withReviewWrite(filePath, before, runId, async () => { await writeLibraryFile(filePath, after); });
  await snapshots.recordWritten(filePath, after);
}

/** What the sweep adds to `seedNotebook`: the records that live outside the notebook's own folders, or in notes. */
async function seedRecords(notebook: string) {
  // The seeded note gets a chart, review comments and Python code.
  await writeLibraryFile(`${notebook}/notes/data.csv`, "x,y\n1,2\n3,4\n");
  const note = `${notebook}/notes/n.md`;
  const content = `${await readFile(disk(note), "utf8")}\n${CHART}`;
  await writeLibraryFile(note, content);
  await addReviewThreads(note, content, [{ range: { start: 0, end: 6 }, text: "a comment" }]);
  await writeAt(pythonCode(note), PYTHON);

  // Pending agent reviews and undo history: one note, and two inside a folder.
  await agentEdit(`${notebook}/notes/agent.md`, "# Agent\n", "# Agent\n\nedited\n", "run-sweep-0001");
  await agentEdit(`${notebook}/proj/one.md`, "one\n", "one\nagent\n", "run-sweep-0002");
  await agentEdit(`${notebook}/proj/deep/two.md`, "two\n", "two\nagent\n", "run-sweep-0003");

  // A .bib in the notebook that the reference library is tethered to.
  await writeLibraryFile(`${notebook}/refs/refs.bib`, "@article{smith2020, title={smith2020}}\n");
  await tetherBibFile(notebook, `${notebook}/refs/refs.bib`, { prefer: "library" });
  await settleBibTether(notebook);
}

const pending = async () => (await listPendingReviews()).map((review) => review.path).sort();
const runs = async () => (await listRunFiles()).files.map((file) => file.path).sort();
const comments = async (key: string) => (await findReview(key))?.threads.length ?? 0;
/** The tether follows a move through the references event bus, which is not awaited by the move: wait for it to settle. */
async function tether(notebook: string, expected?: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const target = await readTetherTarget(notebook);
    if (expected === undefined || (target && "libraryPath" in target && target.libraryPath === expected)) return target;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return readTetherTarget(notebook);
}

test("every file operation leaves its notebooks sound, and carries every record that follows its file", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  await seedNotebook("Nb");
  await setStarredFilePath("Nb/papers/a.pdf", true);
  await setFileTagsForPath("Nb/notes/n.md", ["draft"]);
  await writeReferenceLibrary("Nb", [{ key: "smith2020", attachments: ["Nb/papers/a.pdf"] }]);
  await seedRecords("Nb");
  await sound("Nb");
  assert.deepEqual(await pending(), ["Nb/notes/agent.md", "Nb/proj/deep/two.md", "Nb/proj/one.md"]);
  assert.deepEqual(await runs(), ["Nb/notes/agent.md", "Nb/proj/deep/two.md", "Nb/proj/one.md"]);
  assert.deepEqual(await tether("Nb", "Nb/refs/refs.bib"), { libraryPath: "Nb/refs/refs.bib" });

  // Within the notebook.
  await moveFile("Nb/papers/a.pdf", "Nb", "b.pdf");
  await sound("Nb");
  await createFolder("Nb", "reading");
  await moveFileToDirectory("Nb/papers/b.pdf", "Nb/reading");
  await sound("Nb");
  await renameFolder("Nb/audio", "recordings");
  await sound("Nb");
  await copyFileToDirectory("Nb/notes/n.md", "Nb/notes", "copy.md");
  await sound("Nb");

  // Renamed: the comments and the Python code are at the new name.
  await moveFile("Nb/notes/n.md", "Nb", "renamed.md");
  await sound("Nb");
  assert.equal(await comments("Nb/notes/renamed.md"), 1);
  assert.equal(await findReview("Nb/notes/n.md"), null);
  assert.ok((await readFile(pythonCode("Nb/notes/renamed.md"), "utf8")).startsWith(PYTHON));
  assert.ok(!(await exists(pythonCode("Nb/notes/n.md"))));

  // A note with a pending agent review, moved to another folder and renamed.
  await moveFileToDirectory("Nb/notes/agent.md", "Nb/reading");
  assert.deepEqual(await pending(), ["Nb/proj/deep/two.md", "Nb/proj/one.md", "Nb/reading/agent.md"]);
  assert.deepEqual(await runs(), ["Nb/proj/deep/two.md", "Nb/proj/one.md", "Nb/reading/agent.md"]);
  await sound("Nb");
  await moveFile("Nb/reading/agent.md", "Nb", "agent-renamed.md");
  assert.deepEqual(await pending(), ["Nb/proj/deep/two.md", "Nb/proj/one.md", "Nb/reading/agent-renamed.md"]);
  assert.deepEqual(await runs(), ["Nb/proj/deep/two.md", "Nb/proj/one.md", "Nb/reading/agent-renamed.md"]);
  await sound("Nb");

  // A folder renamed: the reviews and history of the notes inside follow.
  await renameFolder("Nb/proj", "work");
  assert.deepEqual(await pending(), ["Nb/reading/agent-renamed.md", "Nb/work/deep/two.md", "Nb/work/one.md"]);
  assert.deepEqual(await runs(), ["Nb/reading/agent-renamed.md", "Nb/work/deep/two.md", "Nb/work/one.md"]);
  await sound("Nb");

  // The tethered .bib: its folder renamed, then the file moved.
  await renameFolder("Nb/refs", "bibs");
  assert.deepEqual(await tether("Nb", "Nb/bibs/refs.bib"), { libraryPath: "Nb/bibs/refs.bib" });
  await sound("Nb");
  await moveFileToDirectory("Nb/bibs/refs.bib", "Nb/reading");
  assert.deepEqual(await tether("Nb", "Nb/reading/refs.bib"), { libraryPath: "Nb/reading/refs.bib" });
  await sound("Nb");

  // Archiving.
  await archiveFile("Nb/reading/b.pdf");
  await sound("Nb");
  await archiveFolder("Nb/recordings");
  await sound("Nb");
  await archiveFile("Nb/reading/agent-renamed.md");
  assert.deepEqual(await pending(), ["Nb/_archive/agent-renamed.md", "Nb/work/deep/two.md", "Nb/work/one.md"]);
  assert.deepEqual(await runs(), ["Nb/_archive/agent-renamed.md", "Nb/work/deep/two.md", "Nb/work/one.md"]);
  await sound("Nb");
  await archiveFolder("Nb/work");
  assert.deepEqual(await pending(), ["Nb/_archive/agent-renamed.md", "Nb/_archive/work/deep/two.md", "Nb/_archive/work/one.md"]);
  assert.deepEqual(await runs(), ["Nb/_archive/agent-renamed.md", "Nb/_archive/work/deep/two.md", "Nb/_archive/work/one.md"]);
  await sound("Nb");
  await archiveFile("Nb/reading/refs.bib");
  assert.deepEqual(await tether("Nb", "Nb/_archive/refs.bib"), { libraryPath: "Nb/_archive/refs.bib" });
  await sound("Nb");

  // To another notebook: the comments and the Python code go with the note; its chart's CSV stays behind.
  await moveFileToDirectory("Nb/notes/renamed.md", "Other");
  assert.equal(await comments("Other/renamed.md"), 1);
  assert.equal(await findReview("Nb/notes/renamed.md"), null);
  assert.ok((await readFile(pythonCode("Other/renamed.md"), "utf8")).startsWith(PYTHON));
  assert.ok(!(await exists(pythonCode("Nb/notes/renamed.md"))));
  await sound("Nb");
  const moved = await sound("Other", [CHART_LEFT_BEHIND]);
  assert.equal(moved.findings.filter((finding) => finding.message.includes(CHART_LEFT_BEHIND)).length, 1, "the only finding is the chart whose CSV stayed in the other notebook");
  await copyFileToDirectory("Nb/notes/copy.md", "Other", "copied.md");
  await sound("Nb");
  await sound("Other", [CHART_LEFT_BEHIND]);

  // Deleting: a file's records go with it.
  await deleteFile("Nb/_archive/b.pdf");
  await sound("Nb");
  await deleteFolder("Nb/_archive/recordings");
  await sound("Nb");
  await deleteFile("Nb/_archive/agent-renamed.md");
  assert.deepEqual(await pending(), ["Nb/_archive/work/deep/two.md", "Nb/_archive/work/one.md"]);
  // The undo history stays (an agent run can still be reverted; the check lists it as info).
  assert.deepEqual(await runs(), ["Nb/_archive/agent-renamed.md", "Nb/_archive/work/deep/two.md", "Nb/_archive/work/one.md"]);
  await sound("Nb", [UNDO_KEPT]);
  await deleteFolder("Nb/_archive/work");
  assert.deepEqual(await pending(), []);
  assert.deepEqual(await runs(), ["Nb/_archive/agent-renamed.md", "Nb/_archive/work/deep/two.md", "Nb/_archive/work/one.md"]);
  await sound("Nb", [UNDO_KEPT]);
  await deleteFolder("Nb/notes");
  assert.equal(await findReview("Nb/notes/copy.md"), null);
  assert.ok(!(await exists(pythonCode("Nb/notes/copy.md"))));
  assert.ok(await exists(pythonCode("Other/renamed.md")), "the Python code of the note that moved away stays with it");
  await sound("Nb", [UNDO_KEPT]);
  await sound("Other", [CHART_LEFT_BEHIND]);
  // The tether stayed with its file all the way.
  assert.deepEqual(await tether("Nb", "Nb/_archive/refs.bib"), { libraryPath: "Nb/_archive/refs.bib" });
}));
