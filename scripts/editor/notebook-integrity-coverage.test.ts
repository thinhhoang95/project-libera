import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import fsp, { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { mock } from "node:test";
import { withReviewWrite } from "../../src/lib/agent/review-store";
import { verifyNotebook, type IntegrityFinding, type IntegrityProgress } from "../../src/lib/storage/integrity";
import { listInterruptedMigrations, planMigration, resumeMigration, runMigration, setMigrationFaultForTests, type MigrationRequest } from "../../src/lib/storage/migration";
import { definitionsPath, filePathFromParts, getAdminRoot, notebookPath, pdfAnnotationsPath } from "../../src/lib/storage/paths";
import { setFileTagsForPath, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";
import { seeded, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

// The notebook check's blind spots: the migration's final check, an external
// case-only rename, records of notebooks that vanished, and "complete" that
// overstated what was verified.

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const codes = (findings: IntegrityFinding[], check: string) => findings.filter((finding) => finding.check === check).map((finding) => finding.code);

async function planned(request: MigrationRequest) {
  const plan = await planMigration(request);
  assert.deepEqual(plan.blockers, []);
  return plan;
}

// ---- 6: the migration's final check -----------------------------------------

test("the final check is not clean when a moved file is gone from its destination", () => withTemporaryLibrary(["Src", "Dst"], async () => {
  await writeLibraryFile("Src/a.md", "a");
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.md"], destination: { notebook: "Dst" } };
  const plan = await planned(request);
  setMigrationFaultForTests((point) => { if (point === "finalize:notify") rmSync(filePathFromParts("Dst", ["a.md"]), { force: true }); });
  const result = await runMigration(request, plan.token);
  assert.equal(result.state, "done");
  assert.equal(result.check, "incomplete");
  assert.equal(result.missing?.length, 1);
  assert.match(result.missing?.[0] ?? "", /^Dst\/a\.md/);
}));

test("the final check is not clean when a moved file has another size at its destination", () => withTemporaryLibrary(["Src", "Dst"], async () => {
  await writeLibraryFile("Src/a.png", "a");
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.png"], destination: { notebook: "Dst" } };
  const plan = await planned(request);
  setMigrationFaultForTests((point) => { if (point === "finalize:notify") { rmSync(filePathFromParts("Dst", ["a.png"]), { force: true }); writeFileSync(filePathFromParts("Dst", ["a.png"]), "much longer than before"); } });
  const result = await runMigration(request, plan.token);
  assert.equal(result.check, "incomplete");
  assert.equal(result.missing?.length, 1);
}));

test("Stop here with a selected hidden or unsupported file left in the source is not clean", () => withTemporaryLibrary(["Src", "Dst"], async () => {
  await writeLibraryFile("Src/folder/a.png", "a");
  await writeLibraryFile("Src/folder/z-data.unknownext", "unsupported");
  await writeAt(path.join(notebookPath("Src"), "folder", "z-hidden", ".config"), "hidden");
  const request: MigrationRequest = { source: "Src", paths: ["Src/folder"], destination: { notebook: "Dst" } };
  const plan = await planned(request);
  setMigrationFaultForTests((point) => { if (point === "published:Src/folder/a.png") throw new Error("simulated crash"); });
  let interrupted;
  try { interrupted = await runMigration(request, plan.token); }
  finally { setMigrationFaultForTests(null); }
  assert.equal(interrupted.state, "interrupted");
  const stopped = await resumeMigration(interrupted.id, "stop");
  assert.equal(stopped.state, "done");
  assert.ok(existsSync(path.join(notebookPath("Src"), "folder", "z-data.unknownext")));
  assert.ok(stopped.remaining.includes("Src/folder/z-data.unknownext"), JSON.stringify(stopped.remaining));
  assert.ok(stopped.remaining.includes("Src/folder/z-hidden/.config"), JSON.stringify(stopped.remaining));
  assert.notEqual(stopped.check, "clean");
}));

test("records that did not follow keep the final check from being clean", () => withTemporaryLibrary(["Src", "Dst"], async () => {
  await writeLibraryFile("Src/a.md", "a");
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.md"], destination: { notebook: "Dst" } };
  const plan = await planned(request);
  // A finalize step that fails, and fails again when the resume retries it: it is passed over and its note is kept.
  setMigrationFaultForTests((point) => { if (point === "finalizing:history") throw new Error("simulated failure"); });
  const first = await runMigration(request, plan.token);
  assert.equal(first.state, "interrupted");
  assert.notEqual(first.check, "clean");
  const [interrupted] = await listInterruptedMigrations();
  const result = await resumeMigration(interrupted.id, "continue");
  setMigrationFaultForTests(null);
  assert.equal(result.state, "done");
  assert.ok(result.bookkeeping.length > 0);
  assert.equal(result.check, "incomplete");
}));

test("a migration that went well is still clean", () => withTemporaryLibrary(["Src", "Dst"], async () => {
  await writeLibraryFile("Src/a.md", "a");
  await writeAt(path.join(notebookPath("Src"), "folder", ".hidden-config"), "hidden");
  await writeLibraryFile("Src/folder/b.md", "b");
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.md", "Src/folder"], destination: { notebook: "Dst" } };
  const plan = await planned(request);
  const result = await runMigration(request, plan.token);
  assert.equal(result.check, "clean");
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.remaining, []);
}));

// ---- 15: an external case-only rename ---------------------------------------

test("a file renamed outside the app only in its case leaves its side file reported", async (t) => {
  await withTemporaryLibrary(["Nb"], async () => {
    await writeLibraryFile("Nb/probe.md", "x");
    if (existsSync(filePathFromParts("Nb", ["PROBE.md"]))) {
      await writeLibraryFile("Nb/Case.md", "# Case\n");
      await writeAt(definitionsPath("Nb", ["Case.md"]), seeded("note-definitions"));
      await setStarredFilePath("Nb/Case.md", true);
      await rename(filePathFromParts("Nb", ["Case.md"]), filePathFromParts("Nb", ["case.md"]));
      const report = await verifyNotebook("Nb");
      assert.ok(report.findings.some((finding) => finding.check === "sidecars" && finding.path === "Nb/Case.md" && finding.severity === "warning"), "the stale spelling's side file is a finding");
      assert.ok(report.findings.some((finding) => finding.check === "records" && finding.path === "Nb/Case.md"), "and so is its star");
    } else t.skip("the temporary directory is case-sensitive");
  });
});

// ---- 20: records of a notebook that is no longer there ----------------------

test("records of a notebook renamed outside the app are reported when the new name is checked", () => withTemporaryLibrary(["Old"], async () => {
  await writeLibraryFile("Old/n.md", "# N\n");
  await setStarredFilePath("Old/n.md", true);
  await setFileTagsForPath("Old/n.md", ["draft"]);
  await withReviewWrite("Old/n.md", "# N\n", "run-1", async () => { await writeLibraryFile("Old/n.md", "# N\n\nagent\n"); });
  await rename(notebookPath("Old"), path.join(getAdminRoot(), "New"));
  const report = await verifyNotebook("New");
  const finding = report.findings.find((entry) => entry.code === "vanishedNotebookRecords");
  assert.ok(finding, "a finding for the vanished name");
  assert.equal(finding.check, "records");
  assert.equal(finding.severity, "warning");
  assert.equal(finding.path, "Old");
  assert.equal(finding.params?.stars, 1);
  assert.equal(finding.params?.tags, 1);
  assert.equal(finding.params?.pending, 1);
  assert.equal(finding.params?.renamed, "New");
  assert.equal(finding.clear, undefined, "reporting only");
}));

test("a vanished notebook is named as renamed only when exactly one notebook has its paths", () => withTemporaryLibrary(["Old", "Other"], async () => {
  await writeLibraryFile("Old/n.md", "# N\n");
  await setStarredFilePath("Old/n.md", true);
  await rename(notebookPath("Old"), path.join(getAdminRoot(), "New"));
  await writeLibraryFile("Other/n.md", "# N\n");
  const report = await verifyNotebook("Other");
  const finding = report.findings.find((entry) => entry.code === "vanishedNotebookRecords");
  assert.ok(finding);
  assert.equal(finding.params?.renamed, "none");
}));

test("an interrupted migration that names a notebook that is gone is reported", () => withTemporaryLibrary(["Src", "Dst"], async () => {
  await writeLibraryFile("Src/a.md", "a");
  await writeLibraryFile("Src/b.md", "b");
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.md", "Src/b.md"], destination: { notebook: "Dst" } };
  const plan = await planned(request);
  setMigrationFaultForTests((point) => { if (point === "published:Src/a.md") throw new Error("simulated crash"); });
  try { await runMigration(request, plan.token); }
  finally { setMigrationFaultForTests(null); }
  await rename(notebookPath("Src"), path.join(getAdminRoot(), "Renamed"));
  for (const name of ["Renamed", "Dst"]) {
    const report = await verifyNotebook(name);
    assert.ok(codes(report.findings, "migrations").includes("migrationVanishedNotebook"), `${name} shows the stranded journal`);
  }
}));

// ---- 23: what "complete" means ---------------------------------------------

test("a document replaced by a different file of the same size is not taken for the one a side file was made for", () => withTemporaryLibrary(["Nb"], async () => {
  const original = "%PDF-original";
  await writeLibraryFile("Nb/p.pdf", "%PDF-replaced");
  await writeAt(pdfAnnotationsPath("Nb", ["p.pdf"]), JSON.stringify({ annotations: [], comments: [], source: { size: original.length, contentHash: sha256(original) } }));
  const report = await verifyNotebook("Nb");
  assert.ok(codes(report.findings, "sidecars").includes("sideFileStaleContent"), JSON.stringify(report.findings));
}));

test("the same file still matches its side file, and a spent byte budget makes the content check partial", () => withTemporaryLibrary(["Nb"], async () => {
  const content = "%PDF-original";
  await writeLibraryFile("Nb/p.pdf", content);
  await writeAt(pdfAnnotationsPath("Nb", ["p.pdf"]), JSON.stringify({ annotations: [], comments: [], source: { size: content.length, contentHash: sha256(content) } }));
  const same = await verifyNotebook("Nb");
  assert.deepEqual(codes(same.findings, "sidecars"), []);
  assert.equal(same.checks.find((check) => check.id === "sidecars")?.status, "ok");
  const limited = await verifyNotebook("Nb", { limits: { bytes: 4 } });
  const sidecars = limited.checks.find((check) => check.id === "sidecars");
  assert.equal(sidecars?.status, "incomplete");
  assert.equal(limited.completeness, "partial");
}));

test("a Global Search index that can't be read makes the check partial and says so", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a.md", "A\n");
  const { searchIndexFile } = await import("../../src/lib/search/settings");
  const database = searchIndexFile();
  await mkdir(path.dirname(database), { recursive: true });
  await writeFile(database, Buffer.alloc(4096, 1));
  const report = await verifyNotebook("Nb");
  const indexes = report.checks.find((check) => check.id === "indexes");
  assert.equal(indexes?.status, "incomplete");
  assert.ok(indexes?.notes?.some((note) => note.code === "globalSearchSkipped"));
  assert.equal(report.completeness, "partial");
}));

test("no Global Search index yet is not a skipped check", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a.md", "A\n");
  const report = await verifyNotebook("Nb");
  assert.equal(report.checks.find((check) => check.id === "indexes")?.status, "ok");
}));

test("the byte budget applies while the notes are read, and progress comes before the read", () => withTemporaryLibrary(["Nb"], async () => {
  for (let index = 0; index < 6; index += 1) await writeLibraryFile(`Nb/n${index}.md`, "x".repeat(1000));
  const reads: string[] = [];
  const original = fsp.readFile;
  mock.method(fsp, "readFile", (...args: Parameters<typeof original>) => { reads.push(String(args[0])); return original(...args); });
  const progress: IntegrityProgress[] = [];
  let readsAtFirstProgress = -1;
  try {
    const report = await verifyNotebook("Nb", { limits: { bytes: 2500 }, onProgress: (event) => { if (!progress.length) readsAtFirstProgress = reads.filter((file) => file.endsWith(".md")).length; progress.push(event); } });
    assert.equal(readsAtFirstProgress, 0, "progress is reported before any note is read");
    const noteReads = reads.filter((file) => /n\d\.md$/.test(file));
    assert.ok(noteReads.length <= 3, `only notes within the budget are read (${noteReads.length})`);
    assert.ok(report.statistics.bytesRead <= 2500 + 1000);
    assert.equal(report.counts.notes, 6);
    assert.equal(report.completeness, "partial");
    assert.ok(report.checks.some((check) => check.notes?.some((note) => note.code === "notesLeftOut")));
  } finally { mock.restoreAll(); }
}));
