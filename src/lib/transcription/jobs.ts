import { stat } from "node:fs/promises";
import { filePathFromParts, splitFilePath } from "@/lib/storage/paths";
import { assertSupportedFileName } from "@/lib/storage/file-types";
import { StorageError } from "@/lib/storage/errors";
import { writeTranscript } from "@/lib/storage/transcripts";
import { detectAsrModel, detectDiarizationModels, SPEECH_MODELS } from "@/lib/transcription/models";
import { transcribeWithOpenRouter } from "@/lib/transcription/openrouter-stt";
import {
  assignSpeakers,
  diarizationSummary,
  groupSegments,
  joinTurns,
  orderSpeakers,
  planPieces,
  speechRegions,
  wordsFromTokens,
  type SpeakerTurn,
  type Span,
  type TimedWord,
} from "@/lib/transcription/plan";
import { findAudioDecoder, getTranscriptionPreferences } from "@/lib/transcription/settings";
import { TRANSCRIPT_VERSION, type Transcript, type TranscriptionJob } from "@/lib/transcription/types";
import { getTranscriptionWorker } from "@/lib/transcription/worker-client";

// Parakeet is accurate on pieces up to about half a minute and its memory grows
// with length; services take a few minutes per request (a 4-minute 16 kHz WAV
// is under 8 MB), and fewer, longer requests give Whisper more context.
export const LOCAL_PIECE = { maxSeconds: 28, packGap: 1.5 };
export const REMOTE_PIECE = { maxSeconds: 240, packGap: 8 };
const REMOTE_CONCURRENCY = 3;
// Share of the progress bar each stage takes.
const WEIGHTS = { decode: 0.06, diarize: 0.24, transcribe: 0.66, save: 0.04 };
// Finished and failed jobs stay visible for a while, so a viewer opened later still sees the outcome.
const KEEP_FINISHED_MS = 10 * 60_000;

export type TranscriptionOptions = { engine?: "local" | "openrouter"; speakers?: number; language?: string };

type JobRecord = TranscriptionJob & { options: TranscriptionOptions; controller: AbortController; finishedAt?: number };

class TranscriptionJobs {
  private readonly jobs = new Map<string, JobRecord>();
  private queue: Promise<void> = Promise.resolve();

  get(path: string): TranscriptionJob | null {
    const job = this.jobs.get(path);
    if (!job) return null;
    if (job.finishedAt && Date.now() - job.finishedAt > KEEP_FINISHED_MS) {
      this.jobs.delete(path);
      return null;
    }
    return publicJob(job);
  }

  /** Queue a recording; one is transcribed at a time, since each uses the whole CPU budget. */
  start(path: string, options: TranscriptionOptions = {}) {
    const { name } = splitFilePath(path);
    if (assertSupportedFileName(name) !== "audio") throw new StorageError("Only recordings can be transcribed.");
    const existing = this.jobs.get(path);
    if (existing && !existing.finishedAt) return publicJob(existing);

    const engine = options.engine ?? getTranscriptionPreferences().engine;
    const job: JobRecord = {
      path,
      state: "queued",
      engine,
      progress: 0,
      done: 0,
      total: 0,
      startedAt: new Date().toISOString(),
      options: { ...options, engine },
      controller: new AbortController(),
    };
    this.jobs.set(path, job);
    this.queue = this.queue.then(() => this.run(job));
    return publicJob(job);
  }

  cancel(path: string) {
    const job = this.jobs.get(path);
    if (!job || job.finishedAt) return;
    job.controller.abort(new Error("Cancelled."));
    if (job.state === "queued") this.finish(job, "cancelled");
  }

  private finish(job: JobRecord, state: "done" | "error" | "cancelled", error?: string) {
    job.state = state;
    job.finishedAt = Date.now();
    if (state === "done") job.progress = 1;
    if (error) job.error = error;
  }

  private async run(job: JobRecord) {
    if (job.finishedAt) return;
    try {
      await transcribe(job);
      this.finish(job, "done");
    } catch (error) {
      if (job.controller.signal.aborted) this.finish(job, "cancelled");
      else this.finish(job, "error", error instanceof Error ? error.message : "Transcription failed.");
    }
  }
}

function publicJob(job: JobRecord): TranscriptionJob {
  const { path, state, engine, progress, done, total, duration, startedAt, error } = job;
  return { path, state, engine, progress: Math.round(progress * 1000) / 1000, done, total, duration, startedAt, error };
}

async function transcribe(job: JobRecord) {
  const started = Date.now();
  const signal = job.controller.signal;
  const preferences = getTranscriptionPreferences();
  const engine = job.options.engine ?? preferences.engine;
  const language = job.options.language ?? preferences.language;
  const requestedSpeakers = job.options.speakers ?? preferences.speakers;
  const { notebook, pathParts } = splitFilePath(job.path);
  const audioPath = filePathFromParts(notebook, pathParts);
  const audioStats = await stat(audioPath);

  const asrModel = engine === "local" ? await detectAsrModel() : null;
  if (engine === "local" && !asrModel) {
    throw new Error(preferences.modelDirectory
      ? "The speech models are not in their folder yet. Download them first."
      : "Choose a folder for the speech models in Preferences → Speech, or transcribe with OpenRouter.");
  }
  const diarizationModels = preferences.diarization ? await detectDiarizationModels() : null;

  const worker = getTranscriptionWorker();
  worker.configure(await findAudioDecoder(preferences));

  job.state = "decoding";
  const opened = await worker.open(audioPath, { signal });
  job.duration = opened.duration;
  job.progress = WEIGHTS.decode;

  try {
    let turns: SpeakerTurn[] = [];
    if (diarizationModels) {
      signal.throwIfAborted();
      job.state = "diarizing";
      const result = await worker.diarize(opened.handle, diarizationModels, requestedSpeakers, {
        signal,
        onProgress: (value) => {
          job.progress = WEIGHTS.decode + WEIGHTS.diarize * value;
        },
      });
      turns = joinTurns(result.turns);
    }
    job.progress = WEIGHTS.decode + WEIGHTS.diarize;

    const pieces = planPieces(speechRegions(turns, opened.duration), opened.envelope, engine === "local" ? LOCAL_PIECE : REMOTE_PIECE);
    job.state = "transcribing";
    job.total = pieces.length;
    const advance = () => {
      job.done += 1;
      job.progress = WEIGHTS.decode + WEIGHTS.diarize + WEIGHTS.transcribe * (job.done / Math.max(1, job.total));
    };

    let detectedLanguage = language;
    const words: TimedWord[] = [];
    if (engine === "local") {
      for (const piece of pieces) {
        signal.throwIfAborted();
        const result = await worker.recognize(opened.handle, piece.start, piece.end, asrModel!, { signal });
        words.push(...wordsFromTokens(result.tokens, result.timestamps, piece.start, piece.end, result.durations));
        advance();
      }
    } else {
      // A few requests at once; results go back in order whatever order they finish in.
      const results: TimedWord[][] = new Array(pieces.length);
      let next = 0;
      const lane = async () => {
        while (next < pieces.length) {
          const index = next++;
          const piece: Span = pieces[index];
          signal.throwIfAborted();
          const wav = await worker.wav(opened.handle, piece.start, piece.end, { signal });
          const result = await transcribeWithOpenRouter(wav, {
            model: preferences.openRouterModel,
            language,
            offset: piece.start,
            pieceSeconds: piece.end - piece.start,
            signal,
          });
          results[index] = result.words;
          if (!detectedLanguage && result.language) detectedLanguage = result.language;
          advance();
        }
      };
      await Promise.all(Array.from({ length: Math.min(REMOTE_CONCURRENCY, pieces.length) }, lane));
      for (const result of results) words.push(...result);
    }

    signal.throwIfAborted();
    job.state = "saving";
    const ordered = orderSpeakers(groupSegments(assignSpeakers(words, turns)), turns);
    const transcript: Transcript = {
      version: TRANSCRIPT_VERSION,
      createdAt: new Date().toISOString(),
      audio: { size: audioStats.size, modifiedAt: audioStats.mtime.toISOString(), duration: Math.round(opened.duration * 100) / 100 },
      engine: { kind: engine, model: engine === "local" ? SPEECH_MODELS.asr.name : preferences.openRouterModel },
      language: detectedLanguage,
      diarization: diarizationModels ? diarizationSummary(ordered.turns, ordered.speakers.length, requestedSpeakers, {
        segmentation: SPEECH_MODELS.segmentation.name,
        embedding: SPEECH_MODELS.embedding.name,
      }) : null,
      speakers: ordered.speakers,
      segments: ordered.segments,
      stats: { words: words.length, chunks: pieces.length, elapsedMs: Date.now() - started },
    };
    await writeTranscript(job.path, transcript);
    job.progress = 1;
  } finally {
    await worker.close(opened.handle);
  }
}

const JOBS_KEY = Symbol.for("libera.transcriptionJobs");

export function getTranscriptionJobs() {
  const store = globalThis as { [JOBS_KEY]?: TranscriptionJobs };
  store[JOBS_KEY] ??= new TranscriptionJobs();
  return store[JOBS_KEY];
}
