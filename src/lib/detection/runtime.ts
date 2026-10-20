import { spawn } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DETECTION_TEXT_ENCODER,
  DETECTION_VARIANTS,
  detectionPythonPath,
  inspectDetectionFolder,
  type DetectionFolderReport,
  type DetectionPreferences,
  type DetectionVariant,
  type DetectionVariantId,
} from "../../../electron/detection-preferences.cjs";
import { sharedModelDownloader, type ModelDownloadFile } from "@/lib/models/downloader";
import { detectionDirectory, getDetectionPreferences } from "@/lib/detection/settings";

/**
 * YOLOE-26 takes new text and visual prompts only through Ultralytics in
 * Python (an ONNX export bakes its classes in), so Libera installs a private
 * Python runtime for it: uv (pinned, checksummed) installs a managed Python
 * 3.12 and Ultralytics into `runtime/` beside the weights. Nothing is
 * installed system-wide.
 */
export const DETECTION_RUNTIME = {
  uvVersion: "0.13.1",
  python: "3.12",
  ultralytics: "8.4.182",
  // Ultralytics' fork of OpenAI CLIP supplies the tokenizer for MobileCLIP2; pinned as an archive so no git is needed.
  clip: "clip @ https://github.com/ultralytics/CLIP/archive/7ffa84b3bfa40c42ecc1c77147a855e69cb2dd40.zip",
  // PyTorch, torchvision, OpenCV and Ultralytics, as installed on macOS.
  estimatedBytes: 1_000_000_000,
  license: "AGPL-3.0 (Ultralytics, YOLOE-26 weights)",
};

const UV_ASSETS: Record<string, { file: string; size: number; sha256: string }> = {
  "darwin-arm64": { file: "uv-aarch64-apple-darwin.tar.gz", size: 14280170, sha256: "cfe454573412ff7380d15fc7dae5997ab53ffce72fce0a78e91ddbc84001acd2" },
  "darwin-x64": { file: "uv-x86_64-apple-darwin.tar.gz", size: 17491796, sha256: "bb7b805bdcf3d0bc8c74ceb94569e6b3e8aa35bd492acdbb9d46bf46d9d4ff6b" },
  "win32-x64": { file: "uv-x86_64-pc-windows-msvc.zip", size: 15308685, sha256: "3b2661a463a5baea7f5076ea2b25ab71d77f36a6c0d809e5350651792f80a672" },
  "win32-arm64": { file: "uv-aarch64-pc-windows-msvc.zip", size: 15802989, sha256: "ec7846a5939b4654afee24f2d82bf6fde71bd7a6952d7748f1135ab301dd0a49" },
};

const WEIGHTS_RELEASE = "https://github.com/ultralytics/assets/releases/download/v8.4.0";

export type DetectionSetupPhase = "runtime" | "python" | "packages" | "weights";

export type DetectionSetupJob = {
  phase: DetectionSetupPhase;
  variant: DetectionVariantId;
  running: boolean;
  error: string;
  downloadedBytes: number;
  totalBytes: number;
};

export type DetectionStatus = DetectionFolderReport & {
  directory: string;
  /** The variant chosen in Preferences. */
  variant: DetectionVariantId;
  preferences: Omit<DetectionPreferences, "modelDirectory">;
  catalog: ReadonlyArray<Readonly<DetectionVariant>>;
  job: DetectionSetupJob | null;
  /** Bytes still to download for the runtime, the text encoder and each variant. */
  sizes: { runtime: number; textEncoder: number; variants: Record<DetectionVariantId, number> };
};

type Job = DetectionSetupJob & { directory: string; controller: AbortController };

const store = globalThis as { [key: symbol]: Job | null | undefined };
const JOB_KEY = Symbol.for("libera.detection.setup");
const downloader = () => sharedModelDownloader("detection");

export function runtimePaths(directory: string) {
  const runtime = path.join(directory, "runtime");
  return {
    runtime,
    uvDirectory: path.join(runtime, "uv"),
    venv: path.join(runtime, "venv"),
    python: detectionPythonPath(directory),
    marker: path.join(runtime, "installed.json"),
    config: path.join(runtime, "config"),
    environment: {
      UV_CACHE_DIR: path.join(runtime, "cache"),
      UV_PYTHON_INSTALL_DIR: path.join(runtime, "python"),
      UV_NO_PROGRESS: "1",
      UV_PYTHON_DOWNLOADS: "automatic",
    },
  };
}

export function getDetectionStatus(): DetectionStatus {
  const directory = detectionDirectory();
  const preferences = getDetectionPreferences();
  const report = inspectDetectionFolder(directory);
  const job = store[JOB_KEY];
  const current = job && job.directory === directory ? job : null;
  return {
    ...report,
    directory,
    variant: preferences.variant,
    preferences: {
      variant: preferences.variant,
      device: preferences.device,
      confidence: preferences.confidence,
      iou: preferences.iou,
      maxDetections: preferences.maxDetections,
      imageSize: preferences.imageSize,
    },
    catalog: DETECTION_VARIANTS,
    job: current ? {
      phase: current.phase,
      variant: current.variant,
      running: current.running,
      error: current.error,
      ...progressOf(current),
    } : null,
    sizes: {
      runtime: DETECTION_RUNTIME.estimatedBytes,
      textEncoder: DETECTION_TEXT_ENCODER.size,
      variants: Object.fromEntries(DETECTION_VARIANTS.map((variant) => [variant.id, variant.size])) as Record<DetectionVariantId, number>,
    },
  };
}

function progressOf(job: Job) {
  if (job.phase === "runtime" || job.phase === "weights") {
    const download = downloader().progress(downloadDirectory(job));
    if (download) return { downloadedBytes: download.downloadedBytes, totalBytes: download.totalBytes };
  }
  return { downloadedBytes: job.downloadedBytes, totalBytes: job.totalBytes };
}

function downloadDirectory(job: Job) {
  return job.phase === "runtime" ? path.join(runtimePaths(job.directory).runtime, "download") : job.directory;
}

/**
 * Install whatever the variant still needs: the runtime, the text encoder and
 * its weights. Runs in the background; `getDetectionStatus` reports progress.
 */
export function startDetectionSetup(variant: DetectionVariantId) {
  const running = store[JOB_KEY];
  if (running?.running) throw new Error("Libera is already setting up detection. Wait for it to finish.");
  if (!DETECTION_VARIANTS.some((entry) => entry.id === variant)) throw new Error("Unknown model variant.");
  const job: Job = {
    phase: "runtime",
    variant,
    running: true,
    error: "",
    downloadedBytes: 0,
    totalBytes: 0,
    directory: detectionDirectory(),
    controller: new AbortController(),
  };
  store[JOB_KEY] = job;
  void setUp(job).catch((error: unknown) => {
    job.error = job.controller.signal.aborted ? "" : error instanceof Error ? error.message : "Setting up detection failed.";
  }).finally(() => {
    job.running = false;
  });
}

export function cancelDetectionSetup() {
  const job = store[JOB_KEY];
  if (!job?.running) return;
  job.controller.abort();
  downloader().cancel();
}

async function download(job: Job, directory: string, files: ModelDownloadFile[]) {
  await downloader().start(directory, files);
  if (job.controller.signal.aborted) throw new Error("Canceled.");
  const error = downloader().progress(directory)?.error;
  if (error) throw new Error(error);
}

async function setUp(job: Job) {
  const { directory } = job;
  const paths = runtimePaths(directory);
  const report = inspectDetectionFolder(directory);

  if (!report.runtime) {
    const asset = UV_ASSETS[`${process.platform}-${process.arch}`];
    if (!asset) throw new Error(`Detection is not available on ${process.platform} (${process.arch}) yet.`);
    job.phase = "runtime";
    const archiveFolder = path.join(paths.runtime, "download");
    await download(job, archiveFolder, [{
      url: `https://github.com/astral-sh/uv/releases/download/${DETECTION_RUNTIME.uvVersion}/${asset.file}`,
      target: asset.file,
      size: asset.size,
      sha256: asset.sha256,
    }]);
    await rm(paths.uvDirectory, { recursive: true, force: true });
    await mkdir(paths.uvDirectory, { recursive: true });
    // bsdtar reads both .tar.gz and .zip; Windows 10 and later ship it as tar.exe.
    await run(job, "tar", ["-xf", path.join(archiveFolder, asset.file), "-C", paths.uvDirectory]);
    const uv = await findFile(paths.uvDirectory, process.platform === "win32" ? "uv.exe" : "uv");
    if (!uv) throw new Error("The uv download did not contain uv.");

    job.phase = "python";
    job.downloadedBytes = 0;
    job.totalBytes = 0;
    const environment = { ...process.env, ...paths.environment };
    await run(job, uv, ["venv", "--python", DETECTION_RUNTIME.python, "--python-preference", "only-managed", "--clear", paths.venv], environment);

    job.phase = "packages";
    await run(job, uv, ["pip", "install", "--python", paths.python, `ultralytics==${DETECTION_RUNTIME.ultralytics}`, DETECTION_RUNTIME.clip], environment);
    await writeFile(paths.marker, `${JSON.stringify({
      uv: DETECTION_RUNTIME.uvVersion,
      python: DETECTION_RUNTIME.python,
      ultralytics: DETECTION_RUNTIME.ultralytics,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await rm(archiveFolder, { recursive: true, force: true });
  }

  job.phase = "weights";
  const variant = DETECTION_VARIANTS.find((entry) => entry.id === job.variant)!;
  const files: ModelDownloadFile[] = [];
  if (!report.textEncoder) files.push({ url: `${WEIGHTS_RELEASE}/${DETECTION_TEXT_ENCODER.file}`, target: DETECTION_TEXT_ENCODER.file, size: DETECTION_TEXT_ENCODER.size, sha256: null });
  if (!report.variants[variant.id]) files.push({ url: `${WEIGHTS_RELEASE}/${variant.file}`, target: variant.file, size: variant.size, sha256: null });
  if (files.length) await download(job, directory, files);
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

/** Run a setup command, failing with the end of its output. */
function run(job: Job, command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, signal: job.controller.signal });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-4000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => reject(job.controller.signal.aborted ? new Error("Canceled.") : error));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} ${args[0]} failed${output.trim() ? `: ${output.trim().split("\n").slice(-6).join("\n")}` : "."}`));
    });
  });
}
