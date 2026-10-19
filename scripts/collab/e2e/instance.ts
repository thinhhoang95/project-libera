// One throwaway Libera desktop instance for the e2e run: its own userData
// (with a pre-written libera-electron-config.json), its own library root,
// and a DevTools port. Launches the production standalone build
// (LIBERA_ELECTRON_NEXT_MODE=start) with LIBERA_COLLAB=1.
//
// Only processes this module spawned are ever stopped, and only the
// directories it created are removed.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { CdpPage, sleep, waitFor } from "./cdp";

export const PROJECT_ROOT = path.resolve(__dirname, "../../..");
/** Dummy placeholder; AI features are out of scope and never called. */
export const DUMMY_API_KEY = "e2e-dummy-openrouter-key-not-real";

export function scryptHash(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export function generatedPassword(): string {
  return `e2e-${randomBytes(12).toString("base64url")}`;
}

export interface InstanceOptions {
  name: string;
  root: string;
  debugPort: number;
  /** Node inspector port of the Electron main process (for the native-menu stub). */
  inspectPort: number;
  /** Where stdout/stderr of every launch is appended. Defaults to <root>/electron.log. */
  logFile?: string;
}

/**
 * Native popup menus (notebook actions, file actions) are OS menus that the
 * DevTools protocol cannot click. This replaces Menu.prototype.popup in the
 * main process: the renderer still builds the items and main still builds
 * the real Menu; the stub then clicks the item whose label path was queued
 * with chooseMenuItem() (or dismisses the menu) and records what was offered.
 */
const MENU_STUB = `(() => {
  const { Menu } = process.getBuiltinModule("module").createRequire(process.execPath)("electron");
  if (globalThis.__e2eMenu) return "already installed";
  globalThis.__e2eMenu = { queue: [], offered: [] };
  const labels = (menu) => menu.items.map((item) => item.type === "separator" ? "---" : item.submenu ? { [item.label]: labels(item.submenu) } : item.label);
  const find = (menu, path) => {
    const item = menu.items.find((candidate) => candidate.label === path[0]);
    if (!item) return null;
    return path.length === 1 ? item : item.submenu ? find(item.submenu, path.slice(1)) : null;
  };
  Menu.prototype.popup = function (options = {}) {
    const state = globalThis.__e2eMenu;
    const want = state.queue.shift() || null;
    const item = want ? find(this, want) : null;
    state.offered.push({ items: labels(this), wanted: want, clicked: item ? item.label : null });
    setTimeout(() => {
      if (item && item.enabled !== false) item.click();
      if (typeof options.callback === "function") options.callback();
    }, 20);
  };
  return "installed";
})()`;

export class LiberaInstance {
  readonly name: string;
  readonly root: string;
  readonly userData: string;
  readonly dataDir: string;
  readonly adminRoot: string;
  readonly logFile: string;
  readonly debugPort: number;
  readonly inspectPort: number;
  /** The Electron main process (Node inspector). */
  main: CdpPage | null = null;
  /** The local app (login screen) password. */
  readonly localPassword = generatedPassword();
  child: ChildProcess | null = null;
  page: CdpPage | null = null;
  log = "";
  private exitPromise: Promise<number | null> | null = null;
  private launches = 0;

  constructor(options: InstanceOptions) {
    this.name = options.name;
    this.root = options.root;
    this.debugPort = options.debugPort;
    this.inspectPort = options.inspectPort;
    this.userData = path.join(options.root, "userData");
    this.dataDir = path.join(options.root, "library");
    this.adminRoot = path.join(this.dataDir, "users", "admin");
    this.logFile = options.logFile ?? path.join(options.root, "electron.log");
  }

  /** Writes the config Libera reads on start, so no setup window appears. */
  writeConfig(): void {
    mkdirSync(this.userData, { recursive: true });
    mkdirSync(this.adminRoot, { recursive: true });
    const config = {
      dataDir: this.dataDir,
      openaiApiKey: DUMMY_API_KEY,
      passwordHash: scryptHash(this.localPassword),
      sessionSecret: randomBytes(32).toString("base64url"),
      themePreference: "light",
      yourName: this.name,
    };
    writeFileSync(path.join(this.userData, "libera-electron-config.json"), `${JSON.stringify(config, null, 2)}\n`);
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  async launch(): Promise<CdpPage> {
    if (this.running) throw new Error(`${this.name} is already running`);
    this.launches++;
    // The electron package exports the path of its binary.
    const electron = createRequire(path.join(PROJECT_ROOT, "package.json"))("electron") as string;
    const env: NodeJS.ProcessEnv = { ...process.env, LIBERA_COLLAB: "1", LIBERA_ELECTRON_NEXT_MODE: "start" };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = [PROJECT_ROOT, `--user-data-dir=${this.userData}`, `--remote-debugging-port=${this.debugPort}`, `--inspect=${this.inspectPort}`];
    const marker = `\n===== ${this.name} launch ${this.launches} at ${new Date().toISOString()} =====\n`;
    this.log += marker;
    appendFileSync(this.logFile, marker);
    const child = spawn(electron, args, { cwd: PROJECT_ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
    this.child = child;
    const onData = (chunk: Buffer) => {
      const text = String(chunk);
      this.log += text;
      appendFileSync(this.logFile, text);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    this.exitPromise = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    try {
      this.main = await CdpPage.connectMain(this.inspectPort, `${this.name} main`);
      // The inspector can attach before main's globals exist; retry briefly.
      const main = this.main;
      await waitFor(() => main.evaluate<string>(MENU_STUB).then((installed) => /installed/.test(installed ?? "")), {
        timeoutMs: 30_000,
        message: `${this.name}: the native-menu stub did not install in the main process`,
        intervalMs: 50,
      });
      this.page = await CdpPage.connect(this.debugPort, this.name);
    } catch (error) {
      throw new Error(`${(error as Error).message}\n--- ${this.name} log tail ---\n${this.log.slice(-3000)}`);
    }
    return this.page;
  }

  /** Text logged since the last launch. */
  get currentLog(): string {
    const index = this.log.lastIndexOf(`===== ${this.name} launch ${this.launches} `);
    return index >= 0 ? this.log.slice(index) : this.log;
  }

  /** Closes the window the way a user does (the app quits when its last window closes). */
  async quit(timeoutMs = 45_000): Promise<{ code: number | null; ms: number }> {
    const started = Date.now();
    if (!this.child || !this.exitPromise) return { code: null, ms: 0 };
    // With --inspect, main waits at exit for the inspector to disconnect.
    this.main?.close();
    this.main = null;
    try {
      await this.page?.evaluate("setTimeout(() => window.close(), 50), true", 5_000);
    } catch {
      // The socket may close before it answers.
    }
    const code = await Promise.race([this.exitPromise, sleep(timeoutMs).then(() => "timeout" as const)]);
    this.page?.close();
    this.page = null;
    if (code === "timeout") throw new Error(`${this.name} did not quit within ${timeoutMs / 1000} s after its window closed`);
    this.child = null;
    return { code, ms: Date.now() - started };
  }

  /** Last resort for cleanup: kills this instance's own process tree. */
  kill(): void {
    this.page?.close();
    this.page = null;
    this.main?.close();
    this.main = null;
    const pid = this.child?.pid;
    if (pid && this.running) {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      else this.child?.kill("SIGKILL");
    }
    this.child = null;
  }

  /** Queues the label path (e.g. ["Editor Mode", "Source"]) the next native menu should click. */
  async chooseMenuItem(path: string[]): Promise<void> {
    if (!this.main) throw new Error(`${this.name}: not connected to the main process`);
    await this.main.evaluate(`globalThis.__e2eMenu.queue.push(${JSON.stringify(path)}), true`);
  }

  /** What the native menus offered so far (newest last). */
  async menusOffered(): Promise<Array<{ items: unknown[]; wanted: string[] | null; clicked: string | null }>> {
    if (!this.main) return [];
    return (await this.main.evaluate(`globalThis.__e2eMenu.offered`)) as Array<{ items: unknown[]; wanted: string[] | null; clicked: string | null }>;
  }

  file(relative: string): string {
    return path.join(this.adminRoot, ...relative.split("/"));
  }

  exists(relative: string): boolean {
    return existsSync(this.file(relative));
  }
}
