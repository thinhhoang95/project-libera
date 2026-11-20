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

import { stat } from "node:fs/promises";

import { acknowledgeManifestTransitions, collabHostConfig, listProjectEntries, readManifestTransitions, type HostClientConfig } from "@/lib/collab/host-client";
import type { ManifestTransition } from "@/lib/collab/local-api";
import type { SharedCommittedChange } from "@/lib/collab/shared-outcomes";
import { sharedNotebookMarker } from "@/lib/collab/shared-notebook";
import { getFileType } from "@/lib/storage/file-types";
import { copyFileIfExists, pathExists } from "@/lib/storage/fs-utils";
import { movePathDerivedRecords } from "@/lib/storage/files";
import { deleteReviewPath } from "@/lib/storage/markdown-reviews";
import { followSharedPdfChanges } from "@/lib/storage/pdf-sidecars";
import { filePathFromParts, splitFilePath } from "@/lib/storage/paths";
import { detachReferenceAttachments } from "@/lib/storage/references";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { removeFileSidecars, SIDECAR_KINDS } from "@/lib/storage/sidecars";
import { followSharedAudioChanges } from "@/lib/storage/transcripts";
import { removeFileMetadataPath, removeNotebookPanelExpandedPathPrefix, renameFileMetadataPath, renameNotebookPanelExpandedPathPrefix } from "@/lib/storage/workspace-metadata";
import { rm } from "node:fs/promises";

/** A record written this long after a transition is not the one the transition was about. */
const WRITTEN_AFTER_SLACK_MS = 2_000;
/** A move whose destination has not arrived (a recording or PDF still downloading) is retried for this long. */
const WAITING_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** One move (`to` is the new Libera path) or removal (`to` is null) to apply. From the host's log it has a seq, file ID and time; the shared wrappers make their own without a seq. */
export type FollowTransition = { seq?: number; fileId?: string; kind?: "file" | "folder"; from: string; to: string | null; at?: number };

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
}

type Manifest = { byPath: Map<string, string>; fileIds: Set<string> };

const isFinal = (outcome: TransitionOutcome) => outcome.state === "applied" || outcome.state === "held" || outcome.state === "obsolete";

// ---------------------------------------------------------------------------
// One run at a time per notebook
// ---------------------------------------------------------------------------

type FollowState = {
  tails: Map<string, Promise<unknown>>;
  /** Applied here, acknowledgement not yet confirmed: a later run acknowledges again and does not apply again. */
  applied: Map<string, TransitionOutcome>;
};
const STATE_KEY = Symbol.for("libera.sharedRecordFollow");
const followState = ((globalThis as { [STATE_KEY]?: FollowState })[STATE_KEY] ??= { tails: new Map(), applied: new Map() });

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

/** Records of a file that SIDECAR_KINDS lists and that something else already moves in a shared notebook: the host (ink and transcripts are manifest entries), the PDF reconciliation, or nothing (a waveform cache is made again). */
const SIDECARS_MOVED_ELSEWHERE = new Set(["ink", "transcript", "audio-peaks", "pdf-annotations", "pdf-outline", "pdf-text"]);

/**
 * The records of a renamed shared file that live only on this computer (image
 * annotations, definitions of a note or LaTeX file, and any kind added to
 * SIDECAR_KINDS later), moved with it as a local rename does. Never replaces a
 * record already at the destination. `held`: left where they are (the
 * destination has one, or the record was written after `since`); `failed`: could
 * not move (retried).
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
    if (!kind.appliesTo(fromType) || !kind.appliesTo(toType)) continue;
    const old = kind.filePath(source.notebook, source.pathParts);
    const next = kind.filePath(target.notebook, target.pathParts);
    if (old === next || !(await pathExists(old))) continue;
    try {
      if (kind.layout === "folder") continue;
      if (since !== undefined) {
        const written = await stat(old).then((info) => info.mtimeMs, () => 0);
        if (written > since + WRITTEN_AFTER_SLACK_MS) {
          result.held.push(`${kind.id} of ${from} (written after the file moved, so it may belong to a file now at that path)`);
          continue;
        }
      }
      // Created exclusively, like the Python sidecar's move: a record saved there meanwhile is never replaced.
      await copyFileIfExists(old, next, { exclusive: true });
      await rm(old, { force: true });
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
  if (t.to !== null) await followSharedPdfChanges([{ from: t.from, to: t.to }], []);
  else await followSharedPdfChanges([], [t.from]);
}

/** A recording's local sidecars; the host moved or dropped the companion transcript in the same manifest change. */
async function followAudio(t: FollowTransition) {
  if (t.to !== null) await followSharedAudioChanges([{ from: t.from, to: t.to }], []);
  else await followSharedAudioChanges([], [t.from]);
}

/** Review comments, reference attachments, stars and tags of a file that moved. */
const moveDerivedRecords = (from: string, to: string) => movePathDerivedRecords(from, to);

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
function judge(t: FollowTransition, manifest: Manifest | null): Verdict {
  // The shared wrappers pass no seq: the host has just answered that it committed this change for the file they asked about, which is what they know without the list.
  // A change from the log is never judged without the list (drain waits for it).
  if (!manifest) return t.seq === undefined ? { kind: "own" } : { kind: "hold", why: "the notebook's file list could not be read, so the owner of its records cannot be established" };
  const occupant = manifest.byPath.get(t.from);
  if (occupant !== undefined && t.fileId === undefined) return { kind: "hold", why: "another file is at that path now and this change does not say which file it was" };
  if (occupant !== undefined && occupant !== t.fileId) return { kind: "hold", why: "another file is at that path now, so its records may be that file's" };
  // From the log (it has a file ID): a file listed in the manifest again was not removed after all, and records of a file that is still there are not deleted.
  // The shared wrappers pass no seq: the host has just answered that it removed the file.
  if (t.to === null && t.seq !== undefined && t.fileId !== undefined && manifest.fileIds.has(t.fileId)) return { kind: "obsolete" };
  return { kind: "own" };
}

const isFolder = (t: FollowTransition) => t.kind === "folder";

/** Every step for one transition. Returns what was left alone and what failed. */
async function applyOne(t: FollowTransition, verdict: Verdict): Promise<TransitionOutcome> {
  const outcome: TransitionOutcome = { ...(t.seq === undefined ? {} : { seq: t.seq }), ...(t.fileId === undefined ? {} : { fileId: t.fileId }), from: t.from, to: t.to, state: "applied", held: [], unfinished: [] };
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
    await attempt("review comments, reference attachments or tags", () => moveDerivedRecords(t.from, to));
    // A recording or PDF still on its way keeps its transition until it is there; its notes are copied only to bytes that match.
    if ((type === "audio" || type === "pdf") && toType === type && !(await arrived(to))) waiting = true;
  } else {
    const parts = splitFilePath(t.from);
    if (type === "audio") await attempt("recording sidecars", () => followAudio(t));
    // This user's, or a collaborator's, deletion: notes on it go too, as in a local notebook.
    if (type === "pdf") await attempt("PDF notes", () => followPdf(t));
    if (type) await attempt("local records", () => removeFileSidecars(parts.notebook, parts.pathParts, type));
    await attempt("review comments", () => deleteReviewPath(t.from));
    await attempt("reference attachments", () => detachReferenceAttachments(t.from));
    await attempt("stars and tags", () => removeFileMetadataPath(t.from));
  }
  notifySearchChanges(t.to === null ? [t.from] : [t.from, t.to]);
  if (outcome.unfinished.length) return { ...outcome, state: "unfinished" };
  if (waiting && !(t.at !== undefined && Date.now() - t.at > WAITING_TTL_MS)) return { ...outcome, state: "waiting" };
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
    else if (a.to !== null && b.from === a.to) after[i].add(j);
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
      try { outcome = await applyOne(t, judge(t, manifest)); }
      catch (error) {
        console.error(`[shared-record-follow] ${t.from}:`, error);
        outcome = { ...(t.seq === undefined ? {} : { seq: t.seq }), ...(t.fileId === undefined ? {} : { fileId: t.fileId }), from: t.from, to: t.to, state: "unfinished", held: [], unfinished: [`records of ${t.from}`] };
      }
      if (outcome.state === "unfinished" && t.fileId !== undefined) failedFiles.add(t.fileId);
      if (isFinal(outcome) && t.seq !== undefined && projectId) followState.applied.set(`${projectId}:${t.seq}`, outcome);
      results.set(t, outcome);
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
    for (const entry of result.entries) {
      byPath.set(`${notebook}/${entry.path}`, entry.fileId);
      fileIds.add(entry.fileId);
    }
    return { byPath, fileIds };
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
    unfinished: outcomes.flatMap((outcome) => outcome.unfinished),
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
  const result = await drain(notebook, options);
  noteDrained(notebook, result);
  return result;
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
  const outcomes = await applyTransitions(notebook, marker.projectId, transitions, manifest);
  const done = outcomes.filter(isFinal).map((outcome) => outcome.seq).filter((seq): seq is number => seq !== undefined);
  let error: string | undefined;
  if (done.length) {
    try {
      await acknowledgeManifestTransitions(marker.projectId, { seqs: done }, config);
      for (const seq of done) followState.applied.delete(`${marker.projectId}:${seq}`);
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
}

/**
 * The records on this computer follow a change the host has just committed:
 * the moves and removals in `committed` (Libera paths; `fileId` when known,
 * which is what ties a record to the file and not to the path). The host's log
 * is applied first, so the change is applied as the log has it; a change the log
 * does not hold (a host that does not keep one, a failed read) is applied from
 * `committed` through the same steps. Nothing here can undo the host's change:
 * every step runs, and what stayed behind is returned, never thrown.
 */
export async function followCommittedChange(notebook: string, committed: Array<SharedCommittedChange & { kind?: "file" | "folder" }>, options: FollowOptions = {}): Promise<FollowedChange> {
  const drained = await drainSharedRecordTransitions(notebook, options);
  const covered = (change: SharedCommittedChange, outcome: TransitionOutcome) => outcome.from === change.from && outcome.to === change.to;
  const mine: TransitionOutcome[] = [];
  const uncovered: Array<FollowTransition> = [];
  for (const change of committed) {
    const hits = drained.outcomes.filter((outcome) => covered(change, outcome));
    if (hits.length) mine.push(...hits);
    else uncovered.push({ ...(change.fileId ? { fileId: change.fileId } : {}), ...(change.kind ? { kind: change.kind } : {}), from: change.from, to: change.to });
  }
  if (uncovered.length) {
    const marker = sharedNotebookMarker(notebook);
    const config = options.config === undefined ? collabHostConfig() : options.config;
    const manifest = marker?.projectId && config ? await readManifest(notebook, marker.projectId, config) : null;
    mine.push(...await applyTransitions(notebook, null, uncovered, manifest));
  }
  return {
    unfinished: mine.flatMap((outcome) => [...outcome.unfinished, ...outcome.held]),
    held: mine.flatMap((outcome) => outcome.held),
  };
}
