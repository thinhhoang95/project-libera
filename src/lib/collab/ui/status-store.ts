// One shared copy of the host status for every collaboration widget: the rail
// button, the notebook badges and the dialogs all read it, so the status is
// fetched once and then kept current by `status` host events instead of each
// component polling on its own.

import type { HostEvent, HostStatus, LocalProject } from "@/lib/collab/local-api";
import { collabClient, describeError, isCollabDisabledError, type CollabClient } from "./client";
import { getCollabBridge, subscribeHostEvents } from "./bridge";

export type CollabPhase =
  /** The first status request has not answered yet. */
  | "loading"
  | "ready"
  /** Collaboration is off on this device; every collaboration control is hidden. */
  | "disabled"
  /** The local routes answered with an error; the UI offers a retry. */
  | "error";

export interface CollabSnapshot {
  phase: CollabPhase;
  status: HostStatus | null;
  error?: string;
}

export interface CollabStatusStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): CollabSnapshot;
  refresh(): Promise<void>;
  /** Re-reads only the project list (after share, join, leave or a project-changed event). */
  refreshProjects(): Promise<void>;
  /**
   * Shows a status the caller already has (e.g. the sign-in response) at once,
   * then confirms it with a fresh request: the response may be older than a
   * status event that already arrived.
   */
  setStatus(status: HostStatus): void;
}

export interface CollabStatusStoreOptions {
  client?: CollabClient;
  subscribeEvents?: (listener: (event: HostEvent) => void) => () => void;
  /** Whether live events exist; without them the store polls. */
  hasLiveEvents?: () => boolean;
  /** Poll interval when there are no live events. 0 turns polling off. */
  pollMs?: number;
  /** First retry delay after a failed request (doubles up to 30 s). 0 turns retries off. */
  retryMs?: number;
}

const INITIAL: CollabSnapshot = { phase: "loading", status: null };

export function createCollabStatusStore(options: CollabStatusStoreOptions = {}): CollabStatusStore {
  const client = options.client ?? collabClient;
  const subscribeEvents = options.subscribeEvents ?? subscribeHostEvents;
  const hasLiveEvents = options.hasLiveEvents ?? (() => Boolean(getCollabBridge()));
  const pollMs = options.pollMs ?? 30_000;
  const retryBaseMs = options.retryMs ?? 2_000;

  let snapshot: CollabSnapshot = INITIAL;
  const listeners = new Set<() => void>();
  let stopEvents: (() => void) | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = retryBaseMs;
  let stopFocus: (() => void) | null = null;
  // Responses can land out of order (a slow GET after a status event);
  // only the newest request may write.
  let requestSeq = 0;

  function emit(next: CollabSnapshot) {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }

  // Status events are the newest truth: apply them and cancel any request in flight.
  function applyStatus(status: HostStatus) {
    requestSeq += 1;
    clearRetry();
    emit({ phase: "ready", status });
  }

  function setStatus(status: HostStatus) {
    applyStatus(status);
    void refresh();
  }

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    retryDelay = retryBaseMs;
  }

  // A failed request is retried with backoff even when live events exist:
  // the first request can fail before the local app session exists (401 on
  // the login screen), and nothing else would ever ask again.
  function scheduleRetry() {
    if (retryBaseMs <= 0 || retryTimer || listeners.size === 0) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryDelay = Math.min(retryDelay * 2, 30_000);
      void refresh();
    }, retryDelay);
  }

  async function refresh() {
    const seq = ++requestSeq;
    try {
      const status = await client.status();
      if (seq === requestSeq) {
        clearRetry();
        emit({ phase: "ready", status });
      }
    } catch (error) {
      if (seq !== requestSeq) return;
      if (isCollabDisabledError(error)) {
        stopPolling();
        emit({ phase: "disabled", status: null });
      } else {
        // Keep the last known status so badges do not flicker away on a blip.
        emit({ phase: snapshot.status ? "ready" : "error", status: snapshot.status, error: describeError(error) });
        scheduleRetry();
      }
    }
  }

  async function refreshProjects() {
    if (!snapshot.status) {
      await refresh();
      return;
    }
    try {
      const projects: LocalProject[] = await client.projects();
      if (snapshot.status) emit({ ...snapshot, status: { ...snapshot.status, projects } });
    } catch {
      await refresh();
    }
  }

  function handleEvent(event: HostEvent) {
    if (event.t === "status") {
      applyStatus(event.status);
    } else if (event.t === "project-changed") {
      void refreshProjects();
    }
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function start() {
    stopEvents = subscribeEvents(handleEvent);
    if (typeof window !== "undefined") {
      // Coming back to the window (or logging in, which focuses it) is a good
      // moment to recover from an earlier failure.
      const onFocus = () => {
        if (snapshot.phase === "error" || snapshot.phase === "loading") void refresh();
      };
      window.addEventListener("focus", onFocus);
      stopFocus = () => window.removeEventListener("focus", onFocus);
    }
    void refresh();
    if (pollMs > 0 && !hasLiveEvents()) {
      pollTimer = setInterval(() => {
        if (snapshot.phase !== "disabled") void refresh();
      }, pollMs);
    }
  }

  function stop() {
    stopEvents?.();
    stopEvents = null;
    stopFocus?.();
    stopFocus = null;
    stopPolling();
    clearRetry();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: () => snapshot,
    refresh,
    refreshProjects,
    setStatus,
  };
}

let sharedStore: CollabStatusStore | null = null;

export function getCollabStatusStore(): CollabStatusStore {
  sharedStore ??= createCollabStatusStore();
  return sharedStore;
}

/** Replaces the shared store (tests inject fakes; null recreates the default). */
export function setCollabStatusStore(store: CollabStatusStore | null): void {
  sharedStore = store;
}
