import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { inkFileName } from "../../src/lib/ink/authors";
import { emptyInkAuthorFile } from "../../src/lib/ink/codec";
import { writePdfAnnotations } from "../../src/lib/storage/annotations";
import { applyNotebookCleanup, planNotebookCleanup } from "../../src/lib/storage/cleanup";
import { inkFolderPath, reconcileInkFolders } from "../../src/lib/storage/ink";
import { verifyNotebook, type IntegrityFinding } from "../../src/lib/storage/integrity";
import { cachedPdfIdentity } from "../../src/lib/storage/pdf-identity";
import { ORPHAN_GRACE_MS, ORPHAN_RETENTION_MS, readOrphans, reconcilePdfSidecars } from "../../src/lib/storage/pdf-sidecars";
import { filePathFromParts, notebookPath, pdfAnnotationsPath } from "../../src/lib/storage/paths";
import { readReferenceLibrary, reattachMissingReferenceFiles, updateReferenceLibrary } from "../../src/lib/storage/references";
import { applyNotebookRepair, planNotebookRepair } from "../../src/lib/storage/repair";
import { getTree } from "../../src/lib/storage/tree";
import { setFileTagsForPath, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";
import type { ReferenceAttachment } from "../../src/lib/references/types";
import { writeAt, writeLibraryFile, withTemporaryLibrary } from "./notebook-test-helpers";

// Check Notebook is the oracle: every automatic step (the tree's upkeep, the
// reattachment of references, Try to fix, Acknowledge) is run, and the check
// afterwards must report exactly what the step's own result says is left, and
// before it exactly what the step then does. Each case here is a place where
// the step and the check once used rules of their own.

const BYTES = "%PDF-1.4 oracle bytes";
const OTHER = "%PDF-1.4 someone else";
const FRAME = { unit: "pt" as const, width: 100, height: 100 };
const AUTHOR = "aaaaaaaaaa";
const note = (text: string) => [{ type: "text", id: text, pageNumber: 1, text, rect: { x: 0, y: 0, width: 0.1, height: 0.1 } }];
/** Past the minute the upkeep waits between scans of set-aside records. */
const LATER = (ms = 120_000) => Date.now() + ms;

const absolute = (relative: string) => { const [notebook, ...parts] = relative.split("/"); return filePathFromParts(notebook, parts); };
const identityOf = (relative: string) => cachedPdfIdentity(absolute(relative));
const sizeOf = (bytes: string) => Buffer.byteLength(bytes);

/** What Finder does: the file moves, nothing else. */
async function finderMove(from: string, to: string) {
  await mkdir(path.dirname(absolute(to)), { recursive: true });
  await rename(absolute(from), absolute(to));
}

/** The check's findings, all severities, as text; the index lag the tree's own load clears is not part of what a step leaves. */
async function reported(notebook: string) {
  const report = await verifyNotebook(notebook);
  return report.findings.filter((finding) => finding.check !== "indexes");
}
const text = (findings: IntegrityFinding[]) => findings.map((finding) => `${finding.severity} ${finding.check}: ${finding.path}: ${finding.message}`).sort();

async function seedInk(relative: string, source: { size: number; sha256: string }) {
  const [notebook, ...parts] = relative.split("/");
  const folder = inkFolderPath(notebook, parts);
  await writeAt(path.join(folder, inkFileName("page-0001", AUTHOR)), JSON.stringify(emptyInkAuthorFile({ key: AUTHOR }, FRAME, source)));
  return folder;
}
const inkSourceOf = async (relative: string) => { const found = await identityOf(relative); return { size: found.size, sha256: found.contentHash }; };

test("upkeep reattaching a PDF's annotations and ink after an outside move: predicted by the check, nothing left after", () => withTemporaryLibrary(["Up"], async () => {
  await writeLibraryFile("Up/old.pdf", BYTES);
  await writePdfAnnotations("Up/old.pdf", note("mine"));
  await seedInk("Up/old.pdf", await inkSourceOf("Up/old.pdf"));
  assert.deepEqual(text(await reported("Up")), [], "sound before the move");

  await finderMove("Up/old.pdf", "Up/deep/new.pdf");
  const before = await reported("Up");
  // The check says where each goes: the file with its bytes, the same one for both.
  assert.deepEqual(before.filter((finding) => finding.code === "orphanSideFileMoved").map((finding) => finding.params?.moved), ["Up/deep/new.pdf", "Up/deep/new.pdf"]);

  const files = [{ path: "Up/deep/new.pdf", size: sizeOf(BYTES) }];
  const pdf = await reconcilePdfSidecars("Up", files, { now: LATER() });
  const ink = await reconcileInkFolders("Up", files, { now: LATER() });
  assert.deepEqual([pdf, ink], [{ reattached: 1, setAside: 0 }, { reattached: 1, setAside: 0 }]);
  assert.deepEqual(text(await reported("Up")), [], "everything it reattached is where the check wants it");
}));

test("upkeep setting aside: the check lists exactly what was set aside, and keeps it", () => withTemporaryLibrary(["Aside"], async () => {
  await writeLibraryFile("Aside/gone.pdf", BYTES);
  await writePdfAnnotations("Aside/gone.pdf", note("mine"));
  await rm(absolute("Aside/gone.pdf"));
  const files: Array<{ path: string; size: number }> = [];

  const start = LATER();
  assert.deepEqual(await reconcilePdfSidecars("Aside", files, { now: start }), { reattached: 0, setAside: 0 }, "not before the grace");
  assert.equal((await reported("Aside")).filter((finding) => finding.code === "orphanSideFile").length, 1, "until then the check lists the side file as one of a file that is gone");
  const result = await reconcilePdfSidecars("Aside", files, { now: start + ORPHAN_GRACE_MS + 1 });
  assert.equal(result.setAside, 1);

  const after = await reported("Aside");
  assert.deepEqual(after.map((finding) => [finding.code, finding.params?.count]), [["sideFilesKept", result.setAside]], "only what was set aside, counted as the step counted it");
  assert.ok(!existsSync(pdfAnnotationsPath("Aside", ["gone.pdf"])));
}));

test("set-aside work whose owner may be back is kept by the upkeep's expiry and not offered by the check; with no owner, both let it go", () => withTemporaryLibrary(["Exp"], async () => {
  await writeLibraryFile("Exp/gone.pdf", BYTES);
  await writePdfAnnotations("Exp/gone.pdf", note("mine"));
  await rm(absolute("Exp/gone.pdf"));
  const start = LATER();
  await reconcilePdfSidecars("Exp", [], { now: start });
  await reconcilePdfSidecars("Exp", [], { now: start + ORPHAN_GRACE_MS + 1 });
  assert.equal((await readOrphans("Exp")).length, 1);

  // Its bytes are back in a file that already has annotations of its own: the slot is taken, so nothing is reattached.
  await writeLibraryFile("Exp/back.pdf", BYTES);
  await writePdfAnnotations("Exp/back.pdf", note("its own"));
  const files = [{ path: "Exp/back.pdf", size: sizeOf(BYTES) }];
  const clears = async () => (await reported("Exp")).flatMap((finding) => finding.clear ?? []).filter((action) => action.type === "set-aside");
  assert.deepEqual(await clears(), [], "the check does not offer work whose owner may be back");
  const expired = start + ORPHAN_RETENTION_MS + 2 * ORPHAN_GRACE_MS;
  await reconcilePdfSidecars("Exp", files, { now: expired });
  assert.equal((await readOrphans("Exp")).length, 1, "and the expiry keeps it");

  // Nothing with its bytes is left anywhere: offered, and expired.
  await rm(absolute("Exp/back.pdf"));
  assert.equal((await clears()).length, 1);
  await reconcilePdfSidecars("Exp", [], { now: expired + 120_000 });
  assert.equal((await readOrphans("Exp")).length, 0);
  assert.deepEqual(text(await reported("Exp")).filter((line) => /set aside|kept for files/.test(line)), []);
}));

test("case variant: the check predicts a reattachment exactly when the upkeep makes it, by the file system's own slot rule", () => withTemporaryLibrary(["Cv"], async () => {
  await writeLibraryFile("Cv/Foo.pdf", BYTES);
  await writePdfAnnotations("Cv/Foo.pdf", note("mine"));
  // A case-only rename: the exact name `Foo.pdf` is gone and `foo.pdf` is a file. Where the disk ignores case, its slot is the one the notes already occupy.
  await rename(absolute("Cv/Foo.pdf"), absolute("Cv/tmp.pdf"));
  await rename(absolute("Cv/tmp.pdf"), absolute("Cv/foo.pdf"));
  const before = await reported("Cv");
  const predicted = before.some((finding) => finding.code === "orphanSideFileMoved");
  assert.ok(before.some((finding) => finding.code === "orphanSideFileMoved" || finding.code === "orphanSideFile"), "the check says something about the notes of Foo.pdf");

  const result = await reconcilePdfSidecars("Cv", [{ path: "Cv/foo.pdf", size: sizeOf(BYTES) }], { now: LATER() });
  assert.equal(result.reattached, predicted ? 1 : 0, "the step does what the check said");
  assert.equal(result.setAside, 0);
  if (predicted) assert.deepEqual(text(await reported("Cv")), []);
  else assert.deepEqual(text(await reported("Cv")), text(before), "nothing was changed, and nothing new is reported");
}));

test("archive: a file moved into the hidden archive is where the check and the upkeep both look, and a second copy stops both", () => withTemporaryLibrary(["Ar"], async () => {
  await writeLibraryFile("Ar/a.pdf", BYTES);
  await writePdfAnnotations("Ar/a.pdf", note("mine"));
  await finderMove("Ar/a.pdf", "Ar/_archive/a.pdf");
  await writeLibraryFile("Ar/copy.pdf", BYTES);

  // Two files have its bytes, one of them archived: neither says so as the moved file.
  assert.ok(!(await reported("Ar")).some((finding) => finding.code === "orphanSideFileMoved"));
  await getTree();
  assert.ok(!existsSync(pdfAnnotationsPath("Ar", ["copy.pdf"])));
  assert.ok(!existsSync(pdfAnnotationsPath("Ar", ["_archive", "a.pdf"])));

  await rm(absolute("Ar/copy.pdf"));
  assert.deepEqual((await reported("Ar")).filter((finding) => finding.code === "orphanSideFileMoved").map((finding) => finding.params?.moved), ["Ar/_archive/a.pdf"]);
  await getTree();
  assert.ok(existsSync(pdfAnnotationsPath("Ar", ["_archive", "a.pdf"])), "the upkeep gave them to the file the check named");
  assert.deepEqual(text(await reported("Ar")), []);
}));

test("Try to fix: the check names what it fixes, and what is left is what the plan says it left", () => withTemporaryLibrary(["Fix"], async () => {
  await writeLibraryFile("Fix/p/a.pdf", BYTES);
  await writePdfAnnotations("Fix/p/a.pdf", note("a"));
  await setStarredFilePath("Fix/p/a.pdf", true);
  await setFileTagsForPath("Fix/p/a.pdf", ["tag"]);
  // A name shared by two files: not paired, and the check keeps saying so.
  await writeLibraryFile("Fix/p/x.pdf", BYTES);
  await writePdfAnnotations("Fix/p/x.pdf", note("x"));
  await finderMove("Fix/p/a.pdf", "Fix/reading/a.pdf");
  await finderMove("Fix/p/x.pdf", "Fix/q/x.pdf");
  await writeLibraryFile("Fix/r/x.pdf", OTHER);

  const before = await reported("Fix");
  const plan = await planNotebookRepair("Fix");
  assert.deepEqual(plan.moves.map((move) => move.from), ["Fix/p/a.pdf"]);
  assert.deepEqual(plan.unmatched.map((item) => item.from), ["Fix/p/x.pdf"]);
  for (const move of plan.moves) assert.ok(before.some((finding) => finding.path === move.from), `the check lists ${move.from}`);

  // The check's own prediction of the other file: its notes are left, as the plan says.
  const result = await applyNotebookRepair("Fix", plan.token);
  assert.deepEqual(result.problems, []);
  assert.ok(result.outcomes.every((outcome) => outcome.status === "moved"));
  const after = await reported("Fix");
  assert.deepEqual([...new Set(after.map((finding) => finding.path))], plan.unmatched.map((item) => item.from), "exactly the unpaired file's records are left");
}));

test("Acknowledge: what it clears is gone from the check, and what the plan says remains is all the check still reports", () => withTemporaryLibrary(["Ack"], async () => {
  await writeLibraryFile("Ack/gone.pdf", BYTES);
  await writePdfAnnotations("Ack/gone.pdf", note("mine"));
  await seedInk("Ack/gone.pdf", await inkSourceOf("Ack/gone.pdf"));
  await setStarredFilePath("Ack/gone.pdf", true);
  await setFileTagsForPath("Ack/gone.pdf", ["tag"]);
  await rm(absolute("Ack/gone.pdf"));
  await writeLibraryFile("Ack/links.md", "[elsewhere](missing.md)\n");

  const plan = await planNotebookCleanup("Ack");
  assert.ok(plan.items.length > 0);
  assert.equal(plan.remaining, 1);
  const result = await applyNotebookCleanup("Ack", plan.token);
  assert.deepEqual(result.problems, []);
  assert.equal(result.cleared, plan.items.length);
  const after = await reported("Ack");
  assert.equal(after.length, plan.remaining, "exactly what the plan said would remain");
  assert.deepEqual(after.map((finding) => finding.path), ["Ack/links.md"]);
  assert.equal((await readdir(notebookPath("Ack"))).includes("links.md"), true);
}));

async function attach(notebook: string, file: string) {
  const library = await readReferenceLibrary(notebook);
  await updateReferenceLibrary(notebook, library.revision, [{ op: "add", entry: { csl: { type: "book", title: "Paper" }, attachments: [{ kind: "pdf", path: file } as ReferenceAttachment] } }]);
}

test("reference reattachment: an attachment the check calls missing is the one that is re-pointed, a case-only rename included", () => withTemporaryLibrary(["Rf"], async () => {
  await writeLibraryFile("Rf/Paper.pdf", BYTES);
  await attach("Rf", "Rf/Paper.pdf");
  await writeLibraryFile("Rf/moved/other.pdf", OTHER);
  await attach("Rf", "Rf/moved/other.pdf");
  assert.deepEqual(text((await reported("Rf")).filter((finding) => finding.check === "references")), []);

  // One moved to another folder, one renamed in letter case only.
  await finderMove("Rf/moved/other.pdf", "Rf/deep/other.pdf");
  await rename(absolute("Rf/Paper.pdf"), absolute("Rf/tmp.pdf"));
  await rename(absolute("Rf/tmp.pdf"), absolute("Rf/paper.pdf"));
  const missing = (await reported("Rf")).filter((finding) => finding.check === "references").map((finding) => finding.path).sort();
  assert.deepEqual(missing, ["Rf/Paper.pdf", "Rf/moved/other.pdf"]);

  const result = await reattachMissingReferenceFiles("Rf");
  assert.equal(result.missing, missing.length, "it takes for missing what the check does");
  assert.equal(result.reattached, missing.length);
  assert.deepEqual(text((await reported("Rf")).filter((finding) => finding.check === "references")), []);
}));
