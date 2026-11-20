import assert from "node:assert/strict";
import fsp, { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test, { mock } from "node:test";
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
import { definitionsPath, filePathFromParts, getAdminRoot, imageAnnotationsPath, pdfAnnotationsPath } from "../../src/lib/storage/paths";
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

// Folder operations (findings 13 to 16): a folder that can't be scanned or moved cleanly changes nothing, or says what it could not put back.

const sidecarKinds = (notebook: string, folder: string) => ({
  pdf: pdfAnnotationsPath(notebook, [folder, "a.pdf"]),
  image: imageAnnotationsPath(notebook, [folder, "p.png"]),
  definitions: definitionsPath(notebook, [folder, "d.md"]),
});

test("a folder rollback puts back only the records that moved, never ones that arrived at the destination (13)", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/old/n.md", "# N\n");
  const old = sidecarKinds("Nb", "old");
  const arrived = sidecarKinds("Nb", "new");
  await writeAt(old.pdf, "{}");
  await writeAt(old.definitions, "{}");
  // After the checks, a record of another kind and one of a later kind arrive at the destination: the first is not
  // in the way of anything, the second makes the definitions step fail.
  const original = fsp.rename;
  mock.method(fsp, "rename", async (from: string, to: string) => {
    await original(from, to);
    if (String(from).endsWith(`${path.sep}old`) && String(to).endsWith(`${path.sep}new`)) {
      await writeAt(arrived.image, "{\"theirs\":true}");
      await writeAt(arrived.definitions, "{\"theirs\":true}");
    }
  });
  try { await assert.rejects(() => renameFolder("Nb/old", "new")); } finally { mock.restoreAll(); }
  assert.ok(await exists(disk("Nb/old/n.md")), "the folder is back");
  assert.ok(await exists(old.pdf) && await exists(old.definitions), "the records that were moved are back");
  assert.ok(await exists(arrived.image), "the record that arrived stays at the destination");
  assert.ok(!(await exists(sidecarKinds("Nb", "old").image)), "and was not taken to the source");
  assert.equal(await readFile(arrived.definitions, "utf8"), "{\"theirs\":true}");
}));

test("a folder rollback that cannot finish says what is stuck (13)", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/old/n.md", "# N\n");
  await writeAt(pythonCode("Nb/old/n.md"), PYTHON);
  const original = fsp.rename;
  mock.method(fsp, "rename", async (from: string, to: string) => {
    if (String(from).endsWith(`${path.sep}new`) && String(to).endsWith(`${path.sep}old`)) throw Object.assign(new Error("EPERM: cannot rename back"), { code: "EPERM" });
    await original(from, to);
    // Code for the note's new path arrives after the checks, so moving the note's code is refused.
    if (String(from).endsWith(`${path.sep}old`) && String(to).endsWith(`${path.sep}new`)) await writeAt(pythonCode("Nb/new/n.md"), "theirs\n");
  });
  try {
    await assert.rejects(() => renameFolder("Nb/old", "new"), (error) => (error as { status?: number }).status === 500 && /already has Python code/.test((error as Error).message) && /EPERM/.test((error as Error).message));
  } finally { mock.restoreAll(); }
  assert.equal(await readFile(pythonCode("Nb/old/n.md"), "utf8"), PYTHON, "the code stayed with its note");
  assert.equal(await readFile(pythonCode("Nb/new/n.md"), "utf8"), "theirs\n");
}));

test("a folder moved onto a name that still has Python code for its notes is refused, with and without code of its own (14)", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/Drafts/a.md", "# A\n");
  await writeLibraryFile("Nb/Plain/a.md", "# A\n");
  await writeAt(pythonCode("Nb/Drafts/a.md"), PYTHON);
  await writeAt(pythonCode("Nb/Project/a.md"), "stale\n");
  await writeAt(pythonCode("Nb/Other/a.md"), "stale 2\n");
  const refused = (error: unknown) => (error as { status?: number }).status === 409 && /Python code/.test((error as Error).message);
  await assert.rejects(() => renameFolder("Nb/Drafts", "Project"), refused);
  await assert.rejects(() => renameFolder("Nb/Plain", "Other"), refused);
  assert.ok(await exists(disk("Nb/Drafts/a.md")) && await exists(disk("Nb/Plain/a.md")), "nothing moved");
  assert.equal(await readFile(pythonCode("Nb/Drafts/a.md"), "utf8"), PYTHON);
  assert.equal(await readFile(pythonCode("Nb/Project/a.md"), "utf8"), "stale\n");
  assert.equal(await readFile(pythonCode("Nb/Other/a.md"), "utf8"), "stale 2\n");
  // The archive takes another name instead, and the stale code stays where it was.
  await writeAt(pythonCode("Nb/_archive/Drafts/a.md"), "stale 3\n");
  const archived = await archiveFolder("Nb/Drafts");
  assert.equal(archived.moved.to, "Nb/_archive/Drafts-1");
  assert.equal(await readFile(pythonCode("Nb/_archive/Drafts/a.md"), "utf8"), "stale 3\n");
  assert.ok((await readFile(pythonCode("Nb/_archive/Drafts-1/a.md"), "utf8")).startsWith(PYTHON), "the code moved with the note");
}));

/** Makes listing the folder `name` fail, as an unreadable child folder does. */
function failListing(name: string) {
  const original = fsp.readdir;
  mock.method(fsp, "readdir", (target: string, ...rest: unknown[]) => String(target).endsWith(`${path.sep}${name}`)
    ? Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }))
    : (original as (...args: unknown[]) => Promise<unknown>)(target, ...rest));
}

test("a folder with a child that can't be listed is not renamed or archived, so no code is stranded (15)", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/Drafts/sub/b.md", "# B\n");
  await writeAt(pythonCode("Nb/Drafts/sub/b.md"), PYTHON);
  failListing("sub");
  try {
    await assert.rejects(() => renameFolder("Nb/Drafts", "Final"), (error) => (error as { status?: number }).status === 409);
    await assert.rejects(() => archiveFolder("Nb/Drafts"), (error) => (error as { status?: number }).status === 409);
  } finally { mock.restoreAll(); }
  assert.ok(await exists(disk("Nb/Drafts/sub/b.md")), "the folder is where it was");
  assert.ok(await exists(pythonCode("Nb/Drafts/sub/b.md")));
  assert.ok(!(await exists(disk("Nb/Final"))) && !(await exists(disk("Nb/_archive/Drafts"))));
}));

test("deleting a folder whose notes can't all be read deletes nothing, and a full read cleans up its code and images (16)", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/Gone/a.md", "# A\n");
  await writeLibraryFile("Nb/Gone/sub/b.md", "# B\n");
  await writeAt(pythonCode("Nb/Gone/sub/b.md"), PYTHON);
  const original = fsp.readFile;
  mock.method(fsp, "readFile", (target: unknown, ...rest: unknown[]) => String(target).endsWith(`${path.sep}b.md`)
    ? Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }))
    : (original as (...args: unknown[]) => Promise<unknown>)(target, ...rest));
  try { await assert.rejects(() => deleteFolder("Nb/Gone"), (error) => (error as { status?: number }).status === 409); } finally { mock.restoreAll(); }
  assert.ok(await exists(disk("Nb/Gone/sub/b.md")), "the folder is still there");
  assert.ok(await exists(pythonCode("Nb/Gone/sub/b.md")), "with its code");
  await deleteFolder("Nb/Gone");
  assert.ok(!(await exists(disk("Nb/Gone"))));
  assert.ok(!(await exists(pythonCode("Nb/Gone/sub/b.md"))), "its code went with it");
}));
