import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LOCAL_PIECE, REMOTE_PIECE } from "@/lib/transcription/jobs";
import { detectAsrModel } from "@/lib/transcription/models";
import { transcribeWithOpenRouter } from "@/lib/transcription/openrouter-stt";
import { groupSegments, planPieces, wordsFromTokens, type TimedWord } from "@/lib/transcription/plan";
import { findAudioDecoder, getTranscriptionPreferences } from "@/lib/transcription/settings";
import { resolveDictationSettings } from "../../../electron/transcription-preferences.cjs";
import { getTranscriptionWorker } from "@/lib/transcription/worker-client";

/** About ten minutes of 16 kHz, 16-bit mono WAV. */
export const MAX_DICTATION_BYTES = 20 * 1024 * 1024;

/**
 * A prompt spoken into the microphone, as text. The window records 16 kHz
 * mono WAV, so no decoder is needed; it is recognized like a voice memo with
 * the engine chosen in Preferences → Speech → Dictation (by default, the voice
 * memo engine), without telling speakers apart, and nothing is kept.
 */
export async function transcribeDictation(wav: Uint8Array, { signal }: { signal?: AbortSignal } = {}) {
  if (wav.byteLength < 44 || new TextDecoder().decode(wav.subarray(0, 4)) !== "RIFF") throw new Error("The recording is not a WAV file.");
  const preferences = getTranscriptionPreferences();
  const { engine, openRouterModel, language } = resolveDictationSettings(preferences);
  const asrModel = engine === "local" ? await detectAsrModel() : null;
  if (engine === "local" && !asrModel) {
    throw new Error("The speech models are not downloaded yet. Download them from a voice memo's transcript panel, or dictate with OpenRouter.");
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-dictation-"));
  const file = path.join(directory, "dictation.wav");
  const worker = getTranscriptionWorker();
  let handle: string | null = null;
  try {
    await writeFile(file, wav);
    worker.configure(await findAudioDecoder(preferences));
    const opened = await worker.open(file, { signal });
    handle = opened.handle;
    const pieces = planPieces([{ start: 0, end: opened.duration }], opened.envelope, engine === "local" ? LOCAL_PIECE : REMOTE_PIECE);
    const words: TimedWord[] = [];
    for (const piece of pieces) {
      signal?.throwIfAborted();
      if (engine === "local") {
        const result = await worker.recognize(opened.handle, piece.start, piece.end, asrModel!, { signal });
        words.push(...wordsFromTokens(result.tokens, result.timestamps, piece.start, piece.end, result.durations));
      } else {
        const bytes = await worker.wav(opened.handle, piece.start, piece.end, { signal });
        const result = await transcribeWithOpenRouter(bytes, { model: openRouterModel, language, offset: piece.start, pieceSeconds: piece.end - piece.start, signal });
        words.push(...result.words);
      }
    }
    const text = groupSegments(words, { pauseSeconds: Number.POSITIVE_INFINITY }).map((segment) => segment.text).join(" ").trim();
    return { text, engine, duration: opened.duration };
  } finally {
    if (handle) await worker.close(handle);
    await rm(directory, { recursive: true, force: true });
  }
}
