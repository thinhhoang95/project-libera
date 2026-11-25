import assert from "node:assert/strict";
import fs, { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { closeDirectory, getDirectoryModeSummary, openDirectory, relinkDirectory } from "../../src/lib/storage/directory-mode";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { getAdminRoot, getLinkedFolder, getLinkedFolders, withReadOnlyStorage } from "../../src/lib/storage/paths";
import { getTree } from "../../src/lib/storage/tree";

const require = createRequire(import.meta.url);
const { directoryModeStatePath, readDirectoryModeState, writeDirectoryModeState } = require("../../electron/directory-mode.cjs");

// A linked folder renamed or moved outside the app: what it is still taken
// for, and how it is reconnected without becoming a second notebook.

const MARKER = ".libera-folder.json";

async function withLinkedFolder(run: (paths: { project: string; moved: string }) => Promise<void>) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "libera-linked-move-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = path.join(scratch, "data");
  const project = path.join(scratch, "Thesis");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "notes.md"), "original\n");
  try {
    await createNotebook("Library");
    await run({ project, moved: path.join(scratch, "Moved") });
  } finally {
    mock.restoreAll();
    for (const folder of getDirectoryModeSummary().folders) closeDirectory(folder.name);
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Rewrites the state file as it is, so the cached reading of the linked folders is read again from disk. */
function dropLinkedFoldersCache() {
  const adminRoot = getAdminRoot();
  writeDirectoryModeState(adminRoot, JSON.parse(fs.readFileSync(directoryModeStatePath(adminRoot), "utf8")));
}

test("F43: a directory that replaced the linked one is not the folder, and is not stamped with its id", () => withLinkedFolder(async ({ project, moved }) => {
  const { name } = await openDirectory(project);
  const before = getLinkedFolder(name)!;
  await rename(project, moved);
  await mkdir(project);
  await writeFile(path.join(project, "notes.md"), "a different note with the same name\n");

  dropLinkedFoldersCache();
  const folder = getLinkedFolder(name)!;
  assert.equal(folder.unresolved, true, "not connected: its marker is missing");
  assert.equal(folder.stateRoot, before.stateRoot, "the old state stays with the old id");
  assert.ok(!existsSync(path.join(project, MARKER)), "the replacement carries no marker");
  assert.equal((await getTree()).notebooks.find((notebook) => notebook.name === name)?.folder?.missing, true);

  // Check Notebook reads without writing, and reaches the same answer.
  dropLinkedFoldersCache();
  assert.equal((await withReadOnlyStorage(async () => getLinkedFolder(name)))?.unresolved, true);
  assert.ok(!existsSync(path.join(project, MARKER)));

  // Opening the place again is refused rather than adopted; the renamed folder still reconnects by its marker.
  await assert.rejects(openDirectory(project), /different folder/);
  assert.equal((await openDirectory(moved)).name, name);
  assert.equal(getLinkedFolders().filter((item) => item.name === name).length, 1);
  assert.equal(getLinkedFolder(name)!.path, moved);
  assert.equal(getLinkedFolder(name)!.unresolved, undefined);
}));

test("F43: a marker that names another folder is not accepted for a known location either", () => withLinkedFolder(async ({ project }) => {
  const { name } = await openDirectory(project);
  await writeFile(path.join(project, MARKER), `${JSON.stringify({ version: 1, id: "11111111-2222-4333-8444-555555555555" })}\n`);
  dropLinkedFoldersCache();
  assert.equal(getLinkedFolder(name)!.unresolved, true);
}));

test("F44: relinking a moved folder without a usable marker keeps its alias and state", () => withLinkedFolder(async ({ project, moved }) => {
  const { name } = await openDirectory(project);
  const stateRoot = getLinkedFolder(name)!.stateRoot;
  const id = JSON.parse(await readFile(path.join(project, MARKER), "utf8")).id as string;
  await rename(project, moved);
  await rm(path.join(moved, MARKER));

  // Opening it finds nothing to tie it to the link: a second notebook.
  const second = await openDirectory(moved);
  assert.notEqual(second.name, name);
  closeDirectory(second.name);
  await rm(path.join(moved, MARKER));

  const result = await relinkDirectory(name, moved);
  assert.equal(result.name, name);
  const folder = getLinkedFolder(name)!;
  assert.equal(folder.path, moved);
  assert.equal(folder.stateRoot, stateRoot);
  assert.equal(folder.unresolved, undefined);
  assert.equal(getDirectoryModeSummary().folders.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(moved, MARKER), "utf8")).id, id, "the folder gets its own id back");
  assert.equal((await getTree()).notebooks.find((notebook) => notebook.name === name)?.folder?.missing, undefined);
}));

test("F44: a folder that cannot take a marker is remembered as connected by hand, and a stranger's marker is refused", () => withLinkedFolder(async ({ project, moved }) => {
  const { name } = await openDirectory(project);
  const stateRoot = getLinkedFolder(name)!.stateRoot;
  await rename(project, moved);
  await rm(path.join(moved, MARKER));
  const write = fs.writeFileSync;
  mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => {
    if (String(args[0]).startsWith(moved)) throw Object.assign(new Error("read-only"), { code: "EROFS" });
    return write(...args);
  });

  await relinkDirectory(name, moved);
  mock.restoreAll();
  assert.ok(!existsSync(path.join(moved, MARKER)));
  // As written (before any reading upgrades it); D1 E-M8: a writable reading that stamps the marker clears the flag.
  assert.equal(JSON.parse(fs.readFileSync(directoryModeStatePath(getAdminRoot()), "utf8")).folders[0].unmarked, true);
  dropLinkedFoldersCache();
  const folder = getLinkedFolder(name)!;
  assert.equal(folder.unresolved, undefined, "the hand-made connection holds without a marker");
  assert.equal(folder.stateRoot, stateRoot);

  const stranger = path.join(path.dirname(moved), "Stranger");
  await mkdir(stranger);
  await writeFile(path.join(stranger, MARKER), `${JSON.stringify({ version: 1, id: "11111111-2222-4333-8444-555555555555" })}\n`);
  await assert.rejects(relinkDirectory(name, stranger), /different link/);
  await assert.rejects(relinkDirectory("Nope", stranger), /not linked/);
}));
