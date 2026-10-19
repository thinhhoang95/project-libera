const { normalizeMathMarkers, DEFAULT_INLINE_MATH_MARKERS, DEFAULT_BLOCK_MATH_MARKERS } = require("./math-markers.cjs");
const {
  app,
  BrowserWindow,
  WebContentsView,
  Menu,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  session,
  shell,
} = require("electron");
const { createHash, randomBytes, scryptSync, timingSafeEqual } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { normalizeAiPreferences, aiPreferencesEnvironment } = require("./ai-preferences.cjs");
const { normalizeQuickPrompts, validateQuickPrompts } = require("./quick-prompts.cjs");
const { normalizeLatexSnippets } = require("./latex-snippets.cjs");
const { INDEX_FILE_NAME, MODEL_FOLDERS, defaultModelsDirectory, defaultSearchIndexFile, normalizeSearchPreferences } = require("./search-preferences.cjs");
const { normalizeTranscriptionPreferences } = require("./transcription-preferences.cjs");
const { inspectKokoroFolder, normalizeTtsPreferences } = require("./tts-preferences.cjs");
const { inspectDetectionFolder, normalizeDetectionPreferences } = require("./detection-preferences.cjs");
const { createPreferencesBackup, parsePreferencesBackup } = require("./preferences-io.cjs");
const { createUpdaterService } = require("./updater.cjs");
const { createPreferencesOverlay } = require("./preferences-overlay.cjs");
const { OPENROUTER_SPEECH_MODELS_URL, OPENROUTER_TRANSCRIPTION_MODELS_URL, createOpenRouterModelCatalog } = require("./openrouter-models.cjs");
const { clearLoginCookie } = require("./login-cookies.cjs");
const { writeWorkspaceRecovery, localWorkspaceRecoveryRoot } = require("./workspace-recovery.cjs");
const { requestStateFlush } = require("./state-flush.cjs");
const {
  contextStateRoot,
  findLinkedFolder,
  readDirectoryModeState,
} = require("./directory-mode.cjs");
const { maintainWindowsBackdrop } = require("./windows-backdrop.cjs");
const { waitForServer, stopProcessTree } = require("./server-lifecycle.cjs");
const { createCollabHost } = require("./collab-host.cjs");

const CONFIG_FILE_NAME = "libera-electron-config.json";
const MARKDOWN_EXPORT_READY_TIMEOUT_MS = 15_000;
const APP_DISPLAY_NAME = "Libera for Vy Tran";
const ADMIN_USER = "admin";
const MARKDOWN_ASSETS_DIR = "_assets";
const THEME_PREFERENCES = new Set(["light", "dark", "system"]);
const NATIVE_MENU_ITEM_TYPES = new Set(["normal", "checkbox", "radio"]);
const MAX_NATIVE_MENU_ITEMS = 64;
const MAX_NATIVE_MENU_ID_LENGTH = 128;
const MAX_NATIVE_MENU_LABEL_LENGTH = 128;
const DEFAULT_OPENROUTER_MODEL = "google/gemini-3.5-flash";
const DEFAULT_MARKDOWN_EDITOR_FONT_FAMILY = "system-monospace";
const DEFAULT_WYSIWYG_EDITOR_FONT_FAMILY = "system-sans";
const DEFAULT_RENDERED_MARKDOWN_FONT_FAMILY = "system-sans";
const MAX_MARKDOWN_EDITOR_FONT_FAMILY_LENGTH = 256;
const DEFAULT_MARKDOWN_BASE_FONT_SIZE = 16;
const DEFAULT_MARKDOWN_BASE_LINE_HEIGHT = 1.75;
const MAX_MARKDOWN_BASE_FONT_SIZE = 32;
const MAX_MARKDOWN_BASE_LINE_HEIGHT = 2.4;
const MIN_MARKDOWN_BASE_FONT_SIZE = 10;
const MIN_MARKDOWN_BASE_LINE_HEIGHT = 1.1;

function applyApplicationIdentity() {
  app.setName(APP_DISPLAY_NAME);
  process.title = APP_DISPLAY_NAME;
  app.setAboutPanelOptions({ applicationName: APP_DISPLAY_NAME });
}

applyApplicationIdentity();

let activeSetupPromise = null;
let activeSetupWindow = null;
let openRouterModelCatalog = null;
let openRouterTranscriptionModelCatalog = null;
let openRouterSpeechModelCatalog = null;
let nextProcess = null;
let mainWindow = null;
let nextServerUrl = "";
let isQuitting = false;
let rendererStateReady = false;
let quitRequested = false;
let shutdownPromise = null;
let shutdownComplete = false;
const updaterService = createUpdaterService({
  getMainWindow: () => mainWindow,
  onBeforeInstall: prepareToQuit,
});
// Collaboration host (on unless LIBERA_COLLAB=0; when off every call is a no-op).
const collabHost = createCollabHost({
  getMainWindow: () => mainWindow,
  isTrustedFrame: (frame) => Boolean(nextServerUrl) && isSameOrigin(frame.url, nextServerUrl),
  onUpdateRequired: () => void updaterService.check(),
});
const hasInstanceLock = collabHost.claimSingleInstance();
if (!hasInstanceLock) app.quit();

function getAppRoot() {
  return app.getAppPath();
}

function getConfigPath() {
  return path.join(app.getPath("userData"), CONFIG_FILE_NAME);
}

function assertSafePathSegment(segment, label) {
  const trimmed = typeof segment === "string" ? segment.trim() : "";

  if (
    !trimmed ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    throw new Error(`${label} is invalid.`);
  }

  return trimmed;
}

function assertSafeUserPathSegment(segment, label) {
  const trimmed = assertSafePathSegment(segment, label);

  if (
    trimmed.startsWith(".") ||
    trimmed === "__MACOSX" ||
    trimmed === MARKDOWN_ASSETS_DIR
  ) {
    throw new Error(`${label} is invalid.`);
  }

  return trimmed;
}

function splitNotebookItemPath(relativePath) {
  const normalizedPath = typeof relativePath === "string" ? relativePath.trim() : "";

  if (
    !normalizedPath ||
    normalizedPath.includes("\\") ||
    normalizedPath.includes("\0") ||
    path.isAbsolute(normalizedPath)
  ) {
    throw new Error("Item path is invalid.");
  }

  const [notebook, ...pathParts] = normalizedPath.split("/").filter(Boolean);

  if (!notebook || !pathParts.length) {
    throw new Error("Item path must include a notebook and item.");
  }

  return {
    notebook: assertSafePathSegment(notebook, "Notebook name"),
    pathParts: pathParts.map((part) => assertSafeUserPathSegment(part, "Path segment")),
  };
}

function assertPathInside(parentPath, targetPath) {
  const relativePath = path.relative(parentPath, targetPath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Target path is outside the Libera data directory.");
  }
}

function getIconPath() {
  return path.join(getAppRoot(), "assets", "libera-icon.png");
}

function createPasswordHash(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");

  return `scrypt:${salt}:${hash}`;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function hashWithScrypt(password, salt) {
  return scryptSync(password, salt, 64).toString("hex");
}

function verifyPasswordHash(password, configuredHash) {
  if (!configuredHash) {
    return false;
  }

  if (configuredHash.startsWith("scrypt:")) {
    const [, salt, expectedHash] = configuredHash.split(":");

    return Boolean(
      salt &&
        expectedHash &&
        safeEqual(hashWithScrypt(password, salt), expectedHash),
    );
  }

  if (configuredHash.startsWith("sha256:")) {
    const expectedHash = configuredHash.slice("sha256:".length);
    const actualHash = createHash("sha256").update(password).digest("hex");

    return safeEqual(actualHash, expectedHash);
  }

  return false;
}

function createSessionSecret() {
  return randomBytes(32).toString("base64url");
}

function readConfig() {
  try {
    const rawConfig = fs.readFileSync(getConfigPath(), "utf8");
    return JSON.parse(rawConfig);
  } catch {
    return {};
  }
}

function normalizeYourName(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSmartPaste(value) {
  return value === true;
}

// The Markdown Source editor: the textarea ("classic", default) or CodeMirror (beta).
function normalizeSourceEditor(value) {
  return value === "codemirror" ? "codemirror" : "classic";
}

function normalizeThemePreference(themePreference) {
  return THEME_PREFERENCES.has(themePreference) ? themePreference : "system";
}

function normalizeOpenRouterModel(model) {
  const trimmed = typeof model === "string" ? model.trim() : "";

  return trimmed || DEFAULT_OPENROUTER_MODEL;
}

function normalizeNumber(value, fallback) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;

  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeMarkdownBaseFontSize(value) {
  return clamp(
    normalizeNumber(value, DEFAULT_MARKDOWN_BASE_FONT_SIZE),
    MIN_MARKDOWN_BASE_FONT_SIZE,
    MAX_MARKDOWN_BASE_FONT_SIZE,
  );
}

function normalizeMarkdownEditorFontFamily(value) {
  const fontFamily = typeof value === "string" ? value.trim() : "";

  if (
    !fontFamily ||
    fontFamily.length > MAX_MARKDOWN_EDITOR_FONT_FAMILY_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(fontFamily)
  ) {
    return DEFAULT_MARKDOWN_EDITOR_FONT_FAMILY;
  }

  return fontFamily;
}

function normalizeWysiwygEditorFontFamily(value) {
  const fontFamily = typeof value === "string" ? value.trim() : "";

  if (
    !fontFamily ||
    fontFamily.length > MAX_MARKDOWN_EDITOR_FONT_FAMILY_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(fontFamily)
  ) {
    return DEFAULT_WYSIWYG_EDITOR_FONT_FAMILY;
  }

  return fontFamily;
}

function normalizeRenderedMarkdownFontFamily(value) {
  const fontFamily = typeof value === "string" ? value.trim() : "";

  if (
    !fontFamily ||
    fontFamily.length > MAX_MARKDOWN_EDITOR_FONT_FAMILY_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(fontFamily)
  ) {
    return DEFAULT_RENDERED_MARKDOWN_FONT_FAMILY;
  }

  return fontFamily;
}

function normalizeMarkdownBaseLineHeight(value) {
  return clamp(
    normalizeNumber(value, DEFAULT_MARKDOWN_BASE_LINE_HEIGHT),
    MIN_MARKDOWN_BASE_LINE_HEIGHT,
    MAX_MARKDOWN_BASE_LINE_HEIGHT,
  );
}

async function writeConfig(config) {
  await fsp.mkdir(path.dirname(getConfigPath()), { recursive: true });
  await fsp.writeFile(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function normalizedImportedPreferences(input) {
  const dataDir = typeof input.dataDir === "string" ? input.dataDir.trim() : "";
  const openaiApiKey =
    typeof input.openaiApiKey === "string" ? input.openaiApiKey.trim() : "";
  const passwordHash =
    typeof input.passwordHash === "string" ? input.passwordHash.trim() : "";

  if (!dataDir) throw new Error("The preferences backup does not contain a data directory.");
  if (!openaiApiKey) throw new Error("The preferences backup does not contain an API key.");
  if (!/^(?:scrypt:[a-f\d]{32}:[a-f\d]{128}|sha256:[a-f\d]{64})$/i.test(passwordHash)) {
    throw new Error("The preferences backup does not contain a valid master password verifier.");
  }

  const markdownInlineMathMarkers = normalizeMathMarkers(
    input.markdownInlineMathMarkers,
    DEFAULT_INLINE_MATH_MARKERS,
  );
  const markdownBlockMathMarkers = normalizeMathMarkers(
    input.markdownBlockMathMarkers,
    DEFAULT_BLOCK_MATH_MARKERS,
  );
  const inlineOpeners = new Set(
    markdownInlineMathMarkers.split("\n").filter(Boolean).map((line) => line.split(" ")[0]),
  );

  if (
    markdownBlockMathMarkers
      .split("\n")
      .filter(Boolean)
      .some((line) => inlineOpeners.has(line.split(" ")[0]))
  ) {
    throw new Error("The preferences backup uses the same opening marker for inline and display math.");
  }

  const openRouterModel = normalizeOpenRouterModel(input.openRouterModel);

  return {
    themePreference: normalizeThemePreference(input.themePreference),
    yourName: normalizeYourName(input.yourName),
    smartPaste: normalizeSmartPaste(input.smartPaste),
    sourceEditor: normalizeSourceEditor(input.sourceEditor),
    dataDir,
    markdownInlineMathMarkers,
    markdownBlockMathMarkers,
    markdownEditorFontFamily: normalizeMarkdownEditorFontFamily(
      input.markdownEditorFontFamily,
    ),
    wysiwygEditorFontFamily: normalizeWysiwygEditorFontFamily(
      input.wysiwygEditorFontFamily,
    ),
    renderedMarkdownFontFamily: normalizeRenderedMarkdownFontFamily(
      input.renderedMarkdownFontFamily,
    ),
    markdownBaseFontSize: normalizeMarkdownBaseFontSize(input.markdownBaseFontSize),
    markdownBaseLineHeight: normalizeMarkdownBaseLineHeight(input.markdownBaseLineHeight),
    markdownPdfBaseFontSize: normalizeMarkdownBaseFontSize(input.markdownPdfBaseFontSize),
    markdownPdfBaseLineHeight: normalizeMarkdownBaseLineHeight(
      input.markdownPdfBaseLineHeight,
    ),
    openaiApiKey,
    openRouterModel,
    aiFunctions: normalizeAiPreferences(input.aiFunctions, openRouterModel),
    quickPrompts: validateQuickPrompts(input.quickPrompts ?? []),
    // Backups made before snippets existed leave the saved snippets alone.
    ...(Object.hasOwn(input, "latexSnippets") ? { latexSnippets: normalizeLatexSnippets(input.latexSnippets) } : {}),
    ...(Object.hasOwn(input, "search") ? { search: normalizeSearchPreferences(input.search) } : {}),
    ...(Object.hasOwn(input, "transcription") ? { transcription: normalizeTranscriptionPreferences(input.transcription) } : {}),
    ...(Object.hasOwn(input, "tts") ? { tts: normalizeTtsPreferences(input.tts) } : {}),
    ...(Object.hasOwn(input, "detection") ? { detection: normalizeDetectionPreferences(input.detection) } : {}),
    passwordHash,
  };
}

async function exportPreferences(parentWindow) {
  const date = new Date().toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog(parentWindow, {
    title: "Export Libera Preferences",
    defaultPath: path.join(app.getPath("documents"), `libera-preferences-${date}.json`),
    filters: [{ name: "JSON files", extensions: ["json"] }],
  });

  if (result.canceled || !result.filePath) return { canceled: true };

  const backup = createPreferencesBackup(readConfig());
  await fsp.writeFile(result.filePath, `${JSON.stringify(backup, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  return { canceled: false, fileName: path.basename(result.filePath) };
}

async function importPreferences(parentWindow) {
  const result = await dialog.showOpenDialog(parentWindow, {
    title: "Load Libera Preferences",
    properties: ["openFile"],
    filters: [{ name: "JSON files", extensions: ["json"] }],
  });

  if (result.canceled || !result.filePaths[0]) return { canceled: true };

  const filePath = result.filePaths[0];
  const fileInfo = await fsp.stat(filePath);
  if (fileInfo.size > 5 * 1024 * 1024) {
    throw new Error("The selected preferences backup is too large.");
  }

  let parsed;
  try {
    parsed = JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("The selected file is not valid JSON.");
    throw error;
  }

  const importedPreferences = normalizedImportedPreferences(
    parsePreferencesBackup(parsed),
  );
  const confirmation = await showMessageBox(parentWindow, {
    type: "warning",
    buttons: ["Load Settings", "Cancel"],
    cancelId: 1,
    defaultId: 1,
    noLink: true,
    title: "Load Preferences Backup?",
    message: "Replace all saved Libera preferences with this backup?",
    detail:
      "This includes the notebook directory, API key, AI, Markdown and Search settings, quick prompts, LaTeX snippets, theme, and master password verifier.",
  });

  if (confirmation.response !== 0) return { canceled: true };

  const existingConfig = readConfig();
  const nextConfig = {
    ...existingConfig,
    ...importedPreferences,
    sessionSecret: existingConfig.sessionSecret || createSessionSecret(),
  };

  await fsp.mkdir(nextConfig.dataDir, { recursive: true });
  await writeConfig(nextConfig);
  nativeTheme.themeSource = nextConfig.themePreference;
  mainWindow?.webContents.send("theme:changed", nextConfig.themePreference);

  return { canceled: false, config: nextConfig, fileName: path.basename(filePath) };
}

function getConfigStatus(config = readConfig()) {
  return {
    themePreference: normalizeThemePreference(config.themePreference),
    yourName: normalizeYourName(config.yourName),
    smartPaste: normalizeSmartPaste(config.smartPaste),
    sourceEditor: normalizeSourceEditor(config.sourceEditor),
    dataDir: typeof config.dataDir === "string" ? config.dataDir : "",
    hasApiKey: typeof config.openaiApiKey === "string" && config.openaiApiKey.trim().length > 0,
    hasPasswordHash:
      typeof config.passwordHash === "string" && config.passwordHash.trim().length > 0,
    markdownInlineMathMarkers: normalizeMathMarkers(config.markdownInlineMathMarkers, DEFAULT_INLINE_MATH_MARKERS),
    markdownBlockMathMarkers: normalizeMathMarkers(config.markdownBlockMathMarkers, DEFAULT_BLOCK_MATH_MARKERS),
    markdownEditorFontFamily: normalizeMarkdownEditorFontFamily(
      config.markdownEditorFontFamily,
    ),
    wysiwygEditorFontFamily: normalizeWysiwygEditorFontFamily(
      config.wysiwygEditorFontFamily,
    ),
    renderedMarkdownFontFamily: normalizeRenderedMarkdownFontFamily(
      config.renderedMarkdownFontFamily,
    ),
    markdownBaseFontSize: normalizeMarkdownBaseFontSize(config.markdownBaseFontSize),
    markdownBaseLineHeight: normalizeMarkdownBaseLineHeight(config.markdownBaseLineHeight),
    markdownPdfBaseFontSize: normalizeMarkdownBaseFontSize(config.markdownPdfBaseFontSize),
    markdownPdfBaseLineHeight: normalizeMarkdownBaseLineHeight(config.markdownPdfBaseLineHeight),
    openRouterModel: normalizeOpenRouterModel(config.openRouterModel),
    aiFunctions: normalizeAiPreferences(config.aiFunctions, normalizeOpenRouterModel(config.openRouterModel)),
    quickPrompts: normalizeQuickPrompts(config.quickPrompts),
    search: normalizeSearchPreferences(config.search),
    transcription: normalizeTranscriptionPreferences(config.transcription),
    tts: normalizeTtsPreferences(config.tts),
    detection: normalizeDetectionPreferences(config.detection),
    searchDefaultIndexFile: typeof config.dataDir === "string" && config.dataDir
      ? defaultSearchIndexFile({ adminRoot: path.join(config.dataDir, "users", ADMIN_USER), configPath: getConfigPath() })
      : "",
    // Where Libera downloads each local model when no folder is chosen.
    modelFolders: Object.fromEntries(Object.entries(MODEL_FOLDERS).map(([key, folder]) => [
      key,
      path.join(defaultModelsDirectory({ adminRoot: path.join(config.dataDir || "", "users", ADMIN_USER), configPath: getConfigPath() }), folder),
    ])),
  };
}

function isConfigComplete(config) {
  const status = getConfigStatus(config);

  return Boolean(status.dataDir && status.hasApiKey && status.hasPasswordHash);
}

async function selectDataDir(parentWindow) {
  const result = await dialog.showOpenDialog(parentWindow, {
    title: `Select ${APP_DISPLAY_NAME} Master directory`,
    properties: ["openDirectory", "createDirectory"],
  });

  return result.canceled ? "" : result.filePaths[0] ?? "";
}

async function loadAiChatCustomInstructionFile(parentWindow) {
  const result = await dialog.showOpenDialog(parentWindow, {
    title: "Load AI Chat custom instruction",
    properties: ["openFile"],
    filters: [
      { name: "Text files", extensions: ["txt", "md", "markdown"] },
      { name: "All files", extensions: ["*"] },
    ],
  });

  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true };
  }

  return {
    canceled: false,
    content: await fsp.readFile(result.filePaths[0], "utf8"),
  };
}

async function loadAiRewriteCustomInstructionFile(parentWindow) {
  const result = await dialog.showOpenDialog(parentWindow, {
    title: "Load AI Rewrite custom instruction",
    properties: ["openFile"],
    filters: [
      { name: "Text files", extensions: ["txt", "md", "markdown"] },
      { name: "All files", extensions: ["*"] },
    ],
  });

  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true };
  }

  return {
    canceled: false,
    content: await fsp.readFile(result.filePaths[0], "utf8"),
  };
}

async function selectSearchWeights(parentWindow, kind) {
  if (kind === "speech-models") {
    const result = await dialog.showOpenDialog(parentWindow, {
      title: "Choose the speech models folder",
      message: "Choose an empty folder for Libera to download Parakeet and the pyannote speaker models into, or a folder that already holds them.",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? "" : result.filePaths[0] ?? "";
  }

  if (kind === "detection-model") {
    const result = await dialog.showOpenDialog(parentWindow, {
      title: "Choose the detection model folder",
      message: "Choose an empty folder for Libera to download YOLOE-26 and its Python runtime into, or a folder that already holds them.",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? "" : result.filePaths[0] ?? "";
  }

  if (kind === "tts-model") {
    const result = await dialog.showOpenDialog(parentWindow, {
      title: "Choose the Kokoro model folder",
      message: "Choose the extracted sherpa-onnx Kokoro folder, with model.onnx, voices.bin, tokens.txt and espeak-ng-data.",
      properties: ["openDirectory"],
    });
    return result.canceled ? "" : result.filePaths[0] ?? "";
  }

  if (kind === "ffmpeg") {
    const result = await dialog.showOpenDialog(parentWindow, {
      title: "Choose ffmpeg",
      message: "Choose the ffmpeg program, used to read voice memos in formats such as M4A and MP3.",
      properties: ["openFile"],
      ...(process.platform === "win32" ? { filters: [{ name: "Programs", extensions: ["exe"] }] } : {}),
    });
    return result.canceled ? "" : result.filePaths[0] ?? "";
  }

  if (kind === "reading") {
    const result = await dialog.showOpenDialog(parentWindow, {
      title: "Choose the PDF reading model folder",
      message: "Choose an empty folder for Libera to download granite-docling into, or a folder that already holds it.",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? "" : result.filePaths[0] ?? "";
  }

  const isVision = kind === "vision";
  const result = await dialog.showOpenDialog(parentWindow, {
    title: isVision ? "Choose the EmbeddingGemma 2 vision encoder" : "Choose the EmbeddingGemma 2 text model",
    message: isVision
      ? "Choose vision_encoder_*.onnx. Its .onnx_data file must be next to it."
      : "Choose model_*.onnx. Its .onnx_data file must be next to it, and config.json and tokenizer.json next to it or one folder up.",
    properties: ["openFile"],
    filters: [{ name: "ONNX models", extensions: ["onnx"] }],
  });

  return result.canceled ? "" : result.filePaths[0] ?? "";
}

/** Pick an existing index file, or where a new one should be created. */
async function selectSearchIndexFile(parentWindow, mode) {
  if (mode === "new") {
    const result = await dialog.showSaveDialog(parentWindow, {
      title: "Create the search index",
      defaultPath: path.join(app.getPath("documents"), INDEX_FILE_NAME),
      buttonLabel: "Create Here",
      filters: [{ name: "Libera search index", extensions: ["sqlite"] }],
    });
    return result.canceled ? "" : result.filePath ?? "";
  }

  const result = await dialog.showOpenDialog(parentWindow, {
    title: "Use an existing search index",
    message: "Choose a libera-search.sqlite file built by Libera, for example copied from another computer.",
    properties: ["openFile"],
    filters: [{ name: "Libera search index", extensions: ["sqlite"] }],
  });
  return result.canceled ? "" : result.filePaths[0] ?? "";
}

/** Show the index file in Finder or Explorer; only SQLite files that exist. */
function revealSearchIndex(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== ".sqlite") {
    return false;
  }
  if (!fs.existsSync(filePath)) return false;
  shell.showItemInFolder(filePath);
  return true;
}

/** Save the index file in Preferences → Search; the server picks it up on its next request. */
async function useSearchIndexFile(filePath) {
  const config = readConfig();
  const search = normalizeSearchPreferences({ ...normalizeSearchPreferences(config.search), indexFile: filePath });
  await writeConfig({ ...config, search });
  return search.indexFile;
}

function showMessageBox(parentWindow, options) {
  if (parentWindow && !parentWindow.isDestroyed()) {
    return dialog.showMessageBox(parentWindow, options);
  }

  return dialog.showMessageBox(options);
}

function validateSetupInput(input, existingConfig) {
  const dataDir = typeof input?.dataDir === "string" ? input.dataDir.trim() : "";
  const openaiApiKey =
    typeof input?.openaiApiKey === "string" ? input.openaiApiKey.trim() : "";
  const currentPassword =
    typeof input?.currentPassword === "string" ? input.currentPassword : "";
  const password = typeof input?.password === "string" ? input.password : "";
  const passwordConfirmation =
    typeof input?.passwordConfirmation === "string" ? input.passwordConfirmation : "";
  const changingPassword = Boolean(input?.changePassword);
  const markdownEditorFontFamily = normalizeMarkdownEditorFontFamily(
    input?.markdownEditorFontFamily,
  );
  const wysiwygEditorFontFamily = normalizeWysiwygEditorFontFamily(
    input?.wysiwygEditorFontFamily,
  );
  const renderedMarkdownFontFamily = normalizeRenderedMarkdownFontFamily(
    input?.renderedMarkdownFontFamily,
  );
  const markdownInlineMathMarkers = normalizeMathMarkers(input?.markdownInlineMathMarkers ?? existingConfig.markdownInlineMathMarkers, DEFAULT_INLINE_MATH_MARKERS);
  const markdownBlockMathMarkers = normalizeMathMarkers(input?.markdownBlockMathMarkers ?? existingConfig.markdownBlockMathMarkers, DEFAULT_BLOCK_MATH_MARKERS);
  const inlineOpeners = new Set(markdownInlineMathMarkers.split("\n").filter(Boolean).map(line => line.split(" ")[0]));
  if (markdownBlockMathMarkers.split("\n").filter(Boolean).some(line => inlineOpeners.has(line.split(" ")[0]))) {
    throw new Error("Inline and display math must use different opening markers.");
  }
  const markdownBaseFontSize = normalizeMarkdownBaseFontSize(input?.markdownBaseFontSize);
  const markdownBaseLineHeight = normalizeMarkdownBaseLineHeight(input?.markdownBaseLineHeight);
  const markdownPdfBaseFontSize = normalizeMarkdownBaseFontSize(
    input?.markdownPdfBaseFontSize,
  );
  const markdownPdfBaseLineHeight = normalizeMarkdownBaseLineHeight(
    input?.markdownPdfBaseLineHeight,
  );
  const openRouterModel = normalizeOpenRouterModel(input?.openRouterModel);
  const quickPrompts = validateQuickPrompts(input?.quickPrompts ?? existingConfig.quickPrompts ?? []);

  if (!dataDir) {
    throw new Error("Choose a data directory before continuing.");
  }

  if (!openaiApiKey && !existingConfig.openaiApiKey) {
    throw new Error("Enter an OPENAI_API_KEY before continuing.");
  }

  if (!existingConfig.passwordHash || changingPassword) {
    if (
      existingConfig.passwordHash &&
      !verifyPasswordHash(currentPassword, existingConfig.passwordHash)
    ) {
      throw new Error("Enter the current master password before changing it.");
    }

    if (!password) {
      throw new Error(
        existingConfig.passwordHash
          ? "Enter a new master password before continuing."
          : "Create a master password before continuing.",
      );
    }

    if (password.length < 8) {
      throw new Error("Use a master password with at least 8 characters.");
    }

    if (password !== passwordConfirmation) {
      throw new Error("The master password confirmation does not match.");
    }
  }

  return {
    themePreference: normalizeThemePreference(input?.themePreference),
    yourName: normalizeYourName(input?.yourName),
    smartPaste: normalizeSmartPaste(input?.smartPaste),
    sourceEditor: normalizeSourceEditor(input?.sourceEditor),
    dataDir,
    markdownInlineMathMarkers,
    markdownBlockMathMarkers,
    markdownEditorFontFamily,
    wysiwygEditorFontFamily,
    renderedMarkdownFontFamily,
    markdownBaseFontSize,
    markdownBaseLineHeight,
    markdownPdfBaseFontSize,
    markdownPdfBaseLineHeight,
    openaiApiKey,
    openRouterModel,
    aiFunctions: normalizeAiPreferences(input?.aiFunctions ?? existingConfig.aiFunctions, openRouterModel),
    quickPrompts,
    search: normalizeSearchPreferences(input?.search ?? existingConfig.search),
    transcription: normalizeTranscriptionPreferences(input?.transcription ?? existingConfig.transcription),
    tts: normalizeTtsPreferences(input?.tts ?? existingConfig.tts),
    detection: normalizeDetectionPreferences(input?.detection ?? existingConfig.detection),
    passwordHash:
      existingConfig.passwordHash && !changingPassword
        ? existingConfig.passwordHash
        : createPasswordHash(password),
  };
}

async function createSetupWindow({ mode = "setup", parentWindow = null, section = "" } = {}) {
  if (activeSetupWindow && !activeSetupWindow.isDestroyed()) {
    activeSetupWindow.focus();
    return activeSetupPromise;
  }

  activeSetupPromise = new Promise((resolve, reject) => {
    let savedConfig = null;
    const overlay = mode === "configuration" && parentWindow
      ? createPreferencesOverlay(parentWindow, {
          WebContentsView,
          preload: path.join(__dirname, "preload.cjs"),
        })
      : null;
    const setupWindow = overlay ? parentWindow : new BrowserWindow({
      width: 860,
      height: 700,
      icon: getIconPath(),
      modal: Boolean(parentWindow),
      parent: parentWindow ?? undefined,
      resizable: false,
      title:
        mode === "configuration"
          ? `${APP_DISPLAY_NAME} Preferences`
          : `Set Up ${APP_DISPLAY_NAME}`,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        // Same preload as the main window; it only needs sandbox-safe APIs.
        sandbox: true,
        preload: path.join(__dirname, "preload.cjs"),
      },
    });

    const setupHost = overlay ?? setupWindow;
    activeSetupWindow = setupHost;
    if (!overlay) setupWindow.setMenuBarVisibility(false);

    ipcMain.handle("setup:close", (event) => {
      if (event.sender === setupHost.webContents) setupHost.close();
    });

    ipcMain.handle("setup:get-state", () => getConfigStatus());

    ipcMain.handle("setup:select-data-dir", () => selectDataDir(setupWindow));

    ipcMain.handle("setup:select-search-weights", (_event, kind) => selectSearchWeights(setupWindow, kind));

    ipcMain.handle("setup:check-tts-model", (_event, directory) => inspectKokoroFolder(directory));
    ipcMain.handle("setup:check-detection-model", (_event, directory) => inspectDetectionFolder(directory));

    ipcMain.handle("setup:select-search-index-file", (_event, mode) => selectSearchIndexFile(setupWindow, mode));

    ipcMain.handle("setup:reveal-search-index", (_event, filePath) => revealSearchIndex(filePath));

    ipcMain.handle("setup:export-preferences", () => exportPreferences(setupWindow));

    ipcMain.handle("setup:list-openrouter-models", async (_event, options) => {
      // Speech-to-text and text-to-speech models are listed apart from the chat models.
      const catalog = options?.kind === "speech"
        ? (openRouterSpeechModelCatalog ??= createOpenRouterModelCatalog({
          cacheDir: app.getPath("userData"),
          url: OPENROUTER_SPEECH_MODELS_URL,
          cacheFileName: "openrouter-speech-models-cache.json",
        }))
        : options?.kind === "transcription"
        ? (openRouterTranscriptionModelCatalog ??= createOpenRouterModelCatalog({
          cacheDir: app.getPath("userData"),
          url: OPENROUTER_TRANSCRIPTION_MODELS_URL,
          cacheFileName: "openrouter-transcription-models-cache.json",
        }))
        : (openRouterModelCatalog ??= createOpenRouterModelCatalog({ cacheDir: app.getPath("userData") }));
      try {
        return { ok: true, ...(await catalog.list({ refresh: options?.refresh === true })) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    ipcMain.handle("setup:import-preferences", async () => {
      const result = await importPreferences(setupWindow);

      if (!result.canceled) savedConfig = result.config;

      return { canceled: result.canceled, fileName: result.fileName };
    });

    ipcMain.handle("setup:load-ai-chat-custom-instruction-file", () =>
      loadAiChatCustomInstructionFile(setupWindow),
    );

    ipcMain.handle("setup:load-ai-rewrite-custom-instruction-file", () =>
      loadAiRewriteCustomInstructionFile(setupWindow),
    );

    ipcMain.handle("setup:save", async (_event, input) => {
      const existingConfig = readConfig();
      const validated = validateSetupInput(input, existingConfig);

      await fsp.mkdir(validated.dataDir, { recursive: true });

      const nextConfig = {
        ...existingConfig,
        themePreference: validated.themePreference,
        yourName: validated.yourName,
        smartPaste: validated.smartPaste,
        sourceEditor: validated.sourceEditor,
        dataDir: validated.dataDir,
        markdownInlineMathMarkers: validated.markdownInlineMathMarkers,
        markdownBlockMathMarkers: validated.markdownBlockMathMarkers,
        markdownEditorFontFamily: validated.markdownEditorFontFamily,
        wysiwygEditorFontFamily: validated.wysiwygEditorFontFamily,
        renderedMarkdownFontFamily: validated.renderedMarkdownFontFamily,
        markdownBaseFontSize: validated.markdownBaseFontSize,
        markdownBaseLineHeight: validated.markdownBaseLineHeight,
        markdownPdfBaseFontSize: validated.markdownPdfBaseFontSize,
        markdownPdfBaseLineHeight: validated.markdownPdfBaseLineHeight,
        openaiApiKey: validated.openaiApiKey || existingConfig.openaiApiKey,
        openRouterModel: validated.openRouterModel,
        aiFunctions: validated.aiFunctions,
        quickPrompts: validated.quickPrompts,
        search: validated.search,
        transcription: validated.transcription,
        tts: validated.tts,
        detection: validated.detection,
        passwordHash: validated.passwordHash,
        sessionSecret: existingConfig.sessionSecret || createSessionSecret(),
      };

      await writeConfig(nextConfig);
      nativeTheme.themeSource = nextConfig.themePreference;
      mainWindow?.webContents.send("theme:changed", nextConfig.themePreference);
      savedConfig = nextConfig;
      setupHost.close();

      return { ok: true };
    });

    setupHost.on("closed", () => {
      ipcMain.removeHandler("setup:close");
      ipcMain.removeHandler("setup:get-state");
      ipcMain.removeHandler("setup:select-data-dir");
      ipcMain.removeHandler("setup:select-search-weights");
      ipcMain.removeHandler("setup:select-search-index-file");
      ipcMain.removeHandler("setup:check-tts-model");
      ipcMain.removeHandler("setup:check-detection-model");
      ipcMain.removeHandler("setup:reveal-search-index");
      ipcMain.removeHandler("setup:export-preferences");
      ipcMain.removeHandler("setup:list-openrouter-models");
      ipcMain.removeHandler("setup:import-preferences");
      ipcMain.removeHandler("setup:load-ai-chat-custom-instruction-file");
      ipcMain.removeHandler("setup:load-ai-rewrite-custom-instruction-file");
      ipcMain.removeHandler("setup:save");
      activeSetupPromise = null;
      activeSetupWindow = null;

      if (savedConfig) {
        resolve(savedConfig);
        return;
      }

      if (mode === "setup" && !isConfigComplete(readConfig())) {
        reject(new Error("Setup was canceled."));
        return;
      }

      resolve(null);
    });

    setupHost.webContents.loadFile(path.join(__dirname, "setup.html"), {
      query: { mode, presentation: overlay ? "overlay" : "window", section },
    }).catch((error) => {
      reject(error);
      setupHost.close();
    });
  });

  return activeSetupPromise;
}

function showAboutDialog() {
  const parentWindow = BrowserWindow.getFocusedWindow() ?? mainWindow;

  showMessageBox(parentWindow, {
    type: "info",
    buttons: ["OK"],
    defaultId: 0,
    message: APP_DISPLAY_NAME,
    title: `About ${APP_DISPLAY_NAME}`,
    detail: `Version ${app.getVersion()}\nA liberal notetaking app.`,
  });
}

function sanitizePdfFileName(fileName) {
  const cleaned = (typeof fileName === "string" ? fileName : "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = "document.pdf";
  const safeFileName = cleaned || fallback;

  return /\.pdf$/i.test(safeFileName) ? safeFileName : `${safeFileName}.pdf`;
}

const MARKDOWN_PDF_FOOTER_TEMPLATE = `
  <div style="box-sizing: border-box; color: #71717a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 9px; padding: 0 18mm; text-align: center; width: 100%;">
    ${APP_DISPLAY_NAME} &middot; Page <span class="pageNumber"></span> of <span class="totalPages"></span>
  </div>
`;

function normalizeMarkdownPdfExportInput(input) {
  if (!input || typeof input !== "object") {
    throw new Error("PDF export input is invalid.");
  }

  return {
    content: typeof input.content === "string" ? input.content : "",
    documentPath: typeof input.documentPath === "string" ? input.documentPath : "",
    fileName: sanitizePdfFileName(input.fileName),
    title: typeof input.title === "string" ? input.title : "",
  };
}

function getRendererOrigin(webContents) {
  if (nextServerUrl) {
    return nextServerUrl;
  }

  const currentUrl = webContents.getURL();

  if (!currentUrl) {
    throw new Error("Could not determine the app URL for PDF export.");
  }

  return new URL(currentUrl).origin;
}

async function waitForMarkdownPdfExportPage(webContents) {
  await webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timeoutMs = ${MARKDOWN_EXPORT_READY_TIMEOUT_MS};

      function check() {
        if (window.liberaMarkdownPdfExport && typeof window.liberaMarkdownPdfExport.render === "function") {
          resolve(true);
          return;
        }

        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error("Markdown PDF export page did not initialize."));
          return;
        }

        window.setTimeout(check, 50);
      }

      check();
    })
  `);
}

async function renderMarkdownPdfExportPage(webContents, payload) {
  await webContents.executeJavaScript(
    `window.liberaMarkdownPdfExport.render(${JSON.stringify(payload)})`,
  );
}

async function exportMarkdownPdf(event, input) {
  const payload = normalizeMarkdownPdfExportInput(input);
  const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  const saveResult = await dialog.showSaveDialog(parentWindow, {
    defaultPath: path.join(app.getPath("documents"), payload.fileName),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
    title: "Export Markdown as PDF",
  });

  if (saveResult.canceled || !saveResult.filePath) {
    return { canceled: true };
  }

  const outputPath = /\.pdf$/i.test(saveResult.filePath)
    ? saveResult.filePath
    : `${saveResult.filePath}.pdf`;
  const exportWindow = new BrowserWindow({
    backgroundColor: "#ffffff",
    height: 1280,
    parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    width: 960,
  });

  try {
    const exportUrl = new URL("/markdown-export", getRendererOrigin(event.sender));

    await exportWindow.loadURL(exportUrl.toString());
    await waitForMarkdownPdfExportPage(exportWindow.webContents);
    await renderMarkdownPdfExportPage(exportWindow.webContents, {
      content: payload.content,
      documentPath: payload.documentPath,
      title: payload.title,
    });

    const pdf = await exportWindow.webContents.printToPDF({
      displayHeaderFooter: true,
      footerTemplate: MARKDOWN_PDF_FOOTER_TEMPLATE,
      headerTemplate: "<span></span>",
      pageSize: "A4",
      preferCSSPageSize: true,
      printBackground: true,
    });

    await fsp.writeFile(outputPath, pdf);

    return { canceled: false, filePath: outputPath };
  } finally {
    if (!exportWindow.isDestroyed()) {
      exportWindow.close();
    }
  }
}

function dispatchRendererKeydown(webContents, options) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  const script = `window.dispatchEvent(new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ctrlKey: ${options.ctrlKey ? "true" : "false"},
    key: ${JSON.stringify(options.key)},
    metaKey: ${options.metaKey ? "true" : "false"},
    shiftKey: ${options.shiftKey ? "true" : "false"}
  }))`;

  webContents.executeJavaScript(script).catch(() => null);
}

function dispatchRendererTabShortcut(webContents, shiftKey) {
  dispatchRendererKeydown(webContents, {
    ctrlKey: true,
    key: "Tab",
    metaKey: false,
    shiftKey,
  });
}

function dispatchRendererCloseTabShortcut(webContents) {
  const isMac = process.platform === "darwin";

  dispatchRendererKeydown(webContents, {
    ctrlKey: !isMac,
    key: "w",
    metaKey: isMac,
    shiftKey: false,
  });
}

function dispatchCloseTabToFocusedWindow() {
  if (activeSetupWindow && !activeSetupWindow.isDestroyed()) {
    activeSetupWindow.webContents.send("setup:request-close");
    return;
  }
  const focusedWindow = BrowserWindow.getFocusedWindow() ?? mainWindow;

  dispatchRendererCloseTabShortcut(focusedWindow?.webContents);
}

async function openConfigurationWindow(section = "") {
  try {
    const previousConfig = readConfig();
    const updatedConfig = await createSetupWindow({
      mode: "configuration",
      parentWindow: mainWindow,
      section: typeof section === "string" ? section : "",
    });

    if (!updatedConfig) {
      return;
    }

    // The server reads Search preferences while it runs; they need no restart.
    const requiresRestart = Object.keys(updatedConfig).some(
      (key) => key !== "themePreference" && key !== "search" && (key === "aiFunctions"
        ? JSON.stringify(updatedConfig.aiFunctions) !== JSON.stringify(normalizeAiPreferences(previousConfig.aiFunctions, normalizeOpenRouterModel(previousConfig.openRouterModel)))
        : key === "quickPrompts"
          ? JSON.stringify(updatedConfig.quickPrompts) !== JSON.stringify(normalizeQuickPrompts(previousConfig.quickPrompts))
        : key === "latexSnippets"
          ? JSON.stringify(updatedConfig.latexSnippets) !== JSON.stringify(previousConfig.latexSnippets)
        : key === "smartPaste"
          ? updatedConfig.smartPaste !== normalizeSmartPaste(previousConfig.smartPaste)
        : key === "sourceEditor"
          ? updatedConfig.sourceEditor !== normalizeSourceEditor(previousConfig.sourceEditor)
        : updatedConfig[key] !== previousConfig[key]),
    );
    if (!requiresRestart) return;

    const result = await showMessageBox(mainWindow, {
      type: "info",
      buttons: ["Restart Now", "Later"],
      cancelId: 1,
      defaultId: 0,
      message: `Restart ${APP_DISPLAY_NAME} to apply preference changes.`,
      detail:
        `Theme changes apply immediately. Other General and Markdown preferences are applied when the local server starts.`,
      title: "Preferences Saved",
    });

    if (result.response === 0) {
      isQuitting = true;
      app.relaunch();
      app.quit();
    }
  } catch (error) {
    if (error.message !== "Setup was canceled.") {
      dialog.showErrorBox("Unable to update preferences", error.message);
    }
  }
}

function getAdminRootFromConfig() {
  const config = readConfig();
  const dataDir = typeof config.dataDir === "string" ? config.dataDir : "";

  if (!dataDir) {
    throw new Error("Libera data directory is not configured.");
  }

  return path.join(dataDir, "users", ADMIN_USER);
}

function readDirectoryModeStateFromConfig() {
  try {
    return readDirectoryModeState(getAdminRootFromConfig());
  } catch {
    return { version: 2, folders: [], recent: [] };
  }
}

function recentDirectoryLabel(directoryPath) {
  const home = app.getPath("home");
  const relativeToHome = path.relative(home, directoryPath);
  const shown = relativeToHome && !relativeToHome.startsWith("..") && !path.isAbsolute(relativeToHome)
    ? `~${path.sep}${relativeToHome}`
    : directoryPath;
  // Electron treats "&" as a mnemonic marker on Windows and Linux.
  return shown.replace(/&/g, "&&");
}

// The renderer asks the server to link or remove the folder and refreshes its
// library in place.
function sendDirectoryCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  mainWindow.webContents.send("directory:command", command);
}

function showOpenDialogFor(parentWindow, options) {
  return parentWindow ? dialog.showOpenDialog(parentWindow, options) : dialog.showOpenDialog(options);
}

async function showDirectoryDialog(parentWindow) {
  const result = await showOpenDialogFor(parentWindow, {
    buttonLabel: "Open",
    properties: ["openDirectory", "createDirectory"],
    title: "Open Folder",
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
}

async function showFileDialog(parentWindow) {
  const result = await showOpenDialogFor(parentWindow, {
    // The server decides which file types Libera can open.
    buttonLabel: "Open",
    properties: ["openFile"],
    title: "Open File",
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
}

async function chooseDirectoryAndOpen() {
  const directoryPath = await showDirectoryDialog(mainWindow);
  if (directoryPath) sendDirectoryCommand({ type: "open-directory", path: directoryPath });
}

async function chooseFileAndOpen() {
  const filePath = await showFileDialog(mainWindow);
  if (filePath) sendDirectoryCommand({ type: "open-file", path: filePath });
}

/** Map a notebook-relative item path to disk, following linked folders. */
function resolveContextItemPath(relativePath) {
  const { notebook, pathParts } = splitNotebookItemPath(relativePath);
  const adminRoot = getAdminRootFromConfig();
  const folder = findLinkedFolder(readDirectoryModeState(adminRoot), notebook);

  if (folder) {
    const targetPath = path.join(folder.path, ...pathParts);
    assertPathInside(folder.path, targetPath);
    return targetPath;
  }

  const targetPath = path.join(adminRoot, notebook, ...pathParts);
  assertPathInside(adminRoot, targetPath);
  return targetPath;
}

function installDirectoryModeHandlers() {
  ipcMain.handle("directory:choose-folder", (event) =>
    showDirectoryDialog(BrowserWindow.fromWebContents(event.sender) ?? mainWindow));
  ipcMain.handle("directory:choose-file", (event) =>
    showFileDialog(BrowserWindow.fromWebContents(event.sender) ?? mainWindow));
  ipcMain.handle("directory:changed", () => {
    const [latest] = readDirectoryModeStateFromConfig().recent;
    if (latest) app.addRecentDocument(latest);
    installApplicationMenu();
  });
}

function installApplicationMenu() {
  applyApplicationIdentity();

  const isMac = process.platform === "darwin";
  const configurationMenuItem = {
    accelerator: "CmdOrCtrl+,",
    click: () => void openConfigurationWindow(),
    label: "Preferences...",
  };
  const closeTabMenuItem = {
    accelerator: "CmdOrCtrl+W",
    click: dispatchCloseTabToFocusedWindow,
    label: "Close Tab",
  };
  const aboutMenuItem = {
    click: showAboutDialog,
    label: `About ${APP_DISPLAY_NAME}`,
  };
  const directoryState = readDirectoryModeStateFromConfig();
  const openMenuItems = [
    {
      accelerator: "CmdOrCtrl+O",
      click: () => void chooseFileAndOpen(),
      label: "Open File...",
    },
    {
      accelerator: "CmdOrCtrl+Shift+O",
      click: () => void chooseDirectoryAndOpen(),
      label: "Open Folder...",
    },
    {
      label: "Open Recent",
      submenu: directoryState.recent.length
        ? [
            ...directoryState.recent.map((directoryPath) => ({
              click: () => sendDirectoryCommand({ type: "open-directory", path: directoryPath }),
              label: recentDirectoryLabel(directoryPath),
              toolTip: directoryPath,
            })),
            { type: "separator" },
            {
              click: () => sendDirectoryCommand({ type: "clear-recent" }),
              label: "Clear Recently Opened",
            },
          ]
        : [{ enabled: false, label: "No Recent Folders" }],
    },
    {
      label: "Remove Folder from Libera",
      enabled: directoryState.folders.length > 0,
      submenu: directoryState.folders.length
        ? directoryState.folders.map((folder) => ({
            click: () => sendDirectoryCommand({ type: "close-directory", name: folder.name }),
            // Electron treats "&" as a mnemonic marker on Windows and Linux.
            label: folder.name.replace(/&/g, "&&"),
            toolTip: folder.path,
          }))
        : [{ enabled: false, label: "No Linked Folders" }],
    },
    { type: "separator" },
  ];
  const checkForUpdatesMenuItem = {
    click: () => void updaterService.check(),
    enabled: app.isPackaged,
    label: "Check for Updates...",
  };
  const template = [
    ...(isMac
      ? [
          {
            label: APP_DISPLAY_NAME,
            submenu: [
              aboutMenuItem,
              checkForUpdatesMenuItem,
              { type: "separator" },
              configurationMenuItem,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { label: `Hide ${APP_DISPLAY_NAME}`, role: "hide" },
              { label: "Hide Others", role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { label: `Quit ${APP_DISPLAY_NAME}`, role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        ...openMenuItems,
        ...(isMac ? [] : [configurationMenuItem, { type: "separator" }]),
        closeTabMenuItem,
        ...(isMac ? [] : [{ type: "separator" }, { role: "quit" }]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { type: "separator" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    ...(isMac
      ? [
          {
            label: "Window",
            submenu: [{ role: "minimize" }, { role: "zoom" }],
          },
        ]
      : [
          {
            label: "Help",
            submenu: [checkForUpdatesMenuItem, { type: "separator" }, aboutMenuItem],
          },
        ]),
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function installExportHandlers() {
  const standaloneMarkdownFiles = new Map();
  ipcMain.handle("export:markdown-file", async (event, input) => {
    if (!input || typeof input.content !== "string" || typeof input.fileName !== "string") {
      throw new Error("Invalid Markdown file.");
    }
    const previous = standaloneMarkdownFiles.get(input.saveId);
    if (previous && previous.senderId === event.sender.id) {
      await fsp.writeFile(previous.filePath, input.content, "utf8");
      return { canceled: false, saveId: input.saveId, fileName: path.basename(previous.filePath) };
    }
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const result = await dialog.showSaveDialog(parentWindow, {
      defaultPath: path.join(app.getPath("documents"), path.basename(input.fileName)),
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      title: "Save Markdown file",
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fsp.writeFile(result.filePath, input.content, "utf8");
    const saveId = randomBytes(24).toString("hex");
    standaloneMarkdownFiles.set(saveId, { filePath: result.filePath, senderId: event.sender.id });
    event.sender.once("destroyed", () => standaloneMarkdownFiles.delete(saveId));
    return { canceled: false, saveId, fileName: path.basename(result.filePath) };
  });
  ipcMain.handle("export:markdown-pdf", exportMarkdownPdf);
  ipcMain.handle("export:text-file", async (event, input) => {
    if (!input || typeof input.content !== "string" || typeof input.fileName !== "string" || input.content.length > 50 * 1024 * 1024) {
      throw new Error("Invalid text file.");
    }
    const extensions = Array.isArray(input.extensions)
      ? input.extensions.filter((extension) => typeof extension === "string" && /^[a-z0-9]{1,8}$/i.test(extension)).slice(0, 4)
      : [];
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const result = await dialog.showSaveDialog(parentWindow, {
      defaultPath: path.join(app.getPath("documents"), path.basename(input.fileName)),
      filters: extensions.length ? [{ name: typeof input.filterName === "string" ? input.filterName.slice(0, 60) : "Text", extensions }] : [],
      title: "Save As",
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fsp.writeFile(result.filePath, input.content, "utf8");
    return { canceled: false, fileName: path.basename(result.filePath) };
  });
}

function getWindowFromIpcEvent(event) {
  const window = BrowserWindow.fromWebContents(event.sender);

  return window && !window.isDestroyed() ? window : null;
}

function normalizeNativeMenuString(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.trim();

  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function normalizeNativeMenuCoordinate(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.round(value));
}

function buildNativeMenuTemplate(items, selectItem, depth = 0) {
  if (!Array.isArray(items) || depth > 3) {
    return [];
  }

  const template = [];

  for (const item of items.slice(0, MAX_NATIVE_MENU_ITEMS)) {
    if (!item || typeof item !== "object") {
      continue;
    }

    if (item.type === "separator") {
      if (template.length && template.at(-1).type !== "separator") {
        template.push({ type: "separator" });
      }

      continue;
    }

    const id = normalizeNativeMenuString(item.id, MAX_NATIVE_MENU_ID_LENGTH);
    const label = normalizeNativeMenuString(item.label, MAX_NATIVE_MENU_LABEL_LENGTH);

    if (!id || !label) {
      continue;
    }

    if (Array.isArray(item.submenu)) {
      const submenu = buildNativeMenuTemplate(item.submenu, selectItem, depth + 1);
      if (submenu.length) template.push({ id, label, enabled: item.enabled !== false, submenu });
      continue;
    }

    const type = NATIVE_MENU_ITEM_TYPES.has(item.type) ? item.type : "normal";
    const menuItem = {
      id,
      label,
      type,
      enabled: item.enabled !== false,
      click: () => selectItem(id),
    };

    if (type === "checkbox" || type === "radio") {
      menuItem.checked = Boolean(item.checked);
    }

    template.push(menuItem);
  }

  while (template.at(-1)?.type === "separator") {
    template.pop();
  }

  return template;
}

function installNativeMenuHandlers() {
  ipcMain.handle("menu:popup", (event, input) => {
    const window = getWindowFromIpcEvent(event);

    if (!window) {
      return null;
    }

    return new Promise((resolve) => {
      let selectedItemId = null;
      const template = buildNativeMenuTemplate(input?.items, (id) => {
        selectedItemId = id;
      });

      if (!template.length) {
        resolve(null);
        return;
      }

      const x = normalizeNativeMenuCoordinate(input?.x);
      const y = normalizeNativeMenuCoordinate(input?.y);
      const popupOptions = {
        window,
        callback: () => resolve(selectedItemId),
      };

      if (typeof x === "number" && typeof y === "number") {
        popupOptions.x = x;
        popupOptions.y = y;
      }

      if (event.senderFrame) {
        popupOptions.frame = event.senderFrame;
      }

      Menu.buildFromTemplate(template).popup(popupOptions);
    });
  });
}

function installFileExplorerHandlers() {
  ipcMain.handle("file-explorer:reveal-notebook", async (_event, notebook) => {
    const safeNotebook = assertSafePathSegment(notebook, "Notebook name");
    const adminRoot = getAdminRootFromConfig();
    const folder = findLinkedFolder(readDirectoryModeState(adminRoot), safeNotebook);
    const notebookDirectory = folder?.path ?? path.join(adminRoot, safeNotebook);
    if (!folder) assertPathInside(adminRoot, notebookDirectory);

    const stats = await fsp.stat(notebookDirectory);

    if (!stats.isDirectory()) {
      throw new Error("Notebook directory was not found.");
    }

    const errorMessage = await shell.openPath(notebookDirectory);

    if (errorMessage) {
      throw new Error(errorMessage);
    }
  });

  ipcMain.handle("file-explorer:reveal-item", async (_event, relativePath) => {
    const targetPath = resolveContextItemPath(relativePath);

    const stats = await fsp.stat(targetPath);

    if (!stats.isFile() && !stats.isDirectory()) {
      throw new Error("Item was not found.");
    }

    shell.showItemInFolder(targetPath);
  });

  ipcMain.handle("clipboard:copy-item-path", async (_event, relativePath, mode) => {
    if (mode !== "relative" && mode !== "absolute") {
      throw new Error("Copy path mode is invalid.");
    }

    const targetPath = resolveContextItemPath(relativePath);

    const stats = await fsp.stat(targetPath);

    if (!stats.isFile()) {
      throw new Error("File was not found.");
    }

    clipboard.writeText(mode === "absolute" ? targetPath : relativePath);
  });
}

function installWindowControlHandlers() {
  function checkpointRoot(event, contextRoot) {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame ||
        new URL(event.senderFrame.url).origin !== new URL(nextServerUrl).origin) {
      throw new Error("Workspace checkpoint sender is invalid.");
    }
    const stateRoot = contextStateRoot(getAdminRootFromConfig(), contextRoot);
    if (!stateRoot) throw new Error("This folder is no longer open in Libera.");
    return stateRoot;
  }
  ipcMain.on("state:ready", (event, ready) => {
    if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents && event.senderFrame === event.sender.mainFrame) {
      rendererStateReady = ready === true;
    }
  });
  ipcMain.on("workspaces:checkpoint", (event, body, contextRoot) => {
    try {
      // Notebooks and linked folders share the library session.
      writeWorkspaceRecovery(checkpointRoot(event, contextRoot), body);
      event.returnValue = { saved: true };
    } catch (error) {
      event.returnValue = { saved: false, error: error.message };
    }
  });
  ipcMain.on("workspaces:remember", (event, body, contextRoot) => {
    try {
      const stateRoot = checkpointRoot(event, contextRoot);
      const localRoot = localWorkspaceRecoveryRoot(app.getPath("userData"), stateRoot);
      writeWorkspaceRecovery(localRoot, body, stateRoot);
      event.returnValue = { saved: true };
    } catch (error) { event.returnValue = { saved: false, error: error.message }; }
  });
  ipcMain.handle("workspaces:read-recovery", async (event, contextRoot) => {
    const localRoot = localWorkspaceRecoveryRoot(app.getPath("userData"), checkpointRoot(event, contextRoot));
    try { return await fsp.readFile(path.join(localRoot, ".libera-workspaces-recovery.json"), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  });
  ipcMain.handle("search:reveal-index", (_event, filePath) => revealSearchIndex(filePath));

  ipcMain.handle("search:use-existing-index", async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    if (parentWindow !== mainWindow) return "";
    const filePath = await selectSearchIndexFile(parentWindow, "existing");
    return filePath ? useSearchIndexFile(filePath) : "";
  });

  ipcMain.handle("preferences:open", (event, section) => {
    if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) return;
    void openConfigurationWindow(section);
  });

  ipcMain.handle("window:minimize", (event) => {
    getWindowFromIpcEvent(event)?.minimize();
  });

  ipcMain.handle("window:toggle-maximize", (event) => {
    const window = getWindowFromIpcEvent(event);

    if (!window) {
      return;
    }

    if (window.isMaximized()) {
      window.unmaximize();
      return;
    }

    window.maximize();
  });

  ipcMain.handle("window:close", (event) => {
    getWindowFromIpcEvent(event)?.close();
  });

  // Drive the native appearance from the renderer's resolved theme. This makes
  // the macOS vibrancy material render dark in dark mode (and light in light
  // mode), so light text keeps contrast against the glass instead of sitting on
  // a washed-out light material.
  ipcMain.handle("window:set-theme", (_event, theme) => {
    nativeTheme.themeSource =
      theme === "dark" ? "dark" : theme === "light" ? "light" : "system";
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("Unable to choose a local port."));
        }
      });
    });
  });
}

function getNodeExecutable() {
  return process.env.npm_node_execpath || process.env.NODE || "node";
}

function applyServerEnv(env) {
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
}

function isExternalBrowserUrl(url) {
  try {
    const parsedUrl = new URL(url);

    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
}

function isSameOrigin(url, appUrl) {
  try {
    return new URL(url).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

async function startNextServer(config) {
  const appRoot = getAppRoot();
  const mode = process.env.LIBERA_ELECTRON_NEXT_MODE === "dev" ? "dev" : "start";
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  const standaloneServer = path.join(appRoot, ".next", "standalone", "server.js");
  const useStandalone = mode === "start" && fs.existsSync(standaloneServer);
  const nextBin = path.join(appRoot, "node_modules", "next", "dist", "bin", "next");
  const env = {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    LIBERA_CONFIG_PATH: getConfigPath(),
    LIBERA_DATA_DIR: config.dataDir,
    LIBERA_ELECTRON: "1",
    LIBERA_SEARCH_WORKER_PATH: path.join(__dirname, "search-worker.mjs"),
    LIBERA_DOCUMENT_OCR_WORKER_PATH: path.join(__dirname, "document-ocr-worker.mjs"),
    LIBERA_TRANSCRIPTION_WORKER_PATH: path.join(__dirname, "transcription-worker.mjs"),
    LIBERA_TTS_WORKER_PATH: path.join(__dirname, "tts-worker.mjs"),
    LIBERA_DETECTION_WORKER_PATH: path.join(__dirname, "detection-worker.py"),
    ...collabHost.environment(),
    LIBERA_YOUR_NAME: normalizeYourName(config.yourName),
    LIBERA_SMART_PASTE: normalizeSmartPaste(config.smartPaste) ? "1" : "0",
    LIBERA_SOURCE_EDITOR: normalizeSourceEditor(config.sourceEditor),
    LIBERA_MARKDOWN_INLINE_MATH_MARKERS: normalizeMathMarkers(config.markdownInlineMathMarkers, DEFAULT_INLINE_MATH_MARKERS),
    LIBERA_MARKDOWN_BLOCK_MATH_MARKERS: normalizeMathMarkers(config.markdownBlockMathMarkers, DEFAULT_BLOCK_MATH_MARKERS),
    LIBERA_MARKDOWN_EDITOR_FONT_FAMILY: normalizeMarkdownEditorFontFamily(
      config.markdownEditorFontFamily,
    ),
    LIBERA_WYSIWYG_EDITOR_FONT_FAMILY: normalizeWysiwygEditorFontFamily(
      config.wysiwygEditorFontFamily,
    ),
    LIBERA_RENDERED_MARKDOWN_FONT_FAMILY: normalizeRenderedMarkdownFontFamily(
      config.renderedMarkdownFontFamily,
    ),
    LIBERA_MARKDOWN_BASE_FONT_SIZE: String(
      normalizeMarkdownBaseFontSize(config.markdownBaseFontSize),
    ),
    LIBERA_MARKDOWN_BASE_LINE_HEIGHT: String(
      normalizeMarkdownBaseLineHeight(config.markdownBaseLineHeight),
    ),
    LIBERA_MARKDOWN_PDF_BASE_FONT_SIZE: String(
      normalizeMarkdownBaseFontSize(config.markdownPdfBaseFontSize),
    ),
    LIBERA_MARKDOWN_PDF_BASE_LINE_HEIGHT: String(
      normalizeMarkdownBaseLineHeight(config.markdownPdfBaseLineHeight),
    ),
    LIBERA_PASSWORD_HASH: config.passwordHash,
    LIBERA_OPENROUTER_MODEL: normalizeOpenRouterModel(config.openRouterModel),
    ...aiPreferencesEnvironment(config.aiFunctions, normalizeOpenRouterModel(config.openRouterModel)),
    LIBERA_SESSION_SECRET: config.sessionSecret,
    LIBERA_THEME: normalizeThemePreference(config.themePreference),
    NODE_ENV: mode === "dev" ? "development" : "production",
    OPENAI_API_KEY: config.openaiApiKey,
    PORT: String(port),
  };
  const devArgs = [nextBin, "dev", "--webpack", "-H", "127.0.0.1", "-p", String(port)];
  const commandArgs = useStandalone
    ? [standaloneServer]
    : mode === "dev"
      ? devArgs
      : [nextBin, mode, "-H", "127.0.0.1", "-p", String(port)];
  const cwd = useStandalone ? path.dirname(standaloneServer) : appRoot;

  if (useStandalone) {
    applyServerEnv(env);
    require(standaloneServer);
    applyApplicationIdentity();
    await waitForServer(url);
    applyApplicationIdentity();

    return url;
  }

  nextProcess = spawn(getNodeExecutable(), commandArgs, {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  nextProcess.stdout.on("data", (chunk) => {
    process.stdout.write(`[next] ${chunk}`);
  });

  nextProcess.stderr.on("data", (chunk) => {
    process.stderr.write(`[next] ${chunk}`);
  });

  const serverProcess = nextProcess;
  let serverReady = false;
  serverProcess.on("error", (error) => {
    console.error(`[next] ${error.message}`);
  });
  serverProcess.on("exit", (code, signal) => {
    if (serverReady && !isQuitting) {
      dialog.showErrorBox(
        `${APP_DISPLAY_NAME} server stopped`,
        `The local Next.js server stopped unexpectedly (${signal ?? code}).`,
      );
      app.quit();
    }
  });

  await waitForServer(url, { child: serverProcess });
  serverReady = true;

  return url;
}

// Describe the native "liquid glass" backdrop available on this platform.
// macOS uses NSVisualEffectView vibrancy; Windows 11 22H2+ uses the acrylic
// system backdrop. Everything else falls back to the opaque UI.
function getDesktopGlass() {
  if (process.platform === "darwin") {
    return { platform: "darwin", enabled: true };
  }

  if (process.platform === "win32") {
    const buildNumber = Number.parseInt(os.release().split(".")[2] ?? "", 10);
    return { platform: "win32", enabled: Number.isFinite(buildNumber) && buildNumber >= 22621 };
  }

  return { platform: process.platform, enabled: false };
}

async function createMainWindow(url) {
  // Require a fresh sign-in without erasing host-scoped appearance preferences.
  await clearLoginCookie(session.defaultSession, url);

  const glass = getDesktopGlass();
  const isMacGlass = glass.enabled && glass.platform === "darwin";
  const isWindowsGlass = glass.enabled && glass.platform === "win32";

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    icon: getIconPath(),
    minWidth: 960,
    minHeight: 640,
    // Native boolean options must be explicit: passing undefined can coerce to
    // false and disable resizing/zoom and native fullscreen on macOS.
    minimizable: true,
    movable: true,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    autoHideMenuBar: isWindowsGlass,
    title: APP_DISPLAY_NAME,
    show: !isWindowsGlass,
    accentColor: isWindowsGlass ? false : undefined,
    backgroundColor: glass.enabled ? "#00000000" : undefined,
    // On Windows, hidden titleBarStyle makes this internally frameless;
    // thickFrame retains the native resize border, shadow and animations.
    frame: true,
    thickFrame: true,
    // transparent:true forces thickFrame off in Electron. Use the acrylic
    // backdrop with transparent web content instead of a transparent HWND.
    transparent: false,
    // Preserve macOS traffic lights; Windows uses the app's existing controls.
    titleBarStyle: glass.enabled ? "hidden" : undefined,
    // Vertically centre the traffic lights in the 36px (.libera-titlebar) drag
    // strip: (36 - 12) / 2 = 12.
    trafficLightPosition: isMacGlass ? { x: 16, y: 12 } : undefined,
    vibrancy: isMacGlass ? "under-window" : undefined,
    visualEffectState: isMacGlass ? "active" : undefined,
    backgroundMaterial: isWindowsGlass ? "acrylic" : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer shows collaborators' content (security §7): keep it in
      // Chromium's sandbox. Electron 20+ sandboxes by default, but saying so
      // here stops a later preload change from silently turning it off. The
      // preload uses only sandbox-safe modules (electron's contextBridge,
      // ipcRenderer, webFrame) and process.argv/platform; workspace
      // checkpoints keep using ipcRenderer.sendSync, which works sandboxed.
      // scripts/collab/p4d-sandbox.test.ts loads it in a sandboxed window.
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
      additionalArguments: [
        `--libera-platform=${glass.platform}`,
        `--libera-glass=${glass.enabled ? "1" : "0"}`,
      ],
    },
  });

  // Electron disables native visual pinch by default. Let Chromium magnify the
  // existing surface without PDF.js rendering or cancellable wheel listeners.
  const enableNativePinch = (contents) => {
    contents.on("did-finish-load", () => {
      void contents.setVisualZoomLevelLimits(1, 4).catch((error) => {
        console.error("Could not enable native pinch zoom", error);
      });
    });
  };
  enableNativePinch(mainWindow.webContents);

  mainWindow.setMenuBarVisibility(!isWindowsGlass);
  let closingAfterFlush = false;
  let closeFlush = null;
  mainWindow.on("close", (event) => {
    if (shutdownComplete || closingAfterFlush || !rendererStateReady) return;
    event.preventDefault();
    if (closeFlush) return;
    const closingWindow = mainWindow;
    closeFlush = requestStateFlush(closingWindow.webContents, ipcMain).then(() => {
      if (closingWindow.isDestroyed()) return;
      closingAfterFlush = true;
      closingWindow.close();
      // beforeunload may cancel closing because an editor has unsaved text.
      closingAfterFlush = false;
    }).catch((error) => {
      dialog.showErrorBox("Could not save session", error.message);
    }).finally(() => { closeFlush = null; });
  });
  mainWindow.webContents.on("did-start-loading", () => { rendererStateReady = false; });
  mainWindow.on("closed", () => {
    // BrowserWindow.webContents throws after destruction, even with optional
    // chaining. Clear both references before quit re-enters the save path.
    rendererStateReady = false;
    mainWindow = null;
    if (quitRequested) app.quit();
  });
  if (isWindowsGlass) {
    maintainWindowsBackdrop(mainWindow, nativeTheme);
    mainWindow.once("ready-to-show", () => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.show();
      }
    });
  }

  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (
      input.type !== "keyDown" ||
      input.key !== "Tab" ||
      !input.control ||
      input.meta ||
      input.alt
    ) {
      return;
    }

    event.preventDefault();
    dispatchRendererTabShortcut(mainWindow.webContents, Boolean(input.shift));
  });
  // Same-origin pages the renderer may open as child windows: duplicated
  // Markdown previews, duplicated PDF/image tabs and popped-out LaTeX PDFs.
  const childWindowSizes = new Map([["/markdown-preview", [900, 800]], ["/file-window", [1000, 850]], ["/latex-pdf-window", [900, 1000]]]);
  const childWindowSize = (targetUrl) =>
    isSameOrigin(targetUrl, url) ? childWindowSizes.get(new URL(targetUrl).pathname) : undefined;
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    const size = childWindowSize(targetUrl);
    if (size) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: size[0],
          height: size[1],
          minWidth: 360,
          minHeight: 300,
          frame: true,
          transparent: false,
          titleBarStyle: "default",
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            // Overriding webPreferences drops the opener's preload. With
            // collaboration on, pop-outs need window.liberaCollab for shared files.
            ...(collabHost.enabled ? { preload: path.join(__dirname, "preload.cjs") } : {}),
          },
        },
      };
    }
    if (isExternalBrowserUrl(targetUrl)) {
      void shell.openExternal(targetUrl);
    }

    return { action: "deny" };
  });
  mainWindow.webContents.on("did-create-window", (child) => {
    enableNativePinch(child.webContents);
    child.setMenuBarVisibility(false);
    child.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
      if (isExternalBrowserUrl(targetUrl) && !isSameOrigin(targetUrl, url)) {
        void shell.openExternal(targetUrl);
      }
      return { action: "deny" };
    });
    child.webContents.on("will-navigate", (event, targetUrl) => {
      if (childWindowSize(targetUrl)) return;
      event.preventDefault();
      if (isExternalBrowserUrl(targetUrl) && !isSameOrigin(targetUrl, url)) {
        void shell.openExternal(targetUrl);
      }
    });
  });
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (isSameOrigin(targetUrl, url)) {
      return;
    }

    event.preventDefault();

    if (isExternalBrowserUrl(targetUrl)) {
      void shell.openExternal(targetUrl);
    }
  });
  mainWindow.loadURL(url);
}

async function bootstrap() {
  if (!hasInstanceLock) return;
  try {
    applyApplicationIdentity();

    if (process.platform === "darwin") {
      app.dock.setIcon(getIconPath());
    }

    let config = readConfig();

    if (!isConfigComplete(config)) {
      config = await createSetupWindow({ mode: "setup" });
    }

    // Before Next, so the control API's URL and token are in Next's env.
    await collabHost.start(config).catch((error) => {
      console.error(`Collaboration is unavailable: ${error.message}`);
    });
    if (isQuitting) return;
    const url = await startNextServer(config);
    if (isQuitting) return;
    nextServerUrl = url;
    installExportHandlers();
    installNativeMenuHandlers();
    installFileExplorerHandlers();
    installDirectoryModeHandlers();
    installWindowControlHandlers();
    installApplicationMenu();
    await createMainWindow(url);
    updaterService.initialize();
  } catch (error) {
    if (isQuitting) return;
    if (error.message !== "Setup was canceled.") {
      dialog.showErrorBox(`Unable to start ${APP_DISPLAY_NAME}`, error.message);
    }

    app.quit();
  }
}

app.on("ready", bootstrap);

function prepareToQuit() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    if (rendererStateReady && mainWindow && !mainWindow.isDestroyed()) {
      await requestStateFlush(mainWindow.webContents, ipcMain);
    }
    isQuitting = true;
    updaterService.dispose();
    // The host flushes its SQLite work and closes before Next goes away.
    await collabHost.stop().catch((error) => {
      console.error(`Could not stop the collaboration host: ${error.message}`);
    });
    await stopProcessTree(nextProcess).catch((error) => {
      console.error(`Could not stop the Next.js server: ${error.message}`);
    });
    nextProcess = null;
    shutdownComplete = true;
  })().catch((error) => {
    shutdownPromise = null;
    isQuitting = false;
    throw error;
  });
  return shutdownPromise;
}

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  // Let beforeunload accept or cancel closing while the server still runs.
  // Once the main window closes, the next quit finishes server shutdown.
  if (mainWindow && !mainWindow.isDestroyed()) {
    quitRequested = true;
    mainWindow.close();
    return;
  }
  void prepareToQuit().then(() => app.quit()).catch((error) => {
    dialog.showErrorBox("Could not save session", error.message);
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => app.quit());
}

app.on("window-all-closed", () => {
  app.quit();
});
