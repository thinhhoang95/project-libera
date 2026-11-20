import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fsp, { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { seeded, splitLibraryPath, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";
import { directoryModeStatePath } from "../../electron/directory-mode.cjs";
import type { CslItem, ReferenceEntry } from "../../src/lib/references/types";
import { listInterruptedMigrations, planMigration, resumeMigration, runMigration, setMigrationFaultForTests, type MigrationRequest } from "../../src/lib/storage/migration";
import { definitionsPath, filePathFromParts, getAdminRoot } from "../../src/lib/storage/paths";
import { updateReferenceLibrary } from "../../src/lib/storage/references";
import { readWorkspaceMetadata, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";

// Finalization of a migration: citation rewrites that survive a crash, the
// destination states the migration owns, items whose records have not followed,
// a read-only plan (docs/features/notebook-migration.md).

const withLibrary = (run: () => Promise<void>) => withTemporaryLibrary(["Src", "Dst"], run);
const read = (target: string) => readFile(target, "utf8");
const journalFile = (id: string) => path.join(getAdminRoot(), ".libera", "migrations", `${id}.json`);
const NOW = "2024-01-01T00:00:00.000Z";

function entry(id: string, key: string, csl: Partial<CslItem>): ReferenceEntry {
  return {
    id, key, aliases: [], csl: { type: "article-journal", ...csl }, identifiers: {}, provenance: {}, status: "confirmed",
    attachments: [], createdAt: NOW, updatedAt: NOW, fieldUpdatedAt: {},
  };
}

const article = (family: string, year: number, title: string): Partial<CslItem> =>
  ({ author: [{ family, given: "A." }], issued: { "date-parts": [[year]] }, title });

/** The same key for two different works, so the moved note's citation has to change. */
async function clashingLibraries() {
  await updateReferenceLibrary("Src", null, [{ op: "put", entry: entry("s-lee", "lee2018", article("Lee", 2018, "Graph methods for proteins")) }]);
  await updateReferenceLibrary("Dst", null, [{ op: "put", entry: entry("d-lee", "lee2018", article("Leeway", 2018, "Cooking with seaweed")) }]);
}

async function interruptAt(request: MigrationRequest, point: string) {
  const plan = await planMigration(request);
  assert.deepEqual(plan.blockers, []);
  setMigrationFaultForTests((fault) => { if (fault === point) throw new Error("simulated crash"); });
  try { await runMigration(request, plan.token); }
  catch (error) { assert.match((error as Error).message, /simulated crash/); }
  finally { setMigrationFaultForTests(null); }
  const [interrupted] = await listInterruptedMigrations();
  assert.ok(interrupted, "the migration is left interrupted");
  return interrupted;
}

const CITING = "# N\n\nSee [@lee2018].\n";

test("a crash right after a citation rewrite is resumed with the saved key map", () => withLibrary(async () => {
  await clashingLibraries();
  await writeLibraryFile("Src/n.md", CITING);
  const request: MigrationRequest = { source: "Src", paths: ["Src/n.md"], destination: { notebook: "Dst" } };
  const plan = await planMigration(request);
  const destination = filePathFromParts("Dst", ["n.md"]);

  // The rewritten text is published, then the process goes before anything else is saved.
  const rename = fsp.rename;
  let crashed = false;
  mock.method(fsp, "rename", async (from: string, to: string) => {
    await rename(from, to);
    if (to === destination && !crashed) { crashed = true; throw new Error("power cut"); }
  });
  let first;
  try { first = await runMigration(request, plan.token); } finally { mock.restoreAll(); }
  assert.equal(first.state, "interrupted");
  assert.ok(crashed, "the note was rewritten");
  assert.doesNotMatch(await read(destination), /@lee2018\b/, "the citation is already the new key");

  const [interrupted] = await listInterruptedMigrations();
  const journal = JSON.parse(await read(journalFile(interrupted.id))) as { citationRewrites?: { path: string; map: Record<string, string> }[] };
  assert.equal(journal.citationRewrites?.length, 1, "the plan was saved before the text was published");
  assert.deepEqual(Object.keys(journal.citationRewrites![0].map), ["lee2018"]);

  const resumed = await resumeMigration(interrupted.id, "continue");
  assert.equal(resumed.state, "done");
  assert.deepEqual(resumed.references?.drafts.map((draft) => draft.path), ["Dst/n.md"], "the key map is still reported for open drafts");
  assert.deepEqual(Object.keys(resumed.references!.drafts[0].map), ["lee2018"]);
  assert.equal(resumed.check, "clean", JSON.stringify(resumed));
  assert.deepEqual(resumed.bookkeeping, []);
}));

test("a note whose citations were rewritten is the note that moved (a hard-linked one)", () => withLibrary(async () => {
  await clashingLibraries();
  await writeLibraryFile("Src/n.md", CITING);
  const request: MigrationRequest = { source: "Src", paths: ["Src/n.md"], destination: { notebook: "Dst" } };
  const plan = await planMigration(request);
  const result = await runMigration(request, plan.token);
  assert.equal(result.state, "done");
  assert.equal(result.references?.renamed.length, 1);
  assert.deepEqual(result.missing, []);
  assert.equal(result.check, "clean", JSON.stringify(result));
}));

test("a staged note rewritten by citations survives a finalize retry", () => withLibrary(async () => {
  await clashingLibraries();
  await writeLibraryFile("Src/img/fig.png", Buffer.from("png-bytes"));
  await writeLibraryFile("Src/n.md", `${CITING}\n![](/api/files/raw/Src/img/fig.png)\n`);
  const request: MigrationRequest = { source: "Src", paths: ["Src/img/fig.png", "Src/n.md"], destination: { notebook: "Dst" } };
  const interrupted = await interruptAt(request, "finalize:history");
  assert.equal(interrupted.phase, "finalizing");
  const text = await read(filePathFromParts("Dst", ["n.md"]));
  assert.doesNotMatch(text, /@lee2018\b/);
  assert.match(text, /\/api\/files\/raw\/Dst\/img\/fig\.png/);

  const resumed = await resumeMigration(interrupted.id, "continue");
  assert.equal(resumed.state, "done");
  assert.deepEqual(resumed.missing, []);
  assert.equal(resumed.check, "clean", JSON.stringify(resumed));
}));

/** A published note whose sidecar move fails, with Stop chosen, and the finalization interrupted. */
async function stoppedWithUnfollowedSidecar() {
  await writeLibraryFile("Src/a.md", "a\n");
  await setStarredFilePath("Src/a.md", true);
  const from = splitLibraryPath("Src/a.md");
  await writeAt(definitionsPath(from.notebook, from.parts), seeded("note-definitions"));
  const request: MigrationRequest = { source: "Src", paths: ["Src/a.md"], destination: { notebook: "Dst" } };
  const interrupted = await interruptAt(request, "published:Src/a.md");

  const target = definitionsPath("Dst", ["a.md"]);
  // A record is now published by linking it into place (exclusively), with a rename only as the fallback: fail both.
  let failing = true;
  for (const name of ["rename", "link"] as const) {
    const original = fsp[name] as (source: string, to: string) => Promise<void>;
    mock.method(fsp, name, async (source: string, to: string) => {
      if (failing && to === target) throw Object.assign(new Error("disk error"), { code: "EIO" });
      return original(source, to);
    });
  }
  setMigrationFaultForTests((fault) => { if (fault === "finalize:folders") throw new Error("simulated crash"); });
  try { await resumeMigration(interrupted.id, "stop"); }
  catch (error) { assert.match((error as Error).message, /simulated crash/); }
  finally { setMigrationFaultForTests(null); }
  assert.ok(!existsSync(filePathFromParts("Src", ["a.md"])), "the old copy is gone");
  return { interrupted, target, release: () => { failing = false; } };
}

test("resume does not call a published note finished while its sidecar is still at the old path", () => withLibrary(async () => {
  const { interrupted, target } = await stoppedWithUnfollowedSidecar();
  try {
    const resumed = await resumeMigration(interrupted.id, "continue");
    assert.equal(resumed.state, "done");
    assert.deepEqual(resumed.moved.filter((move) => move.incomplete).map((move) => move.from), ["Src/a.md"]);
    assert.notEqual(resumed.check, "clean");
    assert.ok(!existsSync(target));
    assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Src/a.md"], "records of an unfinished item are not moved");
  } finally { mock.restoreAll(); }
}));

test("resume finishes the sidecars of a published note before its records follow", () => withLibrary(async () => {
  const { interrupted, target, release } = await stoppedWithUnfollowedSidecar();
  release();
  try {
    const resumed = await resumeMigration(interrupted.id, "continue");
    assert.equal(resumed.state, "done");
    assert.deepEqual(resumed.moved.filter((move) => move.incomplete), []);
    assert.equal(await read(target), seeded("note-definitions"));
    assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Dst/a.md"]);
  } finally { mock.restoreAll(); }
}));

test("planning writes nothing, not even the upgrade of a linked folder's old state", () => withLibrary(async () => {
  await writeLibraryFile("Src/a.md", "a\n");
  const project = await mkdtemp(path.join(os.tmpdir(), "libera-linked-"));
  try {
    await writeFile(path.join(project, "readme.md"), "# Project\n");
    const state = JSON.stringify({ version: 1, current: project, recent: [project] });
    await writeAt(directoryModeStatePath(getAdminRoot()), state);

    const plan = await planMigration({ source: "Src", paths: ["Src/a.md"], destination: { notebook: "Dst" } });
    assert.deepEqual(plan.blockers, []);
    assert.equal(await read(directoryModeStatePath(getAdminRoot())), state, "the old state file is as it was");
    assert.deepEqual(await readdir(project), ["readme.md"], "no identity marker in the linked folder");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}));
