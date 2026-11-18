"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { compileFind, compileFindReplacement, type CompiledFind, type CompiledReplacement, type FindFlavor, type Finder, type FindOptions, type Replacer } from "@/lib/find";
import type { FindPreset } from "@/lib/find/presets";
import {
  DEFAULT_FIND_SETTINGS,
  getFindSettings,
  subscribeFindStore,
  updateFindSettings,
  type FindEditorKind,
  type FindSettings,
} from "@/lib/find/settings-store";

/* The query, replacement and options of one editor's find bar, compiled.
 * Editors run `finder` over their text; the bar draws `compiled` and
 * `compiledReplacement` (holes, references, errors). */

export type FindQueryState = {
  kind: FindEditorKind;
  flavor: FindFlavor;
  query: string;
  replacement: string;
  settings: FindSettings;
  compiled: CompiledFind;
  /** The compiled query, or null while it has an error. */
  finder: Finder | null;
  compiledReplacement: CompiledReplacement | null;
  /** The compiled replacement, or null while it (or the query) has an error. */
  replacer: Replacer | null;
  setQuery: (query: string) => void;
  setReplacement: (replacement: string) => void;
  updateSettings: (patch: Partial<FindSettings>) => void;
  /** Fills the bar from a preset (TipTap reads `preset.markdownReplacement` itself). */
  applyPreset: (preset: FindPreset) => void;
};

export function toFindOptions(settings: FindSettings, flavor: FindFlavor): FindOptions {
  return {
    mode: settings.mode,
    matchCase: settings.matchCase,
    wholeWord: settings.wholeWord,
    flexibleSpacing: settings.flexibleSpacing,
    scope: settings.scope,
    flavor,
  };
}

export function useFindSettings(kind: FindEditorKind) {
  const settings = useSyncExternalStore(subscribeFindStore, () => getFindSettings(kind), () => DEFAULT_FIND_SETTINGS);
  const update = useCallback((patch: Partial<FindSettings>) => updateFindSettings(kind, patch), [kind]);
  return [settings, update] as const;
}

export function useFindQuery(kind: FindEditorKind, flavor: FindFlavor, initialQuery = ""): FindQueryState {
  const [settings, updateSettings] = useFindSettings(kind);
  const [query, setQuery] = useState(initialQuery);
  const [replacement, setReplacement] = useState("");

  const compiled = useMemo(() => compileFind(query, toFindOptions(settings, flavor)), [query, settings, flavor]);
  const finder = compiled.ok ? compiled.finder : null;
  const compiledReplacement = useMemo(
    () => finder ? compileFindReplacement(finder, replacement, settings.preserveCase) : null,
    [finder, replacement, settings.preserveCase],
  );
  const replacer = compiledReplacement?.ok ? compiledReplacement.replacer : null;

  const applyPreset = useCallback((preset: FindPreset) => {
    updateSettings({
      mode: preset.mode,
      ...(preset.matchCase !== undefined ? { matchCase: preset.matchCase } : {}),
      ...(preset.wholeWord !== undefined ? { wholeWord: preset.wholeWord } : {}),
      ...(preset.flexibleSpacing !== undefined ? { flexibleSpacing: preset.flexibleSpacing } : {}),
      ...(preset.scope !== undefined ? { scope: preset.scope } : {}),
    });
    setQuery(preset.query);
    setReplacement(preset.replacement);
  }, [updateSettings]);

  return {
    kind, flavor, query, replacement, settings, compiled, finder, compiledReplacement, replacer,
    setQuery, setReplacement, updateSettings, applyPreset,
  };
}
