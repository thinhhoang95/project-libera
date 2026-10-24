"use client";

import { useSyncExternalStore } from "react";
import { apiRequest } from "@/components/libera/api-client";
import { isSpendingPeriod, type AccountUsage, type Breakdown, type Metric, type SpendingPeriod, type UsageReport } from "@/lib/spending";

/**
 * State shared by the Spending page and its contextual rail panel: the panel
 * holds the controls (period, measure, breakdown, model), the page shows what
 * they select. Settings are remembered on this computer; the report is loaded
 * once and refreshed while the page is open.
 */
export type SpendingSettings = {
  period: SpendingPeriod;
  metric: Metric;
  breakdown: Breakdown;
  /** Show one model only, or every model. */
  model: string | null;
};

type Loadable<T> = { status: "idle" | "loading" | "ready" | "error"; value: T | null; error: string; loadedAt: number };

export type SpendingState = {
  settings: SpendingSettings;
  report: Loadable<UsageReport>;
  account: Loadable<AccountUsage | null>;
};

const SETTINGS_KEY = "libera.spending.settings";
const DEFAULT_SETTINGS: SpendingSettings = { period: "30d", metric: "cost", breakdown: "component", model: null };
const idle = <T,>(): Loadable<T> => ({ status: "idle", value: null, error: "", loadedAt: 0 });

function readSettings(): SpendingSettings {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<SpendingSettings> | null;
    if (!stored) return DEFAULT_SETTINGS;
    return {
      period: isSpendingPeriod(stored.period) ? stored.period : DEFAULT_SETTINGS.period,
      metric: stored.metric === "tokens" ? "tokens" : "cost",
      breakdown: stored.breakdown === "model" ? "model" : "component",
      model: typeof stored.model === "string" ? stored.model : null,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

let state: SpendingState = { settings: DEFAULT_SETTINGS, report: idle(), account: idle() };
let settingsLoaded = false;
const listeners = new Set<() => void>();
const SERVER_STATE = state;

function publish(next: SpendingState) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  if (!settingsLoaded && typeof window !== "undefined") {
    settingsLoaded = true;
    state = { ...state, settings: readSettings() };
  }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSpending() {
  return useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
}

export function updateSpendingSettings(patch: Partial<SpendingSettings>) {
  const settings = { ...state.settings, ...patch };
  publish({ ...state, settings });
  try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
  catch { /* Settings fall back to the defaults next time. */ }
}

let reportRequest: Promise<void> | null = null;
let accountRequest: Promise<void> | null = null;

/** Loads the ledger report and the OpenRouter key's counters; requests already in flight are shared. */
export function refreshSpending({ account = true } = {}) {
  reportRequest ??= (async () => {
    publish({ ...state, report: { ...state.report, status: "loading", error: "" } });
    try {
      const value = await apiRequest<UsageReport>("/api/usage");
      publish({ ...state, report: { status: "ready", value, error: "", loadedAt: Date.now() } });
    } catch (error) {
      publish({ ...state, report: { ...state.report, status: "error", error: error instanceof Error ? error.message : "Could not load spending." } });
    } finally {
      reportRequest = null;
    }
  })();
  if (account) {
    accountRequest ??= (async () => {
      publish({ ...state, account: { ...state.account, status: "loading", error: "" } });
      try {
        const { account: value } = await apiRequest<{ account: AccountUsage | null }>("/api/usage/account");
        publish({ ...state, account: { status: "ready", value, error: "", loadedAt: Date.now() } });
      } catch (error) {
        publish({ ...state, account: { ...state.account, status: "error", error: error instanceof Error ? error.message : "Could not reach OpenRouter." } });
      } finally {
        accountRequest = null;
      }
    })();
  }
  return Promise.all([reportRequest, accountRequest]);
}
