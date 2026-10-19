import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { StorageError } from "@/lib/storage/errors";
import { assertSupportedFileName } from "@/lib/storage/file-types";
import { audioPeaksPath, filePathFromParts, splitFilePath } from "@/lib/storage/paths";
import { findAudioDecoder } from "@/lib/transcription/settings";
import type { AudioPeaksPayload } from "@/lib/transcription/types";
import { getTranscriptionWorker } from "@/lib/transcription/worker-client";

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
  const stats = await stat(audioPath);
  const key = `${stats.size}:${stats.mtimeMs}`;

  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as AudioPeaksPayload & { key?: string };
    if (cached.key === key && Array.isArray(cached.peaks)) return { duration: cached.duration, peaks: cached.peaks };
  } catch {
    // Not drawn yet.
  }

  const running = inflight.get(audioPath);
  if (running) return running;
  const task = (async () => {
    const worker = getTranscriptionWorker();
    worker.configure(await findAudioDecoder());
    const peaks = await worker.peaks(audioPath, PEAK_BUCKETS);
    await mkdir(path.dirname(cachePath), { recursive: true });
    const temporary = `${cachePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ key, ...peaks }));
    await rename(temporary, cachePath);
    return peaks;
  })().finally(() => inflight.delete(audioPath));
  inflight.set(audioPath, task);
  return task;
}
