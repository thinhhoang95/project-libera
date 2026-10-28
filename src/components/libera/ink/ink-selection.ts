"use client";

import { useSyncExternalStore } from "react";
import type { InkLineStyle, InkStroke } from "@/lib/ink/types";

/*
 * The lasso's selection, for the toolbox: which surface has one, how many
 * strokes, and what can be done to them. One selection at a time in a window;
 * selecting on another surface clears the first. The ink clipboard is here
 * too: copied strokes in their surface's units, pasted with a small offset.
 */

export type InkSelectionActions = {
  remove: () => void;
  recolor: (color: `#${string}`) => void;
  restyle: (lineStyle: InkLineStyle) => void;
  copy: () => void;
  clear: () => void;
};

type Snapshot = {
  owner: symbol | null;
  count: number;
  actions: InkSelectionActions | null;
  clipboard: number;
  /** Pastes into the surface last drawn on or selected in. */
  paste: (() => void) | null;
};

let snapshot: Snapshot = { owner: null, count: 0, actions: null, clipboard: 0, paste: null };
let clipboard: InkStroke[] = [];
let pasteOwner: symbol | null = null;
const listeners = new Set<() => void>();

function publish(next: Snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

export const inkSelection = {
  get: () => snapshot,
  /** A surface now has `count` strokes selected (0 to give up the selection). */
  set(owner: symbol, count: number, actions: InkSelectionActions) {
    if (snapshot.owner && snapshot.owner !== owner && count) snapshot.actions?.clear();
    if (!count && snapshot.owner !== owner) return;
    publish({ ...snapshot, owner: count ? owner : null, count, actions: count ? actions : null, clipboard: clipboard.length });
  },
  setPasteTarget(owner: symbol, paste: () => void) {
    pasteOwner = owner;
    if (snapshot.paste !== paste) publish({ ...snapshot, paste });
  },
  release(owner: symbol) {
    const next = { ...snapshot };
    if (snapshot.owner === owner) Object.assign(next, { owner: null, count: 0, actions: null });
    if (pasteOwner === owner) {
      pasteOwner = null;
      next.paste = null;
    }
    publish(next);
  },
  copy(strokes: InkStroke[]) {
    clipboard = strokes;
    publish({ ...snapshot, clipboard: strokes.length });
  },
  clipboard: () => clipboard,
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const EMPTY: Snapshot = { owner: null, count: 0, actions: null, clipboard: 0, paste: null };

export function useInkSelection() {
  return useSyncExternalStore(subscribe, inkSelection.get, () => EMPTY);
}
