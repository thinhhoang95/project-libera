"use client";

import { apiRequest } from "@/components/libera/api-client";
import { registerStateFlusher, stateRequestKeepalive } from "@/components/libera/deferred-save";
import { diffTexts } from "@/lib/text-hunks";
import type { AgentReviewFile, AgentReviewRevertResult } from "@/lib/agent/types";

/* Manual review in the window: the files with agent changes to review, kept
 * in step with the server (src/lib/agent/review-store.ts). Editors show a
 * file's pending changes as the difference between its baseline and their
 * text, and report back when the user's decisions (or typing) move the
 * baseline. The AI panel lists the files and accepts or rejects whole files. */

type Listener = () => void;

const BASELINE_DELAY_MS = 400;

let files = new Map<string, AgentReviewFile>();
let version = 0;
const listeners = new Set<Listener>();
/** Editors that compute baselines lazily (Visual) flush them before whole-file decisions. */
const flushers = new Map<string, Set<() => void>>();
/** Baselines not yet sent, and those on their way: a refresh must not replace them with older ones. */
const unsent = new Map<string, { baseline: string; timer?: ReturnType<typeof setTimeout> }>();
const sending = new Map<string, Promise<void>>();
let refreshing: Promise<void> | null = null;
let loaded = false;
let refreshAgain = false;
let error = "";
let unregisterPersistence: (() => void) | undefined;

function notify() {
  version++;
  for (const listener of [...listeners]) listener();
}

async function send(path: string, baseline: string) {
  const previous = sending.get(path) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(async () => {
    const file = files.get(path);
    if (!file) return;
    try {
      const body = JSON.stringify({ action: "baseline", path, baseline, revision: file.revision });
      const { pending, revision } = await apiRequest<{ pending: boolean; revision?: string }>("/api/agent/review", { method: "POST", body, keepalive: stateRequestKeepalive(body) });
      const local = files.get(path);
      if (local && revision) { files.set(path, { ...local, revision }); notify(); }
      // The file on disk is its baseline again: nothing is left to review.
      if (!pending && files.get(path)?.baseline === baseline && !unsent.has(path)) {
        files.delete(path);
        notify();
      }
    } catch (cause) {
      // Keep failed reports pending. Whole-file rejection must never fall back
      // to an older server baseline after losing the user's edits in transit.
      if (!unsent.has(path)) unsent.set(path, { baseline });
      error = cause instanceof Error ? cause.message : "Could not save the review baseline.";
      notify();
      throw cause;
    }
  });
  sending.set(path, task);
  try { await task; }
  finally { if (sending.get(path) === task) sending.delete(path); }
}

function sendNow(path: string) {
  const queued = unsent.get(path);
  if (!queued) return sending.get(path) ?? Promise.resolve();
  clearTimeout(queued.timer);
  unsent.delete(path);
  return send(path, queued.baseline);
}

export const agentReviewStore = {
  /** Changes on every update; for useSyncExternalStore. */
  version: () => version,
  subscribe(listener: Listener) {
    listeners.add(listener);
    // The first editor or list to look loads the review state.
    if (!unregisterPersistence) unregisterPersistence = registerStateFlusher(() => agentReviewStore.flush([...files.keys()]));
    if (!loaded) void agentReviewStore.refresh();
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        void agentReviewStore.flush([...files.keys()]).catch(() => undefined);
        unregisterPersistence?.();
        unregisterPersistence = undefined;
      }
    };
  },
  get: (path: string) => files.get(path),
  list: () => [...files.values()],
  error: () => error,

  /** Loads the files under review from the server. */
  refresh() {
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => {
      try {
        do {
          refreshAgain = false;
          const started = version;
          const { files: received } = await apiRequest<{ files: AgentReviewFile[] }>("/api/agent/review");
          // A decision or a baseline acknowledgement happened after this GET
          // started. Its response cannot resurrect the older review state.
          if (started !== version) { refreshAgain = true; continue; }
          const next = new Map(received.map((file) => [file.path, file]));
          // Keep baselines this window has not sent yet, or is sending.
          for (const path of new Set([...unsent.keys(), ...sending.keys()])) {
            const local = files.get(path);
            const file = next.get(path);
            if (local && sending.has(path)) next.set(path, { ...(file ?? local), baseline: local.baseline, revision: local.revision });
            else if (local && file && local.revision === file.revision) next.set(path, { ...file, baseline: local.baseline });
            else if (!sending.has(path)) {
              clearTimeout(unsent.get(path)?.timer);
              unsent.delete(path);
            }
          }
          const changed = next.size !== files.size || [...next].some(([path, file]) => {
            const known = files.get(path);
            return !known || known.baseline !== file.baseline || known.current !== file.current || known.created !== file.created || known.revision !== file.revision;
          });
          files = next;
          loaded = true;
          if (changed) notify();
        } while (refreshAgain);
      } catch { /* Keep what we have; the next refresh tries again. */ }
      finally { refreshing = null; }
    })();
    return refreshing;
  },

  /** An editor moved a file's baseline (decisions, or the user's own edits outside the agent's changes). */
  setBaseline(path: string, baseline: string) {
    const file = files.get(path);
    if (!file || file.baseline === baseline) return;
    files.set(path, { ...file, baseline });
    const queued = unsent.get(path);
    if (queued) clearTimeout(queued.timer);
    unsent.set(path, { baseline, timer: setTimeout(() => void sendNow(path).catch(() => undefined), BASELINE_DELAY_MS) });
    notify();
  },

  /** Lets an editor bring its baseline up to date before a whole-file decision. */
  registerFlusher(path: string, flush: () => void) {
    const set = flushers.get(path) ?? new Set();
    set.add(flush);
    flushers.set(path, set);
    return () => {
      set.delete(flush);
      if (!set.size && flushers.get(path) === set) flushers.delete(path);
    };
  },

  async flush(paths: string[]) {
    for (const path of paths) for (const flush of flushers.get(path) ?? []) flush();
    do {
      await Promise.all(paths.map(sendNow));
    } while (paths.some((path) => unsent.has(path) || sending.has(path)));
    if (error) { error = ""; notify(); }
  },

  /** Accept every change in these files. */
  async keep(paths: string[]) {
    await agentReviewStore.flush(paths);
    const expected = expectations(paths);
    await apiRequest("/api/agent/review", { method: "POST", body: JSON.stringify({ action: "keep", paths: Object.keys(expected), expected }) });
    for (const path of Object.keys(expected)) {
      clearTimeout(unsent.get(path)?.timer);
      unsent.delete(path);
      files.delete(path);
    }
    notify();
  },

  /** Reject every change in these files: each gets its baseline back on disk. */
  async revert(paths: string[]) {
    await agentReviewStore.flush(paths);
    const baselines = Object.fromEntries(paths.flatMap((path) => {
      const file = files.get(path);
      return file ? [[path, file.baseline]] : [];
    }));
    const expected = expectations(paths);
    const { results } = await apiRequest<{ results: AgentReviewRevertResult[] }>("/api/agent/review", { method: "POST", body: JSON.stringify({ action: "revert", paths: Object.keys(expected), baselines, expected }) });
    for (const result of results) if (result.status !== "conflict") {
      clearTimeout(unsent.get(result.path)?.timer);
      unsent.delete(result.path);
      files.delete(result.path);
    }
    notify();
    return results;
  },
};

function expectations(paths: string[]) {
  return Object.fromEntries(paths.flatMap((path) => {
    const file = files.get(path);
    return file ? [[path, { revision: file.revision, current: file.current }]] : [];
  }));
}

/** Exact text differences, including changes to the final newline. */
export function reviewTextHunks(baseline: string, text: string) {
  const hunks = diffTexts(baseline, text);
  let restored = text;
  for (const hunk of [...hunks].reverse()) restored = restored.slice(0, hunk.fromB) + baseline.slice(hunk.fromA, hunk.toA) + restored.slice(hunk.toB);
  if (restored === baseline) return hunks;
  // diffTexts compares complete lines and can omit a final newline change.
  let start = 0;
  while (start < baseline.length && start < text.length && baseline[start] === text[start]) start++;
  let endA = baseline.length, endB = text.length;
  while (endA > start && endB > start && baseline[endA - 1] === text[endB - 1]) { endA--; endB--; }
  return [{ fromA: start, toA: endA, fromB: start, toB: endB }];
}

/** Lines added and removed between a file's baseline and `text`. */
export function reviewLineCounts(baseline: string, text: string) {
  let added = 0;
  let removed = 0;
  const lines = (value: string) => (value ? value.split("\n").length - (value.endsWith("\n") ? 1 : 0) : 0);
  for (const hunk of reviewTextHunks(baseline, text)) {
    added += lines(text.slice(hunk.fromB, hunk.toB));
    removed += lines(baseline.slice(hunk.fromA, hunk.toA));
  }
  return { added, removed };
}
