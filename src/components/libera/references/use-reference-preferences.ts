"use client";

import { useEffect, useState } from "react";

// Preferences → AI → References as the client may see them
// (GET /api/references/settings): the defaults behind the Add box's
// "Search the web", the fact-check popover's web checkbox and the
// "Follow Preferences" choice for new PDFs. Read once per session; a failed
// read is retried by the next component that asks. The choices a user makes
// in the panel (setSessionWebSearch) still win for the session.

export type ReferencePreferenceDefaults = {
  lookupOnline: boolean;
  useAi: boolean;
  webSearch: boolean;
  autoCreateForPdfs: boolean;
};

let cached: ReferencePreferenceDefaults | null = null;
let pending: Promise<ReferencePreferenceDefaults | null> | null = null;

function parse(body: unknown): ReferencePreferenceDefaults | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  const flags = ["lookupOnline", "useAi", "webSearch", "autoCreateForPdfs"] as const;
  if (!flags.every((flag) => typeof value[flag] === "boolean")) return null;
  return { lookupOnline: value.lookupOnline as boolean, useAi: value.useAi as boolean, webSearch: value.webSearch as boolean, autoCreateForPdfs: value.autoCreateForPdfs as boolean };
}

/** The reference preferences, fetched once per session; null when they cannot be read. */
export function fetchReferencePreferences(): Promise<ReferencePreferenceDefaults | null> {
  if (cached) return Promise.resolve(cached);
  pending ??= fetch("/api/references/settings", { cache: "no-store" })
    .then(async (response) => response.ok ? parse(await response.json()) : null)
    .catch(() => null)
    .then((result) => {
      cached = result;
      pending = null;
      return result;
    });
  return pending;
}

/** The cached preferences, if they were read already this session. */
export function cachedReferencePreferences() {
  return cached;
}

/** Tests: forget the session's preferences. */
export function resetReferencePreferences() {
  cached = null;
  pending = null;
}

/** The reference preferences, or null until (and unless) they are read. */
export function useReferencePreferences() {
  const [preferences, setPreferences] = useState<ReferencePreferenceDefaults | null>(cached);
  useEffect(() => {
    if (preferences) return;
    let current = true;
    void fetchReferencePreferences().then((result) => {
      if (current && result) setPreferences(result);
    });
    return () => {
      current = false;
    };
  }, [preferences]);
  return preferences;
}
