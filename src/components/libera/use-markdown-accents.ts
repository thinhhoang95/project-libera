"use client";

import { useEffect } from "react";
import type { MarkdownPreferences } from "@/lib/markdown-preferences";

/**
 * Marks the page with the heading accent from Preferences → Markdown; the
 * colors themselves live in globals.css under [data-heading-color]. A custom
 * palette is handed to that CSS as --libera-custom-* variables.
 */
export function useMarkdownAccents({ headingColor, headingPalette, boldLeadIns }: Pick<MarkdownPreferences, "headingColor" | "headingPalette" | "boldLeadIns">) {
  const { h1, h2, h3, h4, h5, lists } = headingPalette;
  useEffect(() => {
    const root = document.documentElement;
    if (headingColor === "none") return;
    root.dataset.headingColor = headingColor;
    if (boldLeadIns) root.dataset.boldLeadIns = "true";
    const custom = headingColor === "custom" ? Object.entries({ h1, h2, h3, h4, h5, lists }) : [];
    for (const [key, color] of custom) root.style.setProperty(`--libera-custom-${key}`, color);
    return () => {
      delete root.dataset.headingColor;
      delete root.dataset.boldLeadIns;
      for (const [key] of custom) root.style.removeProperty(`--libera-custom-${key}`);
    };
  }, [headingColor, boldLeadIns, h1, h2, h3, h4, h5, lists]);
}
