// Main-window sandbox (security §7): main.cjs sandboxes every window, the
// preload requires only what a sandboxed preload may, and — in a real
// Electron with a throwaway --user-data-dir — the preload loaded into a
// sandboxed window exposes the same window.libera* APIs, with the same
// results for every call, as an unsandboxed load (including
// liberaCollab.attach's MessagePort and the sendSync workspace calls).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(__dirname, "../..");
const require = createRequire(__filename);

test("main.cjs sandboxes its windows and never turns the sandbox off", () => {
  const main = readFileSync(path.join(root, "electron/main.cjs"), "utf8");
  assert.ok(!/sandbox:\s*false/.test(main), "no window opts out of the sandbox");
  const mainWindow = main.slice(main.indexOf("mainWindow = new BrowserWindow({"));
  const preferences = mainWindow.slice(mainWindow.indexOf("webPreferences: {"), mainWindow.indexOf("additionalArguments"));
  assert.match(preferences, /sandbox:\s*true/, "the main window sets sandbox: true");
  assert.match(preferences, /contextIsolation:\s*true/);
  assert.match(preferences, /nodeIntegration:\s*false/);
  const setup = main.slice(main.indexOf("const setupWindow = overlay ? parentWindow : new BrowserWindow({"));
  assert.match(setup.slice(0, setup.indexOf("});")), /sandbox:\s*true/, "the setup window too");
});

test("the preload requires only modules a sandboxed preload can load", () => {
  const preload = readFileSync(path.join(root, "electron/preload.cjs"), "utf8");
  const modules = [...preload.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]);
  assert.ok(modules.length > 0);
  for (const name of modules) assert.ok(["electron", "events", "timers", "url"].includes(name), `preload requires ${name}`);
  const processUses = [...preload.matchAll(/process\.([A-Za-z]+)/g)].map((match) => match[1]);
  for (const name of processUses) assert.ok(["argv", "platform", "env", "versions", "sandboxed"].includes(name), `preload reads process.${name}`);
});

function electronBinary(): string | null {
  try {
    const binary = require("electron") as unknown as string;
    return typeof binary === "string" && existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

const binary = electronBinary();
const headless = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

interface ProbeRun {
  globals?: Record<string, Record<string, string>>;
  calls?: Record<string, unknown>;
  errors?: string[];
  preloadErrors: string[];
  consoleErrors?: string[];
  pageHasNoNode?: boolean;
}

test("Electron: the real preload works the same in a sandboxed window", { skip: !binary ? "Electron is not installed" : headless ? "no display" : false, timeout: 120_000 }, async () => {
  const userData = mkdtempSync(path.join(tmpdir(), "libera-p4d-sandbox-"));
  try {
    const env = { ...process.env };
    // Inherited from a parent Electron app (an IDE), these would make the
    // child act as Node or report to the parent's crash handler.
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.CHROME_CRASHPAD_PIPE_NAME;
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(binary!, [path.join(__dirname, "p4d-sandbox-harness.cjs"), `--user-data-dir=${userData}`], { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Electron did not finish.\n${stderr}`));
      }, 90_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(`${stdout}\n${stderr}`);
      });
      child.once("error", reject);
    });
    const line = output.split(/\r?\n/).find((entry) => entry.startsWith("P4D_SANDBOX_REPORT "));
    assert.ok(line, `no report from Electron:\n${output.slice(0, 2000)}`);
    const report = JSON.parse(line.slice("P4D_SANDBOX_REPORT ".length)) as {
      sandboxed: ProbeRun;
      unsandboxed: ProbeRun;
      env: { sandboxed: { sandboxed: boolean; fsBlocked: boolean }; unsandboxed: { sandboxed: boolean; fsBlocked: boolean } };
      received: Array<{ channel: string }>;
      syncChannels: string[];
    };
    assert.deepEqual(report.env.sandboxed, { sandboxed: true, fsBlocked: true }, "the window really is a sandboxed renderer");
    const { sandboxed, unsandboxed } = report;
    assert.deepEqual(sandboxed.preloadErrors, []);
    assert.deepEqual(sandboxed.consoleErrors, []);
    assert.deepEqual(sandboxed.errors, []);
    assert.equal(sandboxed.pageHasNoNode, true);
    const expected = [
      "liberaClipboard", "liberaCollab", "liberaDirectory", "liberaExport", "liberaFileExplorer", "liberaMenu", "liberaPersistence",
      "liberaPlatform", "liberaPreferences", "liberaSearch", "liberaSetup", "liberaUpdater", "liberaWindow", "liberaWorkspaces",
    ];
    assert.deepEqual(Object.keys(sandboxed.globals ?? {}).sort(), expected);
    assert.deepEqual(sandboxed.globals, unsandboxed.globals, "same API shape as without the sandbox");
    assert.deepEqual(sandboxed.calls, unsandboxed.calls, "same results for every call");
    const calls = sandboxed.calls ?? {};
    assert.equal(calls["liberaPlatform.platform"], "probe-os", "additionalArguments reach the sandboxed preload");
    assert.equal(calls["liberaPlatform.glass"], true);
    assert.deepEqual(calls["liberaWorkspaces.checkpoint"], { channel: "workspaces:checkpoint", args: ["probe-arg", "second-arg"] }, "sendSync works sandboxed");
    assert.deepEqual(calls["liberaCollab.attach"], { port: true, echoed: { echo: "ping" } }, "the collab MessagePort reaches the page");
    assert.ok(report.syncChannels.includes("workspaces:checkpoint") && report.syncChannels.includes("collab:enabled"));
    assert.ok(report.received.some((entry) => entry.channel === "state:ready"), "fire-and-forget sends arrive");
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});
