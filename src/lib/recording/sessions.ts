import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAiFunctionOptions, withAiCustomInstruction } from "@/lib/ai-preferences";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { createMarkdownFileLinkDestination } from "@/lib/markdown-file-links";
import { createOpenRouterCompletion } from "@/lib/openrouter";
import {
  applyRecapEdits,
  applyRecapOperations,
  cleanRecapEdits,
  parseRecapOperations,
  RECAP_MAX_NEW_WORDS,
  RECAP_MIN_INTERVAL_MS,
  RECAP_MIN_NEW_WORDS,
  RECAP_SYSTEM_PROMPT,
  recapMarkdown,
  recapUserMessage,
} from "@/lib/recording/recap";
import {
  RECORDING_SAMPLE_RATE,
  type FinishedRecording,
  type RecordingRecap,
  type RecordingState,
  type RecordingStatus,
  type UnfinishedRecording,
} from "@/lib/recording/types";
import { joinPath } from "@/lib/runtime-path";
import { createMarkdownFile, writeUploadedFile } from "@/lib/storage/files";
import { StorageError } from "@/lib/storage/errors";
import { assertDirectoryExists, findAvailableFilePath } from "@/lib/storage/fs-utils";
import { filePathFromParts, getDataRoot, itemPath, splitDirectoryPath } from "@/lib/storage/paths";
import { writeTranscript } from "@/lib/storage/transcripts";
import { applySegmentEdits, cleanSegmentEdits, countWords, type SegmentEdits } from "@/lib/transcription/edits";
import { detectAsrModel, SPEECH_MODELS } from "@/lib/transcription/models";
import { groupSegments, wordsFromTokens, type TimedWord } from "@/lib/transcription/plan";
import { findAudioDecoder, getTranscriptionPreferences, type AudioDecoder } from "@/lib/transcription/settings";
import { TRANSCRIPT_VERSION, type Transcript, type TranscriptSegment } from "@/lib/transcription/types";
import { getTranscriptionWorker } from "@/lib/transcription/worker-client";

/**
 * A recording in progress lives in Libera's data folder, not in the notebook,
 * as one growing WAV. The recorder sends a chunk of a few seconds whenever the
 * speaker pauses, and each chunk is written into recording.wav at its position
 * and noted in chunks.jsonl, so a crash of the window or the app loses at most
 * the last few seconds; what is found on the next start can be saved or
 * recorded on. session.json holds only the settings, so it is written when they
 * change and not as the audio comes in. The chunks are also what live
 * transcription reads: Parakeet is an offline model, so it hears the recording
 * piece by piece, the way sherpa-onnx's "simulated streaming" does.
 *
 * Finishing completes the WAV's header and saves it into the notebook (AAC when
 * ffmpeg or afconvert is there, WAV otherwise), with the live transcript as its
 * transcript and the live recap as a note beside it. The reader may correct
 * both while recording; their transcript edits are kept beside the audio
 * (edits.json) and the finished transcript is the live one as they left it.
 */

type ChunkRecord = { index: number; start: number; samples: number; transcribed: boolean };

type SessionMeta = {
  id: string;
  name: string;
  /** The folder the recording goes into: "Notebook" or "Notebook/folder". */
  directory: string;
  createdAt: string;
  state: RecordingState;
  liveTranscribe: boolean;
  liveRecap: boolean;
};

type StoredRecap = Pick<RecordingRecap, "version" | "bullets" | "wordsRead" | "lastChanged">;

type Runtime = {
  meta: SessionMeta;
  directory: string;
  /** The saved chunks, in recording order. */
  chunks: ChunkRecord[];
  /** Recognized words by chunk index. */
  words: Map<number, TimedWord[]>;
  recap: RecordingRecap;
  /** The reader's edits to the live transcript. */
  edits: SegmentEdits | null;
  transcribeError: string;
  transcribing: Promise<void> | null;
  recapping: Promise<void> | null;
  lastRecapAt: number;
  saving: Promise<void>;
};

const WAV_HEADER_BYTES = 44;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const recordingsRoot = () => joinPath(getDataRoot(), "recordings");
const audioFile = (directory: string) => path.join(directory, "recording.wav");
const chunkLog = (directory: string) => path.join(directory, "chunks.jsonl");
const chunkLine = ({ index, start, samples }: ChunkRecord) => `${JSON.stringify({ index, start, samples })}\n`;
/** Where a sample sits in recording.wav. */
const audioOffset = (sample: number) => WAV_HEADER_BYTES + sample * 2;
const seconds = (samples: number) => samples / RECORDING_SAMPLE_RATE;
const savedSamples = (chunks: ChunkRecord[]) => chunks.reduce((end, chunk) => Math.max(end, chunk.start + chunk.samples), 0);

const RUNTIMES_KEY = Symbol.for("libera.recordings");
function runtimes() {
  const store = globalThis as { [RUNTIMES_KEY]?: Map<string, Runtime> };
  store[RUNTIMES_KEY] ??= new Map();
  return store[RUNTIMES_KEY];
}

async function writeJson(file: string, value: unknown) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, file);
}

/** Writes in order, each with the state as it is when its turn comes. */
function persist(runtime: Runtime, what: "meta" | "recap" | "edits" = "meta") {
  runtime.saving = runtime.saving.then(() => what === "meta"
    ? writeJson(path.join(runtime.directory, "session.json"), runtime.meta)
    : what === "edits"
      ? writeJson(path.join(runtime.directory, "edits.json"), runtime.edits)
      : writeJson(path.join(runtime.directory, "recap.json"), {
        version: runtime.recap.version,
        bullets: runtime.recap.bullets,
        wordsRead: runtime.recap.wordsRead,
        lastChanged: runtime.recap.lastChanged,
      } satisfies StoredRecap)).catch((error) => {
    console.warn(`Could not save recording ${runtime.meta.id}: ${error instanceof Error ? error.message : error}`);
  });
  return runtime.saving;
}

/**
 * Recordings used to be kept as one chunk-000123.wav per chunk, listed in
 * session.json. Rewriting session.json without its list is what commits the
 * move, so one cut short simply starts over.
 */
async function moveChunkFilesIntoAudio(directory: string) {
  const session = path.join(directory, "session.json");
  const { chunks, ...meta } = JSON.parse(await readFile(session, "utf8")) as SessionMeta & { chunks?: ChunkRecord[] };
  if (!Array.isArray(chunks)) return;
  const oldFile = (index: number) => path.join(directory, `chunk-${String(index).padStart(6, "0")}.wav`);
  const file = await open(audioFile(directory), "w");
  try {
    for (const chunk of chunks) {
      // A missing chunk stays a gap, which is silence.
      const data = (await readFile(oldFile(chunk.index)).catch(() => null))?.subarray(WAV_HEADER_BYTES);
      if (data) await file.write(data, 0, data.length, audioOffset(chunk.start));
    }
  } finally {
    await file.close();
  }
  await writeFile(chunkLog(directory), chunks.map(chunkLine).join(""));
  await writeJson(session, meta);
  await Promise.all(chunks.map((chunk) => rm(oldFile(chunk.index), { force: true })));
}

/** The start screen and an open tab can load the same recording at once; only one may move its files. */
const UPGRADES_KEY = Symbol.for("libera.recordings.upgrades");
function upgradeOnce(directory: string) {
  const store = globalThis as { [UPGRADES_KEY]?: Map<string, Promise<void>> };
  const upgrades = store[UPGRADES_KEY] ??= new Map();
  const running = upgrades.get(directory);
  if (running) return running;
  const upgrade = moveChunkFilesIntoAudio(directory).finally(() => upgrades.delete(directory));
  upgrades.set(directory, upgrade);
  return upgrade;
}

async function readChunks(directory: string) {
  let text = "";
  try {
    text = await readFile(chunkLog(directory), "utf8");
  } catch {
    return [];
  }
  // A line cut off by a crash must not swallow the next chunk's line.
  if (text && !text.endsWith("\n")) await appendFile(chunkLog(directory), "\n");
  const chunks = new Map<number, ChunkRecord>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const { index, start, samples } = JSON.parse(line) as ChunkRecord;
      if (Number.isInteger(index) && Number.isInteger(start) && Number.isInteger(samples)) chunks.set(index, { index, start, samples, transcribed: false });
    } catch {
      // That chunk's audio was not acknowledged either; the recorder's next chunk takes its place.
    }
  }
  return [...chunks.values()].sort((a, b) => a.start - b.start);
}

function emptyRecap(): RecordingRecap {
  return { version: 0, bullets: [], wordsRead: 0, lastChanged: [], error: "", updating: false };
}

async function loadRuntime(id: string): Promise<Runtime | null> {
  const directory = path.join(recordingsRoot(), id);
  let meta: SessionMeta & { chunks?: unknown };
  try {
    meta = JSON.parse(await readFile(path.join(directory, "session.json"), "utf8")) as SessionMeta;
  } catch {
    return null;
  }
  if (meta.id !== id) return null;
  if (meta.chunks !== undefined) {
    try {
      await upgradeOnce(directory);
    } catch (error) {
      console.warn(`Could not read recording ${id}: ${error instanceof Error ? error.message : error}`);
      return null;
    }
    delete meta.chunks;
  }
  // A finish that was cut short is picked up again as an unfinished recording.
  if (meta.state === "finishing") meta.state = "recording";

  const words = new Map<number, TimedWord[]>();
  try {
    for (const line of (await readFile(path.join(directory, "words.jsonl"), "utf8")).split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { index: number; words: TimedWord[] };
        if (typeof entry.index === "number" && Array.isArray(entry.words)) words.set(entry.index, entry.words);
      } catch {
        // A line cut off by a crash; its chunk is recognized again.
      }
    }
  } catch {
    // No transcript yet.
  }
  const chunks = await readChunks(directory);
  for (const chunk of chunks) chunk.transcribed = words.has(chunk.index);

  const recap = emptyRecap();
  try {
    const stored = JSON.parse(await readFile(path.join(directory, "recap.json"), "utf8")) as StoredRecap;
    if (Array.isArray(stored.bullets)) Object.assign(recap, { version: stored.version || 1, bullets: stored.bullets, wordsRead: stored.wordsRead || 0 });
  } catch {
    // No recap yet.
  }

  let edits: SegmentEdits | null = null;
  try {
    edits = cleanSegmentEdits(JSON.parse(await readFile(path.join(directory, "edits.json"), "utf8")), Number.MAX_SAFE_INTEGER);
  } catch {
    // The transcript was not edited.
  }

  return { meta, directory, chunks, words, recap, edits, transcribeError: "", transcribing: null, recapping: null, lastRecapAt: 0, saving: Promise.resolve() };
}

async function getRuntime(id: string) {
  if (!ID_PATTERN.test(id)) throw new StorageError("Recording not found.", 404);
  const cached = runtimes().get(id);
  if (cached) return cached;
  const loaded = await loadRuntime(id);
  if (!loaded || loaded.meta.state === "finished") throw new StorageError("Recording not found.", 404);
  runtimes().set(id, loaded);
  return loaded;
}

function defaultName(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `Recording ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}`;
}

function cleanName(name: unknown) {
  return typeof name === "string" ? name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 120) : "";
}

export async function createRecording(input: { notebook?: string; parentPath?: string; name?: string; liveTranscribe?: boolean; liveRecap?: boolean }) {
  const directory = input.parentPath?.trim() || input.notebook?.trim() || "";
  if (!directory) throw new StorageError("Choose a notebook for the recording.");
  const destination = splitDirectoryPath(directory);
  await assertDirectoryExists(itemPath(destination.notebook, destination.pathParts), "The notebook for the recording was not found.");

  const id = randomUUID();
  const folder = path.join(recordingsRoot(), id);
  await mkdir(folder, { recursive: true });
  const runtime: Runtime = {
    meta: {
      id,
      name: cleanName(input.name) || defaultName(),
      directory,
      createdAt: new Date().toISOString(),
      state: "recording",
      liveTranscribe: Boolean(input.liveTranscribe),
      liveRecap: Boolean(input.liveRecap),
    },
    directory: folder,
    chunks: [],
    words: new Map(),
    recap: emptyRecap(),
    edits: null,
    transcribeError: "",
    transcribing: null,
    recapping: null,
    lastRecapAt: 0,
    saving: Promise.resolve(),
  };
  runtimes().set(id, runtime);
  await persist(runtime);
  return status(runtime, 0, -1);
}

/** Recordings that were never finished, newest first. Empty ones left behind are removed. */
export async function listUnfinishedRecordings(): Promise<UnfinishedRecording[]> {
  let names: string[] = [];
  try {
    names = await readdir(recordingsRoot());
  } catch {
    return [];
  }
  const result: UnfinishedRecording[] = [];
  for (const name of names) {
    if (!ID_PATTERN.test(name)) continue;
    const runtime = runtimes().get(name) ?? await loadRuntime(name);
    if (!runtime || runtime.meta.state === "finished") continue;
    if (!runtime.chunks.length) {
      if (!runtimes().has(name)) await rm(runtime.directory, { recursive: true, force: true });
      continue;
    }
    const { id, name: title, directory, createdAt } = runtime.meta;
    const { notebook } = splitDirectoryPath(directory);
    result.push({ id, name: title, notebook, parentPath: directory, createdAt, savedSeconds: seconds(savedSamples(runtime.chunks)), chunks: runtime.chunks.length });
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function liveSegments(runtime: Runtime): TranscriptSegment[] {
  return runtime.chunks
    .flatMap((chunk) => groupSegments(runtime.words.get(chunk.index) ?? [], { pauseSeconds: 1.2, softMaxSeconds: 20, hardMaxSeconds: 30 }));
}

function allWords(runtime: Runtime) {
  return runtime.chunks.flatMap((chunk) => runtime.words.get(chunk.index) ?? []);
}

function status(runtime: Runtime, after: number, recapVersion: number): RecordingStatus {
  const { id, name, directory, createdAt, state, liveTranscribe, liveRecap } = runtime.meta;
  const { chunks } = runtime;
  const segments = liveSegments(runtime);
  const from = Math.max(0, Math.min(segments.length, Math.floor(after) || 0));
  // The last segment may still grow when the next chunk continues a sentence, so it is sent again.
  const segmentsFrom = Math.max(0, from - 1);
  return {
    id,
    name,
    notebook: splitDirectoryPath(directory).notebook,
    parentPath: directory,
    createdAt,
    state,
    savedSeconds: seconds(savedSamples(chunks)),
    savedSamples: savedSamples(chunks),
    chunks: chunks.length,
    nextIndex: chunks.reduce((next, chunk) => Math.max(next, chunk.index + 1), 0),
    liveTranscribe,
    liveRecap,
    pendingChunks: liveTranscribe ? chunks.filter((chunk) => !chunk.transcribed).length : 0,
    transcribeError: runtime.transcribeError,
    segments: segments.slice(segmentsFrom),
    segmentsFrom,
    segmentCount: segments.length,
    ...(segmentsFrom === 0 ? { transcriptEdits: runtime.edits } : {}),
    recap: recapVersion === runtime.recap.version && !runtime.recap.updating ? null : runtime.recap,
    recapVersion: runtime.recap.version,
  };
}

export async function getRecordingStatus(id: string, after = 0, recapVersion = -1) {
  return status(await getRuntime(id), after, recapVersion);
}

/**
 * Renames the recording, turns live transcription or the recap on or off, or
 * keeps the reader's edits: `transcriptEdits` replaces the transcript edits,
 * `recapEdits` are applied to the recap as it is now (the model may have
 * amended it while the reader typed).
 */
export async function updateRecording(id: string, changes: { name?: unknown; liveTranscribe?: unknown; liveRecap?: unknown; transcriptEdits?: unknown; recapEdits?: unknown }) {
  const runtime = await getRuntime(id);
  if (runtime.meta.state !== "recording" && (changes.transcriptEdits !== undefined || changes.recapEdits !== undefined)) {
    throw new StorageError("The recording is being saved; edits can no longer be made.", 409);
  }
  if (changes.transcriptEdits !== undefined) {
    const edits = changes.transcriptEdits === null ? null : cleanSegmentEdits(changes.transcriptEdits, liveSegments(runtime).length);
    if (changes.transcriptEdits !== null && !edits) throw new StorageError("The transcript edits are not readable.");
    runtime.edits = edits;
    await persist(runtime, "edits");
  }
  if (changes.recapEdits !== undefined) {
    const edits = cleanRecapEdits(changes.recapEdits);
    if (!edits) throw new StorageError("The recap edits are not readable.");
    runtime.recap.bullets = applyRecapEdits(runtime.recap.bullets, edits, { number: true });
    // The reader's own changes do not glow as news.
    runtime.recap.lastChanged = [];
    runtime.recap.version += 1;
    await persist(runtime, "recap");
  }
  const name = cleanName(changes.name);
  if (name) runtime.meta.name = name;
  if (typeof changes.liveTranscribe === "boolean") runtime.meta.liveTranscribe = changes.liveTranscribe;
  if (typeof changes.liveRecap === "boolean") runtime.meta.liveRecap = changes.liveRecap;
  if (runtime.meta.liveTranscribe) {
    runtime.transcribeError = "";
    void transcribePending(runtime);
  }
  if (runtime.meta.liveRecap) {
    runtime.recap.error = "";
    void updateRecap(runtime);
  }
  if (name || typeof changes.liveTranscribe === "boolean" || typeof changes.liveRecap === "boolean") await persist(runtime);
  return status(runtime, 0, -1);
}

/**
 * Writes a chunk's samples at its place in the audio, then notes it. Audio
 * written without its note (a crash in between) is written over by the next
 * chunk or cut off on finishing. In turn with the other writes, so a chunk sent
 * again while the first try is still being written is kept once.
 */
function storeChunk(runtime: Runtime, chunk: ChunkRecord, wav: Uint8Array) {
  const stored = runtime.saving.then(async () => {
    if (runtime.chunks.some((saved) => saved.index === chunk.index)) return;
    const file = await open(audioFile(runtime.directory), fsConstants.O_WRONLY | fsConstants.O_CREAT);
    try {
      await file.write(wav, WAV_HEADER_BYTES, chunk.samples * 2, audioOffset(chunk.start));
    } finally {
      await file.close();
    }
    await appendFile(chunkLog(runtime.directory), chunkLine(chunk));
    runtime.chunks.push(chunk);
    runtime.chunks.sort((a, b) => a.start - b.start);
  });
  runtime.saving = stored.catch(() => undefined);
  return stored;
}

/**
 * Saves chunk `index`, which starts `start` samples into the recording. The
 * recorder sends each chunk until it is acknowledged, so a chunk saved twice
 * is kept once.
 */
export async function saveRecordingChunk(id: string, index: number, start: number, wav: Uint8Array) {
  const runtime = await getRuntime(id);
  if (runtime.meta.state !== "recording") throw new StorageError("This recording is already finished.", 409);
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(start) || start < 0) throw new StorageError("The chunk is not numbered.");
  if (wav.byteLength > MAX_CHUNK_BYTES) throw new StorageError("The chunk is too long.", 413);
  if (wav.byteLength <= WAV_HEADER_BYTES || new TextDecoder().decode(wav.subarray(0, 4)) !== "RIFF") throw new StorageError("The chunk is not a WAV file.");
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  if (view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== RECORDING_SAMPLE_RATE || view.getUint16(34, true) !== 16) {
    throw new StorageError("The chunk is not 16 kHz mono PCM.");
  }

  const samples = Math.floor((wav.byteLength - WAV_HEADER_BYTES) / 2);
  await storeChunk(runtime, { index, start, samples, transcribed: false }, wav);
  if (runtime.meta.liveTranscribe) void transcribePending(runtime);
  return { savedSeconds: seconds(savedSamples(runtime.chunks)), chunks: runtime.chunks.length };
}

function wavHeader(samples: number) {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + samples * 2, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RECORDING_SAMPLE_RATE, 24);
  header.writeUInt32LE(RECORDING_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(samples * 2, 40);
  return header;
}

/** One chunk as a WAV of its own, for Parakeet. The next chunk reuses the file. */
export async function writeChunkForHearing(directory: string, chunk: Pick<ChunkRecord, "start" | "samples">) {
  const data = Buffer.alloc(chunk.samples * 2);
  const file = await open(audioFile(directory), "r");
  try {
    await file.read(data, 0, data.length, audioOffset(chunk.start));
  } finally {
    await file.close();
  }
  const target = path.join(directory, "hearing.wav");
  await writeFile(target, Buffer.concat([wavHeader(chunk.samples), data]));
  return target;
}

/** Recognizes the chunks Parakeet has not heard yet, oldest first; one run per recording at a time. */
function transcribePending(runtime: Runtime): Promise<void> {
  if (runtime.transcribing) return runtime.transcribing;
  const run = (async () => {
    const model = await detectAsrModel();
    if (!model) {
      runtime.transcribeError = "Parakeet is not downloaded. Download the speech models to transcribe live.";
      return;
    }
    const worker = getTranscriptionWorker();
    worker.configure(await findAudioDecoder(getTranscriptionPreferences()));
    for (;;) {
      const chunk = runtime.chunks.find((candidate) => !candidate.transcribed);
      if (!chunk || !runtime.meta.liveTranscribe) break;
      const offset = seconds(chunk.start);
      let words: TimedWord[] = [];
      const opened = await worker.open(await writeChunkForHearing(runtime.directory, chunk));
      try {
        const result = await worker.recognize(opened.handle, 0, opened.duration, model);
        words = wordsFromTokens(result.tokens, result.timestamps, offset, offset + opened.duration, result.durations);
      } finally {
        await worker.close(opened.handle);
      }
      if (runtimes().get(runtime.meta.id) !== runtime) return;
      runtime.words.set(chunk.index, words);
      chunk.transcribed = true;
      runtime.transcribeError = "";
      await appendFile(path.join(runtime.directory, "words.jsonl"), `${JSON.stringify({ index: chunk.index, words })}\n`);
      void updateRecap(runtime);
    }
  })().catch((error) => {
    runtime.transcribeError = error instanceof Error ? error.message : "Live transcription stopped.";
  }).finally(() => {
    runtime.transcribing = null;
  });
  runtime.transcribing = run;
  return run;
}

/**
 * Lets the model amend the recap with the transcript it has not read, once
 * enough is new and some time has passed (`force`: whatever is new, until it
 * has read everything, when the recording ends or the reader asks).
 */
function updateRecap(runtime: Runtime, { force = false } = {}): Promise<void> {
  if (runtime.recapping) {
    if (!force) return runtime.recapping;
    return runtime.recapping.then(() => updateRecap(runtime, { force }));
  }
  if (!runtime.meta.liveRecap) return Promise.resolve();
  const words = allWords(runtime);
  const unread = words.length - runtime.recap.wordsRead;
  if (unread <= 0) return Promise.resolve();
  if (!force && (unread < RECAP_MIN_NEW_WORDS || Date.now() - runtime.lastRecapAt < RECAP_MIN_INTERVAL_MS)) return Promise.resolve();

  const run = (async () => {
    runtime.recap.updating = true;
    runtime.lastRecapAt = Date.now();
    do {
      const read = runtime.recap.wordsRead;
      const fresh = words.slice(read, read + RECAP_MAX_NEW_WORDS);
      const reply = await createOpenRouterCompletion([
        { role: "system", content: withAiCustomInstruction(RECAP_SYSTEM_PROMPT, "recordingRecap") },
        { role: "user", content: recapUserMessage(runtime.recap.bullets, words.slice(0, read), fresh) },
      ], getAiFunctionOptions("recordingRecap"));
      // Bullets the reader wrote or corrected are theirs; changes to them are dropped.
      const operations = parseRecapOperations(reply.content, new Set(runtime.recap.bullets.filter((bullet) => !bullet.edited).map((bullet) => bullet.id)));
      const { bullets, changed } = applyRecapOperations(runtime.recap.bullets, operations, fresh[0]?.start ?? 0);
      runtime.recap.bullets = bullets;
      runtime.recap.lastChanged = changed;
      runtime.recap.wordsRead = read + fresh.length;
      runtime.recap.version += 1;
      runtime.recap.error = "";
      await persist(runtime, "recap");
    } while (force && runtime.recap.wordsRead < words.length);
  })().catch((error) => {
    // Model errors are terse ("User not found." for a revoked key), so say where they come from.
    runtime.recap.error = `The recap could not be updated: ${error instanceof Error ? error.message : "the model did not answer."} Check the OpenRouter key in Preferences → AI if this persists.`;
  }).finally(() => {
    runtime.recap.updating = false;
    runtime.recapping = null;
  });
  runtime.recapping = run;
  return run;
}

/** Brings the recap up to date now, whatever the timing. */
export async function refreshRecordingRecap(id: string) {
  const runtime = await getRuntime(id);
  runtime.recap.error = "";
  void updateRecap(runtime, { force: true });
  return status(runtime, 0, -1);
}

export async function discardRecording(id: string) {
  const runtime = await getRuntime(id);
  runtimes().delete(id);
  runtime.meta.state = "finished";
  await runtime.saving;
  await rm(runtime.directory, { recursive: true, force: true });
}

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile(command, args, { timeout: 10 * 60_000, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr).trim() || error.message));
      else resolve();
    });
  });
}

/** Makes recording.wav a complete WAV of what was saved: a gap left by a lost chunk is already silence. */
async function completeAudio(runtime: Runtime) {
  const total = savedSamples(runtime.chunks);
  const file = await open(audioFile(runtime.directory), fsConstants.O_WRONLY | fsConstants.O_CREAT);
  try {
    await file.truncate(audioOffset(total));
    await file.write(wavHeader(total), 0, WAV_HEADER_BYTES, 0);
  } finally {
    await file.close();
  }
}

/** AAC in an .m4a when there is an encoder (about a tenth of the size), otherwise the WAV as it is. */
async function compress(wav: string, decoder: AudioDecoder) {
  const m4a = wav.replace(/\.wav$/, ".m4a");
  try {
    if (decoder.kind === "ffmpeg") {
      await run(decoder.path, ["-y", "-hide_banner", "-loglevel", "error", "-i", wav, "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", m4a]);
      return { file: m4a, extension: ".m4a" };
    }
    if (process.platform === "darwin") {
      await run(decoder.kind === "afconvert" ? decoder.path : "/usr/bin/afconvert", ["-f", "m4af", "-d", "aac", "-b", "64000", wav, m4a]);
      return { file: m4a, extension: ".m4a" };
    }
  } catch (error) {
    console.warn(`Saving the recording as WAV: ${error instanceof Error ? error.message : error}`);
  }
  return { file: wav, extension: ".wav" };
}

/**
 * Saves the recording into its notebook: waits for Parakeet to hear the last
 * chunks and the recap to read them, then writes the audio, its transcript
 * and the recap note, and removes the working folder.
 */
export async function finishRecording(id: string): Promise<FinishedRecording> {
  const runtime = await getRuntime(id);
  if (runtime.meta.state === "finishing") throw new StorageError("The recording is already being saved.", 409);
  if (!runtime.chunks.length) {
    await discardRecording(id);
    throw new StorageError("Nothing was recorded.", 400);
  }
  runtime.meta.state = "finishing";
  await persist(runtime);
  try {
    if (runtime.meta.liveTranscribe) {
      await runtime.transcribing;
      await transcribePending(runtime);
    }
    await updateRecap(runtime, { force: true });

    const destination = splitDirectoryPath(runtime.meta.directory);
    const folderPath = itemPath(destination.notebook, destination.pathParts);
    await assertDirectoryExists(folderPath, "The notebook for the recording was not found.");
    const shared = isSharedNotebookPath(runtime.meta.directory);

    await completeAudio(runtime);
    const audio = await compress(audioFile(runtime.directory), await findAudioDecoder(getTranscriptionPreferences()));
    const audioName = (await findAvailableFilePath(folderPath, `${runtime.meta.name}${audio.extension}`)).name;
    const upload = new File([await readFile(audio.file)], audioName);
    const node = shared
      ? await (await import("@/lib/collab/shared-writes")).writeSharedUpload(destination.notebook, upload, runtime.meta.directory)
      : await writeUploadedFile(destination.notebook, upload, runtime.meta.directory);

    const words = allWords(runtime);
    // The live transcript as the reader corrected it, or the words in passages for reading.
    const segments = runtime.edits ? applySegmentEdits(liveSegments(runtime), runtime.edits).filter((segment) => segment.text.trim()) : groupSegments(words);
    if (segments.length) {
      let audioStats = { size: upload.size, modifiedAt: new Date().toISOString() };
      try {
        const info = await stat(filePathFromParts(destination.notebook, [...destination.pathParts, audioName]));
        audioStats = { size: info.size, modifiedAt: info.mtime.toISOString() };
      } catch {
        // A shared recording may only be a blob so far.
      }
      const transcript: Transcript = {
        version: TRANSCRIPT_VERSION,
        createdAt: new Date().toISOString(),
        audio: { ...audioStats, duration: Math.round(seconds(savedSamples(runtime.chunks)) * 100) / 100 },
        engine: { kind: "local", model: SPEECH_MODELS.asr.name },
        language: "",
        diarization: null,
        speakers: [],
        segments,
        stats: { words: runtime.edits ? countWords(segments) : words.length, chunks: runtime.chunks.length, elapsedMs: 0 },
      };
      await writeTranscript(node.path, transcript);
    }

    let recapPath: string | null = null;
    if (runtime.recap.bullets.length) {
      const noteName = (await findAvailableFilePath(folderPath, `${runtime.meta.name} recap.md`)).name;
      const notePath = `${runtime.meta.directory}/${noteName}`;
      const href = (at?: number) => createMarkdownFileLinkDestination({
        sourcePath: notePath,
        targetPath: node.path,
        metadata: at ? { v: 1, fileType: "audio", viewState: { audio: { currentTime: at } } } : undefined,
      });
      const content = recapMarkdown(`${runtime.meta.name}: recap`, audioName, href, runtime.recap.bullets);
      if (shared) await (await import("@/lib/collab/shared-writes")).createSharedMarkdownFile(destination.notebook, noteName, content, runtime.meta.directory);
      else await createMarkdownFile(destination.notebook, noteName, content, runtime.meta.directory);
      recapPath = notePath;
    }

    runtimes().delete(id);
    runtime.meta.state = "finished";
    await persist(runtime);
    await rm(runtime.directory, { recursive: true, force: true });
    return { path: node.path, recapPath };
  } catch (error) {
    runtime.meta.state = "recording";
    await persist(runtime);
    throw error;
  }
}
