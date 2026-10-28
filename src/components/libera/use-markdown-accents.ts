"use client";

import { useEffect } from "react";
import type { MarkdownPreferences } from "@/lib/markdown-preferences";

/**
 * Marks the page when bold lead-ins take the heading color (Preferences →
 * Markdown). The heading colors come from the visual editor's theme
 * (use-editor-themes.ts); globals.css applies both.
 */
export function useMarkdownAccents({ boldLeadIns }: Pick<MarkdownPreferences, "boldLeadIns">) {
  useEffect(() => {
    if (!boldLeadIns) return;
    const root = document.documentElement;
    root.dataset.boldLeadIns = "true";
    return () => { delete root.dataset.boldLeadIns; };
  }, [boldLeadIns]);
}
