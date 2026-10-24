"use client";

// Whether a top-level notebook is a shared notebook on this machine, for UI
// that words things differently there (the agent's permission modes become
// "Suggest in …"). Without the desktop bridge collaboration is off in this
// window, so the status store is never read and the answer is false.

import { useSyncExternalStore } from "react";
import { getCollabBridge } from "./bridge";
import { getCollabStatusStore } from "./status-store";

const noopSubscribe = () => () => {};

export function useIsSharedNotebook(notebook: string | null | undefined): boolean {
  const store = getCollabBridge() ? getCollabStatusStore() : null;
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    () => !!notebook && !!store?.getSnapshot().status?.projects.some((project) => project.kind !== "album" && project.notebook === notebook),
    () => false,
  );
}
