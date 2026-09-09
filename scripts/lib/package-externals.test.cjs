const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { copyTurbopackExternals } = require("../../electron/package-externals.cjs");

test("generated package aliases load after relocation without the original checkout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "libera-externals-"));
  try {
    const original = path.join(root, "original");
    const build = path.join(root, "build");
    const standalone = path.join(root, "standalone");
    await fs.mkdir(original);
    await fs.mkdir(path.join(build, "node_modules"), { recursive: true });
    await fs.mkdir(standalone);
    await fs.writeFile(path.join(original, "package.json"), JSON.stringify({ name: "image-library", version: "1.2.3", main: "index.cjs" }));
    await fs.writeFile(path.join(original, "index.cjs"), 'module.exports = "image loader ready";');
    await fs.symlink(original, path.join(build, "node_modules", "image-library-123abc"), "junction");
    const dependencies = await copyTurbopackExternals(build, standalone);
    assert.deepEqual(dependencies, { "image-library-123abc": "1.2.3" });
    await fs.rm(original, { recursive: true });
    const relocated = path.join(root, "relocated");
    await fs.rename(standalone, relocated);
    const requirePackaged = createRequire(path.join(relocated, "server.js"));
    assert.equal(requirePackaged("image-library-123abc"), "image loader ready");
    assert.equal((await fs.lstat(path.join(relocated, "node_modules", "image-library-123abc"))).isSymbolicLink(), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
