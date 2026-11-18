import { compileFind, type FindLimits } from "./index";
import type { FindOptions, FindResult, TextRange } from "./types";

/* Whole-document searches off the main thread (docs/find-replace-patterns-plan.md §6).
 * A JS regex can backtrack catastrophically and cannot be interrupted where it
 * runs, so Regex mode searches run in a worker (find.worker.ts) with a
 * deadline; past it the worker is terminated and the search reports
 * `incomplete`. One runner serves one find bar: a newer search replaces the
 * one in flight, whose promise resolves with null. Without Worker support
 * (tests, server) or after the worker failed to start, searches run here,
 * synchronously. */

export type FindWorkerRequest = { id: number; query: string; options: FindOptions; text: string; within?: TextRange[]; skipped?: TextRange[] };
export type FindWorkerResponse = { id: number; result: FindResult; error?: never } | { id: number; error: string; result?: never };

/** What the runner needs of a Worker (tests pass fakes). */
export type FindWorkerLike = {
  postMessage(message: FindWorkerRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<FindWorkerResponse>) => void) | null;
  onerror: ((event: Event) => void) | null;
};

export const REGEX_SEARCH_DEADLINE_MS = 750;

export type FindSearchRequest = {
  query: string;
  options: FindOptions;
  text: string;
  limits?: Pick<FindLimits, "within" | "skipped">;
};

/** A search's result; `timedOut` when the deadline stopped it (then `incomplete` is true and `matches` empty). */
export type FindSearchOutcome = FindResult & { timedOut?: boolean };

export interface FindSearchRunner {
  /** Resolves with the result, or with null when a newer search, `cancel` or `dispose` replaced it. */
  search(request: FindSearchRequest): Promise<FindSearchOutcome | null>;
  /** Drops the search in flight (its promise resolves with null). */
  cancel(): void;
  dispose(): void;
}

/** The same search on this thread. A query that does not compile finds nothing. */
export function runFindSearch(request: FindSearchRequest): FindResult {
  const compiled = compileFind(request.query, request.options);
  if (!compiled.ok) return { matches: [], incomplete: false };
  return compiled.finder.find(request.text, request.limits);
}

/** The app's search worker, or null where workers are unavailable. */
export function createFindWorker(): FindWorkerLike | null {
  if (typeof window === "undefined" || typeof Worker === "undefined") return null;
  return new Worker(new URL("./find.worker.ts", import.meta.url), { type: "module" }) as unknown as FindWorkerLike;
}

type Running = { id: number; request: FindSearchRequest; resolve: (outcome: FindSearchOutcome | null) => void; timer: ReturnType<typeof setTimeout> };

export function createFindSearchRunner(options: { createWorker?: () => FindWorkerLike | null; deadlineMs?: number } = {}): FindSearchRunner {
  const createWorker = options.createWorker ?? createFindWorker;
  const deadline = options.deadlineMs ?? REGEX_SEARCH_DEADLINE_MS;
  let worker: FindWorkerLike | null = null;
  let unavailable = false;
  let disposed = false;
  let sequence = 0;
  let running: Running | null = null;

  function stopWorker() {
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    worker = null;
  }

  function finish(outcome: FindSearchOutcome | null) {
    const job = running;
    if (!job) return;
    running = null;
    clearTimeout(job.timer);
    job.resolve(outcome);
  }

  function ensureWorker() {
    if (worker || unavailable) return worker;
    try {
      worker = createWorker();
    } catch {
      worker = null;
    }
    if (!worker) { unavailable = true; return null; }
    worker.onmessage = (event) => {
      const data = event.data;
      if (!running || data.id !== running.id) return;
      finish(data.result ? data.result : { matches: [], incomplete: false });
    };
    worker.onerror = () => {
      // The worker could not start or crashed: this and later searches run here.
      console.warn("Find worker failed; searching on the main thread.");
      stopWorker();
      unavailable = true;
      const job = running;
      if (job) finish(runFindSearch(job.request));
    };
    return worker;
  }

  return {
    search(request) {
      if (disposed) return Promise.resolve(null);
      if (running) {
        // The worker is busy with an older search, possibly a runaway regex: start afresh.
        finish(null);
        stopWorker();
      }
      const target = ensureWorker();
      if (!target) return Promise.resolve(runFindSearch(request));
      const id = ++sequence;
      return new Promise<FindSearchOutcome | null>((resolve) => {
        const timer = setTimeout(() => {
          if (running?.id !== id) return;
          stopWorker();
          finish({ matches: [], incomplete: true, timedOut: true });
        }, deadline);
        running = { id, request, resolve, timer };
        try {
          target.postMessage({ id, query: request.query, options: request.options, text: request.text, within: request.limits?.within, skipped: request.limits?.skipped });
        } catch {
          stopWorker();
          unavailable = true;
          finish(runFindSearch(request));
        }
      });
    },
    cancel() {
      if (!running) return;
      finish(null);
      // A cancelled search may still be running: the next one gets a fresh worker.
      stopWorker();
    },
    dispose() {
      disposed = true;
      finish(null);
      stopWorker();
    },
  };
}
