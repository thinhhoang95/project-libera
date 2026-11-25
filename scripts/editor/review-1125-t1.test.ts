import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { tetherBibFile } from "../../src/lib/references/bib-tether";
import { archiveFile, deleteFile, moveFile } from "../../src/lib/storage/files";
import { checkNothingLeftAt, verifyNotebook, type IntegrityFinding } from "../../src/lib/storage/integrity";
import { audioSidecarPaths, filePathFromParts, notebookPath } from "../../src/lib/storage/paths";
import { followSharedAudioChanges, readTranscript, transcriptCompanionPath } from "../../src/lib/storage/transcripts";
import { TRANSCRIPT_VERSION, type Transcript } from "../../src/lib/transcription/types";
import { assertNotebookSound, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

// File-moving review (2026-11-25), package T1: L-H3 (a transcript companion beside a recording follows it through
// local move, rename, archive and delete, and a stray one at a destination is a leftover record), O-H3 (Check
// Notebook sees companions), S-C1 item 5 (a shared recording's rename or delete leaves no orphan pending
// transcript) and L-M3 (the final check sees another notebook's .bib tether).

const AUDIO = "audio bytes";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const transcript = (bytes = AUDIO, text = "hello"): Transcript => ({
  version: TRANSCRIPT_VERSION, createdAt: "2026-11-25T00:00:00.000Z",
  audio: { size: Buffer.byteLength(bytes), modifiedAt: "", duration: 60, contentHash: sha(bytes) },
  engine: { kind: "local", model: "m" }, language: "en", diarization: null, speakers: [],
  segments: [{ start: 0, end: 1, speaker: null, text }], stats: { words: 1, chunks: 1, elapsedMs: 1 },
});
const companionOf = (relative: string) => { const [notebook, ...parts] = relative.split("/"); return filePathFromParts(notebook, [...parts.slice(0, -1), `${parts.at(-1)}.transcript`]); };
const exists = (target: string) => fs.stat(target).then(() => true, () => false);
const recording = (relative: string) => writeLibraryFile(relative, Buffer.from(AUDIO));
const companion = (relative: string, value: unknown = transcript()) => writeAt(companionOf(relative), typeof value === "string" ? value : JSON.stringify(value));
const findings = (report: { findings: IntegrityFinding[] }, check: string) => report.findings.filter((finding) => finding.check === check);

test("L-H3: a renamed recording takes its companion transcript with it", () => withTemporaryLibrary(["Nb"], async () => {
  await recording("Nb/memo.m4a");
  await companion("Nb/memo.m4a");
  await moveFile("Nb/memo.m4a", "Nb", "talk.m4a");
  assert.equal(await exists(companionOf("Nb/memo.m4a")), false, "nothing is left at the old name");
  assert.equal((await readTranscript("Nb/talk.m4a")).transcript?.segments[0].text, "hello");
  assert.equal(await exists(companionOf("Nb/talk.m4a")), true);
  await assertNotebookSound("Nb");
}));

test("L-H3: an archived recording takes its companion transcript with it", () => withTemporaryLibrary(["Nb"], async () => {
  await recording("Nb/memo.m4a");
  await companion("Nb/memo.m4a");
  await archiveFile("Nb/memo.m4a");
  assert.equal(await exists(companionOf("Nb/memo.m4a")), false);
  assert.equal(await exists(companionOf("Nb/_archive/memo.m4a")), true);
  assert.equal((await readTranscript("Nb/_archive/memo.m4a")).transcript?.segments[0].text, "hello");
  await assertNotebookSound("Nb");
}));

test("L-H3: a deleted recording's companion goes too, so a later recording of that name inherits nothing", () => withTemporaryLibrary(["Nb"], async () => {
  await recording("Nb/memo.m4a");
  await companion("Nb/memo.m4a");
  await deleteFile("Nb/memo.m4a");
  assert.equal(await exists(companionOf("Nb/memo.m4a")), false);
  await recording("Nb/memo.m4a");
  assert.equal((await readTranscript("Nb/memo.m4a")).transcript, null, "the new recording has no transcript");
  await assertNotebookSound("Nb");
}));

test("L-H3: a destination that holds a stray companion is a leftover record, and Check Notebook can clear it", () => withTemporaryLibrary(["Nb"], async () => {
  await recording("Nb/memo.m4a");
  await companion("Nb/memo.m4a", transcript(AUDIO, "mine"));
  await companion("Nb/talk.m4a", transcript("another recording", "not mine"));
  await assert.rejects(moveFile("Nb/memo.m4a", "Nb", "talk.m4a"), /still has the transcript of a file that was there before/);
  assert.equal(await exists(filePathFromParts("Nb", ["memo.m4a"])), true, "nothing moved");
  assert.equal(JSON.parse(await fs.readFile(companionOf("Nb/talk.m4a"), "utf8")).segments[0].text, "not mine");
  // The archive picks a free name instead of inheriting it.
  await companion("Nb/_archive/memo.m4a", transcript("another recording", "not mine either"));
  await archiveFile("Nb/memo.m4a");
  assert.equal(await exists(companionOf("Nb/_archive/memo-1.m4a")), true);
  assert.equal(JSON.parse(await fs.readFile(companionOf("Nb/_archive/memo.m4a"), "utf8")).segments[0].text, "not mine either");
  // The check reports each stray one with an action that removes it.
  const orphans = findings(await verifyNotebook("Nb"), "sidecars").filter((finding) => finding.code === "orphanSideFile");
  const kinds = orphans.map((finding) => `${finding.params?.kind}:${finding.path}`).sort();
  assert.deepEqual(kinds, ["transcript-companion:Nb/_archive/memo.m4a", "transcript-companion:Nb/talk.m4a"]);
  for (const finding of orphans) assert.equal(finding.clear?.[0]?.type, "side-file");
}));

test("O-H3: Check Notebook reads companions: unreadable, stale and orphaned ones are reported", () => withTemporaryLibrary(["Nb"], async () => {
  await recording("Nb/fine.m4a");
  await companion("Nb/fine.m4a");
  await recording("Nb/broken.m4a");
  await companion("Nb/broken.m4a", "{ not json");
  await recording("Nb/stale.m4a");
  await companion("Nb/stale.m4a", transcript("a longer recording than this one"));
  await companion("Nb/gone.m4a");
  await writeLibraryFile("Nb/notes.md", "[at the start](fine.m4a#t=30) [past the end](fine.m4a#t=2:00)\n");
  const report = await verifyNotebook("Nb");
  const sidecars = findings(report, "sidecars").map((finding) => `${finding.code}:${finding.path}`);
  assert.ok(sidecars.includes("sideFileUnreadable:Nb/broken.m4a"), sidecars.join("; "));
  assert.ok(sidecars.includes("sideFileStale:Nb/stale.m4a"), sidecars.join("; "));
  assert.ok(sidecars.includes("orphanSideFile:Nb/gone.m4a"), sidecars.join("; "));
  assert.ok(!sidecars.some((entry) => entry.endsWith("Nb/fine.m4a")), "a sound companion is not reported");
  // Its saved length answers a link's position: 2:00 is past the end of a one-minute recording that has only a companion.
  assert.ok(findings(report, "links").some((finding) => finding.message.includes("past the end of Nb/fine.m4a (1:00)")), findings(report, "links").map((finding) => finding.message).join("; "));
}));

test("O-H3: the final check sees a companion left at a moved recording's old place", () => withTemporaryLibrary(["Nb"], async () => {
  await companion("Nb/old.m4a");
  const result = await checkNothingLeftAt([{ label: "Nb/old.m4a", absolutePath: filePathFromParts("Nb", ["old.m4a"]), libraryPath: "Nb/old.m4a", fileType: "audio" }]);
  assert.equal(result.unverified, false);
  assert.ok(result.leftovers.some((line) => line.includes("transcript-companion")), result.leftovers.join("; "));
}));

test("L-M3: the final check sees a .bib tether of another notebook that points at the moved file", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  await writeLibraryFile("Nb/refs/refs.bib", "@article{a2026, title={A}, year={2026}}\n");
  await tetherBibFile("Other", "Nb/refs/refs.bib", { prefer: "library" });
  const old = filePathFromParts("Nb", ["refs", "refs.bib"]);
  await fs.rm(old);
  const result = await checkNothingLeftAt([{ label: "Nb/refs/refs.bib", absolutePath: old, libraryPath: "Nb/refs/refs.bib", fileType: null }]);
  assert.ok(result.leftovers.some((line) => line.includes(".bib tether")), JSON.stringify(result));
}));

async function shared(run: () => Promise<void>) {
  await withTemporaryLibrary(["Notes"], async () => {
    await writeAt(path.join(notebookPath("Notes"), ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", manifestDocId: "doc_manifest", serverUrl: "https://collab.test", accountId: "acc_test", sharedAt: "2026-11-07T00:00:00Z", folderId: "fld_test", writer: "inst_other" }));
    invalidateSharedNotebookCache();
    try { await run(); } finally { invalidateSharedNotebookCache(); }
  });
}
const pendingSidecar = (bytes: string, text: string) => JSON.stringify({ ...transcript(bytes, text), _liberaPendingShare: { fileId: "fil_companion", blobHash: "b".repeat(64) } });
const recoveryRecords = async () => {
  const directory = path.join(notebookPath("Notes"), ".libera", "collab", "sidecar-recovery");
  const names = await fs.readdir(directory).catch(() => [] as string[]);
  return Promise.all(names.map(async (name) => Buffer.from((JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as { contentBase64: string }).contentBase64, "base64").toString("utf8")));
};

test("S-C1 item 5: a renamed shared recording's pending transcript moves, leaving no orphan at the old path", () => shared(async () => {
  const bytes = "recording bytes";
  const source = audioSidecarPaths("Notes", ["a.m4a"])[0], destination = audioSidecarPaths("Notes", ["b.m4a"])[0];
  const pending = pendingSidecar(bytes, "my correction");
  await writeAt(source, pending);
  await writeAt(filePathFromParts("Notes", ["b.m4a"]), bytes);
  assert.equal(await followSharedAudioChanges([{ from: "Notes/a.m4a", to: "Notes/b.m4a" }], []), 1);
  assert.equal(await exists(source), false, "no orphan is left to block the old path");
  assert.equal(await fs.readFile(destination, "utf8"), pending);
  assert.ok((await recoveryRecords()).includes(pending), "a recovery copy of exactly those bytes is kept");
  assert.equal((await readTranscript("Notes/b.m4a")).pending, true);
}));

test("S-C1 item 5: a deleted shared recording's pending transcript is retired, unless a recording is at the path again", () => shared(async () => {
  const gone = audioSidecarPaths("Notes", ["gone.m4a"])[0], back = audioSidecarPaths("Notes", ["back.m4a"])[0];
  await writeAt(gone, pendingSidecar("gone bytes", "unshared work"));
  await writeAt(back, pendingSidecar("back bytes", "other work"));
  await writeAt(filePathFromParts("Notes", ["back.m4a"]), "a new recording");
  await followSharedAudioChanges([], ["Notes/gone.m4a", "Notes/back.m4a"]);
  assert.equal(await exists(gone), false);
  assert.equal(await exists(back), true, "a recording at the path again keeps what is there");
  assert.ok((await recoveryRecords()).includes(pendingSidecar("gone bytes", "unshared work")));
  assert.equal(transcriptCompanionPath("Notes/a.m4a"), "Notes/a.m4a.transcript");
}));
