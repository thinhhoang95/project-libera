// Markdown and LaTeX editor themes, shared by Preferences (Electron) and the
// Next server. A theme sets the page background, the text color and the
// heading colors (H1–H4, H5 and smaller, and list markers with bold lead-ins),
// with its own set for the light and the dark app theme, and two typefaces: a
// text font (the visual editor, rendered previews and PDF export) and a code
// font (the Markdown source, LaTeX and code editors); "" is the system font.
// The visual editor, the Markdown source editors and the LaTeX editor each
// pick a theme, or "default" to keep the app colors, plain headings and system
// fonts; rendered previews take the visual editor's heading colors and text
// font. The editors derive their borders,
// gutters and muted fills from the page colors (globals.css,
// [data-editor-theme-*]). Built-in themes are fixed; the user's own are
// stored with the preferences.
const { normalizeMarkdownHeadingColor, normalizeMarkdownHeadingPalette } = require("./markdown-accents.cjs");

const EDITOR_THEME_SCOPES = Object.freeze(["visual", "source", "latex"]);
const EDITOR_THEME_COLOR_KEYS = Object.freeze(["background", "text", "h1", "h2", "h3", "h4", "h5", "lists"]);
const HEADING_KEYS = ["h1", "h2", "h3", "h4", "h5", "lists"];
const DEFAULT_EDITOR_THEME_ID = "default";
const MAX_EDITOR_THEMES = 100;
const MAX_EDITOR_THEME_NAME_LENGTH = 60;
const EDITOR_THEMES_FILE_FORMAT = "libera-editor-themes";
const EDITOR_THEMES_FILE_VERSION = 1;
// Version 2 holds the fonts that used to be set apart from themes.
const EDITOR_THEMES_VERSION = 2;
const MAX_EDITOR_THEME_FONT_LENGTH = 256;
// The font settings' old "system" values.
const SYSTEM_FONT_IDS = ["system-sans", "system-monospace"];

// The app's own page colors (--card and --foreground in globals.css).
const APP_PAGE = Object.freeze({
  light: Object.freeze({ background: "#ffffff", text: "#18181b" }),
  dark: Object.freeze({ background: "#18181b", text: "#f4f4f5" }),
});

function headings(h1, h2 = h1, h3 = h1, h4 = h1, h5 = h1, lists = h2) {
  return { h1, h2, h3, h4, h5, lists };
}

// The former heading accents keep the app page and color every heading alike.
function accentTheme(id, name, light, dark) {
  return { id, name, light: { ...APP_PAGE.light, ...headings(light) }, dark: { ...APP_PAGE.dark, ...headings(dark) } };
}

const BUILT_IN_EDITOR_THEMES = Object.freeze([
  accentTheme("blue", "Blue", "#1d4ed8", "#93c5fd"),
  accentTheme("indigo", "Indigo", "#4338ca", "#a5b4fc"),
  accentTheme("teal", "Teal", "#0f766e", "#5eead4"),
  accentTheme("green", "Green", "#15803d", "#86efac"),
  accentTheme("purple", "Purple", "#7e22ce", "#d8b4fe"),
  accentTheme("rose", "Rose", "#be123c", "#fda4af"),
  accentTheme("orange", "Orange", "#c2410c", "#fdba74"),
  { id: "spectrum", name: "Spectrum",
    light: { ...APP_PAGE.light, ...headings("#4338ca", "#1d4ed8", "#0f766e", "#15803d", "#475569") },
    dark: { ...APP_PAGE.dark, ...headings("#a5b4fc", "#93c5fd", "#5eead4", "#86efac", "#cbd5e1") } },
  { id: "plain", name: "Plain",
    light: { ...APP_PAGE.light, ...headings(APP_PAGE.light.text) },
    dark: { ...APP_PAGE.dark, ...headings(APP_PAGE.dark.text) } },
  { id: "paper", name: "Paper",
    light: { background: "#fbf8f1", text: "#2b2a27", ...headings("#8a3b12", "#9a4a1c", "#7a5a1e", "#5f6b2a", "#5c5650") },
    dark: { background: "#1c1b19", text: "#e8e4da", ...headings("#f0b58a", "#e8a878", "#e0c27e", "#c4cf8e", "#b5afa5") } },
  { id: "sepia", name: "Sepia",
    light: { background: "#f4ecd8", text: "#4a3b2a", ...headings("#7c2d12", "#92400e", "#78350f", "#713f12", "#6b5a45") },
    dark: { background: "#2a2219", text: "#e6d7bd", ...headings("#fdba74", "#fcd34d", "#fde68a", "#d9c48f", "#c2b49a") } },
  { id: "slate", name: "Slate",
    light: { background: "#f1f5f9", text: "#1e293b", ...headings("#1e40af", "#1d4ed8", "#0369a1", "#0f766e", "#475569") },
    dark: { background: "#0f172a", text: "#e2e8f0", ...headings("#a5b4fc", "#93c5fd", "#7dd3fc", "#5eead4", "#cbd5e1") } },
  { id: "mint", name: "Mint",
    light: { background: "#f0f7f4", text: "#1f3a33", ...headings("#065f46", "#047857", "#0f766e", "#15803d", "#4b635b") },
    dark: { background: "#10201b", text: "#d5ece3", ...headings("#6ee7b7", "#86efac", "#5eead4", "#bef264", "#a7c4b8") } },
  { id: "dusk", name: "Dusk",
    light: { background: "#f5f3ff", text: "#2e1065", ...headings("#6d28d9", "#7e22ce", "#a21caf", "#be185d", "#5b4b7a") },
    dark: { background: "#1a1625", text: "#e9e4f5", ...headings("#c4b5fd", "#d8b4fe", "#f0abfc", "#f9a8d4", "#b8acd0") } },
  { id: "contrast", name: "High contrast",
    light: { background: "#ffffff", text: "#000000", ...headings("#0000b3", "#0000b3", "#00548f", "#005c1a", "#000000") },
    dark: { background: "#000000", text: "#ffffff", ...headings("#9ecbff", "#9ecbff", "#7ee0ff", "#8dff9e", "#ffffff") } },
].map((theme) => Object.freeze({ ...theme, textFont: "", codeFont: "", builtIn: true })));

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

function normalizeThemeName(value) {
  const name = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  return name.slice(0, MAX_EDITOR_THEME_NAME_LENGTH);
}

// One appearance (light or dark) of a theme; null unless the page colors are
// valid. A missing heading color falls back to the text color.
function normalizeAppearance(value) {
  if (!isRecord(value)) return null;
  const background = normalizeColor(value.background);
  const text = normalizeColor(value.text);
  if (!background || !text) return null;
  const appearance = { background, text };
  for (const key of HEADING_KEYS) appearance[key] = normalizeColor(value[key]) ?? text;
  return appearance;
}

// A font family name, or "" for the system font.
function normalizeThemeFont(value) {
  const font = typeof value === "string" ? value.trim() : "";
  if (!font || font.length > MAX_EDITOR_THEME_FONT_LENGTH || /[\u0000-\u001f\u007f]/.test(font) || SYSTEM_FONT_IDS.includes(font)) return "";
  return font;
}

// A user theme without its id, or null when it cannot be used.
function normalizeThemeColors(value) {
  if (!isRecord(value)) return null;
  const name = normalizeThemeName(value.name);
  const light = normalizeAppearance(value.light);
  const dark = normalizeAppearance(value.dark);
  return name && light && dark
    ? { name, light, dark, textFont: normalizeThemeFont(value.textFont), codeFont: normalizeThemeFont(value.codeFont) }
    : null;
}

function isBuiltInThemeId(id) {
  return BUILT_IN_EDITOR_THEMES.some((theme) => theme.id === id);
}

// Halfway to white, as the dark theme used to lighten a custom palette.
function lighten(color) {
  const channels = [1, 3, 5].map((index) => Math.round((Number.parseInt(color.slice(index, index + 2), 16) + 255) / 2));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

// Preferences saved before editor themes had only a heading accent for the
// visual editor and previews; it becomes the visual editor's theme.
function legacyEditorThemes(legacy = {}) {
  const headingColor = normalizeMarkdownHeadingColor(legacy.headingColor);
  const preferences = { visual: DEFAULT_EDITOR_THEME_ID, source: DEFAULT_EDITOR_THEME_ID, latex: DEFAULT_EDITOR_THEME_ID, themes: [] };
  if (headingColor === "none") preferences.visual = "plain";
  else if (headingColor !== "custom") preferences.visual = headingColor;
  else {
    const palette = normalizeMarkdownHeadingPalette(legacy.headingPalette);
    const dark = Object.fromEntries(HEADING_KEYS.map((key) => [key, lighten(palette[key])]));
    preferences.themes.push({ id: "custom-headings", name: "My headings", light: { ...APP_PAGE.light, ...palette }, dark: { ...APP_PAGE.dark, ...dark }, textFont: "", codeFont: "" });
    preferences.visual = "custom-headings";
  }
  return preferences;
}

// Fonts used to be chosen apart from themes: the visual editor's text font,
// and one code font for the Markdown source, LaTeX and code editors. Each
// editor's theme takes them; a built-in theme (or the app colors) is copied
// into a theme of the user's own first, shared by the editors that used it.
function foldLegacyFonts(preferences, legacy = {}) {
  const textFont = normalizeThemeFont(legacy.textFont);
  const codeFont = normalizeThemeFont(legacy.codeFont);
  if (!textFont && !codeFont) return preferences;
  const copies = new Map();
  for (const scope of EDITOR_THEME_SCOPES) {
    const id = preferences[scope];
    let theme = preferences.themes.find((candidate) => candidate.id === id);
    if (!theme) {
      theme = copies.get(id);
      if (!theme) {
        const source = BUILT_IN_EDITOR_THEMES.find((candidate) => candidate.id === id)
          ?? { name: "App colors", light: { ...APP_PAGE.light, ...headings(APP_PAGE.light.text) }, dark: { ...APP_PAGE.dark, ...headings(APP_PAGE.dark.text) } };
        theme = { id: `custom-fonts-${id}`, name: `${source.name} with my fonts`, light: { ...source.light }, dark: { ...source.dark } };
        copies.set(id, theme);
        if (preferences.themes.length < MAX_EDITOR_THEMES) preferences.themes.push(theme);
      }
      preferences[scope] = theme.id;
    }
    theme.textFont ||= textFont;
    theme.codeFont ||= codeFont;
  }
  return preferences;
}

// Accepts the stored preference or, from the environment, its JSON. `legacy`
// holds the settings themes replaced: without a stored preference the former
// heading color and palette choose the visual editor's theme, and preferences
// saved before version 2 take the former fonts.
function normalizeEditorThemes(value, legacy) {
  let input = value;
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { input = null; }
  }
  if (!isRecord(input)) input = legacyEditorThemes(legacy);
  const migrateFonts = input.version !== EDITOR_THEMES_VERSION;

  const themes = [];
  const ids = new Set();
  for (const entry of Array.isArray(input.themes) ? input.themes : []) {
    if (themes.length >= MAX_EDITOR_THEMES) break;
    const theme = normalizeThemeColors(entry);
    const id = typeof entry?.id === "string" && /^custom-[a-z0-9-]{1,40}$/.test(entry.id) ? entry.id : "";
    if (!theme || !id || ids.has(id)) continue;
    ids.add(id);
    themes.push({ id, ...theme });
  }

  const preferences = {};
  for (const scope of EDITOR_THEME_SCOPES) {
    const id = input[scope];
    preferences[scope] = typeof id === "string" && (isBuiltInThemeId(id) || ids.has(id)) ? id : DEFAULT_EDITOR_THEME_ID;
  }
  const normalized = { version: EDITOR_THEMES_VERSION, ...preferences, themes };
  return migrateFonts ? foldLegacyFonts(normalized, legacy) : normalized;
}

// The colors each editor uses, or null where it keeps the app colors; this is
// all the renderer needs.
function resolveEditorThemes(value, legacy) {
  const preferences = normalizeEditorThemes(value, legacy);
  const resolved = {};
  for (const scope of EDITOR_THEME_SCOPES) {
    const id = preferences[scope];
    const theme = BUILT_IN_EDITOR_THEMES.find((candidate) => candidate.id === id)
      ?? preferences.themes.find((candidate) => candidate.id === id);
    resolved[scope] = theme
      ? { light: { ...theme.light }, dark: { ...theme.dark }, textFont: theme.textFont, codeFont: theme.codeFont }
      : null;
  }
  return resolved;
}

function createEditorThemesFile(themes, exportedAt = new Date().toISOString()) {
  return {
    format: EDITOR_THEMES_FILE_FORMAT,
    version: EDITOR_THEMES_FILE_VERSION,
    exportedAt,
    themes: (Array.isArray(themes) ? themes : []).map(normalizeThemeColors).filter(Boolean).slice(0, MAX_EDITOR_THEMES),
  };
}

// The themes in an exported file, without ids: the importer gives them new ones.
function parseEditorThemesFile(value) {
  if (!isRecord(value) || value.format !== EDITOR_THEMES_FILE_FORMAT) {
    throw new Error("This is not a Libera editor themes file.");
  }
  if (value.version !== EDITOR_THEMES_FILE_VERSION) {
    throw new Error(`Unsupported Libera editor themes file version: ${String(value.version)}.`);
  }
  const themes = (Array.isArray(value.themes) ? value.themes : [])
    .map(normalizeThemeColors).filter(Boolean).slice(0, MAX_EDITOR_THEMES);
  if (!themes.length) throw new Error("The file does not contain any usable themes.");
  return themes;
}

module.exports = {
  EDITOR_THEME_SCOPES,
  EDITOR_THEME_COLOR_KEYS,
  DEFAULT_EDITOR_THEME_ID,
  MAX_EDITOR_THEMES,
  MAX_EDITOR_THEME_NAME_LENGTH,
  MAX_EDITOR_THEME_FONT_LENGTH,
  APP_PAGE,
  BUILT_IN_EDITOR_THEMES,
  normalizeEditorThemes,
  resolveEditorThemes,
  createEditorThemesFile,
  parseEditorThemesFile,
};
