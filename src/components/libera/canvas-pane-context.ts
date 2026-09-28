"use client";

import { createContext, useContext } from "react";

// Whether the surrounding canvas pane is the focused one. Window-level shortcuts
// inside a pane (find, delete annotation, save) only act for the focused pane so
// split views never respond twice. Defaults to true outside a split canvas.
export const CanvasPaneFocusContext = createContext(true);

export function useCanvasPaneFocused() {
  return useContext(CanvasPaneFocusContext);
}
