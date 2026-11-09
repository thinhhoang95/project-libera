import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pythonSidecarDocumentPath, pythonSidecarPath } from "../../src/lib/python/sidecar";
import { addReviewThreads, findReview, loadReview, moveReviewPaths } from "../../src/lib/storage/markdown-reviews";
import { inspectReviewKeys } from "../../src/lib/storage/review-files";
import { inkFolderPath } from "../../src/lib/storage/ink";
import { audioPeaksPath, definitionsPath, filePathFromParts, getAdminRoot, getStateRoot, imageAnnotationsPath, pdfAnnotationsPath, pdfOutlinePath, transcriptPath } from "../../src/lib/storage/paths";
import { readReferenceLibrary } from "../../src/lib/storage/references";
import { applyNotebookRepair, planNotebookRepair } from "../../src/lib/storage/repair";
import { pruneAudioSidecars } from "../../src/lib/storage/transcripts";
import { readWorkspaceMetadata, setFileTagsForPath, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";
import { assertNotebookSound, seeded, seedNotebook, withTemporaryLibrary, writeAt, writeLibraryFile, writeReferenceLibrary } from "./notebook-test-helpers";

/** What Finder does: the file moves, nothing else. */
async function finderMove(from: string, to: string) {
  const [notebook, ...fromParts] = from.split("/");
  const target = filePathFromParts(notebook, to.split("/").slice(1));
  await mkdir(path.dirname(target), { recursive: true });
  await rename(filePathFromParts(notebook, fromParts), target);
}

const exists = (target: string) => stat(target).then(() => true, () => false);

/** Every file under the data directory, with its modification time. */
async function snapshot(root: string) {
  const entries: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      entries.push(`${path.relative(root, target)}@${(await stat(target)).mtimeMs}`);
      if (entry.isDirectory()) await walk(target);
    }
  };
  await walk(root);
  return entries.sort();
}

test("files moved in Finder get their records back by name, and the notebook is sound again", () => withTemporaryLibrary(["Nb"], async () => {
  await seedNotebook("Nb");
  await writeAt(path.join(getAdminRoot(), ...pythonSidecarPath("Nb/notes/n.md").split("/")), "print('hi')\n");
  await setStarredFilePath("Nb/papers/a.pdf", true);
  await setFileTagsForPath("Nb/audio/memo.m4a", ["meeting"]);
  await writeReferenceLibrary("Nb", [{ key: "a2026", attachments: ["Nb/papers/a.pdf"] }]);

  await finderMove("Nb/papers/a.pdf", "Nb/reading/a.pdf");
  await finderMove("Nb/papers/fig.png", "Nb/reading/figures/fig.png");
  await finderMove("Nb/audio/memo.m4a", "Nb/recordings/memo.m4a");
  await finderMove("Nb/notes/n.md", "Nb/journal/n.md");
  // The app's tree refresh (on returning to the window) prunes before anyone checks: transcripts stay.
  await pruneAudioSidecars("Nb");

  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, [
    { from: "Nb/audio/memo.m4a", to: "Nb/recordings/memo.m4a", records: ["tags", "transcript"] },
    { from: "Nb/notes/n.md", to: "Nb/journal/n.md", records: ["Python code", "definitions"] },
    { from: "Nb/papers/a.pdf", to: "Nb/reading/a.pdf", records: ["annotations", "definitions", "ink", "outline", "reference attachment", "star"] },
    { from: "Nb/papers/fig.png", to: "Nb/reading/figures/fig.png", records: ["annotations"] },
  ]);
  assert.deepEqual(plan.unmatched, []);

  const result = await applyNotebookRepair("Nb", plan.token);
  assert.deepEqual(result.problems, []);
  assert.equal(result.moved.length, 4);

  assert.equal(await readFile(transcriptPath("Nb", ["recordings", "memo.m4a"]), "utf8"), seeded("transcript"));
  assert.equal(await readFile(pdfOutlinePath("Nb", ["reading", "a.pdf"]), "utf8"), seeded("outline"));
  assert.equal(await readFile(definitionsPath("Nb", ["journal", "n.md"]), "utf8"), seeded("note-definitions"));
  assert.ok(await exists(pdfAnnotationsPath("Nb", ["reading", "a.pdf"])));
  assert.ok(await exists(path.join(inkFolderPath("Nb", ["reading", "a.pdf"]), "me.json")));
  assert.ok(await exists(imageAnnotationsPath("Nb", ["reading", "figures", "fig.png"])));
  assert.equal(await readFile(path.join(getAdminRoot(), ...pythonSidecarPath("Nb/journal/n.md").split("/")), "utf8").then((code) => code.includes("print('hi')")), true);
  assert.ok(!(await exists(transcriptPath("Nb", ["audio", "memo.m4a"]))));

  const metadata = await readWorkspaceMetadata();
  assert.deepEqual(metadata.starredFilePaths, ["Nb/reading/a.pdf"]);
  assert.deepEqual(metadata.fileTags, { "Nb/recordings/memo.m4a": ["meeting"] });
  const library = await readReferenceLibrary("Nb");
  assert.deepEqual(Object.values(library.entries).flatMap((entry) => entry.attachments.map((attachment) => attachment.kind === "url" ? attachment.url : attachment.path)), ["Nb/reading/a.pdf"]);

  // Links are not rewritten by moves; the note's own embeds are what the check may still report.
  // What is left is what the check reports after any move: the note shows the image by its old library address.
  await assertNotebookSound("Nb", { severities: ["error", "warning", "info"], allow: ["error images: Nb/journal/n.md: Shows Nb/papers/fig.png, which is missing."] });
  assert.deepEqual((await planNotebookRepair("Nb")).moves, [], "nothing is left to find");
}));

test("a name that could be several files is never guessed", () => withTemporaryLibrary(["Nb"], async () => {
  // Two missing files of the same name.
  await writeLibraryFile("Nb/a/readme.md", "a");
  await writeLibraryFile("Nb/b/readme.md", "b");
  await setStarredFilePath("Nb/a/readme.md", true);
  await setStarredFilePath("Nb/b/readme.md", true);
  await finderMove("Nb/a/readme.md", "Nb/c/readme.md");
  await finderMove("Nb/b/readme.md", "Nb/d/readme.md");
  // One missing file, two of its name.
  await writeLibraryFile("Nb/p/scan.png", "png");
  await setFileTagsForPath("Nb/p/scan.png", ["x"]);
  await finderMove("Nb/p/scan.png", "Nb/q/scan.png");
  await writeLibraryFile("Nb/r/scan.png", "other png");
  // The only file of its name already has records of the same kind.
  await writeLibraryFile("Nb/rec/talk.m4a", "audio");
  await writeAt(transcriptPath("Nb", ["rec", "talk.m4a"]), seeded("transcript"));
  await writeLibraryFile("Nb/other/talk.m4a", "another recording");
  await writeAt(transcriptPath("Nb", ["other", "talk.m4a"]), seeded("transcript"));
  await finderMove("Nb/rec/talk.m4a", "Nb/gone.m4a");
  // A file deleted for good.
  await writeLibraryFile("Nb/old/lost.pdf", "%PDF");
  await setStarredFilePath("Nb/old/lost.pdf", true);
  await finderMove("Nb/old/lost.pdf", "Nb/old/renamed.pdf");

  const root = getAdminRoot();
  const before = await snapshot(root);
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(await snapshot(root), before, "making the plan writes nothing");
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.unmatched.map((item) => [item.from, item.reason, item.candidates]), [
    ["Nb/a/readme.md", "shared-name", ["Nb/c/readme.md", "Nb/d/readme.md"]],
    ["Nb/b/readme.md", "shared-name", ["Nb/c/readme.md", "Nb/d/readme.md"]],
    ["Nb/old/lost.pdf", "none", []],
    ["Nb/p/scan.png", "several", ["Nb/q/scan.png", "Nb/r/scan.png"]],
    ["Nb/rec/talk.m4a", "own", ["Nb/other/talk.m4a"]],
  ]);
  const applied = await applyNotebookRepair("Nb", plan.token);
  assert.deepEqual(applied.moved, []);
  assert.deepEqual(await readFile(transcriptPath("Nb", ["other", "talk.m4a"]), "utf8"), seeded("transcript"), "a file's own records are never replaced");
}));

test("opening a moved note before the fix doesn't keep its comments from following it", () => withTemporaryLibrary(["Nb"], async () => {
  const text = "# Note\n\nSome text to comment on.\n";
  for (const name of ["opened", "commented"]) {
    await writeLibraryFile(`Nb/old/${name}.md`, text);
    await addReviewThreads(`Nb/old/${name}.md`, text, [{ range: { start: 8, end: 12 }, text: `about ${name}` }]);
    await setFileTagsForPath(`Nb/old/${name}.md`, ["digest"]);
    await finderMove(`Nb/old/${name}.md`, `Nb/new/${name}.md`);
  }
  // Opening a note makes an empty review at its new path.
  await loadReview("Nb/new/opened.md", text);
  // Commenting at the new path makes a review of its own.
  await addReviewThreads("Nb/new/commented.md", text, [{ range: { start: 8, end: 12 }, text: "new comment" }]);

  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, [{ from: "Nb/old/opened.md", to: "Nb/new/opened.md", records: ["review comments", "tags"] }]);
  assert.deepEqual(plan.unmatched.map((item) => [item.from, item.reason]), [["Nb/old/commented.md", "own"]]);

  const result = await applyNotebookRepair("Nb", plan.token);
  assert.deepEqual(result.problems, []);
  const keys = (await inspectReviewKeys(getStateRoot())).keys.sort();
  assert.deepEqual(keys, ["Nb/new/commented.md", "Nb/new/opened.md", "Nb/old/commented.md"], "the empty review gave way, one review per path");
  assert.deepEqual((await findReview("Nb/new/opened.md"))?.threads.map((thread) => thread.messages[0].text), ["about opened"]);
  assert.deepEqual((await findReview("Nb/new/commented.md"))?.threads.map((thread) => thread.messages[0].text), ["new comment"], "a review with comments is never replaced");
  assert.deepEqual((await readWorkspaceMetadata()).fileTags["Nb/new/opened.md"], ["digest"]);
}));

test("a review that gains comments after the plan stays where it was", () => withTemporaryLibrary(["Nb"], async () => {
  const text = "# Note\n\nSome text.\n";
  await writeLibraryFile("Nb/old/n.md", text);
  await addReviewThreads("Nb/old/n.md", text, [{ range: { start: 8, end: 12 }, text: "old" }]);
  await finderMove("Nb/old/n.md", "Nb/new/n.md");
  await loadReview("Nb/new/n.md", text);
  assert.equal((await planNotebookRepair("Nb")).moves.length, 1);
  // Between the plan and its transaction, someone comments at the new path.
  await addReviewThreads("Nb/new/n.md", text, [{ range: { start: 8, end: 12 }, text: "new" }]);
  assert.deepEqual(await moveReviewPaths(new Map([["Nb/old/n.md", "Nb/new/n.md"]]), { replaceEmpty: true }), ["Nb/old/n.md"]);
  assert.deepEqual((await findReview("Nb/old/n.md"))?.threads.map((thread) => thread.messages[0].text), ["old"]);
  assert.deepEqual((await findReview("Nb/new/n.md"))?.threads.map((thread) => thread.messages[0].text), ["new"]);
}));

test("a fix is applied only as it was shown",() => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a/x.pdf", "%PDF");
  await setStarredFilePath("Nb/a/x.pdf", true);
  await finderMove("Nb/a/x.pdf", "Nb/b/x.pdf");
  const plan = await planNotebookRepair("Nb");
  assert.equal(plan.moves.length, 1);
  // Another file of that name appears before the fix is confirmed.
  await writeLibraryFile("Nb/c/x.pdf", "%PDF other");
  await assert.rejects(applyNotebookRepair("Nb", plan.token), /changed since the fix was prepared/);
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Nb/a/x.pdf"]);
}));

test("tree upkeep keeps a missing recording's transcript and drops only its waveform", () => withTemporaryLibrary(["Nb"], async () => {
  await writeAt(transcriptPath("Nb", ["gone.m4a"]), seeded("transcript"));
  await writeAt(audioPeaksPath("Nb", ["gone.m4a"]), seeded("peaks"));
  await pruneAudioSidecars("Nb");
  assert.ok(await exists(transcriptPath("Nb", ["gone.m4a"])));
  assert.ok(!(await exists(audioPeaksPath("Nb", ["gone.m4a"]))));
}));

test("a Python sidecar path leads back to its note", () => {
  for (const note of ["Nb/n.md", "Nb/a b/c~d%20e.md", "Nb/x/y/z.markdown"]) assert.equal(pythonSidecarDocumentPath(pythonSidecarPath(note)), note);
  assert.equal(pythonSidecarDocumentPath("Nb/_assets/n.md/photo.png"), null);
  assert.equal(pythonSidecarDocumentPath("Nb/notes/n.py"), null);
});

test("one of several files of a name is never picked for having no records of its own", () => withTemporaryLibrary(["Nb"], async () => {
  // A starred file deleted outside the app; two files of its name elsewhere, one with annotations of its own.
  await writeLibraryFile("Nb/old/x.pdf", "%PDF old");
  await setStarredFilePath("Nb/old/x.pdf", true);
  await rm(filePathFromParts("Nb", ["old", "x.pdf"]));
  await writeLibraryFile("Nb/b/x.pdf", "%PDF b");
  await writeAt(pdfAnnotationsPath("Nb", ["b", "x.pdf"]), JSON.stringify({ version: 2, marks: [] }));
  await writeLibraryFile("Nb/c/x.pdf", "%PDF c");
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.unmatched.map((item) => [item.from, item.reason]), [["Nb/old/x.pdf", "several"]]);
}));
