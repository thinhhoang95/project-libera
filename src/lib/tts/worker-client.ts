import { fork, type ChildProcess } from "node:child_process";
import os from "node:os";
import type { KokoroModelFiles } from "@/lib/tts/kokoro";
import { ttsThreads, ttsWorkerPath } from "@/lib/tts/settings";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

// Kokoro stays loaded while a passage is read and between passages read soon
// after; then the worker exits to return its memory.
const IDLE_SHUTDOWN_MS = 2 * 60_000;

/**
 * Talks to `electron/tts-worker.mjs`, a separate Node process that runs Kokoro
 * through sherpa-onnx. It starts on first use and exits when idle.
 */
class TtsWorkerClient {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private start() {
    if (this.child) return this.ready!;
    const child = fork(ttsWorkerPath(), [], {
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
      child.once("exit", (code, signal) => reject(new Error(`The read-aloud worker stopped (${signal ?? code}).`)));
    });
    this.ready.catch(() => undefined);

    if (child.pid) {
      try {
        // Slightly below normal: speech should keep up, but the editor comes first.
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
      else pending.reject(new Error(message.error || "The read-aloud worker failed."));
      if (!this.pending.size) this.scheduleIdleShutdown();
    });

    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      const error = new Error(signal === "SIGKILL" || code === 137
        ? "The read-aloud worker ran out of memory. Close other apps and try again."
        : `The read-aloud worker stopped (${signal ?? code}).`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });

    child.send({ id: 0, type: "configure", config: { threads: ttsThreads() } });
    return this.ready;
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!child) return;
    const error = new Error("The read-aloud worker was restarted.");
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

  async synthesize(model: KokoroModelFiles, text: string, sid: number, speed: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const ready = this.start();
    const child = this.child;
    await ready;
    if (child !== this.child || !child?.connected) throw new Error("The read-aloud worker was restarted.");
    if (this.idleTimer) clearTimeout(this.idleTimer);

    const id = this.nextId++;
    const cancel = () => {
      if (child.connected) child.send({ type: "cancel", target: id });
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await new Promise<Uint8Array>((resolve, reject) => {
        this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        child.send({ id, type: "synthesize", model, text, sid, speed });
      });
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }
}

const WORKER_KEY = Symbol.for("libera.ttsWorker");

export function getTtsWorker() {
  const store = globalThis as { [WORKER_KEY]?: TtsWorkerClient };
  store[WORKER_KEY] ??= new TtsWorkerClient();
  return store[WORKER_KEY];
}
