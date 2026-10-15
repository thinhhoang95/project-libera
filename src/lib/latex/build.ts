import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { homeDirectory, joinPath } from "@/lib/runtime-path";
import path from "node:path";
import { StorageError } from "@/lib/storage/errors";
import { filePathFromParts, splitFilePath } from "@/lib/storage/paths";
import { parseBiberLog, parseBibtexLog, parseLatexLog, type LatexLogEntry, type LatexLogSeverity } from "./log-parser";
import { isCompilableLatexPath, resolveLatexEngine, type LatexEngine, type LatexEngineSetting } from "./project";
import { findTexToolchain, texEnvironment, texExecutable, texMissingMessage, type TexToolchain } from "./toolchain";

/* Builds run in a per-document folder under the OS temp directory, so aux
 * files survive between compiles (latexmk then only reruns what changed) and
 * nothing is written into the notebook. The main file is written into that
 * folder from the editor's draft and TeX runs with the source folder as its
 * working directory: `\input`, `\includegraphics` and `\bibliography` resolve
 * against the notebook as usual, while TeX's "output directory first" lookup
 * lets unsaved drafts of other open files shadow their saved versions.
 * Each successful PDF is copied into an immutable snapshot that the viewer and
 * SyncTeX read while the next compile is already running. */

export type LatexDiagnostic = {
  severity: LatexLogSeverity;
  message: string;
  details?: string;
  /** Notebook-relative path, when the message points into the notebook. */
  path?: string;
  line?: number;
};

export type LatexBuildStatus = "success" | "error" | "failure";

export type LatexBuildResult = {
  status: LatexBuildStatus;
  rootPath: string;
  engine: LatexEngine;
  /** Snapshot holding the newest PDF, or null when no PDF exists yet. */
  buildId: string | null;
  /** True when `buildId` holds a PDF produced by this compile. */
  fresh: boolean;
  diagnostics: LatexDiagnostic[];
  log: string;
  output: string;
  durationMs: number;
};

export type LatexBuildRequest = {
  rootPath: string;
  engine?: LatexEngineSetting;
  /** Unsaved editor contents by notebook-relative path. */
  drafts?: Record<string, string>;
};

export type LatexSnapshotMeta = {
  rootPath: string;
  rootDirectoryPath: string;
  jobName: string;
  sourceDirectory: string;
  workDirectory: string;
  /** The same folders with symbolic links resolved, as TeX may report them. */
  realDirectories?: { source: string; work: string };
  overrides: string[];
};

function realTemporaryDirectory() {
  try {
    // On macOS the temp folder is reached through the /var -> /private/var link.
    return realpathSync(os.tmpdir());
  } catch {
    return os.tmpdir();
  }
}

const BUILD_ROOT = joinPath(realTemporaryDirectory(), "libera-latex");

/* Built through functions so the Next.js file tracer cannot read these as paths
 * and glob the project folder at build time (see runtime-path.ts). */
const rootTexFile = (paths: { workDirectory: string; jobName: string }) => joinPath(paths.workDirectory, `${paths.jobName}.tex`);
const optionWithValue = (option: string, value: string) => `${option}=${value}`;
const COMPILE_TIMEOUT_MS = 4 * 60_000;
const MAX_SNAPSHOTS = 3;
const MAX_LOG_CHARACTERS = 400_000;
const MAX_OUTPUT_CHARACTERS = 40_000;
const OVERRIDE_EXTENSIONS = /\.(tex|sty|cls)$/i;
const SNAPSHOT_ID = /^[a-z0-9]{6,40}$/;

const buildLocks = new Map<string, Promise<unknown>>();

export function latexBuildPaths(rootPath: string) {
  if (!isCompilableLatexPath(rootPath)) throw new StorageError("Only .tex files can be compiled.");
  const { notebook, pathParts } = splitFilePath(rootPath);
  const rootAbsolute = filePathFromParts(notebook, pathParts);
  const key = createHash("sha256").update(rootAbsolute).digest("hex").slice(0, 24);
  const buildDirectory = path.join(BUILD_ROOT, key);
  const stem = (pathParts.at(-1) ?? "document").replace(/\.tex$/i, "");
  // Spaces and other shell-unfriendly characters upset some packages' use of \jobname.
  const jobName = /^[A-Za-z0-9._+-]+$/.test(stem) ? stem : stem.replace(/[^A-Za-z0-9._+-]+/g, "_").replace(/^_+|_+$/g, "") || "document";
  return {
    key,
    buildDirectory,
    workDirectory: path.join(buildDirectory, "work"),
    outDirectory: path.join(buildDirectory, "out"),
    sourceDirectory: path.dirname(rootAbsolute),
    rootAbsolute,
    rootDirectoryPath: [notebook, ...pathParts.slice(0, -1)].join("/"),
    jobName,
  };
}

type BuildPaths = ReturnType<typeof latexBuildPaths>;

function relativeInside(directory: string, target: string) {
  const relative = path.relative(directory, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative;
}

/** Map a file name printed by TeX, BibTeX or SyncTeX to a notebook path. */
export function notebookPathForTexFile(file: string | undefined, meta: Pick<LatexSnapshotMeta, "rootPath" | "rootDirectoryPath" | "jobName" | "sourceDirectory" | "workDirectory" | "realDirectories" | "overrides">) {
  if (!file) return undefined;
  const absolute = path.resolve(meta.sourceDirectory, file.trim());
  const inside = (directories: (string | undefined)[]) => {
    for (const directory of directories) {
      const relative = directory ? relativeInside(directory, absolute) : null;
      if (relative !== null) return relative;
    }
    return null;
  };
  const inWork = inside([meta.workDirectory, meta.realDirectories?.work]);
  if (inWork !== null) {
    const normalized = inWork.split(path.sep).join("/");
    if (normalized === `${meta.jobName}.tex`) return meta.rootPath;
    return meta.overrides.includes(normalized) ? `${meta.rootDirectoryPath}/${normalized}` : undefined;
  }
  const inSource = inside([meta.sourceDirectory, meta.realDirectories?.source]);
  if (inSource === null) return undefined;
  const normalized = inSource.split(path.sep).join("/");
  // The saved main file is never read; the draft in the work folder is.
  return `${meta.rootDirectoryPath}/${normalized}`;
}

/** latexmk rc files are Perl programs. A notebook folder can come from
 * anywhere (sync, uploads, shared archives), so only the user's own rc file
 * is read, never one next to the document. */
async function latexmkRcArguments() {
  const home = homeDirectory();
  const candidates = [
    process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, "latexmk", "latexmkrc") : null,
    path.join(home, ".config", "latexmk", "latexmkrc"),
    path.join(home, ".latexmkrc"),
  ].filter((candidate): candidate is string => !!candidate);
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) return ["-norc", "-r", candidate];
  }
  return ["-norc"];
}

/** latexmk runs biber from the source folder, and when its `.fdb_latexmk`
 * record is missing it passes only the job name, so biber would read a stale
 * `.bcf` that another editor left next to the document (and write its `.bbl`
 * there). Always point it at the build folder instead. */
const LATEXMK_BIBER_RC = 'sub libera_biber { my $base = pop @_; $base = "$aux_dir/$base" unless $base =~ m{^/}; return system("biber", "--output-directory=$aux_dir", @_, $base); } $biber = "internal libera_biber %O %B";';

function withLock<T>(key: string, task: () => Promise<T>) {
  const previous = buildLocks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  buildLocks.set(key, next);
  void next.finally(() => { if (buildLocks.get(key) === next) buildLocks.delete(key); }).catch(() => undefined);
  return next;
}

type ProcessResult = { code: number | null; output: string; timedOut: boolean };

function runProcess(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs?: number }) {
  return new Promise<ProcessResult>((resolve, reject) => {
    options.signal.throwIfAborted();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      // A process group lets cancellation stop latexmk and the engine it started.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > MAX_OUTPUT_CHARACTERS * 2) output = output.slice(-MAX_OUTPUT_CHARACTERS);
    };
    const kill = () => {
      if (child.exitCode !== null || child.pid === undefined) return;
      try {
        if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs ?? COMPILE_TIMEOUT_MS);
    const onAbort = () => kill();
    options.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      if (options.signal.aborted) reject(options.signal.reason ?? new Error("Compile canceled."));
      else resolve({ code, output: output.slice(-MAX_OUTPUT_CHARACTERS), timedOut });
    });
  });
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function modifiedAt(file: string) {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/** Write unsaved drafts into the work folder and remove the previous ones. */
async function stageSources(paths: BuildPaths, request: LatexBuildRequest) {
  const drafts = request.drafts ?? {};
  const manifestPath = path.join(paths.buildDirectory, "overrides.json");
  const previous = (await readJson<string[]>(manifestPath)) ?? [];

  for (const relative of previous) {
    const target = path.resolve(paths.workDirectory, relative);
    if (relativeInside(paths.workDirectory, target) !== null) await rm(target, { force: true });
  }

  const rootDraft = drafts[request.rootPath];
  const rootSource = typeof rootDraft === "string" ? rootDraft : await readFile(paths.rootAbsolute, "utf8").catch(() => {
    throw new StorageError("The main LaTeX file could not be read.", 404);
  });
  await writeFile(rootTexFile(paths), rootSource, "utf8");

  const overrides: string[] = [];
  for (const [notebookPath, content] of Object.entries(drafts)) {
    if (notebookPath === request.rootPath || typeof content !== "string" || !OVERRIDE_EXTENSIONS.test(notebookPath)) continue;
    const { notebook, pathParts } = splitFilePath(notebookPath);
    const relative = relativeInside(paths.sourceDirectory, filePathFromParts(notebook, pathParts));
    // Only files TeX can reach from the main file's folder can be shadowed.
    if (relative === null) continue;
    const target = path.join(paths.workDirectory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    overrides.push(relative.split(path.sep).join("/"));
  }

  await writeFile(manifestPath, JSON.stringify(overrides), "utf8");
  return { rootSource, overrides };
}

/** `\include{chapters/one}` writes `chapters/one.aux` into the output
 * folder, which TeX does not create on its own. */
async function mirrorSourceFolders(source: string, target: string, depth = 0) {
  if (depth > 4) return;
  const entries = await readdir(source, { withFileTypes: true }).catch(() => []);
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_") || entry.name === "node_modules") continue;
    if (++count > 64) break;
    await mkdir(path.join(target, entry.name), { recursive: true });
    await mirrorSourceFolders(path.join(source, entry.name), path.join(target, entry.name), depth + 1);
  }
}

async function runEngineDirectly(toolchain: TexToolchain, engine: LatexEngine, paths: BuildPaths, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const engineArgs = ["-interaction=nonstopmode", "-file-line-error", "-synctex=1", optionWithValue("-output-directory", paths.workDirectory), rootTexFile(paths)];
  const options = { cwd: paths.sourceDirectory, env, signal };
  let output = "";
  let result = await runProcess(texExecutable(toolchain, engine), engineArgs, options);
  output += result.output;
  if (result.timedOut) return { ...result, output };

  const aux = await readFile(path.join(paths.workDirectory, `${paths.jobName}.aux`), "utf8").catch(() => "");
  const usesBiber = await modifiedAt(path.join(paths.workDirectory, `${paths.jobName}.bcf`)) !== null;
  if (usesBiber) {
    output += (await runProcess(texExecutable(toolchain, "biber"), [optionWithValue("--output-directory", paths.workDirectory), path.join(paths.workDirectory, paths.jobName)], { ...options, cwd: paths.workDirectory }).catch((error: Error) => ({ output: `biber: ${error.message}\n` }))).output;
  } else if (/\\bibdata\{/.test(aux)) {
    output += (await runProcess(texExecutable(toolchain, "bibtex"), [paths.jobName], { ...options, cwd: paths.workDirectory }).catch((error: Error) => ({ output: `bibtex: ${error.message}\n` }))).output;
  }

  for (let pass = 0; pass < 3; pass++) {
    const log = await readFile(path.join(paths.workDirectory, `${paths.jobName}.log`), "utf8").catch(() => "");
    if (pass > 0 && !/Rerun to get|rerunfilecheck Warning|Label\(s\) may have changed/.test(log)) break;
    result = await runProcess(texExecutable(toolchain, engine), engineArgs, options);
    output += result.output;
    if (result.timedOut) break;
  }

  return { ...result, output };
}

async function snapshotPdf(paths: BuildPaths, meta: LatexSnapshotMeta) {
  const id = `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
  const directory = path.join(paths.outDirectory, id);
  await mkdir(directory, { recursive: true });
  await copyFile(path.join(paths.workDirectory, `${paths.jobName}.pdf`), path.join(directory, `${paths.jobName}.pdf`));
  await copyFile(path.join(paths.workDirectory, `${paths.jobName}.synctex.gz`), path.join(directory, `${paths.jobName}.synctex.gz`)).catch(() => undefined);
  await writeFile(path.join(directory, "meta.json"), JSON.stringify(meta), "utf8");

  const snapshots = (await readdir(paths.outDirectory)).filter((name) => SNAPSHOT_ID.test(name)).sort();
  for (const stale of snapshots.slice(0, Math.max(0, snapshots.length - MAX_SNAPSHOTS))) {
    await rm(path.join(paths.outDirectory, stale), { recursive: true, force: true });
  }
  return id;
}

async function latestSnapshot(paths: BuildPaths) {
  const snapshots = (await readdir(paths.outDirectory).catch(() => [] as string[])).filter((name) => SNAPSHOT_ID.test(name)).sort();
  return snapshots.at(-1) ?? null;
}

function toDiagnostics(entries: LatexLogEntry[], meta: LatexSnapshotMeta): LatexDiagnostic[] {
  return entries.map((entry) => ({
    severity: entry.severity,
    message: entry.message,
    details: entry.details,
    path: notebookPathForTexFile(entry.file, meta),
    line: entry.line,
  }));
}

export async function compileLatexDocument(request: LatexBuildRequest, signal: AbortSignal): Promise<LatexBuildResult> {
  const paths = latexBuildPaths(request.rootPath);
  return withLock(paths.key, async () => {
    signal.throwIfAborted();
    const startedAt = Date.now();
    const toolchain = await findTexToolchain();
    // Drafts are written here, so keep the folders private to this user.
    await mkdir(paths.workDirectory, { recursive: true, mode: 0o700 });
    await mkdir(paths.outDirectory, { recursive: true, mode: 0o700 });
    const { rootSource, overrides } = await stageSources(paths, request);
    const engine = resolveLatexEngine(rootSource, request.engine ?? "auto");
    const meta: LatexSnapshotMeta = {
      rootPath: request.rootPath,
      rootDirectoryPath: paths.rootDirectoryPath,
      jobName: paths.jobName,
      sourceDirectory: paths.sourceDirectory,
      workDirectory: paths.workDirectory,
      realDirectories: {
        source: await realpath(paths.sourceDirectory).catch(() => paths.sourceDirectory),
        work: await realpath(paths.workDirectory).catch(() => paths.workDirectory),
      },
      overrides,
    };

    if (!toolchain.binDirectory) {
      return { status: "failure", rootPath: request.rootPath, engine, buildId: await latestSnapshot(paths), fresh: false, diagnostics: [{ severity: "error", message: texMissingMessage() }], log: "", output: "", durationMs: Date.now() - startedAt };
    }

    await mirrorSourceFolders(paths.sourceDirectory, paths.workDirectory);
    const statePath = path.join(paths.buildDirectory, "state.json");
    const previousState = await readJson<{ signature?: string; status?: LatexBuildStatus }>(statePath);
    const signature = JSON.stringify([engine, overrides.slice().sort()]);
    const listSeparator = path.delimiter;
    const env = texEnvironment(toolchain, {
      TEXMFOUTPUT: paths.workDirectory,
      // Keep documents from running programs or reading outside their folder.
      openin_any: "p",
      openout_any: "p",
      shell_escape: "f",
      BIBINPUTS: `${paths.sourceDirectory}${listSeparator}`,
      BSTINPUTS: `${paths.sourceDirectory}${listSeparator}`,
    });
    const pdfPath = path.join(paths.workDirectory, `${paths.jobName}.pdf`);
    const compileStartedAt = Date.now() - 1000;

    let result: ProcessResult;
    try {
      if (toolchain.hasLatexmk) {
        const engineFlag = engine === "xelatex" ? "-pdfxe" : engine === "lualatex" ? "-pdflua" : "-pdf";
        // Force a full run when the set of shadowed files or the engine changed,
        // or after a failed run, since latexmk tracks dependencies by path.
        const force = previousState?.signature !== signature || previousState?.status !== "success";
        result = await runProcess(texExecutable(toolchain, "latexmk"), [
          ...(await latexmkRcArguments()), "-e", LATEXMK_BIBER_RC, engineFlag, ...(force ? ["-g"] : []), "-interaction=nonstopmode", "-file-line-error", "-synctex=1",
          optionWithValue("-outdir", paths.workDirectory), rootTexFile(paths),
        ], { cwd: paths.sourceDirectory, env, signal });
      } else {
        result = await runEngineDirectly(toolchain, engine, paths, env, signal);
      }
    } catch (error) {
      signal.throwIfAborted();
      const message = error instanceof Error && "code" in error && error.code === "ENOENT" ? texMissingMessage() : error instanceof Error ? error.message : "The LaTeX compiler could not be started.";
      return { status: "failure", rootPath: request.rootPath, engine, buildId: await latestSnapshot(paths), fresh: false, diagnostics: [{ severity: "error", message }], log: "", output: "", durationMs: Date.now() - startedAt };
    }

    const log = await readFile(path.join(paths.workDirectory, `${paths.jobName}.log`), "utf8").catch(() => "");
    const entries = parseLatexLog(log, rootTexFile(paths));
    const blgPath = path.join(paths.workDirectory, `${paths.jobName}.blg`);
    const blgModified = await modifiedAt(blgPath);
    if (blgModified !== null && blgModified >= compileStartedAt) {
      const blg = await readFile(blgPath, "utf8").catch(() => "");
      entries.push(...(/^This is Biber|\bbiber\b/i.test(blg.slice(0, 400)) ? parseBiberLog(blg) : parseBibtexLog(blg)));
    }
    if (result.timedOut) entries.unshift({ severity: "error", message: "Compilation took too long and was stopped." });

    const pdfModified = await modifiedAt(pdfPath);
    // latexmk leaves an up-to-date PDF untouched and exits successfully.
    const pdfReady = pdfModified !== null && !result.timedOut && (pdfModified >= compileStartedAt || result.code === 0);
    const hasErrors = entries.some((entry) => entry.severity === "error") || (result.code !== 0 && !pdfReady);
    if (!pdfReady && !entries.some((entry) => entry.severity === "error")) {
      const tail = result.output.trim().split("\n").slice(-6).join("\n");
      entries.unshift({ severity: "error", message: "LaTeX did not produce a PDF.", details: tail || undefined });
    }

    const status: LatexBuildStatus = !pdfReady ? "failure" : hasErrors ? "error" : "success";
    const buildId = pdfReady ? await snapshotPdf(paths, meta) : await latestSnapshot(paths);
    await writeFile(statePath, JSON.stringify({ signature, status }), "utf8").catch(() => undefined);

    return {
      status,
      rootPath: request.rootPath,
      engine,
      buildId,
      fresh: pdfReady,
      diagnostics: toDiagnostics(entries, meta),
      log: log.length > MAX_LOG_CHARACTERS ? log.slice(-MAX_LOG_CHARACTERS) : log,
      output: result.output,
      durationMs: Date.now() - startedAt,
    };
  });
}

/** The folder of a finished build, after validating its id. */
export async function readLatexSnapshot(rootPath: string, buildId: string) {
  if (!SNAPSHOT_ID.test(buildId)) throw new StorageError("Unknown build.", 404);
  const paths = latexBuildPaths(rootPath);
  const directory = path.join(paths.outDirectory, buildId);
  const meta = await readJson<LatexSnapshotMeta>(path.join(directory, "meta.json"));
  if (!meta) throw new StorageError("This build is no longer available. Compile again.", 404);
  return {
    meta,
    directory,
    pdfPath: path.join(directory, `${meta.jobName}.pdf`),
    synctexPath: path.join(directory, `${meta.jobName}.synctex.gz`),
  };
}

/* ---- Build cache --------------------------------------------------------- */

export type LatexCacheFile = {
  /** Path inside the build folder, with forward slashes. */
  path: string;
  size: number;
  modifiedAt: number;
};

const MAX_CACHE_FILES = 2000;

async function listWorkFiles(directory: string, prefix = "", files: LatexCacheFile[] = []) {
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (files.length >= MAX_CACHE_FILES) break;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await listWorkFiles(directory, relative, files);
    } else if (entry.isFile()) {
      const info = await stat(path.join(directory, relative)).catch(() => null);
      if (info) files.push({ path: relative, size: info.size, modifiedAt: info.mtimeMs });
    }
  }
  return files;
}

async function sortedWorkFiles(directory: string) {
  return (await listWorkFiles(directory)).sort((left, right) => left.path.localeCompare(right.path));
}

/** Files TeX, latexmk and the bibliography tools left in the build folder.
 * PDF snapshots shown in the viewer are not part of the cache. */
export async function listLatexBuildCache(rootPath: string) {
  const paths = latexBuildPaths(rootPath);
  return withLock(paths.key, () => sortedWorkFiles(paths.workDirectory));
}

/** Delete the chosen build files so the next compile starts from scratch. */
export async function clearLatexBuildCache(rootPath: string, files: string[]) {
  const paths = latexBuildPaths(rootPath);
  return withLock(paths.key, async () => {
    let removed = 0;
    for (const file of files) {
      const target = path.resolve(paths.workDirectory, file);
      if (relativeInside(paths.workDirectory, target) === null) continue;
      const info = await stat(target).catch(() => null);
      if (!info?.isFile()) continue;
      await rm(target, { force: true });
      removed++;
    }
    // Forget the previous run so the next compile is a forced, full one.
    await rm(path.join(paths.buildDirectory, "state.json"), { force: true });
    return { removed, files: await sortedWorkFiles(paths.workDirectory) };
  });
}
