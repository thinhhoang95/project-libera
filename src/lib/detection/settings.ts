import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  DETECTION_VARIANTS,
  detectionPreferencesFromEnvironment,
  normalizeDetectionPreferences,
  type DetectionPreferences,
  type DetectionVariantId,
} from "../../../electron/detection-preferences.cjs";
import { defaultModelDirectory } from "@/lib/models/downloader";

export type { DetectionPreferences, DetectionVariantId };

let cached: { key: string; preferences: DetectionPreferences } | null = null;

/** Preferences → Detection and Segmentation, read from the desktop config file so changes apply while the app runs. */
export function getDetectionPreferences(): DetectionPreferences {
  const configPath = process.env.LIBERA_CONFIG_PATH;
  if (!configPath) return detectionPreferencesFromEnvironment();

  let key = `${configPath}:missing`;
  try {
    const stats = statSync(configPath);
    key = `${configPath}:${stats.ino}:${stats.mtimeMs}:${stats.size}`;
  } catch {
    // Fall back to the environment below.
  }
  if (cached?.key === key) return cached.preferences;

  let preferences: DetectionPreferences;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { detection?: unknown };
    preferences = config.detection ? normalizeDetectionPreferences(config.detection) : detectionPreferencesFromEnvironment();
  } catch {
    preferences = detectionPreferencesFromEnvironment();
  }
  cached = { key, preferences };
  return preferences;
}

/** The folder from Preferences, or Libera's download folder: the weights, and the Python runtime in `runtime/`. */
export function detectionDirectory() {
  return getDetectionPreferences().modelDirectory || defaultModelDirectory("detection");
}

export function detectionVariant(id: string) {
  return DETECTION_VARIANTS.find((variant) => variant.id === id) ?? null;
}

/** The worker script: Electron passes its location; `next dev` and `next start` run from the project. */
export function detectionWorkerPath() {
  return process.env.LIBERA_DETECTION_WORKER_PATH
    || path.join(/*turbopackIgnore: true*/ process.cwd(), "electron", "detection-worker.py");
}
