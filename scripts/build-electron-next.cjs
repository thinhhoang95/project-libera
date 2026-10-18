const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { buildCollabHost } = require("./build-collab-host.cjs");

const projectRoot = path.resolve(__dirname, "..");
const nextBin = require.resolve("next/dist/bin/next");
const compatibilityPreload = path
  .join(__dirname, "windows-readlink-compat.cjs")
  .replaceAll("\\", "/");

function runNextBuild() {
  const preloadOption = `--require=${JSON.stringify(compatibilityPreload)}`;
  // The optimized build needs more than Node's default heap on 8 GB machines.
  const heapOption = /--max-old-space-size/.test(process.env.NODE_OPTIONS ?? "") ? "" : "--max-old-space-size=4096";
  const nodeOptions = [process.env.NODE_OPTIONS?.trim(), heapOption, preloadOption]
    .filter(Boolean)
    .join(" ");

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [nextBin, "build", "--webpack"], {
      cwd: projectRoot,
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
      stdio: "inherit",
      windowsHide: true,
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Next.js build stopped after receiving ${signal}.`));
        return;
      }

      resolve(code ?? 1);
    });
  });
}

async function main() {
  // Hidden incremental cache files cannot be reopened for writing on some
  // removable/shared Windows filesystems. Production output is disposable, so
  // start Electron builds from a clean Next directory on every platform.
  // Windows may briefly keep directory entries open after their files are
  // removed. Retry transient ENOTEMPTY/EPERM/EBUSY failures during cleanup.
  const cleanupOptions = { force: true, recursive: true, maxRetries: 5, retryDelay: 200 };
  await fs.rm(path.join(projectRoot, ".next"), cleanupOptions);
  // The collab host ships with every build (collaboration is on unless LIBERA_COLLAB=0);
  // prepare-dist copies electron/collab/dist into the app.
  await fs.rm(path.join(projectRoot, "electron", "collab", "dist"), cleanupOptions);
  await buildCollabHost();
  process.exitCode = await runNextBuild();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
