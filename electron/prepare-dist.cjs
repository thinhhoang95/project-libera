const fs = require("node:fs/promises");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const distAppRoot = path.join(projectRoot, ".electron-build", "app");

async function copy(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, verbatimSymlinks: true });
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

async function main() {
  await fs.rm(distAppRoot, { force: true, recursive: true });
  await fs.mkdir(distAppRoot, { recursive: true });

  await copy(path.join(projectRoot, "electron"), path.join(distAppRoot, "electron"));
  await copy(path.join(projectRoot, "assets"), path.join(distAppRoot, "assets"));
  await copy(
    path.join(projectRoot, ".next", "standalone"),
    path.join(distAppRoot, ".next", "standalone"),
  );
  await fs.rename(
    path.join(distAppRoot, ".next", "standalone", "node_modules"),
    path.join(distAppRoot, "node_modules"),
  );
  await fs.symlink(
    path.join("..", "..", "node_modules"),
    path.join(distAppRoot, ".next", "standalone", "node_modules"),
  );

  await fs.writeFile(
    path.join(distAppRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "libera",
        productName: "Libera",
        version: "0.2.1",
        private: true,
        main: "electron/main.cjs",
        dependencies: {
          next: "16.2.6",
          react: "19.2.4",
          "react-dom": "19.2.4",
        },
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
