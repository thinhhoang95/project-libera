"use client";

import { createContext, useContext } from "react";
import type { MathMarkerSettings } from "@/lib/math-markers";

// PDF and image notes sit several memoized layers below the viewer hosts, so
// the configured math markers reach them through context instead of props.
const NoteMathMarkersContext = createContext<MathMarkerSettings | undefined>(undefined);

export const NoteMathMarkersProvider = NoteMathMarkersContext.Provider;

export function useNoteMathMarkers() {
  return useContext(NoteMathMarkersContext);
}
