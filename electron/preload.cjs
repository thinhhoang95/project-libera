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
  getState: () => ipcRenderer.invoke("setup:get-state"),
  save: (input) => ipcRenderer.invoke("setup:save", input),
  selectDataDir: () => ipcRenderer.invoke("setup:select-data-dir"),
  loadAiChatCustomInstructionFile: () =>
    ipcRenderer.invoke("setup:load-ai-chat-custom-instruction-file"),
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

contextBridge.exposeInMainWorld("liberaClipboard", {
  copyItemPath: (relativePath, mode) =>
    ipcRenderer.invoke("clipboard:copy-item-path", relativePath, mode),
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
