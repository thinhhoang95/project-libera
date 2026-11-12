// The read side of a notebook scan: one in-flight read per path, how long a
// changed file must stay quiet before it is imported, how much one scan may
// read, and the back-off for a walk that cannot finish.

import { readIfExists, SLOW_READ } from "./fs-ops";

/**
 * The collaboration server's default blob limit (server MAX_BLOB_BYTES). The
 * client is never told the configured value, so a larger file is refused
 * before it is read (reading an online-only file downloads it) rather than
 * downloaded and rejected at every scan.
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * A new or changed file whose size, mtime or ctime moved within this long may
 * still be being written by another program. ctime is this machine's own
 * change time, so a writer that restores an old mtime cannot hide behind it.
 */
export const IMPORT_QUIET_MS = 3000;

/** Reads of different paths that may be outstanding at once (a timed-out read keeps running). */
export const MAX_OUTSTANDING_READS = 4;

/** Bytes one scan reads of files it has not shared yet; the rest wait for the next scan. */
export const SCAN_READ_BUDGET_BYTES = 256 * 1024 * 1024;

/** Bytes of new files one scan keeps in memory between reading and sharing them; larger ones are re-read when shared. */
export const FRESH_RETAIN_BYTES = 64 * 1024 * 1024;

/** Longest wait between scans while the walk cannot finish. */
export const MAX_WALK_BACKOFF_MS = 5 * 60_000;

interface Flight {
  promise: Promise<Buffer | null>;
  size: number;
  mtimeMs: number;
}

const flights = new Map<string, Flight>();

/**
 * readWithin with one read per path: a read given up on keeps running, and
 * the next scan joins it instead of starting another. The result is used only
 * while the file still has the size and mtime it had when that read began;
 * otherwise this answers SLOW_READ until the old read ends. At most
 * MAX_OUTSTANDING_READS paths are read at a time.
 */
export async function readShared(absolute: string, ms: number, observed: { size: number; mtimeMs: number }): Promise<Buffer | null | typeof SLOW_READ> {
  let flight = flights.get(absolute);
  if (flight && (flight.size !== observed.size || flight.mtimeMs !== observed.mtimeMs)) return SLOW_READ;
  if (!flight) {
    if (flights.size >= MAX_OUTSTANDING_READS) return SLOW_READ;
    const started: Flight = { promise: readIfExists(absolute), size: observed.size, mtimeMs: observed.mtimeMs };
    flight = started;
    flights.set(absolute, started);
    const finished = () => {
      if (flights.get(absolute) === started) flights.delete(absolute);
    };
    // Also keeps a read given up on from surfacing as an unhandled rejection.
    started.promise.then(finished, finished);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<typeof SLOW_READ>((resolve) => {
    timer = setTimeout(() => resolve(SLOW_READ), ms);
    timer.unref?.();
  });
  try {
    const bytes = await Promise.race([flight.promise, slow]);
    // The file changed while it was read: those bytes are not one version.
    if (bytes && bytes !== SLOW_READ && bytes.byteLength !== observed.size) return SLOW_READ;
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

/** Milliseconds until a file counts as quiet (0: it has not changed for IMPORT_QUIET_MS). */
export function quietWaitMs(entry: { mtimeMs: number; ctimeMs?: number }, now: number): number {
  // A time in the future (a copy from a skewed clock) says nothing about when it changed.
  const modified = entry.mtimeMs <= now ? entry.mtimeMs : 0;
  const changed = entry.ctimeMs !== undefined && entry.ctimeMs <= now ? entry.ctimeMs : 0;
  return Math.max(0, IMPORT_QUIET_MS - (now - Math.max(modified, changed)));
}

interface ScanReadState {
  /** Files refused for their size, so the warning is given once. */
  oversized: Set<string>;
  /** Walks in a row that could not finish. */
  incompleteWalks: number;
  /** No walk is started before this time (an oversized tree). */
  blockedUntil: number;
  warnedTruncated: boolean;
}

const states = new WeakMap<object, ScanReadState>();

/** The per-project scan bookkeeping of the read side. */
export function scanReadState(owner: object): ScanReadState {
  let state = states.get(owner);
  if (!state) {
    state = { oversized: new Set(), incompleteWalks: 0, blockedUntil: 0, warnedTruncated: false };
    states.set(owner, state);
  }
  return state;
}

/** The delay before the next walk after one that stopped at its entry cap: doubling, up to MAX_WALK_BACKOFF_MS. */
export function noteTruncatedWalk(state: ScanReadState, retryMs: number, now: number): number {
  state.incompleteWalks += 1;
  const delay = Math.min(MAX_WALK_BACKOFF_MS, Math.max(1, retryMs) * 2 ** Math.min(20, state.incompleteWalks));
  state.blockedUntil = now + delay;
  return delay;
}
