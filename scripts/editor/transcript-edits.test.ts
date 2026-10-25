import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyRecapEdits, cleanRecapEdits, parseRecapOperations, recapUserMessage } from "../../src/lib/recording/recap";
import type { RecapBullet } from "../../src/lib/recording/types";
import {
  applySegmentEdits,
  cleanSegmentEdits,
  cleanSegments,
  joinSegments,
  setSegmentText,
  splitSegment,
  withoutEmptySegments,
} from "../../src/lib/transcription/edits";
import type { TranscriptSegment } from "../../src/lib/transcription/types";

const line = (start: number, end: number, text: string, speaker: number | null = null): TranscriptSegment => ({ start, end, speaker, text });
const base = [line(0, 4, "Hello everyone and welcome."), line(4, 10, "Today we look at the budget."), line(10, 12, "Any questions?")];

test("edits cover only the passages up to the one corrected; later ones show as transcribed", () => {
  const edits = setSegmentText(base, null, 1, "Today we look at the Q3 budget.");
  assert.equal(edits?.basedOn, 2);
  assert.equal(edits?.segments.length, 2);
  const grown = [...base, line(12, 15, "Yes, one.")];
  assert.deepEqual(applySegmentEdits(grown, edits).map((segment) => segment.text), ["Hello everyone and welcome.", "Today we look at the Q3 budget.", "Any questions?", "Yes, one."]);
  assert.equal(setSegmentText(base, null, 0, base[0].text), null, "an unchanged line is no edit");
});

test("Enter breaks a line and shares its time; at the end it opens an empty line", () => {
  const split = splitSegment(base, null, 1, "Today we look at the budget.", 9)!;
  const shown = applySegmentEdits(base, split);
  assert.deepEqual(shown.slice(1, 3).map((segment) => segment.text), ["Today we", "look at the budget."]);
  assert.equal(shown[1].end, shown[2].start);
  assert.ok(shown[1].end > 4 && shown[1].end < 10);
  assert.equal(shown[2].end, 10);

  const opened = applySegmentEdits(base, splitSegment(base, null, 2, "Any questions?", 14));
  assert.deepEqual(opened.slice(2).map((segment) => [segment.text, segment.start, segment.end]), [["Any questions?", 10, 12], ["", 12, 12]]);
  assert.equal(withoutEmptySegments({ basedOn: 3, segments: opened }).segments.length, 3, "a line left empty is dropped when saved");
});

test("Backspace at a line's start joins it to the one before, with the caret at the seam", () => {
  const joined = joinSegments(base, null, 1, "today we look at the budget.")!;
  const shown = applySegmentEdits(base, joined.edits);
  assert.equal(shown.length, 2);
  assert.equal(shown[0].text, "Hello everyone and welcome. today we look at the budget.");
  assert.deepEqual([shown[0].start, shown[0].end], [0, 10]);
  assert.equal(joined.caret, "Hello everyone and welcome.".length);
  assert.equal(joinSegments(base, null, 0, "x"), null);
});

test("transcript edits from a viewer are checked before they are kept", () => {
  assert.equal(cleanSegments("nope", 0), null);
  assert.equal(cleanSegments([{ start: "1", end: 2, text: "x" }], 0), null);
  assert.deepEqual(cleanSegments([{ start: 3, end: 1, speaker: 5, text: " a\nb " }, { start: 4, end: 5, speaker: 0, text: "  " }], 2), [{ start: 3, end: 3, speaker: null, text: "a b" }]);
  assert.deepEqual(cleanSegmentEdits({ basedOn: 9, segments: [line(0, 1, "x")] }, 2), { basedOn: 2, segments: [line(0, 1, "x")] });
  assert.equal(cleanSegmentEdits({ basedOn: -1, segments: [] }, 2), null);
});

const bullet = (id: number, text: string, edited?: boolean): RecapBullet => ({ id, text, addedAt: id * 10, changedAt: id * 10, ...(edited ? { edited } : {}) });

test("the reader's recap edits apply in order; the server numbers new bullets", () => {
  const bullets = [bullet(1, "Launch moves to May."), bullet(2, "Anna owns pricing."), bullet(3, "Hiring freeze.")];
  const edits = cleanRecapEdits([
    { op: "update", id: 1, text: "Launch moves to May 12." },
    { op: "add", id: -1, after: 1, text: "Security review first.", at: 61 },
    { op: "add", id: -2, after: -1, text: "", at: 62 },
    { op: "remove", id: 3 },
  ])!;
  const shown = applyRecapEdits(bullets, edits);
  assert.deepEqual(shown.map((item) => item.id), [1, -1, -2, 2], "the recorder keeps its own ids while editing");
  const saved = applyRecapEdits(bullets, edits, { number: true });
  assert.deepEqual(saved.map((item) => [item.id, item.text, Boolean(item.edited)]), [[1, "Launch moves to May 12.", true], [4, "Security review first.", true], [2, "Anna owns pricing.", false]]);
  assert.equal(saved[1].addedAt, 61);
  assert.equal(cleanRecapEdits([{ op: "rename", id: 1 }]), null);
});

test("the model is told which bullets the reader wrote, and cannot change them", () => {
  const bullets = [bullet(1, "Mine.", true), bullet(2, "The model's.")];
  assert.match(recapUserMessage(bullets, [], [{ text: "New", start: 1, end: 2 }]), /\[1\*\] Mine\.\n\[2\] The model's\./);
  const known = new Set(bullets.filter((item) => !item.edited).map((item) => item.id));
  assert.deepEqual(parseRecapOperations('{"operations": [{"op": "update", "id": 1, "text": "Theirs."}, {"op": "update", "id": 2, "text": "Better."}]}', known), [{ op: "update", id: 2, text: "Better." }]);
});

function wav(samples: number) {
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
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
  return bytes;
}

test("a recording keeps the reader's corrections through a crash and saves the transcript as they left it", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "libera-recording-edits-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = dataRoot;
  try {
    await mkdir(path.join(dataRoot, "users", "admin", "Meetings"), { recursive: true });
    const sessions = await import("../../src/lib/recording/sessions");
    const created = await sessions.createRecording({ notebook: "Meetings", name: "Edited sync" });
    await sessions.saveRecordingChunk(created.id, 0, 0, wav(16_000));
    // No speech model runs in tests, so the reader's lines are the whole transcript.
    const status = await sessions.updateRecording(created.id, {
      transcriptEdits: { basedOn: 0, segments: [line(0, 0.5, "Notes typed by hand."), line(0.5, 1, "  ")] },
      recapEdits: [{ op: "add", id: -1, after: null, text: "Decide the venue.", at: 0.4 }],
    });
    assert.deepEqual(status.transcriptEdits?.segments.map((segment) => segment.text), ["Notes typed by hand."]);
    assert.deepEqual(status.recap?.bullets.map((item) => [item.id, item.text, item.edited]), [[1, "Decide the venue.", true]]);

    // A crash: the edits come back from the recording's folder.
    (globalThis as Record<symbol, unknown>)[Symbol.for("libera.recordings")] = undefined;
    const reloaded = await sessions.getRecordingStatus(created.id);
    assert.equal(reloaded.transcriptEdits?.segments[0].text, "Notes typed by hand.");
    assert.equal(reloaded.recap?.bullets[0].text, "Decide the venue.");

    const finished = await sessions.finishRecording(created.id);
    assert.ok(finished.recapPath);
    const note = await readFile(path.join(dataRoot, "users", "admin", finished.recapPath!), "utf8");
    assert.match(note, /- Decide the venue\./);
    const { readTranscript } = await import("../../src/lib/storage/transcripts");
    const { transcript } = await readTranscript(finished.path);
    assert.deepEqual(transcript?.segments.map((segment) => segment.text), ["Notes typed by hand."]);
    assert.equal(transcript?.stats.words, 4);

    // Corrections to the saved transcript replace its passages and recount the words.
    const { editTranscriptSegments } = await import("../../src/lib/storage/transcripts");
    const edited = await editTranscriptSegments(finished.path, [line(0, 0.5, "Notes typed by hand,"), line(0.5, 1, "then corrected.")]);
    assert.equal(edited.stats.words, 6);
    assert.equal((await readTranscript(finished.path)).transcript?.segments[1].text, "then corrected.");
    await assert.rejects(() => editTranscriptSegments(finished.path, "nope"));
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(dataRoot, { recursive: true, force: true });
  }
});
