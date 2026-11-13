import assert from "node:assert/strict";
import fsp, { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import test, { mock } from "node:test";
import { emptyInkAuthorFile } from "../../src/lib/ink/codec";
import { reconcilePdfSidecars } from "../../src/lib/storage/pdf-sidecars";
import { pythonSidecarDocumentPath, pythonSidecarPath } from "../../src/lib/python/sidecar";
import { addReviewThreads, findReview, loadReview, moveReviewPaths } from "../../src/lib/storage/markdown-reviews";
import { inspectReviewKeys } from "../../src/lib/storage/review-files";
import { inkFolderPath, reconcileInkFolders } from "../../src/lib/storage/ink";
import { audioPeaksPath, definitionsPath, filePathFromParts, getAdminRoot, getStateRoot, imageAnnotationsPath, notebookPath, orphanedSidecarsDirectoryPath, pdfAnnotationsPath, pdfOutlinePath, transcriptPath } from "../../src/lib/storage/paths";
import { readReferenceLibrary } from "../../src/lib/storage/references";
import { applyNotebookCleanup, planNotebookCleanup } from "../../src/lib/storage/cleanup";
import { applyNotebookRepair, planNotebookRepair } from "../../src/lib/storage/repair";
import { pruneAudioSidecars } from "../../src/lib/storage/transcripts";
import { readWorkspaceMetadata, setFileTagsForPath, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";
import { assertNotebookSound, SEEDED_INK, seeded, seedNotebook, withTemporaryLibrary, writeAt, writeLibraryFile, writeReferenceLibrary } from "./notebook-test-helpers";

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
  assert.ok(await exists(path.join(inkFolderPath("Nb", ["reading", "a.pdf"]), SEEDED_INK)));
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

const inkFile = (key = "aaaaaaaaaa") => JSON.stringify(emptyInkAuthorFile({ key }, { unit: "pt", width: 100, height: 100 }));
const annotations = JSON.stringify({ version: 2, marks: [{ id: "m1" }] });

/** The tree's upkeep after a Finder move: a first load sees the side files orphaned, one 31 s later sets them aside. */
async function upkeep(notebook: string) {
  const now = Date.now();
  for (const at of [now, now + 31_000]) {
    await reconcileInkFolders(notebook, [], { now: at });
    await reconcilePdfSidecars(notebook, [], { now: at });
  }
}

test("ink and side files the tree's upkeep set aside follow their file, and are put back without replacing anything", () => withTemporaryLibrary(["Nb"], async () => {
  // A starred note with ink, and a PDF with annotations and an outline, moved in Finder.
  await writeLibraryFile("Nb/a/x.md", "# X\n");
  await setStarredFilePath("Nb/a/x.md", true);
  await writeAt(path.join(inkFolderPath("Nb", ["a", "x.md"]), "text.aaaaaaaaaa.ink"), inkFile());
  await writeLibraryFile("Nb/a/p.pdf", "%PDF");
  await writeAt(pdfAnnotationsPath("Nb", ["a", "p.pdf"]), annotations);
  await writeAt(pdfOutlinePath("Nb", ["a", "p.pdf"]), seeded("outline"));
  await finderMove("Nb/a/x.md", "Nb/b/x.md");
  await finderMove("Nb/a/p.pdf", "Nb/b/p.pdf");
  await upkeep("Nb");
  assert.ok(!(await exists(inkFolderPath("Nb", ["a", "x.md"]))), "the ink was set aside");
  assert.ok(!(await exists(pdfAnnotationsPath("Nb", ["a", "p.pdf"]))), "the annotations were set aside");

  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, [
    { from: "Nb/a/p.pdf", to: "Nb/b/p.pdf", records: ["annotations", "outline"] },
    { from: "Nb/a/x.md", to: "Nb/b/x.md", records: ["ink", "star"] },
  ]);
  const result = await applyNotebookRepair("Nb", plan.token);
  assert.deepEqual(result.problems, []);
  assert.equal(result.moved.length, 2);
  assert.ok(await exists(path.join(inkFolderPath("Nb", ["b", "x.md"]), "text.aaaaaaaaaa.ink")));
  assert.equal(JSON.parse(await readFile(pdfAnnotationsPath("Nb", ["b", "p.pdf"]), "utf8")).marks[0].id, "m1");
  assert.deepEqual(JSON.parse(await readFile(pdfOutlinePath("Nb", ["b", "p.pdf"]), "utf8")), JSON.parse(seeded("outline")));
  assert.deepEqual(await readdir(orphanedSidecarsDirectoryPath("Nb", "ink")), [], "the record directory went with it");
  assert.deepEqual(await readdir(orphanedSidecarsDirectoryPath("Nb", "annotations")), []);
  assert.deepEqual((await planNotebookRepair("Nb")).moves, []);
}));

test("a set-aside side file never replaces what the file found has: the pair is its own", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a/x.md", "# X\n");
  await writeAt(path.join(inkFolderPath("Nb", ["a", "x.md"]), "text.aaaaaaaaaa.ink"), inkFile());
  await writeLibraryFile("Nb/a/p.pdf", "%PDF");
  await writeAt(pdfAnnotationsPath("Nb", ["a", "p.pdf"]), annotations);
  await finderMove("Nb/a/x.md", "Nb/b/x.md");
  await finderMove("Nb/a/p.pdf", "Nb/b/p.pdf");
  await upkeep("Nb");
  // Each has ink or annotations of its own by the time the check is made.
  await writeAt(path.join(inkFolderPath("Nb", ["b", "x.md"]), "text.bbbbbbbbbb.ink"), inkFile("bbbbbbbbbb"));
  await writeAt(pdfAnnotationsPath("Nb", ["b", "p.pdf"]), JSON.stringify({ version: 2, marks: [{ id: "own" }] }));
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.unmatched.map((item) => [item.from, item.reason]), [["Nb/a/p.pdf", "own"], ["Nb/a/x.md", "own"]]);
  assert.equal((await readdir(orphanedSidecarsDirectoryPath("Nb", "ink"))).length, 1, "kept for Acknowledge or a later match");
}));

test("a file moved into the archive is found there, and counts toward several", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a/x.md", "# X\n");
  await setStarredFilePath("Nb/a/x.md", true);
  await mkdir(path.join(notebookPath("Nb"), "_archive"), { recursive: true });
  await rename(filePathFromParts("Nb", ["a", "x.md"]), path.join(notebookPath("Nb"), "_archive", "x.md"));
  const alone = await planNotebookRepair("Nb");
  assert.deepEqual(alone.moves, [{ from: "Nb/a/x.md", to: "Nb/_archive/x.md", records: ["star"] }]);
  // Another file of the name in view: the archived one is not guessed.
  await writeLibraryFile("Nb/c/x.md", "# Other\n");
  const crowded = await planNotebookRepair("Nb");
  assert.deepEqual(crowded.moves, []);
  assert.deepEqual(crowded.unmatched.map((item) => [item.reason, item.candidates]), [["several", ["Nb/_archive/x.md", "Nb/c/x.md"]]]);
}));

test("a folder that can't be listed stops the plan; one that raced away does not", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a/x.md", "# X\n");
  await setStarredFilePath("Nb/a/x.md", true);
  await finderMove("Nb/a/x.md", "Nb/b/x.md");
  await mkdir(path.join(notebookPath("Nb"), "locked"));
  const original = fsp.readdir;
  const failing = (code: string) => mock.method(fsp, "readdir", ((target: string, ...rest: unknown[]) => String(target).endsWith(`${path.sep}locked`)
    ? Promise.reject(Object.assign(new Error(code), { code }))
    : (original as (...args: unknown[]) => unknown)(target, ...rest)) as typeof fsp.readdir);
  try {
    failing("EACCES");
    await assert.rejects(planNotebookRepair("Nb"), /1 folder of Nb could not be read \(Nb\/locked\)/);
    mock.restoreAll();
    failing("ENOENT");
    assert.equal((await planNotebookRepair("Nb")).moves.length, 1);
  } finally {
    mock.restoreAll();
  }
}));

test("names are matched under Unicode form and case", () => withTemporaryLibrary(["Nb"], async () => {
  const nfc = "Bài giảng.pdf";
  const nfd = nfc.normalize("NFD");
  assert.notEqual(nfc, nfd);
  // A sync client gives the name back decomposed.
  await writeLibraryFile(`Nb/a/${nfc}`, "%PDF");
  await setStarredFilePath(`Nb/a/${nfc}`, true);
  await rm(filePathFromParts("Nb", ["a", nfc]));
  await writeLibraryFile(`Nb/b/${nfd}`, "%PDF");
  // A rename that only changes case, in place.
  await writeLibraryFile("Nb/p/Paper.pdf", "%PDF");
  await setFileTagsForPath("Nb/p/Paper.pdf", ["x"]);
  await rename(filePathFromParts("Nb", ["p", "Paper.pdf"]), filePathFromParts("Nb", ["p", "paper.tmp"]));
  await rename(filePathFromParts("Nb", ["p", "paper.tmp"]), filePathFromParts("Nb", ["p", "paper.pdf"]));
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, [
    { from: `Nb/a/${nfc}`, to: `Nb/b/${nfd}`, records: ["star"] },
    { from: "Nb/p/Paper.pdf", to: "Nb/p/paper.pdf", records: ["tags"] },
  ]);
  assert.deepEqual((await applyNotebookRepair("Nb", plan.token)).problems, []);
  assert.deepEqual((await readWorkspaceMetadata()).fileTags, { "Nb/p/paper.pdf": ["x"] });
}));

test("files that fold to one name are several", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a/x.png", "png");
  await setFileTagsForPath("Nb/a/x.png", ["t"]);
  await rm(filePathFromParts("Nb", ["a", "x.png"]));
  await writeLibraryFile("Nb/b/X.png", "one");
  await writeLibraryFile("Nb/c/x.png", "two");
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.unmatched.map((item) => [item.reason, item.candidates]), [["several", ["Nb/b/X.png", "Nb/c/x.png"]]]);
}));

test("a side file whose destination is taken is said, and a pair that moved nothing is not reported moved", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/b/x.pdf", "%PDF");
  await writeAt(pdfAnnotationsPath("Nb", ["a", "x.pdf"]), annotations);
  const plan = await planNotebookRepair("Nb");
  assert.equal(plan.moves.length, 1);
  // Someone saves annotations at the destination after the plan: the copy refuses to replace them.
  const copy = fsp.copyFile;
  mock.method(fsp, "copyFile", (async (source: string, destination: string, ...rest: [number?]) => {
    await writeAt(destination, "saved meanwhile");
    return (copy as (...args: unknown[]) => Promise<void>)(source, destination, ...rest);
  }) as typeof fsp.copyFile);
  try {
    const result = await applyNotebookRepair("Nb", plan.token);
    assert.deepEqual(result.moved, []);
    assert.match(result.problems.join("\n"), /annotations of Nb\/a\/x\.pdf stayed/);
  } finally {
    mock.restoreAll();
  }
  assert.equal(await readFile(pdfAnnotationsPath("Nb", ["b", "x.pdf"]), "utf8"), "saved meanwhile");
  assert.ok(await exists(pdfAnnotationsPath("Nb", ["a", "x.pdf"])), "the old one stays");
  const again = await planNotebookRepair("Nb");
  assert.deepEqual(again.moves, [], "the next plan does not move it again");
  assert.deepEqual(again.unmatched.map((item) => item.reason), ["own"]);
}));

test("a pair with a reserved segment does not stop the others, and a failed side file leaves a plan that converges", () => withTemporaryLibrary(["Nb"], async () => {
  // A star at a path no file can have (_assets is reserved), whose name a file has.
  await writeLibraryFile("Nb/b/r.md", "# R\n");
  await setStarredFilePath("Nb/_assets/r.md", true);
  // A PDF with annotations and an outline, whose outline can't be copied once.
  await writeLibraryFile("Nb/b/x.pdf", "%PDF");
  await writeAt(pdfAnnotationsPath("Nb", ["a", "x.pdf"]), annotations);
  await writeAt(pdfOutlinePath("Nb", ["a", "x.pdf"]), seeded("outline"));
  const plan = await planNotebookRepair("Nb");
  assert.equal(plan.moves.length, 2);
  const copy = fsp.copyFile;
  mock.method(fsp, "copyFile", (async (source: string, ...rest: unknown[]) => {
    if (source === pdfOutlinePath("Nb", ["a", "x.pdf"])) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return (copy as (...args: unknown[]) => Promise<void>)(source, ...rest);
  }) as typeof fsp.copyFile);
  try {
    const result = await applyNotebookRepair("Nb", plan.token);
    assert.equal(result.problems.length, 2);
    assert.match(result.problems.join("\n"), /Nb\/_assets\/r\.md/);
    assert.match(result.problems.join("\n"), /Nb\/a\/x\.pdf could not follow it to Nb\/b\/x\.pdf: denied/);
  } finally {
    mock.restoreAll();
  }
  assert.ok(await exists(pdfAnnotationsPath("Nb", ["b", "x.pdf"])), "what moved before the failure stays moved");
  const next = await planNotebookRepair("Nb");
  assert.deepEqual(next.moves.map((move) => [move.from, move.records]), [["Nb/_assets/r.md", ["star"]], ["Nb/a/x.pdf", ["outline"]]], "only what is left is planned again");
}));

test("a Finder round trip: files and a folder moved, the tree's upkeep run, Try to fix and Acknowledge never offer a moved file's records for deletion", () => withTemporaryLibrary(["Nb"], async () => {
  await seedNotebook("Nb");
  // The seeded note gets a link and an image embed by path, comments, ink and code; it moves with its folder.
  const note = "Nb/notes/n.md";
  const content = `${await readFile(filePathFromParts("Nb", ["notes", "n.md"]), "utf8")}\n[the paper](../papers/a.pdf)\n`;
  await writeLibraryFile(note, content);
  await addReviewThreads(note, content, [{ range: { start: 0, end: 6 }, text: "a comment" }]);
  await writeAt(path.join(inkFolderPath("Nb", ["notes", "n.md"]), "text.aaaaaaaaaa.ink"), seeded("note-ink"));
  await writeAt(path.join(getAdminRoot(), ...pythonSidecarPath(note).split("/")), "print('hi')\n");
  await setStarredFilePath("Nb/papers/a.pdf", true);
  await setStarredFilePath(note, true);
  await setFileTagsForPath("Nb/audio/memo.m4a", ["meeting"]);
  await writeReferenceLibrary("Nb", [{ key: "a2026", attachments: ["Nb/papers/a.pdf"] }]);
  await assertNotebookSound("Nb", { severities: ["error", "warning", "info"], allow: ["info indexes: "] });

  // Files moved in Finder, and a folder renamed.
  await finderMove("Nb/papers/a.pdf", "Nb/reading/a.pdf");
  await finderMove("Nb/papers/fig.png", "Nb/reading/figures/fig.png");
  await finderMove("Nb/audio/memo.m4a", "Nb/recordings/memo.m4a");
  await finderMove("Nb/notes", "Nb/journal");
  const moved = [
    ["Nb/papers/a.pdf", "Nb/reading/a.pdf"],
    ["Nb/papers/fig.png", "Nb/reading/figures/fig.png"],
    ["Nb/audio/memo.m4a", "Nb/recordings/memo.m4a"],
    ["Nb/notes/n.md", "Nb/journal/n.md"],
  ];
  const touched = moved.flat();
  /** What a check would offer to delete for good that belongs to a moved file, apart from caches (which are made again). */
  const offered = (items: { path: string; message: string }[]) => items.filter((item) => touched.includes(item.path) && !/out of date|cache|waveform/i.test(item.message));

  // The tree's upkeep: a first load sees the side files orphaned, one 31 s later sets them aside.
  await upkeep("Nb");
  // The check lists the records as stale, but Acknowledge offers nothing while Try to fix can still give them back.
  await assert.rejects(planNotebookCleanup("Nb"), /Use Try to fix first/);

  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves.map((move) => [move.from, move.to]).sort(), [...moved].sort());
  assert.deepEqual(plan.unmatched, []);
  const result = await applyNotebookRepair("Nb", plan.token);
  assert.deepEqual(result.problems, []);
  assert.equal(result.moved.length, 4);

  // Acknowledge, as the dialog does after Try to fix.
  const cleanup = await planNotebookCleanup("Nb");
  assert.deepEqual(offered(cleanup.items), [], "Acknowledge offers nothing that belongs to a moved file");
  assert.deepEqual(cleanup.items.filter((item) => item.lost), [], "nothing people made is offered");
  const cleaned = await applyNotebookCleanup("Nb", cleanup.token);
  assert.deepEqual(cleaned.problems, []);

  // Every record of a moved file is where its file is.
  assert.ok(await exists(pdfAnnotationsPath("Nb", ["reading", "a.pdf"])));
  assert.ok(await exists(path.join(inkFolderPath("Nb", ["reading", "a.pdf"]), SEEDED_INK)));
  assert.ok(await exists(imageAnnotationsPath("Nb", ["reading", "figures", "fig.png"])));
  assert.equal(await readFile(transcriptPath("Nb", ["recordings", "memo.m4a"]), "utf8"), seeded("transcript"));
  assert.ok(await exists(path.join(inkFolderPath("Nb", ["journal", "n.md"]), "text.aaaaaaaaaa.ink")));
  assert.equal((await findReview("Nb/journal/n.md"))?.threads.length, 1);
  assert.equal(await findReview("Nb/notes/n.md"), null);
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths.sort(), ["Nb/journal/n.md", "Nb/reading/a.pdf"]);
  assert.ok((await readFile(path.join(getAdminRoot(), ...pythonSidecarPath("Nb/journal/n.md").split("/")), "utf8")).startsWith("print('hi')"));

  // Sound again, except what no move rewrites: the note's link and its image embed, by library path.
  const allowed = [
    'warning links: Nb/journal/n.md: The link "../papers/a.pdf" finds no file.',
    "error images: Nb/journal/n.md: Shows Nb/papers/fig.png, which is missing.",
  ];
  const report = await assertNotebookSound("Nb", { severities: ["error", "warning", "info"], allow: ["info indexes: ", ...allowed] });
  const described = report.findings.map((finding) => `${finding.severity} ${finding.check}: ${finding.path}: ${finding.message}`);
  for (const expected of allowed) assert.equal(described.filter((text) => text.includes(expected)).length, 1, `${expected} is reported once`);
  assert.deepEqual((await planNotebookRepair("Nb")).moves, [], "nothing is left to find");
  assert.deepEqual((await planNotebookCleanup("Nb")).items, [], "nothing stale is left");
}));
