const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, session, shell } = require("electron");
const { randomBytes, scryptSync } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const CONFIG_FILE_NAME = "libera-electron-config.json";
const SERVER_READY_TIMEOUT_MS = 90_000;
const MARKDOWN_EXPORT_READY_TIMEOUT_MS = 15_000;
const APP_DISPLAY_NAME = "Libera by Thinh Hoang";
const THEME_PREFERENCES = new Set(["light", "dark"]);
const NATIVE_MENU_ITEM_TYPES = new Set(["normal", "checkbox", "radio"]);
const MAX_NATIVE_MENU_ITEMS = 64;
const MAX_NATIVE_MENU_ID_LENGTH = 128;
const MAX_NATIVE_MENU_LABEL_LENGTH = 128;

function applyApplicationIdentity() {
  app.setName(APP_DISPLAY_NAME);
  process.title = APP_DISPLAY_NAME;
  app.setAboutPanelOptions({ applicationName: APP_DISPLAY_NAME });
}

applyApplicationIdentity();

let activeSetupPromise = null;
let activeSetupWindow = null;
let nextProcess = null;
let mainWindow = null;
let nextServerUrl = "";
let isQuitting = false;

function getAppRoot() {
  return app.getAppPath();
}

function getConfigPath() {
  return path.join(app.getPath("userData"), CONFIG_FILE_NAME);
}

function getIconPath() {
  return path.join(getAppRoot(), "assets", "libera-icon.png");
}

function createPasswordHash(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");

  return `scrypt:${salt}:${hash}`;
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

function normalizeThemePreference(themePreference) {
  return THEME_PREFERENCES.has(themePreference) ? themePreference : "";
}

async function writeConfig(config) {
  await fsp.mkdir(path.dirname(getConfigPath()), { recursive: true });
  await fsp.writeFile(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function getConfigStatus(config = readConfig()) {
  return {
    dataDir: typeof config.dataDir === "string" ? config.dataDir : "",
    hasApiKey: typeof config.openaiApiKey === "string" && config.openaiApiKey.trim().length > 0,
    hasPasswordHash:
      typeof config.passwordHash === "string" && config.passwordHash.trim().length > 0,
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
  const password = typeof input?.password === "string" ? input.password : "";
  const passwordConfirmation =
    typeof input?.passwordConfirmation === "string" ? input.passwordConfirmation : "";

  if (!dataDir) {
    throw new Error("Choose a data directory before continuing.");
  }

  if (!openaiApiKey && !existingConfig.openaiApiKey) {
    throw new Error("Enter an OPENAI_API_KEY before continuing.");
  }

  if (!existingConfig.passwordHash) {
    if (!password) {
      throw new Error("Create an app password before continuing.");
    }

    if (password.length < 8) {
      throw new Error("Use an app password with at least 8 characters.");
    }

    if (password !== passwordConfirmation) {
      throw new Error("The password confirmation does not match.");
    }
  }

  return {
    dataDir,
    openaiApiKey,
    password,
  };
}

async function createSetupWindow({ mode = "setup", parentWindow = null } = {}) {
  if (activeSetupWindow && !activeSetupWindow.isDestroyed()) {
    activeSetupWindow.focus();
    return activeSetupPromise;
  }

  activeSetupPromise = new Promise((resolve, reject) => {
    let savedConfig = null;
    const setupWindow = new BrowserWindow({
      width: 560,
      height: 660,
      icon: getIconPath(),
      modal: Boolean(parentWindow),
      parent: parentWindow ?? undefined,
      resizable: false,
      title:
        mode === "configuration"
          ? `${APP_DISPLAY_NAME} Configuration`
          : `Set Up ${APP_DISPLAY_NAME}`,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "preload.cjs"),
      },
    });

    activeSetupWindow = setupWindow;
    setupWindow.setMenuBarVisibility(false);

    ipcMain.handle("setup:get-state", () => getConfigStatus());

    ipcMain.handle("setup:select-data-dir", () => selectDataDir(setupWindow));

    ipcMain.handle("setup:save", async (_event, input) => {
      const existingConfig = readConfig();
      const validated = validateSetupInput(input, existingConfig);

      await fsp.mkdir(validated.dataDir, { recursive: true });

      const nextConfig = {
        ...existingConfig,
        dataDir: validated.dataDir,
        openaiApiKey: validated.openaiApiKey || existingConfig.openaiApiKey,
        passwordHash: existingConfig.passwordHash || createPasswordHash(validated.password),
        sessionSecret: existingConfig.sessionSecret || createSessionSecret(),
      };

      await writeConfig(nextConfig);
      savedConfig = nextConfig;
      setupWindow.close();

      return { ok: true };
    });

    setupWindow.on("closed", () => {
      ipcMain.removeHandler("setup:get-state");
      ipcMain.removeHandler("setup:select-data-dir");
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

    setupWindow.loadFile(path.join(__dirname, "setup.html"), {
      query: { mode },
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
  const focusedWindow = BrowserWindow.getFocusedWindow() ?? mainWindow;

  dispatchRendererCloseTabShortcut(focusedWindow?.webContents);
}

async function openConfigurationWindow() {
  try {
    const updatedConfig = await createSetupWindow({
      mode: "configuration",
      parentWindow: mainWindow,
    });

    if (!updatedConfig) {
      return;
    }

    const result = await showMessageBox(mainWindow, {
      type: "info",
      buttons: ["Restart Now", "Later"],
      cancelId: 1,
      defaultId: 0,
      message: `Restart ${APP_DISPLAY_NAME} to apply configuration changes.`,
      detail:
        `The ${APP_DISPLAY_NAME} Master directory and API key are applied when the local server starts.`,
      title: "Configuration Saved",
    });

    if (result.response === 0) {
      isQuitting = true;
      app.relaunch();
      app.quit();
    }
  } catch (error) {
    if (error.message !== "Setup was canceled.") {
      dialog.showErrorBox("Unable to update configuration", error.message);
    }
  }
}

function installApplicationMenu() {
  applyApplicationIdentity();

  const isMac = process.platform === "darwin";
  const configurationMenuItem = {
    accelerator: "CmdOrCtrl+,",
    click: () => void openConfigurationWindow(),
    label: "Configuration...",
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
  const template = [
    ...(isMac
      ? [
          {
            label: APP_DISPLAY_NAME,
            submenu: [
              aboutMenuItem,
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
            submenu: [aboutMenuItem],
          },
        ]),
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function installExportHandlers() {
  ipcMain.handle("export:markdown-pdf", exportMarkdownPdf);
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

function buildNativeMenuTemplate(items, selectItem) {
  if (!Array.isArray(items)) {
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

function installWindowControlHandlers() {
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

function requestUrl(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });

    request.once("error", reject);
    request.setTimeout(2_000, () => {
      request.destroy(new Error("Timed out waiting for the Next.js server."));
    });
  });
}

async function waitForServer(url) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < SERVER_READY_TIMEOUT_MS) {
    try {
      const statusCode = await requestUrl(url);

      if (statusCode >= 200 && statusCode < 500) {
        return;
      }
    } catch {
      // The server is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("The Next.js server did not start in time.");
}

async function cleanDevTurbopackCache(appRoot) {
  await fsp.rm(path.join(appRoot, ".next", "dev", "cache", "turbopack"), {
    force: true,
    recursive: true,
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
    LIBERA_PASSWORD_HASH: config.passwordHash,
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

  if (mode === "dev") {
    await cleanDevTurbopackCache(appRoot);
  }

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
    stdio: ["ignore", "pipe", "pipe"],
  });

  nextProcess.stdout.on("data", (chunk) => {
    process.stdout.write(`[next] ${chunk}`);
  });

  nextProcess.stderr.on("data", (chunk) => {
    process.stderr.write(`[next] ${chunk}`);
  });

  nextProcess.on("exit", (code, signal) => {
    nextProcess = null;

    if (!isQuitting) {
      dialog.showErrorBox(
        `${APP_DISPLAY_NAME} server stopped`,
        `The local Next.js server stopped unexpectedly (${signal ?? code}).`,
      );
      app.quit();
    }
  });

  await waitForServer(url);

  return url;
}

async function clearLoginCookies() {
  await session.defaultSession.clearStorageData({
    storages: ["cookies"],
  });
}

// Describe the native "liquid glass" backdrop available on this platform.
// macOS uses NSVisualEffectView vibrancy; Windows 11 (build 22000+) uses the
// acrylic system backdrop. Everything else falls back to the opaque UI.
function getDesktopGlass() {
  if (process.platform === "darwin") {
    return { platform: "darwin", enabled: true };
  }

  if (process.platform === "win32") {
    const buildNumber = Number.parseInt(os.release().split(".")[2] ?? "", 10);
    return { platform: "win32", enabled: Number.isFinite(buildNumber) && buildNumber >= 22000 };
  }

  return { platform: process.platform, enabled: false };
}

async function createMainWindow(url) {
  await clearLoginCookies();

  const glass = getDesktopGlass();
  const isMacGlass = glass.enabled && glass.platform === "darwin";
  const isWindowsGlass = glass.enabled && glass.platform === "win32";

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    icon: getIconPath(),
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: false,
    title: APP_DISPLAY_NAME,
    backgroundColor: glass.enabled ? "#00000000" : undefined,
    // On macOS the vibrancy view *is* the window background, so we don't need a
    // transparent window — and `transparent: true` would strip the native
    // rounded corners and force square edges. `titleBarStyle: "hidden"` removes
    // the title bar while keeping the rounded corners, the traffic-light buttons
    // and the system drag region at the top of the window.
    titleBarStyle: isMacGlass ? "hidden" : undefined,
    // Vertically centre the traffic lights in the 36px (.libera-titlebar) drag
    // strip: (36 - 12) / 2 = 12.
    trafficLightPosition: isMacGlass ? { x: 16, y: 12 } : undefined,
    vibrancy: isMacGlass ? "under-window" : undefined,
    visualEffectState: isMacGlass ? "active" : undefined,
    backgroundMaterial: isWindowsGlass ? "acrylic" : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      additionalArguments: [
        `--libera-platform=${glass.platform}`,
        `--libera-glass=${glass.enabled ? "1" : "0"}`,
      ],
    },
  });

  mainWindow.setMenuBarVisibility(true);
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
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (isExternalBrowserUrl(targetUrl)) {
      void shell.openExternal(targetUrl);
    }

    return { action: "deny" };
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
  try {
    applyApplicationIdentity();

    if (process.platform === "darwin") {
      app.dock.setIcon(getIconPath());
    }

    let config = readConfig();

    if (!isConfigComplete(config)) {
      config = await createSetupWindow({ mode: "setup" });
    }

    const url = await startNextServer(config);
    nextServerUrl = url;
    installExportHandlers();
    installNativeMenuHandlers();
    installWindowControlHandlers();
    installApplicationMenu();
    await createMainWindow(url);
  } catch (error) {
    if (error.message !== "Setup was canceled.") {
      dialog.showErrorBox(`Unable to start ${APP_DISPLAY_NAME}`, error.message);
    }

    app.quit();
  }
}

app.on("ready", bootstrap);

app.on("before-quit", () => {
  isQuitting = true;

  if (nextProcess) {
    nextProcess.kill();
    nextProcess = null;
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
