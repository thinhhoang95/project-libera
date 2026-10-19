// Coalesce changing UI state without overlapping writes or dropping the newest
// value when a request is in flight. Failed writes remain pending for retry.
export function createDeferredSave(write: (body: string) => Promise<unknown>, onError: (error: unknown) => void = () => {}) {
  let pending: string | undefined;
  let saved: string | undefined;
  let running: Promise<void> | undefined;
  let drainAll = false;
  let lastDelay = 1000;
  let lastMaxWait = 30_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  function clearTimers() {
    clearTimeout(timer); clearTimeout(deadline);
    timer = deadline = undefined;
  }
  async function drain() {
    while (pending !== undefined) {
      const body = pending;
      if (body !== saved) { await write(body); saved = body; }
      if (pending === body) pending = undefined;
      // A normal autosave respects the next batch's delay even if new text
      // arrived during this request. An explicit close flush drains it all.
      if (!drainAll) break;
    }
  }
  function armTimers() {
    timer = setTimeout(() => { void flush(false).catch(() => undefined); }, lastDelay);
    deadline ??= setTimeout(() => { void flush(false).catch(() => undefined); }, lastMaxWait);
  }
  function flush(all = true): Promise<void> {
    clearTimers();
    drainAll ||= all;
    if (!running) {
      let failed = false;
      running = drain().catch((error) => { failed = true; onError(error); throw error; }).finally(() => {
        running = undefined;
        drainAll = false;
        if (!failed && pending !== undefined && timer === undefined) armTimers();
      });
    }
    return running;
  }
  function schedule(value: unknown, delay = 1000, maxWait = 30_000) {
    const body = JSON.stringify(value);
    if (pending === undefined && body === saved) return;
    pending = body;
    lastDelay = delay;
    lastMaxWait = maxWait;
    clearTimeout(timer);
    armTimers();
  }
  return { schedule, flush, markSaved: (value: unknown) => { saved = JSON.stringify(value); } };
}

// Chromium limits keepalive requests to 64 KiB. Larger histories (especially
// photo chats) use a normal request, which Electron waits for before quitting.
export function stateRequestKeepalive(body: string) {
  return !window.liberaPersistence && new Blob([body]).size < 60_000;
}

type Flusher = () => void | Promise<unknown>;
const flushers = new Set<Flusher>();
const finalCaptures = new Set<Flusher>();
let disconnect: (() => void) | undefined;
export async function flushPendingState() {
  const results = await Promise.allSettled([...flushers].map((flush) => {
    try { return Promise.resolve(flush()); }
    catch (error) { return Promise.reject(error); }
  }));
  // A pending review decision can update an editor after its first snapshot.
  // Capture workspaces again once acknowledged writes have applied their result.
  const finalResults = await Promise.allSettled([...finalCaptures].map((flush) => {
    try { return Promise.resolve(flush()); }
    catch (error) { return Promise.reject(error); }
  }));
  const failure = [...results, ...finalResults].find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
export function registerStateFlusher(flush: Flusher, captureAfterWrites = false) {
  flushers.add(flush);
  if (captureAfterWrites) finalCaptures.add(flush);
  if (!disconnect) {
    const onLeave = () => { void flushPendingState().catch(() => undefined); };
    window.addEventListener("beforeunload", onLeave);
    window.addEventListener("pagehide", onLeave);
    const nativeDisconnect = window.liberaPersistence?.onFlush(flushPendingState);
    disconnect = () => {
      window.removeEventListener("beforeunload", onLeave);
      window.removeEventListener("pagehide", onLeave);
      nativeDisconnect?.();
    };
  }
  return () => {
    flushers.delete(flush);
    finalCaptures.delete(flush);
    if (!flushers.size) { disconnect?.(); disconnect = undefined; }
  };
}
