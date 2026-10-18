// Bundles the collab host (electron/collab/, TypeScript) into
// electron/collab/dist/host.cjs. The host runs in an Electron utilityProcess,
// so yjs, the protocol and everything else is bundled; only Node built-ins
// and electron stay external (node:sqlite comes from Electron's own Node).
// Pass --watch to rebuild on change. Also used by electron-dev.cjs and
// build-electron-next.cjs through buildCollabHost().

const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const outfile = path.join(root, "electron", "collab", "dist", "host.cjs");
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
  // sqlite.ts and compaction.ts reach the runtime require through eval on
  // purpose, so the bundler leaves node:sqlite and tsx alone.
  logOverride: { "direct-eval": "silent" },
};

/**
 * Builds once; with { watch: true } keeps rebuilding on change and resolves
 * to a dispose function. A running host does not reload itself: restart
 * Libera (or kill the host; main restarts it) to pick up a rebuild.
 */
async function buildCollabHost({ watch = false, logLevel } = {}) {
  const buildOptions = logLevel ? { ...options, logLevel } : options;
  if (!watch) {
    await esbuild.build(buildOptions);
    return () => {};
  }
  const context = await esbuild.context(buildOptions);
  await context.rebuild();
  await context.watch();
  return () => context.dispose();
}

if (require.main === module) {
  buildCollabHost({ watch: process.argv.includes("--watch") }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { buildCollabHost, collabHostBundle: outfile };
