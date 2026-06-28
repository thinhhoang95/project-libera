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

  const dependencies = {
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
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
