import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { audioSidecarPaths, definitionsPath, filePathFromParts, notebookPath, pdfAnnotationsPath, pdfOutlinePath } from "../../src/lib/storage/paths";
import { followSharedPdfChanges, heldLegacyPdfSidecars, legacySidecarFollows, replayPendingPdfMoves } from "../../src/lib/storage/pdf-sidecars";
import { followSharedAudioChanges, readTranscript, replayPendingAudioMoves } from "../../src/lib/storage/transcripts";
import { TRANSCRIPT_VERSION, type Transcript } from "../../src/lib/transcription/types";

// Shared-notebook integrity round, package PL: S36 (legacy PDF sidecars follow a known rename,
// or are held and listed) and S38 (a pending transcript follows two hops and never lands on a
// replacement recording).

async function shared(run: () => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "libera-pl-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = path.join(directory, "data");
  invalidateSharedNotebookCache();
  try {
    await createNotebook("Notes");
    await write(path.join(notebookPath("Notes"), ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", manifestDocId: "doc_manifest", serverUrl: "https://collab.test", accountId: "acc_test", sharedAt: "2026-11-07T00:00:00Z", folderId: "fld_test", writer: "inst_other" }));
    invalidateSharedNotebookCache();
    await run();
  } finally {
    invalidateSharedNotebookCache();
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function write(target: string, bytes: string | Buffer) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); }
const exists = (target: string) => fs.stat(target).then(() => true, () => false);
const setTime = (target: string, seconds: number) => fs.utimes(target, seconds, seconds);
const pdfPath = (name: string) => filePathFromParts("Notes", [name]);
const sidecarsOf = (name: string) => [pdfAnnotationsPath("Notes", [name]), pdfOutlinePath("Notes", [name]), definitionsPath("Notes", [name])];

/** The three legacy kinds of a PDF, none recording its bytes, saved at `seconds`. */
async function legacyRecords(name: string, seconds: number) {
  for (const [index, file] of sidecarsOf(name).entries()) {
    await write(file, JSON.stringify(index === 0 ? { annotations: [{ id: "n", text: "legacy note" }] } : { legacy: index }));
    await setTime(file, seconds);
  }
}

test("S36: the rule: this user's own move carries a legacy record, a collaborator's only an unchanged PDF", () => {
  const base = { pdfPresent: true, oldNameHasPdf: false, pdfModifiedMs: 5_000, notesModifiedMs: 1_000 };
  assert.equal(legacySidecarFollows({ ...base, explicit: true }), "follows");
  assert.equal(legacySidecarFollows({ ...base, explicit: false }), "held");
  assert.equal(legacySidecarFollows({ ...base, explicit: false, pdfModifiedMs: 900 }), "follows");
  assert.equal(legacySidecarFollows({ ...base, explicit: true, pdfPresent: false }), "waits");
  assert.equal(legacySidecarFollows({ ...base, explicit: true, oldNameHasPdf: true }), "held", "the old name still has a PDF: not a move");
});

test("S36: this user's explicit rename carries legacy annotations, outline and definitions", () => shared(async () => {
  await legacyRecords("old.pdf", 1_000);
  await write(pdfPath("new.pdf"), "the paper");
  assert.equal(await followSharedPdfChanges([{ from: "Notes/old.pdf", to: "Notes/new.pdf" }], [], { explicit: true }), 3);
  for (const [index, file] of sidecarsOf("new.pdf").entries()) assert.equal(await exists(file), true, `kind ${index} followed`);
  assert.equal(await exists(sidecarsOf("old.pdf")[0]), true, "the source is retained");
  assert.deepEqual(heldLegacyPdfSidecars("Notes"), []);
}));

test("S36: a collaborator's rename of a PDF saved after the notes is held and listed with its file ID, never guessed", () => shared(async () => {
  await legacyRecords("old.pdf", 1_000);
  await write(pdfPath("new.pdf"), "another paper arrived later");
  assert.equal(await followSharedPdfChanges([{ from: "Notes/old.pdf", to: "Notes/new.pdf", fileId: "fil_remote" }], []), 0);
  for (const file of sidecarsOf("new.pdf")) assert.equal(await exists(file), false);
  const held = heldLegacyPdfSidecars("Notes").filter((record) => record.from === "Notes/old.pdf");
  assert.deepEqual(held.map((record) => record.kind).sort(), ["annotations", "definitions", "outline"]);
  assert.ok(held.every((record) => record.fileId === "fil_remote" && record.to === "Notes/new.pdf"));
  assert.equal(await exists(sidecarsOf("old.pdf")[0]), true, "what is held stays where it is, for Check Notebook");
}));

test("S36: a collaborator's rename of a PDF not changed since the notes carries them", () => shared(async () => {
  await legacyRecords("old.pdf", 4_000);
  await write(pdfPath("new.pdf"), "the paper");
  await setTime(pdfPath("new.pdf"), 1_000);
  assert.equal(await followSharedPdfChanges([{ from: "Notes/old.pdf", to: "Notes/new.pdf" }], []), 3);
}));

test("S36: a move whose PDF has not arrived waits, and the explicit mark survives the wait", () => shared(async () => {
  await legacyRecords("old.pdf", 1_000);
  assert.equal(await followSharedPdfChanges([{ from: "Notes/old.pdf", to: "Notes/new.pdf" }], [], { explicit: true }), 0);
  await write(pdfPath("new.pdf"), "the paper");
  assert.equal(await replayPendingPdfMoves("Notes"), 3);
}));

test("S36: an explicit move where the old name still holds a PDF is held", () => shared(async () => {
  await legacyRecords("old.pdf", 1_000);
  await write(pdfPath("old.pdf"), "still here");
  await write(pdfPath("new.pdf"), "a copy");
  assert.equal(await followSharedPdfChanges([{ from: "Notes/old.pdf", to: "Notes/new.pdf" }], [], { explicit: true }), 0);
  assert.equal(await exists(sidecarsOf("new.pdf")[0]), false);
}));

const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const transcript = (bytes: string, text: string): Transcript => ({
  version: TRANSCRIPT_VERSION, createdAt: "2026-11-01T00:00:00.000Z",
  audio: { size: Buffer.byteLength(bytes), modifiedAt: "", duration: 1, contentHash: sha(bytes) },
  engine: { kind: "local", model: "m" }, language: "en", diarization: null, speakers: [],
  segments: [{ start: 0, end: 1, speaker: null, text }], stats: { words: 1, chunks: 1, elapsedMs: 1 },
});
const pendingSidecar = (bytes: string, text: string) => JSON.stringify({ ...transcript(bytes, text), _liberaPendingShare: { fileId: "fil_companion", blobHash: "b".repeat(64) } });

test("S38: a second rename before the first copy arrives still carries the pending correction", () => shared(async () => {
  const bytes = "recording bytes";
  await write(audioSidecarPaths("Notes", ["a.m4a"])[0], pendingSidecar(bytes, "my correction"));
  // a -> b: b has not arrived. b -> c before it does.
  assert.equal(await followSharedAudioChanges([{ from: "Notes/a.m4a", to: "Notes/b.m4a" }], []), 0);
  assert.equal(await followSharedAudioChanges([{ from: "Notes/b.m4a", to: "Notes/c.m4a" }], []), 0);
  await write(filePathFromParts("Notes", ["c.m4a"]), bytes);
  assert.equal(await replayPendingAudioMoves("Notes"), 1);
  const read = await readTranscript("Notes/c.m4a");
  assert.equal(read.pending, true, "the correction is still pending, on the recording's current path");
  assert.equal(read.transcript?.segments[0].text, "my correction");
  assert.equal(JSON.parse(await fs.readFile(audioSidecarPaths("Notes", ["c.m4a"])[0], "utf8"))._liberaPendingShare.fileId, "fil_companion", "its companion base travels with it");
}));

test("S38: a replacement recording at a reused path never shows the old pending correction", () => shared(async () => {
  const old = "old recording bytes";
  await write(filePathFromParts("Notes", ["a.m4a"]), old);
  await write(audioSidecarPaths("Notes", ["a.m4a"])[0], pendingSidecar(old, "old correction"));
  assert.equal((await readTranscript("Notes/a.m4a")).pending, true, "control: it is the recording's own pending correction");
  // The old recording moves away (the pending sidecar is retained at the old path), and a different one takes the name.
  const replacement = "a different recording";
  await write(filePathFromParts("Notes", ["a.m4a"]), replacement);
  let read = await readTranscript("Notes/a.m4a");
  assert.equal(read.pending, undefined);
  assert.equal(read.transcript, null);
  // Its companion transcript is what it shows.
  await write(`${filePathFromParts("Notes", ["a.m4a"])}.transcript`, JSON.stringify(transcript(replacement, "shared transcript")));
  read = await readTranscript("Notes/a.m4a");
  assert.equal(read.pending, undefined);
  assert.equal(read.transcript?.segments[0].text, "shared transcript");
  assert.equal(read.stale, false);
  assert.equal(await exists(audioSidecarPaths("Notes", ["a.m4a"])[0]), true, "the old correction is kept, not deleted");
}));
