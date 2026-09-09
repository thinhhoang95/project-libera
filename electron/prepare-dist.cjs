const fs = require("node:fs/promises");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const distAppRoot = path.join(projectRoot, ".electron-build", "app");
const appPackage = require(path.join(projectRoot, "package.json"));
const requiredPackages = new Map([
  ["baseline-browser-mapping", path.join(projectRoot, "node_modules", "baseline-browser-mapping")],
  ["caniuse-lite", path.join(projectRoot, "node_modules", "caniuse-lite")],
  ["nanoid", path.join(projectRoot, "node_modules", "nanoid")],
  ["picocolors", path.join(projectRoot, "node_modules", "picocolors")],
  ["postcss", path.join(projectRoot, "node_modules", "next", "node_modules", "postcss")],
  ["scheduler", path.join(projectRoot, "node_modules", "scheduler")],
  ["source-map-js", path.join(projectRoot, "node_modules", "source-map-js")],
  ["tslib", path.join(projectRoot, "node_modules", "tslib")],
]);
const electronRuntimePackages = ["electron-log", "electron-updater"];

async function copy(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, {
    filter: (entryPath) => !path.basename(entryPath).startsWith("._"),
    recursive: true,
    verbatimSymlinks: true,
  });
}

async function removeAppleDoubleFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.name.startsWith("._")) {
      await fs.rm(entryPath, { force: true, recursive: true });
      continue;
    }

    if (entry.isDirectory()) {
      await removeAppleDoubleFiles(entryPath);
    }
  }
}

async function removeIfPresent(targetPath) {
  await fs.rm(targetPath, { force: true, recursive: true });
}

async function copyPackage(packageName, source, destinationNodeModules) {
  const packagePathParts = packageName.split("/");
  const destination = path.join(destinationNodeModules, ...packagePathParts);

  try {
    await fs.access(destination);
    return;
  } catch {
    await copy(source, destination);
  }
}

function resolvePackageDirectory(packageName, searchDirectory) {
  const packageJsonPath = require.resolve(`${packageName}/package.json`, {
    paths: [searchDirectory],
  });

  return path.dirname(packageJsonPath);
}

async function readPackageDependencies(packageDirectory) {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );

  return {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
  };
}

async function copyRuntimePackageTree(
  packageName,
  searchDirectory,
  destinationNodeModules,
  ancestry = new Set(),
) {
  const source = resolvePackageDirectory(packageName, searchDirectory);
  const destination = path.join(destinationNodeModules, ...packageName.split("/"));

  await removeIfPresent(destination);
  await copy(source, destination);

  if (ancestry.has(source)) {
    return;
  }

  const nextAncestry = new Set(ancestry).add(source);
  const dependencies = await readPackageDependencies(source);
  const nestedNodeModules = path.join(destination, "node_modules");

  for (const dependencyName of Object.keys(dependencies).sort()) {
    try {
      await copyRuntimePackageTree(
        dependencyName,
        source,
        nestedNodeModules,
        nextAncestry,
      );
    } catch (error) {
      if (!error || error.code !== "MODULE_NOT_FOUND") {
        throw error;
      }
    }
  }
}

async function readPackageVersion(nodeModulesRoot, packageName) {
  try {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(nodeModulesRoot, ...packageName.split("/"), "package.json")),
    );

    return typeof packageJson.version === "string" ? packageJson.version : "";
  } catch {
    return "";
  }
}

async function removeStandalonePackagingNoise(standaloneAppRoot) {
  const rootEntriesToRemove = [
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    "electron-builder.json",
    "eslint.config.mjs",
    "next.config.ts",
    "package-lock.json",
    "postcss.config.mjs",
    "tsconfig.json",
    "tsconfig.tsbuildinfo",
  ];

  await Promise.all(
    rootEntriesToRemove.map((entry) => removeIfPresent(path.join(standaloneAppRoot, entry))),
  );

  const entries = await fs.readdir(standaloneAppRoot);

  await Promise.all(
    entries
      .filter((entry) => entry === ".env" || entry.startsWith(".env."))
      .map((entry) => removeIfPresent(path.join(standaloneAppRoot, entry))),
  );
}

async function main() {
  await fs.rm(distAppRoot, { force: true, recursive: true });
  await fs.mkdir(distAppRoot, { recursive: true });

  await copy(path.join(projectRoot, "electron"), path.join(distAppRoot, "electron"));
  await copy(path.join(projectRoot, "assets"), path.join(distAppRoot, "assets"));
  await copy(
    path.join(projectRoot, ".next", "standalone"),
    path.join(distAppRoot, ".next", "standalone"),
  );
  await removeStandalonePackagingNoise(path.join(distAppRoot, ".next", "standalone"));
  await fs.rename(
    path.join(distAppRoot, ".next", "standalone", "node_modules"),
    path.join(distAppRoot, "node_modules"),
  );
  const distNodeModulesRoot = path.join(distAppRoot, "node_modules");

  for (const [packageName, source] of requiredPackages) {
    await copyPackage(packageName, source, distNodeModulesRoot);
  }

  for (const packageName of electronRuntimePackages) {
    await copyRuntimePackageTree(packageName, projectRoot, distNodeModulesRoot);
  }

  const externalPackages = JSON.parse(await fs.readFile(path.join(distAppRoot, ".next", "standalone", ".libera-external-packages.json"), "utf8"));
  const dependencies = {
    ...externalPackages,
    sharp: await readPackageVersion(distNodeModulesRoot, "sharp"),
    "electron-log": await readPackageVersion(distNodeModulesRoot, "electron-log"),
    "electron-updater": await readPackageVersion(distNodeModulesRoot, "electron-updater"),
    next: await readPackageVersion(distNodeModulesRoot, "next"),
    "pdfjs-dist": await readPackageVersion(distNodeModulesRoot, "pdfjs-dist"),
    react: await readPackageVersion(distNodeModulesRoot, "react"),
  };

  if (process.platform !== "win32") {
    await fs.symlink(
      path.join("..", "..", "node_modules"),
      path.join(distAppRoot, ".next", "standalone", "node_modules"),
      "dir",
    );
  }

  await fs.writeFile(
    path.join(distAppRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "libera",
        productName: appPackage.productName,
        version: appPackage.version,
        description: "A local-first notetaking app.",
        author: "Thinh Hoang",
        private: true,
        main: "electron/main.cjs",
        dependencies,
      },
      null,
      2,
    )}\n`,
  );

  await removeAppleDoubleFiles(distAppRoot);
  // Load the staged endpoint without making API calls. This catches missing
  // native modules/aliases before electron-builder produces an unusable release.
  require(path.join(distAppRoot, ".next", "standalone", ".next", "server", "app", "api", "latex-export", "route.js"));
  console.log("Packaged LaTeX endpoint loaded successfully.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
