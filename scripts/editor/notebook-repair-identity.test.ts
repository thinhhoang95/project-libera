import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsp, { mkdir, readdir, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import test, { mock } from "node:test";
import { applyNotebookCleanup, planNotebookCleanup } from "../../src/lib/storage/cleanup";
import { inkFolderPath } from "../../src/lib/storage/ink";
import { filePathFromParts, getStateRoot, orphanedSidecarsDirectoryPath, pdfAnnotationsPath, pdfOutlinePath } from "../../src/lib/storage/paths";
import { applyNotebookRepair, planNotebookRepair } from "../../src/lib/storage/repair";
import { readWorkspaceMetadata, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";
import { seeded, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

// Try to fix and Acknowledge know a file by what it is, not only by its name:
// records that kept their file's bytes find it again under any name, a
// same-named file with other bytes is never given them, and nothing with a
// plausible home (another notebook, the archive) is offered for deletion.

const exists = (target: string) => stat(target).then(() => true, () => false);
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const at = (relative: string) => { const [notebook, ...parts] = relative.split("/"); return filePathFromParts(notebook, parts); };

/** What Finder does: the file moves, nothing else. */
async function finderMove(from: string, to: string) {
  await mkdir(path.dirname(at(to)), { recursive: true });
  await rename(at(from), at(to));
}

/** A PDF with annotations that recorded the PDF's bytes (as the app saves them). */
async function annotatedPdf(relative: string, bytes: string) {
  await writeLibraryFile(relative, bytes);
  const { notebook, parts } = { notebook: relative.split("/")[0], parts: relative.split("/").slice(1) };
  await writeAt(pdfAnnotationsPath(notebook, parts), JSON.stringify({ annotations: [], comments: [], source: { size: bytes.length, contentHash: digest(bytes) }, seed: relative }));
}

/** A pending agent review entry, as agent/review-store.ts keeps it: one file per path in the state folder. */
async function pendingAgentReview(filePath: string, baseline: string) {
  const name = `${createHash("sha256").update(filePath).digest("hex").slice(0, 40)}.json`;
  await writeAt(path.join(getStateRoot(), ".libera", "agent-review", name), JSON.stringify({ version: 1, path: filePath, baseline, created: false, runIds: ["run-12345678"], updatedAt: new Date().toISOString() }));
}

const agentEntries = async () => (await readdir(path.join(getStateRoot(), ".libera", "agent-review")).catch(() => [] as string[])).length;

test("17: a known content match beats a same-named file, and a swapped file invalidates the confirmation", () => withTemporaryLibrary(["Nb"], async () => {
  const original = "%PDF-1.4 the real document";
  await annotatedPdf("Nb/old/a.pdf", original);
  await finderMove("Nb/old/a.pdf", "Nb/new/renamed.pdf");
  // A decoy with the old name and the same size, but other bytes.
  await writeLibraryFile("Nb/other/a.pdf", "%PDF-1.4 a different doc!".slice(0, original.length).padEnd(original.length, "x"));

  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves.map((move) => [move.from, move.to]), [["Nb/old/a.pdf", "Nb/new/renamed.pdf"]]);
  assert.deepEqual(plan.unmatched, []);

  // The file the confirmation covers is replaced (same size) after the preview: the token no longer fits.
  const target = at("Nb/new/renamed.pdf");
  await writeAt(target, "%PDF-1.4 the fake document!".slice(0, original.length).padEnd(original.length, "y"));
  await utimes(target, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  await assert.rejects(applyNotebookRepair("Nb", plan.token), /changed since/);

  // Put the real bytes back and confirm a fresh preview.
  await writeAt(target, original);
  const again = await planNotebookRepair("Nb");
  assert.notEqual(again.token, plan.token, "the modification time is part of the token");
  const result = await applyNotebookRepair("Nb", again.token);
  assert.deepEqual(result.problems, []);
  assert.ok(await exists(pdfAnnotationsPath("Nb", ["new", "renamed.pdf"])));
  assert.ok(!(await exists(pdfAnnotationsPath("Nb", ["other", "a.pdf"]))), "the decoy gets nothing");
}));

test("17: a file of the old name whose bytes differ is not paired, and is named", () => withTemporaryLibrary(["Nb"], async () => {
  await annotatedPdf("Nb/old/a.pdf", "%PDF-1.4 the real document");
  await rm(at("Nb/old/a.pdf"));
  await writeLibraryFile("Nb/other/a.pdf", "%PDF-1.4 something else entirely");
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.unmatched.map((item) => [item.from, item.reason, item.candidates]), [["Nb/old/a.pdf", "different", ["Nb/other/a.pdf"]]]);
  // Its annotations are not offered for deletion either: a file of that name may still be it.
  const cleanup = await planNotebookCleanup("Nb");
  assert.ok(!cleanup.items.some((item) => item.path === "Nb/old/a.pdf"), "held for a decision");
}));

test("17: records without a recorded identity are still matched by name", () => withTemporaryLibrary(["Nb"], async () => {
  await setStarredFilePath("Nb/old/x.png", true);
  await writeLibraryFile("Nb/new/x.png", "png");
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves.map((move) => [move.from, move.to]), [["Nb/old/x.png", "Nb/new/x.png"]]);
}));

test("18: a note moved to another notebook keeps its records out of Acknowledge", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  await writeLibraryFile("Nb/notes/n.md", "# Note\n");
  await setStarredFilePath("Nb/notes/n.md", true);
  await pendingAgentReview("Nb/notes/n.md", "# Note\n\nline one of the note\nline two of the note\n");
  await setStarredFilePath("Nb/notes/gone.md", true);
  await finderMove("Nb/notes/n.md", "Other/n.md");

  const repair = await planNotebookRepair("Nb");
  assert.deepEqual(repair.moves, [], "records are not moved between notebooks");
  const moved = repair.unmatched.find((item) => item.from === "Nb/notes/n.md");
  assert.equal(moved?.reason, "elsewhere");
  assert.deepEqual(moved?.candidates, ["Other/n.md"]);

  const cleanup = await planNotebookCleanup("Nb");
  assert.ok(!cleanup.items.some((item) => item.path === "Nb/notes/n.md"), "the moved note's star and agent changes are not offered");
  assert.ok(cleanup.items.some((item) => item.path === "Nb/notes/gone.md"), "a record with no home still is");
  const result = await applyNotebookCleanup("Nb", cleanup.token);
  assert.deepEqual(result.problems, []);
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Nb/notes/n.md"]);
  assert.equal(await agentEntries(), 1);
}));

test("18: pending agent changes recognise their note by its text under another name", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  const baseline = "# Title\n\nline one of the note\nline two of the note\nline three\n";
  await pendingAgentReview("Nb/notes/n.md", baseline);
  await writeLibraryFile("Other/renamed-note.md", `${baseline}\nan agent edit\n`);
  const repair = await planNotebookRepair("Nb");
  assert.deepEqual(repair.unmatched.map((item) => [item.from, item.reason, item.candidates]), [["Nb/notes/n.md", "elsewhere", ["Other/renamed-note.md"]]]);
  const cleanup = await planNotebookCleanup("Nb");
  assert.deepEqual(cleanup.items.filter((item) => item.path === "Nb/notes/n.md"), []);
}));

test("19: parked annotations of a PDF renamed into the archive follow it, and are never offered for deletion", () => withTemporaryLibrary(["Nb"], async () => {
  const bytes = "%PDF-1.4 archived paper";
  const source = { size: bytes.length, contentHash: digest(bytes) };
  const annotations = { annotations: [], comments: [], source, seed: "parked" };
  const directory = orphanedSidecarsDirectoryPath("Nb", "annotations");
  await writeAt(path.join(directory, "1-abcd-a.pdf.json"), JSON.stringify({ kind: "annotations", originalPath: "Nb/papers/a.pdf", orphanedAt: new Date().toISOString(), source, sidecar: annotations }));
  await writeLibraryFile("Nb/_archive/archived-name.pdf", bytes);

  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves.map((move) => [move.from, move.to, move.records]), [["Nb/papers/a.pdf", "Nb/_archive/archived-name.pdf", ["annotations"]]]);
  await assert.rejects(planNotebookCleanup("Nb"), /Use Try to fix first/);

  const result = await applyNotebookRepair("Nb", plan.token);
  assert.deepEqual(result.problems, []);
  assert.equal(JSON.parse(await readFile(pdfAnnotationsPath("Nb", ["_archive", "archived-name.pdf"]), "utf8")).seed, "parked");
  assert.deepEqual(await readdir(directory), []);
}));

test("19: when the matching file has annotations of its own, the parked ones are held, not offered", () => withTemporaryLibrary(["Nb"], async () => {
  const bytes = "%PDF-1.4 archived paper";
  const source = { size: bytes.length, contentHash: digest(bytes) };
  await writeAt(path.join(orphanedSidecarsDirectoryPath("Nb", "annotations"), "1-abcd-a.pdf.json"), JSON.stringify({ kind: "annotations", originalPath: "Nb/papers/a.pdf", orphanedAt: new Date().toISOString(), source, sidecar: { annotations: [], comments: [], source } }));
  await annotatedPdf("Nb/_archive/archived-name.pdf", bytes);
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.unmatched.map((item) => [item.reason, item.candidates]), [["own", ["Nb/_archive/archived-name.pdf"]]]);
  const cleanup = await planNotebookCleanup("Nb");
  assert.deepEqual(cleanup.items.filter((item) => item.path.includes("a.pdf") || item.path.includes("annotations")), [], "never offered");
}));

test("21: pending agent changes alone make a pair, and they and the agent's undo history follow the note", () => withTemporaryLibrary(["Nb"], async () => {
  const note = "# Note\n\nsome text\n";
  await writeLibraryFile("Nb/a/n.md", note);
  await pendingAgentReview("Nb/a/n.md", note);
  const manifest = path.join(getStateRoot(), ".libera", "agent-runs", "run-12345678.json");
  await writeAt(manifest, JSON.stringify({ version: 1, runId: "run-12345678", createdAt: new Date().toISOString(), files: { "Nb/a/n.md": { existed: true, original: note, written: "x" } } }));
  await finderMove("Nb/a/n.md", "Nb/b/n.md");

  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, [{ from: "Nb/a/n.md", to: "Nb/b/n.md", records: ["pending agent changes"] }]);
  const result = await applyNotebookRepair("Nb", plan.token);
  assert.deepEqual(result.problems, []);
  assert.equal(result.moved.length, 1);

  const entries = await readdir(path.join(getStateRoot(), ".libera", "agent-review"));
  assert.equal(entries.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(getStateRoot(), ".libera", "agent-review", entries[0]), "utf8")).path, "Nb/b/n.md");
  assert.equal(JSON.parse(await readFile(manifest, "utf8")).files["Nb/a/n.md"].movedTo, "Nb/b/n.md");
  assert.deepEqual((await planNotebookRepair("Nb")).moves, []);
}));

test("21: a destination that already has pending agent changes is not given another's", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/b/n.md", "# Note\n");
  await pendingAgentReview("Nb/a/n.md", "# Note\n");
  await pendingAgentReview("Nb/b/n.md", "# Note\n");
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.unmatched.map((item) => item.reason), ["own"]);
}));

test("22: a failure midway leaves nothing half-moved, the pair is not reported moved, and a retry finishes it", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/b/x.pdf", "%PDF");
  await writeAt(pdfAnnotationsPath("Nb", ["a", "x.pdf"]), JSON.stringify({ annotations: [], comments: [], seed: "m1" }));
  await writeAt(pdfOutlinePath("Nb", ["a", "x.pdf"]), seeded("outline"));
  await writeAt(path.join(inkFolderPath("Nb", ["a", "x.pdf"]), "page-0001.aaaaaaaaaa.ink"), seeded("pdf-ink"));
  await writeAt(path.join(inkFolderPath("Nb", ["a", "x.pdf"]), "page-0002.aaaaaaaaaa.ink"), seeded("pdf-ink"));
  await setStarredFilePath("Nb/a/x.pdf", true);

  const plan = await planNotebookRepair("Nb");
  assert.equal(plan.moves.length, 1);
  // The second ink file can't be copied once.
  const copy = fsp.copyFile;
  mock.method(fsp, "copyFile", (async (source: string, ...rest: unknown[]) => {
    if (String(source).endsWith("page-0002.aaaaaaaaaa.ink")) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return (copy as (...args: unknown[]) => Promise<void>)(source, ...rest);
  }) as typeof fsp.copyFile);
  try {
    const result = await applyNotebookRepair("Nb", plan.token);
    assert.deepEqual(result.moved, [], "not reported moved");
    assert.match(result.problems.join("\n"), /could not follow it to Nb\/b\/x\.pdf: denied/);
  } finally {
    mock.restoreAll();
  }
  assert.ok(await exists(pdfAnnotationsPath("Nb", ["b", "x.pdf"])), "what moved whole stays moved");
  assert.ok(!(await exists(inkFolderPath("Nb", ["b", "x.pdf"]))), "no half an ink folder at the destination");
  assert.ok(await exists(path.join(inkFolderPath("Nb", ["a", "x.pdf"]), "page-0001.aaaaaaaaaa.ink")), "the source ink is whole");
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Nb/a/x.pdf"], "the star waits for the whole pair");

  // The cause is fixed: the retry plans the rest and finishes it.
  const retry = await planNotebookRepair("Nb");
  assert.deepEqual(retry.unmatched, []);
  assert.deepEqual(retry.moves.map((move) => [move.from, move.to, move.records]), [["Nb/a/x.pdf", "Nb/b/x.pdf", ["ink", "star"]]]);
  const done = await applyNotebookRepair("Nb", retry.token);
  assert.deepEqual(done.problems, []);
  assert.equal(done.moved.length, 1);
  assert.deepEqual(await readdir(inkFolderPath("Nb", ["b", "x.pdf"])), ["page-0001.aaaaaaaaaa.ink", "page-0002.aaaaaaaaaa.ink"]);
  assert.ok(!(await exists(inkFolderPath("Nb", ["a", "x.pdf"]))));
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Nb/b/x.pdf"]);
}));

test("22: an ink child that finds its place taken stops the pair and takes back the copy", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/b/x.pdf", "%PDF");
  await writeAt(path.join(inkFolderPath("Nb", ["a", "x.pdf"]), "page-0001.aaaaaaaaaa.ink"), seeded("pdf-ink"));
  await writeAt(path.join(inkFolderPath("Nb", ["a", "x.pdf"]), "page-0002.aaaaaaaaaa.ink"), seeded("pdf-ink"));
  const plan = await planNotebookRepair("Nb");
  assert.equal(plan.moves.length, 1);
  const copy = fsp.copyFile;
  mock.method(fsp, "copyFile", (async (source: string, destination: string, ...rest: [number?]) => {
    // Someone saves ink at the destination meanwhile.
    if (String(source).endsWith("page-0002.aaaaaaaaaa.ink")) await writeAt(destination, "saved meanwhile");
    return (copy as (...args: unknown[]) => Promise<void>)(source, destination, ...rest);
  }) as typeof fsp.copyFile);
  try {
    const result = await applyNotebookRepair("Nb", plan.token);
    assert.deepEqual(result.moved, []);
    assert.match(result.problems.join("\n"), /ink of Nb\/a\/x\.pdf stayed/);
  } finally {
    mock.restoreAll();
  }
  assert.deepEqual(await readdir(inkFolderPath("Nb", ["a", "x.pdf"])), ["page-0001.aaaaaaaaaa.ink", "page-0002.aaaaaaaaaa.ink"], "the source is whole");
  assert.deepEqual(await readdir(inkFolderPath("Nb", ["b", "x.pdf"])), ["page-0002.aaaaaaaaaa.ink"], "only what was saved there is left");
}));
