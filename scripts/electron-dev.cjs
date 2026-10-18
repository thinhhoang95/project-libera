const { spawn } = require("node:child_process");
const path = require("node:path");
const { buildCollabHost } = require("./build-collab-host.cjs");

// The collab host bundle must exist before Electron starts (main forks it
// when LIBERA_COLLAB=1). It is rebuilt on change; restart Libera to load a
// rebuild. Without the flag a failed build only warns, as before.
async function startCollabHostBuild() {
  const required = process.env.LIBERA_COLLAB === "1";
  try {
    return await buildCollabHost({ watch: true, logLevel: required ? "info" : "warning" });
  } catch (error) {
    if (required) throw error;
    console.warn(`Could not build the collab host (only needed with LIBERA_COLLAB=1): ${error.message || error}`);
    return () => {};
  }
}

async function main() {
  const stopCollabHostBuild = await startCollabHostBuild();
  try {
    if (process.platform === "darwin" && process.arch === "arm64") {
      await require("./dev-mac.cjs").main();
      return;
    }

    const child = spawn(require("electron"), [path.resolve(__dirname, "..")], {
      env: { ...process.env, LIBERA_ELECTRON_NEXT_MODE: "dev" },
      stdio: "inherit",
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => child.kill(signal));
    }
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await stopCollabHostBuild();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
