// Bundles the server (including the shared protocol from ../src/lib/collab/protocol)
// into dist/index.js. Runtime dependencies stay external and come from node_modules.
import { cpSync, readFileSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const external = Object.keys(pkg.dependencies ?? {});

for (const entry of ["index", "db/migrate-cli", "admin/cli"]) {
  try {
    await build({
      entryPoints: [`src/${entry}.ts`],
      outfile: `dist/${entry}.js`,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      sourcemap: true,
      external,
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    });
  } catch (error) {
    if (entry === "admin/cli" && String(error).includes("Could not resolve")) continue;
    throw error;
  }
}
cpSync("src/db/migrations", "dist/db/migrations", { recursive: true });
cpSync("src/db/migrations", "dist/migrations", { recursive: true });
console.log("Built dist/");
