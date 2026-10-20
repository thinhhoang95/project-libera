import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readImageAnnotations, writeImageAnnotations, writePdfAnnotations } from "../../src/lib/storage/annotations";
import { archiveFile, archiveFolder, copyFileToDirectory, deleteFile, deleteFolder, moveFile, moveFileToDirectory, renameFolder } from "../../src/lib/storage/files";
import { readFileContentHash, readFileSignature } from "../../src/lib/storage/file-signature";
import { deleteMarkdownImageSource } from "../../src/lib/storage/markdown-assets";
import { createNotebook, deleteNotebook } from "../../src/lib/storage/notebooks";
import { audioPeaksPath, filePathFromParts, imageAnnotationsPath, legacyFlatImageAnnotationsPath, notebookPath, transcriptPath } from "../../src/lib/storage/paths";
import { readTranscript, writeTranscript } from "../../src/lib/storage/transcripts";
import { getTree } from "../../src/lib/storage/tree";
import { readWorkspaceMetadata, setFileTagsForPath, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";
import { readAudioPeaks } from "../../src/lib/transcription/peaks";
import type { Transcript } from "../../src/lib/transcription/types";

async function withLibrary(run: () => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-sidecar-lifecycle-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try { await createNotebook("Notes"); await run(); }
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
const note = (text: string) => [{ id: text, type: "text", text, pageNumber: 1, rect: { x: 0, y: 0, width: 0.2, height: 0.1 } }];
const notes = async (relative: string) => (await readImageAnnotations(relative)).annotations.map((annotation) => annotation.text);
const transcript = (): Transcript => ({ version: 1, createdAt: "2026-10-19T00:00:00Z", audio: { size: 4, modifiedAt: "", duration: 1 },
  engine: { kind: "local", model: "test" }, language: "en", diarization: null, speakers: [],
  segments: [{ start: 0, end: 1, speaker: null, text: "original speech" }], stats: { words: 2, chunks: 1, elapsedMs: 1 } });

test("same-named images have independent notes and deleting one preserves the other", () => withLibrary(async () => {
  await file("Notes/a/photo.png"); await file("Notes/b/photo.png");
  await writeImageAnnotations("Notes/a/photo.png", note("first"));
  await writeImageAnnotations("Notes/b/photo.png", note("second"));
  assert.deepEqual(await notes("Notes/a/photo.png"), ["first"]);
  assert.deepEqual(await notes("Notes/b/photo.png"), ["second"]);
  await deleteFile("Notes/a/photo.png");
  assert.deepEqual(await notes("Notes/b/photo.png"), ["second"]);
}));

test("image notes follow files and folders through copies, renames, moves, archive and deletion", () => withLibrary(async () => {
  await file("Notes/old/photo.png");
  await writeImageAnnotations("Notes/old/photo.png", note("keep"));
  await moveFile("Notes/old/photo.png", "Notes", "renamed.png");
  await renameFolder("Notes/old", "new");
  assert.deepEqual(await notes("Notes/new/renamed.png"), ["keep"]);
  await copyFileToDirectory("Notes/new/renamed.png", "Notes", "copy.png");
  await createNotebook("Other");
  await moveFileToDirectory("Notes/copy.png", "Other");
  await archiveFile("Other/copy.png");
  assert.deepEqual(await notes("Other/_archive/copy.png"), ["keep"]);
  await archiveFolder("Notes/new");
  assert.deepEqual(await notes("Notes/_archive/new/renamed.png"), ["keep"]);
  await deleteFolder("Notes/_archive/new");
  await file("Notes/_archive/new/renamed.png");
  assert.deepEqual(await notes("Notes/_archive/new/renamed.png"), [], "new files do not inherit deleted notes");
}));

test("legacy flat image notes migrate only to an unambiguous owner", () => withLibrary(async () => {
  await file("Notes/one/photo.png");
  const legacy = legacyFlatImageAnnotationsPath("Notes", "photo.png");
  await mkdir(path.dirname(legacy), { recursive: true });
  await writeFile(legacy, JSON.stringify({ annotations: note("legacy") }));
  await renameFolder("Notes/one", "renamed");
  assert.deepEqual(await notes("Notes/renamed/photo.png"), ["legacy"]);
  assert.ok(existsSync(imageAnnotationsPath("Notes", ["renamed", "photo.png"])));

  await file("Notes/a/duplicate.png"); await file("Notes/b/DUPLICATE.PNG");
  const ambiguous = legacyFlatImageAnnotationsPath("Notes", "duplicate.png");
  await writeFile(ambiguous, JSON.stringify({ annotations: note("unknown owner") }));
  await deleteFile("Notes/a/duplicate.png");
  assert.deepEqual(await notes("Notes/b/DUPLICATE.PNG"), [], "deletion must not make ambiguous old notes attach to a survivor");
  assert.ok((await readdir(path.dirname(ambiguous))).some((name) => name.startsWith("duplicate.png.json.ambiguous-")), "old user notes remain recoverable");
}));

test("removing a raw image from Markdown updates metadata and search", () => withLibrary(async () => {
  await file("Notes/note.md"); await file("Notes/photo.png");
  await writeImageAnnotations("Notes/photo.png", note("remove"));
  await setStarredFilePath("Notes/photo.png", true);
  await setFileTagsForPath("Notes/photo.png", ["remove"]);
  const key = Symbol.for("libera.searchIndexer");
  const store = globalThis as Record<symbol, unknown>;
  const previous = store[key];
  const changed: string[] = [];
  store[key] = { notifyChanges: (paths: string[] = []) => changed.push(...paths) };
  try {
    await deleteMarkdownImageSource({ documentPath: "Notes/note.md", imageSource: "/api/files/raw/Notes/photo.png" });
    const metadata = await readWorkspaceMetadata();
    assert.ok(!metadata.starredFilePaths.includes("Notes/photo.png"));
    assert.equal(metadata.fileTags["Notes/photo.png"], undefined);
    assert.ok(changed.includes("Notes/photo.png"));
    assert.ok(!existsSync(imageAnnotationsPath("Notes", ["photo.png"])));
  } finally { store[key] = previous; }
}));

for (const kind of ["image", "pdf"] as const) {
  test(`a late ${kind} annotation save cannot recreate a deleted notebook`, () => withLibrary(async () => {
    await file(`Notes/photo.${kind === "image" ? "png" : "pdf"}`);
    const lateNote = { ...note("late")[0], get text() { rmSync(notebookPath("Notes"), { recursive: true, force: true }); return "late"; } };
    const write = kind === "image" ? writeImageAnnotations : writePdfAnnotations;
    await assert.rejects(write(`Notes/photo.${kind === "image" ? "png" : "pdf"}`, [lateNote]));
    assert.ok(!existsSync(notebookPath("Notes")));
  }));
}

for (const change of ["replace", "delete-notebook"] as const) {
  test(`waveforms finishing after ${change} cannot publish stale results`, () => withLibrary(async () => {
    const target = await file("Notes/audio.wav");
    const key = Symbol.for("libera.transcriptionWorker");
    const store = globalThis as Record<symbol, unknown>;
    const previous = store[key];
    let started!: () => void;
    let release!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    store[key] = { configure: () => {}, peaks: async () => {
      if (++calls === 1) { started(); await gate; return { duration: 1, peaks: [0.1] }; }
      return { duration: 2, peaks: [0.9] };
    } };
    try {
      const first = readAudioPeaks("Notes/audio.wav").then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
      await began;
      let fresh;
      if (change === "replace") { await writeFile(target, "different audio"); fresh = readAudioPeaks("Notes/audio.wav"); }
      else await deleteNotebook("Notes");
      release();
      assert.ok((await first).error, "the obsolete request is rejected");
      if (fresh) {
        assert.deepEqual(await fresh, { duration: 2, peaks: [0.9] });
        assert.equal(calls, 2, "a new file identity starts its own decode");
        assert.deepEqual((await readAudioPeaks("Notes/audio.wav")).peaks, [0.9]);
      } else {
        assert.ok(!existsSync(notebookPath("Notes")), "a decoder cannot resurrect the notebook");
        assert.ok(!existsSync(audioPeaksPath("Notes", ["audio.wav"])));
      }
    } finally { release(); store[key] = previous; }
  }));
}

test("transcript freshness detects same-size replacements while copies stay current", () => withLibrary(async () => {
  const target = await file("Notes/audio.wav", "RIFF");
  await writeTranscript("Notes/audio.wav", transcript());
  assert.equal((await readTranscript("Notes/audio.wav")).stale, false);
  await copyFileToDirectory("Notes/audio.wav", "Notes", "copy.wav");
  assert.equal((await readTranscript("Notes/copy.wav")).stale, false);
  const before = await stat(target);
  await writeFile(target, "NEWS");
  await utimes(target, before.atime, before.mtime);
  assert.equal((await readTranscript("Notes/audio.wav")).stale, true);
}));

test("same-size audio replacements invalidate cached waveforms even with preserved timestamps", () => withLibrary(async () => {
  const target = await file("Notes/audio.wav", "RIFF");
  const key = Symbol.for("libera.transcriptionWorker");
  const store = globalThis as Record<symbol, unknown>;
  const previous = store[key];
  let calls = 0;
  store[key] = { configure: () => {}, peaks: async () => ({ duration: 1, peaks: [++calls] }) };
  try {
    assert.deepEqual((await readAudioPeaks("Notes/audio.wav")).peaks, [1]);
    const before = await stat(target);
    await writeFile(target, "NEWS");
    await utimes(target, before.atime, before.mtime);
    assert.deepEqual((await readAudioPeaks("Notes/audio.wav")).peaks, [2]);
  } finally { store[key] = previous; }
}));

test("transcription results cannot be saved after their original recording changes or disappears", () => withLibrary(async () => {
  const target = await file("Notes/audio.wav", "RIFF");
  const signature = await readFileSignature(target);
  const contentHash = await readFileContentHash(target);
  await writeFile(target, "NEWS");
  await assert.rejects(writeTranscript("Notes/audio.wav", transcript(), { expectedSignature: signature, expectedContentHash: contentHash }));
  assert.ok(!existsSync(transcriptPath("Notes", ["audio.wav"])));
  await rm(target);
  await assert.rejects(writeTranscript("Notes/audio.wav", transcript()));
  assert.ok(!existsSync(transcriptPath("Notes", ["audio.wav"])));
}));

test("library refresh removes orphaned audio sidecars without removing live transcripts", () => withLibrary(async () => {
  const target = await file("Notes/audio.wav", "RIFF");
  await file("Notes/live.wav", "RIFF");
  await writeTranscript("Notes/audio.wav", transcript());
  await writeTranscript("Notes/live.wav", transcript());
  const peaks = audioPeaksPath("Notes", ["audio.wav"]);
  await mkdir(path.dirname(peaks), { recursive: true });
  await writeFile(peaks, "{}");
  await rm(target);
  assert.equal((await readTranscript("Notes/audio.wav")).transcript, null);
  await getTree();
  assert.ok(!existsSync(transcriptPath("Notes", ["audio.wav"])));
  assert.ok(!existsSync(peaks));
  assert.ok(existsSync(transcriptPath("Notes", ["live.wav"])));
}));

test("concurrent transcript saves publish complete JSON without shared temporary filenames", () => withLibrary(async () => {
  await file("Notes/audio.wav", "RIFF");
  await Promise.all(Array.from({ length: 10 }, () => writeTranscript("Notes/audio.wav", transcript())));
  assert.equal((await readTranscript("Notes/audio.wav")).transcript?.segments[0].text, "original speech");
  const files = await readdir(path.dirname(transcriptPath("Notes", ["audio.wav"])));
  assert.deepEqual(files, ["audio.wav.json"]);
  assert.equal(JSON.parse(await readFile(transcriptPath("Notes", ["audio.wav"]), "utf8")).segments[0].text, "original speech");
}));
