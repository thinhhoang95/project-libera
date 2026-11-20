import assert from "node:assert/strict";
import fsp, { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports, createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { mock, type TestContext } from "node:test";
import { SearchIndexer } from "../../src/lib/search/indexer";
import { getSearchWorker } from "../../src/lib/search/worker-client";
import { searchIndexFile } from "../../src/lib/search/settings";
import { readFileSignature } from "../../src/lib/storage/file-signature";
import { verifyNotebook, type IntegrityReport } from "../../src/lib/storage/integrity";
import { linkIndexUnverified, populateRelatedNotebooks, resetNotebookLinkReadCache } from "../../src/lib/storage/notebook-links";
import { citationIndexPath, refreshNotebookCitations } from "../../src/lib/storage/reference-citations";
import { filePathFromParts } from "../../src/lib/storage/paths";
import { getTree } from "../../src/lib/storage/tree";
import { withTemporaryLibrary, writeLibraryFile } from "./notebook-test-helpers";

type Sqlite = { DatabaseSync: new (file: string) => { exec(sql: string): void; prepare(sql: string): { run(...values: unknown[]): unknown }; close(): void } };
const { DatabaseSync } = createRequire(__filename)("node:sqlite") as Sqlite;

const absolute = (relative: string) => { const [notebook, ...parts] = relative.split("/"); return filePathFromParts(notebook, parts); };
const denied = () => Object.assign(new Error("denied"), { code: "EACCES" });

/** Reads of these paths fail with an access error until `mock.restoreAll()`. */
function denyStat(paths: string[]) {
  const realStat = fsp.stat;
  mock.method(fsp, "stat", (target: string, options?: object) => paths.includes(String(target)) ? Promise.reject(denied()) : realStat(target, options as never));
  syncBuiltinESMExports();
}
function restoreFs() { mock.restoreAll(); syncBuiltinESMExports(); }

// F59: a case-only rename leaves one search row.
async function searchFixture(t: TestContext, run: (context: { indexer: SearchIndexer; directory: string }) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-move-index-"));
  const settings: Record<string, string | undefined> = {
    LIBERA_DATA_DIR: directory, LIBERA_CONFIG_PATH: undefined,
    LIBERA_SEARCH_INDEX_FILE: path.join(directory, "index.sqlite"), LIBERA_SEARCH_DIMENSIONS: "128",
    LIBERA_SEARCH_TEXT_WEIGHTS: path.join(directory, "model_q4.onnx"), LIBERA_SEARCH_VISION_WEIGHTS: "",
    LIBERA_SEARCH_INDEX_IMAGES: "0", LIBERA_SEARCH_BACKGROUND_INDEXING: "1",
    LIBERA_SEARCH_EMBEDDING_INTERVAL_MINUTES: "180", LIBERA_SEARCH_EMBEDDING_ONLY_ON_AC: "0", LIBERA_SEARCH_KEYWORD_INTERVAL_MINUTES: "0",
  };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(settings)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await writeFile(settings.LIBERA_SEARCH_TEXT_WEIGHTS!, "model fixture");
  const indexer = new SearchIndexer();
  t.mock.method(getSearchWorker(), "ensureModel", async () => ({ textDtype: "q4", visionDtype: null, vision: false, loadMs: 0 }));
  t.mock.method(getSearchWorker(), "embed", async (inputs: unknown[]) => inputs.map(() => { const value = new Float32Array(128); value[0] = 1; return value; }));
  try { await run({ indexer, directory }); }
  finally {
    indexer.pause();
    await (indexer as unknown as { running: Promise<void> | null }).running;
    indexer.database()?.close();
    getSearchWorker().stop();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  }
}

test("a targeted update after a case-only rename retires the old spelling", async (t) => {
  await searchFixture(t, async ({ indexer, directory }) => {
    const folder = path.join(directory, "users/admin/Notes");
    await mkdir(folder, { recursive: true });
    const old = path.join(folder, "Paper.md");
    await writeFile(old, "Quantum tunnelling.");
    await indexer.requestScan({ force: true, build: true });
    assert.deepEqual(indexer.database()!.listFiles().map((file) => file.key), ["Notes/Paper.md"]);

    await rename(old, path.join(folder, "paper.md"));
    // On a case-sensitive volume the old name simply does not open; here the aim is the volume that still opens it.
    const aliased = await fsp.stat(old).then(() => true, () => false);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    indexer.notifyChanges(["Notes/Paper.md", "Notes/paper.md"]);
    t.mock.timers.tick(1000);
    await (indexer as unknown as { running: Promise<void> | null }).running;
    assert.deepEqual(indexer.database()!.listFiles().map((file) => file.key), ["Notes/paper.md"], aliased ? "the old spelling opens, and is still retired" : "one row");
  });
});

// F60: the verifier compares the rows' freshness and the destinations' rows.
const rowsOf = (report: IntegrityReport) => report.findings.filter((finding) => finding.check === "indexes").map((finding) => finding.message).sort();

test("a stale row at a reused path and a missing destination row are reported", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a.md", "The note that now lives at the old name.\n");
  await writeLibraryFile("Nb/b.md", "B\n");
  await writeLibraryFile("Nb/moved.md", "The note that moved away.\n");
  const database = searchIndexFile();
  await mkdir(path.dirname(database), { recursive: true });
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE files (path TEXT, source TEXT, notebook TEXT, signature TEXT, status TEXT)");
  const insert = db.prepare("INSERT INTO files VALUES (?, 'library', 'Nb', ?, ?)");
  insert.run("Nb/a.md", "5:1:1:1:1:another file's signature", "ok");
  insert.run("Nb/b.md", await readFileSignature(absolute("Nb/b.md")), "ok");
  db.close();
  const report = await verifyNotebook("Nb");
  assert.deepEqual(rowsOf(report), [
    "Global Search has no entry yet for 1 file; it catches up the next time it runs.",
    "Global Search holds the text of an earlier file for 1 path; it catches up the next time it runs.",
  ]);
}));

test("a row spelled differently from the listed file is reported though the old name still opens", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/paper.md", "P\n");
  const database = searchIndexFile();
  await mkdir(path.dirname(database), { recursive: true });
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE files (path TEXT, source TEXT, notebook TEXT, signature TEXT, status TEXT)");
  const signature = await readFileSignature(absolute("Nb/paper.md"));
  db.prepare("INSERT INTO files VALUES ('Nb/Paper.md', 'library', 'Nb', ?, 'ok'), ('Nb/paper.md', 'library', 'Nb', ?, 'ok')").run(signature, signature);
  db.close();
  assert.deepEqual(rowsOf(await verifyNotebook("Nb")), ["Global Search still lists 1 file no longer in the notebook; it catches up the next time it runs."]);
}));

// F61: an index rebuild keeps what it knows of notes it could not read.
test("the link index keeps entries of unreadable notes and retires them only when they are gone", () => withTemporaryLibrary(["Alpha", "Beta"], async () => {
  resetNotebookLinkReadCache();
  await writeLibraryFile("Alpha/a.md", "[t](../Beta/t.md)\n");
  await writeLibraryFile("Beta/t.md", "target\n");
  const notebooks = async () => (await getTree()).notebooks.filter((notebook) => ["Alpha", "Beta"].includes(notebook.name));
  const first = await notebooks();
  await populateRelatedNotebooks(first);
  const alpha = () => first.find((notebook) => notebook.name === "Alpha")!;
  assert.deepEqual(alpha().relatedNotebookNames, ["Beta"]);
  const indexFile = path.join(path.dirname(absolute("Alpha/a.md")), ".libera", "notebook-links.json");
  const known = await readFile(indexFile, "utf8");

  // The note can't be read this time: its entry stays, and the rebuild says it was incomplete.
  resetNotebookLinkReadCache();
  denyStat([absolute("Alpha/a.md")]);
  try { await populateRelatedNotebooks(first); } finally { restoreFs(); }
  assert.deepEqual(alpha().relatedNotebookNames, ["Beta"]);
  assert.equal(linkIndexUnverified("Alpha"), 1);
  assert.equal(await readFile(indexFile, "utf8"), known);

  // A note the tree did not list (an unreadable folder) is kept the same way.
  for (const notebook of first) notebook.children = notebook.children.filter((node) => node.kind !== "file" || node.name !== "a.md");
  resetNotebookLinkReadCache();
  denyStat([absolute("Alpha/a.md")]);
  try { await populateRelatedNotebooks(first); } finally { restoreFs(); }
  assert.deepEqual(alpha().relatedNotebookNames, ["Beta"]);
  assert.equal(linkIndexUnverified("Alpha"), 1);

  // Confirmed absent: retired, and the rebuild is complete.
  await rm(absolute("Alpha/a.md"));
  resetNotebookLinkReadCache();
  await populateRelatedNotebooks(first);
  assert.deepEqual(alpha().relatedNotebookNames, []);
  assert.equal(linkIndexUnverified("Alpha"), 0);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(indexFile, "utf8")).files), []);
}));

test("the citation index keeps entries of notes in a folder or file it could not read, and retires them when gone", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/sub/x.md", "See [@smith2020].\n");
  await writeLibraryFile("Nb/y.md", "See [@doe2021].\n");
  const first = await refreshNotebookCitations("Nb", { includeArchive: false });
  assert.deepEqual(Object.keys(first.byFile).sort(), ["Nb/sub/x.md", "Nb/y.md"]);

  // A subtree that can't be listed and a note that can't be read.
  const realReaddir = fsp.readdir;
  mock.method(fsp, "readdir", (target: string, ...rest: unknown[]) => String(target) === path.dirname(absolute("Nb/sub/x.md")) ? Promise.reject(denied()) : (realReaddir as (...args: unknown[]) => unknown)(target, ...rest));
  syncBuiltinESMExports();
  denyStat([absolute("Nb/y.md")]);
  try {
    const partial = await refreshNotebookCitations("Nb", { includeArchive: false });
    assert.deepEqual(Object.keys(partial.byFile).sort(), ["Nb/sub/x.md", "Nb/y.md"], "known entries stay");
    assert.equal(partial.stats.unverified, 2);
    // Confirmed absent beats the unreadable folder.
    await rm(absolute("Nb/sub/x.md"));
    const gone = await refreshNotebookCitations("Nb", { includeArchive: false });
    assert.deepEqual(Object.keys(gone.byFile), ["Nb/y.md"]);
  } finally { restoreFs(); }
  const complete = await refreshNotebookCitations("Nb", { includeArchive: false });
  assert.equal(complete.stats.unverified, 0);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(citationIndexPath("Nb"), "utf8")).files), ["Nb/y.md"]);
}));
