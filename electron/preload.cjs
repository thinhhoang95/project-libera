const { contextBridge, ipcRenderer } = require("electron");

function readProcessSwitch(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));

  return match ? match.slice(prefix.length) : "";
}

contextBridge.exposeInMainWorld("liberaPlatform", {
  isElectron: true,
  platform: readProcessSwitch("libera-platform") || process.platform,
  glass: readProcessSwitch("libera-glass") === "1",
});

contextBridge.exposeInMainWorld("liberaSetup", {
  close: () => ipcRenderer.invoke("setup:close"),
  onRequestClose: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("setup:request-close", handler);
    return () => ipcRenderer.removeListener("setup:request-close", handler);
  },
  getState: () => ipcRenderer.invoke("setup:get-state"),
  save: (input) => ipcRenderer.invoke("setup:save", input),
  selectDataDir: () => ipcRenderer.invoke("setup:select-data-dir"),
  selectSearchWeights: (kind) => ipcRenderer.invoke("setup:select-search-weights", kind),
  selectSearchIndexFile: (mode) => ipcRenderer.invoke("setup:select-search-index-file", mode),
  revealSearchIndex: (filePath) => ipcRenderer.invoke("setup:reveal-search-index", filePath),
  exportPreferences: () => ipcRenderer.invoke("setup:export-preferences"),
  listOpenRouterModels: (options) => ipcRenderer.invoke("setup:list-openrouter-models", options),
  importPreferences: () => ipcRenderer.invoke("setup:import-preferences"),
  loadAiChatCustomInstructionFile: () =>
    ipcRenderer.invoke("setup:load-ai-chat-custom-instruction-file"),
  loadAiRewriteCustomInstructionFile: () =>
    ipcRenderer.invoke("setup:load-ai-rewrite-custom-instruction-file"),
});

contextBridge.exposeInMainWorld("liberaExport", {
  saveMarkdownFile: (input) => ipcRenderer.invoke("export:markdown-file", input),
  exportMarkdownPdf: (input) => ipcRenderer.invoke("export:markdown-pdf", input),
});

contextBridge.exposeInMainWorld("liberaMenu", {
  popup: (input) => ipcRenderer.invoke("menu:popup", input),
});

contextBridge.exposeInMainWorld("liberaFileExplorer", {
  revealNotebook: (notebook) => ipcRenderer.invoke("file-explorer:reveal-notebook", notebook),
  revealItem: (relativePath) => ipcRenderer.invoke("file-explorer:reveal-item", relativePath),
});

contextBridge.exposeInMainWorld("liberaSearch", {
  revealIndex: (filePath) => ipcRenderer.invoke("search:reveal-index", filePath),
  useExistingIndex: () => ipcRenderer.invoke("search:use-existing-index"),
});

contextBridge.exposeInMainWorld("liberaPreferences", {
  open: (section) => ipcRenderer.invoke("preferences:open", section),
});

contextBridge.exposeInMainWorld("liberaClipboard", {
  copyItemPath: (relativePath, mode) =>
    ipcRenderer.invoke("clipboard:copy-item-path", relativePath, mode),
});

contextBridge.exposeInMainWorld("liberaWorkspaces", {
  checkpoint: (body, root) => ipcRenderer.sendSync("workspaces:checkpoint", body, root),
  remember: (body, root) => ipcRenderer.sendSync("workspaces:remember", body, root),
  readRecovery: (root) => ipcRenderer.invoke("workspaces:read-recovery", root),
});

contextBridge.exposeInMainWorld("liberaPersistence", {
  onFlush: (listener) => {
    const handler = async (_event, id) => {
      try { await listener(); ipcRenderer.send("state:flushed", id); }
      catch (error) { ipcRenderer.send("state:flushed", id, error?.message || "Could not save session state."); }
    };
    ipcRenderer.on("state:flush", handler);
    ipcRenderer.send("state:ready", true);
    return () => {
      ipcRenderer.removeListener("state:flush", handler);
      ipcRenderer.send("state:ready", false);
    };
  },
});

contextBridge.exposeInMainWorld("liberaDirectory", {
  chooseFolder: () => ipcRenderer.invoke("directory:choose-folder"),
  chooseFile: () => ipcRenderer.invoke("directory:choose-file"),
  notifyChanged: () => ipcRenderer.invoke("directory:changed"),
  onCommand: (listener) => {
    const handler = (_event, command) => listener(command);
    ipcRenderer.on("directory:command", handler);
    return () => ipcRenderer.removeListener("directory:command", handler);
  },
});

contextBridge.exposeInMainWorld("liberaWindow", {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  // Keep the native window appearance (and therefore the vibrancy material) in
  // sync with the in-app theme so the glass renders dark in dark mode.
  setTheme: (theme) => ipcRenderer.invoke("window:set-theme", theme),
  onThemeChanged: (listener) => {
    const handler = (_event, theme) => listener(theme);
    ipcRenderer.on("theme:changed", handler);
    return () => ipcRenderer.removeListener("theme:changed", handler);
  },
});

contextBridge.exposeInMainWorld("liberaUpdater", {
  getState: () => ipcRenderer.invoke("updater:get-state"),
  check: () => ipcRenderer.invoke("updater:check"),
  restartAndInstall: () => ipcRenderer.invoke("updater:restart-and-install"),
  setDirtyDocumentCount: (count) =>
    ipcRenderer.invoke("updater:set-dirty-document-count", count),
  onStateChanged: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("updater:state-changed", handler);

    return () => ipcRenderer.removeListener("updater:state-changed", handler);
  },
});
