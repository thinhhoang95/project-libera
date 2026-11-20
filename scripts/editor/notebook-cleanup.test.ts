import assert from "node:assert/strict";
import fsp, { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { bibTetherStatePath, readTetherTarget, resetBibTethers, tetherBibFile } from "../../src/lib/references/bib-tether";
import { DEFINITIONS_VERSION } from "../../src/lib/definitions";
import { pythonSidecarPath } from "../../src/lib/python/sidecar";
import { applyNotebookCleanup, planNotebookCleanup } from "../../src/lib/storage/cleanup";
import { verifyNotebook, type IntegrityReport } from "../../src/lib/storage/integrity";
import { addReviewThreads, deleteReviewKey, findReview } from "../../src/lib/storage/markdown-reviews";
import { emptyInkAuthorFile } from "../../src/lib/ink/codec";
import { inkFolderPath, reconcileInkFolders } from "../../src/lib/storage/ink";
import { reconcilePdfSidecars } from "../../src/lib/storage/pdf-sidecars";
import { definitionsDirectoryPath, definitionsPath, filePathFromParts, getAdminRoot, notebookPath, orphanedSidecarsDirectoryPath, pdfAnnotationsPath, transcriptPath } from "../../src/lib/storage/paths";
import { refreshNotebookCitations } from "../../src/lib/storage/reference-citations";
import { readReferenceLibrary } from "../../src/lib/storage/references";
import { readWorkspaceMetadata, setFileTagsForPath, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";
import { assertNotebookSound, SEEDED_INK, seeded, seedNotebook, withTemporaryLibrary, writeAt, writeLibraryFile, writeReferenceLibrary } from "./notebook-test-helpers";

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
  await writeAt(path.join(kept, "ink", SEEDED_INK), seeded("pdf-ink"));
  const plan = await planNotebookCleanup("Nb");
  assert.deepEqual(plan.items, []);
  assert.ok(await exists(path.join(kept, "ink", SEEDED_INK)));
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

const inkFile = () => JSON.stringify(emptyInkAuthorFile({ key: "aaaaaaaaaa" }, { unit: "pt", width: 100, height: 100 }));

/** The tree's upkeep after a Finder move: a first load sees the side files orphaned, one 31 s later sets them aside. */
async function upkeep(notebook: string) {
  const now = Date.now();
  for (const at of [now, now + 31_000]) {
    await reconcileInkFolders(notebook, [], { now: at });
    await reconcilePdfSidecars(notebook, [], { now: at });
  }
}

test("ink set aside for a file that is gone is offered as ink, and removed with the record", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a/x.md", "# X\n");
  await writeAt(path.join(inkFolderPath("Nb", ["a", "x.md"]), "text.aaaaaaaaaa.ink"), inkFile());
  await gone("Nb/a/x.md");
  await upkeep("Nb");
  const plan = await planNotebookCleanup("Nb");
  const aside = plan.items.find((item) => /kept for files/.test(item.message));
  assert.ok(aside?.lost);
  assert.match(aside.consequence, /annotations, outlines, definitions, ink\)/);
  const result = await applyNotebookCleanup("Nb", plan.token);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(await readdir(orphanedSidecarsDirectoryPath("Nb", "ink")), []);
}));

test("a starred note with ink moved in Finder and set aside is paired by Try to fix, not offered to Acknowledge", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a/x.md", "# X\n");
  await setStarredFilePath("Nb/a/x.md", true);
  await writeAt(path.join(inkFolderPath("Nb", ["a", "x.md"]), "text.aaaaaaaaaa.ink"), inkFile());
  await mkdir(path.join(notebookPath("Nb"), "b"));
  await rename(filePathFromParts("Nb", ["a", "x.md"]), filePathFromParts("Nb", ["b", "x.md"]));
  await upkeep("Nb");
  await assert.rejects(planNotebookCleanup("Nb"), /Nb\/a\/x\.md -> Nb\/b\/x\.md/);
}));

test("records of a name several files have are kept, not offered as stale", () => withTemporaryLibrary(["Nb"], async () => {
  for (const folder of ["a", "b"]) {
    await writeLibraryFile(`Nb/${folder}/notes.md`, `# ${folder}\n`);
    await setStarredFilePath(`Nb/${folder}/notes.md`, true);
  }
  // Both folders are renamed in Finder: two missing paths share a name, so Try to fix pairs neither.
  await rename(path.join(notebookPath("Nb"), "a"), path.join(notebookPath("Nb"), "c"));
  await rename(path.join(notebookPath("Nb"), "b"), path.join(notebookPath("Nb"), "d"));
  // Something that is plainly stale goes with them.
  await writeLibraryFile("Nb/lost.md", "x");
  await setStarredFilePath("Nb/lost.md", true);
  await gone("Nb/lost.md");
  const plan = await planNotebookCleanup("Nb");
  assert.deepEqual(plan.items.map((item) => item.path), ["Nb/lost.md"]);
  assert.ok(plan.remaining >= 2);
  assert.match(plan.notes.join("\n"), /more than one file has the name/);
  const result = await applyNotebookCleanup("Nb", plan.token);
  assert.deepEqual(result.problems, []);
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths.sort(), ["Nb/a/notes.md", "Nb/b/notes.md"]);
}));

test("a set-aside side file whose name several files have is kept", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a/x.md", "# X\n");
  await writeAt(path.join(inkFolderPath("Nb", ["a", "x.md"]), "text.aaaaaaaaaa.ink"), inkFile());
  await mkdir(path.join(notebookPath("Nb"), "b"));
  await mkdir(path.join(notebookPath("Nb"), "c"));
  await rename(filePathFromParts("Nb", ["a", "x.md"]), filePathFromParts("Nb", ["b", "x.md"]));
  await writeLibraryFile("Nb/c/x.md", "# Another\n");
  await upkeep("Nb");
  const plan = await planNotebookCleanup("Nb");
  assert.deepEqual(plan.items, []);
  assert.match(plan.notes.join("\n"), /more than one file has the name/);
  await applyNotebookCleanup("Nb", plan.token);
  assert.equal((await readdir(orphanedSidecarsDirectoryPath("Nb", "ink"))).length, 1);
}));

test("what a check that ran only in part found is not offered", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a.md", "a");
  await setStarredFilePath("Nb/a.md", true);
  await gone("Nb/a.md");
  const whole = await planNotebookCleanup("Nb");
  assert.equal(whole.items.length, 1);
  const options = { limits: { entries: 0 } };
  const partial = await planNotebookCleanup("Nb", options);
  assert.deepEqual(partial.items, []);
  // The budget was gone before the checks started: they did not run, and the plan says so.
  assert.match(partial.notes.join("\n"), /ran only in part/);
  const result = await applyNotebookCleanup("Nb", partial.token, options);
  assert.equal(result.cleared, 0);
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Nb/a.md"]);
}));

// ---- Races, versions and outcomes (findings 78-85) ----

/** Runs `before` once, the first time `fsp[name]` is called with arguments `when` accepts, then carries on. */
function onFirst(name: "realpath" | "rm" | "open" | "mkdir", when: (args: unknown[]) => boolean, before: () => Promise<unknown>) {
  const original = fsp[name] as (...args: unknown[]) => Promise<unknown>;
  let fired = false;
  mock.method(fsp, name, (async (...args: unknown[]) => {
    if (!fired && when(args)) { fired = true; await before(); }
    return original(...args);
  }) as never);
  return () => fired;
}
const isIn = (args: unknown[], directory: string) => path.resolve(String(args[0])) === path.resolve(directory);

test("a transcript or review saved at the same address after the plan is not removed with the stale one", () => withTemporaryLibrary(["Nb"], async () => {
  await writeAt(transcriptPath("Nb", ["audio", "memo.m4a"]), seeded("transcript"));
  await addReviewThreads("Nb/gone.md", "# G\n", [{ range: { start: 2, end: 3 }, text: "first" }]);
  const plan = await planNotebookCleanup("Nb");
  assert.equal(plan.items.length, 2);
  const transcript = transcriptPath("Nb", ["audio", "memo.m4a"]);
  const replacedTranscript = onFirst("realpath", (args) => isIn(args, path.dirname(transcript)), () => writeFile(transcript, "{\"new\":\"transcript saved after the plan\"}"));
  const replacedReview = onFirst("mkdir", (args) => String(args[0]).includes(`${path.sep}libera-locks${path.sep}reviews-`), () => addReviewThreads("Nb/gone.md", "# G\n", [{ range: { start: 0, end: 1 }, text: "a newer comment" }]));
  try {
    const result = await applyNotebookCleanup("Nb", plan.token);
    assert.ok(replacedTranscript() && replacedReview());
    assert.equal(result.cleared, 0);
    assert.equal(result.outcomes.held, 2);
    assert.match(result.problems.join("\n"), /changed since it was shown/);
    assert.match(result.problems.join("\n"), /review comments of Nb\/gone\.md changed since/);
    assert.ok(await exists(transcript), "the new transcript is kept");
    assert.equal((await findReview("Nb/gone.md"))?.threads.length, 2, "the review with the newer comment is kept");
  } finally { mock.restoreAll(); }
}));

test("ink files added to a stale ink folder after the plan keep the folder", () => withTemporaryLibrary(["Nb"], async () => {
  const folder = inkFolderPath("Nb", ["a", "x.pdf"]);
  await writeAt(path.join(folder, "page-0001.aaaaaaaaaa.ink"), inkFile());
  const plan = await planNotebookCleanup("Nb");
  assert.equal(plan.items.length, 1);
  onFirst("realpath", (args) => isIn(args, path.dirname(folder)), () => writeFile(path.join(folder, "page-0002.aaaaaaaaaa.ink"), inkFile()));
  try {
    const result = await applyNotebookCleanup("Nb", plan.token);
    assert.equal(result.outcomes.held, 1);
    assert.equal((await readdir(folder)).length, 2);
  } finally { mock.restoreAll(); }
}));

test("a stale record whose name is now a folder is offered, and removed, not refused at apply", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/old.md", "# Old\n");
  await setStarredFilePath("Nb/old.md", true);
  await gone("Nb/old.md");
  await mkdir(filePathFromParts("Nb", ["old.md"]));
  const plan = await planNotebookCleanup("Nb");
  assert.deepEqual(plan.items.map((item) => item.path), ["Nb/old.md"]);
  const result = await applyNotebookCleanup("Nb", plan.token);
  assert.deepEqual(result.problems, []);
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, []);
}));

/** Ink set aside for files that are gone, one set per owner; the tree's upkeep did it. */
async function setAsideInk(files: string[], pages = ["text.aaaaaaaaaa.ink"]) {
  for (const file of files) {
    const [, ...parts] = file.split("/");
    await writeLibraryFile(file, "# X\n");
    for (const page of pages) await writeAt(path.join(inkFolderPath("Nb", parts), page), inkFile());
    await gone(file);
  }
  await upkeep("Nb");
}

test("set-aside ink whose owner returns during apply is kept, record and payload", () => withTemporaryLibrary(["Nb"], async () => {
  await setAsideInk(["Nb/a/x.md"]);
  const plan = await planNotebookCleanup("Nb");
  assert.ok(plan.items.some((item) => /kept for files/.test(item.message)));
  const root = orphanedSidecarsDirectoryPath("Nb", "ink");
  onFirst("realpath", (args) => path.resolve(String(args[0])).startsWith(path.resolve(root)), () => writeLibraryFile("Nb/a/x.md", "# X\n"));
  try {
    const result = await applyNotebookCleanup("Nb", plan.token);
    assert.equal(result.outcomes.removed, 0);
    assert.ok(result.outcomes.held >= 1);
    const [unit] = await readdir(root);
    assert.deepEqual((await readdir(path.join(root, unit))).sort(), ["ink", "record.json"]);
  } finally { mock.restoreAll(); }
}));

test("when part of a set-aside ink folder can't be removed, its record stays with what is left", () => withTemporaryLibrary(["Nb"], async () => {
  await setAsideInk(["Nb/a/x.md"], ["text.aaaaaaaaaa.ink", "text.bbbbbbbbbb.ink"]);
  const plan = await planNotebookCleanup("Nb");
  const root = orphanedSidecarsDirectoryPath("Nb", "ink");
  const original = fsp.rm as (...args: unknown[]) => Promise<void>;
  mock.method(fsp, "rm", (async (target: unknown, ...rest: unknown[]) => {
    if (String(target).endsWith("text.aaaaaaaaaa.ink")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    return original(target, ...rest);
  }) as never);
  try {
    const result = await applyNotebookCleanup("Nb", plan.token);
    assert.equal(result.outcomes.unreadable, 1);
    assert.equal(result.cleared, 0, "the finding stays");
    const [unit] = await readdir(root);
    assert.ok(await exists(path.join(root, unit, "record.json")), "the record that says whose ink it is stays");
    assert.deepEqual(await readdir(path.join(root, unit, "ink")), ["text.aaaaaaaaaa.ink"]);
  } finally { mock.restoreAll(); }
}));

test("the preview lists each set-aside record and the file it was kept for", () => withTemporaryLibrary(["Nb"], async () => {
  await setAsideInk(["Nb/a/x.md", "Nb/b/y.md"]);
  const plan = await planNotebookCleanup("Nb");
  const aside = plan.items.find((item) => /kept for files/.test(item.message))!;
  assert.deepEqual([...new Set(aside.entries.map((entry) => entry.origin))].sort(), ["Nb/a/x.md", "Nb/b/y.md"]);
  assert.ok(aside.entries.every((entry) => /orphaned-sidecars/.test(entry.record)));
  assert.ok(aside.entries.length >= 4, "payload and record of both");
}));

test("an image another notebook's note shows by address is not offered, by either address form", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  const folder = path.join(notebookPath("Nb"), "_assets", "notes", "old.md");
  for (const name of ["chart.png", "chart2.png", "free.png"]) await writeAt(path.join(folder, name), "png");
  await writeLibraryFile("Other/n.md", [
    "![a](/api/files/raw/Nb/_assets/notes/old.md/chart.png)",
    `![b](/api/markdown-assets/raw?document=${encodeURIComponent("Nb/notes/old.md")}&asset=${encodeURIComponent("_assets/notes/old.md/chart2.png")})`,
  ].join("\n"));
  const plan = await planNotebookCleanup("Nb");
  assert.deepEqual(plan.items.map((item) => item.path), ["Nb/_assets/notes/old.md/free.png"]);
  assert.match(plan.notes.join("\n"), /2 images left out/);
  await applyNotebookCleanup("Nb", plan.token);
  assert.ok((await exists(path.join(folder, "chart.png"))) && (await exists(path.join(folder, "chart2.png"))) && !(await exists(path.join(folder, "free.png"))));
}));

test("when other notebooks' notes can't all be read, no image is offered", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  const image = path.join(notebookPath("Nb"), "_assets", "notes", "old.md", "chart.png");
  await writeAt(image, "png");
  await writeLibraryFile("Other/sub/n.md", "text");
  const original = fsp.readdir as (...args: unknown[]) => Promise<unknown>;
  mock.method(fsp, "readdir", ((target: unknown, ...rest: unknown[]) => String(target).endsWith(`${path.sep}sub`)
    ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
    : original(target, ...rest)) as never);
  try {
    const plan = await planNotebookCleanup("Nb");
    assert.deepEqual(plan.items, []);
    assert.match(plan.notes.join("\n"), /could not be read/);
    await applyNotebookCleanup("Nb", plan.token);
    assert.ok(await exists(image));
  } finally { mock.restoreAll(); }
}));

test("an image a note starts to show while Acknowledge applies is kept", () => withTemporaryLibrary(["Nb"], async () => {
  const image = path.join(notebookPath("Nb"), "_assets", "notes", "old.md", "chart.png");
  await writeAt(image, "png");
  await writeAt(transcriptPath("Nb", ["audio", "memo.m4a"]), seeded("transcript"));
  const plan = await planNotebookCleanup("Nb");
  assert.equal(plan.items.length, 2);
  // The transcript goes first; the note is saved with the image right then.
  onFirst("rm", () => true, () => writeLibraryFile("Nb/n.md", "# N\n\n![](_assets/notes/old.md/chart.png)\n"));
  try {
    const result = await applyNotebookCleanup("Nb", plan.token);
    assert.ok(await exists(image));
    assert.match(result.problems.join("\n"), /is shown by a note now/);
    assert.equal(result.outcomes.held, 1);
  } finally { mock.restoreAll(); }
}));

/** A notebook tethered to a .bib outside it, which then goes missing; its folder stays. */
async function tetheredToMissing(outside: string) {
  const bib = path.join(outside, "refs.bib");
  await writeFile(bib, "@article{a, title={A}}\n");
  await tetherBibFile("Nb", bib, { prefer: "library" });
  resetBibTethers();
  await rm(bib);
  return bib;
}

test("a tether is kept when its file returns, or another file is tethered, between the plan and the removal", () => withTemporaryLibrary(["Nb"], async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "libera-bib-"));
  try {
    const bib = await tetheredToMissing(outside);
    const plan = await planNotebookCleanup("Nb");
    assert.equal(plan.items.length, 1);
    const lock = (args: unknown[]) => String(args[0]).includes("reflib-");
    onFirst("open", lock, () => writeFile(bib, "@article{a, title={A}}\n"));
    try {
      const result = await applyNotebookCleanup("Nb", plan.token);
      assert.equal(result.outcomes.held, 1);
      assert.deepEqual(await readTetherTarget("Nb"), { absolutePath: bib });
    } finally { mock.restoreAll(); resetBibTethers(); }
    // Missing again; this time another window points the tether at a different file just before the lock is taken (its state file is rewritten; tethering in process would queue behind this lock).
    await rm(bib);
    const other = path.join(outside, "other.bib");
    await writeFile(other, "@article{b, title={B}}\n");
    const second = await planNotebookCleanup("Nb");
    assert.equal(second.items.length, 1);
    onFirst("open", lock, async () => {
      const state = JSON.parse(await readFile(bibTetherStatePath("Nb"), "utf8")) as { target: { kind: string; path: string } };
      state.target = { kind: "absolute", path: other };
      await writeFile(bibTetherStatePath("Nb"), JSON.stringify(state));
    });
    try {
      const result = await applyNotebookCleanup("Nb", second.token);
      assert.equal(result.outcomes.held, 1);
      assert.deepEqual(await readTetherTarget("Nb"), { absolutePath: other });
    } finally { mock.restoreAll(); resetBibTethers(); }
  } finally { await rm(outside, { recursive: true, force: true }); }
}));

test("a tether whose folder can't be checked is not offered", () => withTemporaryLibrary(["Nb"], async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "libera-bib-"));
  try {
    await tetheredToMissing(outside);
    assert.equal((await planNotebookCleanup("Nb")).items.length, 1, "with the folder readable it is");
    for (const name of ["lstat", "stat"] as const) {
      const original = fsp[name] as (...args: unknown[]) => Promise<unknown>;
      mock.method(fsp, name, ((target: unknown, ...rest: unknown[]) => isIn([target], outside)
        ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
        : original(target, ...rest)) as never);
    }
    try {
      const plan = await planNotebookCleanup("Nb");
      assert.deepEqual(plan.items, []);
      assert.match(plan.notes.join("\n"), /tether is left out/);
    } finally { mock.restoreAll(); }
  } finally { await rm(outside, { recursive: true, force: true }); }
}));

test("a removal that can't be done is not counted as done", () => withTemporaryLibrary(["Nb"], async () => {
  const transcript = transcriptPath("Nb", ["audio", "memo.m4a"]);
  await writeAt(transcript, seeded("transcript"));
  await writeLibraryFile("Nb/lost.md", "x");
  await setStarredFilePath("Nb/lost.md", true);
  await gone("Nb/lost.md");
  const plan = await planNotebookCleanup("Nb");
  assert.equal(plan.items.length, 2);
  const original = fsp.realpath as (...args: unknown[]) => Promise<unknown>;
  mock.method(fsp, "realpath", ((target: unknown, ...rest: unknown[]) => isIn([target], path.dirname(transcript))
    ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
    : original(target, ...rest)) as never);
  try {
    const result = await applyNotebookCleanup("Nb", plan.token);
    assert.deepEqual(result.outcomes, { removed: 1, alreadyAbsent: 0, unreadable: 1, held: 0 });
    assert.equal(result.cleared, 1, "only the star's finding is cleared");
    assert.ok(await exists(transcript));
  } finally { mock.restoreAll(); }
}));

test("code whose owning note was not in the listing is not offered for removal, and its check is partial", () => withTemporaryLibrary(["Nb"], async () => {
  const code = "Nb/_assets/old/a.md/a.py";
  await writeAt(path.join(getAdminRoot(), ...pythonSidecarPath("Nb/old/a.md").split("/")), "print('hi')\n");
  // No note of its name: the code is stale, and Acknowledge may remove it.
  const orphan = (report: IntegrityReport) => report.findings.find((finding) => finding.check === "assets" && finding.path === code);
  assert.equal(orphan(await verifyNotebook("Nb"))?.clear?.length, 1);

  // The note that would own it is in a folder the tree listing could not read (the notes themselves are read later).
  await writeLibraryFile("Nb/later/a.md", "# A\n");
  const original = fsp.readdir;
  let denied = false;
  mock.method(fsp, "readdir", ((target: string, ...rest: unknown[]) => {
    if (!denied && path.basename(String(target)) === "later") { denied = true; return Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" })); }
    return (original as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof fsp.readdir);
  try {
    const report = await verifyNotebook("Nb");
    assert.ok(denied, "the listing hit the unreadable folder");
    assert.equal(orphan(report)?.clear, undefined, "no deletion is offered on an input that was not listed");
    const assets = report.checks.find((check) => check.id === "assets");
    assert.equal(assets?.status, "incomplete");
    assert.ok(assets?.notes?.some((note) => note.code === "foldersUnreadable"));
  } finally { mock.restoreAll(); }
}));

test("Acknowledge clears a citation index entry of an archived note that left the archive, with the archive hidden", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/_archive/old.md", "See [@smith2020].\n");
  await writeLibraryFile("Nb/a.md", "No citation.\n");
  await refreshNotebookCitations("Nb", { includeArchive: true });
  await gone("Nb/_archive/old.md");
  const stale = () => verifyNotebook("Nb").then((report) => report.findings.filter((finding) => finding.check === "indexes").map((finding) => finding.message));
  assert.deepEqual(await stale(), ["The citation index is out of date for 1 file; it is brought up to date the next time citations are listed."]);

  const plan = await planNotebookCleanup("Nb");
  const result = await applyNotebookCleanup("Nb", plan.token);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(await stale(), [], "the finding it said it cleared is cleared");
}));
