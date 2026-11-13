import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp, { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { directoryModeStatePath } from "../../electron/directory-mode.cjs";
import { emptyInkAuthorFile } from "../../src/lib/ink/codec";
import { createMarkdownFileLinkDestination } from "../../src/lib/markdown-file-links";
import { searchIndexFile } from "../../src/lib/search/settings";
import { inkFolderPath } from "../../src/lib/storage/ink";
import { reviewsDirectory } from "../../src/lib/storage/review-files";
import { listSidecars } from "../../src/lib/storage/sidecars";
import { verifyNotebook, type IntegrityReport } from "../../src/lib/storage/integrity";
import { writeMarkdownImageAsset } from "../../src/lib/storage/markdown-assets";
import { linkIndexPath } from "../../src/lib/storage/notebook-links";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { audioPeaksPath, definitionsPath, filePathFromParts, getAdminRoot, getStateRoot, notebookPath, orphanedSidecarsDirectoryPath, pdfAnnotationsPath, pdfTextCachePath, transcriptPath, workspaceMetadataPath } from "../../src/lib/storage/paths";
import { citationIndexPath } from "../../src/lib/storage/reference-citations";
import { seedNotebook, writeReferenceLibrary } from "./notebook-test-helpers";
import { setFileTagsForPath, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";
import { currentReferenceJobRunner, setReferenceJobRunner } from "../../src/lib/references/jobs";
import { resetBibTethers, tetherBibFile } from "../../src/lib/references/bib-tether";

async function withLibrary(run: () => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-integrity-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try { await createNotebook("Nb"); await run(); }
  finally {
    currentReferenceJobRunner()?.dispose();
    setReferenceJobRunner(undefined);
    resetBibTethers();
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

async function file(relative: string, content: string | Buffer) {
  const [notebook, ...parts] = relative.split("/");
  const target = filePathFromParts(notebook, parts);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function raw(target: string, content: string) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

/** Every file and folder under the data directory, with its modification time. */
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

const of = (report: IntegrityReport, check: string) => report.findings.filter((finding) => finding.check === check);

test("a sound notebook has no findings", () => withLibrary(async () => {
  await file("Nb/notes/a.md", "See [b](b.md) and [the paper](../papers/p.pdf).\n");
  await file("Nb/notes/b.md", "Back to [a](a.md).\n");
  await file("Nb/papers/p.pdf", "%PDF");
  await raw(pdfAnnotationsPath("Nb", ["papers", "p.pdf"]), JSON.stringify({ annotations: [], comments: [] }));
  await file("Nb/paper/main.tex", "\\documentclass{article}\n\\usepackage{mystyle}\n\\begin{document}\n\\input{intro}\n\\includegraphics{fig}\n\\bibliography{refs}\n\\end{document}\n");
  await file("Nb/paper/intro.tex", "Intro.\n");
  await file("Nb/paper/fig.png", Buffer.from("png"));
  await file("Nb/paper/refs.bib", "@article{a, title={A}}\n");
  const report = await verifyNotebook("Nb");
  assert.deepEqual(report.findings.filter((finding) => finding.severity !== "info"), []);
  assert.ok(report.checks.every((check) => check.status === "ok" || check.status === "findings"));
  assert.equal(report.counts.notes, 2);
}));

test("problems of every kind are reported, and the check changes nothing on disk", () => withLibrary(async () => {
  // Side files of files that are gone, and one that can't be read.
  await raw(pdfAnnotationsPath("Nb", ["gone.pdf"]), "{}");
  await raw(transcriptPath("Nb", ["gone.m4a"]), "{}");
  await file("Nb/kept.md", "kept");
  await raw(definitionsPath("Nb", ["kept.md"]), "{ damaged");
  // A note with a missing upload, a missing notebook image and a broken link.
  await file("Nb/n.md", "# N\n");
  const upload = await writeMarkdownImageAsset("Nb/n.md", new File(["photo"], "photo.png"));
  await rm(path.join(notebookPath("Nb"), upload.markdown.match(/\(([^)]+)\)/)![1].replace(/^<|>$/g, "")), { force: true });
  await file("Nb/n.md", `# N\n\n${upload.markdown}\n\n![](/api/files/raw/Nb/missing.png)\n\n[gone](nowhere.md)\n`);
  // Python code and an image of a note that was deleted.
  await raw(path.join(notebookPath("Nb"), "_assets", "deleted.md", "deleted.py"), "print(1)");
  await raw(path.join(notebookPath("Nb"), "_assets", "deleted", "old.png"), "png");
  // A LaTeX project missing an include and a figure.
  await file("Nb/paper/main.tex", "\\documentclass{article}\n\\begin{document}\n\\input{chapters/one}\n\\includegraphics{missing-figure}\n\\end{document}\n");
  // Records pointing at missing files, and a reference attached to one.
  await setStarredFilePath("Nb/lost.md", true);
  await setFileTagsForPath("Nb/lost.md", ["x"]);
  await writeReferenceLibrary("Nb", [{ key: "smith2020", attachments: ["Nb/papers/smith.pdf"] }]);
  // A prepared copy a migration left behind.
  await raw(path.join(notebookPath("Nb"), ".libera-migrating-0000-1"), "copy");

  const before = await snapshot(getAdminRoot());
  const report = await verifyNotebook("Nb");
  assert.deepEqual(await snapshot(getAdminRoot()), before, "the check reads only");

  assert.deepEqual(of(report, "sidecars").filter((finding) => finding.severity === "warning").map((finding) => finding.path).sort(), ["Nb/gone.m4a", "Nb/gone.pdf"]);
  assert.ok(of(report, "sidecars").some((finding) => finding.severity === "error" && finding.path === "Nb/kept.md"));
  assert.ok(of(report, "assets").some((finding) => finding.severity === "warning" && finding.path === "Nb/_assets/deleted.md/deleted.py"));
  assert.ok(of(report, "assets").some((finding) => finding.severity === "info" && finding.path === "Nb/_assets/deleted/old.png"));
  assert.equal(of(report, "images").filter((finding) => finding.severity === "error").length, 2);
  assert.deepEqual(of(report, "links").map((finding) => finding.message), ['The link "nowhere.md" finds no file.']);
  assert.deepEqual(of(report, "latex").map((finding) => finding.message).sort(), ['includes "chapters/one.tex", which is not found.', 'shows "missing-figure", which is not found.']);
  assert.deepEqual(of(report, "records").map((finding) => finding.message).sort(), ["Has tags, but the file is missing.", "Starred, but the file is missing."]);
  assert.ok(of(report, "references").some((finding) => finding.path === "Nb/papers/smith.pdf"));
  assert.ok(of(report, "migrations").some((finding) => finding.path === "Nb/.libera-migrating-0000-1"));
}));

test("a notebook that is not connected, or not a notebook, is refused", () => withLibrary(async () => {
  await assert.rejects(verifyNotebook("Missing"), /not found/);
  await assert.rejects(verifyNotebook(".libera"), /not a notebook/);
}));

test("a reference library the app can't read is reported, not read loosely", () => withLibrary(async () => {
  await raw(path.join(notebookPath("Nb"), ".libera", "references", "library.json"), JSON.stringify({ version: 1, revision: 1, entries: {} }));
  const report = await verifyNotebook("Nb");
  assert.ok(of(report, "references").some((finding) => finding.severity === "error" && /can't be read/.test(finding.message)));
}));

test("a folder that can't be read makes a check partial, never a missing file", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => withLibrary(async () => {
  await file("Nb/pics/fig.png", Buffer.from("png"));
  await file("Nb/n.md", "![](/api/files/raw/Nb/pics/fig.png)\n");
  const locked = path.join(notebookPath("Nb"), "pics");
  await chmod(locked, 0o000);
  let report: IntegrityReport;
  try { report = await verifyNotebook("Nb"); }
  finally { await chmod(locked, 0o755); }
  assert.deepEqual(of(report, "images"), [], "an image that could not be checked is not reported missing");
  assert.equal(report.checks.find((check) => check.id === "images")?.status, "incomplete");
}));

test("budgets make a check partial, and a cancelled check stops between reads", () => withLibrary(async () => {
  for (let index = 0; index < 5; index += 1) await file(`Nb/n${index}.md`, `[gone](nowhere-${index}.md)\n`);
  const progress: string[] = [];
  const bounded = await verifyNotebook("Nb", { limits: { bytes: 20, findings: 2 }, onProgress: (step) => progress.push(step.check) });
  assert.equal(bounded.completeness, "partial");
  assert.ok(bounded.findings.length <= 2);
  assert.equal(bounded.checks.find((check) => check.id === "links")?.status, "incomplete");
  assert.ok(progress.includes("links") && progress.length === bounded.checks.length, "each check reports its start");
  assert.equal((await verifyNotebook("Nb")).completeness, "complete");

  const stop = new AbortController();
  const cancelled = await verifyNotebook("Nb", { signal: stop.signal, onProgress: (step) => { if (step.check === "assets") stop.abort(); } });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.completeness, "partial");
  assert.ok(!cancelled.checks.some((check) => check.id === "links"), "no check runs after the cancel");
}));

// node:sqlite, as search/database.ts loads it (this Node's type declarations predate it).
type Sqlite = { DatabaseSync: new (file: string) => { exec(sql: string): void; prepare(sql: string): { run(...values: unknown[]): unknown }; close(): void } };
const { DatabaseSync } = createRequire(__filename)("node:sqlite") as Sqlite;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const ink = (author: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ...emptyInkAuthorFile({ key: author }, { unit: "pt", width: 100, height: 100 }), ...extra });
const messages = (report: IntegrityReport, check: string) => of(report, check).map((finding) => `${finding.severity}: ${finding.message}`);

test("each owner's reading: records it drops, unreadable ink, side files made for another version, stale caches", () => withLibrary(async () => {
  await file("Nb/p.pdf", "%PDF-1");
  // An annotation the viewer can't read, a newer Libera's kind (kept), a comment without its place.
  await raw(pdfAnnotationsPath("Nb", ["p.pdf"]), JSON.stringify({ annotations: [{ type: "highlight" }, { id: "x", type: "future-kind" }], comments: [{}], source: { size: 99, contentHash: "a".repeat(64) } }));
  const folder = inkFolderPath("Nb", ["p.pdf"]);
  await raw(path.join(folder, "page-0001.abcdef.ink"), ink("abcdef", { strokes: [{ id: "s1" }], source: { size: 6, sha256: sha256("%PDF-1") } }));
  await raw(path.join(folder, "page-0002.abcdef.ink"), "{ half-synced");
  await raw(path.join(folder, "page-0003.ghijkl.ink"), ink("abcdef"));
  await raw(path.join(folder, "text.abcdef.ink"), ink("abcdef"));
  await raw(path.join(folder, "notes.txt"), "not ink");
  await raw(pdfTextCachePath("Nb", ["p.pdf"]), JSON.stringify({ version: 3, pdfContentHash: "x", pageCount: 1, pdfSize: 5, pages: [{ pageNumber: 1, text: "" }] }));
  await file("Nb/m.m4a", "audio");
  await raw(transcriptPath("Nb", ["m.m4a"]), JSON.stringify({ version: 1, audio: { size: 5, duration: 60 }, speakers: [], segments: [{ text: "kept", start: 0, end: 1 }, { start: 2 }] }));
  await raw(audioPeaksPath("Nb", ["m.m4a"]), JSON.stringify({ key: "5:1:2:3:4:x\0h", duration: 60, peaks: [0, "loud"] }));

  const report = await verifyNotebook("Nb");
  assert.deepEqual(messages(report, "sidecars").sort(), [
    "error: 2 ink files of Nb/p.pdf can't be read, so their ink is not shown (page-0002.abcdef.ink, page-0003.ghijkl.ink).",
    "info: 1 PDF text cache is out of date or can't be read; it is made again when needed.",
    "info: 1 ink file of Nb/p.pdf belongs to a page or block this kind of file doesn't have, so it is never shown.",
    "info: 1 waveform is out of date or can't be read; it is made again when needed.",
    "info: The pdf annotations of Nb/p.pdf was saved for another version of the file (its size differs), so it may no longer match it.",
    "warning: 1 stroke in the ink of Nb/p.pdf can't be read and is not shown.",
    "warning: 1 transcript segments in the saved transcript of Nb/m.m4a can't be read: they are not shown, and are lost the next time it is saved.",
    "warning: 2 annotations or comments in the saved pdf annotations of Nb/p.pdf can't be read: they are not shown, and are lost the next time it is saved.",
  ]);
}));

test("what links ask of their files: headings, annotations, moments, saved places; reference links and HTML images", () => withLibrary(async () => {
  await file("Nb/a.md", "# Intro\n\n## Results\n");
  await file("Nb/p.pdf", "%PDF-1");
  await raw(pdfAnnotationsPath("Nb", ["p.pdf"]), JSON.stringify({ annotations: [] }));
  await file("Nb/m.m4a", "audio");
  await raw(transcriptPath("Nb", ["m.m4a"]), JSON.stringify({ version: 1, audio: { size: 5, duration: 60 }, speakers: [], segments: [] }));
  const annotation = createMarkdownFileLinkDestination({ sourcePath: "Nb/b.md", targetPath: "Nb/p.pdf", metadata: { v: 1, fileType: "pdf", viewState: { pdf: { selectedAnnotationId: "gone" } } } });
  await file("Nb/b.md", [
    "[ok](a.md#results) [heading text](a.md#Intro) [bad](a.md#methods)",
    "[here](#nowhere) [there](#there) <a id=\"there\"></a>",
    `[mark](${annotation}) [place](p.pdf#libera=not-json)`,
    "[soon](m.m4a#t=30) [late](m.m4a#t=2:00)",
    "[ref][r]",
    "",
    "[r]: gone.md",
    "",
    "<img src=\"/api/files/raw/Nb/missing.png\">",
    "",
  ].join("\n"));

  const report = await verifyNotebook("Nb");
  assert.deepEqual(messages(report, "links").sort(), [
    'warning: The link "#nowhere" finds no heading in this note.',
    'warning: The link "a.md#methods" finds no heading "methods" in Nb/a.md; it opens the file at its start.',
    'warning: The link "gone.md" finds no file.',
    'warning: The link "m.m4a#t=2:00" points at 2:00, past the end of Nb/m.m4a (1:00).',
    'warning: The link "p.pdf#libera=not-json" keeps a place in Nb/p.pdf that can\'t be read; it opens the file at its start.',
    `warning: The link "${annotation}" points at an annotation of Nb/p.pdf that is no longer there; it opens the file at its start.`,
  ].sort());
  assert.deepEqual(messages(report, "images"), ["error: Shows Nb/missing.png, which is missing."]);
}));

test("derived indexes are compared with what they index", () => withLibrary(async () => {
  await file("Nb/a.md", "A\n");
  await file("Nb/b.md", "B\n");
  await raw(linkIndexPath("Nb"), JSON.stringify({ version: 2, files: { "Nb/a.md": { contentHash: "0", destinations: [] }, "Nb/b.md": { contentHash: sha256("B\n"), destinations: [] } } }));
  await raw(citationIndexPath("Nb"), JSON.stringify({ version: 4, files: { "Nb/a.md": { contentHash: sha256("A\n"), keys: [] }, "Nb/gone.tex": { contentHash: "0", keys: [] } } }));
  await writeReferenceLibrary("Nb", [{ key: "smith2020", attachments: [] }], { bibMirror: true });
  const database = searchIndexFile();
  await mkdir(path.dirname(database), { recursive: true });
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE files (path TEXT, source TEXT, notebook TEXT)");
  db.prepare("INSERT INTO files VALUES (?, 'library', 'Nb'), (?, 'library', 'Nb')").run("Nb/a.md", "Nb/gone.md");
  db.close();
  const before = await readdir(path.dirname(database));

  const report = await verifyNotebook("Nb");
  assert.deepEqual(messages(report, "indexes").sort(), [
    "info: Global Search still lists 1 file no longer in the notebook; it catches up the next time it runs.",
    "info: The .bib mirror is on, but references.bib is not written yet.",
    "info: The citation index is out of date for 2 files; it is brought up to date the next time citations are listed.",
    "info: The link index is out of date for 1 note, so links to a file and related notebooks may be off until the notebook is next opened.",
  ]);
  assert.deepEqual(await readdir(path.dirname(database)), before, "the search index is read without a journal or shared memory file");
}));

test("side files of a file moved outside the app name the file they will follow", () => withLibrary(async () => {
  await file("Nb/moved/new.pdf", "%PDF-new");
  await raw(pdfAnnotationsPath("Nb", ["old.pdf"]), JSON.stringify({ annotations: [], source: { size: 8, contentHash: sha256("%PDF-new") } }));
  await raw(pdfAnnotationsPath("Nb", ["lost.pdf"]), JSON.stringify({ annotations: [], source: { size: 9, contentHash: sha256("%PDF-lost") } }));
  await file("Nb/back.pdf", "%PDF-back");
  await raw(path.join(inkFolderPath("Nb", ["drawn.pdf"]), "page-0001.abcdef.ink"), ink("abcdef", { source: { size: 9, sha256: sha256("%PDF-back") } }));
  await raw(path.join(orphanedSidecarsDirectoryPath("Nb", "outline"), "1-x.json"), JSON.stringify({ kind: "outline", originalPath: "Nb/older.pdf", orphanedAt: new Date().toISOString(), source: { size: 9, contentHash: sha256("%PDF-back") }, sidecar: {} }));

  const report = await verifyNotebook("Nb");
  assert.deepEqual(messages(report, "sidecars").sort(), [
    "info: Saved ink of Nb/drawn.pdf, which is not in the notebook, belong to Nb/back.pdf: the same file, moved outside the app. They go to it the next time the notebook is opened.",
    "info: Saved pdf annotations of Nb/old.pdf, which is not in the notebook, belong to Nb/moved/new.pdf: the same file, moved outside the app. They go to it the next time the notebook is opened.",
    "info: Saved pdf outline set aside when Nb/older.pdf left the notebook belong to Nb/back.pdf, the same file. They go to it the next time the notebook is opened.",
    "warning: Saved pdf annotations of Nb/lost.pdf, which is not in the notebook.",
  ]);
}));

test("the check calls nothing that writes, linked folders included", () => withLibrary(async () => {
  await seedNotebook("Nb");
  await file("Nb/notes/links.md", "[a](../papers/a.pdf) [h](n.md#nowhere) [t](../audio/memo.m4a#t=5)\n");
  await raw(path.join(inkFolderPath("Nb", ["papers", "a.pdf"]), "page-0001.abcdef.ink"), ink("abcdef"));
  await raw(linkIndexPath("Nb"), JSON.stringify({ version: 2, files: {} }));
  await raw(citationIndexPath("Nb"), JSON.stringify({ version: 4, files: {} }));
  await writeReferenceLibrary("Nb", [{ key: "smith2020", attachments: ["Nb/papers/a.pdf"] }], { bibMirror: true });
  // A linked folder in an older state file, without its identity marker:
  // reading it as the app does rewrites the state and writes the marker.
  const project = await mkdtemp(path.join(os.tmpdir(), "libera-linked-"));
  await writeFile(path.join(project, "readme.md"), "# Project\n");
  await raw(directoryModeStatePath(getAdminRoot()), JSON.stringify({ version: 1, current: project, recent: [project] }));

  const calls: string[] = [];
  const refuse = (name: string) => () => { calls.push(name); throw Object.assign(new Error(`${name} during a check`), { code: "EPERM" }); };
  const writes = (flags: unknown) => typeof flags === "number"
    ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC)) !== 0
    : /[wa+]/.test(String(flags ?? "r"));
  for (const name of ["writeFile", "appendFile", "mkdir", "mkdtemp", "rm", "rmdir", "unlink", "rename", "copyFile", "cp", "link", "symlink", "truncate", "utimes", "chmod", "chown", "lchown"] as const) mock.method(fsp, name, refuse(name));
  for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "mkdtempSync", "rmSync", "rmdirSync", "unlinkSync", "renameSync", "copyFileSync", "cpSync", "linkSync", "symlinkSync", "truncateSync", "utimesSync", "chmodSync", "writeSync", "createWriteStream"] as const) mock.method(fs, name, refuse(name));
  const open = fsp.open;
  mock.method(fsp, "open", (target: fs.PathLike, flags?: string | number, ...rest: unknown[]) => { if (writes(flags)) calls.push(`open ${String(flags)}`); return open(target, flags, ...(rest as [])); });
  const openSync = fs.openSync;
  mock.method(fs, "openSync", (target: fs.PathLike, flags?: fs.OpenMode, ...rest: unknown[]) => { if (writes(flags)) calls.push(`openSync ${String(flags)}`); return openSync(target, flags ?? "r", ...(rest as [])); });
  let reports: IntegrityReport[];
  try {
    reports = [await verifyNotebook("Nb"), await verifyNotebook(path.basename(project))];
  } finally {
    mock.restoreAll();
  }
  try {
    assert.deepEqual(calls, []);
    assert.deepEqual(await readdir(project), ["readme.md"], "no identity marker in the linked folder");
    assert.ok(reports.every((report) => !report.checks.some((check) => check.status === "failed")), JSON.stringify(reports.map((report) => report.checks)));
    assert.equal(reports[1].counts.notes, 1);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}));

// ---- What is an ink folder, what is people's work, exact names, LaTeX, stores, indexes, charts

const AAAA = "aaaaaaaaaa";

test("a stray file in a folder of ink folders does not make it one file's ink folder", () => withLibrary(async () => {
  await file("Nb/old/a.pdf", "%PDF-a");
  await file("Nb/old/b.pdf", "%PDF-b");
  await raw(path.join(inkFolderPath("Nb", ["old", "a.pdf"]), `page-0001.${AAAA}.ink`), ink(AAAA));
  await raw(path.join(inkFolderPath("Nb", ["old", "b.pdf"]), `page-0001.${AAAA}.ink`), ink(AAAA));
  // A sync conflict copy and system files beside the two ink folders.
  await raw(path.join(inkFolderPath("Nb", ["old"]), "conflict (1).txt"), "stray");
  await raw(path.join(inkFolderPath("Nb", ["old"]), ".DS_Store"), "x");
  await raw(path.join(inkFolderPath("Nb", ["old"]), `page-0001.${AAAA}.ink.sync-conflict`), "{}");

  assert.deepEqual((await listSidecars("Nb")).sidecars.filter((sidecar) => sidecar.kind === "ink").map((sidecar) => sidecar.filePath).sort(), ["Nb/old/a.pdf", "Nb/old/b.pdf"]);
  assert.deepEqual(of(await verifyNotebook("Nb"), "sidecars"), [], "no 'Saved ink of Nb/old', and the ink of both PDFs is found");
}));

test("a size mismatch clears only what can be made again: not annotations, not ink drawn on the current version", () => withLibrary(async () => {
  await file("Nb/p.pdf", "%PDF-1");
  await raw(pdfAnnotationsPath("Nb", ["p.pdf"]), JSON.stringify({ annotations: [], comments: [], source: { size: 99, contentHash: "a".repeat(64) } }));
  const folder = inkFolderPath("Nb", ["p.pdf"]);
  await raw(path.join(folder, `page-0001.${AAAA}.ink`), ink(AAAA, { source: { size: 6, sha256: sha256("%PDF-1") } }));
  await raw(path.join(folder, `page-0002.${AAAA}.ink`), ink(AAAA, { source: { size: 99, sha256: "b".repeat(64) } }));
  await file("Nb/m.m4a", "audio!!");
  await raw(transcriptPath("Nb", ["m.m4a"]), JSON.stringify({ version: 1, audio: { size: 5, duration: 60 }, speakers: [], segments: [] }));

  const findings = of(await verifyNotebook("Nb"), "sidecars");
  const at = (target: string, text: string) => findings.find((finding) => finding.path === target && finding.message.includes(text))!;
  assert.equal(at("Nb/p.pdf", "pdf annotations").clear, undefined, "annotations are people's work");
  assert.deepEqual(at("Nb/p.pdf", "ink file").clear, [{ type: "ink-files", filePath: "Nb/p.pdf", names: [`page-0002.${AAAA}.ink`] }]);
  assert.match(at("Nb/p.pdf", "ink file").message, /^1 ink file of Nb\/p\.pdf was drawn on another version/);
  assert.deepEqual(at("Nb/m.m4a", "transcript").clear, [{ type: "side-file", kind: "transcript", filePath: "Nb/m.m4a" }]);
}));

test("existence is exact: a case-only rename loses stars and links, as it does in the app", () => withLibrary(async () => {
  await file("Nb/paper.pdf", "%PDF");
  await file("Nb/docs/a.md", "# A\n");
  await setStarredFilePath("Nb/Paper.pdf", true);
  await setFileTagsForPath("Nb/Docs/a.md", ["x"]);
  await file("Nb/n.md", "[wrong](Paper.pdf) [right](paper.pdf) [folder](Docs/a.md) [ok](docs/a.md)\n");
  const report = await verifyNotebook("Nb");
  assert.deepEqual(messages(report, "records").sort(), ["warning: Has tags, but the file is missing.", "warning: Starred, but the file is missing."]);
  assert.deepEqual(of(report, "records").map((finding) => finding.path).sort(), ["Nb/Docs/a.md", "Nb/Paper.pdf"]);
  assert.deepEqual(messages(report, "links").sort(), ['warning: The link "Docs/a.md" finds no file.', 'warning: The link "Paper.pdf" finds no file.']);
}));

test("LaTeX: names that need macros are counted, not missing; dotted names get their extensions; pdfpages and listings are read", () => withLibrary(async () => {
  await file("Nb/paper/main.tex", [
    "\\documentclass{article}",
    "\\newcommand{\\fig}[1]{\\includegraphics{figs/#1}}",
    "\\begin{document}",
    "\\includegraphics{\\figdir/a}",
    "\\input{\\jobname.extra}",
    "\\includegraphics{figs/plot.v2}",
    "\\includegraphics{figs/lost.v3}",
    "\\input{chap.final}",
    "\\includepdf[pages={1-2}]{scan}",
    "\\includepdf{lost-scan.pdf}",
    "\\lstinputlisting[language=C]{code/there.c}",
    "\\lstinputlisting{code/missing.c}",
    "\\end{document}",
    "",
  ].join("\n"));
  await file("Nb/paper/figs/plot.v2.pdf", "pdf");
  await file("Nb/paper/chap.final.tex", "Chapter.\n");
  await file("Nb/paper/scan.pdf", "%PDF");
  await file("Nb/paper/code/there.c", "int main;");
  const report = await verifyNotebook("Nb");
  assert.deepEqual(messages(report, "latex").sort(), [
    'error: includes "code/missing.c", which is not found.',
    'error: includes "lost-scan.pdf", which is not found.',
    'error: shows "figs/lost.v3", which is not found.',
  ]);
  const latex = report.checks.find((check) => check.id === "latex")!;
  assert.equal(latex.status, "incomplete");
  assert.match(latex.note ?? "", /3 LaTeX references use a macro/);
  assert.equal(report.completeness, "partial");
}));

test("a tether to a drive that is not connected is a warning to keep; a missing file in a present folder can be forgotten", () => withLibrary(async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "libera-bib-"));
  try {
    const bib = path.join(outside, "refs.bib");
    await writeFile(bib, "@article{a, title={A}}\n");
    await tetherBibFile("Nb", bib, { prefer: "library" });
    resetBibTethers();
    await rm(bib);
    const present = of(await verifyNotebook("Nb"), "references");
    assert.equal(present.length, 1);
    assert.deepEqual(present[0].clear, [{ type: "tether", target: bib }]);
    await rm(outside, { recursive: true, force: true });
    const offline = of(await verifyNotebook("Nb"), "references");
    assert.equal(offline.length, 1);
    assert.match(offline[0].message, /may be on a drive that is not connected/);
    assert.equal(offline[0].clear, undefined);
  } finally { await rm(outside, { recursive: true, force: true }); }
}));

test("a damaged workspace file, and review documents that are not on disk, are reported", () => withLibrary(async () => {
  await file("Nb/a.md", "A\n");
  await raw(workspaceMetadataPath(), "{ broken");
  await raw(path.join(reviewsDirectory(getStateRoot()), "index.json"), JSON.stringify({ schemaVersion: 2, documents: { r1: "Nb/a.md", r2: "Nb/gone.md", r3: "Other/x.md" } }));
  const report = await verifyNotebook("Nb");
  const lines = messages(report, "records").sort();
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^error: The file that keeps stars, tags and notebook groups can't be read/);
  assert.equal(lines[1], "warning: The review comments of Nb/a.md are not on this computer: they may not have synced yet, or are lost.");
  assert.equal(lines[2], "warning: The review comments of Nb/gone.md are not on this computer: they may not have synced yet, or are lost.");
  assert.ok(of(report, "records").every((finding) => !finding.clear), "nothing here is offered for removal");
  await rm(workspaceMetadataPath());
  assert.deepEqual(messages(await verifyNotebook("Nb"), "records").filter((line) => line.startsWith("error:")), [], "a missing workspace file is fine");
}));

test("indexes: LaTeX entries are compared by hash, and a note with invalid UTF-8 matches its raw bytes", () => withLibrary(async () => {
  await file("Nb/a.tex", "\\documentclass{article}\n");
  await file("Nb/b.tex", "\\documentclass{book}\n");
  await raw(citationIndexPath("Nb"), JSON.stringify({ version: 4, files: { "Nb/a.tex": { contentHash: sha256("\\documentclass{article}\n"), keys: [] }, "Nb/b.tex": { contentHash: "0", keys: [] } } }));
  assert.deepEqual(messages(await verifyNotebook("Nb"), "indexes"), ["info: The citation index is out of date for 1 file; it is brought up to date the next time citations are listed."]);

  const bytes = Buffer.from([0x41, 0xff, 0x42, 0x0a]);
  await file("Nb/bad.md", bytes);
  await rm(citationIndexPath("Nb"));
  await raw(linkIndexPath("Nb"), JSON.stringify({ version: 2, files: { "Nb/bad.md": { contentHash: createHash("sha256").update(bytes).digest("hex"), destinations: [] } } }));
  assert.deepEqual(messages(await verifyNotebook("Nb"), "indexes"), [], "the index hashes bytes, and so does the check");
}));

test("a chart's data file is checked as a link is: missing, or present only in another case, is a warning", () => withLibrary(async () => {
  await file("Nb/sales.csv", "q,v\nQ1,1\n");
  await file("Nb/docs/sales.csv", "q,v\nQ1,1\n");
  await file("Nb/docs/c.md", [
    "```chart", "type: bar", "data: ../sales.csv", "```", "",
    "```chart", "type: bar", "data: Sales.csv", "```", "",
    "```chart", "type: bar", "data: gone.csv", "```", "",
    "```chart", "type: bar", "labels: [a]", "series: [1]", "```", "",
  ].join("\n"));
  assert.deepEqual(messages(await verifyNotebook("Nb"), "links").sort(), [
    'warning: The chart at line 11 reads its data from "gone.csv", which is missing.',
    'warning: The chart at line 6 reads its data from "Sales.csv", which is missing.',
  ]);
}));
