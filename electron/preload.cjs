const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("liberaSetup", {
  getState: () => ipcRenderer.invoke("setup:get-state"),
  save: (input) => ipcRenderer.invoke("setup:save", input),
  selectDataDir: () => ipcRenderer.invoke("setup:select-data-dir"),
});
