import assert from "node:assert/strict";
import { existsSync, mkdirSync, promises as fs, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  FileBusyError,
  WriteCancelledError,
  contentGuard,
  flushToDisk,
  movePathUnique,
  sha256,
  writeFileAtomic,
  writeFileUnique,
} from "../../electron/collab/notebooks/fs-ops";
import { tempRoot } from "./support/notebooks-harness";

const busy = () => Object.assign(new Error("injected sharing violation"), { code: "EBUSY" });

test("DATA-13: a rename that stays busy never overwrites the live file in place", { timeout: 30_000 }, async () => {
  const temp = tempRoot("libera-audit-busy-");
  const target = path.join(temp.dir, "note.md");
  const rename = fs.rename;
  const copyFile = fs.copyFile;
  let copies = 0;
  try {
    writeFileSync(target, "live bytes\n");
    fs.rename = async (from, to) => {
      if (to === target) throw busy();
      return rename(from, to);
    };
    fs.copyFile = async (...args: Parameters<typeof copyFile>) => { copies += 1; return copyFile(...args); };
    await assert.rejects(writeFileAtomic(target, Buffer.from("new bytes\n")), (error) => error instanceof FileBusyError && error instanceof WriteCancelledError);
    assert.equal(copies, 0, "no in-place copy fallback");
    assert.equal(readFileSync(target, "utf8"), "live bytes\n");
    assert.deepEqual(readdirSync(temp.dir), ["note.md"], "staged bytes are removed; callers retry from authority");
    // Once the lock clears, the same call succeeds atomically.
    fs.rename = rename;
    await writeFileAtomic(target, Buffer.from("new bytes\n"));
    assert.equal(readFileSync(target, "utf8"), "new bytes\n");
  } finally { fs.rename = rename; fs.copyFile = copyFile; temp.cleanup(); }
});

test("DATA-12: an archive name taken between availableName and the move is never overwritten", async () => {
  const temp = tempRoot("libera-audit-archive-");
  const archive = path.join(temp.dir, "_archive");
  const source = path.join(temp.dir, "a.txt");
  const link = fs.link;
  let raced = false;
  try {
    mkdirSync(archive);
    writeFileSync(source, "source bytes\n");
    fs.link = async (from, to) => {
      if (!raced && path.basename(String(to)) === "a.txt") {
        raced = true;
        writeFileSync(String(to), "racer bytes\n");
      }
      return link(from, to);
    };
    const moved = await movePathUnique(source, archive, "a.txt", { root: temp.dir, canCommit: async () => true });
    assert.equal(path.basename(moved), "a (2).txt");
    assert.equal(readFileSync(path.join(archive, "a.txt"), "utf8"), "racer bytes\n");
    assert.equal(readFileSync(moved, "utf8"), "source bytes\n");
    assert.equal(existsSync(source), false);
  } finally { fs.link = link; temp.cleanup(); }
});

test("DATA-12: archive publication falls back to a claimed name where hard links are unsupported", async () => {
  const temp = tempRoot("libera-audit-nolink-");
  const archive = path.join(temp.dir, "_archive");
  const source = path.join(temp.dir, "a.txt");
  const link = fs.link;
  try {
    mkdirSync(archive);
    writeFileSync(source, "source bytes\n");
    writeFileSync(path.join(archive, "a.txt"), "older\n");
    fs.link = async () => { throw Object.assign(new Error("no links"), { code: "EPERM" }); };
    const moved = await movePathUnique(source, archive, "a.txt");
    assert.equal(path.basename(moved), "a (2).txt");
    assert.equal(readFileSync(moved, "utf8"), "source bytes\n");
    assert.equal(readFileSync(path.join(archive, "a.txt"), "utf8"), "older\n");
    const written = await writeFileUnique(archive, "a.txt", Buffer.from("recovery\n"));
    assert.equal(path.basename(written), "a (3).txt");
    assert.deepEqual(readdirSync(archive).sort(), ["a (2).txt", "a (3).txt", "a.txt"]);
  } finally { fs.link = link; temp.cleanup(); }
});

test("DATA-12: a folder is archived under a claimed name and a racing folder is kept", async () => {
  const temp = tempRoot("libera-audit-folder-");
  const archive = path.join(temp.dir, "_archive");
  const source = path.join(temp.dir, "dir");
  try {
    mkdirSync(archive);
    mkdirSync(source);
    writeFileSync(path.join(source, "inner.txt"), "inner\n");
    mkdirSync(path.join(archive, "dir"));
    writeFileSync(path.join(archive, "dir", "other.txt"), "other\n");
    const moved = await movePathUnique(source, archive, "dir");
    assert.equal(path.basename(moved), "dir (2)");
    assert.equal(readFileSync(path.join(moved, "inner.txt"), "utf8"), "inner\n");
    assert.equal(readFileSync(path.join(archive, "dir", "other.txt"), "utf8"), "other\n");
  } finally { temp.cleanup(); }
});

test("DATA-12: a source replaced after the archive link is left alone", async () => {
  const temp = tempRoot("libera-audit-replaced-");
  const archive = path.join(temp.dir, "_archive");
  const source = path.join(temp.dir, "a.txt");
  const link = fs.link;
  try {
    mkdirSync(archive);
    writeFileSync(source, "old\n");
    fs.link = async (from, to) => {
      await link(from, to);
      await fs.rm(source);
      writeFileSync(source, "newer input\n");
    };
    const moved = await movePathUnique(source, archive, "a.txt");
    assert.equal(readFileSync(moved, "utf8"), "old\n");
    assert.equal(readFileSync(source, "utf8"), "newer input\n", "the new file is not unlinked");
  } finally { fs.link = link; temp.cleanup(); }
});

test("DATA-12: the content guard rejects a file that changed while it was being hashed", async () => {
  const temp = tempRoot("libera-audit-guard-");
  const target = path.join(temp.dir, "note.md");
  const readFile = fs.readFile;
  try {
    writeFileSync(target, "observed\n");
    const guard = contentGuard(target, sha256(Buffer.from("observed\n")), { root: temp.dir, canCommit: async () => true });
    assert.equal(await guard.canCommit(), true);
    fs.readFile = (async (...args: Parameters<typeof readFile>) => {
      const bytes = await readFile(...args);
      const later = new Date(Date.now() + 5000);
      utimesSync(target, later, later);
      return bytes;
    }) as typeof fs.readFile;
    assert.equal(await guard.canCommit(), false);
  } finally { fs.readFile = readFile; temp.cleanup(); }
});

test("DATA-14: the durability barrier syncs files and folders, and surfaces a real file failure", async () => {
  const temp = tempRoot("libera-audit-flush-");
  const open = fs.open;
  const opened: string[] = [];
  try {
    mkdirSync(path.join(temp.dir, "sub"));
    const file = path.join(temp.dir, "sub", "a.bin");
    writeFileSync(file, "bytes");
    await flushToDisk([file, path.join(temp.dir, "sub", "missing.bin")], [path.join(temp.dir, "sub"), temp.dir, path.join(temp.dir, "gone")]);
    fs.open = (async (...args: Parameters<typeof open>) => { opened.push(String(args[0])); return open(...args); }) as typeof fs.open;
    await flushToDisk([file], [path.join(temp.dir, "sub")]);
    assert.deepEqual(opened, [file, path.join(temp.dir, "sub")].filter((item) => process.platform !== "win32" || item === file));
    fs.open = (async (target: Parameters<typeof open>[0], ...rest: unknown[]) => {
      if (String(target) === file) throw Object.assign(new Error("disk failure"), { code: "EIO" });
      return (open as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
    }) as typeof fs.open;
    await assert.rejects(flushToDisk([file], []), /disk failure/);
  } finally { fs.open = open; temp.cleanup(); }
});
