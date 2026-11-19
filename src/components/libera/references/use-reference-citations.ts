"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { citedKeys } from "@/lib/references/citation-syntax";
import { isLatexCitingPath, latexCitedKeys } from "@/lib/references/latex-cite-syntax";
import { entryForKey, libraryEntriesByKey } from "@/lib/references/format";
import type { ReferenceLibrary } from "@/lib/references/types";
import type { OpenTab } from "../types";

// Which documents cite which keys: the server's citation index
// (GET /api/references/citations, saved files only) merged with the open
// drafts, whose keys are scanned here, debounced and off the typing path.

export type ReferenceCitationIndex = {
  byFile: Record<string, string[]>;
  byKey: Record<string, string[]>;
};

export type OpenReferenceDraft = { path: string; text: string };

const NO_DRAFTS: OpenReferenceDraft[] = [];

/**
 * The unsaved Markdown and LaTeX tabs as drafts, reusing `previous` itself (and
 * its entries) while no relevant text changed, so a caret report or a scroll
 * position does not look like an edit to the scan below.
 */
export function projectReferenceDrafts(previous: OpenReferenceDraft[], tabs: readonly OpenTab[]): OpenReferenceDraft[] {
  const before = new Map(previous.map((draft) => [draft.path, draft]));
  const next: OpenReferenceDraft[] = [];
  for (const tab of tabs) {
    if (!(tab.file.fileType === "markdown" || isLatexCitingPath(tab.file.path)) || tab.untitled || tab.draft === tab.saved) continue;
    const old = before.get(tab.file.path);
    next.push(old && old.text === tab.draft ? old : { path: tab.file.path, text: tab.draft });
  }
  return next.length === previous.length && next.every((draft, index) => draft === previous[index]) ? previous : next;
}

/** The drafts the References rail scans; none are collected while the rail is closed (`enabled` false). */
export function useOpenReferenceDrafts(tabs: readonly OpenTab[], enabled: boolean): OpenReferenceDraft[] {
  const [held, setHeld] = useState<OpenReferenceDraft[]>(NO_DRAFTS);
  // Pure in `tabs`; the state only keeps identities, and is replaced while rendering when something changed.
  const next = enabled ? projectReferenceDrafts(held, tabs) : NO_DRAFTS;
  if (next !== held) setHeld(next);
  return next;
}

/** Keys are matched case-insensitively, like key collisions in the library. */
export type CitingDocuments = Map<string, Set<string>>;

export const CITATION_SCAN_DELAY_MS = 300;
/**
 * Returning to the window refetches at most this often. Each fetch reads every
 * saved Markdown/LaTeX file in the notebook (metadata cannot be trusted to show a
 * change); saves and tree changes refetch through `refreshToken` regardless.
 */
export const CITATION_FOCUS_REFRESH_MS = 5000;

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

/** `fallback` (translated by the caller) is shown when the server gives no reason; English by default. */
export async function fetchCitationIndex(notebook: string, fallback = "Could not load which documents cite these references."): Promise<ReferenceCitationIndex> {
  const response = await fetch(`/api/references/citations?notebook=${encodeURIComponent(notebook)}`, { cache: "no-store" });
  if (!response.ok) {
    let message = fallback;
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
  const keys = isLatexCitingPath(draft.path) ? latexCitedKeys(draft.text) : citedKeys(draft.text, { allNarrative: true });
  draftScans.set(draft.path, { text: draft.text, keys });
  if (draftScans.size > 200) draftScans.delete(draftScans.keys().next().value!);
  return keys;
}

function sameDrafts(a: OpenReferenceDraft[], b: OpenReferenceDraft[]) {
  return a.length === b.length && a.every((draft, index) => draft.path === b[index].path && draft.text === b[index].text);
}

function sameScans(a: Record<string, string[]>, b: Record<string, string[]>) {
  const paths = Object.keys(a);
  return paths.length === Object.keys(b).length && paths.every((path) => a[path] === b[path]);
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
 * library, only bracketed citations count). LaTeX source counts its `\cite` commands.
 */
export function useDocumentCitedKeys(draft: string | null, delay = CITATION_SCAN_DELAY_MS, library?: ReferenceLibrary | null, syntax: "markdown" | "latex" = "markdown") {
  const snapshot = useMemo(() => ({ draft, syntax }), [draft, syntax]);
  const debounced = useDebounced(snapshot, delay);
  const known = useMemo(() => library ? libraryEntriesByKey(library) : null, [library]);
  return useMemo(() => {
    if (!debounced.draft || debounced.syntax !== syntax) return [];
    if (syntax === "latex") return latexCitedKeys(debounced.draft);
    return citedKeys(debounced.draft, { resolves: known ? (key) => Boolean(entryForKey(known, key)) : null });
  }, [debounced, known, syntax]);
}

/**
 * The notebook's citation index merged with its open drafts. `refreshToken`
 * changes when saved files may have changed, which refetches the index.
 */
export function useReferenceCitations(notebook: string | null, openDrafts: OpenReferenceDraft[], refreshToken = "") {
  const t = useTranslations("references.useReferenceCitations");
  const [state, setState] = useState<{ notebook: string | null; index: ReferenceCitationIndex; error: string | null; loading: boolean }>(
    { notebook: null, index: EMPTY_INDEX, error: null, loading: false },
  );
  const requestRef = useRef(0);
  const lastLoadRef = useRef(0);

  const reload = useCallback(async () => {
    if (!notebook) return;
    lastLoadRef.current = Date.now();
    const request = ++requestRef.current;
    setState((current) => ({ ...current, loading: true }));
    try {
      const index = await fetchCitationIndex(notebook, t("citationsLoadError"));
      if (request === requestRef.current) setState({ notebook, index, error: null, loading: false });
    } catch (error) {
      if (request === requestRef.current) {
        setState({ notebook, index: EMPTY_INDEX, error: error instanceof Error && error.message ? error.message : t("citationsFallbackError"), loading: false });
      }
    }
  }, [notebook, t]);

  useEffect(() => {
    // Fetching on mount, on notebook change and when saved files change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload, refreshToken]);

  useEffect(() => {
    const refresh = () => { if (Date.now() - lastLoadRef.current >= CITATION_FOCUS_REFRESH_MS) void reload(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [reload]);

  // Drafts inside this notebook, scanned after typing pauses. Unchanged drafts reuse their last scan.
  const candidates = useMemo(
    () => notebook ? openDrafts.filter((draft) => draft.path.startsWith(`${notebook}/`)) : [],
    [notebook, openDrafts],
  );
  // An identical list keeps its identity, so it does not restart the debounce.
  const [heldDrafts, setHeldDrafts] = useState<OpenReferenceDraft[]>(NO_DRAFTS);
  const relevant = sameDrafts(heldDrafts, candidates) ? heldDrafts : candidates;
  if (relevant !== heldDrafts) setHeldDrafts(relevant);
  const debouncedDrafts = useDebounced(relevant, CITATION_SCAN_DELAY_MS);
  const scanned = useMemo(() => {
    const keys: Record<string, string[]> = {};
    for (const draft of debouncedDrafts) keys[draft.path] = scanDraft(draft);
    return keys;
  }, [debouncedDrafts]);
  // The merged index below is rebuilt only when some file's keys differ.
  const [heldKeys, setHeldKeys] = useState<Record<string, string[]>>({});
  const draftKeys = sameScans(heldKeys, scanned) ? heldKeys : scanned;
  if (draftKeys !== heldKeys) setHeldKeys(draftKeys);

  const index = state.notebook === notebook ? state.index : EMPTY_INDEX;
  const byKey = useMemo(() => mergeCitationIndex(index, draftKeys), [index, draftKeys]);
  return { byKey, error: state.notebook === notebook ? state.error : null, loading: state.loading, reload };
}
