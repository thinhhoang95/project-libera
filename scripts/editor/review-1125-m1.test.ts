import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { assertNotebookSound, withTemporaryLibrary, writeLibraryFile } from "./notebook-test-helpers";
import { addReviewThreads, findReview, loadReview } from "../../src/lib/storage/markdown-reviews";
import { listInterruptedMigrations, planMigration, resumeMigration, runMigration, setMigrationFaultForTests, type MigrationRequest } from "../../src/lib/storage/migration";
import { isPathMigrating, migrationJournalDirectory } from "../../src/lib/storage/migration-fence";
import { notebookPath } from "../../src/lib/storage/paths";
import { SIDECAR_KINDS } from "../../src/lib/storage/sidecars";

const withLibrary = (run: () => Promise<void>) => withTemporaryLibrary(["Src", "Dst"], run);
const diskPath = (library: string) => { const [notebook, ...parts] = library.split("/"); return path.join(notebookPath(notebook), ...parts); };

async function migrate(request: MigrationRequest) {
  const plan = await planMigration(request);
  assert.deepEqual(plan.blockers, []);
  return { plan, result: await runMigration(request, plan.token) };
}

test("L-H4: an NFC and an NFD spelling of one name from two folders are planned apart", () => withLibrary(async () => {
  const nfc = "Café.md";
  const nfd = "Café.md";
  await writeLibraryFile(`Src/a/${nfc}`, "one");
  await writeLibraryFile(`Src/b/${nfd}`, "two");
  const request: MigrationRequest = { source: "Src", paths: [`Src/a/${nfc}`, `Src/b/${nfd}`], destination: { notebook: "Dst", flat: true } };
  const plan = await planMigration(request);
  assert.equal(new Set(plan.items.map((item) => item.to.normalize("NFC").toLowerCase())).size, 2, "no two items land on one folded name");
  assert.equal(plan.items.filter((item) => item.renamed).length, 1);
}));

test("L-H6: notes whose sanitized _assets names meet are planned apart and both migrate", () => withLibrary(async () => {
  await writeLibraryFile("Src/a b.md", "one");
  await writeLibraryFile("Src/a-b.md", "two");
  await writeLibraryFile("Src/notes.md", "three");
  await writeLibraryFile("Src/notes.markdown", "four");
  const { plan, result } = await migrate({ source: "Src", paths: ["Src/a b.md", "Src/a-b.md", "Src/notes.md", "Src/notes.markdown"], destination: { notebook: "Dst" } });
  assert.equal(plan.items.filter((item) => item.renamed).length, 2);
  assert.equal(result.state, "done");
  assert.equal(result.moved.length, 4);
  assert.deepEqual(result.remaining, []);
  await assertNotebookSound("Src");
  await assertNotebookSound("Dst");
}));

test("L-M3: parent and child folders selected together are walked once", () => withLibrary(async () => {
  await writeLibraryFile("Src/p/c/x.md", "x");
  await writeLibraryFile("Src/p/y.md", "y");
  const plan = await planMigration({ source: "Src", paths: ["Src/p", "Src/p/c"], destination: { notebook: "Dst" } });
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.folders.map((folder) => folder.from).sort(), ["Src/p", "Src/p/c"]);
  assert.deepEqual(plan.items.map((item) => item.to).sort(), ["Dst/p/c/x.md", "Dst/p/y.md"]);
  assert.equal(plan.items.some((item) => item.renamed), false);
}));

test("L-M3: a cache or an empty ink folder at the destination name does not rename the file", () => withLibrary(async () => {
  await writeLibraryFile("Src/a.pdf", "%PDF-1.4 new");
  const ink = SIDECAR_KINDS.find((kind) => kind.id === "ink")!;
  await mkdir(ink.filePath("Dst", ["a.pdf"]), { recursive: true });
  const plan = await planMigration({ source: "Src", paths: ["Src/a.pdf"], destination: { notebook: "Dst" } });
  assert.equal(plan.items[0].to, "Dst/a.pdf");
  assert.equal(plan.items[0].renamed, false);
}));

test("L-H3: a recording's companion transcript travels with it, and follows its rename on a clash", () => withLibrary(async () => {
  await writeLibraryFile("Src/rec.m4a", "audio");
  await writeLibraryFile("Src/rec.m4a.transcript", "{\"t\":1}");
  await migrate({ source: "Src", paths: ["Src/rec.m4a"], destination: { notebook: "Dst" } });
  assert.equal(await readFile(diskPath("Dst/rec.m4a.transcript"), "utf8"), "{\"t\":1}");
  assert.equal(existsSync(diskPath("Src/rec.m4a.transcript")), false);

  await writeLibraryFile("Src/f/rec.m4a", "audio two");
  await writeLibraryFile("Src/f/rec.m4a.transcript", "{\"t\":2}");
  await writeLibraryFile("Dst/f/rec.m4a", "other audio");
  const { plan } = await migrate({ source: "Src", paths: ["Src/f"], destination: { notebook: "Dst" } });
  const audio = plan.items.find((item) => item.fileType === "audio")!;
  assert.equal(audio.to, "Dst/f/rec-1.m4a");
  assert.equal(await readFile(diskPath("Dst/f/rec-1.m4a.transcript"), "utf8"), "{\"t\":2}");
  assert.equal(existsSync(diskPath("Dst/f/rec.m4a.transcript")), false);
  await assertNotebookSound("Src", { allow: ["transcript"] });
}));

test("L-C2: a moved review is not shadowed by an empty review at the destination", () => withLibrary(async () => {
  const text = "# Note\n\nsome words here\n";
  await writeLibraryFile("Src/n.md", text);
  await addReviewThreads("Src/n.md", text, [{ range: { start: 10, end: 14 }, text: "a comment" }]);
  await loadReview("Dst/n.md", text);
  await migrate({ source: "Src", paths: ["Src/n.md"], destination: { notebook: "Dst" } });
  assert.equal((await findReview("Dst/n.md"))?.threads.length, 1);
  assert.equal(await findReview("Src/n.md"), null);
  await assertNotebookSound("Dst");
}));

test("L-H6: resuming the finalizing phase with an item Stop here kept does not wedge on a 409", () => withLibrary(async () => {
  await writeLibraryFile("Src/a.md", "a");
  await writeLibraryFile("Src/b.md", "b");
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.md", "Src/b.md"], destination: { notebook: "Dst" } };
  const plan = await planMigration(request);
  // The first finalize step fails once and stops, as a crash in the finalizing phase.
  setMigrationFaultForTests((point) => { if (point === "finalize:records") throw Object.assign(new Error("crash"), { crash: true }); });
  await assert.rejects(runMigration(request, plan.token));
  setMigrationFaultForTests(null);
  // An item the disk can no longer account for: its source and its destination are both gone.
  await rm(diskPath("Dst/b.md"), { force: true });
  await rm(diskPath("Src/b.md"), { force: true });
  const [interrupted] = await listInterruptedMigrations();
  assert.ok(interrupted);
  const result = await resumeMigration(interrupted.id, "stop");
  assert.ok(result.bookkeeping.some((text) => text.includes("b.md")));
}));

test("L-C4: an empty, fresh migration lock file is not taken from a writer that is still writing it", () => withLibrary(async () => {
  await mkdir(migrationJournalDirectory(), { recursive: true });
  const lock = path.join(migrationJournalDirectory(), ".lock");
  await writeFile(lock, "");
  await writeLibraryFile("Src/a.md", "a");
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.md"], destination: { notebook: "Dst" } };
  const plan = await planMigration(request);
  await assert.rejects(runMigration(request, plan.token), /Another migration is running/);
  assert.equal(existsSync(lock), true, "the live lock stays");
  // An old one is stale.
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  const result = await runMigration(request, plan.token);
  assert.equal(result.state, "done");
}));

test("L-C4: the fence compares notebook paths by NFC and case", () => withLibrary(async () => {
  await writeLibraryFile("Src/Café.md", "a");
  const request: MigrationRequest = { source: "Src", paths: ["Src/Café.md"], destination: { notebook: "Dst" } };
  const plan = await planMigration(request);
  let seen: boolean[] = [];
  setMigrationFaultForTests((point) => { if (point.startsWith("staged:")) throw Object.assign(new Error("crash"), { crash: true }); });
  await assert.rejects(runMigration(request, plan.token));
  setMigrationFaultForTests(null);
  seen = [await isPathMigrating("Src/Café.md"), await isPathMigrating("Src/Café.md"), await isPathMigrating("SRC/CAFÉ.MD")];
  assert.deepEqual(seen, [true, true, true]);
}));
