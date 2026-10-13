const { spawn } = require("node:child_process");
const path = require("node:path");

async function main() {
  if (process.platform === "darwin" && process.arch === "arm64") {
    await require("./dev-mac.cjs").main();
    return;
  }

  const child = spawn(require("electron"), [path.resolve(__dirname, "..")], {
    env: { ...process.env, LIBERA_ELECTRON_NEXT_MODE: "dev" },
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
