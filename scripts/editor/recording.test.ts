import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
