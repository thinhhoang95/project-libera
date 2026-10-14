"use client";

import { useEffect, useSyncExternalStore } from "react";
import { apiRequest } from "@/components/libera/api-client";
import type { SearchIndexStatus, SearchQueryPart } from "@/lib/global-search";

/**
 * State shared by the Search page and its left panel: the index status (polled
 * while either is on screen), recent searches, and a search the panel asks the
 * page to run.
 */

export type RecentSearch = { parts: SearchQueryPart[]; label: string; at: number };

type SearchStoreState = {
  status: SearchIndexStatus | null;
  statusError: string;
  recent: RecentSearch[];
};

const RECENT_STORAGE_KEY = "libera.globalSearch.recent";
const MAX_RECENT = 12;
const BUSY_POLL_MS = 1_500;
const IDLE_POLL_MS = 10_000;

let state: SearchStoreState = { status: null, statusError: "", recent: [] };
let recentLoaded = false;
const listeners = new Set<() => void>();

function setState(patch: Partial<SearchStoreState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function loadRecent() {
  if (recentLoaded || typeof window === "undefined") return;
  recentLoaded = true;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_STORAGE_KEY) ?? "[]") as RecentSearch[];
    if (Array.isArray(parsed)) state = { ...state, recent: parsed.filter((item) => Array.isArray(item?.parts)).slice(0, MAX_RECENT) };
  } catch {
    // Recent searches are a convenience.
  }
}

export function useSearchStore() {
  loadRecent();
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export function searchQueryLabel(parts: SearchQueryPart[]) {
  return parts
    .map((part) => (part.type === "text" ? part.text : `[${part.image.name}]`))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** Remember a search. Pasted images are too large to keep, so those searches keep only their words. */
export function rememberSearch(parts: SearchQueryPart[]) {
  const kept = parts.filter((part) => part.type === "text" || part.image.kind !== "upload");
  const label = searchQueryLabel(kept);
  if (!label) return;

  const recent = [{ parts: kept, label, at: Date.now() }, ...state.recent.filter((item) => item.label !== label)].slice(0, MAX_RECENT);
  setState({ recent });
  try {
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(recent));
  } catch {
    // Storage may be unavailable.
  }
}

export function forgetRecentSearches() {
  setState({ recent: [] });
  try {
    window.localStorage.removeItem(RECENT_STORAGE_KEY);
  } catch {
    // Storage may be unavailable.
  }
}

const searchRequestHandlers = new Set<(parts: SearchQueryPart[]) => void>();

/** Ask the Search page to put these parts in its box and search. */
export function requestSearch(parts: SearchQueryPart[]) {
  searchRequestHandlers.forEach((handler) => handler(parts));
}

/** The Search page listens for searches picked elsewhere, such as a recent search. */
export function onSearchRequest(handler: (parts: SearchQueryPart[]) => void) {
  searchRequestHandlers.add(handler);
  return () => {
    searchRequestHandlers.delete(handler);
  };
}

export async function refreshSearchStatus(scan = false) {
  try {
    const status = await apiRequest<SearchIndexStatus>(`/api/search/status${scan ? "?scan=1" : ""}`);
    setState({ status, statusError: "" });
    return status;
  } catch (error) {
    setState({ statusError: error instanceof Error ? error.message : "Could not read the search index." });
    return null;
  }
}

export async function searchIndexAction(action: "build" | "scan" | "background" | "rebuild" | "reembed" | "pause" | "resume") {
  const status = await apiRequest<SearchIndexStatus>("/api/search/index", {
    method: "POST",
    body: JSON.stringify({ action }),
  });
  setState({ status, statusError: "" });
  return status;
}

let pollers = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  if (!pollers) return;
  const busy = state.status?.state === "scanning" || state.status?.state === "embedding" || state.status?.model.state === "loading";
  pollTimer = setTimeout(async () => {
    await refreshSearchStatus();
    schedulePoll();
  }, busy ? BUSY_POLL_MS : IDLE_POLL_MS);
}

/** Poll the index status while the component is mounted; the first poll also brings the index up to date. */
export function useSearchStatusPolling(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    pollers += 1;
    void refreshSearchStatus(true).then(schedulePoll);
    return () => {
      pollers -= 1;
      if (!pollers && pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };
  }, [enabled]);
}

/** Speed polling up after an action that starts work. */
export function nudgeSearchStatus() {
  void refreshSearchStatus().then(schedulePoll);
}
