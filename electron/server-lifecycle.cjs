const http = require("node:http");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

function requestUrl(url, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { signal }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("error", reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("The server has not finished compiling the page."));
    });
  });
}

async function waitForServer(url, { child, timeoutMs = 90_000, requestTimeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  let failure;
  let lastResponse = "No HTTP response received.";
  const fail = (error) => {
    failure = error;
    controller.abort();
  };
  const onError = (error) => fail(new Error(`Unable to launch Next.js: ${error.message}`));
  const onExit = (code, signal) => fail(new Error(`Next.js exited before it was ready (${signal ?? code}).`));
  child?.once("error", onError);
  child?.once("exit", onExit);
  const timer = setTimeout(() => fail(new Error(
    `The Next.js server did not start within ${timeoutMs / 1000} seconds at ${url}. ${lastResponse} Check the [next] output above.`,
  )), timeoutMs);

  try {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      onExit(child.exitCode, child.signalCode);
    }
    while (!failure) {
      try {
        const status = await requestUrl(url, controller.signal, requestTimeoutMs);
        if (status >= 200 && status < 500) return;
        lastResponse = `Last HTTP status: ${status}.`;
      } catch (error) {
        if (failure) throw failure;
        lastResponse = error.message;
      }
      await delay(500, undefined, { signal: controller.signal });
    }
    throw failure;
  } catch (error) {
    throw failure ?? error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    child?.removeListener("error", onError);
    child?.removeListener("exit", onExit);
  }
}

// POSIX callers spawn Next.js with detached:true so its CLI and server share
// a private process group. Keep checking that group even after the CLI exits.
async function stopProcessTree(child, { graceMs = 1_500 } = {}) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => { child.kill(); resolve(); });
      killer.once("exit", resolve);
    });
    return;
  }

  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      return false;
    }
  };
  if (!signalGroup("SIGTERM")) return;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!signalGroup(0)) return;
    await delay(50);
  }
  signalGroup("SIGKILL");
}

module.exports = { waitForServer, stopProcessTree };
