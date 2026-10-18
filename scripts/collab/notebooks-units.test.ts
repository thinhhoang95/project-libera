// Pure parts of the shared-notebook service: minimal text diffs, the
// manifest-to-disk layout (case clashes, refused paths), path containment,
// ignore rules, invitation parsing and folder names.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { computeLayout } from "../../electron/collab/notebooks/layout";
import { PathRefusedError, decodeText, isIgnoredName, isShareablePath, resolveInside } from "../../electron/collab/notebooks/fs-ops";
import { folderNameFor, invitationToken } from "../../electron/collab/notebooks/service";
import { applyReplacements, diffText } from "../../electron/collab/notebooks/text-diff";
import { SHARED_MARKER_FILE as GUARD_MARKER } from "../../src/lib/collab/shared-notebook";
import { SHARED_MARKER_FILE as HOST_MARKER } from "../../electron/collab/notebooks/fs-ops";
import type { ManifestEntry } from "../../src/lib/collab/protocol/schema";

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test("diffText round-trips random edits", () => {
  const random = seeded(7);
  const alphabet = ["a", "b", "\n", "\r\n", " ", "é", "😀", "x\n"];
  for (let round = 0; round < 500; round += 1) {
    let before = "";
    const length = Math.floor(random() * 60);
    for (let index = 0; index < length; index += 1) before += alphabet[Math.floor(random() * alphabet.length)];
    let after = before;
    const edits = Math.floor(random() * 4);
    for (let index = 0; index < edits; index += 1) {
      const at = Math.floor(random() * (after.length + 1));
      const remove = Math.floor(random() * 4);
      const insert = alphabet[Math.floor(random() * alphabet.length)].repeat(Math.floor(random() * 3));
      after = after.slice(0, at) + insert + after.slice(at + remove);
    }
    // Lone surrogates from the random slicing are not real text; skip them.
    if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(before + after)) continue;
    const replacements = diffText(before, after);
    assert.equal(applyReplacements(before, replacements), after, JSON.stringify({ before, after }));
    for (let index = 1; index < replacements.length; index += 1) assert.ok(replacements[index].start >= replacements[index - 1].end);
  }
});

test("diffText touches only what changed, line by line", () => {
  const lines = Array.from({ length: 2000 }, (_, index) => `line ${index}\n`);
  const before = lines.join("");
  const changed = [...lines];
  changed[10] = "line ten\n";
  changed[1500] = "line 1500 edited\n";
  changed.splice(900, 1);
  const after = changed.join("");
  const replacements = diffText(before, after);
  assert.equal(applyReplacements(before, replacements), after);
  assert.equal(replacements.length, 3);
  const touched = replacements.reduce((total, edit) => total + (edit.end - edit.start) + edit.text.length, 0);
  assert.ok(touched < 40, `only a few characters change (${touched})`);
  assert.deepEqual(diffText("same", "same"), []);
  // An emoji edit never splits a surrogate pair.
  const emoji = diffText("a😀b", "a😃b");
  assert.equal(applyReplacements("a😀b", emoji), "a😃b");
  assert.equal(emoji[0].end - emoji[0].start, 2);
});

function entry(fileId: string, filePath: string, createdAt: number, kind: ManifestEntry["kind"] = "doc"): ManifestEntry {
  return {
    fileId,
    path: filePath,
    kind,
    ...(kind === "doc" ? { docId: `doc_${fileId}`, docKind: "markdown" as const } : {}),
    ...(kind === "blob" ? { blobHash: "0".repeat(64) } : {}),
    createdBy: "acc",
    createdAt,
    updatedAt: createdAt,
  };
}

test("computeLayout resolves case-insensitive clashes deterministically", () => {
  const entries = [
    entry("fil_b", "Notes/readme.md", 2),
    entry("fil_a", "notes/README.md", 1),
    entry("fil_c", "NOTES/Readme.md", 2),
    entry("fil_d", "notes", 3, "folder"),
    entry("fil_e", "notes.md", 4),
    entry("fil_f", "Notes.MD", 5),
    entry("fil_g", "data", 6, "blob"),
    entry("fil_h", "data/inner.md", 7),
  ];
  const forward = computeLayout(entries);
  const backward = computeLayout([...entries].reverse());
  assert.deepEqual([...forward.paths.entries()].sort(), [...backward.paths.entries()].sort());
  assert.equal(forward.paths.get("fil_a"), "notes/README.md");
  assert.equal(forward.paths.get("fil_b"), "notes/readme (2).md");
  assert.equal(forward.paths.get("fil_c"), "notes/Readme (3).md");
  assert.equal(forward.paths.get("fil_d"), "notes");
  assert.equal(forward.paths.get("fil_e"), "notes.md");
  assert.equal(forward.paths.get("fil_f"), "Notes (2).MD");
  // A folder needs "data", so the blob that claims it moves aside.
  assert.equal(forward.paths.get("fil_h"), "data/inner.md");
  assert.equal(forward.paths.get("fil_g"), "data (2)");
  // No two files share a disk path, and no file takes a folder's name, on a case-insensitive disk.
  const files = [...forward.paths.entries()].filter(([fileId]) => fileId !== "fil_d").map(([, value]) => value.toLowerCase());
  assert.equal(new Set(files).size, files.length);
  for (const directory of forward.directories) assert.ok(!files.includes(directory.toLowerCase()));
});

test("computeLayout refuses unsafe and reserved paths", () => {
  const layout = computeLayout([
    entry("fil_1", "../escape.md", 1),
    entry("fil_2", "/abs.md", 1),
    entry("fil_3", "C:/drive.md", 1),
    entry("fil_4", "con.txt", 1),
    entry("fil_5", ".libera-shared.json", 1),
    entry("fil_6", "_archive/old.md", 1),
    entry("fil_7", "a\\b.md", 1),
    entry("fil_8", "trailing./x.md", 1),
    entry("fil_9", "ok/fine.md", 1),
    entry("fil_10", ".hidden.md", 1),
  ]);
  assert.deepEqual([...layout.paths.keys()], ["fil_9"]);
  assert.equal(layout.refused.length, 9);
  assert.equal(isShareablePath("ok/fine.md"), true);
  assert.equal(isShareablePath("ok/.DS_Store"), false);
});

test("resolveInside refuses escapes and links", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "libera-inside-"));
  try {
    const outside = mkdtempSync(path.join(tmpdir(), "libera-outside-"));
    mkdirSync(path.join(root, "real"));
    symlinkSync(outside, path.join(root, "link"), "junction");
    assert.equal(await resolveInside(root, "real/a.md"), path.join(root, "real", "a.md"));
    assert.equal(await resolveInside(root, "new/deeper/a.md"), path.join(root, "new", "deeper", "a.md"));
    await assert.rejects(resolveInside(root, "link/a.md"), PathRefusedError);
    await assert.rejects(resolveInside(root, "../a.md"), PathRefusedError);
    await assert.rejects(resolveInside(root, "a/../../b.md"), PathRefusedError);
    rmSync(outside, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watcher ignore rules and text detection", () => {
  for (const name of [".libera-tmp-123", ".libera-shared.json", ".DS_Store", "~$report.docx", "note.md.swp", "file.tmp", "a.md~", "Thumbs.db", "x.crdownload", "notes.md.123.abc.tmp"]) {
    assert.equal(isIgnoredName(name), true, name);
  }
  for (const name of ["notes.md", "main.tex", "figure.png", "_assets"]) assert.equal(isIgnoredName(name), false, name);
  assert.equal(decodeText(Buffer.from("plain\r\ntext")), "plain\r\ntext");
  assert.equal(decodeText(Buffer.from([0x61, 0xff, 0x62])), null, "invalid UTF-8");
  assert.equal(decodeText(Buffer.from([0x61, 0, 0x62])), null, "NUL bytes");
  assert.equal(decodeText(Buffer.from("\ufeffBOM kept", "utf8")), "\ufeffBOM kept");
});

test("invitation links and folder names", () => {
  assert.equal(invitationToken("abc123"), "abc123");
  assert.equal(invitationToken("https://collab.example/invite/tok%2Fen"), "tok/en");
  assert.equal(invitationToken("libera://join?token=xyz"), "xyz");
  assert.throws(() => invitationToken("  "));
  assert.equal(folderNameFor("Thesis: draft/2?"), "Thesis- draft-2-");
  assert.equal(folderNameFor("  ..hidden.  "), "hidden");
  assert.equal(folderNameFor("CON"), "CON_");
  assert.equal(folderNameFor("???"), "---");
  assert.equal(folderNameFor(""), "Shared notebook");
});

test("the host and the Next write guard agree on the marker file", () => {
  assert.equal(HOST_MARKER, GUARD_MARKER);
});
