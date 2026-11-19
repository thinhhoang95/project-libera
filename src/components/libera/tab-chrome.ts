"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import type { OpenTab } from "./types";

/**
 * What the tab strip and the chat panel show of an open tab. The text and the
 * view state are really absent, so a component typed with this cannot read a
 * draft by accident: it asks for the live tabs when the user acts instead.
 */
export type ChromeTab = Omit<OpenTab, "draft" | "saved" | "viewState">;

const OMITTED_FIELDS = new Set<string>(["draft", "saved", "viewState"] satisfies Array<keyof OpenTab>);

function chromeOf(tab: OpenTab): ChromeTab {
  return Object.fromEntries(Object.entries(tab).filter(([key]) => !OMITTED_FIELDS.has(key))) as ChromeTab;
}

function sameFields(a: ChromeTab, b: ChromeTab) {
  const left = Object.entries(a);
  return left.length === Object.keys(b).length
    && left.every(([key, value]) => (b as Record<string, unknown>)[key] === value);
}

/**
 * The chrome of `tabs`, reusing the object in `previous` for every tab whose
 * remaining fields are unchanged, and `previous` itself when no element and no
 * position changed.
 */
export function projectChromeTabs(previous: readonly ChromeTab[], tabs: readonly OpenTab[]): readonly ChromeTab[] {
  const before = new Map(previous.map((tab) => [tab.id, tab]));
  const next = tabs.map((tab) => {
    const fresh = chromeOf(tab);
    const old = before.get(tab.id);
    return old && sameFields(old, fresh) ? old : fresh;
  });
  return next.length === previous.length && next.every((tab, index) => tab === previous[index]) ? previous : next;
}

/**
 * `tabs` without drafts, saved text and view state. Typing, caret reports and
 * scroll positions change those, never the result, so a component that gets it
 * is not woken by them; a name, path, status or order change is.
 */
export function useChromeTabs(tabs: readonly OpenTab[]): readonly ChromeTab[] {
  const [held, setHeld] = useState<readonly ChromeTab[]>(() => projectChromeTabs([], tabs));
  // The projection is a pure function of `tabs`; the state only keeps identities.
  // It is replaced while rendering, and only when the chrome really changed.
  const next = projectChromeTabs(held, tabs);
  if (next !== held) setHeld(next);
  return next;
}

const revisionListeners = new Set<() => void>();
const keyListeners = new Map<string, Set<() => void>>();
const keyRevisions = new Map<string, number>();
let revision = 0;
// Moves with every bump that names no tab; every key follows it.
let allRevision = 0;

/** The key of what a tab's reading position decides, apart from its text (see changedDraftKeys). */
export const viewKey = (tabId: string) => `view:${tabId}`;

/** What the chat's "sent" marks take from a tab's view state (readerPosition in document-chat-panel.tsx). */
function readerSignature(tab: OpenTab) {
  const view = tab.viewState;
  if (!view) return "";
  if (tab.file.fileType === "pdf") return `p${view.pdf?.page}`;
  const state = tab.file.fileType === "markdown" ? view.markdown : tab.file.fileType === "latex" ? view.latex : view.text;
  if (!state) return "";
  if (tab.file.fileType !== "markdown" && state.editorScrollPos !== undefined) return `s${state.editorScrollPos}`;
  return state.line === undefined ? `c${state.selectionStart}` : `l${state.line}`;
}

/**
 * The keys (tab id and file path; viewKey for the reading position) of the
 * tabs whose text, or whatever the live readers take from them, differs between
 * two publications. A caret report or a stored scroll position changes none of
 * the text keys.
 */
export function changedDraftKeys(previous: readonly OpenTab[], next: readonly OpenTab[]): string[] {
  const before = new Map(previous.map((tab) => [tab.id, tab]));
  const keys: string[] = [];
  const touch = (tab: OpenTab) => { keys.push(tab.id, tab.file.path); };
  for (const tab of next) {
    const old = before.get(tab.id);
    before.delete(tab.id);
    if (!old) { touch(tab); keys.push(viewKey(tab.id)); continue; }
    if (old.draft !== tab.draft || old.file !== tab.file || old.untitled !== tab.untitled
      || old.viewState?.pdf?.pageCount !== tab.viewState?.pdf?.pageCount) touch(tab);
    if (old.viewState !== tab.viewState && readerSignature(old) !== readerSignature(tab)) keys.push(viewKey(tab.id));
  }
  for (const tab of before.values()) { touch(tab); keys.push(viewKey(tab.id)); }
  return keys;
}

function subscribeKeys(keys: readonly string[], listener: () => void) {
  for (const key of keys) {
    const set = keyListeners.get(key) ?? new Set();
    set.add(listener);
    keyListeners.set(key, set);
  }
  return () => {
    for (const key of keys) {
      const set = keyListeners.get(key);
      set?.delete(listener);
      if (set && !set.size) keyListeners.delete(key);
    }
  };
}

/**
 * A counter that moves when any open tab's text may have changed. Components
 * that do not re-render with drafts but show something computed from one
 * subscribe to it (useDraftRevision) instead of receiving the tabs. Those that
 * show only some tabs' text subscribe to those tabs' keys (useDraftRevisionFor).
 */
export const draftRevision = {
  subscribe(listener: () => void) {
    revisionListeners.add(listener);
    return () => { revisionListeners.delete(listener); };
  },
  getSnapshot: () => revision,
  /** Everything that follows a draft moved, or only what follows `keys`. */
  bump(keys?: readonly string[]) {
    revision += 1;
    const woken = new Set<() => void>(revisionListeners);
    if (keys) {
      for (const key of keys) {
        keyRevisions.set(key, (keyRevisions.get(key) ?? 0) + 1);
        for (const listener of keyListeners.get(key) ?? []) woken.add(listener);
      }
    } else {
      allRevision += 1;
      for (const set of keyListeners.values()) for (const listener of set) woken.add(listener);
    }
    for (const listener of woken) listener();
  },
  /** Called with each committed `tabs`: bumps only for the tabs that changed (for all of them on the first call). */
  publish(previous: readonly OpenTab[] | null, next: readonly OpenTab[]) {
    if (!previous) { draftRevision.bump(); return; }
    if (previous === next) return;
    const keys = changedDraftKeys(previous, next);
    if (keys.length) draftRevision.bump(keys);
  },
};

const NO_KEYS: readonly string[] = [];
const KEY_SEPARATOR = "\u0000";

function keyRevision(keys: readonly string[]) {
  let total = allRevision;
  for (const key of keys) total += keyRevisions.get(key) ?? 0;
  return total;
}

/** A stable list for `keys`, so the caller may pass a fresh array each render. */
function useKeyList(keys: readonly string[]) {
  const joined = keys.join(KEY_SEPARATOR);
  return useMemo(() => joined ? joined.split(KEY_SEPARATOR) : NO_KEYS, [joined]);
}

/** Re-renders the caller when the text of one of these tabs (by id or path) changed; never when `keys` is empty. */
export function useDraftRevisionFor(keys: readonly string[]) {
  const list = useKeyList(keys);
  const subscribe = useCallback((listener: () => void) => subscribeKeys(list, listener), [list]);
  const snapshot = useCallback(() => keyRevision(list), [list]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** useLiveValue for a value that reads only the tabs under `keys`: other tabs' publications do not call `read`. */
export function useLiveValueFor<T>(keys: readonly string[], read: () => T): T {
  const list = useKeyList(keys);
  const subscribe = useCallback((listener: () => void) => subscribeKeys(list, listener), [list]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Re-renders the caller after every draft publication; see draftRevision. */
export function useDraftRevision() {
  return useSyncExternalStore(draftRevision.subscribe, draftRevision.getSnapshot, draftRevision.getSnapshot);
}

/**
 * A value computed from the live tabs that the caller shows. `read` is called
 * after every draft publication and on each render, and must return the same
 * value (a primitive, or a cached object) while nothing it reads changed; the
 * caller renders only when the value does.
 */
export function useLiveValue<T>(read: () => T): T {
  return useSyncExternalStore(draftRevision.subscribe, read, read);
}

/** The guards of gallery-tabs.ts, recording-tabs.ts and page-tabs.ts for a tab without text. */
export const chromeTabKind = {
  gallery: (tab: ChromeTab) => Boolean(tab.gallery),
  recording: (tab: ChromeTab) => Boolean(tab.recording),
  page: (tab: ChromeTab) => Boolean(tab.page),
};
