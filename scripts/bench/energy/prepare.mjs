#!/usr/bin/env node
// Makes a production build of a git ref for the energy bench:
//
//   node scripts/bench/energy/prepare.mjs <ref> [dir]
//
// The ref is checked out as a detached worktree (default: <tmp>/libera-energy-builds/<sha>),
// this checkout's node_modules are linked into it, and it is built the way the
// desktop app is (next build --webpack, then the standalone copy). A build that
// already exists for that commit is reused. Prints the build directory.
//
// The link means both versions run with the same installed packages. When the
// ref's package-lock.json differs from this checkout's, the bench would measure
// it with the wrong dependencies, so that is refused.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

const [ref, target] = process.argv.slice(2);
if (!ref) {
  console.error("Usage: node scripts/bench/energy/prepare.mjs <ref> [dir]");
  process.exit(1);
}
const sha = git("rev-parse", "--verify", `${ref}^{commit}`);
const dir = path.resolve(target ?? path.join(os.tmpdir(), "libera-energy-builds", sha.slice(0, 12)));

if (existsSync(path.join(dir, ".next", "standalone", "server.js"))) {
  console.log(dir);
  process.exit(0);
}

const lockHere = await readFile(path.join(repo, "package-lock.json"), "utf8");
const lockThere = git("show", `${sha}:package-lock.json`);
if (lockHere.trim() !== lockThere.trim()) {
  console.error(`${ref} has a different package-lock.json from this checkout; install its dependencies in a separate clone to bench it.`);
  process.exit(1);
}

if (!existsSync(dir)) {
  await mkdir(path.dirname(dir), { recursive: true });
  git("worktree", "add", "--detach", dir, sha);
}
for (const modules of ["node_modules", path.join("server", "node_modules")]) {
  const link = path.join(dir, modules);
  if (!existsSync(link) && existsSync(path.join(repo, modules))) await symlink(path.join(repo, modules), link);
}

const run = (args, env = {}) => {
  const result = spawnSync(process.execPath, args, { cwd: dir, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ...env } });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
console.error(`Building ${sha.slice(0, 12)} in ${dir} …`);
run([path.join("node_modules", "next", "dist", "bin", "next"), "build", "--webpack"], { NODE_OPTIONS: "--max-old-space-size=4096" });
run([path.join("electron", "prepare-standalone.cjs")]);
console.log(dir);
