const { app, BrowserWindow, dialog, ipcMain, session } = require("electron");
const { randomBytes, scryptSync } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const CONFIG_FILE_NAME = "libera-electron-config.json";
const SERVER_READY_TIMEOUT_MS = 90_000;

let nextProcess = null;
let mainWindow = null;
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
    title: "Select Libera data directory",
    properties: ["openDirectory", "createDirectory"],
  });

  return result.canceled ? "" : result.filePaths[0] ?? "";
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

async function createSetupWindow() {
  return new Promise((resolve, reject) => {
    const setupWindow = new BrowserWindow({
      width: 560,
      height: 660,
      icon: getIconPath(),
      resizable: false,
      title: "Set Up Libera",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "preload.cjs"),
      },
    });

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
      setupWindow.close();
      resolve(nextConfig);

      return { ok: true };
    });

    setupWindow.on("closed", () => {
      ipcMain.removeHandler("setup:get-state");
      ipcMain.removeHandler("setup:select-data-dir");
      ipcMain.removeHandler("setup:save");

      if (!isConfigComplete(readConfig())) {
        reject(new Error("Setup was canceled."));
      }
    });

    setupWindow.loadFile(path.join(__dirname, "setup.html"));
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
    LIBERA_DATA_DIR: config.dataDir,
    LIBERA_ELECTRON: "1",
    LIBERA_PASSWORD_HASH: config.passwordHash,
    LIBERA_SESSION_SECRET: config.sessionSecret,
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
    await waitForServer(url);

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
        "Libera server stopped",
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

async function createMainWindow(url) {
  await clearLoginCookies();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    icon: getIconPath(),
    minWidth: 960,
    minHeight: 640,
    title: "Libera",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(url);
}

async function bootstrap() {
  try {
    if (process.platform === "darwin") {
      app.dock.setIcon(getIconPath());
    }

    let config = readConfig();

    if (!isConfigComplete(config)) {
      config = await createSetupWindow();
    }

    const url = await startNextServer(config);
    await createMainWindow(url);
  } catch (error) {
    if (error.message !== "Setup was canceled.") {
      dialog.showErrorBox("Unable to start Libera", error.message);
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
