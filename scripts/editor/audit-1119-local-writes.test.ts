// Sync audit 2026-11-19, package P10 (findings 9, 11, 16, 17): local file
// writes carry the version they were made from, sidecar transfers never
// replace a destination, and a folder never ends half-moved.

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeImageAnnotations, writePdfAnnotations } from "../../src/lib/storage/annotations";
import { readLiberaFile, renameFolder, textVersion, updateMarkdownFile } from "../../src/lib/storage/files";
import { moveWithoutReplacing } from "../../src/lib/storage/fs-utils";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { filePathFromParts, imageAnnotationsDirectoryPath, pdfAnnotationsDirectoryPath } from "../../src/lib/storage/paths";
import { copyLifecycleSidecar } from "../../src/lib/storage/sidecar-lifecycle";
import { currentTranscriptVersion, editTranscriptSegments, readTranscript, transcriptVersion, writeTranscript } from "../../src/lib/storage/transcripts";
import type { Transcript } from "../../src/lib/transcription/types";

async function withLibrary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-local-writes-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try { await createNotebook("Notes"); await run(directory); }
  finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

async function file(relative: string, body = "body") {
  const [notebook, ...parts] = relative.split("/");
  const target = filePathFromParts(notebook, parts);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
  return target;
}

const rejects409 = (error: unknown) => (error as { status?: number }).status === 409;

// Finding 9

test("a save carrying the version it opened is refused when the file changed on disk", () => withLibrary(async () => {
  const target = await file("Notes/n.txt", "first");
  const opened = (await readLiberaFile("Notes/n.txt")).version;
  assert.equal(opened, textVersion("first"));
  await writeFile(target, "newer, from OneDrive");
  await assert.rejects(updateMarkdownFile("Notes/n.txt", "stale tab", opened), rejects409);
  assert.equal(await readFile(target, "utf8"), "newer, from OneDrive");
}));

test("a versioned save succeeds when the disk still holds that version, and its result carries the next one", () => withLibrary(async () => {
  const target = await file("Notes/n.md", "first");
  const saved = await updateMarkdownFile("Notes/n.md", "second", textVersion("first"));
  assert.equal(await readFile(target, "utf8"), "second");
  const again = await updateMarkdownFile("Notes/n.md", "third", saved.version);
  assert.equal(again.content, "third");
  assert.deepEqual((await readdir(path.dirname(target))).sort(), [".libera-notebook.json", "n.md"], "no staging file is left");
}));

test("a versioned save never recreates a file that was moved or deleted", () => withLibrary(async () => {
  const target = await file("Notes/n.txt", "first");
  await rm(target);
  await assert.rejects(updateMarkdownFile("Notes/n.txt", "late save", textVersion("first")), rejects409);
  assert.equal(existsSync(target), false);
}));

test("a save without a version keeps replacing the file", () => withLibrary(async () => {
  const target = await file("Notes/n.txt", "first");
  await writeFile(target, "other");
  await updateMarkdownFile("Notes/n.txt", "mine");
  assert.equal(await readFile(target, "utf8"), "mine");
}));

test("a save is staged in a temporary file and renamed, not written in place", () => withLibrary(async () => {
  const target = await file("Notes/n.txt", "first");
  const { ino } = await import("node:fs/promises").then((fs) => fs.stat(target));
  await updateMarkdownFile("Notes/n.txt", "second");
  const after = await import("node:fs/promises").then((fs) => fs.stat(target));
  assert.notEqual(after.ino, ino, "a rename publishes a new inode; an in-place write keeps it");
}));

// Finding 11

const TRANSCRIPT: Transcript = {
  version: 1, createdAt: "2026-11-19T00:00:00Z", audio: { size: 4, modifiedAt: "", duration: 1 },
  engine: { kind: "local", model: "test" }, language: "en", diarization: null, speakers: [],
  segments: [{ start: 0, end: 1, speaker: null, text: "original speech" }], stats: { words: 2, chunks: 1, elapsedMs: 1 },
};

test("a segment edit made from an older transcript is refused and the newer one is kept", () => withLibrary(async () => {
  await file("Notes/talk.wav", "RIFF");
  await writeTranscript("Notes/talk.wav", TRANSCRIPT);
  const displayed = transcriptVersion((await readTranscript("Notes/talk.wav")).transcript);
  await editTranscriptSegments("Notes/talk.wav", [{ start: 0, end: 1, speaker: null, text: "first correction" }], displayed);
  await assert.rejects(editTranscriptSegments("Notes/talk.wav", [{ start: 0, end: 1, speaker: null, text: "from the older list" }], displayed), rejects409);
  assert.equal((await readTranscript("Notes/talk.wav")).transcript?.segments[0].text, "first correction");
}));

test("a finished transcription does not replace a transcript edited while it ran", () => withLibrary(async () => {
  await file("Notes/talk.wav", "RIFF");
  await writeTranscript("Notes/talk.wav", TRANSCRIPT);
  const startVersion = await currentTranscriptVersion("Notes/talk.wav");
  await editTranscriptSegments("Notes/talk.wav", [{ start: 0, end: 1, speaker: null, text: "hand correction" }]);
  const result: Transcript = { ...TRANSCRIPT, segments: [{ start: 0, end: 1, speaker: null, text: "job result" }] };
  await assert.rejects(writeTranscript("Notes/talk.wav", result, { expectedTranscriptVersion: startVersion }), rejects409);
  assert.equal((await readTranscript("Notes/talk.wav")).transcript?.segments[0].text, "hand correction");
  // Nothing edited: the job's result still replaces the transcript it started from.
  const fresh = await currentTranscriptVersion("Notes/talk.wav");
  await writeTranscript("Notes/talk.wav", result, { expectedTranscriptVersion: fresh });
  assert.equal((await readTranscript("Notes/talk.wav")).transcript?.segments[0].text, "job result");
}));

// Finding 16

test("a sidecar copy never replaces a destination that appears while it is published", () => withLibrary(async (directory) => {
  const root = path.join(directory, "root");
  await mkdir(root, { recursive: true });
  const source = path.join(root, "source.json");
  const target = path.join(root, "target.json");
  writeFileSync(source, "mine");
  let calls = 0;
  const matches = async () => {
    // The guard's last check, after the destination was found free and just before publication (the 4th call): a cloud arrival takes the name.
    if (++calls === 4) writeFileSync(target, "theirs");
    return true;
  };
  await copyLifecycleSidecar(source, target, root, matches).catch(() => false);
  assert.equal(await readFile(target, "utf8"), "theirs");
}));

test("moveWithoutReplacing refuses a destination that holds a file and clears empty folders", () => withLibrary(async (directory) => {
  const from = path.join(directory, "from");
  const taken = path.join(directory, "taken");
  await mkdir(from); await writeFile(path.join(from, "a.json"), "A");
  await mkdir(taken); await writeFile(path.join(taken, "b.json"), "B");
  await assert.rejects(moveWithoutReplacing(from, taken), rejects409);
  assert.equal(await readFile(path.join(taken, "b.json"), "utf8"), "B");
  assert.equal(await readFile(path.join(from, "a.json"), "utf8"), "A");
  const empty = path.join(directory, "empty");
  await mkdir(path.join(empty, "nested"), { recursive: true });
  await moveWithoutReplacing(from, empty);
  assert.equal(await readFile(path.join(empty, "a.json"), "utf8"), "A");
  assert.equal(existsSync(from), false);
}));

test("moveWithoutReplacing still renames a case-only change", () => withLibrary(async (directory) => {
  const from = path.join(directory, "Sidecar");
  await mkdir(from); await writeFile(path.join(from, "a.json"), "A");
  await moveWithoutReplacing(from, path.join(directory, "sidecar"));
  assert.ok((await readdir(directory)).includes("sidecar"));
}));

// Finding 17

test("a folder rename that fails part-way is rolled back completely", { skip: process.getuid?.() === 0 }, () => withLibrary(async () => {
  await file("Notes/old/a.pdf", "%PDF");
  await file("Notes/old/b.png", "PNG");
  await writePdfAnnotations("Notes/old/a.pdf", [{ id: "n", type: "text", text: "pdf note", pageNumber: 1, rect: { x: 0, y: 0, width: 0.2, height: 0.1 } }]);
  await writeImageAnnotations("Notes/old/b.png", [{ id: "i", type: "text", text: "image note", pageNumber: 1, rect: { x: 0, y: 0, width: 0.2, height: 0.1 } }]);
  const pdfFrom = pdfAnnotationsDirectoryPath("Notes", ["old"]);
  const imageFrom = imageAnnotationsDirectoryPath("Notes", ["old"]);
  assert.ok(existsSync(pdfFrom) && existsSync(imageFrom));
  // The image sidecar cannot leave its folder (locked), after the PDF one has moved.
  const locked = path.dirname(imageFrom);
  await chmod(locked, 0o555);
  try {
    await assert.rejects(renameFolder("Notes/old", "new"));
  } finally { await chmod(locked, 0o755); }
  assert.ok(existsSync(filePathFromParts("Notes", ["old", "a.pdf"])), "the folder is back where it was");
  assert.equal(existsSync(filePathFromParts("Notes", ["new"])), false);
  assert.ok(existsSync(pdfFrom), "the PDF sidecar that had moved is back");
  assert.equal(existsSync(pdfAnnotationsDirectoryPath("Notes", ["new"])), false);
  assert.ok(existsSync(imageFrom));
}));
