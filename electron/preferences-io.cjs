const BACKUP_FORMAT = "libera-preferences";
const BACKUP_VERSION = 1;

const PREFERENCE_KEYS = Object.freeze([
  "themePreference",
  "yourName",
  "dataDir",
  "markdownInlineMathMarkers",
  "markdownBlockMathMarkers",
  "markdownEditorFontFamily",
  "wysiwygEditorFontFamily",
  "renderedMarkdownFontFamily",
  "markdownBaseFontSize",
  "markdownBaseLineHeight",
  "markdownPdfBaseFontSize",
  "markdownPdfBaseLineHeight",
  "openaiApiKey",
  "openRouterModel",
  "aiFunctions",
  "quickPrompts",
  "passwordHash",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function createPreferencesBackup(config, exportedAt = new Date().toISOString()) {
  const preferences = {};

  for (const key of PREFERENCE_KEYS) {
    if (Object.hasOwn(config, key)) preferences[key] = config[key];
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    preferences,
  };
}

function parsePreferencesBackup(value) {
  if (!isRecord(value) || value.format !== BACKUP_FORMAT) {
    throw new Error("This is not a Libera preferences backup.");
  }

  if (value.version !== BACKUP_VERSION) {
    throw new Error(`Unsupported Libera preferences backup version: ${String(value.version)}.`);
  }

  if (!isRecord(value.preferences)) {
    throw new Error("The Libera preferences backup is missing its preferences object.");
  }

  return Object.fromEntries(
    PREFERENCE_KEYS.filter((key) => Object.hasOwn(value.preferences, key)).map((key) => [
      key,
      value.preferences[key],
    ]),
  );
}

module.exports = {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  PREFERENCE_KEYS,
  createPreferencesBackup,
  parsePreferencesBackup,
};
