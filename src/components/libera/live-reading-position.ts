import { useCallback, useSyncExternalStore } from "react";

// Where each tab is being read right now: the Markdown heading line and the PDF
// page. While the user scrolls these change every few frames, and storing each
// one in the root tab state would re-render the whole app shell. The stored
// view state only hears about them when scrolling pauses; the few places that
// show the current position (the outline, the page indicator) read it here, and
// a change wakes only the subscribers of that tab.

type LivePosition = { line?: number; page?: number };

const positions = new Map<string, LivePosition>();
const listeners = new Map<string, Set<() => void>>();

function notify(tabId: string) {
  for (const listener of listeners.get(tabId) ?? []) listener();
}

function subscribeTo(tabId: string, listener: () => void) {
  let set = listeners.get(tabId);
  if (!set) listeners.set(tabId, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size && listeners.get(tabId) === set) listeners.delete(tabId);
  };
}

function write(tabId: string, key: keyof LivePosition, value: number | undefined) {
  const current = positions.get(tabId);
  if (current?.[key] === value) return;
  const next = { ...current, [key]: value };
  if (next.line === undefined && next.page === undefined) positions.delete(tabId);
  else positions.set(tabId, next);
  notify(tabId);
}

export function setLiveMarkdownLine(tabId: string, line: number | undefined) {
  write(tabId, "line", line);
}

export function setLivePdfPage(tabId: string, page: number | undefined) {
  write(tabId, "page", page);
}

export function getLiveMarkdownLine(tabId: string | null | undefined) {
  return tabId ? positions.get(tabId)?.line : undefined;
}

export function getLivePdfPage(tabId: string | null | undefined) {
  return tabId ? positions.get(tabId)?.page : undefined;
}

/** Drops a tab's live position (the tab closed or its view went away): the stored one is the truth again. */
export function clearLiveReadingPosition(tabId: string) {
  if (positions.delete(tabId)) notify(tabId);
}

const noSubscribe = () => () => {};
const noValue = () => undefined;

function useTabSubscription(tabId: string | null | undefined) {
  return useCallback((listener: () => void) => (tabId ? subscribeTo(tabId, listener) : noSubscribe()), [tabId]);
}

export function useLiveMarkdownLine(tabId: string | null | undefined) {
  return useSyncExternalStore(useTabSubscription(tabId), () => getLiveMarkdownLine(tabId), noValue);
}

export function useLivePdfPage(tabId: string | null | undefined) {
  return useSyncExternalStore(useTabSubscription(tabId), () => getLivePdfPage(tabId), noValue);
}
