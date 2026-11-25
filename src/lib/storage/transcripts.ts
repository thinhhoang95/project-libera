import { copyLifecycleSidecar, preserveLifecycleSidecar } from "@/lib/storage/sidecar-lifecycle";
import { createHash } from "node:crypto";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { StorageError } from "@/lib/storage/errors";
import { assertSupportedFileName, getFileType } from "@/lib/storage/file-types";
import { withPathLocks, writeJsonForSource } from "@/lib/storage/fs-utils";
import { assertFileSignature, readCachedFileContentHash, readFileContentHash, readFileSignature } from "@/lib/storage/file-signature";
import { audioSidecarDirectories, audioSidecarPaths, filePathFromParts, notebookPath, splitFilePath, transcriptPath } from "@/lib/storage/paths";
import { cleanSegments, countWords } from "@/lib/transcription/edits";
import { TRANSCRIPT_VERSION, type Transcript, type TranscriptSegment, type TranscriptSpeaker } from "@/lib/transcription/types";
import { assertNotMigrating } from "@/lib/storage/migration-fence";

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

/** Where the companion transcript of the recording at `pathParts` of `notebook` is on disk (whether or not the notebook is shared). */
export function transcriptCompanionFilePath(notebook: string, pathParts: string[]) {
  return filePathFromParts(notebook, [...pathParts.slice(0, -1), `${pathParts.at(-1) ?? ""}${TRANSCRIPT_COMPANION_SUFFIX}`]);
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
  const companionFile = filePathFromParts(notebook, [...pathParts.slice(0, -1), `${name}${TRANSCRIPT_COMPANION_SUFFIX}`]);
  return {
    audio: filePathFromParts(notebook, pathParts),
    sidecar: transcriptPath(notebook, pathParts),
    companion: shared ? companionFile : null,
    // After a takedown the notebook is ordinary again but the shared companion
    // still sits beside the recording, holding the newest transcript.
    companionFile,
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
      ...(typeof input.audio?.contentHash === "string" && /^[a-f0-9]{64}$/.test(input.audio.contentHash) ? { contentHash: input.audio.contentHash } : {}),
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

/**
 * What a correction kept on this computer was based on: the shared transcript's
 * identity when it was made (it may be shared only while that is still current),
 * `create` when there was none, `offline` when the host's state was unknown.
 */
type SharedBase = { fileId: string; blobHash: string } | { create: true } | { offline: true };
type PendingBase = Exclude<SharedBase, { offline: true }>;

/** Marks a local sidecar in a shared notebook as a correction not yet shared: it is read in preference to the companion. */
const PENDING_KEY = "_liberaPendingShare";

async function readSidecarFile(file: string): Promise<{ transcript: Transcript; pending: PendingBase | null } | null> {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    const transcript = parseTranscript(value);
    if (!transcript) return null;
    const mark = value?.[PENDING_KEY];
    const pending = mark && typeof mark === "object" ? ("create" in mark ? { create: true as const } : typeof mark.fileId === "string" && typeof mark.blobHash === "string" ? { fileId: mark.fileId, blobHash: mark.blobHash } : { create: true as const }) : null;
    return { transcript, pending };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * Whether a correction kept on this computer was made for the recording that
 * is at its path now (its size and, when recorded, its content). A replacement
 * recording at a reused path is not the one the correction was made for: the
 * sidecar stays on disk, but is not read as this recording's pending state.
 */
async function pendingIsFor(transcript: Transcript, audio: string, size: number) {
  if (transcript.audio.size !== size) return false;
  if (!transcript.audio.contentHash) return true;
  return readCachedFileContentHash(audio).then((hash) => hash === transcript.audio.contentHash, () => false);
}

/** The transcript, and whether the audio changed since it was made. */
export async function readTranscript(relativePath: string): Promise<{ transcript: Transcript | null; stale: boolean; shared: boolean; pending?: boolean }> {
  const { audio, sidecar, companion, companionFile } = locate(relativePath);
  const stats = await stat(audio).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stats?.isFile()) return { transcript: null, stale: false, shared: false };
  // A correction that could not be shared stays visible until it is shared or discarded.
  const found = await readSidecarFile(sidecar);
  const pending = Boolean(companion && found?.pending && await pendingIsFor(found.transcript, audio, stats.size));
  // A pending correction made for another recording (this path was reused) is not this one's, in any role.
  const local = companion && found?.pending && !pending ? null : found;
  const fromCompanion = companion && !pending ? await readTranscriptFile(companion) : null;
  let transcript = pending ? local!.transcript : fromCompanion ?? local?.transcript ?? null;
  if (!transcript && !companion) {
    // Not shared (any more): a companion left by a takedown is the transcript. Adopt
    // it as the local sidecar so renames, copies and later edits carry it like any other.
    transcript = await readTranscriptFile(companionFile).catch(() => null);
    if (transcript) {
      const signature = await readFileSignature(audio).catch(() => null);
      if (signature) await writeLocal(sidecar, transcript, audio, signature, transcript.audio.contentHash).catch(() => undefined);
    }
  }
  if (!transcript) return { transcript: null, stale: false, shared: false };
  // Older transcripts only stored size. New transcripts use portable content
  // identity, detecting same-size replacements without penalizing copies/sync.
  const stale = stats.size !== transcript.audio.size || Boolean(transcript.audio.contentHash && await readCachedFileContentHash(audio) !== transcript.audio.contentHash);
  return { transcript, stale, shared: Boolean(fromCompanion), ...(pending ? { pending } : {}) };
}

async function writeLocal(file: string, transcript: Transcript, audio: string, signature: string, contentHash?: string, pending?: PendingBase) {
  await writeJsonForSource(file, pending ? { ...transcript, [PENDING_KEY]: pending } : transcript, audio, signature, contentHash);
}

/**
 * The version of a transcript's content ("" when there is none). A save that
 * carries the version it was made from is refused when the latest transcript
 * is another, so an edit or a finished transcription never replaces
 * corrections made in between.
 */
export function transcriptVersion(transcript: Transcript | null) {
  return transcript ? createHash("sha256").update(JSON.stringify(transcript)).digest("hex") : "";
}

export async function currentTranscriptVersion(relativePath: string) {
  return transcriptVersion((await readTranscript(relativePath)).transcript);
}

function transcriptChanged() {
  return new StorageError("The transcript changed since it was loaded, so this save was not applied. Reload it and try again.", 409);
}

/** A shared-transcript write lost to a newer shared version. */
class TranscriptShareConflict extends Error {}

/**
 * Write atomically, so a crash never leaves half a transcript, and let Global
 * Search index it. In a shared notebook it goes to the members through the
 * collab host; when that is refused, it is kept on this computer.
 */
export async function writeTranscript(relativePath: string, transcript: Transcript, options: { expectedSignature?: string; expectedContentHash?: string; expectedTranscriptVersion?: string; sharedBase?: SharedBase; throwOnConflict?: boolean } = {}): Promise<{ shared: boolean }> {
  // A file a notebook migration is moving is written after the migration.
  await assertNotMigrating(relativePath);
  const { audio, sidecar, companion } = locate(relativePath);
  // The recording as the manifest has it when the save starts: the shared write is bound to this file.
  const ownerFileId = companion && !(options.sharedBase && "offline" in options.sharedBase) ? await (await import("@/lib/collab/shared-owner")).sharedOwnerFileId(relativePath) : undefined;
  const signature = options.expectedSignature ?? await readFileSignature(audio);
  await assertFileSignature(audio, signature);
  if (options.expectedContentHash && await readFileContentHash(audio) !== options.expectedContentHash) {
    throw new StorageError("The recording changed during transcription. Transcribe it again.", 409);
  }
  if (options.expectedTranscriptVersion !== undefined && await currentTranscriptVersion(relativePath) !== options.expectedTranscriptVersion) throw transcriptChanged();
  // Preserve the original identity when editing a stale transcript's speaker names.
  if (!transcript.audio.contentHash && (await stat(audio)).size === transcript.audio.size) {
    transcript = { ...transcript, audio: { ...transcript.audio, contentHash: await readFileContentHash(audio) } };
  }
  await assertFileSignature(audio, signature);
  let shared = false;
  const base = options.sharedBase;
  if (companion && !(base && "offline" in base)) {
    try {
      const { writeSharedBlob } = await import("@/lib/collab/shared-writes");
      // An edit replaces only the exact shared version it was made from.
      const precondition = { ...(base ? ("create" in base ? { createOnly: true } : { expectedFileId: base.fileId, expectedBlobHash: base.blobHash }) : {}), ...(ownerFileId ? { ownerFileId } : {}) };
      await writeSharedBlob(transcriptCompanionPath(relativePath), new TextEncoder().encode(JSON.stringify(transcript)), precondition);
      shared = true;
      // The shared copy supersedes one kept here before.
      await rm(sidecar, { force: true });
    } catch (error) {
      if (base && !("offline" in base) && options.throwOnConflict && (error as { status?: number }).status === 409) throw new TranscriptShareConflict("The shared transcript changed.");
      console.warn(`The transcript of ${relativePath} is kept on this computer: ${error instanceof Error ? error.message : error}`);
    }
  }
  // In a shared notebook a copy kept here is a pending correction, read until it is shared or discarded.
  if (!shared) await writeLocal(sidecar, transcript, audio, signature, options.expectedContentHash, companion ? (base && !("offline" in base) ? base : { create: true }) : undefined);
  await assertFileSignature(audio, signature);
  notifySearchChanges([relativePath]);
  return { shared };
}

/** Rename speakers by index; an empty name goes back to "Speaker N". */
export async function renameTranscriptSpeakers(relativePath: string, names: Record<string, string>) {
  // A file a notebook migration is moving is written after the migration.
  await assertNotMigrating(relativePath);
  return mutateTranscript(relativePath, (transcript) => {
    transcript.speakers = transcript.speakers.map((speaker, index) => {
      const requested = names[String(index)];
      if (typeof requested !== "string") return speaker;
      return { ...speaker, name: requested.trim().slice(0, 80) || `Speaker ${index + 1}` };
    });
    return transcript;
  });
}

/**
 * Applies an edit to the transcript's authoritative version: in a shared
 * notebook the host's current bytes (a disk copy may lag another member's
 * newer transcript), replaced only if they are still that version. When
 * another member saves first, the edit is made again on their version.
 */
async function mutateTranscript(relativePath: string, apply: (transcript: Transcript) => Transcript, expectedVersion?: string) {
  const attempts = 3;
  for (let attempt = 1; ; attempt += 1) {
    const { transcript, base } = await loadForEdit(relativePath);
    if (!transcript) throw new StorageError("This recording has no transcript yet.", 404);
    // Also on a retry: the version another member saved meanwhile is not the one the reader corrected.
    if (expectedVersion !== undefined && transcriptVersion(transcript) !== expectedVersion) throw transcriptChanged();
    const edited = apply(transcript);
    try {
      await writeTranscript(relativePath, edited, { sharedBase: base, throwOnConflict: attempt < attempts });
      return edited;
    } catch (error) {
      if (!(error instanceof TranscriptShareConflict)) throw error;
    }
  }
}

async function loadForEdit(relativePath: string): Promise<{ transcript: Transcript | null; base?: SharedBase }> {
  const { companion, sidecar, audio } = locate(relativePath);
  const current = await readTranscript(relativePath);
  if (!companion) return { transcript: current.transcript };
  // A correction kept here continues from the version it was made on.
  const local = await readSidecarFile(sidecar);
  if (local?.pending && await pendingIsFor(local.transcript, audio, (await stat(audio).catch(() => null))?.size ?? -1)) return { transcript: local.transcript, base: local.pending };
  if (!current.transcript && !(await stat(locate(relativePath).audio).then((s) => s.isFile(), () => false))) return { transcript: null };
  try {
    const { readSharedBlob } = await import("@/lib/collab/shared-writes");
    const authority = await readSharedBlob(transcriptCompanionPath(relativePath));
    if (authority.contentBase64 === null) return { transcript: current.transcript, base: { create: true } };
    const base = { fileId: authority.fileId!, blobHash: authority.blobHash! };
    let parsed: Transcript | null = null;
    try { parsed = parseTranscript(JSON.parse(Buffer.from(authority.contentBase64, "base64").toString("utf8"))); } catch { /* unreadable: replaced below */ }
    return { transcript: parsed ?? current.transcript, base };
  } catch {
    // The host's state is unknown, so the edit is kept here rather than replacing it blindly.
    return { transcript: current.transcript, base: { offline: true } };
  }
}

/**
 * Replaces the transcript's passages with the reader's corrections. Speaker
 * talk times stay as pyannote measured them; passage and word counts follow
 * the text.
 */
export async function editTranscriptSegments(relativePath: string, value: unknown, expectedVersion?: string) {
  return mutateTranscript(relativePath, (transcript) => {
    const segments = cleanSegments(value, transcript.speakers.length);
    if (!segments) throw new StorageError("The transcript edits are not readable.");
    transcript.segments = segments;
    transcript.speakers = transcript.speakers.map((speaker, index) => ({ ...speaker, segments: segments.filter((segment) => segment.speaker === index).length }));
    transcript.stats = { ...transcript.stats, words: countWords(segments) };
    return transcript;
  }, expectedVersion);
}

export async function deleteTranscript(relativePath: string) {
  const { sidecar, companion } = locate(relativePath);
  if (companion) {
    const { deleteSharedEntry } = await import("@/lib/collab/shared-writes");
    // The manifest decides whether there is a companion; the disk may not have it yet.
    await deleteSharedEntry(transcriptCompanionPath(relativePath)).catch(async (error: unknown) => {
      if (await stat(companion).then(() => true, () => false)) throw error;
    });
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
  // The copy's own sidecar needs the copied recording's identity on disk.
  const writeSidecar = async () => writeLocal(destination.sidecar, transcript, destination.audio, await readFileSignature(destination.audio));
  if (destination.companion) {
    const { writeSharedBlob } = await import("@/lib/collab/shared-writes");
    // The host's answer is the authority: the recording may not have reached this disk yet, so it is not read here.
    await writeSharedBlob(transcriptCompanionPath(toPath), new TextEncoder().encode(JSON.stringify(transcript)), { createOnly: true }).catch(async (error: unknown) => {
      // The recording is already copied; without it on this disk the transcript cannot be kept beside it, and is not worth failing the copy.
      await writeSidecar().catch((failure: NodeJS.ErrnoException) => {
        if (failure.code !== "ENOENT") throw failure;
        console.warn(`The transcript of ${toPath} was not copied: ${error instanceof Error ? error.message : error}`);
      });
    });
  } else {
    await writeSidecar();
  }
}

/**
 * Whether nothing at `source` is a recording: it is not there, or what is
 * there is a directory (or anything else but a file). Anything that cannot be
 * told (no permission, a drive error) throws, so the cache is kept.
 */
async function recordingAbsent(source: string) {
  try { return !(await stat(source)).isFile(); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return true;
    throw error;
  }
}

/** Discard local sidecars of externally deleted recordings, retaining offline files. */
export async function pruneAudioSidecars(notebook: string) {
  // Missing cloud files are not deletion intent. Retain the local recovery
  // sources left by identity-checked shared lifecycle transfers. Moves that
  // waited for their recording are retried here, on every library refresh.
  if (isSharedNotebookPath(notebook)) {
    await replayPendingAudioMoves(notebook);
    return;
  }
  async function visit(directory: string, parts: string[] = []) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, [...parts, entry.name]);
      else if (entry.isFile() && entry.name.endsWith(".json") && getFileType(entry.name.slice(0, -5)) === "audio") {
        const source = filePathFromParts(notebook, [...parts, entry.name.slice(0, -5)]);
        if (await recordingAbsent(source)) {
          // Looked at again just before: the recording may have come back since.
          if (await recordingAbsent(source)) await rm(target, { force: true });
        }
      }
    }
  }
  // Only the waveform cache: a transcript is the user's work, kept for a
  // recording moved or renamed outside the app until it is found again
  // (Check Notebook → Try to fix), as a PDF's side files are.
  const [, peaks] = audioSidecarDirectories(notebook, []);
  await visit(peaks);
}

/** Moves whose destination recording had not arrived (or matched) when the host reported them; replayed later. */
const PENDING_AUDIO_MOVES = Symbol.for("libera.pendingAudioSidecarMoves");
type PendingAudioMove = { from: string; to: string; at: number };
const pendingAudioState = globalThis as { [PENDING_AUDIO_MOVES]?: Map<string, PendingAudioMove> };
const pendingAudioMoves = pendingAudioState[PENDING_AUDIO_MOVES] ??= new Map<string, PendingAudioMove>();
const PENDING_MOVE_LIMIT = 2_000;
const PENDING_MOVE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function rememberPendingAudioMove(from: string, to: string) {
  const key = `${from} ${to}`;
  if (pendingAudioMoves.size >= PENDING_MOVE_LIMIT && !pendingAudioMoves.has(key)) return;
  pendingAudioMoves.set(key, { from, to, at: Date.now() });
}

/**
 * A pending move into `from` (its recording not arrived) now ends where the
 * recording went next: A to B, then B to C before the copy to B, is A to C.
 * The correction's base (companion file ID and blob) travels with the bytes.
 */
function retargetPendingAudioMoves(from: string, to: string) {
  for (const [key, move] of [...pendingAudioMoves]) {
    if (move.to !== from) continue;
    pendingAudioMoves.delete(key);
    if (move.from !== to) rememberPendingAudioMove(move.from, to);
  }
}

/**
 * Removes the pending local transcript of a shared recording that was renamed
 * (`copy`: the copy made at its new path, which the source must still equal) or
 * deleted (no copy), so it does not stay behind as an orphan that blocks the
 * path (S-C1). Fails closed: nothing is removed unless a recovery copy of
 * exactly these bytes is kept (preserveLifecycleSidecar), the bytes are still
 * the ones judged, and (for a copy) the destination holds the same bytes.
 */
async function retireAudioTranscript(sidecar: string, root: string, copy?: string) {
  try {
    await withPathLocks([sidecar], async () => {
      const bytes = await readFile(sidecar).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (!bytes) return;
      if (copy !== undefined && !bytes.equals(await readFile(copy))) return;
      if (!await preserveLifecycleSidecar(sidecar, root)) return;
      const again = await readFile(sidecar).catch(() => null);
      if (!again?.equals(bytes)) return;
      await rm(sidecar, { force: true });
    });
  } catch { /* Kept: a source that cannot be proven safe to retire stays where it is. */ }
}

/**
 * Copies the sidecars of one moved recording. `waiting` is true when a
 * transcript was left behind only because the recording at the destination is
 * not there yet (or not these bytes yet): a cloud folder delivers it late.
 */
async function followOneAudioMove(from: string, to: string): Promise<{ changed: number; waiting: boolean }> {
  let changed = 0;
  let waiting = false;
  try {
    if (getFileType(from) !== "audio" || getFileType(to) !== "audio" || from === to) return { changed, waiting };
    const source = splitFilePath(from);
    const target = splitFilePath(to);
    const targetAudio = filePathFromParts(target.notebook, target.pathParts);
    const next = audioSidecarPaths(target.notebook, target.pathParts);
    for (const [index, sidecar] of audioSidecarPaths(source.notebook, source.pathParts).entries()) {
      let mismatch = false;
      if (await copyLifecycleSidecar(sidecar, next[index], notebookPath(target.notebook), async (bytes) => {
        const transcript = parseTranscript(JSON.parse(bytes.toString("utf8")));
        if (!transcript?.audio.contentHash) return false;
        // A recording that is missing or still arriving has no bytes to match yet.
        const matches = await readCachedFileContentHash(targetAudio).then((hash) => hash === transcript.audio.contentHash, () => false);
        if (!matches) mismatch = true;
        return matches;
      })) {
        changed += 1;
        // The transcript is at its new path now: the old copy would be an orphan no check or fix can clear (S-C1).
        if (index === 0) await retireAudioTranscript(sidecar, notebookPath(source.notebook), next[index]);
      } else if (mismatch) waiting = true;
    }
  } catch { /* Retain ambiguous sidecars, including occupied destinations and swaps. */ }
  return { changed, waiting };
}

/**
 * Retries the pending audio moves of `notebook` (all when omitted). A move is
 * done once its transcript was copied, or its source or destination sidecar no
 * longer calls for it; it expires after PENDING_MOVE_TTL_MS.
 */
export async function replayPendingAudioMoves(notebook?: string) {
  let changed = 0;
  for (const [key, move] of [...pendingAudioMoves]) {
    if (Date.now() - move.at > PENDING_MOVE_TTL_MS) { pendingAudioMoves.delete(key); continue; }
    try { if (notebook !== undefined && splitFilePath(move.to).notebook !== notebook) continue; } catch { pendingAudioMoves.delete(key); continue; }
    const result = await followOneAudioMove(move.from, move.to);
    changed += result.changed;
    if (!result.waiting) pendingAudioMoves.delete(key);
  }
  return changed;
}

/**
 * Keeps the sidecars on this computer in step with a shared notebook's files
 * when they move or go away, whoever did it: the collab host moves the
 * recordings (and their companion transcripts) itself.
 */
export async function followSharedAudioChanges(moves: Array<{ from: string; to: string }>, _removed: string[]) {
  // Recovery outlives active-path pruning, including after local conversion.
  for (const previous of [...moves.map((move) => move.from), ..._removed]) {
    try {
      if (getFileType(previous) !== "audio") continue;
      const source = splitFilePath(previous);
      for (const sidecar of audioSidecarPaths(source.notebook, source.pathParts)) await preserveLifecycleSidecar(sidecar, notebookPath(source.notebook));
    } catch { /* Keep the active source when its recovery target is unavailable. */ }
  }
  // A deleted recording's pending transcript is kept only in the recovery copy: a later recording of that name must not find it as a live record.
  const moved = new Set(moves.map((move) => move.from));
  for (const previous of _removed) {
    try {
      if (moved.has(previous) || getFileType(previous) !== "audio") continue;
      const source = splitFilePath(previous);
      if (!await recordingAbsent(filePathFromParts(source.notebook, source.pathParts))) continue;
      await retireAudioTranscript(transcriptPath(source.notebook, source.pathParts), notebookPath(source.notebook));
    } catch { /* Kept. */ }
  }
  let changed = await replayPendingAudioMoves();
  for (const { from, to } of moves) {
    retargetPendingAudioMoves(from, to);
    const result = await followOneAudioMove(from, to);
    changed += result.changed;
    if (result.waiting) rememberPendingAudioMove(from, to);
  }
  // A path-only removal is not evidence that these local notes were reviewed.
  return changed;
}
