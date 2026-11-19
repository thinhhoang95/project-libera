// Transcripts change place when a notebook enters sharing. In an ordinary
// notebook a recording's transcript is a hidden sidecar
// (`.libera/transcripts/by-path/<folders>/<name>.json`, src/lib/storage/transcripts.ts),
// which the share walk never reads because `.libera` stays on this computer. In a
// shared notebook it is a companion file beside the recording
// (`<name>.transcript`) that the host shares as a blob. This converts the first
// into the second, so an existing transcript is shared instead of stranded.

import { promises as fs } from "node:fs";
import path from "node:path";

import { AUDIO_EXTENSIONS, LIBERA_SYSTEM_DIR, TRANSCRIPTS_DIR } from "../../../src/lib/storage/constants";
import { DestinationTakenError, isShareablePath, isNotFound, writeFileExclusive, type WriteGuard } from "./fs-ops";

/** Marks a local transcript as a correction not yet shared (src/lib/storage/transcripts.ts). */
const PENDING_KEY = "_liberaPendingShare";
const COMPANION_SUFFIX = ".transcript";

export interface TranscriptConversion {
  /** Companions that exist beside their recordings now (written here, or already there). */
  companions: string[];
  /** Local sidecar files whose transcript is now a companion; removable once the share is installed. */
  sidecars: string[];
}

/** The sidecar directory of the transcripts of a notebook kept at `root`. */
export function localTranscriptDirectory(root: string): string {
  return path.join(root, LIBERA_SYSTEM_DIR, TRANSCRIPTS_DIR, "by-path");
}

async function sidecarFiles(directory: string, prefix: string[], found: Array<{ file: string; parts: string[] }>): Promise<void> {
  let names: string[];
  try { names = await fs.readdir(directory); }
  catch (error) { if (isNotFound(error)) return; throw error; }
  for (const name of names) {
    const file = path.join(directory, name);
    const stats = await fs.lstat(file).catch(() => null);
    if (!stats || stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) await sidecarFiles(file, [...prefix, name], found);
    else if (stats.isFile() && name.endsWith(".json")) found.push({ file, parts: [...prefix, name.slice(0, -".json".length)] });
  }
}

/** The JSON of a companion made from a sidecar, or null when the sidecar is not a transcript. */
function companionBytes(raw: Buffer): Uint8Array | null {
  try {
    const value = JSON.parse(raw.toString("utf8")) as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || typeof value.version !== "number" || !Array.isArray(value.segments) || !Array.isArray(value.speakers)) return null;
    // A correction waiting to be shared is the transcript being shared now.
    const { [PENDING_KEY]: _pending, ...transcript } = value;
    return Buffer.from(JSON.stringify(transcript), "utf8");
  } catch {
    return null;
  }
}

/**
 * Writes `<recording>.transcript` beside every recording that has a local
 * transcript sidecar and no companion yet (an existing companion is never
 * replaced). The caller walks the folder afterwards, so the companions are
 * shared like any other file.
 */
export async function convertLocalTranscripts(root: string, guard: WriteGuard): Promise<TranscriptConversion> {
  const found: Array<{ file: string; parts: string[] }> = [];
  await sidecarFiles(localTranscriptDirectory(root), [], found);
  const result: TranscriptConversion = { companions: [], sidecars: [] };
  for (const { file, parts } of found) {
    const recording = parts.join("/");
    if (!AUDIO_EXTENSIONS.has(path.extname(recording).toLowerCase())) continue;
    const companion = `${recording}${COMPANION_SUFFIX}`;
    if (!isShareablePath(companion)) continue;
    const audio = path.join(root, ...parts);
    if (!(await fs.lstat(audio).catch(() => null))?.isFile()) continue;
    const bytes = companionBytes(await fs.readFile(file));
    if (!bytes) continue;
    const target = path.join(root, ...companion.split("/"));
    if ((await fs.lstat(target).catch(() => null)) === null) {
      try { await writeFileExclusive(target, bytes, guard); }
      catch (error) { if (!(error instanceof DestinationTakenError)) throw error; }
    }
    result.companions.push(companion);
    result.sidecars.push(file);
  }
  return result;
}
