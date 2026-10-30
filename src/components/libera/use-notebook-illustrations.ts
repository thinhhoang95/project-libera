"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { DEFAULT_NOTEBOOK_ILLUSTRATIONS, type NotebookIllustrationLibrary } from "../../../electron/notebook-illustrations.cjs";

/** The illustration sets and the one notebook covers use (Preferences → General). */
export const NotebookIllustrationsContext = createContext<NotebookIllustrationLibrary>(DEFAULT_NOTEBOOK_ILLUSTRATIONS);

export function useNotebookIllustrationLibrary() {
  return useContext(NotebookIllustrationsContext);
}

/** Starts from the server's copy; Preferences sends the sets again as soon as they are saved. */
export function useNotebookIllustrations(initial: NotebookIllustrationLibrary) {
  const [library, setLibrary] = useState(initial);
  useEffect(() => window.liberaWindow?.onNotebookIllustrationsChanged?.(setLibrary), []);
  return library;
}
