import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  normalizeTranscriptionPreferences,
  transcriptionPreferencesFromEnvironment,
  type TranscriptionPreferences,
} from "../../../electron/transcription-preferences.cjs";

export type { TranscriptionPreferences };

let cached: { key: string; preferences: TranscriptionPreferences } | null = null;

/** Preferences → Speech, read from the desktop config file so changes apply while the app runs. */
export function getTranscriptionPreferences(): TranscriptionPreferences {
  const configPath = process.env.LIBERA_CONFIG_PATH;
  if (!configPath) return transcriptionPreferencesFromEnvironment();

  let key = `${configPath}:missing`;
  try {
    const stats = statSync(configPath);
    key = `${configPath}:${stats.ino}:${stats.mtimeMs}:${stats.size}`;
  } catch {
    // Fall back to the environment below.
  }
  if (cached?.key === key) return cached.preferences;

  let preferences: TranscriptionPreferences;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { transcription?: unknown };
    preferences = config.transcription ? normalizeTranscriptionPreferences(config.transcription) : transcriptionPreferencesFromEnvironment();
  } catch {
    preferences = transcriptionPreferencesFromEnvironment();
  }
  cached = { key, preferences };
  return preferences;
}

/** The worker script: Electron passes its location; `next dev` and `next start` run from the project. */
export function transcriptionWorkerPath() {
  return process.env.LIBERA_TRANSCRIPTION_WORKER_PATH
    || path.join(/*turbopackIgnore: true*/ process.cwd(), "electron", "transcription-worker.mjs");
}

/** Up to four threads, leaving the rest of the computer responsive during a long recording. */
export function transcriptionThreads() {
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, cores - 2));
}

export type AudioDecoder = { kind: "ffmpeg" | "afconvert" | "wav-only"; path: string };

async function executable(candidate: string) {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function lookUpOnPath(command: string) {
  return new Promise<string>((resolve) => {
    execFile(process.platform === "win32" ? "where" : "which", [command], { timeout: 3000, windowsHide: true }, (error, stdout) => {
      resolve(error ? "" : stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "");
    });
  });
}

/** Where package managers put ffmpeg. An app opened from the Dock or Start menu does not see the shell's PATH. */
function commonFfmpegLocations() {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? "";
    const home = os.homedir();
    return [
      path.join(local, "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
      path.join(home, "scoop", "shims", "ffmpeg.exe"),
      "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe",
      "C:\\ffmpeg\\bin\\ffmpeg.exe",
    ];
  }
  return ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg", "/opt/local/bin/ffmpeg", "/snap/bin/ffmpeg"];
}

let decoderCache: { key: string; at: number; decoder: AudioDecoder } | null = null;

/**
 * How recordings are decoded: the ffmpeg chosen in Preferences, one found on
 * this computer, macOS's built-in afconvert, or (with neither) WAV files only.
 */
export async function findAudioDecoder(preferences = getTranscriptionPreferences()): Promise<AudioDecoder> {
  const key = preferences.ffmpegPath;
  if (decoderCache?.key === key && Date.now() - decoderCache.at < 60_000) return decoderCache.decoder;

  let decoder: AudioDecoder = { kind: "wav-only", path: "" };
  const candidates = [preferences.ffmpegPath, await lookUpOnPath("ffmpeg"), ...commonFfmpegLocations()].filter(Boolean);
  for (const candidate of candidates) {
    if (await executable(candidate)) {
      decoder = { kind: "ffmpeg", path: candidate };
      break;
    }
  }
  if (decoder.kind === "wav-only" && process.platform === "darwin" && await executable("/usr/bin/afconvert")) {
    decoder = { kind: "afconvert", path: "/usr/bin/afconvert" };
  }
  decoderCache = { key, at: Date.now(), decoder };
  return decoder;
}
