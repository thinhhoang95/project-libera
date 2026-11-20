import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import fsp, { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { mock } from "node:test";
import { withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";
import { applyNotebookCleanup } from "../../src/lib/storage/cleanup";
import { claimNotebooksForMigration, migrationJournalDirectory, withNotebookOperation, whenNotebookIdle } from "../../src/lib/storage/migration-fence";
import { listInterruptedMigrations, planMigration, resumeMigration, runMigration, setMigrationFaultForTests, type MigrationRequest } from "../../src/lib/storage/migration";
import { applyNotebookRepair } from "../../src/lib/storage/repair";
import { filePathFromParts, notebookPath } from "../../src/lib/storage/paths";

// Races around notebook migration: publication that must never replace a
// concurrent arrival, a hidden folder retired only as far as it was copied,
// staging rollback that removes only its own files, one name policy for the
// destination, and the coordination with Try to fix, Acknowledge and upkeep.

const withLibrary = (run: () => Promise<void>) => withTemporaryLibrary(["Src", "Dst"], run);
const file = writeLibraryFile;
const read = (target: string) => readFile(target, "utf8");
const at = (library: string) => { const [notebook, ...parts] = library.split("/"); return filePathFromParts(notebook, parts); };
const raw = (library: string) => { const [notebook, ...parts] = library.split("/"); return path.join(notebookPath(notebook), ...parts); };

async function prepare(request: MigrationRequest) {
  const plan = await planMigration(request);
  assert.deepEqual(plan.blockers, []);
  return plan;
}

test.afterEach(() => { mock.restoreAll(); setMigrationFaultForTests(null); });

// ---- F87 ---------------------------------------------------------------------

test("without hard links, a file that arrives at the destination is not replaced", () => withLibrary(async () => {
  await file("Src/a.md", "mine");
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.md"], destination: { notebook: "Dst" } };
  const plan = await prepare(request);
  const destination = at("Dst/a.md");
  // This file system has no hard links, and another file arrives right then.
  mock.method(fsp, "link", async () => {
    await writeFile(destination, "theirs");
    throw Object.assign(new Error("not supported"), { code: "EPERM" });
  });
  const result = await runMigration(request, plan.token);
  mock.restoreAll();
  assert.equal(result.state, "interrupted");
  assert.match(result.error ?? "", /appeared/);
  assert.equal(await read(destination), "theirs");
  assert.equal(await read(at("Src/a.md")), "mine");
}));

test("a hidden folder is not renamed over a folder that arrives just before", () => withLibrary(async () => {
  await file("Src/proj/n.md", "note");
  await writeAt(raw("Src/proj/.hidden/x"), "x");
  const request: MigrationRequest = { source: "Src", paths: ["Src/proj"], destination: { notebook: "Dst" } };
  const plan = await prepare(request);
  const destination = raw("Dst/proj/.hidden");
  const real = fsp.stat;
  let planted = false;
  // The check for the destination has passed; an empty folder appears before the move.
  mock.method(fsp, "stat", async (...args: Parameters<typeof fsp.stat>) => {
    if (!planted && path.resolve(String(args[0])) === path.dirname(destination)) { planted = true; mkdirSync(destination, { recursive: true }); }
    return real(...args);
  });
  const result = await runMigration(request, plan.token).catch((error: Error) => error);
  mock.restoreAll();
  assert.ok(planted, "the arrival was staged");
  assert.ok(result instanceof Error || result.state === "interrupted", "the migration stops instead of replacing it");
  assert.ok(existsSync(destination), "the arrived folder is still there");
  assert.ok(existsSync(raw("Src/proj/.hidden/x")), "the source folder was not moved onto it");
}));

// ---- F88 ---------------------------------------------------------------------

/** A hidden folder that is copied, as when the destination is on another drive. */
async function crossDeviceRequest() {
  await file("Src/proj/n.md", "note");
  await writeAt(raw("Src/proj/.git/HEAD"), "ref: aaaa\n");
  await writeAt(raw("Src/proj/.git/objects/o1"), "object one");
  const request: MigrationRequest = { source: "Src", paths: ["Src/proj"], destination: { notebook: "Dst" } };
  const plan = await prepare(request);
  const destinationDirectory = path.resolve(raw("Dst/proj"));
  const real = fsp.stat;
  const onStaged = () => mock.method(fsp, "stat", async (...args: Parameters<typeof fsp.stat>) => {
    const stats = await real(...args);
    return path.resolve(String(args[0])) === destinationDirectory ? Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { dev: Number(stats.dev) + 1 }) : stats;
  });
  return { request, plan, onStaged };
}

test("a cross-device hidden folder keeps a same-size nested edit and a new entry made after the copy", () => withLibrary(async () => {
  const { request, plan, onStaged } = await crossDeviceRequest();
  setMigrationFaultForTests((point) => {
    if (point === "staged:Src/proj/.git") onStaged();
    if (point === "published:Src/proj/.git") {
      // Same length as before, so a size check passes it; and a file nobody copied.
      writeFileSync(raw("Src/proj/.git/HEAD"), "ref: bbbb\n");
      writeFileSync(raw("Src/proj/.git/new"), "arrived later");
    }
  });
  const result = await runMigration(request, plan.token);
  mock.restoreAll();
  assert.equal(result.state, "interrupted");
  assert.match(result.error ?? "", /changed or arrived/);
  assert.equal(await read(raw("Src/proj/.git/HEAD")), "ref: bbbb\n", "the edited file stays in the source");
  assert.equal(await read(raw("Src/proj/.git/new")), "arrived later");
  assert.ok(!existsSync(raw("Src/proj/.git/objects")), "what was copied unchanged is retired, with its folder");
  assert.equal(await read(raw("Dst/proj/.git/HEAD")), "ref: aaaa\n", "the copy holds what was copied");
  assert.equal(await read(raw("Dst/proj/.git/objects/o1")), "object one");
}));

test("a hidden folder edited to the same size while it is copied is not published", () => withLibrary(async () => {
  const { request, plan, onStaged } = await crossDeviceRequest();
  setMigrationFaultForTests((point) => { if (point === "staged:Src/proj/.git") onStaged(); });
  const realCp = fsp.cp;
  mock.method(fsp, "cp", async (...args: Parameters<typeof fsp.cp>) => {
    await realCp(...args);
    writeFileSync(raw("Src/proj/.git/HEAD"), "ref: bbbb\n");
  });
  const result = await runMigration(request, plan.token);
  mock.restoreAll();
  assert.equal(result.state, "interrupted");
  assert.match(result.error ?? "", /changed while it was being copied/);
  assert.ok(!existsSync(raw("Dst/proj/.git")), "nothing was published");
  assert.equal(await read(raw("Src/proj/.git/HEAD")), "ref: bbbb\n");
}));

// ---- F89 ---------------------------------------------------------------------

test("undoing staging after a crash keeps an image another writer put in the note's asset folder", () => withLibrary(async () => {
  await file("Src/img/fig.png", Buffer.from("png-bytes"));
  await file("Src/n.md", "# N\n\n![](/api/files/raw/Src/img/fig.png)\n");
  const request: MigrationRequest = { source: "Src", paths: ["Src/n.md"], destination: { notebook: "Dst" } };
  const plan = await prepare(request);
  setMigrationFaultForTests((point) => { if (point === "staged:Src/n.md") throw Object.assign(new Error("simulated crash"), { crash: true }); });
  await assert.rejects(runMigration(request, plan.token), /simulated crash/);
  setMigrationFaultForTests(null);

  const [interrupted] = await listInterruptedMigrations();
  const journal = JSON.parse(await read(path.join(migrationJournalDirectory(), `${interrupted.id}.json`))) as { items: { ownedDirectories: string[]; createdImages?: string[] }[] };
  const [directory] = journal.items[0].ownedDirectories;
  assert.ok(journal.items[0].createdImages?.length, "the copied image was recorded as it was made");
  // A sync client delivers the user's own file there.
  await writeFile(path.join(directory, "user.png"), "theirs");

  const resumed = await resumeMigration(interrupted.id, "continue");
  assert.equal(resumed.state, "done");
  assert.equal(await read(path.join(directory, "user.png")), "theirs", "the user's file is kept");
  assert.deepEqual(await readdir(directory), ["user.png"], "only the migration's own image went");
  assert.ok(existsSync(at("Src/n.md")), "the source was never touched");
}));

test("undoing staging removes the folders staging made when nothing else is in them", () => withLibrary(async () => {
  await file("Src/img/fig.png", Buffer.from("png-bytes"));
  await file("Src/n.md", "# N\n\n![](/api/files/raw/Src/img/fig.png)\n");
  const request: MigrationRequest = { source: "Src", paths: ["Src/n.md"], destination: { notebook: "Dst" } };
  const plan = await prepare(request);
  setMigrationFaultForTests((point) => { if (point === "staged:Src/n.md") throw Object.assign(new Error("simulated crash"), { crash: true }); });
  await assert.rejects(runMigration(request, plan.token), /simulated crash/);
  setMigrationFaultForTests(null);
  const [interrupted] = await listInterruptedMigrations();
  await resumeMigration(interrupted.id, "continue");
  assert.ok(!existsSync(path.join(notebookPath("Dst"), "_assets")), "the assets folder it made is gone");
}));

// ---- F93 ---------------------------------------------------------------------

async function isCaseInsensitive() {
  await file("Dst/Probe.txt", "p");
  return existsSync(at("Dst/probe.txt"));
}

test("a destination name that exists under another case is kept free for both files", () => withLibrary(async () => {
  await file("Dst/NOTE.md", "theirs");
  await file("Src/note.md", "mine");
  const plan = await prepare({ source: "Src", paths: ["Src/note.md"], destination: { notebook: "Dst" } });
  assert.deepEqual(plan.items.map((item) => item.to), ["Dst/note-1.md"]);
}));

test("a destination folder under another case is reported on a case-sensitive volume", async (t) => {
  await withLibrary(async () => {
    if (await isCaseInsensitive()) { t.diagnostic("case-insensitive volume: one spelling reaches the other"); return; }
    await mkdir(raw("Dst/Docs"), { recursive: true });
    await file("Src/docs/a.md", "a");
    const plan = await planMigration({ source: "Src", paths: ["Src/docs"], destination: { notebook: "Dst" } });
    assert.ok(plan.blockers.some((blocker) => /differs only in case/.test(blocker)), plan.blockers.join("; "));
  });
});

test("two planned spellings of one folder are reported, each exact path validated", async (t) => {
  await withLibrary(async () => {
    await file("Src/Docs/a.md", "a");
    await mkdir(raw("Src/docs"), { recursive: true });
    if ((await readdir(raw("Src"))).filter((name) => name.toLowerCase() === "docs").length !== 2) { t.diagnostic("case-insensitive volume: the source cannot hold both"); return; }
    await file("Src/docs/b.md", "b");
    const plan = await planMigration({ source: "Src", paths: ["Src/Docs", "Src/docs"], destination: { notebook: "Dst" } });
    assert.ok(plan.blockers.some((blocker) => /differ only in case/.test(blocker)), plan.blockers.join("; "));
  });
});

// ---- F77 ---------------------------------------------------------------------

test("a migration cannot start while Try to fix, Acknowledge or upkeep works on its notebook", () => withLibrary(async () => {
  await file("Src/a.md", "a");
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.md"], destination: { notebook: "Dst" } };
  const plan = await prepare(request);
  await withNotebookOperation("Src", async () => {
    await assert.rejects(runMigration(request, plan.token), /Another operation is working on this notebook/);
  });
  assert.ok(existsSync(at("Src/a.md")), "nothing moved");
  // The hold ends with the operation, also when it fails.
  await assert.rejects(withNotebookOperation("Dst", async () => { throw new Error("boom"); }), /boom/);
  const result = await runMigration(request, plan.token);
  assert.equal(result.state, "done");
}));

test("Try to fix, Acknowledge and upkeep refuse a notebook a migration is about to take", () => withLibrary(async () => {
  const release = claimNotebooksForMigration(["Src", "Dst"]);
  try {
    await assert.rejects(applyNotebookRepair("Src", "token"), /about to be migrated/);
    await assert.rejects(applyNotebookCleanup("Dst", "token"), /about to be migrated/);
    assert.equal(await whenNotebookIdle("Src", async () => { assert.fail("upkeep must not run"); }), false);
  } finally { release(); }
  assert.equal(await whenNotebookIdle("Src", async () => undefined), true);
}));

test("an unreadable journal stops Try to fix, Acknowledge and upkeep, which cannot tell what it involves", () => withLibrary(async () => {
  await mkdir(migrationJournalDirectory(), { recursive: true });
  await writeFile(path.join(migrationJournalDirectory(), "damaged.json"), "{ not json");
  await assert.rejects(applyNotebookRepair("Src", "token"), /journal can't be read/);
  await assert.rejects(applyNotebookCleanup("Src", "token"), /journal can't be read/);
  assert.equal(await whenNotebookIdle("Src", async () => assert.fail("upkeep must not run")), false);
  // A migration is refused too, as before.
  await file("Src/a.md", "a");
  const plan = await planMigration({ source: "Src", paths: ["Src/a.md"], destination: { notebook: "Dst" } });
  assert.ok(plan.blockers.some((blocker) => /can't be read/.test(blocker)));
}));
