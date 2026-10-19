const fs = require("node:fs");
const path = require("node:path");

// Preferences → Read Aloud. Like Voice memos, the Electron main process
// saves these in the config file and the Next server reads them from there
// while it runs, so changes apply without a restart. A web deployment uses the
// LIBERA_TTS_* variables.
const TTS_ENGINES = ["local", "openrouter"];
const MIN_SPEED = 0.5;
const MAX_SPEED = 2;
const DEFAULT_TTS_PREFERENCES = Object.freeze({
  // OpenRouter works with the API key alone; Kokoro on this computer needs its weights first.
  engine: "openrouter",
  // Kokoro 82M on OpenRouter: the same voices as on this computer, for well under a dollar per million characters.
  openRouterModel: "hexgrad/kokoro-82m",
  openRouterVoice: "af_heart",
  modelDirectory: "",
  localVoice: "af_heart",
  speed: 1,
});

function normalizePath(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) return "";
  return path.resolve(trimmed);
}

function normalizeModelId(value) {
  const model = typeof value === "string" ? value.trim() : "";
  return model && model.length <= 200 && !/[\u0000-\u001f\u007f\s]/.test(model) ? model : "";
}

/** A provider's voice name, such as af_heart, alloy or en-US-Harper:MAI-Voice-2. */
function normalizeVoice(value) {
  const voice = typeof value === "string" ? value.trim() : "";
  return voice && voice.length <= 120 && !/[\u0000-\u001f\u007f\s]/.test(voice) ? voice : "";
}

function normalizeSpeed(value) {
  const speed = typeof value === "string" ? Number.parseFloat(value) : value;
  if (typeof speed !== "number" || !Number.isFinite(speed)) return DEFAULT_TTS_PREFERENCES.speed;
  return Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed)) * 100) / 100;
}

function normalizeTtsPreferences(input) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};

  return {
    engine: TTS_ENGINES.includes(value.engine) ? value.engine : DEFAULT_TTS_PREFERENCES.engine,
    openRouterModel: normalizeModelId(value.openRouterModel) || DEFAULT_TTS_PREFERENCES.openRouterModel,
    // Empty sends none, for providers with a default voice.
    openRouterVoice: typeof value.openRouterVoice === "string" ? normalizeVoice(value.openRouterVoice) : DEFAULT_TTS_PREFERENCES.openRouterVoice,
    // The extracted sherpa-onnx Kokoro folder (model.onnx, voices.bin, tokens.txt, espeak-ng-data/).
    modelDirectory: normalizePath(value.modelDirectory),
    localVoice: normalizeVoice(value.localVoice) || DEFAULT_TTS_PREFERENCES.localVoice,
    speed: normalizeSpeed(value.speed),
  };
}

// Each Kokoro voice is a 510 × 256 float32 style table in voices.bin.
const KOKORO_VOICE_BYTES = 510 * 256 * 4;

/**
 * What a chosen Kokoro folder holds, for Preferences to report right away:
 * the files sherpa-onnx needs that are missing, and how many voices it has.
 * src/lib/tts/kokoro.ts applies the same rules when reading aloud.
 */
function inspectKokoroFolder(directory) {
  const folder = normalizePath(directory);
  if (!folder) return { ok: false, exists: false, missing: [], voices: 0, quantized: false };
  let entries;
  try {
    entries = fs.readdirSync(folder);
  } catch {
    return { ok: false, exists: false, missing: [], voices: 0, quantized: false };
  }
  const isFile = (name) => { try { return fs.statSync(path.join(folder, name)).isFile(); } catch { return false; } };
  const isDirectory = (name) => { try { return fs.statSync(path.join(folder, name)).isDirectory(); } catch { return false; } };
  const hasModel = entries.some((name) => name.toLowerCase().endsWith(".onnx"));
  const missing = [
    !hasModel && "model.onnx",
    !isFile("voices.bin") && "voices.bin",
    !isFile("tokens.txt") && "tokens.txt",
    !isDirectory("espeak-ng-data") && "espeak-ng-data/",
  ].filter(Boolean);
  let voices = 0;
  try {
    voices = Math.round(fs.statSync(path.join(folder, "voices.bin")).size / KOKORO_VOICE_BYTES);
  } catch {
    // Reported as missing above.
  }
  return { ok: missing.length === 0, exists: true, missing, voices, quantized: entries.includes("model.int8.onnx") };
}

/** Preferences from LIBERA_TTS_* variables, for deployments without the desktop config file. */
function ttsPreferencesFromEnvironment(env = process.env) {
  return normalizeTtsPreferences({
    engine: env.LIBERA_TTS_ENGINE,
    openRouterModel: env.LIBERA_TTS_OPENROUTER_MODEL,
    openRouterVoice: env.LIBERA_TTS_OPENROUTER_VOICE,
    modelDirectory: env.LIBERA_TTS_MODEL_DIR,
    localVoice: env.LIBERA_TTS_VOICE,
    speed: env.LIBERA_TTS_SPEED,
  });
}

module.exports = {
  DEFAULT_TTS_PREFERENCES,
  MAX_SPEED,
  MIN_SPEED,
  TTS_ENGINES,
  inspectKokoroFolder,
  normalizeTtsPreferences,
  ttsPreferencesFromEnvironment,
};
