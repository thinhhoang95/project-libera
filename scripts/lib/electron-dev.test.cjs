const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { assertMacCacheReady } = require("../dev-mac.cjs");
const { waitForServer, stopProcessTree } = require("../../electron/server-lifecycle.cjs");

const macOnly = process.platform !== "darwin" || process.arch !== "arm64";

async function dependencyFixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "libera-deps-test-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = path.join(root, ".platform-deps", "darwin-arm64");
  await fs.mkdir(cache, { recursive: true });
  const manifest = { dependencies: { next: "16.2.6" }, devDependencies: {}, optionalDependencies: {} };
  const lock = "test lockfile";
  const hash = createHash("sha256").update("schema:2").update(JSON.stringify(manifest)).update(lock).digest("hex");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(root, "package-lock.json"), lock);
  await fs.writeFile(path.join(cache, ".libera-platform-deps.json"), JSON.stringify({ platform: "darwin", arch: "arm64", fingerprint: hash }));
  return { root, cache };
}

async function populateModules(modules) {
  for (const item of ["next/dist/bin/next", "electron/dist/Electron.app/Contents/MacOS/Electron"]) {
    await fs.mkdir(path.dirname(path.join(modules, item)), { recursive: true });
    await fs.writeFile(path.join(modules, item), "fixture");
  }
}

test("uses macOS dependencies after activation moved them out of the cache", { skip: macOnly }, async (context) => {
  const { root } = await dependencyFixture(context);
  const modules = path.join(root, "node_modules");
  await populateModules(modules);
  await fs.writeFile(path.join(root, ".platform-deps", ".active.json"), JSON.stringify({ platformKey: "darwin-arm64" }));
  assert.equal(await assertMacCacheReady(root), modules);
});

test("uses cached macOS dependencies while Windows dependencies are active", { skip: macOnly }, async (context) => {
  const { root, cache } = await dependencyFixture(context);
  const modules = path.join(cache, "node_modules");
  await populateModules(modules);
  await fs.writeFile(path.join(root, ".platform-deps", ".active.json"), JSON.stringify({ platformKey: "win32-x64" }));
  assert.equal(await assertMacCacheReady(root), modules);
  await fs.rm(modules, { recursive: true, force: true });
  await populateModules(path.join(root, "node_modules"));
  await assert.rejects(assertMacCacheReady(root), /macOS dependency cache is missing/);
});

test("rejects dependencies that no longer match the lockfile", { skip: macOnly }, async (context) => {
  const { root } = await dependencyFixture(context);
  await fs.writeFile(path.join(root, "package-lock.json"), "changed lockfile");
  await assert.rejects(assertMacCacheReady(root), /stale/);
});

async function serve(context, handler) {
  const server = http.createServer(handler);
  context.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

test("lets the first page compile for more than two seconds without repeated requests", async (context) => {
  let requests = 0;
  const url = await serve(context, async (_request, response) => {
    requests += 1;
    await delay(2_100);
    response.end("ready");
  });
  await waitForServer(url, { timeoutMs: 5_000 });
  assert.equal(requests, 1);
});

test("enforces the overall deadline even when the HTTP request never responds", async (context) => {
  const url = await serve(context, () => {});
  const start = Date.now();
  await assert.rejects(waitForServer(url, { timeoutMs: 150 }), /did not start within/);
  assert.ok(Date.now() - start < 2_000);
});

test("reports a child exit immediately during an outstanding HTTP request", async (context) => {
  const url = await serve(context, () => {});
  const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(7), 100)"]);
  context.after(() => child.kill());
  await assert.rejects(waitForServer(url, { child, timeoutMs: 5_000 }), /exited.*7/);
});

test("stops a descendant that ignores SIGTERM after its parent exits", { skip: process.platform === "win32" }, async (context) => {
  const child = spawn(process.execPath, ["-e", `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'inherit', 'ignore'] });
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  context.after(() => stopProcessTree(child, { graceMs: 100 }));
  const [output] = await once(child.stdout, "data");
  const descendant = Number(output.toString().trim());
  assert.ok(descendant > 0);
  await stopProcessTree(child, { graceMs: 100 });
  for (let i = 0; i < 20; i += 1) {
    try { process.kill(descendant, 0); } catch (error) {
      assert.equal(error.code, "ESRCH");
      return;
    }
    await delay(50);
  }
  assert.fail(`Descendant ${descendant} survived shutdown`);
});
