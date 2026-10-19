const { createHash } = require("node:crypto");
const path = require("node:path");

// Preferences → Search. The Electron main process saves these in the config
// file and the Next server reads them from there while it runs, so changes
// apply without a restart. A web deployment uses the LIBERA_SEARCH_* variables.
const SEARCH_DIMENSIONS = [768, 512, 256, 128];
const SEARCH_VISION_TOKENS = [70, 140, 280, 560, 1120];
const DEFAULT_SEARCH_PREFERENCES = Object.freeze({
  textWeights: "",
  visionWeights: "",
  dimensions: 768,
  visionTokens: 140,
  indexImages: true,
  backgroundIndexing: true,
  indexFile: "",
  readingModelDirectory: "",
});
const INDEX_FILE_NAME = "libera-search.sqlite";
// Each local model's subfolder of the default models folder.
const MODEL_FOLDERS = Object.freeze({
  search: "embeddinggemma-2-ONNX",
  reading: "granite-docling-258M",
  readAloud: "kokoro-int8-multi-lang-v1_0",
  speech: "speech",
});

function normalizePath(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) return "";
  return path.resolve(trimmed);
}

function normalizeChoice(value, choices, fallback) {
  const number = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return choices.includes(number) ? number : fallback;
}

function normalizeSearchPreferences(input) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};

  return {
    textWeights: normalizePath(value.textWeights),
    visionWeights: normalizePath(value.visionWeights),
    dimensions: normalizeChoice(value.dimensions, SEARCH_DIMENSIONS, DEFAULT_SEARCH_PREFERENCES.dimensions),
    visionTokens: normalizeChoice(value.visionTokens, SEARCH_VISION_TOKENS, DEFAULT_SEARCH_PREFERENCES.visionTokens),
    indexImages: typeof value.indexImages === "boolean" ? value.indexImages : DEFAULT_SEARCH_PREFERENCES.indexImages,
    backgroundIndexing: typeof value.backgroundIndexing === "boolean"
      ? value.backgroundIndexing
      : DEFAULT_SEARCH_PREFERENCES.backgroundIndexing,
    // Earlier versions named a folder; its index file had a fixed name.
    indexFile: normalizePath(value.indexFile) ||
      (normalizePath(value.indexDirectory) ? path.join(normalizePath(value.indexDirectory), INDEX_FILE_NAME) : ""),
    // The PDF reading model (granite-docling): a folder like its Hugging Face repository; empty uses Libera's download.
    readingModelDirectory: normalizePath(value.readingModelDirectory),
  };
}

/**
 * The index file when Preferences names none. The desktop app keeps it on this
 * computer, beside its config and outside the Master directory, so a notes
 * folder synced to the cloud never uploads it; one index per Master directory.
 * On Windows that is Local, not Roaming, application data. A server without
 * the desktop config keeps it with its own data.
 */
function defaultSearchIndexFile({ adminRoot, configPath, platform = process.platform, localAppData = process.env.LOCALAPPDATA }) {
  if (!configPath) return path.join(adminRoot, ".libera", "search", INDEX_FILE_NAME);
  const library = createHash("sha256").update(path.resolve(adminRoot)).digest("hex").slice(0, 16);
  return path.join(localDataDirectory(configPath, platform, localAppData), "search-index", library, INDEX_FILE_NAME);
}

/** Libera's application data on this computer: beside the config, or Local on Windows. */
function localDataDirectory(configPath, platform, localAppData) {
  const appData = path.dirname(configPath);
  return platform === "win32" && localAppData ? path.join(localAppData, path.basename(appData)) : appData;
}

/**
 * Where Libera downloads its local models when Preferences names no folder:
 * like the index, on this computer in its application data, shared by every
 * Master directory. A server without the desktop config keeps them with its data.
 */
function defaultModelsDirectory({ adminRoot, configPath, platform = process.platform, localAppData = process.env.LOCALAPPDATA }) {
  if (!configPath) return path.join(adminRoot, ".libera", "models");
  return path.join(localDataDirectory(configPath, platform, localAppData), "models");
}

/** Preferences from LIBERA_SEARCH_* variables, for deployments without the desktop config file. */
function searchPreferencesFromEnvironment(env = process.env) {
  return normalizeSearchPreferences({
    textWeights: env.LIBERA_SEARCH_TEXT_WEIGHTS,
    visionWeights: env.LIBERA_SEARCH_VISION_WEIGHTS,
    dimensions: env.LIBERA_SEARCH_DIMENSIONS,
    visionTokens: env.LIBERA_SEARCH_VISION_TOKENS,
    indexImages: env.LIBERA_SEARCH_INDEX_IMAGES === undefined ? undefined : env.LIBERA_SEARCH_INDEX_IMAGES !== "0",
    backgroundIndexing: env.LIBERA_SEARCH_BACKGROUND_INDEXING === undefined
      ? undefined
      : env.LIBERA_SEARCH_BACKGROUND_INDEXING !== "0",
    indexFile: env.LIBERA_SEARCH_INDEX_FILE,
    indexDirectory: env.LIBERA_SEARCH_INDEX_DIR,
    readingModelDirectory: env.LIBERA_READING_MODEL_DIR,
  });
}

module.exports = {
  DEFAULT_SEARCH_PREFERENCES,
  INDEX_FILE_NAME,
  MODEL_FOLDERS,
  SEARCH_DIMENSIONS,
  SEARCH_VISION_TOKENS,
  defaultModelsDirectory,
  defaultSearchIndexFile,
  normalizeSearchPreferences,
  searchPreferencesFromEnvironment,
};
