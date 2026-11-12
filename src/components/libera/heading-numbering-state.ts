"use client";

import { useSyncExternalStore } from "react";
import type { HeadingNumberingOptions, HeadingNumberingSettings } from "@/lib/markdown-heading-numbering";

/*
 * Heading numbering state, shared by every Markdown editor and toolbar.
 *
 * - "Skip the first level-1 heading" is a device preference (on by default).
 * - "Number up to level N" is a device preference (all levels by default).
 * - Whether a document is structurally numbered is chosen per document with
 *   the toolbar toggle and remembered by path. A document nobody has toggled
 *   counts as numbered when, the first time it is seen this session, all its
 *   headings except a title are numbered.
 */

const SKIP_TITLE_KEY = "libera-heading-numbering-skip-title";
const MAX_DEPTH_KEY = "libera-heading-numbering-max-depth";
const DOCUMENTS_KEY = "libera-heading-numbering-documents";
const CHANGE_EVENT = "libera-heading-numbering-change";
const MAX_REMEMBERED_DOCUMENTS = 1000;

let unstoredSkipTitle = true;
let unstoredMaxDepth = 0;
let unstoredDocuments: Record<string, boolean> = {};
let documentsCache: { raw: string | null; value: Record<string, boolean> } | null = null;
const detected = new Map<string, boolean>();

function notify() {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function readHeadingNumberingSkipTitle() {
  try {
    const stored = window.localStorage.getItem(SKIP_TITLE_KEY);
    return stored === null ? unstoredSkipTitle : stored !== "false";
  } catch {
    return unstoredSkipTitle;
  }
}

export function saveHeadingNumberingSkipTitle(value: boolean) {
  unstoredSkipTitle = value;
  try {
    window.localStorage.setItem(SKIP_TITLE_KEY, String(value));
  } catch {
    // Storage can be unavailable; the choice then lasts for this session only.
  }
  notify();
}

/** The deepest numbered level, 1-6, or 0 when every level is numbered. */
export function readHeadingNumberingMaxDepth() {
  try {
    const stored = window.localStorage.getItem(MAX_DEPTH_KEY);
    return stored === null ? unstoredMaxDepth : normalizeMaxDepth(Number(stored));
  } catch {
    return unstoredMaxDepth;
  }
}

function normalizeMaxDepth(value: number) {
  return Number.isInteger(value) && value >= 1 && value <= 6 ? value : 0;
}

export function saveHeadingNumberingMaxDepth(value: number) {
  unstoredMaxDepth = normalizeMaxDepth(value);
  try {
    window.localStorage.setItem(MAX_DEPTH_KEY, String(unstoredMaxDepth));
  } catch {
    // Storage can be unavailable; the choice then lasts for this session only.
  }
  notify();
}

/** The device's numbering options, for one-off numbering. */
export function readHeadingNumberingOptions(): HeadingNumberingOptions {
  return { maxDepth: readHeadingNumberingMaxDepth(), skipTitle: readHeadingNumberingSkipTitle() };
}

function readDocuments(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(DOCUMENTS_KEY);
    if (documentsCache?.raw === raw) return documentsCache.value;
    let value: Record<string, boolean> = {};
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        value = Object.fromEntries(Object.entries(parsed).filter(([, enabled]) => typeof enabled === "boolean"));
      }
    } catch {
      // A damaged entry is forgotten rather than breaking the editors.
    }
    documentsCache = { raw, value };
    return value;
  } catch {
    return unstoredDocuments;
  }
}

/** Whether `documentPath` is structurally numbered. `detect` reads the
 * document's headings; it runs once a non-empty document is first seen. */
export function readDocumentHeadingNumbering(documentPath: string, detect?: () => boolean | null) {
  const chosen = readDocuments()[documentPath];
  if (chosen !== undefined) return chosen;
  const known = detected.get(documentPath);
  if (known !== undefined) return known;
  const result = detect?.();
  if (result === null || result === undefined) return false;
  detected.set(documentPath, result);
  return result;
}

export function saveDocumentHeadingNumbering(documentPath: string, enabled: boolean) {
  const documents = { ...readDocuments() };
  delete documents[documentPath];
  documents[documentPath] = enabled;
  const paths = Object.keys(documents);
  for (const path of paths.slice(0, Math.max(0, paths.length - MAX_REMEMBERED_DOCUMENTS))) delete documents[path];
  unstoredDocuments = documents;
  try {
    window.localStorage.setItem(DOCUMENTS_KEY, JSON.stringify(documents));
  } catch {
    // Storage can be unavailable; the choice then lasts for this session only.
  }
  notify();
}

/** Documents moved to new paths (notebook migration) keep their numbering choice. */
export function remapDocumentHeadingNumbering(moves: ReadonlyMap<string, string>) {
  const documents = readDocuments();
  if (![...moves.keys()].some((path) => path in documents)) return;
  const next = Object.fromEntries(Object.entries(documents).map(([path, enabled]) => [moves.get(path) ?? path, enabled]));
  unstoredDocuments = next;
  try {
    window.localStorage.setItem(DOCUMENTS_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable; the choice then lasts for this session only.
  }
  notify();
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SKIP_TITLE_KEY || event.key === MAX_DEPTH_KEY || event.key === DOCUMENTS_KEY) onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

const DISABLED: HeadingNumberingSettings = { enabled: false, maxDepth: 0, skipTitle: true };
const settingsCache = new Map<string, HeadingNumberingSettings>();

/** A stable settings object per state, as useSyncExternalStore requires. */
function settingsFor(enabled: boolean, skipTitle: boolean, maxDepth: number) {
  const key = `${enabled}:${skipTitle}:${maxDepth}`;
  let settings = settingsCache.get(key);
  if (!settings) settingsCache.set(key, settings = { enabled, maxDepth, skipTitle });
  return settings;
}

/** The document's numbering settings, re-rendering when they change.
 * `detect` gets the device's level limit (0: all levels). */
export function useHeadingNumbering(documentPath: string | undefined, detect?: (maxDepth: number) => boolean | null) {
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!documentPath) return DISABLED;
      const maxDepth = readHeadingNumberingMaxDepth();
      return settingsFor(
        readDocumentHeadingNumbering(documentPath, detect && (() => detect(maxDepth))),
        readHeadingNumberingSkipTitle(),
        maxDepth,
      );
    },
    () => DISABLED,
  );
}
