const fs = require("node:fs/promises");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const standaloneRoot = path.join(projectRoot, ".next", "standalone");

async function copyIfPresent(source, destination) {
  try {
    await fs.access(source);
  } catch {
    return;
  }

  await fs.rm(destination, { force: true, recursive: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true });
}

async function main() {
  await copyIfPresent(
    path.join(projectRoot, ".next", "server"),
    path.join(standaloneRoot, ".next", "server"),
  );
  await copyIfPresent(
    path.join(projectRoot, ".next", "static"),
    path.join(standaloneRoot, ".next", "static"),
  );
  await copyIfPresent(path.join(projectRoot, "public"), path.join(standaloneRoot, "public"));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
