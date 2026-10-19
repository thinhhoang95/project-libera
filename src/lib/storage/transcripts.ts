import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { StorageError } from "@/lib/storage/errors";
import { assertSupportedFileName, getFileType } from "@/lib/storage/file-types";
import { moveFileIfExists } from "@/lib/storage/fs-utils";
import { audioSidecarPaths, filePathFromParts, splitFilePath, transcriptPath } from "@/lib/storage/paths";
import { TRANSCRIPT_VERSION, type Transcript, type TranscriptSegment, type TranscriptSpeaker } from "@/lib/transcription/types";

// Where a voice memo's transcript lives. The recording is the document, and
// Global Search indexes it through its transcript, once; the transcript is
// never a note of its own.
//
// - In an ordinary notebook or linked folder it is a sidecar beside the
//   notebook's others (like a PDF's annotations): `.libera/transcripts/…`.
// - In a shared notebook `.libera` stays on this computer, so the transcript
//   is a companion file next to the recording, `<name>.transcript`, which the
//   collab host shares as a blob: every member sees the same transcript and
//   speaker names. Libera lists only the file types it opens, so the companion
//   never shows in the tree or in search. A member who cannot change files, or
//   a host that is not running, keeps the transcript in the local sidecar; it
//   is read from there until a later change can be shared.

/** The companion transcript of a recording in a shared notebook. */
export const TRANSCRIPT_COMPANION_SUFFIX = ".transcript";

/** "Shared/memo.m4a" → "Shared/memo.m4a.transcript". */
export function transcriptCompanionPath(relativePath: string) {
  return `${relativePath}${TRANSCRIPT_COMPANION_SUFFIX}`;
}

/** The recording a companion transcript belongs to, or null when the path is not one. */
export function recordingForCompanion(relativePath: string) {
  if (!relativePath.endsWith(TRANSCRIPT_COMPANION_SUFFIX)) return null;
  const recording = relativePath.slice(0, -TRANSCRIPT_COMPANION_SUFFIX.length);
  return getFileType(recording) === "audio" ? recording : null;
}

function locate(relativePath: string) {
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  if (assertSupportedFileName(name) !== "audio") throw new StorageError("Transcripts belong to audio files.");
  const shared = isSharedNotebookPath(relativePath);
  return {
    audio: filePathFromParts(notebook, pathParts),
    sidecar: transcriptPath(notebook, pathParts),
    companion: shared ? filePathFromParts(notebook, [...pathParts.slice(0, -1), `${name}${TRANSCRIPT_COMPANION_SUFFIX}`]) : null,
  };
}

const finite = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** A transcript read from disk, or null when it is missing or not one Libera wrote. */
export function parseTranscript(value: unknown): Transcript | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<Transcript>;
  if (input.version !== TRANSCRIPT_VERSION || !Array.isArray(input.segments) || !Array.isArray(input.speakers)) return null;
  const speakers: TranscriptSpeaker[] = input.speakers.map((speaker, index) => ({
    name: typeof speaker?.name === "string" && speaker.name.trim() ? speaker.name.trim().slice(0, 80) : `Speaker ${index + 1}`,
    talkSeconds: finite(speaker?.talkSeconds),
    share: finite(speaker?.share),
    segments: finite(speaker?.segments),
  }));
  const segments: TranscriptSegment[] = input.segments
    .filter((segment) => segment && typeof segment.text === "string")
    .map((segment) => ({
      start: finite(segment.start),
      end: finite(segment.end),
      speaker: Number.isInteger(segment.speaker) && segment.speaker! >= 0 && segment.speaker! < speakers.length ? segment.speaker : null,
      text: segment.text,
    }));
  return {
    version: TRANSCRIPT_VERSION,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date(0).toISOString(),
    audio: {
      size: finite(input.audio?.size),
      modifiedAt: typeof input.audio?.modifiedAt === "string" ? input.audio.modifiedAt : "",
      duration: finite(input.audio?.duration),
    },
    engine: {
      kind: input.engine?.kind === "openrouter" ? "openrouter" : "local",
      model: typeof input.engine?.model === "string" ? input.engine.model : "",
    },
    language: typeof input.language === "string" ? input.language : "",
    diarization: input.diarization && typeof input.diarization === "object" ? input.diarization : null,
    speakers,
    segments,
    stats: {
      words: finite(input.stats?.words),
      chunks: finite(input.stats?.chunks),
      elapsedMs: finite(input.stats?.elapsedMs),
    },
  };
}

async function readTranscriptFile(file: string) {
  try {
    return parseTranscript(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** The transcript, and whether the audio changed since it was made. */
export async function readTranscript(relativePath: string): Promise<{ transcript: Transcript | null; stale: boolean; shared: boolean }> {
  const { audio, sidecar, companion } = locate(relativePath);
  const fromCompanion = companion ? await readTranscriptFile(companion) : null;
  const transcript = fromCompanion ?? await readTranscriptFile(sidecar);
  if (!transcript) return { transcript: null, stale: false, shared: false };
  // By size: a copy has a new modification time but the same recording, while
  // a trimmed or re-recorded file all but always changes size.
  const stats = await stat(audio).catch(() => null);
  const stale = Boolean(stats && stats.size !== transcript.audio.size);
  return { transcript, stale, shared: Boolean(fromCompanion) };
}

async function writeLocal(file: string, transcript: Transcript) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(transcript));
  await rename(temporary, file);
}

/**
 * Write atomically, so a crash never leaves half a transcript, and let Global
 * Search index it. In a shared notebook it goes to the members through the
 * collab host; when that is refused, it is kept on this computer.
 */
export async function writeTranscript(relativePath: string, transcript: Transcript): Promise<{ shared: boolean }> {
  const { sidecar, companion } = locate(relativePath);
  let shared = false;
  if (companion) {
    try {
      const { writeSharedBlob } = await import("@/lib/collab/shared-writes");
      await writeSharedBlob(transcriptCompanionPath(relativePath), new TextEncoder().encode(JSON.stringify(transcript)));
      shared = true;
      // The shared copy supersedes one kept here before.
      await rm(sidecar, { force: true });
    } catch (error) {
      console.warn(`The transcript of ${relativePath} is kept on this computer: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (!shared) await writeLocal(sidecar, transcript);
  notifySearchChanges([relativePath]);
  return { shared };
}

/** Rename speakers by index; an empty name goes back to "Speaker N". */
export async function renameTranscriptSpeakers(relativePath: string, names: Record<string, string>) {
  const { transcript } = await readTranscript(relativePath);
  if (!transcript) throw new StorageError("This recording has no transcript yet.", 404);
  transcript.speakers = transcript.speakers.map((speaker, index) => {
    const requested = names[String(index)];
    if (typeof requested !== "string") return speaker;
    return { ...speaker, name: requested.trim().slice(0, 80) || `Speaker ${index + 1}` };
  });
  await writeTranscript(relativePath, transcript);
  return transcript;
}

export async function deleteTranscript(relativePath: string) {
  const { sidecar, companion } = locate(relativePath);
  if (companion && await stat(companion).then(() => true, () => false)) {
    const { deleteSharedEntry } = await import("@/lib/collab/shared-writes");
    await deleteSharedEntry(transcriptCompanionPath(relativePath));
  }
  await rm(sidecar, { force: true });
  notifySearchChanges([relativePath]);
}

/** The identity of a recording's transcript; "" when it has none. */
export async function transcriptSignature(relativePath: string) {
  try {
    const { sidecar, companion } = locate(relativePath);
    for (const file of companion ? [companion, sidecar] : [sidecar]) {
      const stats = await stat(file, { bigint: true }).catch(() => null);
      if (stats) return `transcript:${stats.size}:${stats.mtimeNs}:${stats.ino}`;
    }
  } catch {
    // Not a recording.
  }
  return "";
}

/**
 * Copies a recording's transcript to a copy of the recording, wherever each
 * keeps it: a sidecar, or a companion in a shared notebook.
 */
export async function copyTranscript(fromPath: string, toPath: string) {
  const { transcript } = await readTranscript(fromPath);
  if (!transcript) return;
  const destination = locate(toPath);
  if (destination.companion) {
    const { writeSharedBlob } = await import("@/lib/collab/shared-writes");
    await writeSharedBlob(transcriptCompanionPath(toPath), new TextEncoder().encode(JSON.stringify(transcript)), { createOnly: true }).catch(async () => {
      await writeLocal(destination.sidecar, transcript);
    });
  } else {
    await writeLocal(destination.sidecar, transcript);
  }
}

/**
 * Keeps the sidecars on this computer in step with a shared notebook's files
 * when they move or go away, whoever did it: the collab host moves the
 * recordings (and their companion transcripts) itself.
 */
export async function followSharedAudioChanges(moves: Array<{ from: string; to: string }>, removed: string[]) {
  let changed = 0;
  for (const { from, to } of moves) {
    try {
      if (getFileType(from) !== "audio") continue;
      const fromParts = splitFilePath(from);
      const toParts = splitFilePath(to);
      const next = getFileType(to) === "audio" ? audioSidecarPaths(toParts.notebook, toParts.pathParts) : null;
      for (const [index, sidecar] of audioSidecarPaths(fromParts.notebook, fromParts.pathParts).entries()) {
        if (next) await moveFileIfExists(sidecar, next[index]);
        else await rm(sidecar, { force: true });
      }
      changed += 1;
    } catch {
      // A path that is not a library file: nothing of ours to move.
    }
  }
  for (const gone of removed) {
    try {
      if (getFileType(gone) !== "audio") continue;
      const parts = splitFilePath(gone);
      for (const sidecar of audioSidecarPaths(parts.notebook, parts.pathParts)) await rm(sidecar, { force: true });
      changed += 1;
    } catch {
      // As above.
    }
  }
  return changed;
}
