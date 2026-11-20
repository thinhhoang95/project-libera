import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fsp, { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import test, { mock } from "node:test";
import { writePdfAnnotations } from "../../src/lib/storage/annotations";
import { audioPeaksPath, notebookPath, pdfAnnotationsPath } from "../../src/lib/storage/paths";
import { findOrphanedSidecars } from "../../src/lib/storage/sidecars";
import { pruneAudioSidecars } from "../../src/lib/storage/transcripts";
import { getTree } from "../../src/lib/storage/tree";
import type { LiberaTreeNode } from "../../src/lib/types";
import { seeded, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

// Tree upkeep after files are moved outside the app (Explorer, Finder, a sync
// client): which folder a record belongs to, which files can take it over,
// and a refresh that meets folders changing under it.

const PDF = "%PDF-1.4 moved";
const note = (text: string) => [{ type: "text", id: text, pageNumber: 1, text, rect: { x: 0, y: 0, width: 0.1, height: 0.1 } }];
const code = (value: string) => Object.assign(new Error(value), { code: value });
const namesOf = (nodes: LiberaTreeNode[]): string[] => nodes.flatMap((node) => node.kind === "file" ? [node.path] : [node.path, ...namesOf(node.children)]);

/** Runs `task` with `fsp.readdir` or `fsp.stat` answering `fake` for some paths and the real thing for the rest. */
async function withFake(method: "readdir" | "stat", fake: (target: string) => Promise<unknown> | undefined, task: () => Promise<void>) {
  const original = fsp[method] as (...args: unknown[]) => Promise<unknown>;
  mock.method(fsp, method, (...args: unknown[]) => fake(String(args[0])) ?? original(...args));
  try { await task(); } finally { mock.restoreAll(); }
}

test("F33: a case-only or Unicode-normalization ancestor rename makes the sidecar an orphan, as the tree sees it", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/Folder/Paper.pdf", PDF);
  await writePdfAnnotations("Nb/Folder/Paper.pdf", note("kept"));
  await rename(path.join(notebookPath("Nb"), "Folder"), path.join(notebookPath("Nb"), "folder"));
  // On a case-insensitive disk `stat` still answers for `Folder/Paper.pdf`; the folder's own listing does not.
  assert.deepEqual((await findOrphanedSidecars("Nb")).map((orphan) => orphan.filePath), ["Nb/Folder/Paper.pdf"]);

  await writeLibraryFile("Nb/été/Paper.pdf", PDF);
  await writePdfAnnotations("Nb/été/Paper.pdf", note("accents"));
  await rename(path.join(notebookPath("Nb"), "été"), path.join(notebookPath("Nb"), "été"));
  assert.ok((await findOrphanedSidecars("Nb")).some((orphan) => orphan.filePath === "Nb/été/Paper.pdf"));
}));

test("F38: upkeep counts the files in a hidden archive, so a visible copy is not taken for the moved file", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a.pdf", PDF);
  await writePdfAnnotations("Nb/a.pdf", note("mine"));
  await mkdir(path.join(notebookPath("Nb"), "_archive"));
  await rename(path.join(notebookPath("Nb"), "a.pdf"), path.join(notebookPath("Nb"), "_archive", "a.pdf"));
  await writeLibraryFile("Nb/copy.pdf", PDF);

  await getTree();
  assert.ok(!existsSync(pdfAnnotationsPath("Nb", ["copy.pdf"])), "two identical files: neither is the moved one");
  assert.ok(existsSync(pdfAnnotationsPath("Nb", ["a.pdf"])));

  // With one candidate left, the archived file (which the rail hides) is the match.
  await rm(path.join(notebookPath("Nb"), "copy.pdf"));
  await getTree();
  assert.ok(existsSync(pdfAnnotationsPath("Nb", ["_archive", "a.pdf"])));
}));

test("F38/F42: an unreadable folder defers reattachment instead of declaring the visible copy unique", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a.pdf", PDF);
  await writePdfAnnotations("Nb/a.pdf", note("mine"));
  await mkdir(path.join(notebookPath("Nb"), "locked"));
  await rename(path.join(notebookPath("Nb"), "a.pdf"), path.join(notebookPath("Nb"), "locked", "a.pdf"));
  await writeLibraryFile("Nb/copy.pdf", PDF);
  const locked = path.join(notebookPath("Nb"), "locked");

  await withFake("readdir", (target) => target === locked ? Promise.reject(code("EACCES")) : undefined, async () => {
    const tree = await getTree();
    assert.equal(tree.incomplete, true);
    assert.ok(namesOf(tree.notebooks[0].children).includes("Nb/copy.pdf"), "the rest still shows");
    assert.ok(!existsSync(pdfAnnotationsPath("Nb", ["copy.pdf"])));
  });

  await rm(path.join(notebookPath("Nb"), "copy.pdf"));
  const tree = await getTree();
  assert.equal(tree.incomplete, undefined);
  assert.ok(existsSync(pdfAnnotationsPath("Nb", ["locked", "a.pdf"])), "seen in full, the one file takes it");
}));

test("F42: a child that races away between readdir and stat leaves the other notebooks refreshing", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  await writeLibraryFile("Nb/keep.md", "keep");
  await writeLibraryFile("Other/o.md", "o");
  await mkdir(path.join(notebookPath("Nb"), "gone"));
  await mkdir(path.join(notebookPath("Nb"), "locked"));
  await writeAt(path.join(notebookPath("Nb"), "locked", "x.md"), "x");
  const gone = path.join(notebookPath("Nb"), "gone");
  const locked = path.join(notebookPath("Nb"), "locked");

  await withFake("stat", (target) => target === gone ? rm(gone, { recursive: true }).then(() => Promise.reject(code("ENOENT"))) : undefined, async () => {
    const tree = await getTree();
    const paths = tree.notebooks.flatMap((notebook) => namesOf(notebook.children));
    assert.ok(paths.includes("Nb/keep.md") && paths.includes("Other/o.md"));
    assert.ok(!paths.includes("Nb/gone"));
    assert.equal(tree.incomplete, true);
  });

  await withFake("readdir", (target) => target === locked ? Promise.reject(code("EACCES")) : undefined, async () => {
    const tree = await getTree();
    const nb = tree.notebooks.find((notebook) => notebook.name === "Nb")!;
    assert.deepEqual(namesOf(nb.children).sort(), ["Nb/keep.md", "Nb/locked"], "an unreadable folder shows empty");
    assert.equal(tree.incomplete, true);
  });

  assert.equal((await getTree()).incomplete, undefined);
}));

test("F41: a directory at the recording's path is not the recording, and a recording that returns keeps its waveform", () => withTemporaryLibrary(["Nb"], async () => {
  await writeAt(audioPeaksPath("Nb", ["dir.m4a"]), seeded("peaks"));
  await mkdir(path.join(notebookPath("Nb"), "dir.m4a"));
  await pruneAudioSidecars("Nb");
  assert.ok(!existsSync(audioPeaksPath("Nb", ["dir.m4a"])), "a folder named like a recording leaves no waveform behind");

  await writeLibraryFile("Nb/back.m4a", "audio");
  await writeAt(audioPeaksPath("Nb", ["back.m4a"]), seeded("peaks"));
  const source = path.join(notebookPath("Nb"), "back.m4a");
  let calls = 0;
  // The first look says the file is not there (a sync client is replacing it); by the second it is back.
  await withFake("stat", (target) => target === source && calls++ === 0 ? Promise.reject(code("ENOENT")) : undefined, async () => {
    await pruneAudioSidecars("Nb");
  });
  assert.ok(calls >= 2, "the source is looked at again before the waveform goes");
  assert.ok(existsSync(audioPeaksPath("Nb", ["back.m4a"])));
}));
