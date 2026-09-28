const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const cacheRoot = path.join(projectRoot, ".platform-deps");
const platformKey = `${process.platform}-${process.arch}`;
const platformRoot = path.join(cacheRoot, platformKey);
const platformNodeModules = path.join(platformRoot, "node_modules");
const projectNodeModules = path.join(projectRoot, "node_modules");
const metadataFile = path.join(platformRoot, ".libera-platform-deps.json");
const activeMetadataFile = path.join(cacheRoot, ".active.json");
const cacheSchemaVersion = 2;
const nativeOptionalPackages = {
  "darwin-arm64": [
    "@esbuild/darwin-arm64",
    "@next/swc-darwin-arm64",
    "@unrs/resolver-binding-darwin-arm64",
    "lightningcss-darwin-arm64",
    "@tailwindcss/oxide-darwin-arm64",
    "@img/sharp-darwin-arm64",
    "@img/sharp-libvips-darwin-arm64",
  ],
  "darwin-x64": [
    "@esbuild/darwin-x64",
    "@next/swc-darwin-x64",
    "@unrs/resolver-binding-darwin-x64",
    "lightningcss-darwin-x64",
    "@tailwindcss/oxide-darwin-x64",
    "@img/sharp-darwin-x64",
    "@img/sharp-libvips-darwin-x64",
  ],
  "win32-arm64": [
    "@esbuild/win32-arm64",
    "@next/swc-win32-arm64-msvc",
    "@unrs/resolver-binding-win32-arm64-msvc",
    "lightningcss-win32-arm64-msvc",
    "@tailwindcss/oxide-win32-arm64-msvc",
    "@img/sharp-win32-arm64",
  ],
  "win32-x64": [
    "@esbuild/win32-x64",
    "@next/swc-win32-x64-msvc",
    "@unrs/resolver-binding-win32-x64-msvc",
    "lightningcss-win32-x64-msvc",
    "@tailwindcss/oxide-win32-x64-msvc",
    "@img/sharp-win32-x64",
  ],
};

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function dependencyFingerprint() {
  const hash = createHash("sha256");
  const packageJson = JSON.parse(
    await fs.readFile(path.join(projectRoot, "package.json"), "utf8"),
  );

  hash.update(`schema:${cacheSchemaVersion}`);
  hash.update(
    JSON.stringify({
      dependencies: packageJson.dependencies,
      devDependencies: packageJson.devDependencies,
      optionalDependencies: packageJson.optionalDependencies,
    }),
  );
  hash.update(await fs.readFile(path.join(projectRoot, "package-lock.json")));

  return hash.digest("hex");
}

async function readMetadata() {
  try {
    return JSON.parse(await fs.readFile(metadataFile, "utf8"));
  } catch {
    return null;
  }
}

async function readActiveMetadata() {
  try {
    return JSON.parse(await fs.readFile(activeMetadataFile, "utf8"));
  } catch {
    return null;
  }
}

async function cacheIsCurrent(fingerprint) {
  const metadata = await readMetadata();
  const requiredPackages = [
    "next",
    "electron",
    "electron-builder",
    ...(nativeOptionalPackages[platformKey] ?? []),
  ];
  const activeMetadata = await readActiveMetadata();
  // A completed refresh is staged under the platform cache until activation.
  // Prefer it over an older tree that is still active at the project root.
  const nodeModulesRoot = (await exists(platformNodeModules))
    ? platformNodeModules
    : activeMetadata?.platformKey === platformKey
      ? projectNodeModules
      : platformNodeModules;

  if (
    metadata?.fingerprint !== fingerprint ||
    metadata?.platform !== process.platform ||
    metadata?.arch !== process.arch
  ) {
    return false;
  }

  return Promise.all(
    requiredPackages.map((packageName) =>
      exists(path.join(nodeModulesRoot, packageName, "package.json")),
    ),
  ).then((results) => results.every(Boolean));
}

function runNpm(args, cwd) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const commandArgs = npmExecPath ? [npmExecPath, ...args] : args;

  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`npm stopped after receiving ${signal}.`));
        return;
      }

      resolve(code ?? 1);
    });
  });
}

async function installMissingNativePackages(installRoot) {
  const packageNames = nativeOptionalPackages[platformKey] ?? [];
  const missingPackageSpecs = [];

  for (const packageName of packageNames) {
    const packagePath = path.join(installRoot, "node_modules", ...packageName.split("/"));

    if (!(await exists(path.join(packagePath, "package.json")))) {
      const parentName = packageName.startsWith("@esbuild/")
        ? "esbuild"
        : packageName.startsWith("@next/swc-")
          ? "next"
          : packageName.startsWith("@unrs/resolver-binding-")
            ? "unrs-resolver"
            : packageName.startsWith("lightningcss-")
              ? "lightningcss"
              : packageName.startsWith("@tailwindcss/oxide-")
                ? "@tailwindcss/oxide"
                : "sharp";
      const parentPackage = JSON.parse(
        await fs.readFile(
          path.join(installRoot, "node_modules", ...parentName.split("/"), "package.json"),
          "utf8",
        ),
      );
      const version = parentPackage.optionalDependencies?.[packageName];

      if (!version) {
        throw new Error(`${parentName} does not declare the expected ${packageName} binding.`);
      }

      missingPackageSpecs.push(`${packageName}@${version}`);
    }
  }

  if (!missingPackageSpecs.length) {
    return;
  }

  // npm lockfiles generated on another OS can omit transitive optional native
  // packages. npm may update the staging copy of the lockfile, but the shared
  // project lock remains unchanged and continues to pin the rest of the tree.
  console.log(`Installing missing native bindings: ${missingPackageSpecs.join(", ")}`);
  const exitCode = await runNpm(
    [
      "install",
      "--no-save",
      "--no-audit",
      "--no-fund",
      ...missingPackageSpecs,
    ],
    installRoot,
  );

  if (exitCode !== 0) {
    throw new Error(`Installing native bindings failed with exit code ${exitCode}.`);
  }
}

async function installPlatformCache(fingerprint) {
  const stagingRoot = path.join(cacheRoot, `.install-${platformKey}-${process.pid}`);

  await fs.rm(stagingRoot, { force: true, recursive: true });
  await fs.mkdir(stagingRoot, { recursive: true });

  for (const manifestName of ["package.json", "package-lock.json"]) {
    await fs.copyFile(
      path.join(projectRoot, manifestName),
      path.join(stagingRoot, manifestName),
    );
  }

  console.log(`Installing dependencies for ${platformKey}...`);
  const exitCode = await runNpm(["ci", "--no-audit", "--no-fund"], stagingRoot);

  if (exitCode !== 0) {
    throw new Error(`npm ci failed with exit code ${exitCode}.`);
  }

  await installMissingNativePackages(stagingRoot);

  await fs.writeFile(
    path.join(stagingRoot, path.basename(metadataFile)),
    `${JSON.stringify(
      {
        arch: process.arch,
        fingerprint,
        installedAt: new Date().toISOString(),
        platform: process.platform,
      },
      null,
      2,
    )}\n`,
  );

  await fs.rm(platformRoot, { force: true, recursive: true });
  await fs.rename(stagingRoot, platformRoot);
}

async function pointsToActiveCache() {
  const activeMetadata = await readActiveMetadata();

  return activeMetadata?.platformKey === platformKey && (await exists(projectNodeModules));
}

async function moveExistingNodeModulesAside() {
  let stats;

  try {
    stats = await fs.lstat(projectNodeModules);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }

    throw error;
  }

  if (stats.isSymbolicLink()) {
    await fs.unlink(projectNodeModules);
    return;
  }

  const activeMetadata = await readActiveMetadata();

  if (activeMetadata?.platformKey && activeMetadata.platformKey !== platformKey) {
    const previousPlatformRoot = path.join(cacheRoot, activeMetadata.platformKey);
    const previousNodeModules = path.join(previousPlatformRoot, "node_modules");

    await fs.mkdir(previousPlatformRoot, { recursive: true });
    await fs.rm(previousNodeModules, { force: true, recursive: true });
    await fs.rename(projectNodeModules, previousNodeModules);
    return;
  }

  const backupKind = activeMetadata?.platformKey === platformKey ? "stale" : "legacy";
  const backupName = `${backupKind}-node_modules-${Date.now()}`;
  const backupPath = path.join(cacheRoot, backupName);

  await fs.rename(projectNodeModules, backupPath);
  console.log(`Preserved the previous node_modules at ${path.relative(projectRoot, backupPath)}.`);
}

async function activatePlatformCache() {
  if (!(await exists(platformNodeModules)) && (await pointsToActiveCache())) {
    return;
  }

  await moveExistingNodeModulesAside();
  await fs.rename(platformNodeModules, projectNodeModules);
  await fs.writeFile(
    activeMetadataFile,
    `${JSON.stringify({ platformKey }, null, 2)}\n`,
  );
}

async function ensurePlatformDependencies() {
  await fs.mkdir(cacheRoot, { recursive: true });
  const fingerprint = await dependencyFingerprint();

  if (!(await cacheIsCurrent(fingerprint))) {
    await installPlatformCache(fingerprint);
  } else {
    console.log(`Reusing cached dependencies for ${platformKey}.`);
  }

  // A refreshed cache lives under .platform-deps even when this platform was
  // already marked active. Activate that tree before trusting .active.json;
  // otherwise the stale project-level tree would be reused.
  await activatePlatformCache();
  console.log(`node_modules is using the ${platformKey} dependency cache.`);
}

async function printStatus() {
  const fingerprint = await dependencyFingerprint();
  const current = await cacheIsCurrent(fingerprint);
  const pendingActivation = await exists(platformNodeModules);
  const active = current && !pendingActivation && (await pointsToActiveCache());

  console.log(`Platform: ${platformKey}`);
  console.log(`Cache: ${current ? "ready" : "missing or stale"}`);
  console.log(`Active: ${active ? "yes" : "no"}`);
  process.exitCode = active ? 0 : 1;
}

async function main() {
  const [command = "install", scriptName, ...scriptArgs] = process.argv.slice(2);

  if (command === "status") {
    await printStatus();
    return;
  }

  if (command !== "install" && command !== "run") {
    throw new Error("Usage: node scripts/platform-deps.cjs <install|status|run> [npm-script] [args...]");
  }

  await ensurePlatformDependencies();

  if (command === "run") {
    if (!scriptName) {
      throw new Error("The run command requires an npm script name.");
    }

    const exitCode = await runNpm(
      ["run", scriptName, ...(scriptArgs.length ? ["--", ...scriptArgs] : [])],
      projectRoot,
    );
    process.exitCode = exitCode;
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
