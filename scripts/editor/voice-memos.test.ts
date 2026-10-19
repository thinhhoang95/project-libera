import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { normalizeTranscriptionPreferences } from "../../electron/transcription-preferences.cjs";
import { GET as getRawFile } from "../../src/app/api/files/raw/[...path]/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import { searchKindLabel, searchLocationLabel } from "../../src/lib/global-search";
import { parseByteRange } from "../../src/lib/http-range";
import { copyFileToDirectory, createFolder, deleteFile, moveFileToDirectory, renameFolder } from "../../src/lib/storage/files";
import { getContentType, getFileType } from "../../src/lib/storage/file-types";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { filePathFromParts, transcriptPath } from "../../src/lib/storage/paths";
import { readTranscript, renameTranscriptSpeakers, transcriptSignature, writeTranscript } from "../../src/lib/storage/transcripts";
import { formatClock, segmentIndexAt, transcriptPassages, transcriptToMarkdown, transcriptToSrt } from "../../src/lib/transcription/format";
import { wordsFromResponse } from "../../src/lib/transcription/openrouter-stt";
import {
  assignSpeakers,
  groupSegments,
  joinTurns,
  orderSpeakers,
  planPieces,
  quietestPoint,
  speechCoverage,
  speechRegions,
  wordsFromSegments,
  wordsFromTokens,
} from "../../src/lib/transcription/plan";
import { TRANSCRIPT_VERSION, type Transcript } from "../../src/lib/transcription/types";

function transcript(overrides: Partial<Transcript> = {}): Transcript {
  return {
    version: TRANSCRIPT_VERSION,
    createdAt: "2026-10-19T10:00:00.000Z",
    audio: { size: 4, modifiedAt: "2026-10-19T09:00:00.000Z", duration: 20 },
    engine: { kind: "local", model: "Parakeet TDT 0.6B v3" },
    language: "en",
    diarization: null,
    speakers: [
      { name: "Speaker 1", talkSeconds: 8, share: 0.6, segments: 2 },
      { name: "Speaker 2", talkSeconds: 5, share: 0.4, segments: 1 },
    ],
    segments: [
      { start: 0, end: 4, speaker: 0, text: "Hello and welcome." },
      { start: 4.5, end: 9, speaker: 1, text: "Thanks for having me." },
      { start: 9.5, end: 14, speaker: 0, text: "Let us talk about sparse attention." },
    ],
    stats: { words: 14, chunks: 1, elapsedMs: 1000 },
    ...overrides,
  };
}

async function withLibrary(run: () => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "libera-voice-memos-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = path.join(root, "library");
  try {
    await createNotebook("Notes");
    await run();
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function recording(relative: string, bytes = Buffer.from("RIFF")) {
  const [notebook, ...parts] = relative.split("/");
  const target = filePathFromParts(notebook, parts);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return target;
}

function sidecar(relative: string) {
  const [notebook, ...parts] = relative.split("/");
  return transcriptPath(notebook, parts);
}

test("recordings are audio files with playable content types", () => {
  assert.equal(getFileType("Interview.m4a"), "audio");
  assert.equal(getFileType("memo.MP3"), "audio");
  assert.equal(getFileType("call.opus"), "audio");
  assert.equal(getContentType("memo.m4a", "audio"), "audio/mp4");
  assert.equal(getContentType("memo.mp3", "audio"), "audio/mpeg");
  assert.equal(getContentType("memo.wav", "audio"), "audio/wav");
});

test("speech regions pad turns and join short pauses; no turns covers the recording", () => {
  assert.deepEqual(speechRegions([], 30), [{ start: 0, end: 30 }]);
  const regions = speechRegions([
    { start: 1, end: 3, speaker: 0 },
    { start: 3.5, end: 6, speaker: 1 },
    { start: 20, end: 25, speaker: 0 },
  ], 26);
  assert.equal(regions.length, 2);
  assert.ok(Math.abs(regions[0].start - 0.75) < 1e-9 && Math.abs(regions[0].end - 6.25) < 1e-9);
  assert.ok(Math.abs(regions[1].end - 25.25) < 1e-9);
});

test("long speech is cut at its quietest moment, and pieces cover it without overlap", () => {
  // Loud everywhere except a silence at 20 s.
  const values = Array.from({ length: 1200 }, (_, frame) => (frame >= 398 && frame <= 402 ? 0.001 : 0.5));
  const envelope = { frameSeconds: 0.05, values };
  assert.ok(Math.abs(quietestPoint(envelope, 15, 28) - 20.025) < 0.06);
  const pieces = planPieces([{ start: 0, end: 60 }], envelope, { maxSeconds: 28, packGap: 1 });
  assert.ok(pieces.every((piece) => piece.end - piece.start <= 28 + 1e-9));
  assert.ok(Math.abs(pieces[0].end - 20.025) < 0.06, "the first cut lands in the silence");
  for (let index = 1; index < pieces.length; index += 1) assert.equal(pieces[index].start, pieces[index - 1].end);
  assert.equal(pieces.at(-1)!.end, 60);
});

test("nearby regions are packed into one piece up to the limit", () => {
  const envelope = { frameSeconds: 0.05, values: new Array(4000).fill(0.2) };
  const pieces = planPieces([{ start: 0, end: 10 }, { start: 12, end: 20 }, { start: 100, end: 110 }], envelope, { maxSeconds: 240, packGap: 8 });
  assert.deepEqual(pieces, [{ start: 0, end: 20 }, { start: 100, end: 110 }]);
});

test("transducer tokens become words at the piece's offset", () => {
  const words = wordsFromTokens([" Hel", "lo", " world", "."], [0.1, 0.3, 0.6, 0.9], 30, 32);
  assert.deepEqual(words.map((word) => word.text), ["Hello", "world."]);
  assert.ok(Math.abs(words[0].start - 30.1) < 1e-9);
  assert.ok(Math.abs(words[1].start - 30.6) < 1e-9);
  assert.ok(words[1].end <= 32);
  // SentencePiece's ▁ marks word starts too.
  assert.deepEqual(wordsFromTokens(["▁Xin", "▁chào"], [0, 0.4], 0, 1).map((word) => word.text), ["Xin", "chào"]);
});

test("segment-only responses are spread into timed words", () => {
  const words = wordsFromSegments([{ start: 0, end: 2, text: "one two" }], 10);
  assert.equal(words.length, 2);
  assert.equal(words[0].start, 10);
  assert.ok(Math.abs(words[1].end - 12) < 1e-9);
});

test("words take the speaker they overlap most, or the nearest turn, across long turns", () => {
  const turns = [
    { start: 0, end: 100, speaker: 7 },
    { start: 10, end: 12, speaker: 3 },
    { start: 120, end: 130, speaker: 3 },
  ];
  const words = assignSpeakers([
    { start: 10.2, end: 11.8, text: "overlapping" },
    { start: 50, end: 51, text: "long" },
    { start: 100.5, end: 101, text: "near" },
    { start: 110, end: 111, text: "alone" },
  ], turns);
  assert.deepEqual(words.map((word) => word.speaker), [3, 7, 7, null]);
  assert.deepEqual(assignSpeakers([{ start: 0, end: 1, text: "x" }], []).map((word) => word.speaker), [null]);
});

test("segments break at speaker changes, pauses and sentence ends past the soft limit", () => {
  const segments = groupSegments([
    { start: 0, end: 0.5, text: "Hi", speaker: 0 },
    { start: 0.6, end: 1, text: "there.", speaker: 0 },
    { start: 1.2, end: 1.6, text: "Hello", speaker: 1 },
    { start: 5, end: 5.5, text: "Later", speaker: 1 },
  ]);
  assert.deepEqual(segments.map((segment) => [segment.speaker, segment.text]), [[0, "Hi there."], [1, "Hello"], [1, "Later"]]);

  const long = Array.from({ length: 40 }, (_, index) => ({ start: index, end: index + 0.9, text: index % 10 === 9 ? "end." : "word", speaker: 0 }));
  const split = groupSegments(long, { softMaxSeconds: 25 });
  assert.equal(split.length, 2);
  assert.ok(split[0].text.endsWith("end."));
  // Punctuation returned as its own word attaches without a space; CJK joins without spaces.
  assert.equal(groupSegments([{ start: 0, end: 1, text: "Yes", speaker: null }, { start: 1, end: 1.1, text: ",", speaker: null }])[0].text, "Yes,");
  assert.equal(groupSegments([{ start: 0, end: 1, text: "你好", speaker: null }, { start: 1, end: 2, text: "世界", speaker: null }])[0].text, "你好世界");
});

test("speakers are numbered by first appearance with talk time and share", () => {
  const turns = [{ start: 0, end: 4, speaker: 5 }, { start: 4, end: 10, speaker: 2 }];
  const ordered = orderSpeakers([
    { start: 0, end: 4, speaker: 5, text: "a" },
    { start: 4, end: 10, speaker: 2, text: "b" },
    { start: 10, end: 11, speaker: null, text: "c" },
  ], turns);
  assert.deepEqual(ordered.segments.map((segment) => segment.speaker), [0, 1, null]);
  assert.deepEqual(ordered.speakers.map((speaker) => [speaker.name, speaker.talkSeconds, speaker.share, speaker.segments]), [
    ["Speaker 1", 4, 0.4, 1],
    ["Speaker 2", 6, 0.6, 1],
  ]);
});

test("coverage counts speech and overlapping speech; back-to-back turns of a speaker join", () => {
  assert.deepEqual(speechCoverage([{ start: 0, end: 10, speaker: 0 }, { start: 8, end: 12, speaker: 1 }]), { speechSeconds: 12, overlapSeconds: 2 });
  assert.deepEqual(joinTurns([{ start: 0, end: 2, speaker: 1 }, { start: 2.1, end: 3, speaker: 1 }, { start: 3, end: 4, speaker: 0 }]), [
    { start: 0, end: 3, speaker: 1 },
    { start: 3, end: 4, speaker: 0 },
  ]);
});

test("OpenRouter words, segments or text all become timed words", () => {
  assert.deepEqual(wordsFromResponse({ words: [{ start: 0, end: 0.5, word: " Hi" }, { start: 0.5, end: 1, word: "(laughs)", type: "audio_event" }] }, 60, 120).map((word) => [word.start, word.text]), [[60, "Hi"]]);
  assert.equal(wordsFromResponse({ segments: [{ start: 1, end: 2, text: "a b" }] }, 0, 10).length, 2);
  const textOnly = wordsFromResponse({ text: "just text" }, 30, 10);
  assert.equal(textOnly[0].start, 30);
  assert.ok(Math.abs(textOnly.at(-1)!.end - 40) < 1e-9);
});

test("clock, current segment, passages and exports", () => {
  assert.equal(formatClock(65), "1:05");
  assert.equal(formatClock(3723), "1:02:03");
  const value = transcript();
  assert.equal(segmentIndexAt(value.segments, -1), -1);
  assert.equal(segmentIndexAt(value.segments, 5), 1);
  assert.equal(segmentIndexAt(value.segments, 99), 2);

  const passages = transcriptPassages(value);
  assert.equal(passages.length, 1);
  assert.equal(passages[0].start, 0);
  assert.equal(passages[0].end, 14000);
  assert.match(passages[0].text, /^Speaker 1: Hello and welcome\.\nSpeaker 2: Thanks/);
  assert.equal(passages[0].title, "Speaker 1, Speaker 2");

  assert.match(transcriptToMarkdown(value, "Interview"), /^# Interview\n[\s\S]*\*\*Speaker 2\*\* · 0:04\nThanks for having me\./);
  assert.match(transcriptToSrt(value), /^1\n00:00:00,000 --> 00:00:04,000\nSpeaker 1: Hello and welcome\./);
  assert.equal(searchKindLabel("audio"), "Voice memo");
  assert.equal(searchLocationLabel("audio", { start: 125000, section: "Speaker 1" }), "2:05 · Speaker 1");
});

test("long transcripts split into passages of about 250 tokens with context", () => {
  const segments = Array.from({ length: 60 }, (_, index) => ({ start: index * 5, end: index * 5 + 4, speaker: index % 2, text: `Sentence number ${index} about the experiment and its careful setup.` }));
  const passages = transcriptPassages(transcript({ segments }));
  assert.ok(passages.length > 2);
  assert.ok(passages.every((passage) => passage.text.length <= 1300));
  assert.equal(passages[0].context, "");
  assert.ok(passages[1].context.length > 0);
  assert.ok(passages[1].start > passages[0].start);
});

test("transcripts are sidecars that follow their recording through moves, copies and deletion", () => withLibrary(async () => {
  await recording("Notes/memos/interview.m4a");
  assert.deepEqual(await readTranscript("Notes/memos/interview.m4a"), { transcript: null, stale: false, shared: false });
  assert.equal(await transcriptSignature("Notes/memos/interview.m4a"), "");

  await writeTranscript("Notes/memos/interview.m4a", transcript());
  const read = await readTranscript("Notes/memos/interview.m4a");
  assert.equal(read.transcript?.segments.length, 3);
  assert.equal(read.stale, false);
  assert.match(await transcriptSignature("Notes/memos/interview.m4a"), /^transcript:/);
  assert.ok(!existsSync(path.join(filePathFromParts("Notes", ["memos"]), "interview.m4a.json")), "nothing is written into the notebook folder");

  const renamed = await renameTranscriptSpeakers("Notes/memos/interview.m4a", { 0: "Vy", 1: "  " });
  assert.deepEqual(renamed.speakers.map((speaker) => speaker.name), ["Vy", "Speaker 2"]);

  await createFolder("Notes", "archive");
  await moveFileToDirectory("Notes/memos/interview.m4a", "Notes/archive");
  assert.ok(!existsSync(sidecar("Notes/memos/interview.m4a")));
  assert.equal((await readTranscript("Notes/archive/interview.m4a")).transcript?.speakers[0].name, "Vy");

  await copyFileToDirectory("Notes/archive/interview.m4a", "Notes/memos");
  assert.equal((await readTranscript("Notes/memos/interview.m4a")).stale, false, "a copy keeps its transcript current");
  assert.ok(existsSync(sidecar("Notes/archive/interview.m4a")));

  await renameFolder("Notes/archive", "old");
  assert.ok(existsSync(sidecar("Notes/old/interview.m4a")));

  await recording("Notes/old/interview.m4a", Buffer.from("RIFF and more audio"));
  assert.equal((await readTranscript("Notes/old/interview.m4a")).stale, true, "a changed recording marks its transcript stale");

  await deleteFile("Notes/old/interview.m4a");
  assert.ok(!existsSync(sidecar("Notes/old/interview.m4a")));
}));

test("byte ranges are parsed like browsers send them", () => {
  assert.deepEqual(parseByteRange("bytes=0-", 100), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseByteRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange("bytes=50-500", 100), { start: 50, end: 99 });
  assert.equal(parseByteRange("bytes=100-", 100), null);
  assert.equal(parseByteRange("items=0-1", 100), null);
});

test("recordings stream in ranges so the player can seek", () => withLibrary(async () => {
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 256));
  await recording("Notes/memo.mp3", bytes);
  const context = { params: Promise.resolve({ path: ["Notes", "memo.mp3"] }) };
  const request = (range?: string) => new NextRequest("http://localhost/api/files/raw/Notes/memo.mp3", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}`, ...(range ? { range } : {}) },
  });

  const whole = await getRawFile(request(), context);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("Accept-Ranges"), "bytes");
  assert.equal(whole.headers.get("Content-Type"), "audio/mpeg");
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), bytes);

  const part = await getRawFile(request("bytes=100-199"), context);
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("Content-Range"), "bytes 100-199/1000");
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(100, 200));

  assert.equal((await getRawFile(request("bytes=5000-"), context)).status, 416);
}));

test("preferences keep valid choices and fall back to defaults", () => {
  assert.deepEqual(normalizeTranscriptionPreferences({}), {
    engine: "local", openRouterModel: "openai/whisper-large-v3", language: "", modelDirectory: "", diarization: true, speakers: 0, ffmpegPath: "",
    dictation: { engine: "same", openRouterModel: "", language: "" },
  });
  const chosen = normalizeTranscriptionPreferences({ engine: "openrouter", openRouterModel: "openai/whisper-large-v3-turbo", language: "VI", speakers: "3", diarization: false });
  assert.equal(chosen.engine, "openrouter");
  assert.equal(chosen.language, "vi");
  assert.equal(chosen.speakers, 3);
  assert.equal(chosen.diarization, false);
  assert.equal(normalizeTranscriptionPreferences({ engine: "cloud", speakers: 40, language: "english" }).engine, "local");
  assert.equal(normalizeTranscriptionPreferences({ speakers: 40 }).speakers, 0);
});

test("dictation follows the voice memo engine unless it has its own", async () => {
  const { resolveDictationSettings } = await import("../../electron/transcription-preferences.cjs");
  const memos = normalizeTranscriptionPreferences({ engine: "local", openRouterModel: "openai/whisper-large-v3", language: "vi" });
  assert.deepEqual(resolveDictationSettings(memos), { engine: "local", openRouterModel: "openai/whisper-large-v3", language: "vi" });
  const own = normalizeTranscriptionPreferences({ engine: "local", language: "vi", dictation: { engine: "openrouter", openRouterModel: "openai/gpt-4o-mini-transcribe", language: "en" } });
  assert.deepEqual(resolveDictationSettings(own), { engine: "openrouter", openRouterModel: "openai/gpt-4o-mini-transcribe", language: "en" });
  assert.equal(normalizeTranscriptionPreferences({ dictation: { engine: "cloud" } }).dictation.engine, "same");
});

/** A 16-bit stereo WAV at 48 kHz: a tone for `seconds`, louder in the second half. */
function toneWav(seconds: number) {
  const rate = 48_000;
  const frames = rate * seconds;
  const buffer = Buffer.alloc(44 + frames * 4);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + frames * 4, 4);
  buffer.write("WAVEfmt ", 8, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(frames * 4, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const amplitude = frame < frames / 2 ? 0.1 : 0.6;
    const value = Math.round(Math.sin((2 * Math.PI * 220 * frame) / rate) * amplitude * 32767);
    buffer.writeInt16LE(value, 44 + frame * 4);
    buffer.writeInt16LE(value, 46 + frame * 4);
  }
  return buffer;
}

test("the worker decodes WAV to 16 kHz mono, measures loudness, slices pieces and draws peaks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-transcription-worker-"));
  const file = path.join(directory, "tone.wav");
  await writeFile(file, toneWav(2));
  const child = fork(path.join(process.cwd(), "electron", "transcription-worker.mjs"), [], { serialization: "advanced", stdio: ["ignore", "inherit", "inherit", "ipc"] });
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  child.on("message", (message: { id?: number; ok?: boolean; result?: unknown; error?: string; type?: string }) => {
    if (typeof message.id !== "number" || message.type === "progress") return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.ok) entry?.resolve(message.result);
    else entry?.reject(new Error(message.error));
  });
  const request = <T>(type: string, payload: Record<string, unknown> = {}) => new Promise<T>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    child.send({ id, type, ...payload });
  });
  try {
    await request("configure", { config: { threads: 1, decoder: { kind: "wav-only", path: "" } } });
    const opened = await request<{ handle: string; duration: number; envelope: { frameSeconds: number; values: Float32Array } }>("open", { path: file });
    assert.ok(Math.abs(opened.duration - 2) < 0.01);
    assert.equal(opened.envelope.values.length, 40);
    assert.ok(opened.envelope.values[35] > opened.envelope.values[5] * 3, "the louder half measures louder");

    const wav = Buffer.from(await request<Uint8Array>("wav", { handle: opened.handle, start: 0.5, end: 1 }));
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.readUInt32LE(24), 16_000);
    assert.equal(wav.readUInt32LE(40), 8000 * 2, "half a second of 16-bit samples");

    const peaks = await request<{ duration: number; peaks: number[] }>("peaks", { path: file, buckets: 20 });
    assert.equal(peaks.peaks.length, 20);
    assert.ok(Math.abs(peaks.duration - 2) < 0.01);
    assert.ok(peaks.peaks[15] > peaks.peaks[2]);

    await request("close", { handle: opened.handle });
    await assert.rejects(request("wav", { handle: opened.handle, start: 0, end: 1 }), /no longer open/);
    await assert.rejects(request("open", { path: path.join(directory, "missing.m4a") }));
  } finally {
    child.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});

test("transcript search reads speaker: filters by name start, number or quoted name", async () => {
  const { parseTranscriptQuery } = await import("../../src/lib/transcription/format");
  const speakers = [{ name: "Vy" }, { name: "Speaker 2" }, { name: "Vyas Rao" }, { name: "Đức" }];
  assert.deepEqual(parseTranscriptQuery("budget speaker:Vy", speakers), { text: "budget", speakers: [0], unknown: [] });
  assert.deepEqual(parseTranscriptQuery("speaker:vya", speakers).speakers, [2]);
  assert.deepEqual(parseTranscriptQuery('speaker:"Speaker 2" deadline', speakers), { text: "deadline", speakers: [1], unknown: [] });
  assert.deepEqual(parseTranscriptQuery("speaker:2 speaker:duc", speakers).speakers, [1, 3]);
  assert.deepEqual(parseTranscriptQuery("speaker:Nobody", speakers), { text: "", speakers: [], unknown: ["Nobody"] });
  assert.deepEqual(parseTranscriptQuery("plain words", speakers), { text: "plain words", speakers: null, unknown: [] });
});

test("Global Search speaker: filters keep voice memo passages where that speaker talks", async () => {
  const { extractSpeakerFilters, passageHasSpeaker } = await import("../../src/lib/global-search");
  const { parts, speakers } = extractSpeakerFilters([{ type: "text", text: 'budget speaker:Vy speaker:"Speaker 2"' }]);
  assert.deepEqual(speakers, ["Vy", "Speaker 2"]);
  assert.deepEqual(parts, [{ type: "text", text: "budget  " }]);
  assert.equal(passageHasSpeaker("Speaker 1: hello\nVy: the budget", ["vy"]), true);
  assert.equal(passageHasSpeaker("Speaker 1: Vy said the budget", ["vy"]), false);
});

test("transcripts export as text, WebVTT and AI context with links to moments", async () => {
  const { transcriptContextText, transcriptToText, transcriptToVtt } = await import("../../src/lib/transcription/format");
  const value = transcript();
  assert.match(transcriptToText(value), /^\[0:00\] Speaker 1: Hello and welcome\.\n\n\[0:04\] Speaker 2: Thanks/);
  assert.match(transcriptToVtt(value), /^WEBVTT\n\n00:00:00\.000 --> 00:00:04\.000\n<v Speaker 1>Hello and welcome\./);
  const context = transcriptContextText(value, "Lab meeting.m4a", "Memos/Lab meeting.m4a");
  assert.match(context, /^Transcript of the recording Lab meeting\.m4a \(0:20; speakers: Speaker 1, Speaker 2\)\.\nTo cite a moment, link it as \[3:05\]\(Memos\/Lab%20meeting\.m4a#t=185\)/);
  assert.match(context, /\[0:09\] Speaker 1: Let us talk about sparse attention\./);
});

test("links to a moment in a recording read and resolve as #t=", async () => {
  const { createMarkdownFileLinkDestination, parseMediaTime, resolveMarkdownFileLink } = await import("../../src/lib/markdown-file-links");
  assert.equal(parseMediaTime("73"), 73);
  assert.equal(parseMediaTime("1:13"), 73);
  assert.equal(parseMediaTime("1:02:03.5"), 3723.5);
  assert.equal(parseMediaTime("x"), undefined);
  const destination = createMarkdownFileLinkDestination({
    sourcePath: "Notes/today.md",
    targetPath: "Memos/Lab meeting.m4a",
    metadata: { v: 1, fileType: "audio", viewState: { audio: { currentTime: 73.6 } } },
  });
  assert.equal(destination, "../Memos/Lab%20meeting.m4a#t=73");
  const file = { kind: "file" as const, name: "Lab meeting.m4a", path: "Memos/Lab meeting.m4a", notebook: "Memos", fileType: "audio" as const, createdAt: "", updatedAt: "", size: 1 };
  assert.equal(resolveMarkdownFileLink(destination, "Notes/today.md", [file])?.metadata?.viewState?.audio?.currentTime, 73);
  // A library path, as the transcript panel copies and the AI writes.
  assert.equal(resolveMarkdownFileLink("Memos/Lab%20meeting.m4a#t=1:05", "Notes/today.md", [file])?.metadata?.viewState?.audio?.currentTime, 65);
});
