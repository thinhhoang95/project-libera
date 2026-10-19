// Local snapshots and log compaction (collaboration map §11 D6, plan M1.10).
//
// Every 500 updates or 1 MB of log per sub-document, the host writes a
// snapshot covering every update up to a local_seq, then deletes only the
// ACKED updates it covers. Unacked updates stay in the log, and outbound
// batches keep their own bytes, so a compaction never changes what is resent.
//
// The work is split so no single event-loop task is long: rows are read in
// small chunks, the merge runs in a worker thread, and deletes are chunked.
// Each synchronous step is timed and reported in CompactionStats.

import { Worker } from "node:worker_threads";

import type { Subdoc } from "../../../src/lib/collab/protocol/roles";
import type { Logger } from "./clock";
import { Emitter, yieldToLoop } from "./clock";
import {
  COMPACTION_WORKER_FILE,
  COMPACTION_WORKER_MARK,
  mergeState,
  type MergeRequest,
  type MergeResponse,
} from "./compaction-worker";
import { SNAPSHOT_PART_BYTES, splitParts, type HostStore } from "./store";

export interface CompactionTarget {
  readonly docId: string;
  /** Changes whenever the sub-document's local state is replaced (reject rollback). */
  generation(subdoc: Subdoc): number;
  /** Highest local_seq persisted for the sub-document. */
  lastPersistedSeq(subdoc: Subdoc): number;
  /** Called after a snapshot covering `uptoLocalSeq` is committed. */
  compacted(subdoc: Subdoc, uptoLocalSeq: number): void;
}

export interface CompactionStats {
  docId: string;
  subdoc: Subdoc;
  uptoLocalSeq: number;
  rowsMerged: number;
  inputBytes: number;
  stateBytes: number;
  deletedRows: number;
  /** Longest synchronous main-thread step, in ms, and which step it was. */
  maxMainTaskMs: number;
  slowestStep: string;
  mergeMs: number;
  totalMs: number;
  mode: "worker" | "inline";
}

export interface CompactorOptions {
  store: HostStore;
  logger: Logger;
  /** "worker" (default) merges in a worker thread; "inline" merges in setImmediate slices. */
  mode?: "worker" | "inline";
  updatesThreshold?: number;
  bytesThreshold?: number;
  readChunkRows?: number;
  deleteChunkRows?: number;
  /** Size of each snapshot part commit. */
  partBytes?: number;
  workerFactory?: () => Worker;
}

const nodeRequire = eval("require") as NodeRequire;

function defaultWorkerFactory(): Worker {
  const workerData = { mark: COMPACTION_WORKER_MARK };
  if (/\.[cm]?tsx?$/.test(COMPACTION_WORKER_FILE)) {
    // Running from TypeScript sources (tests): Worker cannot load .ts by
    // itself, so bootstrap tsx's CommonJS hook first.
    const tsx = nodeRequire.resolve("tsx/cjs");
    return new Worker(`require(${JSON.stringify(tsx)}); require(${JSON.stringify(COMPACTION_WORKER_FILE)});`, {
      eval: true,
      workerData,
    });
  }
  return new Worker(COMPACTION_WORKER_FILE, { workerData });
}

class MergeWorker {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (value: MergeResponse) => void; reject: (error: Error) => void }>();

  constructor(private readonly factory: () => Worker) {}

  merge(base: Uint8Array | null, updates: Uint8Array[]): Promise<MergeResponse> {
    const worker = this.ensure();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      const request: MergeRequest = { id, base, updates };
      worker.postMessage(request);
      // A worker with work in flight must keep the process alive.
      worker.ref();
    });
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = this.factory();
    worker.unref();
    worker.on("message", (response: MergeResponse) => {
      const waiter = this.waiting.get(response.id);
      this.waiting.delete(response.id);
      if (this.waiting.size === 0) worker.unref();
      waiter?.resolve(response);
    });
    const fail = (error: Error) => {
      for (const waiter of this.waiting.values()) waiter.reject(error);
      this.waiting.clear();
      if (this.worker === worker) this.worker = null;
    };
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`Compaction worker exited with code ${code}`)));
    this.worker = worker;
    return worker;
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }
}

export class Compactor {
  readonly updatesThreshold: number;
  readonly bytesThreshold: number;
  private readonly store: HostStore;
  private readonly logger: Logger;
  private mode: "worker" | "inline";
  private readonly readChunkRows: number;
  private readonly deleteChunkRows: number;
  private readonly partBytes: number;
  private readonly worker: MergeWorker;
  private readonly jobs = new Map<string, Promise<CompactionStats | null>>();
  private readonly emitter = new Emitter<CompactionStats>();
  private closed = false;

  constructor(options: CompactorOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.mode = options.mode ?? "worker";
    this.updatesThreshold = options.updatesThreshold ?? 500;
    this.bytesThreshold = options.bytesThreshold ?? 1024 * 1024;
    this.readChunkRows = options.readChunkRows ?? 128;
    this.deleteChunkRows = options.deleteChunkRows ?? 500;
    this.partBytes = options.partBytes ?? SNAPSHOT_PART_BYTES;
    this.worker = new MergeWorker(options.workerFactory ?? defaultWorkerFactory);
  }

  shouldCompact(tailCount: number, tailBytes: number): boolean {
    return tailCount >= this.updatesThreshold || tailBytes >= this.bytesThreshold;
  }

  onCompacted(listener: (stats: CompactionStats) => void): () => void {
    return this.emitter.on(listener);
  }

  /** Schedules a compaction; a second call while one is queued or running returns the same job. */
  schedule(target: CompactionTarget, subdoc: Subdoc): Promise<CompactionStats | null> {
    const key = `${target.docId}\u0000${subdoc}`;
    const existing = this.jobs.get(key);
    if (existing) return existing;
    const job = this.run(target, subdoc)
      .catch((error) => {
        this.logger.error(`Compaction failed for ${target.docId}/${subdoc}`, error);
        return null;
      })
      .finally(() => {
        if (this.jobs.get(key) === job) this.jobs.delete(key);
      });
    this.jobs.set(key, job);
    return job;
  }

  /** Resolves when no compaction for `docId` (or any doc) is queued or running. */
  async whenIdle(docId?: string): Promise<void> {
    for (;;) {
      const pending = [...this.jobs.entries()]
        .filter(([key]) => docId === undefined || key.startsWith(`${docId}\u0000`))
        .map(([, job]) => job);
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  async close(): Promise<void> {
    await this.whenIdle();
    this.closed = true;
    await this.worker.close();
  }

  private async run(target: CompactionTarget, subdoc: Subdoc): Promise<CompactionStats | null> {
    const started = performance.now();
    let maxMainTaskMs = 0;
    let slowestStep = "";
    const timed = <T>(step: string, fn: () => T): T => {
      const begin = performance.now();
      try {
        return fn();
      } finally {
        const elapsed = performance.now() - begin;
        if (elapsed > maxMainTaskMs) {
          maxMainTaskMs = elapsed;
          slowestStep = step;
        }
      }
    };
    const docId = target.docId;

    // Leave the caller's task (the update that crossed the threshold) first.
    await yieldToLoop();
    if (this.closed || this.store.isClosed) return null;
    const generation = target.generation(subdoc);
    const { upto, base } = timed("plan", () => {
      const snapshot = this.store.latestSnapshot(docId, subdoc);
      return { upto: target.lastPersistedSeq(subdoc), base: snapshot };
    });
    const after = base?.uptoLocalSeq ?? 0;
    if (upto <= after) return null;

    const updates: Uint8Array[] = [];
    let inputBytes = 0;
    let cursor = after;
    for (;;) {
      if (this.store.isClosed || target.generation(subdoc) !== generation) return null;
      const rows = timed("read", () => this.store.updatesInRange(docId, subdoc, cursor, upto, this.readChunkRows));
      if (rows.length === 0) break;
      for (const row of rows) {
        updates.push(row.update);
        inputBytes += row.update.length;
      }
      cursor = rows[rows.length - 1].localSeq;
      await yieldToLoop();
    }

    const merged = await this.merge(base?.state ?? null, updates, timed);
    if (this.store.isClosed || target.generation(subdoc) !== generation) return null;
    // Parts are separate small commits; the snapshot becomes visible only
    // when its row is committed, so a crash in between changes nothing.
    const parts = splitParts(merged.state, this.partBytes);
    for (let index = 0; index < parts.length; index += 1) {
      if (this.store.isClosed || target.generation(subdoc) !== generation) return null;
      timed("write-part", () => this.store.writeSnapshotPart(docId, subdoc, upto, index, parts[index]));
      await yieldToLoop();
    }
    if (this.store.isClosed || target.generation(subdoc) !== generation) return null;
    timed("commit-snapshot", () =>
      this.store.commitSnapshot(docId, subdoc, upto, merged.stateVector, merged.state.length, parts.length),
    );

    let deletedRows = 0;
    for (;;) {
      await yieldToLoop();
      if (this.store.isClosed) break;
      const deleted = timed("delete", () => this.store.deleteAckedCovered(docId, subdoc, upto, this.deleteChunkRows));
      deletedRows += deleted;
      if (deleted < this.deleteChunkRows) break;
    }
    if (!this.store.isClosed) target.compacted(subdoc, upto);

    const stats: CompactionStats = {
      docId,
      subdoc,
      uptoLocalSeq: upto,
      rowsMerged: updates.length,
      inputBytes,
      stateBytes: merged.state.length,
      deletedRows,
      maxMainTaskMs,
      slowestStep,
      mergeMs: merged.ms,
      totalMs: performance.now() - started,
      mode: merged.mode,
    };
    this.emitter.emit(stats);
    return stats;
  }

  private async merge(
    base: Uint8Array | null,
    updates: Uint8Array[],
    timed: <T>(step: string, fn: () => T) => T,
  ): Promise<{ state: Uint8Array; stateVector: Uint8Array; ms: number; mode: "worker" | "inline" }> {
    if (this.mode === "worker") {
      try {
        const response = await this.worker.merge(base, updates);
        if (response.ok) return { state: response.state, stateVector: response.stateVector, ms: response.ms, mode: "worker" };
        throw new Error(response.error);
      } catch (error) {
        // A worker that cannot start (packaging, sandbox) must not stop
        // compaction; inline merging is slower but still correct.
        this.logger.warn("Compaction worker unavailable; merging inline", error);
        this.mode = "inline";
      }
    }
    const begin = performance.now();
    // Inline fallback: merge in slices so most steps stay short; the final
    // encode is one step and is the part the worker exists to avoid.
    let state = base;
    const slice = 64;
    for (let index = 0; index < updates.length; index += slice) {
      const chunk = updates.slice(index, index + slice);
      state = timed("inline-merge", () => mergeState(state, chunk).state);
      await yieldToLoop();
    }
    const result = timed("inline-encode", () => mergeState(state, []));
    return { ...result, ms: performance.now() - begin, mode: "inline" };
  }
}
