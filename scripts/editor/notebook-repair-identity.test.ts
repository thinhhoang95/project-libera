import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsp, { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import test, { mock } from "node:test";
import { planNotebookCleanup } from "../../src/lib/storage/cleanup";
import { inkFolderPath } from "../../src/lib/storage/ink";
import { filePathFromParts, getStateRoot, orphanedSidecarsDirectoryPath, pdfAnnotationsPath, pdfOutlinePath } from "../../src/lib/storage/paths";
import { applyNotebookRepair, planNotebookRepair } from "../../src/lib/storage/repair";
import { readWorkspaceMetadata, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";
import { assertNotebookSound, seeded, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

// Try to fix pairs by name alone (docs/features/notebook-integrity.md): a
// file with the recorded bytes under another name is not a candidate, a
// same-named file with other bytes is (as the dialog warns), and several
// files of a name are never guessed. The same file covers how a pair is
// carried out: a failure midway, a side file changed while it moved, and a
// retry that finishes what an earlier try left.

const exists = (target: string) => stat(target).then(() => true, () => false);
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const at = (relative: string) => { const [notebook, ...parts] = relative.split("/"); return filePathFromParts(notebook, parts); };

/** What Finder does: the file moves, nothing else. */
async function finderMove(from: string, to: string) {
  await mkdir(path.dirname(at(to)), { recursive: true });
  await rename(at(from), at(to));
}

/** A PDF with annotations (as the app saves them, with the PDF's bytes recorded: repair never looks at them). */
async function annotatedPdf(relative: string, bytes: string) {
  await writeLibraryFile(relative, bytes);
  const [notebook, ...parts] = relative.split("/");
  await writeAt(pdfAnnotationsPath(notebook, parts.slice()), JSON.stringify({ annotations: [], comments: [], source: { size: bytes.length, contentHash: digest(bytes) }, seed: relative }));
}

/** A pending agent review entry, as agent/review-store.ts keeps it: one file per path in the state folder. */
async function pendingAgentReview(filePath: string, baseline: string) {
  const name = `${createHash("sha256").update(filePath).digest("hex").slice(0, 40)}.json`;
  await writeAt(path.join(getStateRoot(), ".libera", "agent-review", name), JSON.stringify({ version: 1, path: filePath, baseline, created: false, runIds: ["run-12345678"], updatedAt: new Date().toISOString() }));
}

const inkOf = (relative: string) => { const [notebook, ...parts] = relative.split("/"); return inkFolderPath(notebook, parts); };

/** Calls `link` (the way a side file is published) through `intercept`, which may add to what it does. */
function interceptLink(intercept: (source: string, destination: string, real: () => Promise<void>) => Promise<void>) {
  const original = fsp.link;
  mock.method(fsp, "link", (async (source: string, destination: string) => intercept(String(source), String(destination), () => original(source, destination))) as typeof fsp.link);
}

test("name rule: a differently named file with the recorded bytes is not a candidate", () => withTemporaryLibrary(["Nb"], async () => {
  const bytes = "%PDF-1.4 the real document";
  await annotatedPdf("Nb/old/a.pdf", bytes);
  await finderMove("Nb/old/a.pdf", "Nb/new/renamed.pdf");
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.unmatched.map((item) => [item.from, item.reason, item.candidates]), [["Nb/old/a.pdf", "none", []]]);
}));

test("name rule: a file of the old name with other bytes is paired, as the dialog warns", () => withTemporaryLibrary(["Nb"], async () => {
  await annotatedPdf("Nb/old/a.pdf", "%PDF-1.4 the real document");
  await rm(at("Nb/old/a.pdf"));
  await writeLibraryFile("Nb/other/a.pdf", "%PDF-1.4 something else entirely");
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves.map((move) => [move.from, move.to, move.records]), [["Nb/old/a.pdf", "Nb/other/a.pdf", ["annotations"]]]);
  const result = await applyNotebookRepair("Nb", plan.token);
  assert.deepEqual(result.problems, []);
  assert.ok(await exists(pdfAnnotationsPath("Nb", ["other", "a.pdf"])));
  await assertNotebookSound("Nb");
}));

test("name rule: several files of the name are never guessed, whatever their bytes", () => withTemporaryLibrary(["Nb"], async () => {
  const bytes = "%PDF-1.4 the real document";
  await annotatedPdf("Nb/old/a.pdf", bytes);
  await rm(at("Nb/old/a.pdf"));
  await writeLibraryFile("Nb/one/a.pdf", bytes);
  await writeLibraryFile("Nb/two/a.pdf", "%PDF-1.4 other");
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.unmatched.map((item) => [item.reason, item.candidates]), [["several", ["Nb/one/a.pdf", "Nb/two/a.pdf"]]]);
}));

test("name rule: records of a note moved to another notebook are not paired there, and are held while a file of the name is there (E-M7)", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  await writeLibraryFile("Nb/notes/n.md", "# Note\n");
  await setStarredFilePath("Nb/notes/n.md", true);
  await finderMove("Nb/notes/n.md", "Other/n.md");
  const repair = await planNotebookRepair("Nb");
  assert.deepEqual(repair.moves, []);
  assert.deepEqual(repair.unmatched.map((item) => [item.from, item.reason, item.candidates]), [["Nb/notes/n.md", "elsewhere", ["Other/n.md"]]]);
}));

test("parked annotations of a PDF are paired by name, including into the archive, and not by their bytes", () => withTemporaryLibrary(["Nb"], async () => {
  const bytes = "%PDF-1.4 archived paper";
  const source = { size: bytes.length, contentHash: digest(bytes) };
  const annotations = { annotations: [], comments: [], source, seed: "parked" };
  const directory = orphanedSidecarsDirectoryPath("Nb", "annotations");
  await writeAt(path.join(directory, "1-abcd-a.pdf.json"), JSON.stringify({ kind: "annotations", originalPath: "Nb/papers/a.pdf", orphanedAt: new Date().toISOString(), source, sidecar: annotations }));
  await writeLibraryFile("Nb/_archive/archived-name.pdf", bytes);
  assert.deepEqual((await planNotebookRepair("Nb")).moves, [], "the bytes under another name are not enough");

  await rm(at("Nb/_archive/archived-name.pdf"));
  await writeLibraryFile("Nb/_archive/a.pdf", "%PDF-1.4 whatever");
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves.map((move) => [move.from, move.to, move.records]), [["Nb/papers/a.pdf", "Nb/_archive/a.pdf", ["annotations"]]]);
  await assert.rejects(planNotebookCleanup("Nb"), /Use Try to fix first/);
  const result = await applyNotebookRepair("Nb", plan.token);
  assert.deepEqual(result.problems, []);
  assert.equal(JSON.parse(await readFile(pdfAnnotationsPath("Nb", ["_archive", "a.pdf"]), "utf8")).seed, "parked");
  assert.deepEqual(await readdir(directory), []);
}));

test("when the same-named file has annotations of its own, parked ones are not given to it", () => withTemporaryLibrary(["Nb"], async () => {
  const bytes = "%PDF-1.4 archived paper";
  const source = { size: bytes.length, contentHash: digest(bytes) };
  await writeAt(path.join(orphanedSidecarsDirectoryPath("Nb", "annotations"), "1-abcd-a.pdf.json"), JSON.stringify({ kind: "annotations", originalPath: "Nb/papers/a.pdf", orphanedAt: new Date().toISOString(), source, sidecar: { annotations: [], comments: [], source } }));
  await annotatedPdf("Nb/_archive/a.pdf", bytes);
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.unmatched.map((item) => [item.reason, item.candidates]), [["own", ["Nb/_archive/a.pdf"]]]);
}));

test("74: two set-aside copies of one side file for one path are a conflict, reported with nothing written", () => withTemporaryLibrary(["Nb"], async () => {
  const directory = orphanedSidecarsDirectoryPath("Nb", "annotations");
  const record = (seed: string) => JSON.stringify({ kind: "annotations", originalPath: "Nb/a/a.pdf", orphanedAt: new Date().toISOString(), source: null, sidecar: { annotations: [], comments: [], seed } });
  await writeAt(path.join(directory, "1-aaaa-a.pdf.json"), record("first"));
  await writeAt(path.join(directory, "2-bbbb-a.pdf.json"), record("second"));
  await writeLibraryFile("Nb/b/a.pdf", "%PDF");
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.unmatched.map((item) => [item.from, item.reason, item.candidates]), [["Nb/a/a.pdf", "conflict", ["Nb/b/a.pdf"]]]);
  const result = await applyNotebookRepair("Nb", plan.token);
  assert.deepEqual(result.moved, []);
  assert.equal((await readdir(directory)).length, 2);
  assert.ok(!(await exists(pdfAnnotationsPath("Nb", ["b", "a.pdf"]))));
}));

test("21: pending agent changes alone make a pair, and they and the agent's undo history follow the note", () => withTemporaryLibrary(["Nb"], async () => {
  const note = "# Note\n\nsome text\n";
  await writeLibraryFile("Nb/a/n.md", note);
  await pendingAgentReview("Nb/a/n.md", note);
  const manifest = path.join(getStateRoot(), ".libera", "agent-runs", "run-12345678.json");
  await writeAt(manifest, JSON.stringify({ version: 1, runId: "run-12345678", createdAt: new Date().toISOString(), files: { "Nb/a/n.md": { existed: true, original: note, written: "x" } } }));
  await finderMove("Nb/a/n.md", "Nb/b/n.md");

  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, [{ from: "Nb/a/n.md", to: "Nb/b/n.md", records: ["agent undo history", "pending agent changes"] }]);
  const result = await applyNotebookRepair("Nb", plan.token);
  assert.deepEqual(result.problems, []);
  assert.equal(result.moved.length, 1);
  assert.deepEqual(result.outcomes.map((outcome) => outcome.status), ["moved", "moved"]);

  const entries = await readdir(path.join(getStateRoot(), ".libera", "agent-review"));
  assert.equal(entries.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(getStateRoot(), ".libera", "agent-review", entries[0]), "utf8")).path, "Nb/b/n.md");
  assert.equal(JSON.parse(await readFile(manifest, "utf8")).files["Nb/a/n.md"].movedTo, "Nb/b/n.md");
  assert.deepEqual((await planNotebookRepair("Nb")).moves, []);
  await assertNotebookSound("Nb");
}));

test("69: undo history alone, with no other record, makes a pair under the same name rule", () => withTemporaryLibrary(["Nb"], async () => {
  const note = "# Note\n";
  await writeLibraryFile("Nb/a/n.md", note);
  const manifest = path.join(getStateRoot(), ".libera", "agent-runs", "run-12345678.json");
  await writeAt(manifest, JSON.stringify({ version: 1, runId: "run-12345678", createdAt: new Date().toISOString(), files: { "Nb/a/n.md": { existed: true, original: note, written: "x" } } }));
  await finderMove("Nb/a/n.md", "Nb/b/n.md");
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, [{ from: "Nb/a/n.md", to: "Nb/b/n.md", records: ["agent undo history"] }]);
  const result = await applyNotebookRepair("Nb", plan.token);
  assert.deepEqual(result.outcomes, [{ from: "Nb/a/n.md", to: "Nb/b/n.md", record: "agent undo history", status: "moved" }]);
  assert.equal(JSON.parse(await readFile(manifest, "utf8")).files["Nb/a/n.md"].movedTo, "Nb/b/n.md");
}));

test("21: a destination that already has pending agent changes is not given another's", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/b/n.md", "# Note\n");
  await pendingAgentReview("Nb/a/n.md", "# Note\n");
  await pendingAgentReview("Nb/b/n.md", "# Note\n");
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.unmatched.map((item) => item.reason), ["own"]);
}));

test("22: a failure midway leaves nothing half-moved, the stores wait, and a retry finishes it", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/b/x.pdf", "%PDF");
  await writeAt(pdfAnnotationsPath("Nb", ["a", "x.pdf"]), JSON.stringify({ annotations: [], comments: [], seed: "m1" }));
  await writeAt(pdfOutlinePath("Nb", ["a", "x.pdf"]), seeded("outline"));
  await writeAt(path.join(inkOf("Nb/a/x.pdf"), "page-0001.aaaaaaaaaa.ink"), seeded("pdf-ink"));
  await writeAt(path.join(inkOf("Nb/a/x.pdf"), "page-0002.aaaaaaaaaa.ink"), seeded("pdf-ink"));
  await setStarredFilePath("Nb/a/x.pdf", true);

  const plan = await planNotebookRepair("Nb");
  assert.equal(plan.moves.length, 1);
  // The second ink file can't be placed once.
  interceptLink(async (source, _destination, real) => {
    if (source.endsWith("page-0002.aaaaaaaaaa.ink")) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return real();
  });
  try {
    const result = await applyNotebookRepair("Nb", plan.token);
    assert.deepEqual(result.moved.map((move) => move.from), ["Nb/a/x.pdf"], "the annotations and outline did move");
    assert.deepEqual(result.outcomes.map((outcome) => [outcome.record, outcome.status]), [["annotations", "moved"], ["ink", "failed"], ["outline", "moved"], ["star", "waiting"]]);
    assert.match(result.problems.join("\n"), /could not follow it to Nb\/b\/x\.pdf: denied/);
  } finally {
    mock.restoreAll();
  }
  assert.ok(await exists(pdfAnnotationsPath("Nb", ["b", "x.pdf"])), "what moved whole stays moved");
  assert.ok(!(await exists(inkOf("Nb/b/x.pdf"))), "no half an ink folder at the destination");
  assert.ok(await exists(path.join(inkOf("Nb/a/x.pdf"), "page-0001.aaaaaaaaaa.ink")), "the source ink is whole");
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Nb/a/x.pdf"], "the star waits for the whole pair");

  // The cause is fixed: the retry plans the rest and finishes it.
  const retry = await planNotebookRepair("Nb");
  assert.deepEqual(retry.unmatched, []);
  assert.deepEqual(retry.moves.map((move) => [move.from, move.to, move.records]), [["Nb/a/x.pdf", "Nb/b/x.pdf", ["ink", "star"]]]);
  const done = await applyNotebookRepair("Nb", retry.token);
  assert.deepEqual(done.problems, []);
  assert.equal(done.moved.length, 1);
  assert.deepEqual(await readdir(inkOf("Nb/b/x.pdf")), ["page-0001.aaaaaaaaaa.ink", "page-0002.aaaaaaaaaa.ink"]);
  assert.ok(!(await exists(inkOf("Nb/a/x.pdf"))));
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Nb/b/x.pdf"]);
}));

test("22: an ink child that finds its place taken stops the pair and takes back what it placed", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/b/x.pdf", "%PDF");
  await writeAt(path.join(inkOf("Nb/a/x.pdf"), "page-0001.aaaaaaaaaa.ink"), seeded("pdf-ink"));
  await writeAt(path.join(inkOf("Nb/a/x.pdf"), "page-0002.aaaaaaaaaa.ink"), seeded("pdf-ink"));
  const plan = await planNotebookRepair("Nb");
  assert.equal(plan.moves.length, 1);
  interceptLink(async (source, destination, real) => {
    // Someone saves ink at the destination meanwhile.
    if (source.endsWith("page-0002.aaaaaaaaaa.ink")) await writeAt(destination, "saved meanwhile");
    return real();
  });
  try {
    const result = await applyNotebookRepair("Nb", plan.token);
    assert.deepEqual(result.moved, []);
    assert.match(result.problems.join("\n"), /ink of Nb\/a\/x\.pdf stayed/);
  } finally {
    mock.restoreAll();
  }
  assert.deepEqual(await readdir(inkOf("Nb/a/x.pdf")), ["page-0001.aaaaaaaaaa.ink", "page-0002.aaaaaaaaaa.ink"], "the source is whole");
  assert.deepEqual(await readdir(inkOf("Nb/b/x.pdf")), ["page-0002.aaaaaaaaaa.ink"], "only what was saved there is left");
}));

test("72: a source side file updated after it was published is kept, and the destination's older copy is taken back", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/b/x.pdf", "%PDF");
  const source = pdfAnnotationsPath("Nb", ["a", "x.pdf"]);
  await writeAt(source, JSON.stringify({ annotations: [], comments: [], seed: "older" }));
  const plan = await planNotebookRepair("Nb");
  interceptLink(async (from, _destination, real) => {
    await real();
    // A sync client replaces the source (a new file under the same name) before it is retired.
    await writeAt(`${from}.incoming`, JSON.stringify({ annotations: [], comments: [], seed: "newer work" }));
    await rename(`${from}.incoming`, from);
  });
  try {
    const result = await applyNotebookRepair("Nb", plan.token);
    assert.deepEqual(result.moved, []);
    assert.match(result.problems.join("\n"), /changed while it was being moved/);
  } finally {
    mock.restoreAll();
  }
  assert.equal(JSON.parse(await readFile(source, "utf8")).seed, "newer work", "the newer work is not deleted");
  assert.ok(!(await exists(pdfAnnotationsPath("Nb", ["b", "x.pdf"]))), "no stale snapshot is left at the destination");
}));

test("72: rolling back an ink folder leaves a destination child another writer replaced", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/b/x.pdf", "%PDF");
  await writeAt(path.join(inkOf("Nb/a/x.pdf"), "page-0001.aaaaaaaaaa.ink"), seeded("pdf-ink"));
  await writeAt(path.join(inkOf("Nb/a/x.pdf"), "page-0002.aaaaaaaaaa.ink"), seeded("pdf-ink"));
  const plan = await planNotebookRepair("Nb");
  const first = path.join(inkOf("Nb/b/x.pdf"), "page-0001.aaaaaaaaaa.ink");
  interceptLink(async (source, _destination, real) => {
    if (source.endsWith("page-0002.aaaaaaaaaa.ink")) {
      // The app saves ink over the child just placed (a new file), then the next child fails.
      await writeAt(`${first}.incoming`, "someone's ink");
      await rename(`${first}.incoming`, first);
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    }
    return real();
  });
  try { await applyNotebookRepair("Nb", plan.token); } finally { mock.restoreAll(); }
  assert.equal(await readFile(first, "utf8"), "someone's ink", "not removed by the rollback");
  assert.deepEqual(await readdir(inkOf("Nb/a/x.pdf")), ["page-0001.aaaaaaaaaa.ink", "page-0002.aaaaaaaaaa.ink"]);
}));

test("73: a try that published a side file and stopped before retiring the old one is finished by a retry, not blocked by it", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/b/x.pdf", "%PDF");
  const source = pdfAnnotationsPath("Nb", ["a", "x.pdf"]);
  await writeAt(source, JSON.stringify({ annotations: [], comments: [], seed: "m1" }));
  await setStarredFilePath("Nb/a/x.pdf", true);
  const plan = await planNotebookRepair("Nb");
  // The old name can't be removed once.
  const remove = fsp.rm;
  mock.method(fsp, "rm", (async (target: string, ...rest: unknown[]) => {
    if (String(target) === source) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    return (remove as (...args: unknown[]) => Promise<void>)(target, ...rest);
  }) as typeof fsp.rm);
  try {
    const result = await applyNotebookRepair("Nb", plan.token);
    assert.deepEqual(result.moved, []);
    assert.match(result.problems.join("\n"), /busy/);
  } finally {
    mock.restoreAll();
  }
  assert.ok(await exists(source) && await exists(pdfAnnotationsPath("Nb", ["b", "x.pdf"])), "both names are there");
  const retry = await planNotebookRepair("Nb");
  assert.deepEqual(retry.unmatched, [], "the pair is not blocked by its own earlier try");
  assert.deepEqual(retry.moves.map((move) => move.records), [["annotations", "star"]]);
  const done = await applyNotebookRepair("Nb", retry.token);
  assert.deepEqual(done.problems, []);
  assert.ok(!(await exists(source)));
  assert.equal(JSON.parse(await readFile(pdfAnnotationsPath("Nb", ["b", "x.pdf"]), "utf8")).seed, "m1");
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Nb/b/x.pdf"]);
  await assertNotebookSound("Nb");
}));

test("66: a destination's own record that merely equals the source's is its own, not an earlier try's", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/b/x.pdf", "%PDF");
  await writeAt(pdfOutlinePath("Nb", ["a", "x.pdf"]), seeded("outline"));
  await writeAt(pdfOutlinePath("Nb", ["b", "x.pdf"]), seeded("outline"));
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.unmatched.map((item) => item.reason), ["own"]);
  await applyNotebookRepair("Nb", plan.token);
  assert.ok(await exists(pdfOutlinePath("Nb", ["a", "x.pdf"])), "the source record is not retired");
}));

test("66: an ink folder at the destination that holds the source's pages and more is its own", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/b/x.pdf", "%PDF");
  await writeAt(path.join(inkOf("Nb/a/x.pdf"), "page-0001.aaaaaaaaaa.ink"), seeded("pdf-ink"));
  await writeAt(path.join(inkOf("Nb/b/x.pdf"), "page-0001.aaaaaaaaaa.ink"), seeded("pdf-ink"));
  await writeAt(path.join(inkOf("Nb/b/x.pdf"), "page-0002.aaaaaaaaaa.ink"), seeded("pdf-ink"));
  const plan = await planNotebookRepair("Nb");
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.unmatched.map((item) => item.reason), ["own"]);
}));

test("70: a pair is checked again right before it is written: a source that came back, or a replaced destination, stops it", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a/x.pdf", "%PDF");
  await setStarredFilePath("Nb/a/x.pdf", true);
  await finderMove("Nb/a/x.pdf", "Nb/b/x.pdf");
  const plan = await planNotebookRepair("Nb");
  assert.equal(plan.moves.length, 1);
  /** Runs `change` when the migration journals are listed: after the token was compared, before any pair. */
  const afterToken = async (change: () => Promise<void>) => {
    const original = fsp.readdir;
    let fired = false;
    mock.method(fsp, "readdir", (async (target: string, ...rest: unknown[]) => {
      if (!fired && /migration/i.test(String(target))) { fired = true; await change(); }
      return (original as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fsp.readdir);
    try { return await applyNotebookRepair("Nb", plan.token); } finally { mock.restoreAll(); }
  };
  const back = await afterToken(() => writeLibraryFile("Nb/a/x.pdf", "%PDF back").then(() => undefined));
  assert.deepEqual(back.moved, []);
  assert.match(back.problems.join("\n"), /Nb\/a\/x\.pdf is back/);
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Nb/a/x.pdf"]);
  await rm(at("Nb/a/x.pdf"));
  const replaced = await afterToken(() => writeLibraryFile("Nb/b/x.pdf", "%PDF a different, longer file").then(() => undefined));
  assert.deepEqual(replaced.moved, []);
  assert.match(replaced.problems.join("\n"), /not the file that was shown/);
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Nb/a/x.pdf"]);
}));

test("75: a pair whose only record vanished after the plan is not reported moved", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/b/x.png", "png");
  await setStarredFilePath("Nb/a/x.png", true);
  const plan = await planNotebookRepair("Nb");
  assert.equal(plan.moves.length, 1);
  // The star goes (unstarred in the app) after the plan was shown, before the stores are written.
  const original = fsp.readdir;
  mock.method(fsp, "readdir", (async (target: string, ...rest: unknown[]) => {
    if (/migration/i.test(String(target))) await setStarredFilePath("Nb/a/x.png", false);
    return (original as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof fsp.readdir);
  try {
    const result = await applyNotebookRepair("Nb", plan.token);
    assert.deepEqual(result.moved, [], "nothing moved, so nothing is retargeted");
    assert.deepEqual(result.outcomes.map((outcome) => [outcome.record, outcome.status]), [["star", "nothing"]]);
  } finally {
    mock.restoreAll();
  }
}));
