// Main-process glue for the collab host (collaboration map §3, plan M1.3).
//
// The host (electron/collab/dist/host.cjs) runs in a utilityProcess. This
// module starts it before the Next server so the control API's URL and token
// can go into Next's env, restarts it with backoff if it crashes (same port
// and token, so Next's URL stays valid), forwards sleep/wake and network
// changes, hands MessagePorts to renderers, broadcasts host events to every
// window, encrypts refresh tokens with safeStorage, and stops the host inside
// the quit sequence before Next stops.
//
// Collaboration is on by default. LIBERA_COLLAB=0 in the environment of the
// Electron process turns it off: then nothing here starts, no env is
// injected, and the preload exposes no window.liberaCollab.
//
// The message shapes mirror electron/collab/adapters/protocol.ts.

const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const {
  app,
  BrowserWindow,
  MessageChannelMain,
  ipcMain,
  net: electronNet,
  powerMonitor,
  safeStorage,
  utilityProcess,
} = require("electron");

const PARENT_PROTOCOL_VERSION = 1;
const READY_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;
/** A host that ran this long before crashing restarts from the shortest delay. */
const STABLE_UPTIME_MS = 60_000;
const ONLINE_POLL_MS = 5_000;
const MAX_DOC_ID_LENGTH = 512;
const MAX_REQUEST_ID_LENGTH = 128;

function isCollabEnabled(env = process.env) {
  return env.LIBERA_COLLAB !== "0";
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("Unable to choose a local port."))));
    });
  });
}

/**
 * safeStorage on Linux can fall back to a hard-coded key ("basic_text"),
 * which is no better than plaintext; treat that as unavailable so the host
 * keeps the session in memory only.
 */
function secureStorageAvailable() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform === "linux" && typeof safeStorage.getSelectedStorageBackend === "function") {
    return safeStorage.getSelectedStorageBackend() !== "basic_text";
  }
  return true;
}

function handleSecret(message) {
  if (!secureStorageAvailable()) return { ok: false, error: "Secure storage is not available on this system." };
  try {
    const value = message.op === "encrypt"
      ? safeStorage.encryptString(String(message.value)).toString("base64")
      : safeStorage.decryptString(Buffer.from(String(message.value), "base64"));
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error?.message || "Secure storage failed." };
  }
}

function prefixLines(stream, prefix, chunk) {
  const text = String(chunk);
  stream.write(text.split(/\r?\n/).filter((line, index, lines) => line || index < lines.length - 1).map((line) => `${prefix} ${line}\n`).join(""));
}

/**
 * @param {object} options
 * @param {string} [options.hostPath] the host bundle
 * @param {(frame: Electron.WebFrameMain) => boolean} [options.isTrustedFrame] only app pages may attach
 * @param {() => void} [options.onUpdateRequired] the server needs a newer app (close 4026)
 * @param {() => Electron.BrowserWindow | null} [options.getMainWindow]
 */
function createCollabHost(options = {}) {
  const enabled = isCollabEnabled();
  const hostPath = options.hostPath ?? path.join(__dirname, "collab", "dist", "host.cjs");
  const token = randomBytes(32).toString("base64url");
  let child = null;
  let ready = false;
  let port = 0;
  let url = "";
  let dataDir = "";
  let stopping = false;
  let stopPromise = null;
  let restartTimer = null;
  let restartAttempt = 0;
  let startedAt = 0;
  let onlineTimer = null;
  let lastOnline = null;
  let shutdownId = 0;
  let readyWaiters = [];
  let lastConnection = "";
  let handlersInstalled = false;

  // The preload asks synchronously whether to expose window.liberaCollab;
  // register before any window exists, whether or not the flag is on.
  ipcMain.on("collab:enabled", (event) => {
    event.returnValue = enabled;
  });

  function post(message, transfer) {
    if (!child) return false;
    try {
      child.postMessage(message, transfer);
      return true;
    } catch (error) {
      console.error(`[collab-host] Could not reach the host: ${error.message}`);
      return false;
    }
  }

  function settleReady(error) {
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const waiter of waiters) waiter(error);
  }

  function broadcast(event) {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      try {
        window.webContents.send("collab:event", event);
      } catch {
        // A window that is closing cannot receive events.
      }
    }
    if (event?.t === "status") {
      const connection = event.status?.connection ?? "";
      if (connection === "update-required" && lastConnection !== connection) options.onUpdateRequired?.();
      lastConnection = connection;
    }
  }

  function onMessage(message) {
    if (!message || typeof message !== "object") return;
    switch (message.t) {
      case "ready": {
        ready = true;
        startedAt = Date.now();
        if (message.port !== port) {
          // The old port was taken; the in-process production server reads
          // process.env per request, so it follows. A spawned dev server
          // keeps the old URL until Libera restarts.
          console.warn(`[collab-host] Control API moved from port ${port} to ${message.port}.`);
          port = message.port;
        }
        url = message.url;
        if (process.env.LIBERA_COLLAB_HOST_URL) process.env.LIBERA_COLLAB_HOST_URL = url;
        console.log(`[collab-host] Ready at ${url} (store schema ${message.storeSchemaVersion}).`);
        settleReady(null);
        return;
      }
      case "fatal":
        console.error(`[collab-host] ${message.message}`);
        settleReady(new Error(message.message));
        return;
      case "event":
        broadcast(message.event);
        return;
      case "secret": {
        const result = handleSecret(message);
        post({ t: "secret-result", id: message.id, ...result });
        return;
      }
      default:
    }
  }

  function scheduleRestart() {
    if (stopping || restartTimer) return;
    if (startedAt && Date.now() - startedAt > STABLE_UPTIME_MS) restartAttempt = 0;
    const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** restartAttempt);
    restartAttempt++;
    console.warn(`[collab-host] Restarting in ${Math.round(delay / 1000)} s.`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      spawnHost();
    }, delay);
  }

  function spawnHost() {
    if (stopping) return;
    ready = false;
    startedAt = 0;
    let processHandle;
    try {
      processHandle = utilityProcess.fork(hostPath, [], {
        serviceName: "Libera Collaboration",
        stdio: "pipe",
      });
    } catch (error) {
      console.error(`[collab-host] Could not start: ${error.message}`);
      settleReady(error);
      scheduleRestart();
      return;
    }
    child = processHandle;
    processHandle.stdout?.on("data", (chunk) => prefixLines(process.stdout, "[collab-host]", chunk));
    processHandle.stderr?.on("data", (chunk) => prefixLines(process.stderr, "[collab-host]", chunk));
    processHandle.on("message", onMessage);
    processHandle.once("exit", (code) => {
      if (child === processHandle) child = null;
      const wasReady = ready;
      ready = false;
      if (stopping) return;
      console.error(`[collab-host] Exited with code ${code}${wasReady ? "" : " before it was ready"}.`);
      settleReady(new Error(`The collaboration host exited with code ${code}.`));
      scheduleRestart();
    });
    post({
      t: "start",
      protocol: PARENT_PROTOCOL_VERSION,
      userData: app.getPath("userData"),
      dataDir,
      appVersion: app.getVersion(),
      port,
      token,
    });
  }

  function waitForReady(timeoutMs) {
    if (ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        readyWaiters = readyWaiters.filter((waiter) => waiter !== done);
        reject(new Error(`The collaboration host did not start within ${timeoutMs / 1000} s.`));
      }, timeoutMs);
      const done = (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      readyWaiters.push(done);
    });
  }

  function nudge() {
    if (ready) post({ t: "nudge" });
  }

  function installLifecycle() {
    powerMonitor.on("suspend", () => post({ t: "suspend" }));
    powerMonitor.on("resume", () => post({ t: "resume" }));
    powerMonitor.on("unlock-screen", nudge);
    // Main has no "online" event; poll the cheap OS check and nudge when the
    // network comes back so the reconnect does not wait for its backoff.
    lastOnline = electronNet.isOnline();
    onlineTimer = setInterval(() => {
      const online = electronNet.isOnline();
      if (online && lastOnline === false) nudge();
      lastOnline = online;
    }, ONLINE_POLL_MS);
    onlineTimer.unref?.();
  }

  function installIpc() {
    ipcMain.handle("collab:attach", (event, docId, requestId) => {
      if (typeof docId !== "string" || !docId || docId.length > MAX_DOC_ID_LENGTH) throw new Error("A document id is required.");
      if (typeof requestId !== "string" || !requestId || requestId.length > MAX_REQUEST_ID_LENGTH) throw new Error("A request id is required.");
      const frame = event.senderFrame;
      if (!frame || (options.isTrustedFrame && !options.isTrustedFrame(frame))) throw new Error("This page cannot open shared documents.");
      if (!ready || !child) throw new Error("The collaboration service is not running.");
      const { port1, port2 } = new MessageChannelMain();
      if (!post({ t: "attach", docId }, [port1])) {
        port1.close();
        port2.close();
        throw new Error("The collaboration service is not running.");
      }
      // To the frame that asked; the preload forwards it to the page.
      frame.postMessage("collab:port", { requestId, docId }, [port2]);
      return true;
    });
    ipcMain.on("collab:nudge", () => nudge());
  }

  /** Starts the host and waits (bounded) until its control API listens. */
  async function start(config) {
    if (!enabled) return;
    dataDir = config.dataDir;
    if (!fs.existsSync(hostPath)) {
      throw new Error(`The collaboration host is missing (${hostPath}). Run npm run collab:build-host.`);
    }
    if (!handlersInstalled) {
      handlersInstalled = true;
      installIpc();
      installLifecycle();
    }
    port = port || (await freePort());
    url = `http://127.0.0.1:${port}`;
    spawnHost();
    try {
      await waitForReady(READY_TIMEOUT_MS);
    } catch (error) {
      // Next still gets the URL: the host keeps restarting and the routes
      // answer 503 until it is up. Collaboration must not block the app.
      console.error(`[collab-host] ${error.message}`);
    }
  }

  /** Env for the Next server; empty when collaboration is off. */
  function environment() {
    if (!enabled || !url) return {};
    return { LIBERA_COLLAB_HOST_URL: url, LIBERA_COLLAB_HOST_TOKEN: token };
  }

  /** Asks the host to flush and stop; kills it after timeoutMs. */
  function stop({ timeoutMs = STOP_TIMEOUT_MS } = {}) {
    if (stopPromise) return stopPromise;
    stopping = true;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    if (onlineTimer) clearInterval(onlineTimer);
    onlineTimer = null;
    const processHandle = child;
    if (!processHandle) {
      stopPromise = Promise.resolve();
      return stopPromise;
    }
    stopPromise = new Promise((resolve) => {
      const id = ++shutdownId;
      let finished = false;
      const finish = (note) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        processHandle.removeListener("message", onShutdown);
        if (note) console.warn(`[collab-host] ${note}`);
        resolve();
      };
      const onShutdown = (message) => {
        if (message?.t !== "shutdown-done" || message.id !== id) return;
        if (message.error) console.error(`[collab-host] Stopped with an error: ${message.error}`);
        else console.log("[collab-host] Flushed and stopped.");
        // The host exits on its own; wait for it so nothing writes after quit.
        if (child !== processHandle) finish();
      };
      const timer = setTimeout(() => {
        processHandle.kill();
        finish(`Did not stop within ${timeoutMs / 1000} s; killed it.`);
      }, timeoutMs);
      processHandle.on("message", onShutdown);
      processHandle.once("exit", () => finish());
      if (!post({ t: "shutdown", id })) {
        processHandle.kill();
        finish();
      }
    });
    return stopPromise;
  }

  /**
   * One app instance per user: two hosts would contend for the same SQLite
   * files. Returns false when another instance owns the lock (this one
   * should quit); that instance focuses its window.
   */
  function claimSingleInstance() {
    if (!enabled) return true;
    if (!app.requestSingleInstanceLock()) return false;
    app.on("second-instance", () => {
      const window = options.getMainWindow?.();
      if (!window || window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    });
    return true;
  }

  return {
    enabled,
    start,
    stop,
    environment,
    claimSingleInstance,
    nudge,
    get ready() {
      return ready;
    },
  };
}

module.exports = { createCollabHost, isCollabEnabled };
