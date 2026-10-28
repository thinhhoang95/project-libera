"use client";

import { useSyncExternalStore } from "react";
import { pdfPaperColor } from "@/lib/pdf-paper-color";
import { useResolvedEditorThemes } from "./use-editor-themes";

// theme-sync.tsx announces light/dark switches, including the system's.
function subscribe(listener: () => void) {
  window.addEventListener("libera:theme-changed", listener);
  return () => window.removeEventListener("libera:theme-changed", listener);
}

const isDark = () => document.documentElement.classList.contains("dark");

/** The PDF paper color for the visual editor's theme and the appearance (pdf-paper-color.ts). */
export function usePdfPaperColor() {
  const theme = useResolvedEditorThemes().visual;
  const dark = useSyncExternalStore(subscribe, isDark, () => false);
  return pdfPaperColor(theme, dark);
}
