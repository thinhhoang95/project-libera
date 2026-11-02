import { useSyncExternalStore } from "react";

// Tracks in-flight AI operations (format, rewrite, write...) across editors so
// the workspace chrome can show a single Gemini-style glow while any runs, and
// a floating card can offer Stop for the ones that can be cancelled.
export type AiActivity = { id: number; label: string; cancel: () => void };

/** What the floating card says while each editor AI action runs. */
export const AI_ACTION_LABELS = {
  write: "Writing with AI",
  rewrite: "Rewriting with AI",
  format: "Formatting with AI",
  image: "Converting the image with AI",
} as const;

let active = 0;
let nextId = 1;
let cancellable: readonly AiActivity[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function beginAiActivity(options?: { label: string; cancel: () => void }): () => void {
  active += 1;
  const activity = options ? { id: nextId++, ...options } : null;
  if (activity) cancellable = [...cancellable, activity];
  emit();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    active -= 1;
    if (activity) cancellable = cancellable.filter((item) => item !== activity);
    emit();
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const NO_ACTIVITIES: readonly AiActivity[] = [];

export function useAiActivity(): boolean {
  return useSyncExternalStore(subscribe, () => active > 0, () => false);
}

/** The running AI operations that registered a way to cancel them, oldest first. */
export function useCancellableAiActivities(): readonly AiActivity[] {
  return useSyncExternalStore(subscribe, () => cancellable, () => NO_ACTIVITIES);
}
