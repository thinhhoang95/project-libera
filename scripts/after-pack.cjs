const { spawnSync } = require("node:child_process");
const path = require("node:path");
// electron-builder's Arch enum (builder-util), by value.
const archNames = ["ia32", "x64", "armv7l", "arm64", "universal"];

/**
 * electron-builder rebuilds node_modules while packing (it dedupes and hoists
 * packages), so .electron-build/app passing its checks does not mean the
 * packed app works. Load the runtime packages from the packed app before it is
 * signed and archived, so a missing or partial package fails the build.
 */
function packedAppRoot(context) {
  if (context.electronPlatformName === "darwin" || context.electronPlatformName === "mas") {
    return path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      "Contents",
      "Resources",
      "app",
    );
  }

  return path.join(context.appOutDir, "resources", "app");
}

function importFrom(directory, specifiers) {
  const source = specifiers
    .map((specifier) => `await import(${JSON.stringify(specifier)});`)
    .join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: "" },
  });

  if (result.status !== 0) {
    throw new Error(
      `Packed app cannot load ${specifiers.join(", ")} from ${directory}:\n${result.stderr || result.error}`,
    );
  }
}

exports.default = async function afterPack(context) {
  const arch = archNames[context.arch];

  if (context.electronPlatformName !== process.platform || arch !== process.arch) {
    console.log(`Skipping packed runtime check for ${context.electronPlatformName}-${arch} on ${process.platform}-${process.arch}.`);
    return;
  }

  const appRoot = packedAppRoot(context);
  // The search worker (electron/search-worker.mjs) imports Transformers.js,
  // which loads onnxruntime-node and its own sharp.
  importFrom(path.join(appRoot, "electron"), ["@huggingface/transformers", "pdfjs-dist/legacy/build/pdf.mjs"]);
  // The Next server loads the top-level sharp.
  importFrom(path.join(appRoot, ".next", "standalone"), ["sharp"]);
  const latexCheck = spawnSync(process.execPath, [
    path.join(__dirname, "check-latex-production.cjs"),
    path.join(appRoot, ".next", "standalone", ".next", "server"),
  ], { stdio: "inherit", windowsHide: true });
  if (latexCheck.status !== 0) {
    throw new Error(`Packed app LaTeX check failed: ${latexCheck.error || latexCheck.status}`);
  }
  console.log("Packed app runtime loaded successfully.");
};
