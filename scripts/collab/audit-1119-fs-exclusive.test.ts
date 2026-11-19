// Exclusive publication primitives shared by the 2026-11-19 sync audit fixes:
// a move or a write at an exact name never replaces what is already there.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DestinationTakenError, movePathExclusive, writeFileExclusive } from "../../electron/collab/notebooks/fs-ops";

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "libera-exclusive-"));
}

test("movePathExclusive moves a file to a free name and creates its folder", async () => {
  const root = scratch();
  try {
    writeFileSync(path.join(root, "a.md"), "A");
    await movePathExclusive(path.join(root, "a.md"), path.join(root, "sub", "b.md"));
    assert.equal(readFileSync(path.join(root, "sub", "b.md"), "utf8"), "A");
    assert.equal(existsSync(path.join(root, "a.md")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("movePathExclusive refuses an occupied destination and keeps both files", async () => {
  const root = scratch();
  try {
    writeFileSync(path.join(root, "a.md"), "A");
    writeFileSync(path.join(root, "b.md"), "B");
    await assert.rejects(movePathExclusive(path.join(root, "a.md"), path.join(root, "b.md")), DestinationTakenError);
    assert.equal(readFileSync(path.join(root, "a.md"), "utf8"), "A");
    assert.equal(readFileSync(path.join(root, "b.md"), "utf8"), "B");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("movePathExclusive refuses a folder onto an existing folder", async () => {
  const root = scratch();
  try {
    mkdirSync(path.join(root, "from"));
    writeFileSync(path.join(root, "from", "x.md"), "X");
    mkdirSync(path.join(root, "to"));
    await assert.rejects(movePathExclusive(path.join(root, "from"), path.join(root, "to")), DestinationTakenError);
    assert.equal(readFileSync(path.join(root, "from", "x.md"), "utf8"), "X");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("writeFileExclusive publishes at the exact name and refuses an existing file", async () => {
  const root = scratch();
  try {
    const target = path.join(root, "deep", "note.md");
    const stats = await writeFileExclusive(target, Buffer.from("first"));
    assert.equal(stats.size, 5);
    assert.equal(readFileSync(target, "utf8"), "first");
    await assert.rejects(writeFileExclusive(target, Buffer.from("second")), DestinationTakenError);
    assert.equal(readFileSync(target, "utf8"), "first");
    // No staged temp file is left behind either way.
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(path.dirname(target)), ["note.md"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
