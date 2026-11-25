// Records follow every manifest move of a shared notebook, durably.
//
// The collaboration host keeps a per-project log of the moves and removals the
// manifest went through (file ID, from, to, time), on a writer and on a follower,
// local or remote (electron/collab/notebooks/transition-log.ts). This module
// applies them to every record this computer keeps for a shared file: local
// sidecars, reviews, reference attachments, stars and tags, panel state, a PDF's
// and a recording's sidecars, and the search index. Then it acknowledges them,
// so the host trims its log.
//
//   - Idempotent. A record already moved (by this process, or by the user's
//     other device through a synced library) is not there to move again.
//   - Ordered per file ID; a file's chain stops at the first step that failed.
//   - Ownership is checked before anything moves or goes: a record at `from`
//     that was written after the transition, or whose path the manifest now
//     gives to a different file, may be another file's, so it is held (left
//     where it is and reported), never moved or deleted.
//   - A transition is acknowledged only when every step ran (or it was held on
//     purpose). A step that failed is retried by the next run and reported.
//   - One run at a time per notebook; the lock is never held across a host call.
//
// The shared wrappers (moveSharedFile, ...) apply their own change right after
// the host commits, through followCommittedChange, so the response reports what
// stayed behind. The log makes sure a lost response, a crash or a move made by a
// collaborator is still applied later (drainSharedRecordTransitions).

import { acknowledgeManifestTransitions, collabHostConfig, listProjectEntries, readManifestTransitions, type HostClientConfig } from "@/lib/collab/host-client";
import type { ManifestTransition } from "@/lib/collab/local-api";
import type { SharedCommittedChange } from "@/lib/collab/shared-outcomes";
import { sharedNotebookMarker } from "@/lib/collab/shared-notebook";
import { getFileType } from "@/lib/storage/file-types";
import { foldedFileName } from "@/lib/storage/file-names";
import { discardReviewsAt, hasReviewEntry, moveReviewEntryAfterMove } from "@/lib/agent/review-store";
import { moveTetheredFilesBatch } from "@/lib/references/bib-tether";
import { copyFileIfExists, isCaseOnlyRename, pathExists, renameCaseAlias, retireIfUnchanged, snapshotFile, withPathLocks } from "@/lib/storage/fs-utils";
import { deleteReviewPath, moveReviewPaths } from "@/lib/storage/markdown-reviews";
import { followSharedPdfChanges } from "@/lib/storage/pdf-sidecars";
import { filePathFromParts, splitFilePath } from "@/lib/storage/paths";
import { detachReferenceAttachmentsChecked, moveReferenceAttachmentsChecked } from "@/lib/storage/references";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { HOST_OWNED_SIDECARS, removeLocalSidecars, SIDECAR_KINDS } from "@/lib/storage/sidecars";
import { isTextFileType } from "@/lib/types";
import { followSharedAudioChanges } from "@/lib/storage/transcripts";
import { removeFileMetadataPath, removeNotebookPanelExpandedPathPrefix, renameFileMetadataPath, renameNotebookPanelExpandedPathPrefix } from "@/lib/storage/workspace-metadata";

/** A record written this long after a transition is not the one the transition was about. */
const WRITTEN_AFTER_SLACK_MS = 2_000;
/** A move whose destination has not arrived (a recording or PDF still downloading) is retried for this long. */
const WAITING_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** One move (`to` is the new Libera path) or removal (`to` is null) to apply. From the host's log it has a seq, file ID and time; the shared wrappers make their own without a seq. */
export type FollowTransition = { seq?: number; fileId?: string; kind?: "file" | "folder"; from: string; to: string | null; at?: number; explicit?: boolean };

/** The host's synthetic file ID for a local-only file it archived because an incoming entry claimed its path (electron/collab/notebooks/project.ts displacedPath). */
const DISPLACED_PREFIX = "displaced-";

export interface TransitionOutcome {
  seq?: number;
  fileId?: string;
  from: string;
  to: string | null;
  /**
   * applied: every step ran. held: records were left where they are on purpose (see `held`); final.
   * obsolete: the manifest has the file again, so nothing was removed; final.
   * waiting: a recording or PDF has not arrived at its new path yet; retried later.
   * unfinished: a step failed (see `unfinished`); retried by the next run.
   */
  state: "applied" | "held" | "obsolete" | "waiting" | "unfinished";
  /** Records left alone because their owner cannot be established, one plain phrase each. */
  held: string[];
  /** Steps that failed, one plain phrase each. */
  unfinished: string[];
  /** Records that cannot be updated until something is connected (a reference library in an unconnected linked folder), one plain phrase each; retried later like `waiting`. */
  pending?: string[];
}

export interface DrainResult {
  notebook: string;
  /** False when the host's log could not be read (collaboration off, the host not running or too old): nothing came from it. */
  reachable: boolean;
  /** Why, or why the acknowledgement did not go through. */
  error?: string;
  outcomes: TransitionOutcome[];
  /** Transitions applied in full (acknowledged). */
  applied: number;
  /** Records left alone because their owner cannot be established (plain phrases). */
  held: string[];
  /** Steps that failed and will be retried (plain phrases). */
  unfinished: string[];
  /** Moves still waiting for a recording or PDF to arrive. */
  waiting: number;
}

export interface FollowOptions {
  /** The host's address; undefined: this launch's, null: none. */
  config?: HostClientConfig | null;
  /** Changes this user's own wrapper has just had the host commit: transitions in the log that match them are this user's explicit moves (a PDF's legacy notes follow them), the rest are not. */
  own?: ReadonlyArray<SharedCommittedChange>;
}

/**
 * The notebook's file list. `byPath` is keyed by the round's name rule (`foldedPath`): on a volume that treats case and Unicode form as
 * one name, a record at `Shared/Note.md` is the record of whichever file the manifest has at `Shared/note.md` (S-H4).
 * `awaiting`: moves and removals in it that the server has not acknowledged yet (S-C2).
 */
type Manifest = { byPath: Map<string, string>; fileIds: Set<string>; pathOf: Map<string, string>; awaiting: number };

/** A Libera path under the one name rule (foldedFileName per segment), the key two spellings of one name share. */
const foldedPath = (path: string) => path.split("/").map(foldedFileName).join("/");

const isFinal = (outcome: TransitionOutcome) => outcome.state === "applied" || outcome.state === "held" || outcome.state === "obsolete";

// ---------------------------------------------------------------------------
// One run at a time per notebook
// ---------------------------------------------------------------------------

type FollowState = {
  tails: Map<string, Promise<unknown>>;
  /** The drain running (or queued last) for each notebook. */
  drains: Map<string, Promise<void>>;
  /** Applied here, acknowledgement not yet confirmed: a later run acknowledges again and does not apply again. */
  applied: Map<string, TransitionOutcome>;
  /**
   * This user's own changes the host committed but the server had not acknowledged when their wrapper looked, by notebook: their records
   * wait for the log row recorded at the acknowledgement, which is then an explicit move (a PDF's legacy notes follow it). Memory only,
   * bounded and dated; a change lost here (a restart) is still followed from the log, as a collaborator's would be.
   */
  expected: Map<string, Array<{ change: SharedCommittedChange; at: number }>>;
};
const STATE_KEY = Symbol.for("libera.sharedRecordFollow");
const followState = ((globalThis as { [STATE_KEY]?: FollowState })[STATE_KEY] ??= { tails: new Map(), drains: new Map(), applied: new Map(), expected: new Map() });
// A state object made by an earlier copy of this module (hot reload) has no drain queue.
followState.drains ??= new Map();
followState.expected ??= new Map();

const EXPECTED_MAX = 1_000;
const EXPECTED_TTL_MS = 24 * 60 * 60 * 1000;

const sameChange = (change: SharedCommittedChange, transition: { from: string; to: string | null; fileId?: string }) =>
  transition.from === change.from && transition.to === change.to && (change.fileId === undefined || change.fileId === transition.fileId);

function expectChanges(notebook: string, changes: SharedCommittedChange[]) {
  const now = Date.now();
  const kept = (followState.expected.get(notebook) ?? []).filter((item) => now - item.at < EXPECTED_TTL_MS && !changes.some((change) => sameChange(change, { ...item.change, fileId: item.change.fileId })));
  kept.push(...changes.map((change) => ({ change, at: now })));
  followState.expected.set(notebook, kept.slice(-EXPECTED_MAX));
}

function forgetExpected(notebook: string, done: (change: SharedCommittedChange) => boolean) {
  const kept = (followState.expected.get(notebook) ?? []).filter((item) => !done(item.change));
  if (kept.length) followState.expected.set(notebook, kept); else followState.expected.delete(notebook);
}

/** The most seqs the host accepts in one acknowledgement (service.ts: transitionsAck). */
const ACK_BATCH = 5_000;

/** Runs `work` after the notebook's earlier runs. Only local work goes inside: never a host call that can wait. */
function exclusive<T>(notebook: string, work: () => Promise<T>): Promise<T> {
  const previous = followState.tails.get(notebook) ?? Promise.resolve();
  const next = previous.then(work, work);
  const tail = next.catch(() => undefined);
  followState.tails.set(notebook, tail);
  void tail.then(() => { if (followState.tails.get(notebook) === tail) followState.tails.delete(notebook); });
  return next;
}

// ---------------------------------------------------------------------------
// The steps. Each is a small named call; a step that fails throws and is reported.
// ---------------------------------------------------------------------------

/** Records of a file that SIDECAR_KINDS lists and that something else already moves in a shared notebook: the host, the PDF reconciliation, or nothing (a waveform cache is made again). */
const SIDECARS_MOVED_ELSEWHERE = HOST_OWNED_SIDECARS;

/**
 * The records of a renamed shared file that live only on this computer (image
 * annotations, definitions of a note or LaTeX file, and any kind added to
 * SIDECAR_KINDS later), moved with it as a local rename does. Never replaces a
 * record already at the destination. `held`: left where they are (the
 * destination has one, or the record was written after `since`, or a newer
 * version was saved at the old place while it was copied, or the new type cannot
 * keep it); `failed`: could not move (retried). The copy is published exclusively
 * and only the version that was copied is retired, under the record's path locks;
 * a case-only rename (both spellings are the same slot) goes through a temporary name.
 */
export async function moveSharedLocalRecords(from: string, to: string, since?: number): Promise<{ held: string[]; failed: string[] }> {
  const result = { held: [] as string[], failed: [] as string[] };
  if (from === to) return result;
  const source = splitFilePath(from);
  const target = splitFilePath(to);
  const fromType = getFileType(source.name);
  const toType = getFileType(target.name);
  if (!fromType || !toType) return result;
  for (const kind of SIDECAR_KINDS) {
    if (SIDECARS_MOVED_ELSEWHERE.has(kind.id) || (kind.id === "definitions" && fromType === "pdf")) continue;
    if (!kind.appliesTo(fromType)) continue;
    const old = kind.filePath(source.notebook, source.pathParts);
    const next = kind.filePath(target.notebook, target.pathParts);
    if (!kind.appliesTo(toType)) {
      // A type change made elsewhere (a collaborator's): the record stays and is reported, never dropped.
      if (!kind.cache && kind.layout !== "folder" && old !== next && await pathExists(old)) result.held.push(`${kind.id} of ${from} (a ${toType} file cannot keep it)`);
      continue;
    }
    if (old === next || !(await pathExists(old))) continue;
    try {
      if (kind.layout === "folder") continue;
      await withPathLocks([old, next], async () => {
        const seen = await snapshotFile(old);
        if (!seen) return;
        if (since !== undefined && Number(seen.mtimeNs / BigInt(1_000_000)) > since + WRITTEN_AFTER_SLACK_MS) {
          result.held.push(`${kind.id} of ${from} (written after the file moved, so it may belong to a file now at that path)`);
          return;
        }
        // A letter-case change on a volume that treats both spellings as one slot: the record itself occupies the destination.
        if (await isCaseOnlyRename(old, next)) { await renameCaseAlias(old, next); return; }
        // Created exclusively, like the Python sidecar's move: a record saved there meanwhile is never replaced.
        await copyFileIfExists(old, next, { exclusive: true });
        // Only the version that was copied goes: one saved at the old place meanwhile stays, and both are recoverable.
        if (await retireIfUnchanged(old, seen) === "newer") result.held.push(`${kind.id} of ${from} (a newer version was saved there while it moved, so it was kept; ${to} has the earlier one)`);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") result.held.push(`${kind.id} of ${from} (${to} already has one)`);
      else {
        console.error(`[shared-record-follow] Could not move the ${kind.id} record of ${from} to ${to}:`, error);
        result.failed.push(`${kind.id} of ${from}`);
      }
    }
  }
  return result;
}

/** A PDF's local side-cars (annotations, outline, definitions, text cache), the way its own follower does. */
async function followPdf(t: FollowTransition) {
  // This user's own move through the host is explicit: their legacy (hash-less) notes follow it. A collaborator's, or one replayed from the log, is decided by the collaborator rule.
  if (t.to !== null) await followSharedPdfChanges([{ from: t.from, to: t.to, ...(t.fileId ? { fileId: t.fileId } : {}) }], [], t.explicit ? { explicit: true } : {});
  else await followSharedPdfChanges([], [t.from]);
}

/** A recording's local sidecars; the host moved or dropped the companion transcript in the same manifest change. */
async function followAudio(t: FollowTransition) {
  if (t.to !== null) await followSharedAudioChanges([{ from: t.from, to: t.to }], []);
  else await followSharedAudioChanges([], [t.from]);
}

/**
 * The records a file has at a path of their own, beside its sidecars, for a file the host moved: review comments, the pending agent review,
 * reference attachments, a tethered .bib file, stars and tags. Each is tried whatever the one before did. `held`: left alone on purpose
 * (the destination has records of its own); `pending`: waiting for something to be connected. Returns the stores that could not be
 * updated (after the rest ran), so the move stays in the log and is retried.
 */
async function moveDerivedRecords(from: string, to: string, report: { held: string[]; pending: string[] }): Promise<string[]> {
  const failed: string[] = [];
  const attempt = async (what: string, work: () => Promise<unknown>) => {
    try { await work(); } catch (error) {
      console.error(`[shared-record-follow] Could not move the ${what} of ${from} to ${to}:`, error);
      failed.push(what);
    }
  };
  const fromType = getFileType(from);
  const toType = getFileType(to);
  await attempt("review comments", async () => {
    // A destination that gained comments meanwhile keeps them, and the review moving there stays where it was.
    const stayed = await moveReviewPaths(new Map([[from, to]]), { replaceEmpty: true });
    if (stayed.includes(from)) report.held.push(`review comments of ${from} (${to} has comments of its own)`);
  });
  await attempt("pending agent changes", async () => {
    // A review follows only a text file; the committed pair is the one the host moved, so a note never gets two review documents.
    if (!isTextFileType(fromType ?? undefined)) return;
    if (!isTextFileType(toType ?? undefined)) {
      if (await hasReviewEntry(from)) report.held.push(`pending agent changes of ${from} (a ${toType} file cannot keep them)`);
      return;
    }
    if (await moveReviewEntryAfterMove(from, to) === "held") report.held.push(`pending agent changes of ${from} (${to} has a pending review of its own)`);
  });
  await attempt("reference attachments", async () => {
    const { failures, offline } = await moveReferenceAttachmentsChecked(from, to);
    if (offline.length) report.pending.push(`reference attachments in ${offline.join(", ")} (not connected, so they still point at ${from})`);
    if (failures.length) throw new Error(failures.map((failure) => failure.notebook || "the libraries").join(", "));
  });
  await attempt("tethered .bib file", async () => {
    const failures = await moveTetheredFilesBatch(new Map([[from, to]]));
    if (failures.length) throw new Error(failures.map((failure) => failure.notebook).join(", "));
  });
  await attempt("stars and tags", () => renameFileMetadataPath(from, to));
  return failed;
}

/** Undo history of the agent runs that changed files before they were shared follows their moves (one pass over the runs for the whole batch; shared runs carry document IDs and are skipped). */
async function followRunHistory(moves: Array<{ from: string; to: string }>) {
  const composed = new Map<string, string>();
  for (const { from, to } of moves) {
    const earlier = [...composed].find(([, destination]) => destination === from);
    if (earlier) composed.set(earlier[0], to); else composed.set(from, to);
  }
  // Imported here: snapshots reaches back into storage through shared-writes.
  const { recordMovedRunFiles } = await import("@/lib/agent/snapshots");
  await recordMovedRunFiles(new Map([...composed].map(([from, to]) => [from, { to }])));
}

/** Whether the file a move brought to `to` is on this computer yet (a PDF or recording a cloud folder delivers late). */
async function arrived(to: string): Promise<boolean> {
  const { notebook, pathParts } = splitFilePath(to);
  return pathExists(filePathFromParts(notebook, pathParts));
}

// ---------------------------------------------------------------------------
// Applying one transition
// ---------------------------------------------------------------------------

type Verdict = { kind: "own" } | { kind: "obsolete" } | { kind: "hold"; why: string };

/** Whether the records at `from` can be taken for this transition's file's, from what the manifest says now. */
function judge(t: FollowTransition, manifest: Manifest | null, batch: FollowTransition[] = []): Verdict {
  // The shared wrappers pass no seq: the host has just answered that it committed this change for the file they asked about, which is what they know without the list.
  // A change from the log is never judged without the list (drain waits for it).
  if (!manifest) return t.seq === undefined ? { kind: "own" } : { kind: "hold", why: "the notebook's file list could not be read, so the owner of its records cannot be established" };
  // A local-only file the host archived because an incoming entry claimed its path: the claimant is at `from` by design, and the records there are the archived file's.
  if (t.fileId?.startsWith(DISPLACED_PREFIX)) return { kind: "own" };
  // Compared under the name rule: the file the manifest has at `Shared/note.md` owns the records at `Shared/Note.md` on a volume where they are one slot (S-H4).
  const occupant = manifest.byPath.get(foldedPath(t.from));
  if (occupant !== undefined && t.fileId === undefined) return { kind: "hold", why: "another file is at that path now and this change does not say which file it was" };
  // A file that is at that path because it moved in within this very batch (a chain: this one moves out first, see orderTransitions) is not a claimant of the records there.
  if (occupant !== undefined && occupant !== t.fileId && !batch.some((other) => other.fileId === occupant && other.to !== null && foldedPath(other.to) === foldedPath(t.from))) return { kind: "hold", why: "another file is at that path now, so its records may be that file's" };
  // From the log (it has a file ID): a file listed in the manifest again was not removed after all, and records of a file that is still there are not deleted.
  // The shared wrappers pass no seq: the host has just answered that it removed the file.
  if (t.to === null && t.seq !== undefined && t.fileId !== undefined && manifest.fileIds.has(t.fileId)) return { kind: "obsolete" };
  return { kind: "own" };
}

const isFolder = (t: FollowTransition) => t.kind === "folder";

/** Every step for one transition. Returns what was left alone and what failed. */
async function applyOne(t: FollowTransition, verdict: Verdict, history: FollowTransition[]): Promise<TransitionOutcome> {
  const outcome: TransitionOutcome = { ...(t.seq === undefined ? {} : { seq: t.seq }), ...(t.fileId === undefined ? {} : { fileId: t.fileId }), from: t.from, to: t.to, state: "applied", held: [], unfinished: [], pending: [] };
  if (verdict.kind === "obsolete") return { ...outcome, state: "obsolete" };
  if (verdict.kind === "hold") {
    const what = t.to === null ? `records of ${t.from}` : `records of ${t.from}`;
    return { ...outcome, state: "held", held: [`${what} (${verdict.why})`] };
  }
  const attempt = async (what: string, work: () => Promise<unknown>) => {
    try { await work(); } catch (error) {
      console.error(`[shared-record-follow] Could not ${t.to === null ? "remove" : "move"} the ${what} of ${t.from}:`, error);
      outcome.unfinished.push(what);
    }
  };
  const type = getFileType(t.from);
  let waiting = false;
  if (isFolder(t)) {
    // The files inside have transitions of their own; a folder has stars and tags, and an expanded or collapsed state in the panel.
    if (t.to !== null) {
      await attempt("stars and tags", () => renameFileMetadataPath(t.from, t.to as string));
      await attempt("panel state", () => renameNotebookPanelExpandedPathPrefix(t.from, t.to as string));
    } else {
      await attempt("stars and tags", () => removeFileMetadataPath(t.from));
      await attempt("panel state", () => removeNotebookPanelExpandedPathPrefix(t.from));
    }
  } else if (t.to !== null) {
    const to = t.to;
    const toType = getFileType(to);
    if (type === "audio") await attempt("recording sidecars", () => followAudio(t));
    if (type === "pdf") await attempt("PDF notes", () => followPdf(t));
    await attempt("local records", async () => {
      const moved = await moveSharedLocalRecords(t.from, to, t.at);
      outcome.held.push(...moved.held);
      if (moved.failed.length) throw new Error(moved.failed.join("; "));
    });
    await attempt("local stores", async () => { outcome.unfinished.push(...await moveDerivedRecords(t.from, to, { held: outcome.held, pending: outcome.pending as string[] })); });
    // Undo history of earlier agent runs follows, once for the whole batch (applyTransitions).
    if (isTextFileType(type ?? undefined)) history.push(t);
    // A recording or PDF still on its way keeps its transition until it is there; its notes are copied only to bytes that match.
    if ((type === "audio" || type === "pdf") && toType === type && !(await arrived(to))) waiting = true;
  } else {
    const parts = splitFilePath(t.from);
    if (type === "audio") await attempt("recording sidecars", () => followAudio(t));
    // This user's, or a collaborator's, deletion: notes on it go too, as in a local notebook.
    if (type === "pdf") await attempt("PDF notes", () => followPdf(t));
    // Only the records Next keeps itself: ink, transcripts and a note's Python code are manifest entries the host removes, never unlinked from here.
    if (type) await attempt("local records", () => removeLocalSidecars(parts.notebook, parts.pathParts, type, HOST_OWNED_SIDECARS));
    await attempt("review comments", () => deleteReviewPath(t.from));
    // The file is gone, so its pending agent review no longer describes anything and would block the path (a deliberate discard, as for a local delete).
    await attempt("pending agent changes", () => discardReviewsAt(t.from));
    await attempt("reference attachments", async () => {
      const { failures, offline } = await detachReferenceAttachmentsChecked(t.from);
      if (offline.length) (outcome.pending as string[]).push(`reference attachments in ${offline.join(", ")} (not connected, so they still point at ${t.from})`);
      if (failures.length) throw new Error(failures.map((failure) => failure.notebook || "the libraries").join(", "));
    });
    await attempt("stars and tags", () => removeFileMetadataPath(t.from));
  }
  notifySearchChanges(t.to === null ? [t.from] : [t.from, t.to]);
  if (outcome.unfinished.length) return { ...outcome, state: "unfinished" };
  if ((waiting || outcome.pending?.length) && !(t.at !== undefined && Date.now() - t.at > WAITING_TTL_MS)) return { ...outcome, state: "waiting" };
  return { ...outcome, state: outcome.held.length ? "held" : "applied" };
}

/**
 * The order to apply a batch in: a file's own transitions in the order they happened, and a move out of a path before another file's move into it.
 * Transitions that wait for each other in a circle (two files swapped names) cannot be ordered safely and are returned apart.
 */
function orderTransitions(list: FollowTransition[]): { ordered: FollowTransition[]; circular: FollowTransition[] } {
  const after = list.map(() => new Set<number>());
  list.forEach((a, i) => list.forEach((b, j) => {
    if (i === j) return;
    // b comes before a when it is the same file's earlier step, or when b moves out of the path a moves into.
    if (a.fileId !== undefined && a.fileId === b.fileId) { if ((b.seq ?? j) < (a.seq ?? i) || (b.seq === a.seq && j < i)) after[i].add(j); }
    else if (a.to !== null && foldedPath(b.from) === foldedPath(a.to)) after[i].add(j);
  }));
  const ordered: FollowTransition[] = [];
  const placed = new Set<number>();
  for (let progress = true; progress && placed.size < list.length;) {
    progress = false;
    list.forEach((t, i) => {
      if (placed.has(i) || [...after[i]].some((j) => !placed.has(j))) return;
      placed.add(i);
      ordered.push(t);
      progress = true;
    });
  }
  return { ordered, circular: list.filter((_, i) => !placed.has(i)) };
}

/**
 * Applies transitions to this computer's records. `manifest` is the notebook's file list now (null when it could not be read: nothing is applied then).
 * Returns one outcome per transition, in the order given.
 */
async function applyTransitions(notebook: string, projectId: string | null, transitions: FollowTransition[], manifest: Manifest | null): Promise<TransitionOutcome[]> {
  return exclusive(notebook, async () => {
    const results = new Map<FollowTransition, TransitionOutcome>();
    const pending: FollowTransition[] = [];
    for (const t of transitions) {
      const done = t.seq !== undefined && projectId ? followState.applied.get(`${projectId}:${t.seq}`) : undefined;
      if (done) results.set(t, done);
      else pending.push(t);
    }
    const { ordered, circular } = orderTransitions(pending);
    const failedFiles = new Set<string>();
    const history: FollowTransition[] = [];
    for (const t of circular) {
      results.set(t, { ...(t.seq === undefined ? {} : { seq: t.seq }), ...(t.fileId === undefined ? {} : { fileId: t.fileId }), from: t.from, to: t.to, state: "held", held: [`records of ${t.from} (files swapped names, so which records belong to which cannot be established)`], unfinished: [] });
    }
    for (const t of ordered) {
      // A file's later steps wait for its failed one, so its records are never moved out of order.
      if (t.fileId !== undefined && failedFiles.has(t.fileId)) {
        results.set(t, { ...(t.seq === undefined ? {} : { seq: t.seq }), fileId: t.fileId, from: t.from, to: t.to, state: "unfinished", held: [], unfinished: [`earlier steps for ${t.from} did not finish`] });
        continue;
      }
      let outcome: TransitionOutcome;
      try { outcome = await applyOne(t, judge(t, manifest, ordered), history); }
      catch (error) {
        console.error(`[shared-record-follow] ${t.from}:`, error);
        outcome = { ...(t.seq === undefined ? {} : { seq: t.seq }), ...(t.fileId === undefined ? {} : { fileId: t.fileId }), from: t.from, to: t.to, state: "unfinished", held: [], unfinished: [`records of ${t.from}`] };
      }
      if (outcome.state === "unfinished" && t.fileId !== undefined) failedFiles.add(t.fileId);
      if (isFinal(outcome) && t.seq !== undefined && projectId) followState.applied.set(`${projectId}:${t.seq}`, outcome);
      results.set(t, outcome);
    }
    if (history.length) {
      try { await followRunHistory(history.map((t) => ({ from: t.from, to: t.to as string }))); }
      catch (error) {
        console.error("[shared-record-follow] Could not move the undo history of the agent runs:", error);
        for (const t of history) {
          const done = results.get(t) as TransitionOutcome;
          results.set(t, { ...done, state: "unfinished", unfinished: [...done.unfinished, "agent undo history"] });
          if (t.seq !== undefined && projectId) followState.applied.delete(`${projectId}:${t.seq}`);
        }
      }
    }
    return transitions.map((t) => results.get(t) as TransitionOutcome);
  });
}

// ---------------------------------------------------------------------------
// Reading the host
// ---------------------------------------------------------------------------

async function readManifest(notebook: string, projectId: string, config: HostClientConfig): Promise<Manifest | null> {
  try {
    const result = await listProjectEntries(projectId, config);
    if (!result || !Array.isArray(result.entries)) return null;
    const byPath = new Map<string, string>();
    const fileIds = new Set<string>();
    const pathOf = new Map<string, string>();
    for (const entry of result.entries) {
      byPath.set(foldedPath(`${notebook}/${entry.path}`), entry.fileId);
      pathOf.set(entry.fileId, `${notebook}/${entry.path}`);
      fileIds.add(entry.fileId);
    }
    return { byPath, fileIds, pathOf, awaiting: typeof result.awaitingServer === "number" ? result.awaitingServer : 0 };
  } catch {
    return null;
  }
}

const blank = (notebook: string, extra: Partial<DrainResult> = {}): DrainResult => ({ notebook, reachable: true, outcomes: [], applied: 0, held: [], unfinished: [], waiting: 0, ...extra });

function summarize(notebook: string, outcomes: TransitionOutcome[], extra: Partial<DrainResult> = {}): DrainResult {
  return blank(notebook, {
    outcomes,
    applied: outcomes.filter((outcome) => outcome.state === "applied" || outcome.state === "obsolete").length,
    held: outcomes.flatMap((outcome) => outcome.held),
    unfinished: outcomes.flatMap((outcome) => [...outcome.unfinished, ...outcome.pending ?? []]),
    waiting: outcomes.filter((outcome) => outcome.state === "waiting").length,
    ...extra,
  });
}

/**
 * Applies what the host's log holds for this shared notebook to the records on
 * this computer, then acknowledges it. Cheap when nothing is pending (one host
 * call). Never throws: a host that cannot answer gives `reachable: false`; what
 * could not be applied stays in the log and is reported in `unfinished`, what
 * was left alone on purpose in `held`. Call it before Check Notebook, when a
 * shared notebook's tree loads, and when the host reports a tree change.
 */
export async function drainSharedRecordTransitions(notebook: string, options: FollowOptions = {}): Promise<DrainResult> {
  // One drain at a time per notebook, from reading the log to acknowledging it: an overlapping drain would hold a log and a file
  // list that are out of date by the time it gets the lock, and could apply a transition twice or to a file created since.
  // Host calls are bounded by a timeout, so a drain that waits here cannot wait forever.
  const previous = followState.drains.get(notebook) ?? Promise.resolve();
  const run = previous.then(() => drain(notebook, options));
  const tail = run.then(() => undefined, () => undefined);
  followState.drains.set(notebook, tail);
  void tail.then(() => { if (followState.drains.get(notebook) === tail) followState.drains.delete(notebook); });
  const result = await run;
  noteDrained(notebook, result);
  return result;
}

/**
 * A move a collaborator (or Finder or Explorer on the host's disk) made is not followed by this user's own notes:
 * the mover rewrote the shared notes that linked in, but a local note elsewhere in this library (or in the notebook's
 * `_archive/`) is on this computer only. Each moved file's net move (a chain a to b to c is one a to c) is followed
 * by those local notes, on disk. One pass per drain, only when the log had such moves; the shared notes are left to
 * the mover. Never throws: a note left behind is what Check Notebook reports.
 */
async function followLocalLinksOfRemoteMoves(transitions: readonly FollowTransition[], outcomes: readonly TransitionOutcome[]) {
  const net = new Map<string, { from: string; to: string; folder: boolean }>();
  transitions.forEach((t, index) => {
    const outcome = outcomes[index];
    if (t.explicit || t.to === null || !outcome || outcome.state !== "applied" || t.from === t.to) return;
    const key = t.fileId ?? `${t.kind ?? "file"}:${t.from}`;
    const earlier = net.get(key);
    net.set(key, { from: earlier?.from ?? t.from, to: t.to, folder: t.kind === "folder" });
  });
  const moves = [...net.values()].filter((move) => move.from !== move.to).map((move) => ({ from: move.from, to: move.to, ...(move.folder ? { folder: true } : {}) }));
  if (!moves.length) return;
  try {
    const { followSharedMovedLinks } = await import("@/lib/storage/shared-move-links");
    await followSharedMovedLinks(moves, { localOnly: true });
  } catch (error) {
    console.error("[shared-record-follow] Local links did not follow a collaborator's move:", error);
  }
}

async function drain(notebook: string, options: FollowOptions): Promise<DrainResult> {
  const marker = sharedNotebookMarker(notebook);
  const config = options.config === undefined ? collabHostConfig() : options.config;
  if (!marker?.projectId) return blank(notebook, { reachable: false, error: `${notebook} is not a shared notebook.` });
  if (!config) return blank(notebook, { reachable: false, error: "Collaboration is not running in this Libera." });
  const transitions: ManifestTransition[] = [];
  try {
    for (let after = 0, more = true; more;) {
      const page = await readManifestTransitions(marker.projectId, after, 500, config);
      transitions.push(...page.transitions);
      more = page.more && page.transitions.length > 0;
      after = page.transitions.at(-1)?.seq ?? after;
    }
  } catch (error) {
    return blank(notebook, { reachable: false, error: error instanceof Error ? error.message : String(error) });
  }
  if (transitions.length === 0) return blank(notebook);
  // Ownership is judged against the manifest as it is now; read outside the lock.
  const manifest = await readManifest(notebook, marker.projectId, config);
  // Nothing from the log is applied without knowing who owns the paths now: it stays in the log for the next run.
  if (!manifest) return blank(notebook, { error: "The notebook's file list could not be read, so the owner of its records cannot be established. The changes stay in the host's log." });
  // This user's own wrapper's changes are explicit moves; the rest of the log (a collaborator's, or one replayed after a crash) is not.
  // Changes whose wrapper had to leave them for the server's acknowledgement are this user's too (S-C2).
  const own = [...(options.own ?? []), ...(followState.expected.get(notebook)?.map((item) => item.change) ?? [])];
  const marked: FollowTransition[] = transitions.map((t) => own.some((change) => sameChange(change, t)) ? { ...t, explicit: true } : t);
  const outcomes = await applyTransitions(notebook, marker.projectId, marked, manifest);
  await followLocalLinksOfRemoteMoves(marked, outcomes);
  if (followState.expected.has(notebook)) forgetExpected(notebook, (change) => outcomes.some((outcome) => isFinal(outcome) && sameChange(change, outcome)));
  const done = outcomes.filter(isFinal).map((outcome) => outcome.seq).filter((seq): seq is number => seq !== undefined);
  let error: string | undefined;
  // The host takes at most ACK_BATCH seqs per call (it answers 400 for more); a batch that failed leaves the rest for the next run.
  for (let start = 0; start < done.length && !error; start += ACK_BATCH) {
    const batch = done.slice(start, start + ACK_BATCH);
    try {
      await acknowledgeManifestTransitions(marker.projectId, { seqs: batch }, config);
      for (const seq of batch) followState.applied.delete(`${marker.projectId}:${seq}`);
    } catch (failure) {
      // Applied here already; the next run acknowledges again without applying again.
      error = `The host could not be told which changes were applied: ${failure instanceof Error ? failure.message : String(failure)}`;
    }
  }
  return summarize(notebook, outcomes, error ? { error } : {});
}

// ---------------------------------------------------------------------------
// When to drain: on events, never on a timer
// ---------------------------------------------------------------------------

const RETRY_FIRST_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;
type Pacing = { idle: Set<string>; retry: Map<string, { until: number; delay: number }> };
const PACING_KEY = Symbol.for("libera.sharedRecordFollow.pacing");
const pacing = ((globalThis as { [PACING_KEY]?: Pacing })[PACING_KEY] ??= { idle: new Set(), retry: new Map() });

/** Remembers whether the log is empty: idle until the host's next nudge; otherwise retried with capped, doubling waits that restart on progress. */
function noteDrained(notebook: string, result: DrainResult) {
  const settled = result.reachable && !result.error && result.outcomes.every(isFinal);
  if (settled) {
    pacing.idle.add(notebook);
    pacing.retry.delete(notebook);
    return;
  }
  pacing.idle.delete(notebook);
  const previous = pacing.retry.get(notebook);
  const progressed = result.applied > 0;
  const delay = !previous || progressed ? RETRY_FIRST_MS : Math.min(RETRY_MAX_MS, previous.delay * 2);
  pacing.retry.set(notebook, { until: Date.now() + delay, delay });
}

/**
 * For a path that runs often (a tree load): drains only when something may be
 * pending, so a notebook with nothing pending costs no host call. That is the
 * first time in this process, after a nudge, and after a run that left
 * something behind (then at most once per growing wait). Null when it did not drain.
 */
export async function drainSharedRecordTransitionsIfPending(notebook: string, options: FollowOptions = {}): Promise<DrainResult | null> {
  if (pacing.idle.has(notebook)) return null;
  const wait = pacing.retry.get(notebook);
  if (wait && wait.until > Date.now()) return null;
  return drainSharedRecordTransitions(notebook, options);
}

/** The host reported a tree change (or a window opened): something may be pending now. Drains at once. */
export function nudgeSharedRecordTransitions(notebook: string, options: FollowOptions = {}): Promise<DrainResult> {
  pacing.idle.delete(notebook);
  pacing.retry.delete(notebook);
  return drainSharedRecordTransitions(notebook, options);
}

export interface FollowedChange {
  /** What stayed behind, one plain phrase each; empty when everything followed. */
  unfinished: string[];
  /** Records left alone because their owner cannot be established (also in `unfinished`). */
  held: string[];
  /** Changes the server has not acknowledged yet, one plain phrase each: their records follow the host's log row recorded at the acknowledgement (not a failure; nothing was moved or removed). */
  awaiting: string[];
}

/** Whether the manifest as it is now still shows the change (a move put the file at `to`; a removal left it out), so a record can follow it; false: the server rolled it back or it was changed since. */
function manifestShows(change: SharedCommittedChange & { kind?: "file" | "folder" }, manifest: Manifest): boolean {
  if (change.fileId !== undefined) {
    const now = manifest.pathOf.get(change.fileId);
    return change.to === null ? now === undefined : now !== undefined && foldedPath(now) === foldedPath(change.to);
  }
  // A folder held only as the directory of its files has no entry of its own: its files say where it is.
  if (change.kind === "folder") {
    const below = (folder: string) => [...manifest.byPath.keys()].some((key) => key.startsWith(`${foldedPath(folder)}/`));
    return change.to === null ? !below(change.from) : below(change.to);
  }
  return true;
}

/**
 * The records on this computer follow a change the host has just committed:
 * the moves and removals in `committed` (Libera paths; `fileId` when known,
 * which is what ties a record to the file and not to the path). The host's log
 * is applied first, so the change is applied as the log has it; a change the log
 * does not hold (a host that does not keep one, a failed read) is applied from
 * `committed` through the same steps. Nothing here can undo the host's change:
 * every step runs, and what stayed behind is returned, never thrown.
 *
 * Nothing local is destroyed or moved before the server has the change (S-C2): the
 * host logs a move or removal only once the server acknowledged it, because the
 * server can still roll it back. A change the log does not hold yet while the host
 * says changes are awaiting the server is left for the log row: the host announces
 * it when it is recorded (`transitions-recorded`), Next drains it, and it is followed
 * once, as this user's own move. A rolled-back change never gets a row, so its
 * records are where the restored manifest expects them.
 */
export async function followCommittedChange(notebook: string, committed: Array<SharedCommittedChange & { kind?: "file" | "folder" }>, options: FollowOptions = {}): Promise<FollowedChange> {
  const covered = (change: SharedCommittedChange, outcome: TransitionOutcome) => outcome.from === change.from && outcome.to === change.to;
  const mine: TransitionOutcome[] = [];
  const awaiting: string[] = [];
  const extra: string[] = [];
  /** Splits `changes` into what `drained` covered (added to `mine`) and what it did not. */
  const split = (changes: typeof committed, drained: DrainResult) => {
    const rest: typeof committed = [];
    for (const change of changes) {
      const hits = drained.outcomes.filter((outcome) => covered(change, outcome));
      if (hits.length) mine.push(...hits); else rest.push(change);
    }
    return rest;
  };
  let uncovered = split(committed, await drainSharedRecordTransitions(notebook, { ...options, own: committed }));
  if (uncovered.length) {
    // Remembered before the host is asked: the row can be recorded and announced while this reads, and it is this user's move.
    expectChanges(notebook, uncovered);
    const marker = sharedNotebookMarker(notebook);
    const config = options.config === undefined ? collabHostConfig() : options.config;
    let manifest = marker?.projectId && config ? await readManifest(notebook, marker.projectId, config) : null;
    if (!manifest) {
      // Whether the server has the change cannot be established: nothing is moved or removed on a guess, and the report says so.
      for (const change of uncovered) extra.push(`records of ${change.from} (the notebook's file list could not be read, so it is not known whether the server has the change)`);
      uncovered = [];
    } else if (manifest.awaiting > 0) {
      for (const change of uncovered) awaiting.push(`records of ${change.from} (waiting for the server to confirm the change)`);
      uncovered = [];
    } else {
      // The server has everything this notebook's list shows, so the log holds it: the row may have been recorded since the first read.
      uncovered = split(uncovered, await drainSharedRecordTransitions(notebook, { ...options, own: committed }));
      // What the log still lacks is a host that does not keep one. A change the manifest no longer shows was rolled back or changed since: its records stay.
      manifest = manifest as Manifest;
      const current = uncovered.filter((change) => manifestShows(change, manifest as Manifest));
      if (current.length) {
        mine.push(...await applyTransitions(notebook, null, current.map((change) => ({ ...(change.fileId ? { fileId: change.fileId } : {}), ...(change.kind ? { kind: change.kind } : {}), from: change.from, to: change.to, explicit: true })), manifest));
      }
      forgetExpected(notebook, (expected) => committed.some((change) => change.from === expected.from && change.to === expected.to && change.fileId === expected.fileId));
    }
  }
  return {
    unfinished: [...mine.flatMap((outcome) => [...outcome.unfinished, ...outcome.pending ?? [], ...outcome.held]), ...extra],
    held: mine.flatMap((outcome) => outcome.held),
    awaiting,
  };
}

/**
 * Before Check Notebook, Try to fix or Acknowledge make their plan (their routes call this): applies the host's
 * pending record moves for a shared notebook, so they judge what this computer holds once the moves it already knows
 * of are followed, not a state the next tree load changes. The check itself stays read-only. Never throws; does
 * nothing for a local notebook, and costs one host call when nothing is pending.
 */
export async function settleSharedRecordsBeforeCheck(notebook: string): Promise<void> {
  try {
    if (typeof notebook !== "string" || !notebook || !sharedNotebookMarker(notebook)) return;
  } catch {
    return;
  }
  await drainSharedRecordTransitions(notebook).catch(() => undefined);
}
