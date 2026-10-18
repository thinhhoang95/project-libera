// Preload for every Libera window. All of them run sandboxed (main.cjs sets
// sandbox: true), so this file may only require "electron" (contextBridge,
// ipcRenderer, webFrame, webUtils, nativeImage, crashReporter), "events",
// "timers" and "url", and may only read process.argv, platform, env and
// versions. Anything needing Node (fs, path, child_process) belongs in main
// behind an IPC channel. scripts/collab/p4d-sandbox.test.ts loads this file
// in a sandboxed window and checks every exposed API against an unsandboxed
// load.
const { contextBridge, ipcRenderer, webFrame } = require("electron");

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

// Collaboration (electron/collab-host.cjs). Exposed only when the host runs.
// contextBridge cannot pass MessagePorts, so window.liberaCollab is defined in
// the page's own world: attach() asks main for a port, main posts it to this
// preload, and the preload forwards it to the page with window.postMessage
// under a request id. Only `require("electron")` is used here because the
// popped-out file and LaTeX PDF windows load this preload sandboxed.
const COLLAB_PORT_MESSAGE = "libera-collab:port";

function collabEnabled() {
  try {
    return ipcRenderer.sendSync("collab:enabled") === true;
  } catch {
    return false;
  }
}

// Runs in the main world (serialized there), so it must be self-contained.
function installCollabBridge(ipc, messageType) {
  if (window.liberaCollab) return;
  const waiting = new Map();
  let counter = 0;
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== window || !data || data.type !== messageType || typeof data.requestId !== "string") return;
    const entry = waiting.get(data.requestId);
    if (!entry) return;
    waiting.delete(data.requestId);
    clearTimeout(entry.timer);
    event.stopImmediatePropagation();
    const port = event.ports && event.ports[0];
    if (port) entry.resolve(port);
    else entry.reject(new Error("The collaboration service sent no port."));
  });
  const bridge = Object.freeze({
    attach(docId) {
      if (typeof docId !== "string" || !docId) return Promise.reject(new TypeError("A document id is required."));
      counter += 1;
      const requestId = `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2)}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(requestId);
          reject(new Error("The collaboration service did not answer."));
        }, 15000);
        waiting.set(requestId, { resolve, reject, timer });
        Promise.resolve(ipc.requestPort(docId, requestId)).catch((error) => {
          if (!waiting.delete(requestId)) return;
          clearTimeout(timer);
          const message = String((error && error.message) || error).replace(/^Error invoking remote method 'collab:attach': (Error: )?/, "");
          reject(new Error(message));
        });
      });
    },
    onEvent(listener) {
      return ipc.onEvent(listener);
    },
    nudge() {
      ipc.nudge();
    },
  });
  Object.defineProperty(window, "liberaCollab", { value: bridge, enumerable: true, configurable: false, writable: false });
}

if (collabEnabled()) {
  ipcRenderer.on("collab:port", (event, info) => {
    const port = event.ports && event.ports[0];
    if (!port) return;
    if (!info || typeof info.requestId !== "string") {
      port.close();
      return;
    }
    const origin = window.location.origin && window.location.origin !== "null" ? window.location.origin : "*";
    window.postMessage({ type: COLLAB_PORT_MESSAGE, requestId: info.requestId, docId: info.docId }, origin, [port]);
  });
  const ipc = {
    requestPort: (docId, requestId) => ipcRenderer.invoke("collab:attach", docId, requestId),
    onEvent: (listener) => {
      const handler = (_event, hostEvent) => listener(hostEvent);
      ipcRenderer.on("collab:event", handler);
      return () => ipcRenderer.removeListener("collab:event", handler);
    },
    nudge: () => ipcRenderer.send("collab:nudge"),
  };
  if (typeof contextBridge.executeInMainWorld === "function") {
    contextBridge.executeInMainWorld({ func: installCollabBridge, args: [ipc, COLLAB_PORT_MESSAGE] });
  } else {
    // Older Electron: expose the IPC half, then define the bridge in the page.
    contextBridge.exposeInMainWorld("__liberaCollabIpc", ipc);
    void webFrame.executeJavaScript(
      `(${installCollabBridge.toString()})(window.__liberaCollabIpc, ${JSON.stringify(COLLAB_PORT_MESSAGE)}); delete window.__liberaCollabIpc;`,
    );
  }
}
