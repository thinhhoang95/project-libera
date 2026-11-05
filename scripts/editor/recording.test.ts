import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyRecapOperations, parseRecapOperations, recapMarkdown, recapUserMessage } from "../../src/lib/recording/recap";
import type { RecapBullet } from "../../src/lib/recording/types";

const bullet = (id: number, text: string): RecapBullet => ({ id, text, addedAt: id * 10, changedAt: id * 10 });

test("recap replies are read leniently and only for known bullets", () => {
  const known = new Set([1, 2]);
  assert.deepEqual(parseRecapOperations("```json\n{\"operations\": [{\"op\": \"add\", \"text\": \"- Budget is approved \"}]}\n```", known), [{ op: "add", text: "Budget is approved" }]);
  assert.deepEqual(parseRecapOperations('{"operations": [{"op": "update", "id": 7, "text": "x"}, {"op": "delete", "id": 1}, {"op": "update", "id": 2, "text": "Kept"}]}', known), [{ op: "update", id: 2, text: "Kept" }]);
  assert.deepEqual(parseRecapOperations("Nothing new here.", known), []);
  assert.deepEqual(parseRecapOperations('{"operations": "none"}', known), []);
});

test("operations amend the recap one bullet at a time and never remove one", () => {
  const before = [bullet(1, "Launch moves to May."), bullet(2, "Anna owns the pricing page.")];
  const { bullets, changed } = applyRecapOperations(before, [
    { op: "update", id: 1, text: "Launch moves to May 12, after the security review." },
    { op: "add", text: "Hiring freeze until Q3." },
    { op: "add", text: "anna owns the pricing page" },
  ], 95);
  assert.deepEqual(bullets.map((item) => item.text), ["Launch moves to May 12, after the security review.", "Anna owns the pricing page.", "Hiring freeze until Q3."]);
  assert.deepEqual(changed, [1, 3]);
  assert.equal(bullets[0].addedAt, 10);
  assert.equal(bullets[0].changedAt, 95);
  assert.equal(bullets[2].id, 3);
  assert.equal(before[0].text, "Launch moves to May.", "the old list is left as it was");
});

test("the prompt shows bullet ids, context and only the unread transcript", () => {
  const word = (text: string, start: number) => ({ text, start, end: start + 0.4 });
  const message = recapUserMessage([bullet(4, "Q3 targets agreed.")], [word("Earlier", 1)], [word("New", 65), word("point.", 65.5)]);
  assert.match(message, /\[4\] Q3 targets agreed\./);
  assert.match(message, /context only[\s\S]*\[0:01\] Earlier/);
  assert.match(message, /New transcript:\n\[1:05\] New point\./);
});

test("the recap note links each bullet to its moment", () => {
  const note = recapMarkdown("Standup: recap", "Standup.m4a", (at) => (at ? `Standup.m4a#t=${Math.floor(at)}` : "Standup.m4a"), [bullet(7, "Ship Friday.")]);
  assert.match(note, /^# Standup: recap/);
  assert.match(note, /- Ship Friday\. \(\[1:10\]\(Standup\.m4a#t=70\)\)/);
});

function wav(samples: number, value = 0.25) {
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index += 1) view.setInt16(44 + index * 2, Math.round(value * 32767), true);
  return bytes;
}

test("chunks on disk survive a crash and are saved as one recording", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "libera-recording-test-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = dataRoot;
  try {
    await mkdir(path.join(dataRoot, "users", "admin", "Meetings"), { recursive: true });
    const sessions = await import("../../src/lib/recording/sessions");
    const created = await sessions.createRecording({ notebook: "Meetings", name: "Weekly sync" });
    await sessions.saveRecordingChunk(created.id, 0, 0, wav(16_000));
    await sessions.saveRecordingChunk(created.id, 0, 0, wav(16_000)); // Sent again after a lost reply.
    await sessions.saveRecordingChunk(created.id, 1, 16_000, wav(8_000));
    await assert.rejects(() => sessions.saveRecordingChunk(created.id, 2, 24_000, new Uint8Array(10)));

    const folder = path.join(dataRoot, "recordings", created.id);
    assert.deepEqual((await readdir(folder)).sort(), ["chunks.jsonl", "recording.wav", "session.json"], "chunks add no files");
    assert.ok(!(await readFile(path.join(folder, "session.json"), "utf8")).includes("chunks"), "chunks are not listed in session.json");

    // A crash: the server forgets everything it kept in memory.
    (globalThis as Record<symbol, unknown>)[Symbol.for("libera.recordings")] = undefined;
    const unfinished = await sessions.listUnfinishedRecordings();
    assert.equal(unfinished.length, 1);
    assert.equal(unfinished[0].name, "Weekly sync");
    assert.equal(unfinished[0].savedSeconds, 1.5);

    const status = await sessions.getRecordingStatus(created.id);
    assert.equal(status.nextIndex, 2);
    assert.equal(status.savedSamples, 24_000);

    const finished = await sessions.finishRecording(created.id);
    assert.match(finished.path, /^Meetings\/Weekly sync\.(m4a|wav)$/);
    assert.equal(finished.recapPath, null);
    const saved = await readFile(path.join(dataRoot, "users", "admin", finished.path));
    if (finished.path.endsWith(".wav")) assert.equal(saved.byteLength, 44 + 24_000 * 2);
    else assert.ok(saved.byteLength > 0);
    assert.deepEqual(await readdir(path.join(dataRoot, "recordings")), [], "the chunks are removed once saved");
    assert.deepEqual(await sessions.listUnfinishedRecordings(), []);
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(dataRoot, { recursive: true, force: true });
  }
});

async function inRecordingData(run: (dataRoot: string, sessions: typeof import("../../src/lib/recording/sessions")) => Promise<void>) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "libera-recording-test-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = dataRoot;
  try {
    await mkdir(path.join(dataRoot, "users", "admin", "Meetings"), { recursive: true });
    await run(dataRoot, await import("../../src/lib/recording/sessions"));
  } finally {
    (globalThis as Record<symbol, unknown>)[Symbol.for("libera.recordings")] = undefined;
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

const firstSample = (bytes: Uint8Array, at = 0) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(44 + at * 2, true);

test("each chunk can be heard alone, and a lost chunk leaves silence", () => inRecordingData(async (dataRoot, sessions) => {
  const { id } = await sessions.createRecording({ notebook: "Meetings" });
  await sessions.saveRecordingChunk(id, 0, 0, wav(1_000, 0.25));
  await sessions.saveRecordingChunk(id, 2, 2_000, wav(500, 0.5)); // Chunk 1 was refused.
  const folder = path.join(dataRoot, "recordings", id);

  const heard = await readFile(await sessions.writeChunkForHearing(folder, { start: 2_000, samples: 500 }));
  assert.equal(heard.byteLength, 44 + 500 * 2);
  assert.equal(heard.toString("ascii", 0, 4), "RIFF");
  assert.equal(firstSample(heard), Math.round(0.5 * 32767));

  const audio = await readFile(path.join(folder, "recording.wav"));
  assert.equal(firstSample(audio), Math.round(0.25 * 32767));
  assert.equal(firstSample(audio, 1_500), 0);
  assert.equal(firstSample(audio, 2_000), Math.round(0.5 * 32767));
}));

test("a line cut off by a crash loses only its chunk", () => inRecordingData(async (dataRoot, sessions) => {
  const { id } = await sessions.createRecording({ notebook: "Meetings" });
  await sessions.saveRecordingChunk(id, 0, 0, wav(1_000));
  const log = path.join(dataRoot, "recordings", id, "chunks.jsonl");
  await writeFile(log, `${await readFile(log, "utf8")}{"index":1,"sta`);

  (globalThis as Record<symbol, unknown>)[Symbol.for("libera.recordings")] = undefined;
  const status = await sessions.getRecordingStatus(id);
  assert.equal(status.nextIndex, 1);
  assert.equal(status.savedSamples, 1_000);
  await sessions.saveRecordingChunk(id, 1, 1_000, wav(1_000));

  (globalThis as Record<symbol, unknown>)[Symbol.for("libera.recordings")] = undefined;
  assert.equal((await sessions.getRecordingStatus(id)).savedSamples, 2_000);
}));

test("a recording left as chunk files is moved into one file", () => inRecordingData(async (dataRoot, sessions) => {
  const id = "11111111-2222-4333-8444-555555555555";
  const folder = path.join(dataRoot, "recordings", id);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "chunk-000000.wav"), wav(1_000, 0.25));
  await writeFile(path.join(folder, "chunk-000001.wav"), wav(500, 0.5));
  await writeFile(path.join(folder, "session.json"), JSON.stringify({
    id,
    name: "Old",
    directory: "Meetings",
    createdAt: "2026-01-01T00:00:00.000Z",
    state: "recording",
    liveTranscribe: false,
    liveRecap: false,
    chunks: [
      { index: 0, start: 0, samples: 1_000, transcribed: false },
      { index: 1, start: 1_000, samples: 500, transcribed: false },
    ],
  }));

  // The start screen and an open tab both load it at once.
  const [listed, status] = await Promise.all([sessions.listUnfinishedRecordings(), sessions.getRecordingStatus(id)]);
  assert.equal(listed[0].chunks, 2);
  assert.equal(status.savedSamples, 1_500);
  assert.deepEqual((await readdir(folder)).sort(), ["chunks.jsonl", "recording.wav", "session.json"]);
  const audio = await readFile(path.join(folder, "recording.wav"));
  assert.equal(firstSample(audio, 999), Math.round(0.25 * 32767));
  assert.equal(firstSample(audio, 1_000), Math.round(0.5 * 32767));

  const finished = await sessions.finishRecording(id);
  assert.match(finished.path, /^Meetings\/Old\.(m4a|wav)$/);
}));
