import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { runtimePaths } from "@/lib/detection/runtime";
import { detectionWorkerPath } from "@/lib/detection/settings";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

// The model and its text embeddings stay loaded between runs on one photo;
// then the worker exits to return PyTorch's memory.
const IDLE_SHUTDOWN_MS = 5 * 60_000;

/** JSON with every non-ASCII character escaped, so the pipe's encoding never matters. */
function asciiJson(value: unknown) {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * Talks to `electron/detection-worker.py`, run by the Python in the detection
 * runtime with the weights folder as its working directory. It starts on
 * first use and exits when idle or when the folder changes.
 */
class DetectionWorkerClient {
  private child: ChildProcess | null = null;
  private directory = "";
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stderr = "";

  private start(directory: string) {
    if (this.child && this.directory === directory) return this.ready!;
    this.stop();
    const paths = runtimePaths(directory);
    const child = spawn(paths.python, ["-I", "-u", detectionWorkerPath()], {
      cwd: directory,
      env: {
        ...process.env,
        YOLO_CONFIG_DIR: paths.config,
        YOLO_AUTOINSTALL: "false",
        YOLO_OFFLINE: "true",
        // Operators Metal lacks fall back to the CPU instead of failing.
        PYTORCH_ENABLE_MPS_FALLBACK: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.directory = directory;
    this.stderr = "";

    this.ready = new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout! });
      lines.on("line", (line) => {
        let message: { id?: number; ok?: boolean; result?: unknown; error?: string };
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message.id === 0) {
          if (message.ok) resolve();
          else reject(new Error(message.error || "The detection runtime could not start."));
          return;
        }
        const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
        if (!pending) return;
        this.pending.delete(message.id!);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(message.error || "Detection failed."));
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4000);
      });
      child.once("error", (error) => reject(error));
      child.once("exit", (code, signal) => {
        const detail = this.stderr.trim().split("\n").slice(-3).join(" ");
        const error = new Error(`The detection worker stopped (${signal ?? code})${detail ? `: ${detail}` : "."}`);
        reject(error);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
      });
    });
    this.ready.catch(() => undefined);
    return this.ready;
  }

  stop() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }

  async request<T>(directory: string, body: Record<string, unknown>): Promise<T> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      await this.start(directory);
      const id = this.nextId++;
      return await new Promise<T>((resolve, reject) => {
        this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        this.child!.stdin!.write(`${asciiJson({ ...body, id })}\n`);
      });
    } finally {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.stop(), IDLE_SHUTDOWN_MS);
      this.idleTimer.unref?.();
    }
  }
}

/** One worker for the whole server, surviving hot reloads. */
export function getDetectionWorker() {
  const store = globalThis as { [key: symbol]: DetectionWorkerClient | undefined };
  const key = Symbol.for("libera.detection.worker");
  store[key] ??= new DetectionWorkerClient();
  return store[key];
}
