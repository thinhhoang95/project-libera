"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { citedKeys } from "@/lib/references/citation-syntax";
import { entryForKey, libraryEntriesByKey } from "@/lib/references/format";
import type { ReferenceLibrary } from "@/lib/references/types";

// Which documents cite which keys: the server's citation index
// (GET /api/references/citations, saved files only) merged with the open
// drafts, whose keys are scanned here, debounced and off the typing path.

export type ReferenceCitationIndex = {
  byFile: Record<string, string[]>;
  byKey: Record<string, string[]>;
};

export type OpenReferenceDraft = { path: string; text: string };

/** Keys are matched case-insensitively, like key collisions in the library. */
export type CitingDocuments = Map<string, Set<string>>;

export const CITATION_SCAN_DELAY_MS = 300;

const EMPTY_INDEX: ReferenceCitationIndex = { byFile: {}, byKey: {} };

/**
 * Lowercased key → citing paths. A draft replaces its file's saved keys, so a
 * citation typed but not saved counts and one deleted but not saved does not.
 */
export function mergeCitationIndex(index: ReferenceCitationIndex, draftKeys: Record<string, string[]>): CitingDocuments {
  const byFile: Record<string, string[]> = { ...index.byFile, ...draftKeys };
  const byKey: CitingDocuments = new Map();
  for (const [path, keys] of Object.entries(byFile)) {
    for (const key of keys) {
      const lower = key.toLowerCase();
      let paths = byKey.get(lower);
      if (!paths) byKey.set(lower, paths = new Set());
      paths.add(path);
    }
  }
  return byKey;
}

export async function fetchCitationIndex(notebook: string): Promise<ReferenceCitationIndex> {
  const response = await fetch(`/api/references/citations?notebook=${encodeURIComponent(notebook)}`, { cache: "no-store" });
  if (!response.ok) {
    let message = "Could not load which documents cite these references.";
    try {
      const body = await response.json() as { error?: unknown };
      if (typeof body.error === "string" && body.error) message = body.error;
    } catch {
      // Not JSON.
    }
    throw new Error(message);
  }
  const body = await response.json() as Partial<ReferenceCitationIndex>;
  return { byFile: body.byFile ?? {}, byKey: body.byKey ?? {} };
}

/** The last scan of each open draft, so unchanged drafts are not scanned again. */
const draftScans = new Map<string, { text: string; keys: string[] }>();

function scanDraft(draft: OpenReferenceDraft) {
  const cached = draftScans.get(draft.path);
  if (cached && cached.text === draft.text) return cached.keys;
  // Every narrative candidate: the merged index is only ever looked up by library keys.
  const keys = citedKeys(draft.text, { allNarrative: true });
  draftScans.set(draft.path, { text: draft.text, keys });
  if (draftScans.size > 200) draftScans.delete(draftScans.keys().next().value!);
  return keys;
}

/** `value`, after it has stopped changing for `delay` ms. */
function useDebounced<T>(value: T, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (Object.is(value, debounced)) return;
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, debounced, delay]);
  return debounced;
}

/**
 * Keys the active document cites, in document order, rescanned ~300 ms after
 * typing stops. Narrative `@key`s count when `library` knows them (without a
 * library, only bracketed citations count).
 */
export function useDocumentCitedKeys(draft: string | null, delay = CITATION_SCAN_DELAY_MS, library?: ReferenceLibrary | null) {
  const debounced = useDebounced(draft, delay);
  const known = useMemo(() => library ? libraryEntriesByKey(library) : null, [library]);
  return useMemo(() => {
    if (!debounced) return [];
    return citedKeys(debounced, { resolves: known ? (key) => Boolean(entryForKey(known, key)) : null });
  }, [debounced, known]);
}

/**
 * The notebook's citation index merged with its open drafts. `refreshToken`
 * changes when saved files may have changed, which refetches the index.
 */
export function useReferenceCitations(notebook: string | null, openDrafts: OpenReferenceDraft[], refreshToken = "") {
  const [state, setState] = useState<{ notebook: string | null; index: ReferenceCitationIndex; error: string | null; loading: boolean }>(
    { notebook: null, index: EMPTY_INDEX, error: null, loading: false },
  );
  const requestRef = useRef(0);

  const reload = useCallback(async () => {
    if (!notebook) return;
    const request = ++requestRef.current;
    setState((current) => ({ ...current, loading: true }));
    try {
      const index = await fetchCitationIndex(notebook);
      if (request === requestRef.current) setState({ notebook, index, error: null, loading: false });
    } catch (error) {
      if (request === requestRef.current) {
        setState({ notebook, index: EMPTY_INDEX, error: error instanceof Error ? error.message : "Could not load citations.", loading: false });
      }
    }
  }, [notebook]);

  useEffect(() => {
    // Fetching on mount, on notebook change and when saved files change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload, refreshToken]);

  useEffect(() => {
    const refresh = () => void reload();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [reload]);

  // Drafts inside this notebook, scanned after typing pauses. Unchanged drafts reuse their last scan.
  const relevant = useMemo(
    () => notebook ? openDrafts.filter((draft) => draft.path.startsWith(`${notebook}/`)) : [],
    [notebook, openDrafts],
  );
  const debouncedDrafts = useDebounced(relevant, CITATION_SCAN_DELAY_MS);
  const draftKeys = useMemo(() => {
    const keys: Record<string, string[]> = {};
    for (const draft of debouncedDrafts) keys[draft.path] = scanDraft(draft);
    return keys;
  }, [debouncedDrafts]);

  const index = state.notebook === notebook ? state.index : EMPTY_INDEX;
  const byKey = useMemo(() => mergeCitationIndex(index, draftKeys), [index, draftKeys]);
  return { byKey, error: state.notebook === notebook ? state.error : null, loading: state.loading, reload };
}
