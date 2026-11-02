import { readFileSync } from "node:fs";
import type { SearchPreferences } from "./settings";

export type EmbeddingDeferral = "interval" | "battery" | "power-unknown";

export function embeddingPowerState(): "ac" | "battery" | "unknown" {
  try {
    const file = process.env.LIBERA_POWER_STATE_PATH;
    if (!file) return "unknown";
    const state = JSON.parse(readFileSync(file, "utf8"));
    const age = Date.now() - state.checkedAt;
    if (!Number.isFinite(age) || age < 0 || age > 90_000) return "unknown";
    return state.onBattery === false ? "ac" : state.onBattery === true ? "battery" : "unknown";
  } catch { return "unknown"; }
}

export function embeddingDeferral(preferences: SearchPreferences, lastAttempt: number, manual = false): EmbeddingDeferral | undefined {
  if (preferences.embeddingOnlyOnAC) {
    const power = embeddingPowerState();
    if (power !== "ac") return power === "battery" ? "battery" : "power-unknown";
  }
  if (!manual && lastAttempt > 0 && Date.now() < lastAttempt + preferences.embeddingIntervalMinutes * 60_000) return "interval";
}
