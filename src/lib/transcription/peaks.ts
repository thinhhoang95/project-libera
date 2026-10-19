import { readFile } from "node:fs/promises";
import { StorageError } from "@/lib/storage/errors";
import { assertSupportedFileName } from "@/lib/storage/file-types";
import { audioPeaksPath, filePathFromParts, splitFilePath } from "@/lib/storage/paths";
import { findAudioDecoder } from "@/lib/transcription/settings";
import type { AudioPeaksPayload } from "@/lib/transcription/types";
import { getTranscriptionWorker } from "@/lib/transcription/worker-client";
import { readFileContentHash, readFileSignature } from "@/lib/storage/file-signature";
import { writeJsonForSource } from "@/lib/storage/fs-utils";

/** Enough detail for a wide window; the viewer draws fewer bars by taking the loudest of each group. */
const PEAK_BUCKETS = 2400;
const inflight = new Map<string, Promise<AudioPeaksPayload>>();

/**
 * A recording's waveform overview, decoded once and cached beside its other
 * sidecars until the audio changes.
 */
export async function readAudioPeaks(relativePath: string): Promise<AudioPeaksPayload> {
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  if (assertSupportedFileName(name) !== "audio") throw new StorageError("Waveforms are drawn for recordings only.");
  const audioPath = filePathFromParts(notebook, pathParts);
  const cachePath = audioPeaksPath(notebook, pathParts);
  const signature = await readFileSignature(audioPath);
  const contentHash = await readFileContentHash(audioPath);
  const key = `${signature}\0${contentHash}`;

  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as AudioPeaksPayload & { key?: string };
    if (cached.key === key && Number.isFinite(cached.duration) && cached.duration >= 0 && Array.isArray(cached.peaks) && cached.peaks.every(Number.isFinite)) return { duration: cached.duration, peaks: cached.peaks };
  } catch {
    // Not drawn yet.
  }

  const requestKey = `${cachePath}\0${key}`;
  const running = inflight.get(requestKey);
  if (running) return running;
  const task = (async () => {
    const worker = getTranscriptionWorker();
    worker.configure(await findAudioDecoder());
    const peaks = await worker.peaks(audioPath, PEAK_BUCKETS);
    await writeJsonForSource(cachePath, { key, ...peaks }, audioPath, signature, contentHash);
    return peaks;
  })().finally(() => inflight.delete(requestKey));
  inflight.set(requestKey, task);
  return task;
}
