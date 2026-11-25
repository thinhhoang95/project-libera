import assert from "node:assert/strict";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { applyNotebookCleanup, planNotebookCleanup } from "../../src/lib/storage/cleanup";
import { verifyNotebook } from "../../src/lib/storage/integrity";
import { orphanedSidecarsDirectoryPath, pdfAnnotationsPath } from "../../src/lib/storage/paths";
import { assertNotebookSound, SEEDED_INK, seeded, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

// Review 2026-11-25, package C1 (Acknowledge and the check's reading of set-aside records):
// E-H3, E-M2, E-M3 and the check part of E-C3.

const exists = (target: string) => stat(target).then(() => true, () => false);
const IDENTITY = { size: 9999, contentHash: "a".repeat(64) };
const messages = async (notebook: string) => (await verifyNotebook(notebook)).findings.map((finding) => `${finding.severity}: ${finding.message}`);

test("E-H3: a set-aside record that can't be read is never offered, and Acknowledge leaves its file", () => withTemporaryLibrary(["Nb"], async () => {
  const folder = orphanedSidecarsDirectoryPath("Nb", "annotations");
  const damaged = path.join(folder, "1-abcd-x.pdf.json");
  await writeAt(damaged, "{ this is not json");
  // Ink set aside with a record that is cut off: the ink in it may be someone's only copy.
  const ink = path.join(orphanedSidecarsDirectoryPath("Nb", "ink"), "1-efgh");
  await writeAt(path.join(ink, "record.json"), "{\"originalPath\": ");
  await writeAt(path.join(ink, "ink", SEEDED_INK), seeded("pdf-ink"));
  const plan = await planNotebookCleanup("Nb");
  assert.deepEqual(plan.items, [], "nothing is offered");
  assert.ok((await messages("Nb")).some((text) => /can't be matched to the file/.test(text)), "the check says they are left alone");
  assert.ok(!(await messages("Nb")).some((text) => /kept for files that left/.test(text)), "and does not call them kept");
  const result = await applyNotebookCleanup("Nb", plan.token);
  assert.equal(result.outcomes.removed, 0);
  assert.ok(await exists(damaged));
  assert.ok(await exists(path.join(ink, "ink", SEEDED_INK)));
  assert.ok(await exists(path.join(ink, "record.json")));
}));

test("E-H3: a record whose file can't be read is held at apply time too (the origin is not known)", () => withTemporaryLibrary(["Nb"], async () => {
  const folder = orphanedSidecarsDirectoryPath("Nb", "outline");
  const record = path.join(folder, "1-abcd-x.pdf.json");
  await writeAt(record, JSON.stringify({ kind: "outline", originalPath: "Nb/gone.pdf", orphanedAt: new Date().toISOString(), source: null, sidecar: { version: 1, entries: [] } }));
  const plan = await planNotebookCleanup("Nb");
  assert.equal(plan.items.length, 1, "a record that says whose it is, for a file that is gone, is offered");
  // The record is damaged after the plan was made: what it was kept for is no longer known.
  await writeAt(record, "{ broken");
  await assert.rejects(applyNotebookCleanup("Nb", plan.token), /changed since this was prepared/);
  assert.ok(await exists(record));
}));

test("E-H3: a corrupt live sidecar of a file that is gone counts as unread, so Acknowledge leaves it", () => withTemporaryLibrary(["Nb"], async () => {
  const annotations = pdfAnnotationsPath("Nb", ["a", "gone.pdf"]);
  await writeAt(annotations, "{ not json");
  const plan = await planNotebookCleanup("Nb");
  assert.ok(!plan.items.some((item) => item.entries.some((entry) => /gone\.pdf/.test(entry.record))), "the damaged notes are not offered");
  const result = await applyNotebookCleanup("Nb", plan.token);
  assert.deepEqual(result.problems.filter((problem) => /gone\.pdf/.test(problem)), []);
  assert.ok(await exists(annotations), "still there");
}));

test("E-C3 (check): a set-aside ink folder with its record but no ink is reported as such, not as a promise or a kept file", () => withTemporaryLibrary(["Nb"], async () => {
  // The file is back under its old path: a record with ink would be a promise to give it its ink.
  await writeLibraryFile("Nb/a.pdf", "%PDF back");
  const leaked = path.join(orphanedSidecarsDirectoryPath("Nb", "ink"), "1-leak");
  await writeAt(path.join(leaked, "record.json"), JSON.stringify({ originalPath: "Nb/a.pdf", orphanedAt: new Date().toISOString(), source: null }));
  const found = await messages("Nb");
  assert.ok(found.some((text) => /record but no ink/.test(text)), found.join("\n"));
  assert.ok(!found.some((text) => /belongs to|kept for files that left/.test(text)), "no reattachment promise, no kept-file count");
  const plan = await planNotebookCleanup("Nb");
  assert.deepEqual(plan.items, [], "never offered for removal either: a move may be in progress");
  await applyNotebookCleanup("Nb", plan.token);
  assert.ok(await exists(path.join(leaked, "record.json")));
}));

test("E-M3: an annotation backup (.replaced-<hash>.json) is not an orphan and is never offered", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/papers/a.pdf", "%PDF-1.4 a");
  const backup = `${pdfAnnotationsPath("Nb", ["papers", "a.pdf"])}.replaced-0123456789ab.json`;
  await writeAt(backup, JSON.stringify({ annotations: [{ id: "x", type: "highlight" }], revision: 3 }));
  const plan = await planNotebookCleanup("Nb");
  assert.deepEqual(plan.items, []);
  await applyNotebookCleanup("Nb", plan.token);
  assert.ok(await exists(backup));
  await assertNotebookSound("Nb", { severities: ["error", "warning", "info"] });
}));

test("E-M2: a stale record whose name now belongs to a file with its own notes is cleared when it names bytes no file has", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/b/x.pdf", "%PDF other");
  await writeAt(pdfAnnotationsPath("Nb", ["b", "x.pdf"]), JSON.stringify({ annotations: [], revision: 1 }));
  const stale = pdfAnnotationsPath("Nb", ["a", "x.pdf"]);
  await writeAt(stale, JSON.stringify({ annotations: [], revision: 1, source: IDENTITY }));
  const plan = await planNotebookCleanup("Nb");
  assert.ok(plan.items.some((item) => item.path === "Nb/a/x.pdf"), "offered");
  assert.doesNotMatch(plan.notes.join("\n"), /more than one file has the name/);
  const result = await applyNotebookCleanup("Nb", plan.token);
  assert.deepEqual(result.problems, []);
  assert.ok(!(await exists(stale)));
  assert.ok(await exists(pdfAnnotationsPath("Nb", ["b", "x.pdf"])), "the file's own notes stay");
  await assertNotebookSound("Nb", { severities: ["error", "warning", "info"] });
}));

test("E-M2: without a recorded identity the record is held, and the note says why", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/b/x.pdf", "%PDF other");
  await writeAt(pdfAnnotationsPath("Nb", ["b", "x.pdf"]), JSON.stringify({ annotations: [], revision: 1 }));
  const stale = pdfAnnotationsPath("Nb", ["a", "x.pdf"]);
  await writeAt(stale, JSON.stringify({ annotations: [], revision: 1 }));
  const plan = await planNotebookCleanup("Nb");
  assert.deepEqual(plan.items, []);
  assert.match(plan.notes.join("\n"), /records of its own/);
  assert.doesNotMatch(plan.notes.join("\n"), /more than one file has the name/);
  await applyNotebookCleanup("Nb", plan.token);
  assert.ok(await exists(stale));
}));

test("E-M2: two copies set aside for one file are held with their own message", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/b/x.pdf", "%PDF other");
  const folder = orphanedSidecarsDirectoryPath("Nb", "annotations");
  for (const name of ["1-aaaa-x.pdf.json", "2-bbbb-x.pdf.json"]) {
    await writeAt(path.join(folder, name), JSON.stringify({ kind: "annotations", originalPath: "Nb/a/x.pdf", orphanedAt: new Date().toISOString(), source: null, sidecar: { annotations: [], revision: 1 } }));
  }
  const plan = await planNotebookCleanup("Nb");
  assert.deepEqual(plan.items, []);
  assert.match(plan.notes.join("\n"), /more than one copy was set aside/);
  assert.doesNotMatch(plan.notes.join("\n"), /more than one file has the name/);
  await applyNotebookCleanup("Nb", plan.token);
  assert.equal((await readdir(folder)).length, 2);
}));
