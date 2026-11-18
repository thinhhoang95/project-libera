"use client";

import { isFindPreset, type FindPreset } from "./presets";
import type { FindMode, FindScope } from "./types";

/* Find bar settings, remembered per editor kind so LaTeX can keep Pattern mode
 * while notes stay Plain, plus the user's saved presets. Kept in localStorage:
 * a convenience that may come back empty (private windows, cleared data). */

export type FindEditorKind = "markdown" | "rich" | "latex" | "code";

export type FindSettings = {
  mode: FindMode;
  matchCase: boolean;
  wholeWord: boolean;
  flexibleSpacing: boolean;
  preserveCase: boolean;
  scope: FindScope;
};

export const DEFAULT_FIND_SETTINGS: FindSettings = {
  mode: "plain",
  matchCase: false,
  wholeWord: false,
  flexibleSpacing: false,
  preserveCase: false,
  scope: "anywhere",
};

const SETTINGS_KEY = "libera.find.settings.v1";
const PRESETS_KEY = "libera.find.presets.v1";
const MODES = new Set(["plain", "pattern", "regex"]);
const SCOPES = new Set(["anywhere", "outsideMath", "insideMath", "skipCommentsAndCode"]);

function read(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch { /* kept for this window only */ }
}

export function normalizeFindSettings(value: unknown): FindSettings {
  const input = value && typeof value === "object" ? value as Partial<Record<keyof FindSettings, unknown>> : {};
  return {
    mode: MODES.has(input.mode as string) ? input.mode as FindMode : DEFAULT_FIND_SETTINGS.mode,
    matchCase: input.matchCase === true,
    wholeWord: input.wholeWord === true,
    flexibleSpacing: input.flexibleSpacing === true,
    preserveCase: input.preserveCase === true,
    scope: SCOPES.has(input.scope as string) ? input.scope as FindScope : DEFAULT_FIND_SETTINGS.scope,
  };
}

const listeners = new Set<() => void>();
let settingsByKind: Partial<Record<FindEditorKind, FindSettings>> | null = null;
let presets: FindPreset[] | null = null;

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeFindStore(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function loadSettings() {
  if (!settingsByKind) {
    const stored = read(SETTINGS_KEY);
    settingsByKind = {};
    if (stored && typeof stored === "object") {
      for (const kind of ["markdown", "rich", "latex", "code"] as const) {
        const value = (stored as Record<string, unknown>)[kind];
        if (value) settingsByKind[kind] = normalizeFindSettings(value);
      }
    }
  }
  return settingsByKind;
}

export function getFindSettings(kind: FindEditorKind): FindSettings {
  const loaded = loadSettings();
  return (loaded[kind] ??= { ...DEFAULT_FIND_SETTINGS });
}

export function updateFindSettings(kind: FindEditorKind, patch: Partial<FindSettings>) {
  const loaded = loadSettings();
  loaded[kind] = normalizeFindSettings({ ...getFindSettings(kind), ...patch });
  write(SETTINGS_KEY, loaded);
  emit();
}

export function getUserFindPresets(): FindPreset[] {
  if (!presets) {
    const stored = read(PRESETS_KEY);
    presets = Array.isArray(stored) ? stored.filter(isFindPreset) : [];
  }
  return presets;
}

export function saveUserFindPreset(preset: Omit<FindPreset, "id">) {
  const id = `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  presets = [...getUserFindPresets(), { ...preset, id }];
  write(PRESETS_KEY, presets);
  emit();
  return id;
}

export function deleteUserFindPreset(id: string) {
  presets = getUserFindPresets().filter((preset) => preset.id !== id);
  write(PRESETS_KEY, presets);
  emit();
}

/** Tests: forget what was read, so the next read sees the current storage. */
export function resetFindStoreForTests() {
  settingsByKind = null;
  presets = null;
}
