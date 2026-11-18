import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { withTemporaryLibrary, writeLibraryFile } from "./notebook-test-helpers";
import { listInterruptedMigrations, planMigration, resumeMigration, runMigration, setMigrationFaultForTests, type MigrationRequest } from "../../src/lib/storage/migration";
import { filePathFromParts, getAdminRoot, markdownAssetsDirectoryPathFromParts } from "../../src/lib/storage/paths";
import { readWorkspaceMetadata, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";

const withLibrary = (run: () => Promise<void>) => withTemporaryLibrary(["Src", "Dst"], run);
const file = writeLibraryFile;
const read = (target: string) => readFile(target, "utf8");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const journalFile = (id: string) => path.join(getAdminRoot(), ".libera", "migrations", `${id}.json`);

async function editJournal(id: string, change: (journal: { items: Record<string, unknown>[] }) => void) {
  const journal = JSON.parse(await read(journalFile(id))) as { items: Record<string, unknown>[] };
  change(journal);
  await writeFile(journalFile(id), JSON.stringify(journal));
}

/** Run a migration that stops at a fault point; the fault may throw or be swallowed by the run's own handling. */
async function interruptAt(request: MigrationRequest, point: string, options: { crash?: boolean } = {}) {
  const plan = await planMigration(request);
  assert.deepEqual(plan.blockers, []);
  setMigrationFaultForTests((fault) => { if (fault === point) throw Object.assign(new Error("simulated crash"), options); });
  try { await runMigration(request, plan.token); }
  catch (error) { assert.match((error as Error).message, /simulated crash/); }
  finally { setMigrationFaultForTests(null); }
  const [interrupted] = await listInterruptedMigrations();
  assert.ok(interrupted, "the migration is left interrupted");
  return interrupted;
}

/** A note that embeds an image that moves with it: its text is rewritten for the new notebook, so it is published from a staged copy. */
async function noteWithMovingImage() {
  const text = "# Note\n\n![](/api/files/raw/Src/img/fig.png)\n";
  await file("Src/img/fig.png", Buffer.from("png-bytes"));
  await file("Src/n.md", text);
  return text;
}

test("a source edited in place after a staged copy was published is not deleted on resume", () => withLibrary(async () => {
  const text = await noteWithMovingImage();
  const request: MigrationRequest = { source: "Src", paths: ["Src/img/fig.png", "Src/n.md"], destination: { notebook: "Dst" } };
  const interrupted = await interruptAt(request, "published:Src/n.md");
  const source = filePathFromParts("Src", ["n.md"]);
  const destination = filePathFromParts("Dst", ["n.md"]);
  assert.ok(existsSync(destination), "published");
  const published = await read(destination);
  assert.match(published, /\/api\/files\/raw\/Dst\/img\/fig\.png/, "the copy is a rewritten one, not the same file");
  await appendFile(source, "typed after publication\n");

  const resumed = await resumeMigration(interrupted.id, "continue");
  assert.equal(resumed.state, "interrupted");
  assert.match(resumed.error ?? "", /edited after/);
  assert.equal(await read(source), `${text}typed after publication\n`, "the edit is still in the source");
  assert.equal(await read(destination), published, "the destination was not touched");

  // Stop here ends without deleting that source, and the note is not reported as cleanly moved.
  const stopped = await resumeMigration(interrupted.id, "stop");
  assert.equal(stopped.state, "done");
  assert.equal(await read(source), `${text}typed after publication\n`);
  assert.ok(existsSync(destination));
  assert.deepEqual(stopped.moved.filter((move) => move.incomplete).map((move) => move.from), ["Src/n.md"]);
  assert.notEqual(stopped.check, "clean");
  assert.ok(stopped.bookkeeping.some((entry) => /edited after/.test(entry)));
}));

test("a hard-linked source edited after publication is the same file and still retires", () => withLibrary(async () => {
  await file("Src/a.md", "a\n");
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.md"], destination: { notebook: "Dst" } };
  const interrupted = await interruptAt(request, "published:Src/a.md");
  await appendFile(filePathFromParts("Src", ["a.md"]), "more\n");
  const resumed = await resumeMigration(interrupted.id, "continue");
  assert.equal(resumed.state, "done");
  assert.equal(await read(filePathFromParts("Dst", ["a.md"])), "a\nmore\n");
  assert.ok(!existsSync(filePathFromParts("Src", ["a.md"])));
}));

test("rolling back staging leaves files in the folders of notes it never reached", () => withLibrary(async () => {
  await file("Src/a.md", "a");
  await file("Src/b.md", "b");
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.md", "Src/b.md"], destination: { notebook: "Dst" } };
  const plan = await planMigration(request);
  assert.deepEqual(plan.items.map((item) => item.from), ["Src/a.md", "Src/b.md"]);
  const interrupted = await interruptAt(request, "staged:Src/a.md", { crash: true });
  assert.equal(interrupted.phase, "staging");
  // Something of the user's appears where b.md's images would go.
  const bAssets = markdownAssetsDirectoryPathFromParts("Dst", ["b.md"]);
  await mkdir(bAssets, { recursive: true });
  await writeFile(path.join(bAssets, "keep.png"), "mine");

  const stopped = await resumeMigration(interrupted.id, "stop");
  assert.deepEqual(stopped.moved, []);
  assert.equal(await read(path.join(bAssets, "keep.png")), "mine");
  assert.equal(await read(filePathFromParts("Src", ["b.md"])), "b");
}));

test("staging refuses a folder that appeared since the review, and removes nothing of it", () => withLibrary(async () => {
  await file("Src/a.md", "a");
  await file("Src/b.md", "b");
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.md", "Src/b.md"], destination: { notebook: "Dst" } };
  const plan = await planMigration(request);
  const bAssets = markdownAssetsDirectoryPathFromParts("Dst", ["b.md"]);
  // After the first note is staged and before the second begins, a folder appears where the second's images would go.
  setMigrationFaultForTests((fault) => {
    if (fault !== "staged:Src/a.md") return;
    mkdirSync(bAssets, { recursive: true });
    writeFileSync(path.join(bAssets, "keep.png"), "mine");
  });
  try { await assert.rejects(runMigration(request, plan.token), /appeared since the migration was reviewed/); }
  finally { setMigrationFaultForTests(null); }
  assert.equal(await read(path.join(bAssets, "keep.png")), "mine");
  assert.deepEqual(await listInterruptedMigrations(), []);
  assert.equal(await read(filePathFromParts("Src", ["b.md"])), "b");
}));

test("a finalize step interrupted before its first write runs again on resume", () => withLibrary(async () => {
  await file("Src/a.md", "a");
  await setStarredFilePath("Src/a.md", true);
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.md"], destination: { notebook: "Dst" } };
  const interrupted = await interruptAt(request, "finalize:records");
  assert.equal(interrupted.phase, "finalizing");
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Src/a.md"], "the records step had not written yet");
  const resumed = await resumeMigration(interrupted.id, "continue");
  assert.equal(resumed.state, "done");
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Dst/a.md"]);
  assert.deepEqual(resumed.bookkeeping, []);
}));

test("a finalize step that throws is retried on resume, and its note goes when the retry works", () => withLibrary(async () => {
  await file("Src/a.md", "a");
  await setStarredFilePath("Src/a.md", true);
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.md"], destination: { notebook: "Dst" } };
  const plan = await planMigration(request);
  let failures = 0;
  setMigrationFaultForTests((fault) => { if (fault === "finalizing:records" && failures++ === 0) throw new Error("disk hiccup"); });
  const first = await runMigration(request, plan.token);
  setMigrationFaultForTests(null);
  assert.equal(first.state, "interrupted");
  assert.ok(first.bookkeeping.some((entry) => /records: disk hiccup/.test(entry)));
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Src/a.md"]);

  const [interrupted] = await listInterruptedMigrations();
  const resumed = await resumeMigration(interrupted.id, "continue");
  assert.equal(resumed.state, "done");
  assert.deepEqual(resumed.bookkeeping, []);
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Dst/a.md"]);
}));

test("a finalize step that fails again on resume is passed over with its note kept", () => withLibrary(async () => {
  await file("Src/a.md", "a");
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.md"], destination: { notebook: "Dst" } };
  const plan = await planMigration(request);
  setMigrationFaultForTests((fault) => { if (fault === "finalizing:records") throw new Error("still broken"); });
  const first = await runMigration(request, plan.token);
  assert.equal(first.state, "interrupted");
  const [interrupted] = await listInterruptedMigrations();
  const resumed = await resumeMigration(interrupted.id, "continue");
  setMigrationFaultForTests(null);
  assert.equal(resumed.state, "done");
  assert.ok(resumed.bookkeeping.some((entry) => /records: still broken/.test(entry)));
  assert.deepEqual(await listInterruptedMigrations(), []);
}));

test("resume refuses an unrelated destination file of the same size as a copy", () => withLibrary(async () => {
  await file("Src/a.pdf", "%PDF a");
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.pdf"], destination: { notebook: "Dst" } };
  const interrupted = await interruptAt(request, "published:Src/a.pdf");
  // As if it had been copied across drives: its recorded content identity is the copy's hash.
  await editJournal(interrupted.id, (journal) => { journal.items[0].method = "copy"; journal.items[0].contentHash = sha256("%PDF a"); });
  const destination = filePathFromParts("Dst", ["a.pdf"]);
  await rm(destination);
  await writeFile(destination, "%PDF X");

  const resumed = await resumeMigration(interrupted.id, "continue");
  assert.equal(resumed.state, "interrupted");
  assert.match(resumed.error ?? "", /not the file this migration moved/);
  assert.equal(await read(destination), "%PDF X");
  assert.equal(await read(filePathFromParts("Src", ["a.pdf"])), "%PDF a");
}));

test("resume accepts a copy whose content matches the recorded identity", () => withLibrary(async () => {
  await file("Src/a.pdf", "%PDF a");
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.pdf"], destination: { notebook: "Dst" } };
  const interrupted = await interruptAt(request, "published:Src/a.pdf");
  await editJournal(interrupted.id, (journal) => { journal.items[0].method = "copy"; journal.items[0].contentHash = sha256("%PDF a"); });
  const resumed = await resumeMigration(interrupted.id, "continue");
  assert.equal(resumed.state, "done");
  assert.equal(await read(filePathFromParts("Dst", ["a.pdf"])), "%PDF a");
  assert.ok(!existsSync(filePathFromParts("Src", ["a.pdf"])));
}));

test("a copy with no recorded content identity is not accepted by size alone", () => withLibrary(async () => {
  await file("Src/a.pdf", "%PDF a");
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.pdf"], destination: { notebook: "Dst" } };
  const interrupted = await interruptAt(request, "published:Src/a.pdf");
  await editJournal(interrupted.id, (journal) => { journal.items[0].method = "copy"; });
  const resumed = await resumeMigration(interrupted.id, "continue");
  assert.equal(resumed.state, "interrupted");
  assert.match(resumed.error ?? "", /not the file this migration moved/);
}));
