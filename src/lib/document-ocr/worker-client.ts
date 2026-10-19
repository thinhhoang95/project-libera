import { fork, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { DocumentOcrDtype } from "@/lib/document-ocr/model";

export type DocumentOcrResult = {
  doctags: string;
  tokens: number;
  stopped: "eos" | "length" | "loop" | "cancelled";
  ms: number;
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

// Reading is something the user waits for, so the model stays loaded for a
// while between snips or pages, then the worker exits to return its memory.
const IDLE_SHUTDOWN_MS = 3 * 60_000;

/** The worker script: Electron passes its location; `next dev` and `next start` run from the project. */
export function documentOcrWorkerPath() {
  return process.env.LIBERA_DOCUMENT_OCR_WORKER_PATH
    || path.join(/*turbopackIgnore: true*/ process.cwd(), "electron", "document-ocr-worker.mjs");
}

/** Up to four threads, leaving the rest of the computer responsive while a page is read. */
export function documentOcrThreads() {
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, cores - 2));
}

/**
 * Talks to `electron/document-ocr-worker.mjs`, a separate Node process that
 * runs granite-docling. It starts on first use and exits when idle.
 */
class DocumentOcrWorkerClient {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private config: { modelDirectory: string; dtype: DocumentOcrDtype; threads: number } | null = null;

  /** A different folder or set of weights restarts the worker on this request. */
  private configure(modelDirectory: string, dtype: DocumentOcrDtype) {
    const config = { modelDirectory, dtype, threads: documentOcrThreads() };
    if (JSON.stringify(config) === JSON.stringify(this.config)) return;
    this.stop();
    this.config = config;
  }

  private start() {
    if (this.child) return this.ready!;

    const child = fork(documentOcrWorkerPath(), [], {
      execPath: process.execPath,
      // Electron's binary behaves as Node with this; plain Node ignores it.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    this.child = child;

    this.ready = new Promise<void>((resolve, reject) => {
      const onReady = (message: unknown) => {
        if ((message as { type?: string })?.type !== "ready") return;
        child.off("message", onReady);
        resolve();
      };
      child.on("message", onReady);
      child.once("error", reject);
      child.once("exit", (code, signal) => reject(new Error(`The PDF reading worker stopped (${signal ?? code}).`)));
    });
    this.ready.catch(() => undefined);

    if (child.pid) {
      try {
        // Slightly below normal, so typing and scrolling stay smooth.
        os.setPriority(child.pid, 5);
      } catch {
        // Lower priority is a courtesy; some systems refuse it.
      }
    }

    child.on("message", (message: { id?: number; ok?: boolean; result?: unknown; error?: string }) => {
      if (typeof message?.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || "The PDF reading worker failed."));
    });

    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      const error = new Error(`The PDF reading worker stopped (${signal ?? code}).`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });

    child.send({ id: 0, type: "configure", config: this.config });
    return this.ready;
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!child) return;
    const error = new Error("The PDF reading worker was restarted.");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    child.disconnect?.();
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }, 2_000).unref();
  }

  private scheduleIdleShutdown() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.pending.size) this.stop();
    }, IDLE_SHUTDOWN_MS);
    this.idleTimer.unref?.();
  }

  async convert(
    image: Uint8Array,
    model: { directory: string; dtype: DocumentOcrDtype },
    { maxNewTokens, maxEdge, signal }: { maxNewTokens?: number; maxEdge?: number; signal?: AbortSignal } = {},
  ) {
    signal?.throwIfAborted();
    this.configure(model.directory, model.dtype);
    const ready = this.start();
    const child = this.child;
    await ready;
    if (child !== this.child || !child?.connected) throw new Error("The PDF reading worker was restarted.");
    if (this.idleTimer) clearTimeout(this.idleTimer);

    const id = this.nextId++;
    const cancel = () => {
      if (child.connected) child.send({ type: "cancel", target: id });
    };
    signal?.addEventListener("abort", cancel, { once: true });

    try {
      return await new Promise<DocumentOcrResult>((resolve, reject) => {
        this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        child.send({ type: "convert", id, image, maxNewTokens, maxEdge });
      });
    } finally {
      signal?.removeEventListener("abort", cancel);
      this.scheduleIdleShutdown();
    }
  }
}

const WORKER_KEY = Symbol.for("libera.documentOcrWorker");

/** One worker per server process, kept across development reloads. */
export function getDocumentOcrWorker() {
  const store = globalThis as { [WORKER_KEY]?: DocumentOcrWorkerClient };
  store[WORKER_KEY] ??= new DocumentOcrWorkerClient();
  return store[WORKER_KEY];
}
