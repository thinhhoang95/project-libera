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

/**
 * The paper color of PDF pages, in the PDF viewer and the LaTeX PDF preview
 * alike: the page color of the theme Preferences sets for PDF pages, for the
 * appearance (pdf-paper-color.ts).
 */
export function usePdfPaperColor() {
  const theme = useResolvedEditorThemes().pdf;
  const dark = useSyncExternalStore(subscribe, isDark, () => false);
  return pdfPaperColor(theme, dark);
}
