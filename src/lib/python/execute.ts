import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { pathExists } from "@/lib/storage/fs-utils";
import { filePathFromParts, notebookPath, splitFilePath } from "@/lib/storage/paths";
import { pythonInterpreter, pythonRuntimePaths, requirePythonInterpreter, type PythonRuntimeStatus } from "@/lib/python/runtime";
import { parsePythonCells, previousPythonFigureSources, pythonCellProblem, pythonFigureFileName, pythonFigureSourcePrefix, pythonSidecarPath, type PythonCell, type PythonFigure } from "@/lib/python/sidecar";

// Runs a note's Python sidecar (sidecar.ts) in a fresh process and saves the
// figures into the note's assets. Each run executes the setup code and the
// cells before the requested one first, so a cell sees what earlier cells
// defined, as in a notebook run from the top, and results never depend on a
// hidden kernel state.
//
// On macOS the process runs in a sandbox: no network, no writes outside its
// scratch folder, and no reads in the home folder except the notebook and the
// runtime. Libera's environment (API keys included) is never passed on.

export const DEFAULT_PYTHON_TIMEOUT_MS = 120_000;
export const MAX_PYTHON_TIMEOUT_MS = 600_000;

export type PythonCellError = { type: string; message: string; traceback: string; line: number | null };

export type PythonCellResult = {
  id: string | null;
  title: string;
  /** Line of the cell's `# %%` header in the sidecar (1 for setup code at the top). */
  line: number;
  stdout: string;
  stderr: string;
  /** The display of the cell's last expression, as a notebook shows it. */
  value: string | null;
  error: PythonCellError | null;
  seconds: number;
  figures: PythonFigure[];
  /** Figures drawn by a setup cell (no id), which are not saved. */
  discardedFigures: number;
};

export type PythonRunResult = {
  sidecarPath: string;
  cells: PythonCellResult[];
  figures: PythonFigure[];
  /** Ids of cells that finished, whose figures are now the ones in `figures`. */
  completed: string[];
  /** Cells that were to run but did not, after an error or the time limit. */
  notRun: string[];
  timedOut: boolean;
  python: string;
  previousSources: string[];
};

export class PythonRunError extends Error {}

type RunnerCell = { id: string | null; startLine: number; code: string };
type RunnerResult = {
  cells: Array<{ id: string | null; stdout: string; stderr: string; value: string | null; error: PythonCellError | null; figures: string[]; seconds: number; discardedFigures?: number }>;
  done: boolean;
  python: string;
};

export function pythonRunnerPath() {
  return process.env.LIBERA_PYTHON_RUNNER_PATH
    || path.join(/*turbopackIgnore: true*/ process.cwd(), "electron", "python-runner.py");
}

/** The cells a run executes: everything up to and including `cell`, or every cell. */
export function cellsToRun(cells: PythonCell[], cell?: string) {
  const code = cells.filter((entry) => !entry.text);
  if (!cell) return code;
  const index = code.findIndex((entry) => entry.id === cell);
  if (index < 0) {
    const ids = code.flatMap((entry) => entry.id ? [entry.id] : []);
    throw new PythonRunError(`The sidecar has no cell "${cell}".${ids.length ? ` Its cells: ${ids.join(", ")}.` : " It has no cells with an id yet; start one with a line \"# %% [" + cell + "]\"."}`);
  }
  return code.slice(0, index + 1);
}

const locks = new Map<string, Promise<unknown>>();

/** One run per note at a time: the agent and the editor's Re-run take turns. */
function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  locks.set(key, next);
  void next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => undefined);
  return next;
}

export function runPythonSidecar(options: {
  documentPath: string;
  /** The sidecar's text (an unsaved draft, or what is on disk). */
  source: string;
  cell?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onSetupProgress?: (status: PythonRuntimeStatus) => void;
}): Promise<PythonRunResult> {
  return serialized(options.documentPath, () => run(options));
}

async function run({ documentPath, source, cell, timeoutMs = DEFAULT_PYTHON_TIMEOUT_MS, signal, onSetupProgress }: Parameters<typeof runPythonSidecar>[0]): Promise<PythonRunResult> {
  if (isSharedNotebookPath(documentPath)) {
    throw new PythonRunError("Python figures are not available in shared notebooks yet: their images are shared files the collaboration host manages.");
  }
  const { notebook, pathParts } = splitFilePath(documentPath);
  const cells = parsePythonCells(source);
  const problem = pythonCellProblem(cells);
  if (problem) throw new PythonRunError(problem);
  const selected = cellsToRun(cells, cell);
  if (!selected.length) throw new PythonRunError("The sidecar has no code to run.");

  const interpreter = pythonInterpreter() ?? await requirePythonInterpreter(signal, onSetupProgress);
  const documentFile = filePathFromParts(notebook, pathParts);
  const original = await stat(documentFile, { bigint: true });
  const verifyDocument = async () => {
    const current = await stat(documentFile, { bigint: true });
    if (current.dev !== original.dev || current.ino !== original.ino || current.birthtimeNs !== original.birthtimeNs) throw new PythonRunError("The note was replaced while Python was running. Run it again.");
  };
  const sidecarFile = filePathFromParts(notebook, splitFilePath(pythonSidecarPath(documentPath)).pathParts);
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "libera-python-")));
  try {
    const output = path.join(scratch, "out");
    const temporary = path.join(scratch, "tmp");
    await mkdir(output);
    await mkdir(temporary);
    const request = path.join(scratch, "request.json");
    const runnerCells: RunnerCell[] = selected.map((entry) => ({ id: entry.id, startLine: entry.startLine, code: entry.code }));
    await writeFile(request, JSON.stringify({ sidecar: sidecarFile, output, cells: runnerCells, dpi: 200 }));

    const runtime = pythonRuntimePaths();
    await mkdir(runtime.cache, { recursive: true }).catch(() => undefined);
    const cwd = path.dirname(documentFile);
    const { command, args } = await sandboxed(interpreter, [pythonRunnerPath(), request], {
      writable: [scratch, runtime.cache],
      readable: [await realpath(notebookPath(notebook)).catch(() => notebookPath(notebook)), runtime.directory, path.dirname(pythonRunnerPath()), ...await interpreterRoots(interpreter)],
    });
    const { timedOut, stderr, exitCode, exitSignal } = await spawnRunner(command, args, {
      cwd,
      env: runnerEnvironment(temporary, runtime.cache),
      timeoutMs: Math.min(Math.max(timeoutMs, 1_000), MAX_PYTHON_TIMEOUT_MS),
      signal,
    });

    let result: RunnerResult | null = null;
    try { result = JSON.parse(await readFile(path.join(output, "result.json"), "utf8")) as RunnerResult; }
    catch { result = null; }
    if (signal?.aborted) throw new PythonRunError("Stopped.");
    if (!timedOut && (exitCode !== 0 || (result && !result.done))) {
      throw new PythonRunError(`Python stopped unexpectedly (${exitSignal ? `signal ${exitSignal}` : exitCode === 0 ? "incomplete result" : `exit code ${exitCode ?? "unknown"}`}).${stderr.trim() ? `\n${stderr.trim().split("\n").slice(-8).join("\n")}` : ""}`);
    }
    if (!result || (timedOut && !result.cells.length)) {
      if (signal?.aborted) throw new PythonRunError("Stopped.");
      if (timedOut) throw new PythonRunError(`The run hit its time limit before the first cell finished${result ? "" : " (Python had not started yet)"}. The first run on a computer is slower while Matplotlib builds its font cache; try again, or allow more time.`);
      throw new PythonRunError(`Python did not start${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-8).join("\n")}` : "."}`);
    }

    await verifyDocument();
    const assetDirectory = path.dirname(sidecarFile);
    const assetPrefix = pythonFigureSourcePrefix(documentPath);
    const cellResults: PythonCellResult[] = [];
    for (const [index, entry] of result.cells.entries()) {
      const cellInfo = selected[index];
      const figures: PythonFigure[] = [];
      for (const [number, file] of entry.figures.entries()) {
        const body = await readFile(path.join(output, file));
        const name = pythonFigureFileName(cellInfo.id!, number + 1, createHash("sha256").update(body).digest("hex"));
        const target = path.join(assetDirectory, name);
        if (!(await pathExists(target))) {
          await verifyDocument();
          await mkdir(assetDirectory, { recursive: true });
          await writeFile(target, body);
        } else await utimes(target, new Date(), new Date());
        figures.push({ cell: cellInfo.id!, index: number + 1, src: `${assetPrefix}/${name}`, ...pngSize(body) });
      }
      cellResults.push({
        id: entry.id,
        title: cellInfo.title,
        line: Math.max(1, cellInfo.startLine - 1),
        stdout: entry.stdout,
        stderr: entry.stderr,
        value: entry.value,
        error: entry.error,
        seconds: entry.seconds,
        figures,
        discardedFigures: entry.discardedFigures ?? 0,
      });
    }
    return {
      sidecarPath: pythonSidecarPath(documentPath),
      cells: cellResults,
      figures: cellResults.flatMap((entry) => entry.figures),
      completed: cellResults.flatMap((entry) => entry.id && !entry.error ? [entry.id] : []),
      notRun: selected.slice(cellResults.length).map((entry) => entry.id ?? `setup code at line ${Math.max(1, entry.startLine - 1)}`),
      timedOut: timedOut && !result.done,
      python: result.python,
      previousSources: previousPythonFigureSources(source),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Only what Python needs; never Libera's own environment, which holds API keys. */
function runnerEnvironment(temporary: string, cache: string): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];
  const env: Record<string, string> = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key]!;
  const run: Record<string, string> = {
    ...env,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    MPLBACKEND: "Agg",
    MPLCONFIGDIR: cache,
    // Fontconfig (in conda builds of Matplotlib) caches here instead of the home folder.
    XDG_CACHE_HOME: cache,
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
  return run as NodeJS.ProcessEnv;
}

/** Folders an interpreter outside Libera's runtime (LIBERA_PYTHON) loads its libraries from. */
async function interpreterRoots(interpreter: string) {
  const resolved = await realpath(interpreter).catch(() => interpreter);
  return [path.dirname(path.dirname(interpreter)), path.dirname(path.dirname(resolved))];
}

function sbplString(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

/** The macOS sandbox profile for a run (sandbox-exec; later rules win). */
export function pythonSandboxProfile({ home, writable, readable }: { home: string; writable: string[]; readable: string[] }) {
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    `(allow file-write* ${[...writable.map((folder) => `(subpath ${sbplString(folder)})`), "(literal \"/dev/null\")", "(regex #\"^/dev/(fd/|tty|stdout|stderr)\")"].join(" ")})`,
    `(deny file-read* (subpath ${sbplString(home)}))`,
    `(allow file-read* (literal ${sbplString(home)}) ${[...readable, ...writable].map((folder) => `(subpath ${sbplString(folder)})`).join(" ")})`,
  ].join("\n");
}

async function sandboxed(interpreter: string, args: string[], access: { writable: string[]; readable: string[] }) {
  if (process.platform !== "darwin" || process.env.LIBERA_PYTHON_SANDBOX === "0" || !(await pathExists("/usr/bin/sandbox-exec"))) {
    return { command: interpreter, args };
  }
  const home = await realpath(os.homedir()).catch(() => os.homedir());
  const resolve = (folders: string[]) => Promise.all(folders.map((folder) => realpath(folder).catch(() => folder)));
  const profile = pythonSandboxProfile({ home, writable: await resolve(access.writable), readable: await resolve(access.readable) });
  return { command: "/usr/bin/sandbox-exec", args: ["-p", profile, interpreter, ...args] };
}

function spawnRunner(command: string, args: string[], { cwd, env, timeoutMs, signal }: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }) {
  return new Promise<{ timedOut: boolean; stderr: string; exitCode: number | null; exitSignal: NodeJS.Signals | null }>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PythonRunError("Stopped."));
      return;
    }
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", () => undefined);
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8000); });
    child.once("exit", () => {
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ }
      }
    });
    let fallback: ReturnType<typeof setTimeout> | undefined;
    let killer: ReturnType<typeof spawn> | undefined;
    const kill = () => {
      if (fallback) return;
      if (process.platform === "win32" && child.pid) {
        killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", () => child.kill("SIGKILL"));
      } else if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
      // An inherited pipe must never keep a timed-out request waiting indefinitely.
      fallback = setTimeout(() => {
        killer?.kill();
        child.kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
      }, 1_000);
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const abort = () => kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(fallback);
      signal?.removeEventListener("abort", abort);
      reject(new PythonRunError(`Could not start Python: ${error.message}`));
    });
    child.once("close", (exitCode, exitSignal) => {
      clearTimeout(timer);
      clearTimeout(fallback);
      signal?.removeEventListener("abort", abort);
      // Kill any remaining members of the run's POSIX process group, even after a normal exit.
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ }
      }
      resolve({ timedOut, stderr, exitCode, exitSignal });
    });
  });
}

function pngSize(body: Buffer) {
  const png = body.length >= 24 && body.readUInt32BE(12) === 0x49484452;
  return png ? { width: body.readUInt32BE(16), height: body.readUInt32BE(20) } : { width: 0, height: 0 };
}
