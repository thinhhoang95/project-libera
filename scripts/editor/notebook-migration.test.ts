import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { assertNotebookSound, SEEDED_INK, seeded, seedNotebook, splitLibraryPath, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listPendingReviews, withReviewWrite } from "../../src/lib/agent/review-store";
import { RunSnapshots, undoRun } from "../../src/lib/agent/snapshots";
import { getMarkdownImageAssetBySource, markdownImageSources, writeMarkdownImageAsset } from "../../src/lib/storage/markdown-assets";
import { acknowledgeMigration, listInterruptedMigrations, listUnacknowledgedMigrations, listUnreadableMigrations, planMigration, resumeMigration, runMigration, setAsideUnreadableMigration, setMigrationFaultForTests, type MigrationRequest } from "../../src/lib/storage/migration";
import { updateMarkdownFile } from "../../src/lib/storage/files";
import { getTree } from "../../src/lib/storage/tree";
import { remapWorkspacePathsMany, type WorkspaceLibrary } from "../../src/lib/workspaces";
import type { OpenTab } from "../../src/components/libera/types";
import {
  audioPeaksPath,
  definitionsPath,
  getAdminRoot,
  filePathFromParts,
  imageAnnotationsPath,
  notebookPath,
  pdfAnnotationsPath,
  pdfOutlinePath,
  pdfTextCachePath,
  transcriptPath,
} from "../../src/lib/storage/paths";
import { inkFolderPath } from "../../src/lib/storage/ink";
import { findOrphanedSidecars, SIDECAR_PATH_HELPERS } from "../../src/lib/storage/sidecars";
import { readWorkspaceMetadata, setFileTagsForPath, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";

const withLibrary = (run: () => Promise<void>) => withTemporaryLibrary(["Src", "Dst"], run);
const split = splitLibraryPath;
const file = writeLibraryFile;
const sidecar = writeAt;
const read = (target: string) => readFile(target, "utf8");

async function migrate(request: MigrationRequest) {
  const plan = await planMigration(request);
  assert.deepEqual(plan.blockers, []);
  return { plan, result: await runMigration(request, plan.token) };
}

const populate = () => seedNotebook("Src");

test("paths.ts per-file sidecars are all in the sidecar registry", async () => {
  const source = await readFile(path.join(process.cwd(), "src/lib/storage/paths.ts"), "utf8");
  const notPerFile = new Set(["filePathFromParts", "relativeItemPath", "audioSidecarPaths", "pdfAnnotationsDirectoryPath", "imageAnnotationsDirectoryPath", "pdfTextCacheDirectoryPath"]);
  const perFile = [...source.matchAll(/export function (\w+)\(notebook: string, (?:pathParts|nameOrParts|parts)\b/g)].map((match) => match[1]).filter((name) => !notPerFile.has(name));
  const registered = new Set<string>(SIDECAR_PATH_HELPERS);
  assert.deepEqual(perFile.filter((name) => !registered.has(name)), [], "add new per-file sidecars to SIDECAR_KINDS in storage/sidecars.ts");
});

test("a mixed batch moves with every sidecar, image and record, and leaves nothing behind", () => withLibrary(async () => {
  await populate();
  await setStarredFilePath("Src/papers/a.pdf", true);
  await setFileTagsForPath("Src/notes/n.md", ["draft"]);
  await withReviewWrite("Src/notes/n.md", "# Note\n", "run-review-1", async () => {
    await file("Src/notes/n.md", `${await read(filePathFromParts("Src", ["notes", "n.md"]))}\nagent line\n`);
  });

  const { plan, result } = await migrate({ source: "Src", paths: ["Src/papers", "Src/notes", "Src/audio/memo.m4a"], destination: { notebook: "Dst" } });
  assert.deepEqual(plan.items.filter((item) => item.kind === "other").map((item) => item.from).sort(), ["Src/notes/.hidden-config", "Src/notes/data.unknownext"]);
  assert.equal(result.state, "done");
  assert.deepEqual(result.leftovers, []);
  assert.deepEqual(result.remaining, []);

  // The files and their sidecars are at the mirrored paths.
  const pdf = split("Dst/papers/a.pdf");
  assert.equal(await read(filePathFromParts(pdf.notebook, pdf.parts)), "%PDF-1.4 a");
  assert.match(await read(pdfAnnotationsPath(pdf.notebook, pdf.parts)), /m1/);
  assert.equal(await read(pdfOutlinePath(pdf.notebook, pdf.parts)), seeded("outline"));
  assert.equal(await read(pdfTextCachePath(pdf.notebook, pdf.parts)), seeded("text-cache"));
  assert.equal(await read(definitionsPath(pdf.notebook, pdf.parts)), seeded("pdf-definitions"));
  assert.equal(await read(path.join(inkFolderPath(pdf.notebook, pdf.parts), SEEDED_INK)), seeded("pdf-ink"));
  assert.ok(existsSync(imageAnnotationsPath("Dst", ["papers", "fig.png"])));
  assert.equal(await read(transcriptPath("Dst", ["audio", "memo.m4a"])), seeded("transcript"));
  assert.equal(await read(audioPeaksPath("Dst", ["audio", "memo.m4a"])), seeded("peaks"));
  assert.equal(await read(definitionsPath("Dst", ["notes", "n.md"])), seeded("note-definitions"));
  assert.equal(await read(path.join(notebookPath("Dst"), "notes", ".hidden-config")), "hidden");
  assert.equal(await read(filePathFromParts("Dst", ["notes", "data.unknownext"])), "unknown");

  // The note's upload was copied; its embed of a moving notebook image follows that image.
  const note = await read(filePathFromParts("Dst", ["notes", "n.md"]));
  assert.match(note, /!\[\]\(\/api\/files\/raw\/Dst\/papers\/fig\.png\)/);
  const upload = markdownImageSources(note).find((source) => !source.startsWith("/api/files/raw/"))!;
  assert.equal((await getMarkdownImageAssetBySource("Dst/notes/n.md", upload)).body.toString(), "photo-bytes");

  // The source keeps nothing: selected folders are gone, as are its unused uploads and every sidecar.
  assert.ok(!existsSync(path.join(notebookPath("Src"), "papers")));
  assert.ok(!existsSync(path.join(notebookPath("Src"), "notes")));
  assert.deepEqual(await readdir(path.join(notebookPath("Src"), "audio")), []);
  assert.ok(!existsSync(path.join(notebookPath("Src"), "_assets", "notes")), "the note's upload left the source");
  assert.deepEqual(await findOrphanedSidecars("Src"), []);
  assert.deepEqual(await findOrphanedSidecars("Dst"), []);

  // Records follow: stars, tags, pending agent reviews.
  const metadata = await readWorkspaceMetadata();
  assert.deepEqual(metadata.starredFilePaths, ["Dst/papers/a.pdf"]);
  assert.deepEqual(metadata.fileTags, { "Dst/notes/n.md": ["draft"] });
  assert.deepEqual((await listPendingReviews()).map((review) => review.path), ["Dst/notes/n.md"]);
  assert.deepEqual(await listInterruptedMigrations(), []);
  // The notebook check agrees: both notebooks came out sound.
  await assertNotebookSound("Src");
  await assertNotebookSound("Dst");
}));

test("name clashes keep both files, and a new notebook is created by the run", () => withLibrary(async () => {
  await file("Src/a.md", "source a");
  await file("Src/b.md", "source b");
  await file("Dst/a.md", "destination a");

  const clash = await planMigration({ source: "Src", paths: ["Src/a.md"], destination: { notebook: "Dst" } });
  assert.deepEqual(clash.items.map((item) => [item.to, item.renamed]), [["Dst/a-1.md", true]]);
  assert.ok(clash.warnings.some((warning) => warning.kind === "renamed"));
  await runMigration({ source: "Src", paths: ["Src/a.md"], destination: { notebook: "Dst" } }, clash.token);
  assert.equal(await read(filePathFromParts("Dst", ["a.md"])), "destination a");
  assert.equal(await read(filePathFromParts("Dst", ["a-1.md"])), "source a");

  const request: MigrationRequest = { source: "Src", paths: ["Src/b.md"], destination: { notebook: "Fresh", create: { emoji: "🧪" } } };
  const plan = await planMigration(request);
  assert.ok(!existsSync(notebookPath("Fresh")), "planning creates nothing");
  const result = await runMigration(request, plan.token);
  assert.equal(result.createdNotebook, true);
  assert.equal(await read(filePathFromParts("Fresh", ["b.md"])), "source b");
  for (const notebook of ["Src", "Dst", "Fresh"]) await assertNotebookSound(notebook);
}));

test("a run refuses a plan that changed since it was reviewed", () => withLibrary(async () => {
  await file("Src/a.md", "a");
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.md"], destination: { notebook: "Dst" } };
  const plan = await planMigration(request);
  await file("Dst/a.md", "now taken");
  await assert.rejects(runMigration(request, plan.token), /changed since/);
  assert.equal(await read(filePathFromParts("Src", ["a.md"])), "a");
}));

test("a crash right after a file is published leaves it whole, keeps its sidecars from being pruned, and resumes", () => withLibrary(async () => {
  await populate();
  const request: MigrationRequest = { source: "Src", paths: ["Src/papers", "Src/notes", "Src/audio/memo.m4a"], destination: { notebook: "Dst" } };
  const plan = await planMigration(request);
  setMigrationFaultForTests((point) => { if (point === "published:Src/audio/memo.m4a") throw new Error("simulated crash"); });
  let result;
  try { result = await runMigration(request, plan.token); }
  finally { setMigrationFaultForTests(null); }
  assert.equal(result.state, "interrupted");
  // The recording is at its new path (and still at the old one, as the same file), its transcript not yet.
  assert.ok(result.moved.some((move) => move.from === "Src/audio/memo.m4a" && move.incomplete));
  assert.ok(existsSync(transcriptPath("Src", ["audio", "memo.m4a"])));

  // Loading the library while interrupted must not take the transcript for an orphan.
  await getTree();
  assert.equal(await read(transcriptPath("Src", ["audio", "memo.m4a"])), seeded("transcript"));
  // Saves to files in flight wait for the migration.
  await assert.rejects(updateMarkdownFile("Src/notes/n.md", "edited meanwhile"), /being moved/);

  const [interrupted] = await listInterruptedMigrations();
  assert.equal(interrupted.phase, "moving");
  assert.ok((await planMigration(request)).blockers.some((blocker) => /did not finish/.test(blocker)));
  const resumed = await resumeMigration(interrupted.id, "continue");
  assert.equal(resumed.state, "done");
  assert.deepEqual(resumed.leftovers, []);
  assert.deepEqual(resumed.bookkeeping, []);
  assert.equal(await read(transcriptPath("Dst", ["audio", "memo.m4a"])), seeded("transcript"));
  assert.equal(await read(definitionsPath("Dst", ["notes", "n.md"])), seeded("note-definitions"));
  assert.ok(!existsSync(filePathFromParts("Src", ["audio", "memo.m4a"])));
  assert.deepEqual(await findOrphanedSidecars("Src"), []);
  assert.deepEqual(await findOrphanedSidecars("Dst"), []);
  assert.deepEqual(await listInterruptedMigrations(), []);
  await assertNotebookSound("Src");
  await assertNotebookSound("Dst");
}));

test("Stop finishes what moved and leaves the rest untouched in the source", () => withLibrary(async () => {
  await populate();
  const request: MigrationRequest = { source: "Src", paths: ["Src/papers", "Src/notes"], destination: { notebook: "Dst" } };
  const plan = await planMigration(request);
  setMigrationFaultForTests((point) => { if (point === "published:Src/papers/fig.png") throw new Error("simulated crash"); });
  let result;
  try { result = await runMigration(request, plan.token); }
  finally { setMigrationFaultForTests(null); }
  assert.equal(result.state, "interrupted");
  const stopped = await resumeMigration(result.id, "stop");
  assert.equal(stopped.state, "done");
  assert.deepEqual(stopped.leftovers, []);
  // The note never moved: it, its sidecars and its images are where they were.
  assert.ok(stopped.remaining.includes("Src/notes/n.md"));
  assert.equal(await read(definitionsPath("Src", ["notes", "n.md"])), seeded("note-definitions"));
  const note = await read(filePathFromParts("Src", ["notes", "n.md"]));
  const upload = markdownImageSources(note).find((source) => !source.startsWith("/api/files/raw/"))!;
  assert.equal((await getMarkdownImageAssetBySource("Src/notes/n.md", upload)).body.toString(), "photo-bytes");
  // No staged copy is left beside a destination.
  const leftovers = (await readdir(path.join(notebookPath("Dst"), "notes")).catch(() => [])).filter((name) => name.startsWith(".libera-migrating-"));
  assert.deepEqual(leftovers, []);
  // The folder that only partly moved stays, with its records.
  assert.ok(existsSync(path.join(notebookPath("Src"), "notes")));
  // Stopping after the image moved leaves the note that stayed showing it from its old place: the one expected finding.
  await assertNotebookSound("Src", { allow: ["Src/notes/n.md: Shows Src/papers/fig.png, which is missing"] });
  await assertNotebookSound("Dst");
}));

test("a crash during finalizing resumes without running the interrupted step twice", () => withLibrary(async () => {
  await file("Src/a.md", "a");
  await setStarredFilePath("Src/a.md", true);
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.md"], destination: { notebook: "Dst" } };
  const plan = await planMigration(request);
  setMigrationFaultForTests((point) => { if (point === "finalize:assets") throw new Error("simulated crash"); });
  await assert.rejects(runMigration(request, plan.token), /simulated crash/);
  setMigrationFaultForTests(null);
  const [interrupted] = await listInterruptedMigrations();
  assert.equal(interrupted.phase, "finalizing");
  const resumed = await resumeMigration(interrupted.id, "continue");
  assert.equal(resumed.state, "done");
  assert.ok(resumed.bookkeeping.some((entry) => /assets/.test(entry)), "the interrupted step is reported, not repeated");
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Dst/a.md"]);
  await assertNotebookSound("Src");
  await assertNotebookSound("Dst");
}));

test("resume refuses a destination file that is not the migration's", () => withLibrary(async () => {
  await file("Src/a.pdf", "%PDF a");
  await file("Src/b.pdf", "%PDF b");
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.pdf", "Src/b.pdf"], destination: { notebook: "Dst" } };
  setMigrationFaultForTests((point) => { if (point === "published:Src/a.pdf") throw new Error("simulated crash"); });
  try { await runMigration(request, (await planMigration(request)).token); }
  finally { setMigrationFaultForTests(null); }
  // Meanwhile something else takes b.pdf's place in the destination.
  await file("Dst/b.pdf", "unrelated");
  const [interrupted] = await listInterruptedMigrations();
  const resumed = await resumeMigration(interrupted.id, "continue");
  assert.equal(resumed.state, "interrupted");
  assert.match(resumed.error ?? "", /not the file this migration moved/);
  assert.equal(await read(filePathFromParts("Dst", ["b.pdf"])), "unrelated", "nothing was replaced");
  assert.equal(await read(filePathFromParts("Src", ["b.pdf"])), "%PDF b", "nothing was removed");
  // The check sees the migration as unfinished, on both sides, and nothing else wrong.
  await assertNotebookSound("Src", { allow: ["did not finish"] });
  await assertNotebookSound("Dst", { allow: ["did not finish"] });
}));

test("files keep their identity, and sidecar data left at a free name is never overwritten", () => withLibrary(async () => {
  await file("Src/a.pdf", "%PDF a");
  const { ino } = await stat(filePathFromParts("Src", ["a.pdf"]));
  // Dst/a.pdf is gone, but its annotations were kept (for re-attaching it later).
  await sidecar(pdfAnnotationsPath("Dst", ["a.pdf"]), seeded("kept annotations"));
  const { plan, result } = await migrate({ source: "Src", paths: ["Src/a.pdf"], destination: { notebook: "Dst" } });
  assert.deepEqual(plan.items.map((item) => item.to), ["Dst/a-1.pdf"]);
  assert.equal(result.state, "done");
  assert.equal(await read(pdfAnnotationsPath("Dst", ["a.pdf"])), seeded("kept annotations"));
  assert.equal((await stat(filePathFromParts("Dst", ["a-1.pdf"]))).ino, ino, "a hard link keeps the file's inode and dates");
  // The kept annotations of the gone a.pdf are the one expected finding.
  await assertNotebookSound("Dst", { allow: ["Dst/a.pdf: Saved pdf annotations of Dst/a.pdf"] });
}));

test("pending agent reviews and undo history follow a note's rewritten image paths", () => withLibrary(async () => {
  await file("Src/fig.png", Buffer.from("png"));
  await file("Src/n.md", "![](/api/files/raw/Src/fig.png)\n");
  await withReviewWrite("Src/n.md", "![](/api/files/raw/Src/fig.png)\n", "run-review-2", async () => {
    await file("Src/n.md", "![](/api/files/raw/Src/fig.png)\nagent line\n");
  });
  const snapshots = new RunSnapshots("run-migrated-2");
  await snapshots.recordOriginal("Src/n.md", "![](/api/files/raw/Src/fig.png)\nagent line\n");
  await file("Src/n.md", "![](/api/files/raw/Src/fig.png)\nagent line\nsecond\n");
  await snapshots.recordWritten("Src/n.md", "![](/api/files/raw/Src/fig.png)\nagent line\nsecond\n");

  await migrate({ source: "Src", paths: ["Src/fig.png", "Src/n.md"], destination: { notebook: "Dst" } });
  assert.equal(await read(filePathFromParts("Dst", ["n.md"])), "![](/api/files/raw/Dst/fig.png)\nagent line\nsecond\n");
  const [review] = await listPendingReviews();
  assert.equal(review.path, "Dst/n.md");
  assert.equal(review.baseline, "![](/api/files/raw/Dst/fig.png)\n", "rejecting the agent's change keeps the new image path");
  const [undone] = await undoRun("run-migrated-2");
  assert.equal(undone.status, "restored", "the rewrite does not count as an edit after the agent's");
  assert.equal(await read(filePathFromParts("Dst", ["n.md"])), "![](/api/files/raw/Dst/fig.png)\nagent line\n");
  await assertNotebookSound("Dst");
}));

test("a finished result is kept until the app acknowledges it", () => withLibrary(async () => {
  await file("Src/a.md", "a");
  const { result } = await migrate({ source: "Src", paths: ["Src/a.md"], destination: { notebook: "Dst" } });
  assert.deepEqual((await listUnacknowledgedMigrations()).map((item) => item.id), [result.id]);
  assert.deepEqual((await planMigration({ source: "Dst", paths: ["Dst/a.md"], destination: { notebook: "Src" } })).blockers, [], "a finished migration blocks nothing");
  await acknowledgeMigration(result.id);
  assert.deepEqual(await listUnacknowledgedMigrations(), []);
}));

test("links to other folders, Libera's own folders and request garbage are refused", { skip: process.platform === "win32" }, () => withLibrary(async () => {
  await file("Src/a.md", "a");
  const outside = await mkdtemp(path.join(os.tmpdir(), "libera-outside-"));
  try {
    await symlink(outside, path.join(notebookPath("Dst"), "linked"));
    const plan = await planMigration({ source: "Src", paths: ["Src/a.md"], destination: { notebook: "Dst", folder: "linked" } });
    assert.ok(plan.blockers.some((blocker) => /link to another folder/.test(blocker)));
    await symlink(outside, path.join(notebookPath("Src"), "elsewhere"));
    await assert.rejects(planMigration({ source: "Src", paths: ["Src/elsewhere"], destination: { notebook: "Dst" } }), /link/);
  } finally { await rm(outside, { recursive: true, force: true }); }
  await assert.rejects(planMigration({ source: ".libera", paths: [".libera/x"], destination: { notebook: "Dst" } }), /not a notebook/);
  await assert.rejects(planMigration({ source: "Src", paths: ["Src/a.md"], destination: { notebook: ".libera" } }), /can't start with/);
  await assert.rejects(planMigration({ source: "Src", paths: [null as unknown as string], destination: { notebook: "Dst" } }), /library paths/);
}));

test("workspace remapping prefers a file's own move over its folder's, and rewrites saved drafts", () => {
  const tab = (filePath: string, text: string) => ({ id: filePath, file: { kind: "file", name: filePath.split("/").at(-1)!, path: filePath, notebook: filePath.split("/")[0], fileType: "markdown", createdAt: "", updatedAt: "", size: 0 }, saved: text, draft: `${text} draft`, status: "dirty" }) as unknown as OpenTab;
  const library: WorkspaceLibrary = { version: 1, updatedAt: 0, activeWorkspaceId: null, workspaces: [], librarySession: { tabs: [tab("Src/f/a.md", "old"), tab("Src/f/b.md", "b")], activeTabId: "Src/f/a.md", selectedNotebookName: "Src", expandedPaths: ["Src/f"] } };
  const next = remapWorkspacePathsMany(library, [{ from: "Src/f", to: "Dst/f" }, { from: "Src/f/a.md", to: "Dst/f/a-1.md" }, { from: "Src/f/b.md", to: "Dst/f/b.md" }], (filePath, text) => filePath === "Dst/f/a-1.md" ? text.replace("old", "new") : text);
  assert.deepEqual(next.librarySession!.tabs.map((item) => [item.file.path, item.saved, item.draft]), [["Dst/f/a-1.md", "new", "new draft"], ["Dst/f/b.md", "b", "b draft"]]);
  assert.equal(next.librarySession!.activeTabId, "Dst/f/a-1.md");
  assert.deepEqual(next.librarySession!.expandedPaths, ["Dst/f"]);
});

test("an agent run's undo still works on a file migrated after the run", () => withLibrary(async () => {
  await file("Src/n.md", "before");
  const snapshots = new RunSnapshots("run-migrated-1");
  await snapshots.recordOriginal("Src/n.md", "before");
  await file("Src/n.md", "after");
  await snapshots.recordWritten("Src/n.md", "after");
  await migrate({ source: "Src", paths: ["Src/n.md"], destination: { notebook: "Dst" } });
  const [undone] = await undoRun("run-migrated-1");
  assert.equal(undone.path, "Src/n.md");
  assert.equal(undone.currentPath, "Dst/n.md");
  assert.equal(undone.status, "restored");
  assert.equal(await read(filePathFromParts("Dst", ["n.md"])), "before");
}));

test("the review warns about LaTeX files and links that the move would split", () => withLibrary(async () => {
  await file("Src/paper/main.tex", "\\documentclass{article}\n\\begin{document}\n\\input{intro}\n\\includegraphics{fig}\n\\end{document}\n");
  await file("Src/paper/intro.tex", "Intro.\n");
  await file("Src/paper/fig.png", Buffer.from("png"));
  await file("Src/notes/a.md", "See [b](b.md).\n");
  await file("Src/notes/b.md", "Back to [a](a.md).\n");

  // The app has loaded the tree (which keeps each notebook's link index) before the dialog opens.
  await getTree();
  const plan = await planMigration({ source: "Src", paths: ["Src/paper/main.tex", "Src/notes/a.md"], destination: { notebook: "Dst" } });
  const warning = (kind: string) => plan.warnings.find((item) => item.kind === kind)?.paths;
  assert.deepEqual(warning("latex-left-behind"), ["Src/paper/fig.png", "Src/paper/intro.tex"]);
  assert.deepEqual(warning("inbound-links"), ["Src/notes/b.md"]);
  assert.deepEqual(warning("outbound-links"), ["Src/notes/a.md"]);

  const whole = await planMigration({ source: "Src", paths: ["Src/paper", "Src/notes"], destination: { notebook: "Dst" } });
  assert.deepEqual(whole.warnings, [], "moving the whole project and both notes splits nothing");
}));

test("the source as destination, archived files, other notebooks' paths and taken names are refused", () => withLibrary(async () => {
  await file("Src/a.md", "a");
  await file("Src/_archive/old.md", "old");
  const self = await planMigration({ source: "Src", paths: ["Src/a.md"], destination: { notebook: "Src" } });
  assert.ok(self.blockers.some((blocker) => /different destination/.test(blocker)));
  await assert.rejects(planMigration({ source: "Src", paths: ["Src/_archive/old.md"], destination: { notebook: "Dst" } }), /Archived/);
  await assert.rejects(planMigration({ source: "Src", paths: ["Dst/a.md"], destination: { notebook: "Dst" } }), /not in Src/);
  const taken = await planMigration({ source: "Src", paths: ["Src/a.md"], destination: { notebook: "Dst", create: {} } });
  assert.ok(taken.blockers.some((blocker) => /already exists/.test(blocker)));
}));

test("a crash while staging is undone on resume: copied images, created folders and the new notebook go away", () => withLibrary(async () => {
  await file("Src/notes/n.md", "# Note\n");
  const upload = await writeMarkdownImageAsset("Src/notes/n.md", new File(["photo-bytes"], "photo.png"));
  await file("Src/notes/n.md", `# Note\n\n${upload.markdown}\n`);
  await file("Src/notes/z.md", "z");
  const request: MigrationRequest = { source: "Src", paths: ["Src/notes"], destination: { notebook: "Fresh", create: { emoji: "🧪" } } };
  const plan = await planMigration(request);
  setMigrationFaultForTests((point) => { if (point === "staged:Src/notes/n.md") throw Object.assign(new Error("simulated crash"), { crash: true }); });
  await assert.rejects(runMigration(request, plan.token), /simulated crash/);
  setMigrationFaultForTests(null);
  // The crash left the new notebook with the note's copied image.
  assert.ok(existsSync(path.join(notebookPath("Fresh"), "_assets")));
  const [interrupted] = await listInterruptedMigrations();
  assert.equal(interrupted.phase, "staging");
  const result = await resumeMigration(interrupted.id, "continue");
  assert.deepEqual(result.moved, []);
  assert.ok(!existsSync(path.join(getAdminRoot(), "Fresh")), "the notebook made for the migration is gone again");
  assert.equal(await read(filePathFromParts("Src", ["notes", "n.md"])), `# Note\n\n${upload.markdown}\n`, "the source never changed");
}));

test("selected folders keep their empty folders, and the plan refuses spaced names and the archive", () => withLibrary(async () => {
  await file("Src/project/a.md", "a");
  await mkdir(path.join(notebookPath("Src"), "project", "empty", "deeper"), { recursive: true });
  const { result } = await migrate({ source: "Src", paths: ["Src/project"], destination: { notebook: "Dst" } });
  assert.equal(result.check, "clean");
  assert.ok(existsSync(path.join(notebookPath("Dst"), "project", "empty", "deeper")));
  assert.ok(!existsSync(path.join(notebookPath("Src"), "project")));

  await writeFile(path.join(notebookPath("Src"), "spaced.md "), "x");
  await mkdir(path.join(notebookPath("Src"), "folder"));
  // " inner.md" is a note the panel shows; "inner.md " is not one (its extension is ".md "), so it would move as hidden content.
  await writeFile(path.join(notebookPath("Src"), "folder", " inner.md"), "x");
  await file("Src/folder/ok.md", "ok");
  await assert.rejects(planMigration({ source: "Src", paths: ["Src/spaced.md "], destination: { notebook: "Dst" } }), /starts or ends with a space/);
  const folder = await planMigration({ source: "Src", paths: ["Src/folder"], destination: { notebook: "Dst" } });
  assert.ok(folder.blockers.some((blocker) => /starts or ends with a space/.test(blocker)));
  await assert.rejects(planMigration({ source: "Src", paths: ["Src/folder/ok.md"], destination: { notebook: "Dst", folder: "_ARCHIVE" } }), /archive/);
}));

test("links that break even when both ends move, and LaTeX chapters resolved from their main file, are reported", () => withLibrary(async () => {
  await file("Src/notes/a.md", "See [b](b.md).\n");
  await file("Src/notes/b.md", "B\n");
  await file("Dst/notes/b.md", "another b\n");
  await file("Src/paper/main.tex", "\\documentclass{article}\n\\graphicspath{{figs/}}\n\\begin{document}\n\\input{chapters/one}\n\\end{document}\n");
  await file("Src/paper/chapters/one.tex", "\\includegraphics*[width=1cm]{plot}\n");
  await file("Src/paper/figs/plot.png", Buffer.from("png"));
  await getTree();
  const plan = await planMigration({ source: "Src", paths: ["Src/notes", "Src/paper/chapters/one.tex"], destination: { notebook: "Dst" } });
  const warning = (kind: string) => plan.warnings.find((item) => item.kind === kind)?.paths;
  // b.md is renamed b-1.md to keep both, so a.md's "b.md" would open the other b.
  assert.deepEqual(warning("outbound-links"), ["Src/notes/a.md"]);
  assert.deepEqual(warning("latex-left-behind"), ["Src/paper/figs/plot.png", "Src/paper/main.tex"]);
}));

test("an unreadable journal blocks migrations until it is set aside", () => withLibrary(async () => {
  await file("Src/a.md", "a");
  const directory = path.join(getAdminRoot(), ".libera", "migrations");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "0badc0de-0000.json"), "{ damaged");
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.md"], destination: { notebook: "Dst" } };
  assert.ok((await planMigration(request)).blockers.some((blocker) => /can't be read/.test(blocker)));
  // Saves are not blocked by it.
  await updateMarkdownFile("Src/a.md", "a2");
  assert.deepEqual(await listUnreadableMigrations(), ["0badc0de-0000.json"]);
  await setAsideUnreadableMigration("0badc0de-0000.json");
  assert.deepEqual((await planMigration(request)).blockers, []);
  assert.ok((await readdir(directory)).some((name) => name.startsWith("0badc0de-0000.json.unreadable-")), "kept for inspection");
}));

test("the token covers the new notebook's details, and the result returns its workspace group", () => withLibrary(async () => {
  await file("Src/a.md", "a");
  const request = (emoji: string): MigrationRequest => ({ source: "Src", paths: ["Src/a.md"], destination: { notebook: "Fresh", create: { emoji, workspaceGroupId: "group-1" } } });
  const plan = await planMigration(request("🧪"));
  await assert.rejects(runMigration(request("📓"), plan.token), /changed since/);
  const result = await runMigration(request("🧪"), plan.token);
  assert.deepEqual(result.workspaceGroup, { notebook: "Fresh", groupId: "group-1" });
  assert.equal(result.check, "clean");
}));

test("a note that stays and shows a moving image is warned about, and the check sees the same", () => withLibrary(async () => {
  await file("Src/fig.png", Buffer.from("png"));
  await file("Src/stays.md", "![](/api/files/raw/Src/fig.png)\n");
  const { plan } = await migrate({ source: "Src", paths: ["Src/fig.png"], destination: { notebook: "Dst" } });
  assert.deepEqual(plan.warnings.find((warning) => warning.kind === "inbound-images")?.paths, ["Src/stays.md"]);
  // What the review warned about is exactly what the notebook check finds afterwards.
  await assertNotebookSound("Src", { allow: ["Src/stays.md: Shows Src/fig.png, which is missing"] });
  await assertNotebookSound("Dst");
}));

test("a flat move puts each selected item directly in the destination folder (Move… of one file)", () => withLibrary(async () => {
  await populate();
  await mkdir(path.join(notebookPath("Dst"), "inbox"), { recursive: true });
  const { plan, result } = await migrate({ source: "Src", paths: ["Src/papers/a.pdf", "Src/notes"], destination: { notebook: "Dst", folder: "inbox", flat: true } });
  assert.ok(plan.items.some((item) => item.from === "Src/papers/a.pdf" && item.to === "Dst/inbox/a.pdf"));
  // A selected folder keeps its own content under it.
  assert.ok(plan.items.some((item) => item.from === "Src/notes/n.md" && item.to === "Dst/inbox/notes/n.md"));
  assert.equal(result.check, "clean");
  assert.match(await read(pdfAnnotationsPath("Dst", ["inbox", "a.pdf"])), /m1/);
  await assertNotebookSound("Src", { allow: ["Shows Src/papers/fig.png"] });
  await assertNotebookSound("Dst");
}));
