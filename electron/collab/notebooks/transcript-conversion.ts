// Transcripts change place when a notebook enters sharing. In an ordinary
// notebook a recording's transcript is a hidden sidecar
// (`.libera/transcripts/by-path/<folders>/<name>.json`, src/lib/storage/transcripts.ts),
// which the share walk never reads because `.libera` stays on this computer. In a
// shared notebook it is a companion file beside the recording
// (`<name>.transcript`) that the host shares as a blob. This converts the first
// into the second, so an existing transcript is shared instead of stranded.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { AUDIO_EXTENSIONS, LIBERA_SYSTEM_DIR, TRANSCRIPTS_DIR } from "../../../src/lib/storage/constants";
import { DestinationTakenError, isShareablePath, isNotFound, writeFileExclusive, type WriteGuard } from "./fs-ops";

/** Marks a local transcript as a correction not yet shared (src/lib/storage/transcripts.ts). */
const PENDING_KEY = "_liberaPendingShare";
const COMPANION_SUFFIX = ".transcript";

/** A local sidecar whose transcript the companion beside the recording holds, as converted. */
export interface ConvertedSidecar {
  file: string;
  /** SHA-256 of the sidecar's bytes when it was converted: it is removed only if it is still exactly that. */
  sha256: string;
  /** The companion's path (relative to the notebook) and the SHA-256 of the bytes that hold this version. */
  companion: string;
  companionSha256: string;
}

export interface TranscriptConversion {
  /** Companions that exist beside their recordings now (written here, or already there). */
  companions: string[];
  /**
   * Local sidecars whose version the companion holds. Each is removable only after the share is installed AND
   * the uploaded companion is confirmed to be those bytes (`removableSidecars`).
   */
  sidecars: ConvertedSidecar[];
  /** Recordings whose existing companion differs from the local sidecar: both stay, and the share reports them. */
  conflicts: string[];
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The transcript a companion or sidecar holds, as comparable text (the pending mark and formatting aside). */
function canonical(raw: Buffer): string | null {
  const bytes = companionBytes(raw);
  if (!bytes) return null;
  try { return JSON.stringify(JSON.parse(Buffer.from(bytes).toString("utf8"))); } catch { return null; }
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
    const transcript = { ...value };
    delete transcript[PENDING_KEY];
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
  const result: TranscriptConversion = { companions: [], sidecars: [], conflicts: [] };
  for (const { file, parts } of found) {
    const recording = parts.join("/");
    if (!AUDIO_EXTENSIONS.has(path.extname(recording).toLowerCase())) continue;
    const companion = `${recording}${COMPANION_SUFFIX}`;
    if (!isShareablePath(companion)) continue;
    const audio = path.join(root, ...parts);
    if (!(await fs.lstat(audio).catch(() => null))?.isFile()) continue;
    const rawSidecar = await fs.readFile(file);
    const bytes = companionBytes(rawSidecar);
    if (!bytes) continue;
    const target = path.join(root, ...companion.split("/"));
    if ((await fs.lstat(target).catch(() => null)) === null) {
      try { await writeFileExclusive(target, bytes, guard); }
      catch (error) { if (!(error instanceof DestinationTakenError)) throw error; }
    }
    result.companions.push(companion);
    // Whatever companion is there now (written here, or left by a takedown or an interrupted share) must hold the sidecar's version.
    const existing = await fs.readFile(target).catch(() => null);
    const mine = canonical(rawSidecar);
    if (existing && mine !== null && canonical(existing) === mine) {
      result.sidecars.push({ file, sha256: sha256(rawSidecar), companion, companionSha256: sha256(existing) });
    } else {
      // A different transcript is already the companion: it is shared as it is, and the sidecar stays here untouched.
      result.conflicts.push(recording);
    }
  }
  return result;
}

/**
 * The sidecars that may be removed now: the share has installed its marker, the plan's entry for the companion
 * is the very bytes that matched the sidecar and has been uploaded, and the sidecar was not edited since.
 * Anything else stays (and is reported by the caller as a kept local version).
 */
export async function removableSidecars(
  converted: TranscriptConversion,
  uploaded: ReadonlyMap<string, { blobHash?: string; uploaded?: boolean }>,
): Promise<{ remove: string[]; kept: string[] }> {
  const remove: string[] = [];
  const kept: string[] = [];
  for (const sidecar of converted.sidecars) {
    const entry = uploaded.get(sidecar.companion);
    const current = await fs.readFile(sidecar.file).catch(() => null);
    if (entry?.uploaded && entry.blobHash === sidecar.companionSha256 && current && sha256(current) === sidecar.sha256) remove.push(sidecar.file);
    else kept.push(sidecar.companion.slice(0, -COMPANION_SUFFIX.length));
  }
  return { remove, kept };
}
