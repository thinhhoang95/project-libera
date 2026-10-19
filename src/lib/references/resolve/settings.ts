import { readFileSync, statSync } from "node:fs";

// Preferences → AI → References, read like the other AI preferences: from the
// desktop config file while the app runs (so a change applies to the next
// lookup), else from the environment Electron passes to the server
// (electron/ai-preferences.cjs). Plain `next dev` uses the defaults.

export type ReferenceResolveSettings = {
  /** Query Crossref, DataCite, arXiv, OpenAlex, PubMed and Open Library. Default on. */
  lookupOnline: boolean;
  /** Use the model when no source is found (and to read PDFs without identifiers). Default on. */
  useAi: boolean;
  /** Let the model search the web unless a request says otherwise. Default off. */
  webSearchDefault: boolean;
  /** Sent as `mailto` to Crossref and OpenAlex (their polite pools). Empty by default; never filled in by Libera. */
  contactEmail: string;
  /** Create entries for PDFs added to a notebook. Default off; a notebook's `autoCreateForPdfs` setting overrides it. */
  autoCreateForPdfs: boolean;
};

export const DEFAULT_REFERENCE_SETTINGS: ReferenceResolveSettings = {
  lookupOnline: true,
  useAi: true,
  webSearchDefault: false,
  contactEmail: "",
  autoCreateForPdfs: false,
};

/** Environment names, as electron/ai-preferences.cjs writes them. */
export const REFERENCE_SETTINGS_ENV = {
  lookupOnline: "LIBERA_REFERENCES_LOOKUP_ONLINE",
  useAi: "LIBERA_REFERENCES_USE_AI",
  webSearchDefault: "LIBERA_REFERENCES_WEB_SEARCH",
  contactEmail: "LIBERA_REFERENCES_CONTACT_EMAIL",
  autoCreateForPdfs: "LIBERA_REFERENCES_AUTO_CREATE_PDFS",
} as const;

const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

export function normalizeContactEmail(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length <= 254 && EMAIL.test(text) ? text : "";
}

function flag(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

/** Stored preferences (`aiFunctions.references` in the config file) or environment values → settings. */
export function normalizeReferenceSettings(input: Record<string, unknown> | undefined): ReferenceResolveSettings {
  return {
    lookupOnline: flag(input?.lookupOnline, DEFAULT_REFERENCE_SETTINGS.lookupOnline),
    useAi: flag(input?.useAi, DEFAULT_REFERENCE_SETTINGS.useAi),
    webSearchDefault: flag(input?.webSearch, DEFAULT_REFERENCE_SETTINGS.webSearchDefault),
    contactEmail: normalizeContactEmail(input?.contactEmail),
    autoCreateForPdfs: flag(input?.autoCreateForPdfs, DEFAULT_REFERENCE_SETTINGS.autoCreateForPdfs),
  };
}

function fromEnvironment() {
  return normalizeReferenceSettings({
    lookupOnline: process.env[REFERENCE_SETTINGS_ENV.lookupOnline],
    useAi: process.env[REFERENCE_SETTINGS_ENV.useAi],
    webSearch: process.env[REFERENCE_SETTINGS_ENV.webSearchDefault],
    contactEmail: process.env[REFERENCE_SETTINGS_ENV.contactEmail],
    autoCreateForPdfs: process.env[REFERENCE_SETTINGS_ENV.autoCreateForPdfs],
  });
}

let cached: { key: string; settings: ReferenceResolveSettings } | null = null;

export function getReferenceResolveSettings(): ReferenceResolveSettings {
  const configPath = process.env.LIBERA_CONFIG_PATH;
  if (!configPath) return fromEnvironment();
  let key = `${configPath}:missing`;
  try {
    const stats = statSync(configPath);
    key = `${configPath}:${stats.ino}:${stats.mtimeMs}:${stats.size}`;
  } catch {
    return fromEnvironment();
  }
  if (cached?.key === key) return cached.settings;
  let settings: ReferenceResolveSettings;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { aiFunctions?: { references?: Record<string, unknown> } };
    settings = config.aiFunctions?.references ? normalizeReferenceSettings(config.aiFunctions.references) : fromEnvironment();
  } catch {
    settings = fromEnvironment();
  }
  cached = { key, settings };
  return settings;
}
