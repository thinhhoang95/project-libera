const fs = require("node:fs/promises");
const path = require("node:path");

// Turbopack can emit require("sharp-<hash>") with a symlink in .next/node_modules.
// Standalone tracing includes sharp itself but can omit this generated alias.
// Materialize aliases inside the portable node_modules tree, never ship symlinks
// pointing back into the build machine's checkout.
async function copyTurbopackExternals(buildRoot, standaloneRoot) {
  const dependencies = {};
  async function visit(directory, scope = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.name.startsWith("._")) continue;
      const source = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name.startsWith("@")) {
        await visit(source, `${entry.name}/`);
      } else if (entry.isSymbolicLink()) {
        const alias = scope + entry.name;
        const packageRoot = await fs.realpath(source);
        const pkg = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
        const destination = path.join(standaloneRoot, "node_modules", alias);
        await fs.rm(destination, { recursive: true, force: true });
        await fs.cp(packageRoot, destination, {
          recursive: true, dereference: true,
          filter: (entryPath) => !path.basename(entryPath).startsWith("._"),
        });
        dependencies[alias] = pkg.version;
      }
    }
  }
  await visit(path.join(buildRoot, "node_modules"));
  await fs.writeFile(path.join(standaloneRoot, ".libera-external-packages.json"), JSON.stringify(dependencies, null, 2) + "\n");
  return dependencies;
}

module.exports = { copyTurbopackExternals };
