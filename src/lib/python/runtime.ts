import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultModelsDirectory } from "../../../electron/search-preferences.cjs";
import { getAdminRoot } from "@/lib/storage/paths";
import { UV_VERSION, uvAsset, uvDownloadUrl } from "@/lib/python/uv";

/**
 * Python in notes runs on a private runtime that Libera installs by itself
 * the first time the app opens: uv (pinned, checksummed) installs a managed
 * Python and a scientific stack into Libera's application data. Nothing is
 * installed system-wide. `LIBERA_PYTHON` points at another interpreter
 * instead (a conda env, say); Libera then installs nothing.
 */
export const PYTHON_RUNTIME = {
  python: "3.12",
  /** Raise when the package list changes: installed runtimes then update their packages. */
  revision: 1,
  // Ranges, not pins, so every platform finds wheels; --only-binary keeps
  // installs from running any package's build code.
  packages: [
    "numpy>=2.3,<3",
    "scipy>=1.16,<2",
    "pandas>=2.3,<3",
    "matplotlib>=3.10,<4",
    "seaborn>=0.13,<1",
    "sympy>=1.14,<2",
    "networkx>=3.5,<4",
    "tabulate>=0.9,<1",
    "pillow>=11,<13",
  ],
  estimatedBytes: 450_000_000,
};

export type PythonSetupPhase = "uv" | "python" | "packages";

export type PythonRuntimeStatus = {
  /** The interpreter cells run with is ready. */
  ready: boolean;
  /** `LIBERA_PYTHON` names the interpreter; Libera manages nothing. */
  custom: boolean;
  interpreter: string;
  directory: string;
  /** Packages the agent installed on top of the standard set. */
  extraPackages: string[];
  job: { phase: PythonSetupPhase; running: boolean; error: string; downloadedBytes: number; totalBytes: number; detail: string } | null;
  estimatedBytes: number;
};

type Marker = { revision: number; python: string; uv: string; packages: string[]; extraPackages?: string[]; installedAt: string };
type Job = NonNullable<PythonRuntimeStatus["job"]> & { directory: string; controller: AbortController; done: Promise<void> };

const store = globalThis as { [key: symbol]: Job | null | undefined };
const JOB_KEY = Symbol.for("libera.python.setup");

export function pythonRuntimeDirectory() {
  if (process.env.LIBERA_PYTHON_DIR) return process.env.LIBERA_PYTHON_DIR;
  const models = defaultModelsDirectory({ adminRoot: getAdminRoot(), configPath: process.env.LIBERA_CONFIG_PATH });
  return path.join(path.dirname(models), "python");
}

export function pythonRuntimePaths(directory = pythonRuntimeDirectory()) {
  const venv = path.join(directory, "venv");
  return {
    directory,
    uvDirectory: path.join(directory, "uv"),
    download: path.join(directory, "download"),
    venv,
    python: process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python"),
    marker: path.join(directory, "installed.json"),
    /** Matplotlib's font cache, kept between runs (building it takes seconds). */
    cache: path.join(directory, "mpl-cache"),
    environment: {
      UV_CACHE_DIR: path.join(directory, "cache"),
      UV_PYTHON_INSTALL_DIR: path.join(directory, "python"),
      UV_NO_PROGRESS: "1",
      UV_PYTHON_DOWNLOADS: "automatic",
    },
  };
}

function readMarker(markerPath: string): Marker | null {
  try { return JSON.parse(readFileSync(markerPath, "utf8")) as Marker; }
  catch { return null; }
}

function customInterpreter() {
  return process.env.LIBERA_PYTHON?.trim() || null;
}

/** The interpreter to run cells with, or null while the runtime is not installed. */
export function pythonInterpreter(): string | null {
  const custom = customInterpreter();
  if (custom) return custom;
  const paths = pythonRuntimePaths();
  const marker = readMarker(paths.marker);
  try {
    if (marker?.revision === PYTHON_RUNTIME.revision && statSync(paths.python).isFile()) return paths.python;
  } catch {
    // Not installed.
  }
  return null;
}

export function getPythonRuntimeStatus(): PythonRuntimeStatus {
  const paths = pythonRuntimePaths();
  const custom = customInterpreter();
  const job = store[JOB_KEY];
  const current = job && job.directory === paths.directory ? job : null;
  return {
    ready: pythonInterpreter() !== null,
    custom: !!custom,
    interpreter: custom ?? paths.python,
    directory: paths.directory,
    extraPackages: readMarker(paths.marker)?.extraPackages ?? [],
    job: current ? {
      phase: current.phase,
      running: current.running,
      error: current.error,
      downloadedBytes: current.downloadedBytes,
      totalBytes: current.totalBytes,
      detail: current.detail,
    } : null,
    estimatedBytes: PYTHON_RUNTIME.estimatedBytes,
  };
}

/**
 * Starts installing the runtime unless it is ready or being installed.
 * Python in notes is part of the app, so this runs on its own when the app
 * opens; a failed setup waits for `retry` (the Retry button) instead of
 * looping.
 */
export function ensurePythonRuntime({ retry = false } = {}) {
  if (pythonInterpreter()) return;
  const running = store[JOB_KEY];
  const directory = pythonRuntimePaths().directory;
  if (running && running.directory === directory && (running.running || (running.error && !retry))) return;
  const controller = new AbortController();
  const job = {
    phase: "uv",
    running: true,
    error: "",
    downloadedBytes: 0,
    totalBytes: 0,
    detail: "",
    directory,
    controller,
  } as Omit<Job, "done"> as Job;
  job.done = setUp(job).catch((error: unknown) => {
    job.error = controller.signal.aborted ? "Canceled." : error instanceof Error ? error.message : "Setting up Python failed.";
  }).finally(() => {
    job.running = false;
  });
  store[JOB_KEY] = job;
}

export function cancelPythonRuntimeSetup() {
  const job = store[JOB_KEY];
  if (job?.running) job.controller.abort();
}

/**
 * The interpreter, installing the runtime first when needed (the first run
 * on a new computer waits for it). Throws with the setup's error.
 */
export async function requirePythonInterpreter(signal?: AbortSignal, onProgress?: (status: PythonRuntimeStatus) => void): Promise<string> {
  const ready = pythonInterpreter();
  if (ready) return ready;
  ensurePythonRuntime({ retry: true });
  const job = store[JOB_KEY];
  if (job) {
    const timer = onProgress ? setInterval(() => onProgress(getPythonRuntimeStatus()), 2_000) : null;
    try {
      await Promise.race([
        job.done,
        new Promise<void>((_, reject) => {
          if (signal?.aborted) reject(new Error("Stopped."));
          signal?.addEventListener("abort", () => reject(new Error("Stopped.")), { once: true });
        }),
      ]);
    } finally {
      if (timer) clearInterval(timer);
    }
  }
  const interpreter = pythonInterpreter();
  if (interpreter) return interpreter;
  throw new Error(`Python is not set up${job?.error ? `: ${job.error}` : "."}`);
}

async function setUp(job: Job) {
  const paths = pythonRuntimePaths(job.directory);
  await mkdir(paths.directory, { recursive: true });
  const marker = readMarker(paths.marker);
  const uv = await installUv(job, paths);
  const environment = { ...process.env, ...paths.environment };

  if (!marker || !existsSync(paths.python) || marker.python !== PYTHON_RUNTIME.python) {
    job.phase = "python";
    job.detail = `Python ${PYTHON_RUNTIME.python}`;
    await run(job, uv, ["venv", "--python", PYTHON_RUNTIME.python, "--python-preference", "only-managed", "--clear", paths.venv], environment);
  }

  job.phase = "packages";
  const extra = marker?.extraPackages ?? [];
  job.detail = "NumPy, SciPy, pandas, Matplotlib and others";
  await run(job, uv, ["pip", "install", "--python", paths.python, "--only-binary", ":all:", ...PYTHON_RUNTIME.packages, ...extra], environment);
  await writeMarker(paths.marker, { packages: PYTHON_RUNTIME.packages, extraPackages: extra });
  await rm(paths.download, { recursive: true, force: true });
}

async function writeMarker(markerPath: string, { packages, extraPackages }: { packages: string[]; extraPackages: string[] }) {
  const marker: Marker = { revision: PYTHON_RUNTIME.revision, python: PYTHON_RUNTIME.python, uv: UV_VERSION, packages, extraPackages, installedAt: new Date().toISOString() };
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
}

async function installUv(job: Job, paths: ReturnType<typeof pythonRuntimePaths>) {
  const name = process.platform === "win32" ? "uv.exe" : "uv";
  const existing = existsSync(paths.uvDirectory) ? await findFile(paths.uvDirectory, name) : null;
  if (existing) return existing;
  const asset = uvAsset();
  if (!asset) throw new Error(`Python in notes is not available on ${process.platform} (${process.arch}) yet.`);
  job.phase = "uv";
  job.detail = "uv";
  job.totalBytes = asset.size;
  job.downloadedBytes = 0;
  const response = await fetch(uvDownloadUrl(asset.file), { signal: job.controller.signal });
  if (!response.ok || !response.body) throw new Error(`Downloading uv failed (HTTP ${response.status}).`);
  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk);
    chunks.push(buffer);
    hash.update(buffer);
    job.downloadedBytes += buffer.length;
  }
  if (hash.digest("hex") !== asset.sha256) throw new Error("The uv download is damaged (checksum mismatch). Try again.");
  await mkdir(paths.download, { recursive: true });
  const archive = path.join(paths.download, asset.file);
  await writeFile(archive, Buffer.concat(chunks));
  await rm(paths.uvDirectory, { recursive: true, force: true });
  await mkdir(paths.uvDirectory, { recursive: true });
  // bsdtar reads both .tar.gz and .zip; Windows 10 and later ship it as tar.exe.
  await run(job, "tar", ["-xf", archive, "-C", paths.uvDirectory]);
  const uv = await findFile(paths.uvDirectory, name);
  if (!uv) throw new Error("The uv download did not contain uv.");
  return uv;
}

/** Package names (with optional version specifiers) the agent may install; no URLs, paths or options. */
const PACKAGE_SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,-]+\])?(\s*(==|>=|<=|~=|!=|<|>)\s*[A-Za-z0-9.*+!-]+(\s*,\s*(==|>=|<=|~=|!=|<|>)\s*[A-Za-z0-9.*+!-]+)*)?$/;

export function isPythonPackageSpec(spec: string) {
  return PACKAGE_SPEC.test(spec.trim()) && spec.length <= 120;
}

/**
 * Installs packages from PyPI into Libera's runtime (wheels only, so no
 * package code runs during the install) and remembers them, so a runtime
 * update keeps them. Returns uv's report.
 */
export async function installPythonPackages(specs: string[], signal?: AbortSignal): Promise<string> {
  if (customInterpreter()) throw new Error("Cells run with the interpreter in LIBERA_PYTHON, which Libera does not manage. Install packages there yourself.");
  const invalid = specs.find((spec) => !isPythonPackageSpec(spec));
  if (invalid) throw new Error(`"${invalid}" is not a package name: give names from PyPI, optionally with a version (numpy>=2).`);
  await requirePythonInterpreter(signal);
  const paths = pythonRuntimePaths();
  const uv = await findFile(paths.uvDirectory, process.platform === "win32" ? "uv.exe" : "uv");
  if (!uv) throw new Error("Libera's uv is missing; restart Libera to repair the Python runtime.");
  const controller = new AbortController();
  signal?.addEventListener("abort", () => controller.abort(), { once: true });
  const job = { controller } as Job;
  const output = await run(job, uv, ["pip", "install", "--python", paths.python, "--only-binary", ":all:", ...specs.map((spec) => spec.trim())], { ...process.env, ...paths.environment });
  const marker = readMarker(paths.marker);
  const extra = [...new Set([...(marker?.extraPackages ?? []), ...specs.map((spec) => spec.trim())])];
  await writeMarker(paths.marker, { packages: marker?.packages ?? PYTHON_RUNTIME.packages, extraPackages: extra });
  return output;
}

async function findFile(folder: string, name: string): Promise<string | null> {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const entryPath = path.join(folder, entry.name);
    if (entry.isFile() && entry.name === name) return entryPath;
    if (entry.isDirectory()) {
      const found = await findFile(entryPath, name);
      if (found) return found;
    }
  }
  return null;
}

/** Run a setup command; fails with the end of its output, returns the output otherwise. */
function run(job: Pick<Job, "controller">, command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, signal: job.controller.signal });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-4000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => reject(job.controller.signal.aborted ? new Error("Canceled.") : error));
    child.once("close", (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${path.basename(command)} ${args[0]} failed${output.trim() ? `: ${output.trim().split("\n").slice(-6).join("\n")}` : "."}`));
    });
  });
}
