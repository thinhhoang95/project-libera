"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Where a tab's own view puts its controls in the left panel. A contextual
 * rail tab such as Voice Memo has no panel of its own: the left panel shows
 * an empty slot for the active tab, and the tab's view renders its controls
 * into it (a portal), so they share the view's state (the player, the
 * transcript, the recorder) without a store in between.
 */
type Slot = { tabId: string; element: HTMLElement };

let slot: Slot | null = null;
const listeners = new Set<() => void>();

function publish(next: Slot | null) {
  slot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The element to render `tabId`'s controls into, while its rail tab is open. */
export function useRailSlot(tabId: string) {
  return useSyncExternalStore(subscribe, () => (slot?.tabId === tabId ? slot.element : null), () => null);
}

/** The left panel's slot for the active tab's controls. */
export function RailSlot({ tabId, emptyText }: { tabId: string; emptyText: string }) {
  const attach = useCallback((element: HTMLDivElement | null) => {
    if (element) publish({ tabId, element });
    else if (slot?.tabId === tabId) publish(null);
  }, [tabId]);
  return (
    <div
      ref={attach}
      data-empty={emptyText}
      className="flex min-h-0 flex-1 flex-col empty:items-center empty:justify-center empty:px-6 empty:text-center empty:text-xs empty:text-muted-foreground empty:before:content-[attr(data-empty)]"
    />
  );
}
