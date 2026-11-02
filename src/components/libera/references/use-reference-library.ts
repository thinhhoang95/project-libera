"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  REFERENCES_UPDATED_EVENT,
  type ReferenceLibrary,
  type ReferenceLibraryOp,
  type ReferencesUpdatedDetail,
} from "@/lib/references/types";

// One cached library per notebook, shared by every component in this window.
// Changes go through PATCH with the known revision; a conflict is retried once
// against the library the server returned. Every committed change is
// announced with REFERENCES_UPDATED_EVENT here and on a BroadcastChannel, so
// other windows reload that notebook.

const CHANNEL_NAME = "libera-references";
const windowId = globalThis.crypto.randomUUID();

export type ReferenceLibraryState = {
  library: ReferenceLibrary | null;
  loading: boolean;
  error: string | null;
};

type ReferencesMessage = { sender?: string; notebook?: string; revision?: number };

type Store = {
  state: ReferenceLibraryState;
  listeners: Set<() => void>;
  loading: Promise<ReferenceLibrary> | null;
  reloadQueued: boolean;
  /** Changes from this window apply one at a time, so they never conflict with each other. */
  queue: Promise<unknown>;
};

const EMPTY_STATE: ReferenceLibraryState = { library: null, loading: false, error: null };
const stores = new Map<string, Store>();

function storeFor(notebook: string) {
  let store = stores.get(notebook);
  if (!store) {
    store = { state: EMPTY_STATE, listeners: new Set(), loading: null, reloadQueued: false, queue: Promise.resolve() };
    stores.set(notebook, store);
  }
  return store;
}

function setState(notebook: string, patch: Partial<ReferenceLibraryState>) {
  const store = storeFor(notebook);
  store.state = { ...store.state, ...patch };
  for (const listener of store.listeners) listener();
}

/** Keep the newest library: a slow response must not replace a later revision. */
function adopt(notebook: string, library: ReferenceLibrary) {
  const current = storeFor(notebook).state.library;
  if (!current || library.revision >= current.revision) setState(notebook, { library, error: null });
}

async function errorMessage(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON.
  }
  return fallback;
}

/** Load a notebook's library from the server and cache it. */
export function fetchReferenceLibrary(notebook: string): Promise<ReferenceLibrary> {
  const store = storeFor(notebook);
  if (store.loading) return store.loading;
  setState(notebook, { loading: true });
  const request = (async () => {
    try {
      const response = await fetch(`/api/references?notebook=${encodeURIComponent(notebook)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await errorMessage(response, "Could not load references."));
      const { library } = await response.json() as { library: ReferenceLibrary };
      adopt(notebook, library);
      setState(notebook, { loading: false });
      return library;
    } catch (error) {
      setState(notebook, { loading: false, error: error instanceof Error ? error.message : "Could not load references." });
      throw error;
    } finally {
      store.loading = null;
      if (store.reloadQueued) {
        store.reloadQueued = false;
        void fetchReferenceLibrary(notebook).catch(() => undefined);
      }
    }
  })();
  store.loading = request;
  return request;
}

class ConflictError extends Error {
  constructor(message: string, readonly library: ReferenceLibrary) {
    super(message);
  }
}

async function patch(notebook: string, revision: number, ops: ReferenceLibraryOp[]) {
  const response = await fetch("/api/references", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notebook, revision, ops }),
  });
  if (response.status === 409) {
    const body = await response.json().catch(() => ({})) as { error?: string; library?: ReferenceLibrary };
    if (body.library) throw new ConflictError(body.error ?? "The reference library changed in another window.", body.library);
    throw new Error(body.error ?? "The reference library is busy. Try again.");
  }
  if (!response.ok) throw new Error(await errorMessage(response, "Could not save the reference change."));
  return (await response.json() as { library: ReferenceLibrary }).library;
}

function announce(notebook: string, revision: number) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<ReferencesUpdatedDetail>(REFERENCES_UPDATED_EVENT, { detail: { notebook, revision } }));
  }
  if (typeof BroadcastChannel === "undefined") return;
  // Opened per message and closed right away, as annotation sync does.
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.postMessage({ sender: windowId, notebook, revision } satisfies ReferencesMessage);
  channel.close();
}

/**
 * Apply ops to a notebook's library at the revision this window knows. On a
 * revision conflict the ops are re-applied once to the server's newer
 * library; a second conflict throws.
 */
export function applyReferenceOps(notebook: string, ops: ReferenceLibraryOp[]): Promise<ReferenceLibrary> {
  const store = storeFor(notebook);
  const run = store.queue.catch(() => undefined).then(async () => {
    const known = store.state.library ?? await fetchReferenceLibrary(notebook);
    let library: ReferenceLibrary;
    try {
      library = await patch(notebook, known.revision, ops);
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      adopt(notebook, error.library);
      try {
        library = await patch(notebook, error.library.revision, ops);
      } catch (retryError) {
        if (retryError instanceof ConflictError) {
          adopt(notebook, retryError.library);
          throw new Error(retryError.message);
        }
        throw retryError;
      }
    }
    const previousRevision = storeFor(notebook).state.library?.revision;
    adopt(notebook, library);
    if (library.revision !== previousRevision) announce(notebook, library.revision);
    return library;
  });
  store.queue = run;
  return run;
}

// ---------------------------------------------------------------------------
// Cross-window sync
// ---------------------------------------------------------------------------

let channel: BroadcastChannel | null = null;
let subscriberCount = 0;

/** Another window, or another module in this one, changed a library this window shows. */
function reloadIfNewer(notebook: unknown, revision: unknown) {
  if (typeof notebook !== "string") return;
  const store = stores.get(notebook);
  if (!store || !store.listeners.size) return;
  const known = store.state.library?.revision;
  if (typeof revision === "number" && known !== undefined && revision <= known) return;
  if (store.loading) { store.reloadQueued = true; return; }
  void fetchReferenceLibrary(notebook).catch(() => undefined);
}

function receiveMessage(event: MessageEvent<ReferencesMessage>) {
  const message = event.data;
  if (!message || message.sender === windowId) return;
  reloadIfNewer(message.notebook, message.revision);
}

function receiveEvent(event: Event) {
  const detail = (event as CustomEvent<ReferencesUpdatedDetail>).detail;
  reloadIfNewer(detail?.notebook, detail?.revision);
}

function startSync() {
  subscriberCount += 1;
  if (subscriberCount > 1) return;
  if (typeof window !== "undefined") window.addEventListener(REFERENCES_UPDATED_EVENT, receiveEvent);
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener("message", receiveMessage);
  }
}

function stopSync() {
  subscriberCount -= 1;
  if (subscriberCount > 0) return;
  if (typeof window !== "undefined") window.removeEventListener(REFERENCES_UPDATED_EVENT, receiveEvent);
  channel?.close();
  channel = null;
}

function subscribe(notebook: string, listener: () => void) {
  const store = storeFor(notebook);
  store.listeners.add(listener);
  startSync();
  return () => {
    store.listeners.delete(listener);
    stopSync();
  };
}

const noopSubscribe = () => () => undefined;

/** The notebook's library, loaded on first use and kept current across windows. */
export function useReferenceLibrary(notebook: string | null) {
  const subscribeToStore = useCallback(
    (listener: () => void) => notebook ? subscribe(notebook, listener) : noopSubscribe(),
    [notebook],
  );
  const getSnapshot = useCallback(() => notebook ? storeFor(notebook).state : EMPTY_STATE, [notebook]);
  const state = useSyncExternalStore(subscribeToStore, getSnapshot, () => EMPTY_STATE);

  useEffect(() => {
    if (!notebook) return;
    const store = storeFor(notebook);
    if (!store.state.library && !store.loading && !store.state.error) void fetchReferenceLibrary(notebook).catch(() => undefined);
  }, [notebook]);

  const apply = useCallback((ops: ReferenceLibraryOp[]) => {
    if (!notebook) return Promise.reject(new Error("Open a notebook to change its references."));
    return applyReferenceOps(notebook, ops);
  }, [notebook]);
  const reload = useCallback(() => {
    if (!notebook) return Promise.reject(new Error("Open a notebook to load its references."));
    return fetchReferenceLibrary(notebook);
  }, [notebook]);

  return { library: state.library, loading: state.loading || Boolean(notebook && !state.library && !state.error), error: state.error, apply, reload };
}

/** Drop every cached library (tests, sign-out). */
export function resetReferenceLibraryCache() {
  stores.clear();
}
