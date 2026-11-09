import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rename, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFINITIONS_VERSION } from "../../src/lib/definitions";
import { pythonSidecarPath } from "../../src/lib/python/sidecar";
import { applyNotebookCleanup, planNotebookCleanup } from "../../src/lib/storage/cleanup";
import { addReviewThreads, deleteReviewKey, findReview } from "../../src/lib/storage/markdown-reviews";
import { inkFolderPath } from "../../src/lib/storage/ink";
import { definitionsDirectoryPath, definitionsPath, filePathFromParts, getAdminRoot, notebookPath, orphanedSidecarsDirectoryPath, pdfAnnotationsPath, transcriptPath } from "../../src/lib/storage/paths";
import { readReferenceLibrary } from "../../src/lib/storage/references";
import { readWorkspaceMetadata, setFileTagsForPath, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";
import { assertNotebookSound, seedNotebook, withTemporaryLibrary, writeAt, writeLibraryFile, writeReferenceLibrary } from "./notebook-test-helpers";

const exists = (target: string) => stat(target).then(() => true, () => false);
const gone = (relative: string) => { const [notebook, ...parts] = relative.split("/"); return rm(filePathFromParts(notebook, parts), { force: true }); };

test("Acknowledge removes what is stale, and checking again finds only what needs you", () => withTemporaryLibrary(["Nb"], async () => {
  await seedNotebook("Nb");
  // A note that is deleted for good, with Python code, review comments, a star and tags.
  const text = "# Gone\n\nSome text.\n";
  await writeLibraryFile("Nb/notes/gone.md", text);
  await writeAt(path.join(getAdminRoot(), ...pythonSidecarPath("Nb/notes/gone.md").split("/")), "print('hi')\n");
  await addReviewThreads("Nb/notes/gone.md", text, [{ range: { start: 8, end: 12 }, text: "a comment" }]);
  await setStarredFilePath("Nb/notes/gone.md", true);
  await setFileTagsForPath("Nb/notes/gone.md", ["draft"]);
  // A PDF and a recording deleted for good: their side files stay behind; the PDF was attached to a reference.
  await writeReferenceLibrary("Nb", [{ key: "a2026", attachments: ["Nb/papers/a.pdf"] }]);
  await gone("Nb/notes/gone.md");
  await gone("Nb/papers/a.pdf");
  await gone("Nb/audio/memo.m4a");
  // Definitions saved for another version of a note that is still there.
  await writeLibraryFile("Nb/notes/kept.md", "# Kept\n\nChanged since.\n");
  await writeAt(definitionsPath("Nb", ["notes", "kept.md"]), JSON.stringify({ version: DEFINITIONS_VERSION, documentPath: "Nb/notes/kept.md", source: { size: 1, contentHash: "old" }, entries: [] }));
  // Not stale: a broken link, which stays for you to set right.
  await writeLibraryFile("Nb/notes/links.md", "[elsewhere](missing.md)\n");
  // An image no note shows, in a folder of its own (_assets is not a user path).
  const unusedImage = path.join(notebookPath("Nb"), "_assets", "notes", "old.md", "chart.png");
  await writeAt(unusedImage, "png");

  const plan = await planNotebookCleanup("Nb");
  const paths = new Set(plan.items.map((item) => item.path));
  for (const expected of ["Nb/notes/gone.md", "Nb/papers/a.pdf", "Nb/audio/memo.m4a", "Nb/notes/kept.md", "Nb/_assets/notes/old.md/chart.png"]) assert.ok(paths.has(expected), `${expected} is listed`);
  assert.ok(plan.items.some((item) => item.lost && /annotations are deleted for good/.test(item.consequence)), "lost annotations are said to be lost");
  assert.ok(plan.items.some((item) => item.lost && /ink drawn on it/.test(item.consequence)));
  assert.ok(plan.items.some((item) => !item.lost && item.path === "Nb/notes/kept.md" && /can be made again/.test(item.consequence)));
  assert.equal(plan.remaining, 1, "the broken link is left");

  const result = await applyNotebookCleanup("Nb", plan.token);
  assert.deepEqual(result.problems, []);
  assert.equal(result.cleared, plan.items.length);

  await assertNotebookSound("Nb", { severities: ["error", "warning", "info"], allow: ["links: Nb/notes/links.md: The link \"missing.md\" finds no file."] });
  assert.ok(!(await exists(pdfAnnotationsPath("Nb", ["papers", "a.pdf"]))));
  assert.ok(!(await exists(inkFolderPath("Nb", ["papers", "a.pdf"]))));
  assert.ok(!(await exists(transcriptPath("Nb", ["audio", "memo.m4a"]))));
  assert.ok(!(await exists(definitionsPath("Nb", ["notes", "kept.md"]))));
  assert.ok(await exists(definitionsPath("Nb", ["notes", "n.md"])), "side files of files that are there and current are kept");
  assert.equal(await findReview("Nb/notes/gone.md"), null);
  const metadata = await readWorkspaceMetadata();
  assert.deepEqual([metadata.starredFilePaths, metadata.fileTags], [[], {}]);
  const library = await readReferenceLibrary("Nb");
  assert.deepEqual(Object.values(library.entries).flatMap((entry) => entry.attachments), []);
  const python = path.join(getAdminRoot(), ...pythonSidecarPath("Nb/notes/gone.md").split("/"));
  assert.ok(!(await exists(python)));
  assert.ok(!(await exists(path.dirname(python))), "the code's emptied folder goes too");
  assert.ok((await readdir(path.join(getAdminRoot(), "Nb", "_assets"))).length > 0, "a note's images stay");
  assert.ok(!(await exists(unusedImage)) && !(await exists(path.dirname(unusedImage))), "the unused image and its emptied folder are gone");
  assert.deepEqual((await planNotebookCleanup("Nb")).items, [], "nothing stale is left");
}));

test("an image a note's missing embed names is kept for it, not offered to Acknowledge", () => withTemporaryLibrary(["Nb"], async () => {
  // The note moved in Finder; its embed now points where the image is not.
  await writeLibraryFile("Nb/n.md", "# N\n\n![figure](_assets/n.md/Figure.png)\n");
  const left = path.join(notebookPath("Nb"), "_assets", "notes", "n.md", "figure.png");
  await writeAt(left, "png");
  const plan = await planNotebookCleanup("Nb");
  assert.deepEqual(plan.items, []);
  await applyNotebookCleanup("Nb", plan.token);
  assert.ok(await exists(left));
  const report = await assertNotebookSound("Nb", { severities: ["error", "info"], allow: ["images: Nb/n.md", "probably this one, left behind when the note moved"] });
  assert.ok(report.findings.every((finding) => !finding.clear?.length));
}));

test("Python code named like a note without code is kept for it, not offered to Acknowledge", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/analysis.md", "# Analysis\n");
  // Its code's folder was renamed in Finder.
  const left = path.join(notebookPath("Nb"), "_assets", "analysis.md-old", "analysis.py");
  await writeAt(left, "print('kept')\n");
  const plan = await planNotebookCleanup("Nb");
  assert.deepEqual(plan.items, []);
  assert.ok(await exists(left));
  await assertNotebookSound("Nb", { allow: ["named like Nb/analysis.md: probably its code"] });
}));

test("Acknowledge waits for Try to fix, so records that can follow their file are not deleted", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a/x.pdf", "%PDF");
  await setStarredFilePath("Nb/a/x.pdf", true);
  await rename(filePathFromParts("Nb", ["a", "x.pdf"]), filePathFromParts("Nb", ["x.pdf"]));
  await assert.rejects(planNotebookCleanup("Nb"), /Use Try to fix first/);
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Nb/a/x.pdf"]);
}));

test("Acknowledge removes only what was shown", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a.md", "a");
  await setStarredFilePath("Nb/a.md", true);
  await gone("Nb/a.md");
  const plan = await planNotebookCleanup("Nb");
  assert.equal(plan.items.length, 1);
  // Something else goes stale before the cleanup is confirmed.
  await writeLibraryFile("Nb/b.md", "b");
  await setFileTagsForPath("Nb/b.md", ["x"]);
  await gone("Nb/b.md");
  await assert.rejects(applyNotebookCleanup("Nb", plan.token), /changed since this was prepared/);
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Nb/a.md"]);
}));

test("ink set aside for a file that is back goes to it, and is never offered to Acknowledge", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a.pdf", "%PDF back");
  // Set aside without the file's bytes recorded: the file back under its old path is its own (ink.ts reconcileInkFolders).
  const kept = path.join(orphanedSidecarsDirectoryPath("Nb", "ink"), "1-abcd");
  await writeAt(path.join(kept, "record.json"), JSON.stringify({ originalPath: "Nb/a.pdf", orphanedAt: new Date().toISOString(), source: null }));
  await writeAt(path.join(kept, "ink", "me.json"), "{}");
  const plan = await planNotebookCleanup("Nb");
  assert.deepEqual(plan.items, []);
  assert.ok(await exists(path.join(kept, "ink", "me.json")));
}));

test("a missing attachment to another notebook's file is detached from that reference only", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  await writeLibraryFile("Other/kept.pdf", "%PDF");
  await writeReferenceLibrary("Nb", [{ key: "a2026", attachments: ["Other/lost.pdf", "Other/kept.pdf"] }]);
  const plan = await planNotebookCleanup("Nb");
  assert.deepEqual(plan.items.map((item) => item.path), ["Other/lost.pdf"]);
  const result = await applyNotebookCleanup("Nb", plan.token);
  assert.deepEqual(result.problems, []);
  const library = await readReferenceLibrary("Nb");
  assert.deepEqual(Object.values(library.entries).flatMap((entry) => entry.attachments.map((attachment) => attachment.kind === "url" ? attachment.url : attachment.path)), ["Other/kept.pdf"]);
}));

test("deleting a missing file's review keeps the reviews of a folder of the same name", () => withTemporaryLibrary(["Nb"], async () => {
  await addReviewThreads("Nb/old.md", "# Old\n", [{ range: { start: 2, end: 5 }, text: "old" }]);
  await addReviewThreads("Nb/old.md/child.md", "# Child\n", [{ range: { start: 2, end: 7 }, text: "child" }]);
  await deleteReviewKey("Nb/old.md");
  assert.equal(await findReview("Nb/old.md"), null);
  assert.ok(await findReview("Nb/old.md/child.md"));
}));

test("a side file reached through a link out of the notebook is never deleted", { skip: process.platform !== "win32" && process.platform !== "linux" && process.platform !== "darwin" }, () => withTemporaryLibrary(["Nb"], async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "libera-outside-"));
  try {
    await writeAt(path.join(outside, "gone.md.json"), JSON.stringify({ version: DEFINITIONS_VERSION, documentPath: "x", entries: [] }));
    const byPath = definitionsDirectoryPath("Nb", []);
    await mkdir(path.dirname(byPath), { recursive: true });
    await symlink(outside, byPath, "junction");
    const plan = await planNotebookCleanup("Nb");
    assert.ok(plan.items.some((item) => item.path === "Nb/gone.md"), "the linked side file is listed by the check");
    const result = await applyNotebookCleanup("Nb", plan.token);
    assert.match(result.problems.join("\n"), /outside the notebook once links are followed/);
    assert.ok(await exists(path.join(outside, "gone.md.json")), "the file outside is kept");
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
}));
