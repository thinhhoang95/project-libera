"use client";

import type { LatexEditorHandle } from "./latex-editor";

/** The mounted LaTeX editor of each tab, for the outline panel. */
const editors = new Map<string, { current: LatexEditorHandle | null }>();

export function registerLatexEditor(tabId: string, handle: { current: LatexEditorHandle | null }) {
  editors.set(tabId, handle);
  return () => {
    if (editors.get(tabId) === handle) editors.delete(tabId);
  };
}

export function getLatexEditor(tabId: string) {
  return editors.get(tabId)?.current ?? null;
}
