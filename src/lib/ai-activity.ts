import { useSyncExternalStore } from "react";

// Counts in-flight AI operations (format, rewrite, write...) across editors so
// the workspace chrome can show a single Gemini-style glow while any runs.
let active = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function beginAiActivity(): () => void {
  active += 1;
  emit();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    active -= 1;
    emit();
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useAiActivity(): boolean {
  return useSyncExternalStore(subscribe, () => active > 0, () => false);
}
