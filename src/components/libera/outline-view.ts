"use client";

// Which view the Outlines panel shows: the document's outline or its
// definitions. Remembered per browser, and switchable from elsewhere (the
// command palette) while the panel is open or before it mounts.

export type OutlinePanelView = "outline" | "definitions";

const OUTLINE_VIEW_STORAGE_KEY = "libera.outlinePanelView";
export const OUTLINE_VIEW_EVENT = "libera:outline-view";

export function readStoredOutlineView(): OutlinePanelView {
  try {
    return window.localStorage.getItem(OUTLINE_VIEW_STORAGE_KEY) === "definitions" ? "definitions" : "outline";
  } catch { return "outline"; }
}

export function storeOutlineView(view: OutlinePanelView) {
  try { window.localStorage.setItem(OUTLINE_VIEW_STORAGE_KEY, view); } catch { /* A convenience only. */ }
}

/** Switches the Outlines panel to a view, now or when it next opens. */
export function showOutlineView(view: OutlinePanelView) {
  storeOutlineView(view);
  window.dispatchEvent(new CustomEvent<OutlinePanelView>(OUTLINE_VIEW_EVENT, { detail: view }));
}
