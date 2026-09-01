const { app, dialog, ipcMain } = require("electron");

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_CHECK_DELAY_MS = 30_000;

function createUpdaterService({ getMainWindow, onBeforeInstall }) {
  let autoUpdater = null;
  let checkPromise = null;
  let checkTimer = null;
  let initialCheckTimer = null;
  let dirtyDocumentCount = 0;
  let initialized = false;
  let promptedVersion = "";
  let state = {
    status: app.isPackaged ? "idle" : "unsupported",
    currentVersion: app.getVersion(),
  };

  function getWindowFromEvent(event) {
    const window = getMainWindow();

    return window && !window.isDestroyed() && event.sender === window.webContents
      ? window
      : null;
  }

  function publishState(patch) {
    state = {
      ...state,
      ...patch,
      currentVersion: app.getVersion(),
    };

    const window = getMainWindow();

    if (window && !window.isDestroyed()) {
      window.webContents.send("updater:state-changed", state);
    }

    return state;
  }

  function friendlyError(error) {
    const message = error instanceof Error ? error.message : String(error ?? "");

    return message.trim() || "The update check failed.";
  }

  async function promptForRestart(version) {
    if (promptedVersion === version) {
      return;
    }

    promptedVersion = version;
    const window = getMainWindow();
    const hasUnsavedDocuments = dirtyDocumentCount > 0;
    const options = {
      type: "info",
      buttons: hasUnsavedDocuments ? ["Later"] : ["Restart and Update", "Later"],
      cancelId: hasUnsavedDocuments ? 0 : 1,
      defaultId: 0,
      title: "Libera Update Ready",
      message: `Libera ${version} has been downloaded.`,
      detail: hasUnsavedDocuments
        ? "Save your open edits, then use Restart and Update in the About dialog."
        : "Restart Libera now to install the update, or install it the next time you quit.",
    };
    const result = window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);

    if (!hasUnsavedDocuments && result.response === 0) {
      restartAndInstall();
    }
  }

  function restartAndInstall() {
    if (!autoUpdater || state.status !== "downloaded") {
      throw new Error("No downloaded update is ready to install.");
    }

    if (dirtyDocumentCount > 0) {
      throw new Error("Save all open edits before restarting to install the update.");
    }

    onBeforeInstall();
    autoUpdater.quitAndInstall(false, true);
  }

  async function check({ manual = false } = {}) {
    if (!app.isPackaged || !autoUpdater) {
      return publishState({ status: "unsupported" });
    }

    if (["available", "downloading", "downloaded"].includes(state.status)) {
      return state;
    }

    if (checkPromise) {
      return checkPromise;
    }

    publishState({
      status: "checking",
      error: undefined,
      manual,
      percent: undefined,
    });

    checkPromise = autoUpdater
      .checkForUpdates()
      .then(() => state)
      .catch((error) => {
        publishState({ status: "error", error: friendlyError(error), manual });
        return state;
      })
      .finally(() => {
        checkPromise = null;
      });

    return checkPromise;
  }

  function installIpcHandlers() {
    ipcMain.handle("updater:get-state", (event) => {
      if (!getWindowFromEvent(event)) {
        throw new Error("Updater state is unavailable from this window.");
      }

      return state;
    });

    ipcMain.handle("updater:check", (event) => {
      if (!getWindowFromEvent(event)) {
        throw new Error("Update checks are unavailable from this window.");
      }

      return check({ manual: true });
    });

    ipcMain.handle("updater:restart-and-install", (event) => {
      if (!getWindowFromEvent(event)) {
        throw new Error("Update installation is unavailable from this window.");
      }

      restartAndInstall();
    });

    ipcMain.handle("updater:set-dirty-document-count", (event, count) => {
      if (!getWindowFromEvent(event)) {
        throw new Error("Document state is unavailable from this window.");
      }

      dirtyDocumentCount = Number.isInteger(count) && count > 0 ? Math.min(count, 10_000) : 0;
      publishState({ hasUnsavedDocuments: dirtyDocumentCount > 0 });
    });
  }

  function initialize() {
    if (initialized) {
      return;
    }

    initialized = true;
    installIpcHandlers();

    if (!app.isPackaged) {
      return;
    }

    const electronLog = require("electron-log/main");
    const electronUpdater = require("electron-updater");
    autoUpdater = electronUpdater.autoUpdater;
    electronLog.initialize();
    electronLog.transports.file.level = "info";
    autoUpdater.logger = electronLog;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;

    autoUpdater.on("checking-for-update", () => {
      publishState({ status: "checking", error: undefined, percent: undefined });
    });
    autoUpdater.on("update-available", (info) => {
      publishState({ status: "available", availableVersion: info.version, percent: 0 });
    });
    autoUpdater.on("download-progress", (progress) => {
      publishState({
        status: "downloading",
        percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
      });
    });
    autoUpdater.on("update-not-available", () => {
      publishState({ status: "up-to-date", availableVersion: undefined, percent: undefined });
    });
    autoUpdater.on("update-downloaded", (event) => {
      publishState({
        status: "downloaded",
        availableVersion: event.version,
        percent: 100,
      });
      void promptForRestart(event.version);
    });
    autoUpdater.on("error", (error) => {
      publishState({ status: "error", error: friendlyError(error), percent: undefined });
    });

    initialCheckTimer = setTimeout(() => void check(), INITIAL_CHECK_DELAY_MS);
    initialCheckTimer.unref();
    checkTimer = setInterval(() => void check(), CHECK_INTERVAL_MS);
    checkTimer.unref();
  }

  function dispose() {
    if (initialCheckTimer) {
      clearTimeout(initialCheckTimer);
      initialCheckTimer = null;
    }

    if (checkTimer) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
  }

  return {
    check: () => check({ manual: true }),
    dispose,
    getState: () => state,
    initialize,
  };
}

module.exports = { createUpdaterService };
