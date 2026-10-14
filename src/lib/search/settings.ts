import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultSearchIndexFile,
  normalizeSearchPreferences,
  searchPreferencesFromEnvironment,
  type SearchPreferences,
} from "../../../electron/search-preferences.cjs";
import { getAdminRoot } from "@/lib/storage/paths";

export type { SearchPreferences };

let cached: { key: string; preferences: SearchPreferences } | null = null;

/** Preferences → Search, read from the desktop config file so changes apply while the app runs. */
export function getSearchPreferences(): SearchPreferences {
  const configPath = process.env.LIBERA_CONFIG_PATH;
  if (!configPath) return searchPreferencesFromEnvironment();

  let key = `${configPath}:missing`;
  try {
    const stats = statSync(configPath);
    key = `${configPath}:${stats.mtimeMs}:${stats.size}`;
  } catch {
    // Fall back to the environment below.
  }

  if (cached?.key === key) return cached.preferences;

  let preferences: SearchPreferences;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { search?: unknown };
    preferences = config.search ? normalizeSearchPreferences(config.search) : searchPreferencesFromEnvironment();
  } catch {
    preferences = searchPreferencesFromEnvironment();
  }

  cached = { key, preferences };
  return preferences;
}

/** The index's SQLite file: the one chosen in Preferences, or the default. */
export function searchIndexFile(preferences = getSearchPreferences()) {
  return preferences.indexFile || defaultSearchIndexFile({ adminRoot: getAdminRoot(), configPath: process.env.LIBERA_CONFIG_PATH });
}

/** The worker script: Electron passes its location; `next dev` and `next start` run from the project. */
export function searchWorkerPath() {
  return process.env.LIBERA_SEARCH_WORKER_PATH || path.join(/*turbopackIgnore: true*/ process.cwd(), "electron", "search-worker.mjs");
}

/** Leave half the cores to the rest of the computer while indexing in the background. */
export function searchWorkerThreads() {
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}
