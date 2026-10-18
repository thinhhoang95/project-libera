// Access to `window.liberaCollab` (electron/preload.cjs). It is absent in a
// plain browser or `next dev` without Electron, and every caller must work
// without it: the UI then shows what the HTTP routes return and stays static.

import type { HostEvent, LiberaCollabBridge } from "@/lib/collab/local-api";

type WindowWithCollab = Window & { liberaCollab?: LiberaCollabBridge };

export function getCollabBridge(): LiberaCollabBridge | null {
  if (typeof window === "undefined") {
    return null;
  }
  return (window as WindowWithCollab).liberaCollab ?? null;
}

/** Subscribes to host events; a no-op without the bridge. */
export function subscribeHostEvents(listener: (event: HostEvent) => void): () => void {
  const bridge = getCollabBridge();
  if (!bridge) {
    return () => {};
  }
  try {
    return bridge.onEvent(listener);
  } catch {
    return () => {};
  }
}

/** Asks the host to reconnect now; a no-op without the bridge. */
export function nudgeHost(): void {
  try {
    getCollabBridge()?.nudge();
  } catch {
    // The host may be restarting; the next status event tells the story.
  }
}
