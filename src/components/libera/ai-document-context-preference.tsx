"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "libera-ai-include-document-context";
const CHANGE_EVENT = "libera-ai-include-document-context-change";
let unstoredValue = true;

/** Whether AI Rewrite and Write with AI send the whole document as context.
 * On by default; stored per device so it survives app restarts. */
export function readIncludeDocumentContext() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === null ? unstoredValue : stored !== "false";
  } catch {
    return unstoredValue;
  }
}

export function saveIncludeDocumentContext(value: boolean) {
  unstoredValue = value;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Storage can be unavailable; the choice then lasts for this session only.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEY) onChange(); };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useIncludeDocumentContext() {
  return useSyncExternalStore(subscribe, readIncludeDocumentContext, () => true);
}
