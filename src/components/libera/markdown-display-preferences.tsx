"use client";

import { useTranslations } from "next-intl";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { apiRequest } from "./api-client";
import { createDeferredSave, registerStateFlusher, stateRequestKeepalive } from "./deferred-save";
import { DEFAULT_MARKDOWN_DISPLAY_PREFERENCES, normalizeMarkdownDisplayPreferences, type MarkdownDisplayPreferences } from "@/lib/markdown-display-preferences";

type Actions = {
  updatePreferences: (patch: Partial<MarkdownDisplayPreferences>) => void;
  flushPreferences: () => void;
};

/** Preferences live outside React state so a consumer re-renders only for the keys it reads. */
type Store = Actions & {
  get: () => MarkdownDisplayPreferences;
  subscribe: (listener: () => void) => () => void;
};

function createStore(initial: MarkdownDisplayPreferences, actions: (store: Store) => Actions): Store {
  let current = initial;
  const listeners = new Set<() => void>();
  const store: Store = {
    get: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    updatePreferences: (patch) => {
      const next = normalizeMarkdownDisplayPreferences({ ...current, ...patch });
      if ((Object.keys(next) as (keyof MarkdownDisplayPreferences)[]).every((key) => next[key] === current[key])) return;
      current = next;
      actions(store).updatePreferences(next);
      listeners.forEach((listener) => listener());
    },
    flushPreferences: () => actions(store).flushPreferences(),
  };
  return store;
}

const DEFAULT_STORE = createStore(DEFAULT_MARKDOWN_DISPLAY_PREFERENCES, () => ({ updatePreferences: () => {}, flushPreferences: () => {} }));
const Context = createContext<Store>(DEFAULT_STORE);

/** One preference; pass `enabled: false` to stop following it (the default value is returned). */
export function useMarkdownDisplayPreference<K extends keyof MarkdownDisplayPreferences>(key: K, enabled = true): MarkdownDisplayPreferences[K] {
  const store = useContext(Context);
  const subscribe = useCallback((listener: () => void) => enabled ? store.subscribe(listener) : () => {}, [enabled, store]);
  const read = () => enabled ? store.get()[key] : DEFAULT_MARKDOWN_DISPLAY_PREFERENCES[key];
  return useSyncExternalStore(subscribe, read, read);
}

/** Update and flush functions only; never re-renders for a preference change. */
export function useMarkdownDisplayPreferenceActions(): Actions {
  const { updatePreferences, flushPreferences } = useContext(Context);
  return useMemo(() => ({ updatePreferences, flushPreferences }), [updatePreferences, flushPreferences]);
}

/** Every preference; re-renders on any change, so prefer the single-key hook. */
export function useMarkdownDisplayPreferences() {
  const store = useContext(Context);
  const preferences = useSyncExternalStore(store.subscribe, store.get, store.get);
  return { preferences, updatePreferences: store.updatePreferences, flushPreferences: store.flushPreferences };
}

export function MarkdownDisplayPreferencesProvider({ initialPreferences = {}, children }: {
  initialPreferences?: Partial<MarkdownDisplayPreferences>;
  children?: ReactNode;
}) {
  const t = useTranslations("markdownDisplayPreferences");
  const [error, setError] = useState(false);
  const writer = useMemo(() => createDeferredSave(async (body) => {
    await apiRequest("/api/preferences/markdown-display", { method: "PUT", body, keepalive: stateRequestKeepalive(body) });
    setError(false);
  }, () => setError(true)), []);
  const flushPreferences = useCallback(() => writer.flush().catch(() => undefined), [writer]);
  const [store] = useState(() => createStore(normalizeMarkdownDisplayPreferences(initialPreferences), () => ({
    updatePreferences: (next) => writer.schedule(next),
    flushPreferences,
  })));
  const { updatePreferences } = store;

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

  return <Context.Provider value={store}>
    {children}
    {error && <div role="alert" className="fixed bottom-4 right-4 z-50 rounded border border-border bg-card p-3 text-sm">
      {t("saveError")} <button type="button" className="underline" onClick={flushPreferences}>{t("retry")}</button>
    </div>}
  </Context.Provider>;
}
