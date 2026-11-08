// Preferences backups. The plain backup (version 1) is wrapped for export in
// an encrypted envelope (version 2) keyed by the master password, the same
// way the collaboration sign-in is shared through the synced library folder
// (electron/collab/control/shared-sign-in.ts): scrypt derives a 256-bit key,
// AES-256-GCM encrypts the plain backup, and the header (format, version, KDF
// parameters and salt) is authenticated with it so it cannot be swapped.
// Version 1 files written before encryption existed can still be loaded.

const { createCipheriv, createDecipheriv, randomBytes, scrypt: scryptCallback } = require("node:crypto");

const BACKUP_FORMAT = "libera-preferences";
const BACKUP_VERSION = 1;
const ENCRYPTED_BACKUP_VERSION = 2;

/** ~0.3 s and 128 MiB per derivation: slows guessing of a leaked backup. */
const KDF = Object.freeze({ N: 2 ** 17, r: 8, p: 1 });
/** Backups from elsewhere may ask for more; refuse parameters that would exhaust memory. */
const KDF_LIMITS = Object.freeze({ minN: 2 ** 14, maxN: 2 ** 20, maxR: 16, maxP: 4 });
const MAX_KDF_MEMORY = 128 * 1024 * 1024;
const MAX_KDF_WORK = KDF.N * KDF.r;

const PREFERENCE_KEYS = Object.freeze([
  "themePreference",
  "yourName",
  "smartPaste",
  "sourceEditor",
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
  "markdownHeadingColor",
  "markdownHeadingPalette",
  "markdownBoldLeadIns",
  "markdownEditorThemes",
  "notebookIllustrations",
  "openaiApiKey",
  "openRouterModel",
  "aiFunctions",
  "quickPrompts",
  "latexSnippets",
  "search",
  "transcription",
  "tts",
  "detection",
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

class PreferencesBackupPasswordError extends Error {
  constructor() {
    super("The master password does not open this preferences backup.");
    this.name = "PreferencesBackupPasswordError";
    this.code = "wrong-password";
  }
}

function validKdf(kdf) {
  return (
    isRecord(kdf) &&
    kdf.name === "scrypt" &&
    Number.isInteger(kdf.N) &&
    kdf.N >= KDF_LIMITS.minN &&
    kdf.N <= KDF_LIMITS.maxN &&
    (kdf.N & (kdf.N - 1)) === 0 &&
    Number.isInteger(kdf.r) &&
    kdf.r >= 1 &&
    kdf.r <= KDF_LIMITS.maxR &&
    Number.isInteger(kdf.p) &&
    kdf.p >= 1 &&
    kdf.p <= KDF_LIMITS.maxP &&
    128 * kdf.N * kdf.r <= MAX_KDF_MEMORY &&
    kdf.N * kdf.r * kdf.p <= MAX_KDF_WORK &&
    typeof kdf.salt === "string" &&
    kdf.salt.length === 24 &&
    Buffer.from(kdf.salt, "base64").length === 16 &&
    Buffer.from(kdf.salt, "base64").toString("base64") === kdf.salt
  );
}

function deriveKey(password, kdf) {
  const options = { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r + 32 * 1024 * 1024 };
  return new Promise((resolve, reject) => {
    scryptCallback(password, Buffer.from(kdf.salt, "base64"), 32, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

function additionalData(kdf) {
  return Buffer.from(JSON.stringify([BACKUP_FORMAT, ENCRYPTED_BACKUP_VERSION, kdf.name, kdf.N, kdf.r, kdf.p, kdf.salt]));
}

function assertPassword(password) {
  if (typeof password !== "string" || password.length === 0) {
    throw new TypeError("A master password is required to encrypt or open a preferences backup.");
  }
}

function isEncryptedPreferencesBackup(value) {
  return isRecord(value) && value.format === BACKUP_FORMAT && value.version === ENCRYPTED_BACKUP_VERSION;
}

/**
 * Encrypts a backup from createPreferencesBackup with the master password.
 * `params` lets tests use a cheaper scrypt; it must still be within the limits.
 */
async function encryptPreferencesBackup(backup, password, params = KDF) {
  assertPassword(password);
  const kdf = { name: "scrypt", N: params.N, r: params.r, p: params.p, salt: randomBytes(16).toString("base64") };
  if (!validKdf(kdf)) throw new TypeError("Unsafe preferences backup KDF parameters.");

  const key = await deriveKey(password, kdf);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(additionalData(kdf));
    const data = Buffer.concat([cipher.update(JSON.stringify(backup), "utf8"), cipher.final(), cipher.getAuthTag()]);
    return {
      format: BACKUP_FORMAT,
      version: ENCRYPTED_BACKUP_VERSION,
      kdf,
      iv: iv.toString("base64"),
      data: data.toString("base64"),
    };
  } finally {
    key.fill(0);
  }
}

/** Returns the plain (version 1) backup inside an encrypted envelope. */
async function decryptPreferencesBackup(value, password) {
  assertPassword(password);
  if (!isEncryptedPreferencesBackup(value)) throw new Error("This is not an encrypted Libera preferences backup.");
  if (!validKdf(value.kdf)) throw new Error("The preferences backup uses unsupported or unsafe encryption settings.");
  const iv = typeof value.iv === "string" ? Buffer.from(value.iv, "base64") : Buffer.alloc(0);
  const data = typeof value.data === "string" ? Buffer.from(value.data, "base64") : Buffer.alloc(0);
  if (iv.length !== 12 || data.length < 17) throw new Error("The encrypted preferences backup is damaged.");

  const key = await deriveKey(password, value.kdf);
  let text;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(additionalData(value.kdf));
    decipher.setAuthTag(data.subarray(data.length - 16));
    text = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    // GCM cannot tell a wrong password from a modified file.
    throw new PreferencesBackupPasswordError();
  } finally {
    key.fill(0);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The encrypted preferences backup is damaged.");
  }
}

/**
 * The preferences in a parsed backup file: encrypted backups need the master
 * password they were exported with; older plain backups ignore it.
 */
async function readPreferencesBackup(value, password) {
  if (isEncryptedPreferencesBackup(value)) {
    const inner = await decryptPreferencesBackup(value, password);
    if (!isRecord(inner) || inner.version !== BACKUP_VERSION) {
      throw new Error("The encrypted preferences backup is damaged.");
    }
    return parsePreferencesBackup(inner);
  }
  return parsePreferencesBackup(value);
}

module.exports = {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  ENCRYPTED_BACKUP_VERSION,
  PreferencesBackupPasswordError,
  encryptPreferencesBackup,
  decryptPreferencesBackup,
  isEncryptedPreferencesBackup,
  readPreferencesBackup,
  PREFERENCE_KEYS,
  createPreferencesBackup,
  parsePreferencesBackup,
};
