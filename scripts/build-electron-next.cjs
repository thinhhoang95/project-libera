const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const nextBin = require.resolve("next/dist/bin/next");
const compatibilityPreload = path
  .join(__dirname, "windows-readlink-compat.cjs")
  .replaceAll("\\", "/");

function runNextBuild() {
  const preloadOption = `--require=${JSON.stringify(compatibilityPreload)}`;
  const nodeOptions = [process.env.NODE_OPTIONS?.trim(), preloadOption]
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
  await fs.rm(path.join(projectRoot, ".next"), { force: true, recursive: true });
  process.exitCode = await runNextBuild();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
