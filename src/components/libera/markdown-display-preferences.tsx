"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiRequest } from "./api-client";
import { createDeferredSave, registerStateFlusher, stateRequestKeepalive } from "./deferred-save";
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
  const writer = useMemo(() => createDeferredSave(async (body) => {
    await apiRequest("/api/preferences/markdown-display", { method: "PUT", body, keepalive: stateRequestKeepalive(body) });
    setError("");
  }, () => setError("Could not save Markdown display settings.")), []);
  const flushPreferences = useCallback(() => writer.flush().catch(() => undefined), [writer]);

  const updatePreferences = useCallback((patch: Partial<MarkdownDisplayPreferences>) => {
    const next = normalizeMarkdownDisplayPreferences({ ...latest.current, ...patch });
    if (next.textWidth === latest.current.textWidth && next.textScale === latest.current.textScale &&
        next.outlineExpansionLevel === latest.current.outlineExpansionLevel) return;
    latest.current = next;
    setPreferences(next);
    writer.schedule(next);
  }, [writer]);

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
    const unregister = registerStateFlusher(writer.flush);
    return () => {
      unregister();
      void flushPreferences();
    };
  }, [flushPreferences, updatePreferences, writer]);

  const context = useMemo(() => ({ preferences, updatePreferences, flushPreferences }), [preferences, updatePreferences, flushPreferences]);
  return <Context.Provider value={context}>
    {children}
    {error && <div role="alert" className="fixed bottom-4 right-4 z-50 rounded border border-border bg-card p-3 text-sm">
      {error} <button type="button" className="underline" onClick={flushPreferences}>Retry</button>
    </div>}
  </Context.Provider>;
}
