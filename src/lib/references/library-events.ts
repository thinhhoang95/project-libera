// Server-side notices about reference libraries, for listeners in this
// process: the .bib tether (bib-tether.ts) follows library commits, and
// /api/references/events streams them to open windows so a change made on
// the server (a tethered file edited elsewhere) shows without a reload.
// Storage publishes; it never imports the listeners.

import type { TetherStatus } from "./bib-tether-types";

export type ReferenceServerEvent =
  | { type: "library"; notebook: string; revision: number }
  | { type: "tether"; notebook: string; status: TetherStatus | null }
  /** A file or folder moved in Libera (library-relative paths); a tethered file inside follows. Not sent to windows. */
  | { type: "moved"; from: string; to: string };

type Listener = (event: ReferenceServerEvent) => void;

const LISTENERS = Symbol.for("libera.referenceServerEvents");
const holder = globalThis as { [LISTENERS]?: Set<Listener> };
const listeners = holder[LISTENERS] ??= new Set();

export function publishReferenceEvent(event: ReferenceServerEvent) {
  for (const listener of [...listeners]) {
    try { listener(event); } catch (error) { console.error("[references] A library listener failed:", error); }
  }
}

/** Returns the unsubscribe function. */
export function subscribeReferenceEvents(listener: Listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
