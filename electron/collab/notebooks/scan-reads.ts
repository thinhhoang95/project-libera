// The read side of a notebook scan: one in-flight read per path, how long a
// changed file must stay quiet before it is imported, how much one scan may
// read, and the back-off for a walk that cannot finish.

import { readIfExists, SLOW_READ, statIfExists } from "./fs-ops";

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

/**
 * Reads of different paths that may be outstanding at once in one notebook (a
 * timed-out read keeps running). The count is per notebook: a stalled provider
 * under one notebook must not make the scans of the others defer forever.
 */
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

/** Reads of callers that name no notebook share this pool. */
const SHARED_POOL = {};
const pools = new WeakMap<object, Map<string, Flight>>();

function poolOf(owner: object): Map<string, Flight> {
  let pool = pools.get(owner);
  if (!pool) {
    pool = new Map();
    pools.set(owner, pool);
  }
  return pool;
}

/**
 * readWithin with one read per path: a read given up on keeps running, and
 * the next scan joins it instead of starting another. The result is used only
 * while the file still has the size and mtime it had when that read began;
 * otherwise this answers SLOW_READ until the old read ends. At most
 * MAX_OUTSTANDING_READS paths are read at a time per `owner` (the notebook).
 */
export async function readShared(absolute: string, ms: number, observed: { size: number; mtimeMs: number }, owner: object = SHARED_POOL): Promise<Buffer | null | typeof SLOW_READ> {
  const flights = poolOf(owner);
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
    // A rewrite that kept the length is invisible to the length check; the
    // stat taken after the read must still be the one the read began under.
    if (bytes && bytes !== SLOW_READ) {
      const after = await statIfExists(absolute);
      if (!after || after.size !== observed.size || after.mtimeMs !== observed.mtimeMs) return SLOW_READ;
    }
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

/** Milliseconds until a file counts as quiet (0: it has not changed for `quietMs`). */
/**
 * How far past `now` a change time may be and still mean "changed just now":
 * a scan takes `now` before it walks, so a file written during the walk is
 * later than that, and file times carry fractions of the millisecond `now`
 * rounds down.
 */
const RECENT_FUTURE_MS = 60_000;

export function quietWaitMs(entry: { mtimeMs: number; ctimeMs?: number }, now: number, quietMs = IMPORT_QUIET_MS): number {
  // An mtime can be anything (a copy keeps its source's; a skewed clock writes
  // a future one), so one in the future says nothing about when it changed.
  const modified = entry.mtimeMs <= now ? entry.mtimeMs : 0;
  // The ctime is this system's own clock: past `now` only because the file
  // changed after `now` was taken, which is as recent as it gets.
  const changed = entry.ctimeMs === undefined || entry.ctimeMs > now + RECENT_FUTURE_MS ? 0 : Math.min(entry.ctimeMs, now);
  return Math.max(0, quietMs - (now - Math.max(modified, changed)));
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
