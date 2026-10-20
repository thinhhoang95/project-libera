const path = require("node:path");

// Preferences → Speech: voice memos and dictation. Like Preferences → Search, the Electron main
// process saves these in the config file and the Next server reads them from
// there while it runs, so changes apply without a restart. A web deployment
// uses the LIBERA_TRANSCRIPTION_* variables.
const TRANSCRIPTION_ENGINES = ["local", "openrouter"];
/** Dictation can follow the voice memo engine ("same") or use its own. */
const DICTATION_ENGINES = ["same", "local", "openrouter"];
const MAX_SPEAKERS = 12;
const DEFAULT_TRANSCRIPTION_PREFERENCES = Object.freeze({
  engine: "local",
  openRouterModel: "openai/whisper-large-v3",
  language: "",
  modelDirectory: "",
  diarization: true,
  speakers: 0,
  ffmpegPath: "",
  dictation: Object.freeze({ engine: "same", openRouterModel: "", language: "" }),
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

/** An ISO-639-1 code such as "en" or "vi"; empty detects the language. */
function normalizeLanguage(value) {
  const language = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z]{2,3}$/.test(language) ? language : "";
}

function normalizeTranscriptionPreferences(input) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const speakers = typeof value.speakers === "string" ? Number.parseInt(value.speakers, 10) : value.speakers;

  return {
    engine: TRANSCRIPTION_ENGINES.includes(value.engine) ? value.engine : DEFAULT_TRANSCRIPTION_PREFERENCES.engine,
    openRouterModel: normalizeModelId(value.openRouterModel) || DEFAULT_TRANSCRIPTION_PREFERENCES.openRouterModel,
    language: normalizeLanguage(value.language),
    // One folder for every local speech model, laid out as Libera downloads them.
    modelDirectory: normalizePath(value.modelDirectory),
    diarization: typeof value.diarization === "boolean" ? value.diarization : DEFAULT_TRANSCRIPTION_PREFERENCES.diarization,
    // 0 lets clustering decide how many people speak.
    speakers: Number.isInteger(speakers) && speakers >= 0 && speakers <= MAX_SPEAKERS ? speakers : 0,
    ffmpegPath: normalizePath(value.ffmpegPath),
    dictation: normalizeDictationPreferences(value.dictation),
  };
}

/** Empty model and language follow the voice memo settings. */
function normalizeDictationPreferences(input) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    engine: DICTATION_ENGINES.includes(value.engine) ? value.engine : "same",
    openRouterModel: normalizeModelId(value.openRouterModel),
    language: normalizeLanguage(value.language),
  };
}

/** The engine, OpenRouter model and language dictation uses. */
function resolveDictationSettings(preferences) {
  const { dictation } = preferences;
  return {
    engine: dictation.engine === "same" ? preferences.engine : dictation.engine,
    openRouterModel: dictation.openRouterModel || preferences.openRouterModel,
    language: dictation.language || preferences.language,
  };
}

/** Preferences from LIBERA_TRANSCRIPTION_* variables, for deployments without the desktop config file. */
function transcriptionPreferencesFromEnvironment(env = process.env) {
  return normalizeTranscriptionPreferences({
    engine: env.LIBERA_TRANSCRIPTION_ENGINE,
    openRouterModel: env.LIBERA_TRANSCRIPTION_OPENROUTER_MODEL,
    language: env.LIBERA_TRANSCRIPTION_LANGUAGE,
    modelDirectory: env.LIBERA_TRANSCRIPTION_MODEL_DIR,
    diarization: env.LIBERA_TRANSCRIPTION_DIARIZATION === undefined ? undefined : env.LIBERA_TRANSCRIPTION_DIARIZATION !== "0",
    speakers: env.LIBERA_TRANSCRIPTION_SPEAKERS,
    ffmpegPath: env.LIBERA_FFMPEG_PATH,
    dictation: {
      engine: env.LIBERA_DICTATION_ENGINE,
      openRouterModel: env.LIBERA_DICTATION_OPENROUTER_MODEL,
      language: env.LIBERA_DICTATION_LANGUAGE,
    },
  });
}

module.exports = {
  DEFAULT_TRANSCRIPTION_PREFERENCES,
  DICTATION_ENGINES,
  MAX_SPEAKERS,
  TRANSCRIPTION_ENGINES,
  normalizeTranscriptionPreferences,
  resolveDictationSettings,
  transcriptionPreferencesFromEnvironment,
};
