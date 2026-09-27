"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiRequest } from "./api-client";
import { DEFAULT_MARKDOWN_DISPLAY_PREFERENCES, normalizeMarkdownDisplayPreferences, type MarkdownDisplayPreferences } from "@/lib/markdown-display-preferences";

const Context = createContext<{
  preferences: MarkdownDisplayPreferences;
  updatePreferences: (patch: Partial<MarkdownDisplayPreferences>) => void;
  flushPreferences: () => void;
}>({
  preferences: DEFAULT_MARKDOWN_DISPLAY_PREFERENCES,
  updatePreferences: () => {},
  flushPreferences: () => {},
});

export const useMarkdownDisplayPreferences = () => useContext(Context);

export function MarkdownDisplayPreferencesProvider({ initialPreferences = {}, children }: {
  initialPreferences?: Partial<MarkdownDisplayPreferences>;
  children?: ReactNode;
}) {
  const [preferences, setPreferences] = useState(() => normalizeMarkdownDisplayPreferences(initialPreferences));
  const [error, setError] = useState("");
  const latest = useRef(preferences);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saves = useRef(Promise.resolve());

  const flushPreferences = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current) return;
    dirty.current = false;
    const snapshot = latest.current;
    // Serialize writes so an earlier adjustment cannot overwrite a later one.
    saves.current = saves.current.then(async () => {
      try {
        await apiRequest("/api/preferences/markdown-display", {
          method: "PUT", body: JSON.stringify(snapshot), keepalive: true,
        });
        setError("");
      } catch {
        if (latest.current === snapshot) dirty.current = true;
        setError("Could not save Markdown display settings.");
      }
    });
  }, []);

  const updatePreferences = useCallback((patch: Partial<MarkdownDisplayPreferences>) => {
    const next = normalizeMarkdownDisplayPreferences({ ...latest.current, ...patch });
    if (next.textWidth === latest.current.textWidth && next.textScale === latest.current.textScale &&
        next.outlineExpansionLevel === latest.current.outlineExpansionLevel) return;
    latest.current = next;
    dirty.current = true;
    setPreferences(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(flushPreferences, 250);
  }, [flushPreferences]);

  const initial = useRef(initialPreferences);
  useEffect(() => {
    // Migrate the old browser-only width once; disk settings take precedence.
    if (initial.current.textWidth === undefined) {
      try {
        const saved = window.localStorage.getItem("libera.markdown.text-width");
        if (saved !== null && saved.trim() && Number.isFinite(Number(saved))) {
          updatePreferences({ textWidth: Number(saved) });
        }
      } catch { /* Browser storage can be disabled. */ }
    }
    window.addEventListener("pagehide", flushPreferences);
    return () => {
      window.removeEventListener("pagehide", flushPreferences);
      flushPreferences();
    };
  }, [flushPreferences, updatePreferences]);

  const context = useMemo(() => ({ preferences, updatePreferences, flushPreferences }), [preferences, updatePreferences, flushPreferences]);
  return <Context.Provider value={context}>
    {children}
    {error && <div role="alert" className="fixed bottom-4 right-4 z-50 rounded border border-border bg-card p-3 text-sm">
      {error} <button type="button" className="underline" onClick={flushPreferences}>Retry</button>
    </div>}
  </Context.Provider>;
}
