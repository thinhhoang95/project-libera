// Audit 2026-11-12 PERM-1 / DATA-9 / MISC-1: manifest ids never name paths,
// bookkeeping is bound to its project, and collision suffixes fit one name.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import * as Y from "yjs";

import { computeLayout, readManifest } from "../../electron/collab/notebooks/layout";
import { deleteBase, emptyState, readBase, readState, writeBase, writeState } from "../../electron/collab/notebooks/state";
import { ManifestKeys, utf8ByteLength, type ManifestEntry } from "../../src/lib/collab/protocol/schema";

function temp(): string {
  return mkdtempSync(path.join(tmpdir(), "libera-audit1112-"));
}

test("PERM-1: readManifest drops entries with malformed ids", () => {
  const doc = new Y.Doc();
  const files = doc.getMap(ManifestKeys.files);
  const record = { path: "a.md", kind: "doc", docKind: "markdown", createdBy: "u", createdAt: 1, updatedAt: 1 };
  files.set("fil_good00000001", { ...record, docId: "doc_good00000001" });
  files.set("fil_evil00000001", { ...record, docId: "../../../../Other/victim" });
  files.set("../fil_evil", { ...record, path: "b.md", docId: "doc_fine00000002" });
  assert.deepEqual([...readManifest(doc).keys()], ["fil_good00000001"]);
});

test("PERM-1: base files can never escape the base directory", async () => {
  const parent = temp();
  try {
    const root = path.join(parent, "NotebookA");
    const sibling = path.join(parent, "Other");
    mkdirSync(path.join(root, ".libera", "collab", "base"), { recursive: true });
    mkdirSync(sibling, { recursive: true });
    const sentinel = path.join(sibling, "victim.txt");
    writeFileSync(sentinel, "keep");
    const escape = "../../../../Other/victim";
    await assert.rejects(deleteBase(root, escape));
    await assert.rejects(readBase(root, escape));
    await assert.rejects(writeBase(root, escape, "x"));
    await assert.rejects(deleteBase(root, "a/b"));
    await assert.rejects(deleteBase(root, ""));
    assert.ok(existsSync(sentinel));
    assert.equal(readdirSync(sibling).length, 1);
    await writeBase(root, "doc_ok000001", "hello");
    assert.equal(await readBase(root, "doc_ok000001"), "hello");
    await deleteBase(root, "doc_ok000001");
    assert.equal(await readBase(root, "doc_ok000001"), null);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("DATA-9: bookkeeping stamped for another project is not trusted", async () => {
  const root = temp();
  try {
    const mine = { projectId: "prj_mine", manifestDocId: "man_mine", folderId: "fld_mine" };
    const state = { ...emptyState(), identity: mine };
    state.layout.fil_one00001 = { path: "a.md", kind: "doc", docId: "doc_one00001", docKind: "markdown" } as never;
    await writeState(root, state);
    assert.deepEqual((await readState(root, undefined, mine)).layout, state.layout);
    const other = await readState(root, undefined, { ...mine, projectId: "prj_other" });
    assert.deepEqual(other.layout, {});
    assert.equal(other.externalAdoptionRequired, true);
    const otherFolder = await readState(root, undefined, { ...mine, folderId: "fld_other" });
    assert.deepEqual(otherFolder.layout, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DATA-9: unstamped bookkeeping from before the stamp is accepted", async () => {
  const root = temp();
  try {
    const legacy = emptyState();
    legacy.layout.fil_one00001 = { path: "a.md", kind: "doc", docId: "doc_one00001", docKind: "markdown" } as never;
    await writeState(root, legacy);
    const read = await readState(root, undefined, { projectId: "prj_mine", manifestDocId: "man_mine" });
    assert.deepEqual(read.layout, legacy.layout);
    assert.equal(read.externalAdoptionRequired, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MISC-1: a collision suffix never pushes a name over 255 bytes", () => {
  const name = `${"é".repeat(124)}.md`;
  assert.ok(utf8ByteLength(name) <= 255);
  const entry = (fileId: string, createdAt: number): ManifestEntry => ({
    fileId, path: name, kind: "doc", docId: `doc_${fileId}`, docKind: "markdown", createdBy: "u", createdAt, updatedAt: createdAt,
  });
  const layout = computeLayout([entry("fil_a00000001", 1), entry("fil_b00000001", 2)]);
  assert.equal(layout.refused.length, 0);
  for (const placed of layout.paths.values()) assert.ok(utf8ByteLength(placed) <= 255, placed);
  assert.equal(new Set([...layout.paths.values()].map((value) => value.toLowerCase())).size, 2);
});

test("MISC-1: a path component over 255 bytes is refused", () => {
  const entry: ManifestEntry = {
    fileId: "fil_c00000001", path: `${"é".repeat(130)}.md`, kind: "doc", docId: "doc_c00000001", docKind: "markdown", createdBy: "u", createdAt: 1, updatedAt: 1,
  };
  assert.equal(computeLayout([entry]).refused.length, 1);
});
