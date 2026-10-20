import { fork, type ChildProcess } from "node:child_process";
import os from "node:os";
import type { LoudnessEnvelope, SpeakerTurn } from "@/lib/transcription/plan";
import type { AudioDecoder } from "@/lib/transcription/settings";
import { transcriptionThreads, transcriptionWorkerPath } from "@/lib/transcription/settings";
import type { AsrModelFiles, DiarizationModelFiles } from "@/lib/transcription/models";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; onProgress?: (value: number) => void };
type RequestOptions = { signal?: AbortSignal; onProgress?: (value: number) => void };

// The models stay loaded between pieces of a recording and between
// recordings opened soon after; then the worker exits to return its memory.
const IDLE_SHUTDOWN_MS = 2 * 60_000;

export type RecognizedPiece = { text: string; tokens: string[]; timestamps: number[]; durations: number[] };

/**
 * Talks to `electron/transcription-worker.mjs`, a separate Node process that
 * decodes recordings and runs the speech models. It starts on first use and
 * exits when idle.
 */
class TranscriptionWorkerClient {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private config: { threads: number; decoder: AudioDecoder } | null = null;

  /** Another decoder restarts the worker on this request. */
  configure(decoder: AudioDecoder) {
    const config = { threads: transcriptionThreads(), decoder };
    if (JSON.stringify(config) === JSON.stringify(this.config)) return;
    this.stop();
    this.config = config;
  }

  private start() {
    if (this.child) return this.ready!;
    const child = fork(transcriptionWorkerPath(), [], {
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
      child.once("exit", (code, signal) => reject(new Error(`The transcription worker stopped (${signal ?? code}).`)));
    });
    this.ready.catch(() => undefined);

    if (child.pid) {
      try {
        // Below normal, so the app stays smooth during an hour-long recording.
        os.setPriority(child.pid, 10);
      } catch {
        // Lower priority is a courtesy; some systems refuse it.
      }
    }

    child.on("message", (message: { type?: string; id?: number; ok?: boolean; result?: unknown; error?: string; value?: number }) => {
      if (typeof message?.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.type === "progress") {
        if (typeof message.value === "number") pending.onProgress?.(message.value);
        return;
      }
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || "The transcription worker failed."));
      if (!this.pending.size) this.scheduleIdleShutdown();
    });

    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      const error = new Error(signal === "SIGKILL" || code === 137
        ? "The transcription worker ran out of memory. Try a shorter recording, or close other apps."
        : `The transcription worker stopped (${signal ?? code}).`);
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
    const error = new Error("The transcription worker was restarted.");
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

  private async request<T>(type: string, payload: Record<string, unknown>, { signal, onProgress }: RequestOptions = {}): Promise<T> {
    signal?.throwIfAborted();
    if (!this.config) throw new Error("The transcription worker is not configured.");
    const ready = this.start();
    const child = this.child;
    await ready;
    if (child !== this.child || !child?.connected) throw new Error("The transcription worker was restarted.");
    if (this.idleTimer) clearTimeout(this.idleTimer);

    const id = this.nextId++;
    const cancel = () => {
      if (child.connected) child.send({ type: "cancel", target: id });
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await new Promise<T>((resolve, reject) => {
        this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, onProgress });
        child.send({ id, type, ...payload });
      });
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  open(path: string, options?: RequestOptions) {
    return this.request<{ handle: string; duration: number; envelope: LoudnessEnvelope }>("open", { path }, options);
  }

  diarize(handle: string, models: DiarizationModelFiles, speakers: number, options?: RequestOptions) {
    return this.request<{ turns: SpeakerTurn[] }>("diarize", { handle, models, speakers }, options);
  }

  recognize(handle: string, start: number, end: number, model: AsrModelFiles, options?: RequestOptions) {
    return this.request<RecognizedPiece>("recognize", { handle, start, end, model }, options);
  }

  wav(handle: string, start: number, end: number, options?: RequestOptions) {
    return this.request<Uint8Array>("wav", { handle, start, end }, options);
  }

  peaks(path: string, buckets: number, options?: RequestOptions) {
    return this.request<{ duration: number; peaks: number[] }>("peaks", { path, buckets }, options);
  }

  close(handle: string) {
    return this.request<null>("close", { handle }).catch(() => null);
  }
}

const WORKER_KEY = Symbol.for("libera.transcriptionWorker");

export function getTranscriptionWorker() {
  const store = globalThis as { [WORKER_KEY]?: TranscriptionWorkerClient };
  store[WORKER_KEY] ??= new TranscriptionWorkerClient();
  return store[WORKER_KEY];
}
