import { fork, type ChildProcess } from "node:child_process";
import os from "node:os";
import { searchWorkerPath, searchWorkerThreads, type SearchPreferences } from "@/lib/search/settings";

export type EmbedImage = { path: string } | { data: Uint8Array };
export type EmbedInput = { text?: string; images?: EmbedImage[] };
export type PdfTextItem = { str: string; hasEOL: boolean };

type WorkerConfig = {
  textWeights: string;
  visionWeights: string;
  threads: number;
  visionTokens: number;
};

type ModelInfo = { textDtype: string; visionDtype: string | null; vision: boolean; loadMs: number };

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

// The worker exits after this long without requests, returning its memory.
const IDLE_SHUTDOWN_MS = 5 * 60_000;
// A failed model load is retried after this long, or at once when preferences change.
const LOAD_RETRY_MS = 60_000;

/**
 * Talks to `electron/search-worker.mjs`, a separate Node process that runs the
 * embedding model and parses PDFs. It starts on first use and exits when idle.
 */
class SearchWorkerClient {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private config: WorkerConfig = { textWeights: "", visionWeights: "", threads: 1, visionTokens: 140 };
  private configKey = "";
  private loadPromise: Promise<ModelInfo> | null = null;
  private loadFailedAt = 0;

  /** When a search last asked for an embedding; indexing waits while someone is searching. */
  lastQueryAt = 0;
  modelState: "idle" | "loading" | "ready" | "error" = "idle";
  modelError = "";
  modelInfo: ModelInfo | null = null;

  /** Apply Preferences → Search; a change restarts the worker on its next request. Returns whether anything changed. */
  configure(preferences: SearchPreferences) {
    const config: WorkerConfig = {
      textWeights: preferences.textWeights,
      visionWeights: preferences.visionWeights,
      threads: searchWorkerThreads(),
      visionTokens: preferences.visionTokens,
    };
    const key = JSON.stringify(config);
    if (key === this.configKey) return false;

    const changed = Boolean(this.configKey);
    this.config = config;
    this.configKey = key;
    this.stop();
    this.modelState = "idle";
    this.modelError = "";
    this.modelInfo = null;
    this.loadFailedAt = 0;
    return changed;
  }

  get configured() {
    return Boolean(this.config.textWeights);
  }

  get visionConfigured() {
    return Boolean(this.config.textWeights && this.config.visionWeights);
  }

  private start() {
    if (this.child) return this.ready!;

    const child = fork(searchWorkerPath(), [], {
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
      child.once("exit", (code, signal) => reject(new Error(`The search worker stopped (${signal ?? code}).`)));
    });
    // Unhandled when nobody is waiting yet.
    this.ready.catch(() => undefined);

    if (child.pid) {
      try {
        os.setPriority(child.pid, 10);
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
      else pending.reject(new Error(message.error || "The search worker failed."));
    });

    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      this.loadPromise = null;
      if (this.modelState === "ready" || this.modelState === "loading") this.modelState = "idle";
      const error = new Error(`The search worker stopped (${signal ?? code}).`);
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
    this.loadPromise = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!child) return;
    const error = new Error("The search worker was restarted.");
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
      if (!this.pending.size) {
        this.stop();
        if (this.modelState !== "error") this.modelState = "idle";
      }
    }, IDLE_SHUTDOWN_MS);
    this.idleTimer.unref?.();
  }

  private async request<T>(message: Record<string, unknown>): Promise<T> {
    await this.start();
    const child = this.child;
    if (!child?.connected) throw new Error("The search worker is not running.");
    if (this.idleTimer) clearTimeout(this.idleTimer);

    const id = this.nextId++;
    try {
      return await new Promise<T>((resolve, reject) => {
        this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        child.send({ ...message, id });
      });
    } finally {
      this.scheduleIdleShutdown();
    }
  }

  /** Load the model once; failures are remembered so indexing does not retry in a loop. */
  async ensureModel() {
    if (!this.configured) {
      throw new Error("Choose the EmbeddingGemma 2 text model weights in Preferences → Search.");
    }
    if (this.modelState === "error" && Date.now() - this.loadFailedAt < LOAD_RETRY_MS) {
      throw new Error(this.modelError);
    }

    this.loadPromise ??= (async () => {
      this.modelState = "loading";
      try {
        const info = await this.request<ModelInfo>({ type: "load" });
        this.modelInfo = info;
        this.modelState = "ready";
        this.modelError = "";
        return info;
      } catch (error) {
        this.loadPromise = null;
        this.modelState = "error";
        this.modelError = error instanceof Error ? error.message : "Could not load the embedding model.";
        this.loadFailedAt = Date.now();
        throw error;
      }
    })();

    return this.loadPromise;
  }

  async embed(inputs: EmbedInput[], priority: "query" | "index") {
    if (priority === "query") this.lastQueryAt = Date.now();
    await this.ensureModel();
    return this.request<Float32Array[]>({ type: "embed", inputs, priority });
  }

  pdfText(filePath: string, from: number, to: number) {
    return this.request<{ numPages: number; pages: Array<{ pageNumber: number; items: PdfTextItem[] }> }>({
      type: "pdf-text",
      path: filePath,
      from,
      to,
    });
  }

  closePdf(filePath: string) {
    return this.request<boolean>({ type: "pdf-close", path: filePath }).catch(() => false);
  }
}

const WORKER_KEY = Symbol.for("libera.searchWorker");

/** One worker per server process, kept across development reloads. */
export function getSearchWorker() {
  const store = globalThis as { [WORKER_KEY]?: SearchWorkerClient };
  store[WORKER_KEY] ??= new SearchWorkerClient();
  return store[WORKER_KEY];
}
