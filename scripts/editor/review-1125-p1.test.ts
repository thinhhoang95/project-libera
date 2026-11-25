import assert from "node:assert/strict";
import fsp, { mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import test, { mock } from "node:test";
import { pythonSidecarDocumentPath, pythonSidecarPath } from "../../src/lib/python/sidecar";
import { reconcilePdfSidecars } from "../../src/lib/storage/pdf-sidecars";
import { inkFolderPath, reconcileInkFolders } from "../../src/lib/storage/ink";
import { filePathFromParts, getAdminRoot, orphanedSidecarsDirectoryPath, pdfAnnotationsPath, pdfOutlinePath } from "../../src/lib/storage/paths";
import { planNotebookCleanup } from "../../src/lib/storage/cleanup";
import { applyNotebookRepair, planNotebookRepair, slotOf } from "../../src/lib/storage/repair";
import { legacyPythonSidecarPath } from "../../src/lib/python/sidecar";
import { setStarredFilePath } from "../../src/lib/storage/workspace-metadata";
import { assertNotebookSound, seeded, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

// Review 2026-11-25, package P1 (Try to fix): E-H2, E-M6, and E-M7 as the user decided it.

const exists = (target: string) => stat(target).then(() => true, () => false);
const annotations = JSON.stringify({ version: 2, marks: [{ id: "m1" }] });
const inkFile = (key = "aaaaaaaaaa") => JSON.stringify({ key });

/** A name changed only in letter case, through a temporary name (what Finder or a sync client leaves). */
async function respell(target: string, next: string) {
  const temporary = `${target}.tmp-case`;
  await rename(target, temporary);
  await rename(temporary, next);
}

/** Whether this disk treats names that differ only in case as one. */
async function caseInsensitiveDisk() {
  await writeLibraryFile("Nb/probe/Probe.txt", "x");
  return exists(filePathFromParts("Nb", ["probe", "probe.txt"]));
}

const names = (directory: string) => readdir(directory);

test("E-H2: a parent folder renamed only in case respells the side file's folder too, and the check agrees", () => withTemporaryLibrary(["Nb"], async () => {
  if (!(await caseInsensitiveDisk())) return;
  await writeLibraryFile("Nb/Docs/paper.pdf", "%PDF");
  await writeAt(pdfAnnotationsPath("Nb", ["Docs", "paper.pdf"]), annotations);
  await writeAt(pdfOutlinePath("Nb", ["Docs", "paper.pdf"]), seeded("outline"));
  await writeAt(path.join(inkFolderPath("Nb", ["Docs", "paper.pdf"]), "page.aaaaaaaaaa.ink"), inkFile());
  await respell(filePathFromParts("Nb", ["Docs"]), filePathFromParts("Nb", ["docs"]));

  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves.map((move) => [move.from, move.to]), [["Nb/Docs/paper.pdf", "Nb/docs/paper.pdf"]]);
  const result = await applyNotebookRepair("Nb", plan.token);
  assert.deepEqual(result.problems, []);
  // The folder level that differed was renamed, not only the leaf.
  assert.deepEqual(await names(path.dirname(path.dirname(pdfAnnotationsPath("Nb", ["docs", "paper.pdf"])))), ["docs"]);
  assert.deepEqual(await names(path.dirname(pdfAnnotationsPath("Nb", ["docs", "paper.pdf"]))), ["paper.pdf.json"]);
  assert.deepEqual((await planNotebookRepair("Nb")).moves, [], "nothing left to repair");
  await assertNotebookSound("Nb");
}));

test("E-H2: a note renamed in case keeps its Python code where pythonSidecarDocumentPath expects it", () => withTemporaryLibrary(["Nb"], async () => {
  if (!(await caseInsensitiveDisk())) return;
  await writeLibraryFile("Nb/Docs/Note.md", "# Note\n");
  // A record that has to be paired (the code alone is not listed as unused under a spelling of its note's name).
  await setStarredFilePath("Nb/Docs/Note.md", true);
  const code = path.join(getAdminRoot(), ...pythonSidecarPath("Nb/Docs/Note.md").split("/"));
  await writeAt(code, "print('hi')\n");
  await respell(filePathFromParts("Nb", ["Docs", "Note.md"]), filePathFromParts("Nb", ["Docs", "note.md"]));
  await respell(filePathFromParts("Nb", ["Docs"]), filePathFromParts("Nb", ["docs"]));

  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.unmatched, []);
  const result = await applyNotebookRepair("Nb", plan.token);
  assert.deepEqual(result.problems, []);
  const wanted = pythonSidecarPath("Nb/docs/note.md").split("/");
  let directory = path.join(getAdminRoot(), wanted[0]);
  for (const segment of wanted.slice(1)) {
    assert.ok((await names(directory)).includes(segment), `${segment} is spelled as the sidecar path expects`);
    directory = path.join(directory, segment);
  }
  assert.equal(pythonSidecarDocumentPath(wanted.join("/")), "Nb/docs/note.md");
  assert.deepEqual((await planNotebookRepair("Nb")).moves, []);
  await assertNotebookSound("Nb");
}));

test("E-H2: both names of one hard-linked side file (a crash between the link and the removal) are 'ours', not 'same'", async () => {
  // A case-sensitive volume can't be made here: the file system is stubbed to show two entries of one inode.
  const folder = path.join(path.sep, "virtual", "by-path");
  const source = path.join(folder, "Paper.pdf.json");
  const destination = path.join(folder, "paper.pdf.json");
  const stat1 = { dev: BigInt(1), ino: BigInt(7), nlink: BigInt(2), isDirectory: () => false };
  const lstat = fsp.lstat;
  const readdir = fsp.readdir;
  mock.method(fsp, "lstat", (async (target: string, options?: unknown) => (target === source || target === destination ? stat1 : lstat(target, options as never))) as typeof fsp.lstat);
  mock.method(fsp, "readdir", (async (target: string, options?: unknown) => (target === folder ? ["Paper.pdf.json", "paper.pdf.json"] : readdir(target, options as never))) as typeof fsp.readdir);
  try {
    assert.equal(await slotOf(source, destination), "ours");
    // One entry under two spellings (nlink 1, or only one spelling listed) is still the file itself.
    mock.method(fsp, "readdir", (async (target: string, options?: unknown) => (target === folder ? ["paper.pdf.json"] : readdir(target, options as never))) as typeof fsp.readdir);
    assert.equal(await slotOf(source, destination), "same");
  } finally {
    mock.restoreAll();
  }
});

test("E-M6: EINVAL from a hard link means links are unavailable: the side file is copied", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a/p.pdf", "%PDF");
  await writeAt(pdfAnnotationsPath("Nb", ["a", "p.pdf"]), annotations);
  await mkdir(filePathFromParts("Nb", ["b"]), { recursive: true });
  await rename(filePathFromParts("Nb", ["a", "p.pdf"]), filePathFromParts("Nb", ["b", "p.pdf"]));
  const plan = await planNotebookRepair("Nb");
  assert.equal(plan.moves.length, 1);
  mock.method(fsp, "link", (async () => { throw Object.assign(new Error("invalid"), { code: "EINVAL" }); }) as typeof fsp.link);
  try {
    const result = await applyNotebookRepair("Nb", plan.token);
    assert.deepEqual(result.problems, []);
  } finally {
    mock.restoreAll();
  }
  assert.ok(await exists(pdfAnnotationsPath("Nb", ["b", "p.pdf"])));
  assert.ok(!(await exists(pdfAnnotationsPath("Nb", ["a", "p.pdf"]))));
  await assertNotebookSound("Nb");
}));

test("E-M6: Windows EPERM/EBUSY on removing the old side file is retried a bounded number of times", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a/p.pdf", "%PDF");
  await writeAt(pdfAnnotationsPath("Nb", ["a", "p.pdf"]), annotations);
  await mkdir(filePathFromParts("Nb", ["b"]), { recursive: true });
  await rename(filePathFromParts("Nb", ["a", "p.pdf"]), filePathFromParts("Nb", ["b", "p.pdf"]));
  const plan = await planNotebookRepair("Nb");
  const rm = fsp.rm;
  let busy = 0;
  mock.method(fsp, "rm", (async (target: string, options?: unknown) => {
    if (String(target).endsWith("p.pdf.json") && busy < 2) { busy += 1; throw Object.assign(new Error("busy"), { code: busy === 1 ? "EBUSY" : "EPERM" }); }
    return rm(target, options as never);
  }) as typeof fsp.rm);
  try {
    const result = await applyNotebookRepair("Nb", plan.token);
    assert.deepEqual(result.problems, []);
  } finally {
    mock.restoreAll();
  }
  assert.equal(busy, 2);
  assert.ok(!(await exists(pdfAnnotationsPath("Nb", ["a", "p.pdf"]))));
  assert.ok(await exists(pdfAnnotationsPath("Nb", ["b", "p.pdf"])));
}));

test("E-M6: a file that stays busy is reported, not a crash, and a retry finishes the pair", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a/p.pdf", "%PDF");
  await writeAt(pdfAnnotationsPath("Nb", ["a", "p.pdf"]), annotations);
  await mkdir(filePathFromParts("Nb", ["b"]), { recursive: true });
  await rename(filePathFromParts("Nb", ["a", "p.pdf"]), filePathFromParts("Nb", ["b", "p.pdf"]));
  const plan = await planNotebookRepair("Nb");
  const rm = fsp.rm;
  mock.method(fsp, "rm", (async (target: string, options?: unknown) => {
    if (String(target).endsWith("p.pdf.json")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    return rm(target, options as never);
  }) as typeof fsp.rm);
  try {
    const result = await applyNotebookRepair("Nb", plan.token);
    assert.match(result.problems.join("\n"), /busy/);
  } finally {
    mock.restoreAll();
  }
  // Both links exist: the retry recognises its own earlier try and finishes it.
  const retry = await planNotebookRepair("Nb");
  const done = await applyNotebookRepair("Nb", retry.token);
  assert.deepEqual(done.problems, []);
  assert.ok(!(await exists(pdfAnnotationsPath("Nb", ["a", "p.pdf"]))));
  await assertNotebookSound("Nb");
}));

/** The tree's upkeep after a Finder move: a first load sees the side files orphaned, one 31 s later sets them aside. */
async function upkeep(notebook: string) {
  const now = Date.now();
  for (const at of [now, now + 31_000]) {
    await reconcileInkFolders(notebook, [], { now: at });
    await reconcilePdfSidecars(notebook, [], { now: at });
  }
}

test("E-M6: a set-aside side file is restored atomically (written whole elsewhere, then published exclusively)", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a/p.pdf", "%PDF");
  await writeAt(pdfAnnotationsPath("Nb", ["a", "p.pdf"]), annotations);
  await mkdir(filePathFromParts("Nb", ["b"]), { recursive: true });
  await rename(filePathFromParts("Nb", ["a", "p.pdf"]), filePathFromParts("Nb", ["b", "p.pdf"]));
  await upkeep("Nb");
  const plan = await planNotebookRepair("Nb");
  assert.equal(plan.moves.length, 1);
  const destination = pdfAnnotationsPath("Nb", ["b", "p.pdf"]);
  const writeFileSpy = fsp.writeFile;
  const direct: string[] = [];
  mock.method(fsp, "writeFile", (async (target: string, ...rest: unknown[]) => {
    if (String(target) === destination) direct.push(String(target));
    return (writeFileSpy as (...args: unknown[]) => Promise<void>)(target, ...rest);
  }) as typeof fsp.writeFile);
  try {
    const result = await applyNotebookRepair("Nb", plan.token);
    assert.deepEqual(result.problems, []);
  } finally {
    mock.restoreAll();
  }
  assert.deepEqual(direct, [], "nothing is written at the destination itself, where a reader could see half of it");
  assert.equal(JSON.parse(await readFile(destination, "utf8")).marks[0].id, "m1");
  assert.deepEqual((await readdir(path.dirname(destination))).filter((name) => name.endsWith(".tmp")), []);
}));

test("E-M6: records set aside that can't be read keep the file's records from being paired", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a/p.pdf", "%PDF");
  await writeAt(pdfAnnotationsPath("Nb", ["a", "p.pdf"]), annotations);
  await mkdir(filePathFromParts("Nb", ["b"]), { recursive: true });
  await rename(filePathFromParts("Nb", ["a", "p.pdf"]), filePathFromParts("Nb", ["b", "p.pdf"]));
  // A damaged set-aside record: it could be a second path of the same name.
  await writeAt(path.join(orphanedSidecarsDirectoryPath("Nb", "annotations"), "damaged.json"), "{ not json");
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.unmatched.map((item) => [item.from, item.reason]), [["Nb/a/p.pdf", "unread"]]);
}));

test("E-M6: Python code of the legacy layout that the file found already has is its own", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a/x.md", "# X\n");
  await writeAt(path.join(getAdminRoot(), ...pythonSidecarPath("Nb/a/x.md").split("/")), "print('old')\n");
  await rename(filePathFromParts("Nb", ["a", "x.md"]), filePathFromParts("Nb", ["x.md"]));
  // The note that is there has legacy-layout code of its own.
  const legacy = path.join(getAdminRoot(), ...legacyPythonSidecarPath("Nb/x.md").split("/"));
  await writeAt(legacy, "print('mine')\n");
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.unmatched.map((item) => [item.from, item.reason]), [["Nb/a/x.md", "own"]]);
}));

// E-M7, decided by the user (2026-11-25): Try to fix stays name-based within the notebook. A file moved to another
// notebook is not looked for there; its records are reported like any other whose file is gone, and Acknowledge offers them.
test("E-M7 (decided): records of a file moved to another notebook are not held, nor paired there, and Acknowledge offers them", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  await writeLibraryFile("Nb/a/p.pdf", "%PDF");
  await writeAt(pdfAnnotationsPath("Nb", ["a", "p.pdf"]), annotations);
  await rename(filePathFromParts("Nb", ["a", "p.pdf"]), filePathFromParts("Other", ["p.pdf"]));
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.unmatched.map((item) => [item.from, item.reason, item.candidates]), [["Nb/a/p.pdf", "none", []]]);
  const cleanup = await planNotebookCleanup("Nb");
  assert.ok(cleanup.items.some((item) => item.path === "Nb/a/p.pdf"), `the records are offered: ${JSON.stringify(cleanup.items.map((item) => item.path))}`);
}));
