#!/usr/bin/env node
// Energy bench: replays the same editing, reading and idle sessions against two
// production builds of Libera and compares what they cost.
//
//   node scripts/bench/energy/run.mjs --before <build dir> --after <build dir>
//        [--reps 3] [--scenarios idle,visual-typing,...] [--power ac|battery] [--out dir]
//
// A build dir is a checkout with a production build in .next/standalone
// (prepare.mjs makes one from a git ref). Each run gets a fresh copy of the
// fixture library, its own server and its own Electron window; versions
// alternate (ABBA) so drift in the machine's load affects both alike.
//
// Measured per run, over the scenario's window only:
// - CPU seconds of the Electron processes (renderer, GPU, browser) from
//   Electron's own counters, and of the server process tree (with LaTeX
//   compiles) from `top`.
// - Energy Impact: the same score Activity Monitor shows, from `top`'s POWER
//   column, summed over both process trees, averaged per second.
// - Idle wakeups per second (Electron), renderer task/script/layout/style time
//   (Chrome DevTools Performance metrics), menu-bar syncs and API requests.

import { spawn } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE, writeFixtureLibrary } from "./fixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const require = createRequire(import.meta.url);
const ELECTRON = require("electron");

const ALL_SCENARIOS = ["idle", "idle-background", "visual-typing", "source-typing", "pdf-annotate", "latex-typing", "panels"];
const PASSWORD = "libera";

function parseArgs(argv) {
  const options = { reps: 3, scenarios: ALL_SCENARIOS, power: "ac", out: path.join(repo, "docs", "audits", "energy-bench") };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (flag === "--before") options.before = path.resolve(value);
    else if (flag === "--after") options.after = path.resolve(value);
    else if (flag === "--reps") options.reps = Number(value);
    else if (flag === "--scenarios") options.scenarios = value.split(",");
    else if (flag === "--power") options.power = value;
    else if (flag === "--out") options.out = path.resolve(value);
    else if (flag === "--settle") options.settleMs = Number(value);
    else continue;
    index += 1;
  }
  for (const name of ["before", "after"]) {
    if (!options[name] || !existsSync(path.join(options[name], ".next", "standalone", "server.js"))) {
      throw new Error(`--${name} must be a checkout with a production build (.next/standalone/server.js). Make one with prepare.mjs.`);
    }
  }
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

function passwordHash(password) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

/* ---- top: Energy Impact and CPU time of every process, once a second ----------- */

function parseTime(text) {
  return text.replace(/[+*]$/, "").split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

class TopSampler {
  constructor() {
    this.blocks = [];
    this.current = null;
    this.buffer = "";
    this.child = spawn("top", ["-l", "0", "-s", "1", "-stats", "pid,ppid,time,power"], { stdio: ["ignore", "pipe", "ignore"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.read(chunk));
  }
  read(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.startsWith("Processes:")) {
        if (this.current) this.blocks.push(this.current);
        if (this.blocks.length > 900) this.blocks.splice(0, this.blocks.length - 900);
        this.current = { at: Date.now(), rows: new Map() };
        continue;
      }
      const match = /^\s*(\d+)\s+(\d+)\s+([\d:.]+[+*]?)\s+([\d.]+)/.exec(line);
      if (match && this.current) this.current.rows.set(Number(match[1]), { ppid: Number(match[2]), time: parseTime(match[3]), power: Number(match[4]) });
    }
  }
  /** Blocks whose sample interval lies inside [start, end]; top's first block of each run is skipped. */
  window(start, end) {
    return this.blocks.filter((block, index) => index > 0 && block.at - 1000 >= start - 200 && block.at <= end + 1200);
  }
  stop() { this.child.kill(); }
}

function treeOf(rows, roots) {
  const members = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, row] of rows) if (!members.has(pid) && members.has(row.ppid)) { members.add(pid); grew = true; }
  }
  return members;
}

/** CPU seconds and Energy Impact of a process tree over the sampled blocks. */
function treeUsage(blocks, roots) {
  if (blocks.length < 2) return { cpuS: null, energyImpact: null };
  const first = blocks[0];
  const last = blocks.at(-1);
  const seen = new Map();
  let powerSum = 0;
  for (const block of blocks) {
    const members = treeOf(block.rows, roots);
    for (const pid of members) {
      const row = block.rows.get(pid);
      if (!row) continue;
      const known = seen.get(pid);
      seen.set(pid, { start: known?.start ?? (first.rows.has(pid) ? row.time : 0), end: row.time });
    }
    if (block !== first) for (const pid of members) powerSum += block.rows.get(pid)?.power ?? 0;
  }
  let cpuS = 0;
  for (const { start, end } of seen.values()) cpuS += Math.max(0, end - start);
  return { cpuS, energyImpact: powerSum / Math.max(1, (last.at - first.at) / 1000) };
}

/* ---- One run -------------------------------------------------------------------- */

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (child.exitCode !== null) throw new Error("The server exited during startup.");
    try { const response = await fetch(url); if (response.status < 500) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error("The server did not start.");
}

/**
 * Starts a version's server on a fresh copy of the fixture library. The managed
 * Python runtime lives in a folder shared by every run (see preparePython): a
 * fresh one per run would make each session install Python again, ~570 MB of
 * downloads and seconds of CPU that a real install spends once.
 */
async function startServer({ build, work, cacheDir }) {
  const dataDir = path.join(work, "data");
  await writeFixtureLibrary(dataDir, cacheDir);
  const configPath = path.join(work, "config.json");
  await writeFile(configPath, "{}\n");
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const standalone = path.join(build, ".next", "standalone");
  const server = spawn(process.execPath, [path.join(standalone, "server.js")], {
    cwd: standalone,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: String(port),
      LIBERA_DATA_DIR: dataDir, LIBERA_CONFIG_PATH: configPath,
      LIBERA_PYTHON_DIR: path.join(cacheDir, "python"),
      LIBERA_PASSWORD_HASH: passwordHash(PASSWORD), LIBERA_SESSION_SECRET: randomBytes(32).toString("hex"),
      LIBERA_USAGE_LEDGER: "off",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return { server, url };
}

/** Installs the shared Python runtime once, before anything is measured (the app asks for it at sign-in). */
async function preparePython(build, cacheDir) {
  const work = await mkdtemp(path.join(os.tmpdir(), "libera-energy-python-"));
  const { server, url } = await startServer({ build, work, cacheDir });
  try {
    await waitForServer(url, server);
    const login = await fetch(`${url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const started = Date.now();
    for (let first = true; ; first = false) {
      const status = await (await fetch(`${url}/api/python${first ? "?ensure=1" : ""}`, { headers: { cookie } })).json();
      if (status.ready) return;
      if (status.job?.error) throw new Error(`Python setup failed: ${status.job.error}`);
      if (first) process.stdout.write("Installing the shared Python runtime once (the app sets it up at sign-in) …\n");
      if (Date.now() - started > 20 * 60_000) throw new Error("Python setup did not finish within 20 minutes.");
      await sleep(2000);
    }
  } finally {
    server.kill();
    await sleep(500);
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function runOnce({ build, version, scenario, options, top, cacheDir, rep }) {
  const work = await mkdtemp(path.join(os.tmpdir(), "libera-energy-"));
  const { server, url } = await startServer({ build, work, cacheDir });
  let serverErrors = "";
  server.stderr.on("data", (chunk) => { serverErrors = (serverErrors + chunk).slice(-2000); });
  try {
    await waitForServer(url, server);
    const logFile = path.join(work, "harness.log");
    await writeFile(logFile, "");
    const harness = spawn(ELECTRON, [path.join(here, "harness.cjs")], {
      env: {
        ...process.env,
        BENCH_POWER: options.power,
        BENCH_CONFIG: JSON.stringify({
          url, password: PASSWORD, scenario, settleMs: options.settleMs, userData: path.join(work, "electron-profile"),
          logFile, watchdogMs: 210000,
          shotFile: rep === 0 ? path.join(options.out, `end-${version}-${scenario}.png`) : undefined,
          files: { note: FIXTURE.note, pdf: FIXTURE.pdf, latex: FIXTURE.latex },
          failureShot: path.join(options.out, `failure-${version}-${scenario}-${Date.now()}.png`),
        }),
      },
      // Nothing reads stdout (progress goes to the log file), so it must not be a pipe that can fill up.
      stdio: ["ignore", "ignore", "pipe"],
    });
    let start, end, electronPids = [], result, error, lastStep = "starting Electron", harnessErrors = "";
    harness.stderr.setEncoding("utf8");
    harness.stderr.on("data", (chunk) => { harnessErrors = (harnessErrors + chunk).slice(-1500); });
    const timeout = setTimeout(() => harness.kill("SIGKILL"), 4 * 60_000);
    await new Promise((resolve) => harness.once("exit", resolve));
    clearTimeout(timeout);
    for (const line of (await readFile(logFile, "utf8")).split("\n")) {
      if (line.startsWith("BENCH_START ")) { const [, at, pids] = line.split(" "); start = Number(at); electronPids = JSON.parse(pids); }
      else if (line.startsWith("BENCH_END ")) end = Number(line.split(" ")[1]);
      else if (line.startsWith("BENCH_RESULT ")) result = JSON.parse(line.slice(13));
      else if (line.startsWith("BENCH_ERROR ")) error = line.slice(12);
      else if (line.startsWith("BENCH_STEP ")) lastStep = line.slice(11);
    }
    if (!result) throw new Error(error ?? `The harness stopped while ${lastStep}.${harnessErrors ? ` Electron said: ${harnessErrors.trim().split("\n").slice(-3).join(" | ")}` : ""}`);
    await sleep(1500);
    const blocks = top.window(start, end);
    const electronRoot = harness.pid;
    const electron = treeUsage(blocks, [electronRoot, ...electronPids]);
    const serverUsage = treeUsage(blocks, [server.pid]);
    return {
      version, scenario, power: options.power,
      ...result,
      electronTree: electron,
      serverTree: serverUsage,
      totalCpuS: (electron.cpuS ?? 0) + (serverUsage.cpuS ?? 0),
      energyImpact: (electron.energyImpact ?? 0) + (serverUsage.energyImpact ?? 0),
      topSamples: blocks.length,
    };
  } catch (cause) {
    throw new Error(`${version}/${scenario}: ${cause.message}${serverErrors ? ` (server: ${serverErrors.trim().split("\n").slice(-3).join(" | ")})` : ""}`);
  } finally {
    server.kill();
    await sleep(500);
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/* ---- Report --------------------------------------------------------------------- */

const median = (values) => {
  const sorted = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export const METRICS = [
  ["energyImpact", "Energy Impact (avg)", 1],
  ["totalCpuS", "CPU s, all processes", 2],
  ["electronCpuS.Tab", "CPU s, renderer", 2],
  ["electronCpuS.GPU", "CPU s, GPU", 2],
  ["electronCpuS.Browser", "CPU s, browser", 2],
  ["serverTree.cpuS", "CPU s, server", 2],
  ["idleWakeupsPerS", "Idle wakeups / s", 0],
  ["renderer.taskMs", "Renderer task ms", 0],
  ["renderer.scriptMs", "Renderer script ms", 0],
  ["renderer.layoutMs", "Renderer layout ms", 0],
  ["renderer.styleMs", "Renderer style ms", 0],
  ["appMenuUpdates", "Menu-bar syncs", 0],
];

export const pick = (run, key) => key.split(".").reduce((value, part) => value?.[part], run);

export function summarize(runs) {
  const scenarios = [...new Set(runs.map((run) => run.scenario))];
  return scenarios.map((scenario) => {
    const of = (version) => runs.filter((run) => run.scenario === scenario && run.version === version);
    const rows = METRICS.map(([key, label, digits]) => {
      const before = of("before").map((run) => pick(run, key));
      const after = of("after").map((run) => pick(run, key));
      const b = median(before);
      const a = median(after);
      return { key, label, digits, before: b, after: a, beforeRuns: before, afterRuns: after, change: b ? (a - b) / b : null };
    });
    return { scenario, runs: of("before").length + of("after").length, rows };
  });
}

export function markdown(summary, options, meta) {
  const format = (value, digits) => (value === null || value === undefined ? "–" : value.toFixed(digits));
  const lines = [
    `# Energy bench (${options.power === "battery" ? "battery" : "mains power"})`,
    "",
    `Before: \`${meta.before}\` · After: \`${meta.after}\` · ${options.reps} run(s) per version and scenario, alternating versions. Medians; ranges in brackets.`,
    "",
  ];
  for (const { scenario, rows } of summary) {
    lines.push(`## ${scenario}`, "", "| Metric | Before | After | Change |", "| --- | --- | --- | --- |");
    for (const row of rows) {
      const range = (values) => {
        const finite = values.filter((value) => typeof value === "number");
        return finite.length > 1 ? ` [${format(Math.min(...finite), row.digits)}–${format(Math.max(...finite), row.digits)}]` : "";
      };
      lines.push(`| ${row.label} | ${format(row.before, row.digits)}${range(row.beforeRuns)} | ${format(row.after, row.digits)}${range(row.afterRuns)} | ${row.change === null ? "–" : `${row.change > 0 ? "+" : ""}${(row.change * 100).toFixed(0)}%`} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function gitDescribe(dir) {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", dir, "log", "-1", "--format=%h %s"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("exit", () => resolve(out.trim().slice(0, 80) || dir));
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.out, { recursive: true });
  const cacheDir = path.join(os.tmpdir(), "libera-energy-cache");
  const meta = { before: await gitDescribe(options.before), after: await gitDescribe(options.after), startedAt: new Date().toISOString(), host: `${os.cpus()[0]?.model} · ${Math.round(os.totalmem() / 2 ** 30)} GB`, node: process.version };
  await preparePython(options.after, cacheDir);
  const top = new TopSampler();
  await sleep(2500);
  const runs = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jsonPath = path.join(options.out, `energy-${options.power}-${stamp}.json`);
  try {
    for (let rep = 0; rep < options.reps; rep += 1) {
      for (const scenario of options.scenarios) {
        const order = rep % 2 === 0 ? ["before", "after"] : ["after", "before"];
        for (const version of order) {
          process.stdout.write(`rep ${rep + 1}/${options.reps} · ${scenario} · ${version} … `);
          try {
            const run = await runOnce({ build: options[version], version, scenario, options, top, cacheDir, rep });
            runs.push({ rep, ...run });
            process.stdout.write(`energy ${run.energyImpact.toFixed(1)} · cpu ${run.totalCpuS.toFixed(2)} s\n`);
          } catch (error) {
            runs.push({ rep, version, scenario, error: error.message });
            process.stdout.write(`failed: ${error.message}\n`);
          }
          await writeFile(jsonPath, JSON.stringify({ meta, options, runs }, null, 2));
          await sleep(3000);
        }
      }
    }
  } finally {
    top.stop();
  }
  const ok = runs.filter((run) => !run.error);
  const summary = summarize(ok);
  const report = markdown(summary, options, meta);
  await writeFile(jsonPath, JSON.stringify({ meta, options, runs, summary }, null, 2));
  await writeFile(jsonPath.replace(/\.json$/, ".md"), `${report}\n`);
  process.stdout.write(`\n${report}\nWrote ${jsonPath}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
}
