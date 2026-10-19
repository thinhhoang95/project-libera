import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeTtsPreferences,
  ttsPreferencesFromEnvironment,
  type TtsPreferences,
} from "../../../electron/tts-preferences.cjs";

export type { TtsPreferences };

let cached: { key: string; preferences: TtsPreferences } | null = null;

/** Preferences → Read Aloud, read from the desktop config file so changes apply while the app runs. */
export function getTtsPreferences(): TtsPreferences {
  const configPath = process.env.LIBERA_CONFIG_PATH;
  if (!configPath) return ttsPreferencesFromEnvironment();

  let key = `${configPath}:missing`;
  try {
    const stats = statSync(configPath);
    key = `${configPath}:${stats.ino}:${stats.mtimeMs}:${stats.size}`;
  } catch {
    // Fall back to the environment below.
  }
  if (cached?.key === key) return cached.preferences;

  let preferences: TtsPreferences;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { tts?: unknown };
    preferences = config.tts ? normalizeTtsPreferences(config.tts) : ttsPreferencesFromEnvironment();
  } catch {
    preferences = ttsPreferencesFromEnvironment();
  }
  cached = { key, preferences };
  return preferences;
}

/** The worker script: Electron passes its location; `next dev` and `next start` run from the project. */
export function ttsWorkerPath() {
  return process.env.LIBERA_TTS_WORKER_PATH
    || path.join(/*turbopackIgnore: true*/ process.cwd(), "electron", "tts-worker.mjs");
}

/** Up to four threads, leaving the rest of the computer responsive while it speaks. */
export function ttsThreads() {
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, cores - 2));
}
