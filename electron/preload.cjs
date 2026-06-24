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
});

contextBridge.exposeInMainWorld("liberaExport", {
  exportMarkdownPdf: (input) => ipcRenderer.invoke("export:markdown-pdf", input),
});

contextBridge.exposeInMainWorld("liberaWindow", {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  // Keep the native window appearance (and therefore the vibrancy material) in
  // sync with the in-app theme so the glass renders dark in dark mode.
  setTheme: (theme) => ipcRenderer.invoke("window:set-theme", theme),
});
