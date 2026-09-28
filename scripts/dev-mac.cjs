const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { watch } = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const macCache = path.join(projectRoot, ".platform-deps", "darwin-arm64");
const macModules = path.join(macCache, "node_modules");
const mirroredDirectories = new Set(["src", "public", "assets", "prompts"]);

function includeSource(source) {
  return !path.basename(source).startsWith("._");
}

async function assertMacCacheReady() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("dev:mac requires macOS arm64.");
  }

  const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  const hash = createHash("sha256");
  hash.update("schema:2");
  hash.update(JSON.stringify({
    dependencies: manifest.dependencies,
    devDependencies: manifest.devDependencies,
    optionalDependencies: manifest.optionalDependencies,
  }));
  hash.update(await fs.readFile(path.join(projectRoot, "package-lock.json")));

  let metadata;
  try {
    metadata = JSON.parse(await fs.readFile(path.join(macCache, ".libera-platform-deps.json"), "utf8"));
  } catch {
    throw new Error("The macOS dependency cache is missing. Run npm run deps:setup on macOS first.");
  }

  if (metadata.platform !== "darwin" || metadata.arch !== "arm64" || metadata.fingerprint !== hash.digest("hex")) {
    throw new Error("The macOS dependency cache is stale. Run npm run deps:setup on macOS first.");
  }

  for (const item of [
    "next/dist/bin/next",
    "electron/dist/Electron.app/Contents/MacOS/Electron",
  ]) {
    try {
      await fs.access(path.join(macModules, item));
    } catch {
      throw new Error(`The macOS dependency cache is incomplete: ${item}`);
    }
  }
}

async function makeIsolatedApp() {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), "libera-dev-mac-"));
  const excluded = new Set([
    ".git", ".next", ".platform-deps", ".electron-build", "dist-electron",
    "node_modules", "next-env.d.ts", "tsconfig.tsbuildinfo", "data",
  ]);
  const copied = new Set(["package.json", "tsconfig.json"]);

  try {
    for (const entry of await fs.readdir(projectRoot, { withFileTypes: true })) {
      if (excluded.has(entry.name) || entry.name.startsWith("._")) continue;
      const source = path.join(projectRoot, entry.name);
      const destination = path.join(appRoot, entry.name);
      if (copied.has(entry.name)) {
        await fs.copyFile(source, destination);
      } else if (mirroredDirectories.has(entry.name)) {
        await fs.cp(source, destination, { recursive: true, filter: includeSource });
      } else {
        await fs.symlink(source, destination, entry.isDirectory() ? "dir" : "file");
      }
    }

    await fs.symlink(macModules, path.join(appRoot, "node_modules"), "dir");
    return appRoot;
  } catch (error) {
    await fs.rm(appRoot, { recursive: true, force: true });
    throw error;
  }
}

function watchSource(appRoot) {
  const watchers = [];
  const pending = new Map();

  for (const directory of mirroredDirectories) {
    const sourceRoot = path.join(projectRoot, directory);
    const destinationRoot = path.join(appRoot, directory);
    const watcher = watch(sourceRoot, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const relative = filename.toString();
      if (relative.split(path.sep).some((part) => part.startsWith("._"))) return;
      const previous = pending.get(`${directory}/${relative}`);
      if (previous) clearTimeout(previous);
      pending.set(`${directory}/${relative}`, setTimeout(async () => {
        pending.delete(`${directory}/${relative}`);
        const source = path.join(sourceRoot, relative);
        const destination = path.join(destinationRoot, relative);
        try {
          const stats = await fs.stat(source);
          if (stats.isDirectory()) {
            await fs.cp(source, destination, { recursive: true, force: true, filter: includeSource });
          } else {
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.copyFile(source, destination);
          }
        } catch (error) {
          if (error.code === "ENOENT") {
            await fs.rm(destination, { recursive: true, force: true });
          } else {
            console.error(`Could not mirror ${directory}/${relative}: ${error.message}`);
          }
        }
      }, 75));
    });
    watchers.push(watcher);
  }

  return () => {
    for (const watcher of watchers) watcher.close();
    for (const timeout of pending.values()) clearTimeout(timeout);
  };
}

async function main() {
  await assertMacCacheReady();
  const appRoot = await makeIsolatedApp();
  const electron = path.join(macModules, "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
  const stopWatching = watchSource(appRoot);

  console.log(`Starting macOS development app from ${appRoot}`);
  try {
    const child = spawn(electron, [appRoot], {
      cwd: appRoot,
      env: { ...process.env, LIBERA_ELECTRON_NEXT_MODE: "dev" },
      stdio: "inherit",
    });

    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => child.kill(signal));
    }

    const outcome = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    process.exitCode = outcome.signal ? 128 + os.constants.signals[outcome.signal] : outcome.code ?? 1;
  } finally {
    stopWatching();
    await fs.rm(appRoot, { recursive: true, force: true });
  }
}

module.exports = { assertMacCacheReady, makeIsolatedApp, watchSource };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
