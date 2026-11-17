"use client";

import { useState, useSyncExternalStore } from "react";
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
let revision = 0;

/**
 * A counter that moves when any open tab's text may have changed. Components
 * that do not re-render with drafts but show something computed from one
 * subscribe to it (useDraftRevision) instead of receiving the tabs.
 */
export const draftRevision = {
  subscribe(listener: () => void) {
    revisionListeners.add(listener);
    return () => { revisionListeners.delete(listener); };
  },
  getSnapshot: () => revision,
  bump() {
    revision += 1;
    for (const listener of [...revisionListeners]) listener();
  },
};

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
