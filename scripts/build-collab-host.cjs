// Bundles the collab host (electron/collab/, TypeScript) into
// electron/collab/dist/host.cjs. The host runs in an Electron utilityProcess,
// so yjs, the protocol and everything else is bundled; only Node built-ins
// and electron stay external. Pass --watch to rebuild on change.

const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const options = {
  absWorkingDir: root,
  entryPoints: { host: "electron/collab/host-entry.ts" },
  outdir: "electron/collab/dist",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: "linked",
  external: ["electron", "node:*"],
  logLevel: "info",
};

async function main() {
  if (process.argv.includes("--watch")) {
    const context = await esbuild.context(options);
    await context.watch();
    return;
  }
  await esbuild.build(options);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
