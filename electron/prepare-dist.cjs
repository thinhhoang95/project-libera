const { existsSync } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const distAppRoot = path.join(projectRoot, ".electron-build", "app");
const appPackage = require(path.join(projectRoot, "package.json"));
const requiredPackages = new Map([
  ["baseline-browser-mapping", path.join(projectRoot, "node_modules", "baseline-browser-mapping")],
  ["caniuse-lite", path.join(projectRoot, "node_modules", "caniuse-lite")],
  ["nanoid", path.join(projectRoot, "node_modules", "nanoid")],
  ["pdfjs-dist", path.join(projectRoot, "node_modules", "pdfjs-dist")],
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
  try {
    return path.dirname(require.resolve(`${packageName}/package.json`, { paths: [searchDirectory] }));
  } catch (error) {
    // Packages with an "exports" map may not export package.json; look where Node would.
    if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    for (let directory = searchDirectory; ; directory = path.dirname(directory)) {
      const candidate = path.join(directory, "node_modules", ...packageName.split("/"));
      if (existsSync(path.join(candidate, "package.json"))) return candidate;
      if (path.dirname(directory) === directory) throw error;
    }
  }
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

function sqliteVecPackageName() {
  return `sqlite-vec-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
}

function onnxruntimePlatform() {
  return process.platform === "win32" ? "win32" : process.platform;
}

/**
 * Global Search runs Transformers.js in a worker process (electron/search-worker.mjs)
 * and keeps its index in SQLite with the sqlite-vec extension. Copy only what
 * runs in Node: the Node build of Transformers.js, onnxruntime-node for this
 * platform, and the sharp version it was built against.
 */
async function copySearchRuntime(distNodeModulesRoot) {
  const transformersSource = resolvePackageDirectory("@huggingface/transformers", projectRoot);
  const transformersDestination = path.join(distNodeModulesRoot, "@huggingface", "transformers");
  const nested = path.join(transformersDestination, "node_modules");
  await removeIfPresent(transformersDestination);

  const transformersPackage = JSON.parse(await fs.readFile(path.join(transformersSource, "package.json"), "utf8"));
  for (const entry of ["package.json", "LICENSE", "README.md"]) {
    await copy(path.join(transformersSource, entry), path.join(transformersDestination, entry)).catch(() => undefined);
  }
  for (const entry of ["transformers.node.mjs", "transformers.node.cjs"]) {
    await copy(path.join(transformersSource, "dist", entry), path.join(transformersDestination, "dist", entry));
  }

  // The Node build bundles the tokenizers and templates and never loads the
  // browser runtime; it imports only these at run time.
  const runtimeDependencies = ["onnxruntime-node", "onnxruntime-common", "sharp"];
  for (const dependency of runtimeDependencies) {
    await copyRuntimePackageTree(dependency, transformersSource, nested);
  }
  transformersPackage.dependencies = Object.fromEntries(
    runtimeDependencies.map((dependency) => [dependency, transformersPackage.dependencies?.[dependency] ?? "*"]),
  );
  delete transformersPackage.devDependencies;
  await fs.writeFile(path.join(transformersDestination, "package.json"), `${JSON.stringify(transformersPackage, null, 2)}\n`);

  // onnxruntime-node ships binaries for every platform; keep this one.
  const binaries = path.join(nested, "onnxruntime-node", "bin", "napi-v6");
  for (const platform of await fs.readdir(binaries).catch(() => [])) {
    for (const arch of await fs.readdir(path.join(binaries, platform)).catch(() => [])) {
      if (platform !== onnxruntimePlatform() || arch !== process.arch) {
        await removeIfPresent(path.join(binaries, platform, arch));
      }
    }
  }

  await completeTopLevelDuplicates(nested, distNodeModulesRoot);
  await copyPackage(sqliteVecPackageName(), resolveSqliteVecDirectory(), distNodeModulesRoot);
}

async function listPackageDirectories(nodeModulesDirectory) {
  const entries = await fs.readdir(nodeModulesDirectory, { withFileTypes: true }).catch(() => []);
  const packages = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const entryPath = path.join(nodeModulesDirectory, entry.name);

    if (entry.name.startsWith("@")) {
      for (const scoped of await fs.readdir(entryPath, { withFileTypes: true })) {
        if (scoped.isDirectory()) packages.push([`${entry.name}/${scoped.name}`, path.join(entryPath, scoped.name)]);
      }
    } else {
      packages.push([entry.name, entryPath]);
    }
  }

  return packages;
}

/**
 * electron-builder rebuilds the node_modules tree and drops a nested package
 * when a top-level package has the same name and version. Top-level packages
 * from Next's standalone trace can be partial (only the traced files), so the
 * nested dependant would then load a broken copy at run time (e.g. sharp's
 * semver without index.js). Replace those top-level copies with the full one.
 */
async function completeTopLevelDuplicates(nestedNodeModules, distNodeModulesRoot) {
  for (const [packageName, packageDirectory] of await listPackageDirectories(nestedNodeModules)) {
    const nestedVersion = await readPackageVersion(nestedNodeModules, packageName);
    const topLevel = path.join(distNodeModulesRoot, ...packageName.split("/"));

    if (nestedVersion && nestedVersion === (await readPackageVersion(distNodeModulesRoot, packageName))) {
      // Keep the top-level package's own node_modules; its dependants resolve through it.
      for (const entry of await fs.readdir(topLevel)) {
        if (entry !== "node_modules") await removeIfPresent(path.join(topLevel, entry));
      }
      for (const entry of await fs.readdir(packageDirectory)) {
        if (entry !== "node_modules") await copy(path.join(packageDirectory, entry), path.join(topLevel, entry));
      }
    }

    await completeTopLevelDuplicates(path.join(packageDirectory, "node_modules"), distNodeModulesRoot);
  }
}

function resolveSqliteVecDirectory() {
  const extension = process.platform === "win32" ? "dll" : process.platform === "darwin" ? "dylib" : "so";
  return path.dirname(require.resolve(`${sqliteVecPackageName()}/vec0.${extension}`, { paths: [projectRoot] }));
}

/** Load what Global Search needs from the staged app, so a broken package fails here, not for users. */
function checkSearchRuntime() {
  const resolveFromWorker = (request) => require.resolve(request, { paths: [path.join(distAppRoot, "electron")] });
  resolveFromWorker("@huggingface/transformers");
  resolveFromWorker("pdfjs-dist/legacy/build/pdf.mjs");
  const extension = process.platform === "win32" ? "dll" : process.platform === "darwin" ? "dylib" : "so";
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(":memory:", { allowExtension: true });
  database.loadExtension(path.join(distAppRoot, "node_modules", sqliteVecPackageName(), `vec0.${extension}`));
  database.close();
  console.log("Packaged search runtime loaded successfully.");
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

  await copySearchRuntime(distNodeModulesRoot);

  const externalPackages = JSON.parse(await fs.readFile(path.join(distAppRoot, ".next", "standalone", ".libera-external-packages.json"), "utf8"));
  const dependencies = {
    ...externalPackages,
    sharp: await readPackageVersion(distNodeModulesRoot, "sharp"),
    "electron-log": await readPackageVersion(distNodeModulesRoot, "electron-log"),
    "electron-updater": await readPackageVersion(distNodeModulesRoot, "electron-updater"),
    next: await readPackageVersion(distNodeModulesRoot, "next"),
    "pdfjs-dist": await readPackageVersion(distNodeModulesRoot, "pdfjs-dist"),
    react: await readPackageVersion(distNodeModulesRoot, "react"),
    "@huggingface/transformers": await readPackageVersion(distNodeModulesRoot, "@huggingface/transformers"),
    [sqliteVecPackageName()]: await readPackageVersion(distNodeModulesRoot, sqliteVecPackageName()),
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
  checkSearchRuntime();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
