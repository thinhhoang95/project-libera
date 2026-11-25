import assert from "node:assert/strict";
import fs, { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { closeDirectory, getDirectoryModeSummary, openDirectory } from "../../src/lib/storage/directory-mode";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { getAdminRoot, getLinkedFolder } from "../../src/lib/storage/paths";
import { assertRepairable } from "../../src/lib/storage/repair";
import { getTree } from "../../src/lib/storage/tree";

const require = createRequire(import.meta.url);
const { directoryModeStatePath, readDirectoryModeState, writeDirectoryModeState } = require("../../electron/directory-mode.cjs");

// D1 (2026-11-25 file-moving review): linked folders and directory mode.
const MARKER = ".libera-folder.json";

async function withLinkedFolder(run: (paths: { project: string; moved: string; scratch: string }) => Promise<void>) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "libera-d1-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = path.join(scratch, "data");
  const project = path.join(scratch, "Thesis");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "notes.md"), "original\n");
  try {
    await createNotebook("Library");
    await run({ project, moved: path.join(scratch, "Moved"), scratch });
  } finally {
    mock.restoreAll();
    for (const folder of getDirectoryModeSummary().folders) closeDirectory(folder.name);
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(scratch, { recursive: true, force: true });
  }
}

const stateOf = () => JSON.parse(fs.readFileSync(directoryModeStatePath(getAdminRoot()), "utf8")) as { folders: Array<Record<string, unknown>> };

test("E-C2: a folder replaced at the same path while the cache is warm is not the linked folder", () => withLinkedFolder(async ({ project, moved }) => {
  const { name } = await openDirectory(project);
  // Warm the cache, with the linked folder as it is.
  assert.equal(getLinkedFolder(name)!.unresolved, undefined);
  assert.doesNotThrow(() => assertRepairable(name));

  await rename(project, moved);
  await mkdir(project);
  await writeFile(path.join(project, "notes.md"), "an unrelated folder\n");

  // No state-file write in between: the cached reading must still notice.
  assert.equal(getLinkedFolder(name)!.unresolved, true);
  assert.ok(!existsSync(path.join(project, MARKER)), "the impostor is not stamped");
  assert.throws(() => assertRepairable(name), /not connected/);
  assert.equal((await getTree()).notebooks.find((notebook) => notebook.name === name)?.folder?.missing, true);
}));

test("E-C2: an impostor that carries another folder's marker is refused too", () => withLinkedFolder(async ({ project, moved }) => {
  const { name } = await openDirectory(project);
  assert.equal(getLinkedFolder(name)!.unresolved, undefined);
  await rename(project, moved);
  await mkdir(project);
  await writeFile(path.join(project, MARKER), `${JSON.stringify({ version: 1, id: "11111111-2222-4333-8444-555555555555" })}\n`);
  assert.equal(getLinkedFolder(name)!.unresolved, true);
  assert.throws(() => assertRepairable(name), /not connected/);
}));

test("E-C2: an unchanged folder is served from the cache", () => withLinkedFolder(async ({ project }) => {
  const { name } = await openDirectory(project);
  const first = getLinkedFolder(name);
  assert.equal(getLinkedFolder(name), first, "same object: no second reading");
}));

test("E-M8: a stale unmarked flag is cleared once the folder carries its marker", () => withLinkedFolder(async ({ project }) => {
  const { name } = await openDirectory(project);
  const state = stateOf();
  state.folders[0].unmarked = true;
  writeDirectoryModeState(getAdminRoot(), state);
  assert.equal(readDirectoryModeState(getAdminRoot()).folders[0].unmarked, undefined, "upgrade clears it");
  assert.equal(stateOf().folders[0].unmarked, undefined);

  // A markerless impostor can no longer ride the stale flag.
  await rm(path.join(project, MARKER));
  assert.equal(getLinkedFolder(name)!.unresolved, true);
}));

test("E-M8: the state file's temp name is unique and created exclusively", () => withLinkedFolder(async ({ project }) => {
  await openDirectory(project);
  const opened: string[] = [];
  const original = fs.openSync;
  mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).endsWith(".tmp")) opened.push(`${String(args[0])}|${String(args[1])}`);
    return original(...args);
  });
  writeDirectoryModeState(getAdminRoot(), stateOf());
  writeDirectoryModeState(getAdminRoot(), stateOf());
  mock.restoreAll();
  assert.equal(opened.length, 2);
  for (const entry of opened) assert.match(entry, /directory-mode\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp\|wx$/i);
  assert.notEqual(opened[0], opened[1]);
  assert.equal(fs.readdirSync(path.dirname(directoryModeStatePath(getAdminRoot()))).filter((file) => file.endsWith(".tmp")).length, 0);
}));

test("E-M8: assertRepairable does not upgrade a legacy linked folder before the token check", () => withLinkedFolder(async ({ project }) => {
  // A folder linked before identity markers: no id, no marker.
  writeDirectoryModeState(getAdminRoot(), { version: 2, folders: [{ name: "Thesis", path: project }], recent: [] });
  const before = fs.readFileSync(directoryModeStatePath(getAdminRoot()), "utf8");
  assert.equal(assertRepairable("Thesis"), "Thesis");
  assert.ok(!existsSync(path.join(project, MARKER)), "no marker stamped by the guard");
  assert.equal(fs.readFileSync(directoryModeStatePath(getAdminRoot()), "utf8"), before, "state file untouched by the guard");
}));

test("E-M8: the same place under another spelling is the same link", () => withLinkedFolder(async ({ project, scratch }) => {
  const { name } = await openDirectory(project);
  const respelled = path.join(scratch, "THESIS");
  if (!existsSync(respelled)) return; // a case-sensitive volume: two names are two folders
  const again = await openDirectory(respelled);
  assert.equal(again.name, name);
  assert.equal(getDirectoryModeSummary().folders.length, 1);
  await assert.rejects(openDirectory(path.join(getAdminRoot().toUpperCase(), "Library")), /already part of your Libera library/);
}));
