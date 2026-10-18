// Electron main script for p4d-sandbox.test.ts: loads the real
// electron/preload.cjs into a sandboxed window and into an unsandboxed one,
// answers every IPC channel the preload uses with an echo, calls every
// exposed window.libera* function, and prints one JSON line with the API
// shapes, call results and any preload errors. Run with a throwaway
// --user-data-dir; it never touches the user's profile.

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, MessageChannelMain, ipcMain } = require("electron");

const preload = path.resolve(__dirname, "../../electron/preload.cjs");
const source = fs.readFileSync(preload, "utf8");
const channels = (pattern) => [...new Set([...source.matchAll(pattern)].map((match) => match[1]))];
const invokeChannels = channels(/ipcRenderer\.invoke\(\s*"([^"]+)"/g);
const syncChannels = channels(/ipcRenderer\.sendSync\(\s*"([^"]+)"/g);
const sendChannels = channels(/ipcRenderer\.send\(\s*"([^"]+)"/g);

const received = [];
for (const channel of invokeChannels) {
  if (channel === "collab:attach") continue;
  ipcMain.handle(channel, (_event, ...args) => ({ channel, args }));
}
ipcMain.handle("collab:attach", (event, docId, requestId) => {
  const { port1, port2 } = new MessageChannelMain();
  port1.start();
  port1.on("message", (message) => port1.postMessage({ echo: message.data }));
  event.senderFrame.postMessage("collab:port", { requestId, docId }, [port2]);
  return true;
});
for (const channel of syncChannels) {
  ipcMain.on(channel, (event, ...args) => {
    event.returnValue = channel === "collab:enabled" ? true : { channel, args };
  });
}
for (const channel of sendChannels) ipcMain.on(channel, (_event, ...args) => received.push({ channel, args }));

// Runs in the page (main world). Lists every libera* global and calls each function.
const probe = `(async () => {
  const report = { globals: {}, calls: {}, errors: [] };
  const names = Object.keys(window).filter((key) => key.startsWith("libera")).sort();
  for (const name of names) {
    const api = window[name];
    report.globals[name] = Object.fromEntries(Object.keys(api).sort().map((key) => [key, typeof api[key]]));
    for (const key of Object.keys(api).sort()) {
      if (typeof api[key] !== "function") { report.calls[name + "." + key] = api[key]; continue; }
      try {
        if (name === "liberaCollab" && key === "attach") {
          const port = await api.attach("doc_probe");
          const echoed = await new Promise((resolve) => { port.onmessage = (event) => resolve(event.data); port.postMessage("ping"); });
          report.calls[name + "." + key] = { port: port instanceof MessagePort, echoed };
          continue;
        }
        if (key.startsWith("on")) {
          const off = api[key](() => {});
          report.calls[name + "." + key] = typeof off;
          if (typeof off === "function") off();
          continue;
        }
        const result = await api[key]("probe-arg", "second-arg");
        report.calls[name + "." + key] = result === undefined ? "undefined" : result;
      } catch (error) {
        report.errors.push(name + "." + key + ": " + (error && error.message));
      }
    }
  }
  return report;
})()`;

const windows = [];

async function run(sandbox) {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox,
      preload,
      additionalArguments: ["--libera-platform=probe-os", "--libera-glass=1"],
    },
  });
  const preloadErrors = [];
  const consoleErrors = [];
  window.webContents.on("render-process-gone", (_event, details) => preloadErrors.push(`renderer gone: ${details.reason} (${details.exitCode})`));
  window.webContents.on("did-fail-load", (_event, code, description) => preloadErrors.push(`load failed: ${code} ${description}`));
  window.webContents.on("preload-error", (_event, file, error) => preloadErrors.push(`${path.basename(file)}: ${error.message}`));
  window.webContents.on("console-message", (details) => {
    const level = typeof details === "object" && details ? details.level : undefined;
    const message = typeof details === "object" && details ? details.message : String(details);
    if (level === "error" || level === 3) consoleErrors.push(message);
  });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent("<!doctype html><title>probe</title><body>probe</body>")}`).catch((error) => preloadErrors.push(String(error.message)));
  if (preloadErrors.length) return { preloadErrors };
  const report = await window.webContents.executeJavaScript(probe, true);
  const sandboxed = await window.webContents.executeJavaScript("typeof require === 'undefined' && typeof process === 'undefined'", true);
  // Windows stay open until the end: destroying one and loading the next at
  // once can hand the new page the dying renderer process (ERR_FAILED).
  windows.push(window);
  return { ...report, preloadErrors, consoleErrors, pageHasNoNode: sandboxed };
}

// Proves what "sandboxed" means for a preload in this Electron: process.sandboxed
// is set and Node modules cannot be required.
async function environment(sandbox) {
  const file = path.join(app.getPath("userData"), "p4d-env-probe.cjs");
  fs.writeFileSync(
    file,
    `const { contextBridge } = require("electron");
let fsBlocked = false;
try { require("fs"); } catch { fsBlocked = true; }
contextBridge.exposeInMainWorld("__p4dEnv", { sandboxed: process.sandboxed === true, fsBlocked });`,
  );
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox, preload: file } });
  await window.loadURL("data:text/html;charset=utf-8,env");
  const result = await window.webContents.executeJavaScript("window.__p4dEnv", true);
  windows.push(window);
  return result;
}

app.whenReady().then(async () => {
  try {
    const sandboxed = await run(true);
    const unsandboxed = await run(false);
    const env = { sandboxed: await environment(true), unsandboxed: await environment(false) };
    for (const window of windows) window.destroy();
    process.stdout.write(`P4D_SANDBOX_REPORT ${JSON.stringify({ sandboxed, unsandboxed, env, received, invokeChannels, syncChannels, sendChannels })}\n`);
    app.exit(0);
  } catch (error) {
    process.stdout.write(`P4D_SANDBOX_FAILED ${error && error.stack}\n`);
    app.exit(1);
  }
});
