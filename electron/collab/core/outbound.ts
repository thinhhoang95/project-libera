// Outbound queue for one document (source plan §4, collaboration map §7.1).
//
// Local updates are already committed to `updates` when they get here. The
// queue groups them into batches: within batchWindowMs, consecutive updates of
// one sub-document with the same provenance are merged with Y.mergeUpdates,
// up to batchMaxBytes. Each batch gets the doc's next clientSeq, and the
// merged bytes and covered local_seqs are persisted in the same transaction
// as the clientSeq allocation. A resend after reconnect therefore reuses the
// same clientSeq and the same bytes, which is what the server dedupes on.
//
// Batches are only formed while the doc is open on the server. Offline edits
// stay unbatched in the log, so a reconnect merges them into few batches.

import * as Y from "yjs";

import type { Provenance } from "../../../src/lib/collab/protocol/actor";
import { MessageType, type UpdateMessage } from "../../../src/lib/collab/protocol/messages";
import type { Subdoc } from "../../../src/lib/collab/protocol/roles";
import { SyncLimits } from "../../../src/lib/collab/protocol/version";
import type { Clock, Logger, TimerHandle } from "./clock";
import type { HostStore, OutboundBatch } from "./store";

export interface OutboundTransport {
  /** Sends an update frame; returns false when the socket is not writable. */
  send(message: UpdateMessage): boolean;
}

export interface OutboundLimits {
  batchWindowMs: number;
  batchMaxBytes: number;
  /** Largest single update the server accepts; bigger ones can never be sent. */
  maxUpdateBytes?: number;
  /** At most this many batches are written to a connection before an ack frees room. */
  maxOutstandingBatches?: number;
  /** At most this many unacknowledged bytes are in flight (one batch may exceed it alone). */
  maxOutstandingBytes?: number;
}

/** An update that exceeds the server's per-update limit and so can never be sent. */
export interface UnsendableUpdate {
  subdoc: Subdoc;
  bytes: number;
  limit: number;
}

const DEFAULT_MAX_OUTSTANDING_BATCHES = 32;
const DEFAULT_MAX_OUTSTANDING_BYTES = 4 * 1024 * 1024;
/** A resend of the oldest outstanding batch waits this long without any acknowledgement progress. */
const ACK_TIMEOUT_MS = 15_000;

export interface OutboundOptions {
  docId: string;
  store: HostStore;
  clock: Clock;
  limits: OutboundLimits;
  logger: Logger;
  /** Time slice for forming batches before yielding to the event loop. */
  sliceMs?: number;
  /** Called once per update that is too large to send; it is skipped, not retried. */
  onUnsendable?: (update: UnsendableUpdate) => void;
}

interface PendingEntry {
  localSeq: number;
  subdoc: Subdoc;
  update: Uint8Array;
  provenance?: Provenance;
  provenanceKey: string;
}

function provenanceKey(provenance: Provenance | undefined): string {
  return provenance ? JSON.stringify(provenance) : "";
}

/**
 * Extends a server state vector with the struct ranges of updates we are
 * about to (re)send, so the "what the server lacks" diff does not repeat
 * them. A range only counts when it starts at or before the known clock.
 */
export function extendStateVector(stateVector: Uint8Array, updates: readonly Uint8Array[]): Uint8Array {
  const known = Y.decodeStateVector(stateVector);
  const ranges = updates.map((update) => Y.parseUpdateMeta(update));
  let changed = true;
  while (changed) {
    changed = false;
    for (const range of ranges) {
      for (const [client, from] of range.from) {
        const to = range.to.get(client) ?? from;
        const clock = known.get(client) ?? 0;
        if (from <= clock && to > clock) {
          known.set(client, to);
          changed = true;
        }
      }
    }
  }
  return Y.encodeStateVector(known);
}

/** True when an update carries structs (not just a delete set). */
export function hasStructs(update: Uint8Array): boolean {
  return Y.parseUpdateMeta(update).to.size > 0;
}

export class OutboundQueue {
  readonly docId: string;
  private readonly store: HostStore;
  private readonly clock: Clock;
  private readonly limits: OutboundLimits;
  private readonly logger: Logger;
  private readonly sliceMs: number;
  private readonly onUnsendable: ((update: UnsendableUpdate) => void) | undefined;
  private readonly unbatched = new Map<Subdoc, PendingEntry[]>();
  private batches: OutboundBatch[];
  private transport: OutboundTransport | null = null;
  /** clientSeqs already written to the current connection. */
  private sent = new Set<number>();
  private sentAt = new Map<number, number>();
  private lastProgressAt = 0;
  private forceRetry = false;
  private readonly reportedUnsendable = new Set<string>();
  private timer: TimerHandle | null = null;
  private forming = false;
  private epoch = 0;
  private disposed = false;
  private retryTimer: TimerHandle | null = null;
  private retryAt: number | null = null;
  private retryAttempt = 0;

  constructor(options: OutboundOptions) {
    this.docId = options.docId;
    this.store = options.store;
    this.clock = options.clock;
    this.limits = options.limits;
    this.logger = options.logger;
    this.sliceMs = options.sliceMs ?? 6;
    this.onUnsendable = options.onUnsendable;
    this.batches = this.store.outboundBatches(this.docId);
    for (const row of this.store.unbatchedUpdates(this.docId)) {
      const provenance = row.origin?.kind === "local" ? row.origin.provenance : undefined;
      this.pushEntry({ localSeq: row.localSeq, subdoc: row.subdoc, update: row.update, provenance, provenanceKey: provenanceKey(provenance) });
    }
  }

  private pushEntry(entry: PendingEntry): void {
    let queue = this.unbatched.get(entry.subdoc);
    if (!queue) {
      queue = [];
      this.unbatched.set(entry.subdoc, queue);
    }
    queue.push(entry);
  }

  /** Number of batches awaiting ack. */
  get batchCount(): number {
    return this.batches.length;
  }

  get unbatchedCount(): number {
    let count = 0;
    for (const queue of this.unbatched.values()) count += queue.length;
    return count;
  }

  /** A copy of the batches awaiting ack, in clientSeq order. */
  pendingBatches(): OutboundBatch[] {
    return this.batches.map((batch) => ({ ...batch, localSeqs: [...batch.localSeqs] }));
  }

  hasBatch(clientSeq: number): boolean {
    return this.batches.some((batch) => batch.clientSeq === clientSeq);
  }

  batchFor(clientSeq: number): OutboundBatch | null {
    return this.batches.find((batch) => batch.clientSeq === clientSeq) ?? null;
  }

  /** A committed local update. */
  enqueue(subdoc: Subdoc, localSeq: number, update: Uint8Array, provenance?: Provenance): void {
    if (this.disposed) return;
    this.pushEntry({ localSeq, subdoc, update, provenance, provenanceKey: provenanceKey(provenance) });
    if (this.transport && !this.timer && !this.forming) {
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        void this.formAndSend();
      }, this.limits.batchWindowMs);
    }
  }

  /**
   * The doc became writable on the current connection (or stopped being:
   * transport null). Starting resends every batch not yet written to this
   * connection, then batches the backlog, then sends `missing` (what the
   * server lacks beyond the queue) as one more batch.
   */
  async start(
    transport: OutboundTransport,
    serverStateVectors?: ReadonlyMap<Subdoc, Uint8Array>,
    encodeMissing?: (subdoc: Subdoc, knownStateVector: Uint8Array) => Uint8Array,
  ): Promise<void> {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.transport = transport;
    this.epoch += 1;
    const epoch = this.epoch;
    this.sendUnsent();
    await this.formAndSend();
    if (epoch !== this.epoch || this.transport !== transport || !serverStateVectors || !encodeMissing) return;
    for (const [subdoc, serverStateVector] of serverStateVectors) {
      const known = extendStateVector(serverStateVector, [
        ...this.batches.filter((batch) => batch.subdoc === subdoc).map((batch) => batch.update),
        ...(this.unbatched.get(subdoc) ?? []).map((entry) => entry.update),
      ]);
      const update = encodeMissing(subdoc, known);
      if (!hasStructs(update)) continue;
      if (this.tooLarge(subdoc, update.length, `missing:${subdoc}`)) continue;
      const batch = this.store.createBatch(this.docId, subdoc, [], update);
      this.batches.push(batch);
      this.sendBatch(batch);
    }
  }

  /** The socket dropped or the doc stopped being writable. */
  stop(): void {
    this.transport = null;
    this.epoch += 1;
    this.sent.clear();
    this.sentAt.clear();
    this.forceRetry = false;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.clearRetry();
    this.retryAttempt = 0;
  }

  /** An explicit transient error must make progress even while pings succeed. */
  retry(): void {
    this.forceRetry = true;
    this.scheduleRetry(Math.min(30_000, 1000 * 2 ** Math.min(this.retryAttempt, 5)));
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAt = null;
  }

  private scheduleRetry(delayMs = 15_000): void {
    if (this.disposed || !this.transport || this.batches.length === 0) return;
    const at = this.clock.now() + delayMs;
    if (this.retryAt !== null && this.retryAt <= at) return;
    this.clearRetry();
    this.retryAt = at;
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null;
      this.retryAt = null;
      if (!this.transport || this.disposed) return;
      this.retryAttempt += 1;
      // The bytes and clientSeq remain persisted and unchanged. Resends are
      // idempotent both after a lost ack and after a failed server commit.
      if (this.forceRetry) {
        // The server reported a transient error: resend the (bounded) window.
        this.forceRetry = false;
        this.sent.clear();
        this.sentAt.clear();
      } else {
        // Otherwise only the oldest outstanding batch, and only when no
        // acknowledgement arrived for a full timeout (progress resets this).
        const oldest = this.batches.find((batch) => this.sent.has(batch.clientSeq));
        const lastActivity = Math.max(this.lastProgressAt, oldest ? this.sentAt.get(oldest.clientSeq) ?? 0 : 0);
        if (oldest && this.clock.now() - lastActivity >= ACK_TIMEOUT_MS) {
          this.sent.delete(oldest.clientSeq);
          this.sentAt.delete(oldest.clientSeq);
        }
      }
      this.sendUnsent();
      this.scheduleRetry(Math.min(30_000, 1000 * 2 ** Math.min(this.retryAttempt, 5)));
    }, delayMs);
  }

  get active(): boolean {
    return this.transport !== null;
  }

  /** Forms batches from everything unbatched now (tests, flush on close). */
  async flush(): Promise<void> {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    await this.formAndSend();
  }

  private async formAndSend(): Promise<void> {
    if (this.forming || this.disposed || !this.transport) return;
    this.forming = true;
    const epoch = this.epoch;
    try {
      let sliceStart = performance.now();
      while (!this.disposed && epoch === this.epoch) {
        const batch = this.formOne();
        if (!batch) break;
        this.batches.push(batch);
        this.sendBatch(batch);
        if (performance.now() - sliceStart > this.sliceMs) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          sliceStart = performance.now();
        }
      }
    } catch (error) {
      this.logger.error(`Could not form outbound batch for ${this.docId}`, error);
    } finally {
      this.forming = false;
    }
    // Updates that arrived while forming wait for the next window.
    if (!this.disposed && this.transport && this.unbatchedCount > 0 && !this.timer) {
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        void this.formAndSend();
      }, this.limits.batchWindowMs);
    }
  }

  /** Takes the oldest group of mergeable updates and persists it as a batch. */
  private formOne(): OutboundBatch | null {
    let subdoc: Subdoc | null = null;
    let oldest = Infinity;
    for (const [candidate, queue] of this.unbatched) {
      if (queue.length > 0 && queue[0].localSeq < oldest) {
        oldest = queue[0].localSeq;
        subdoc = candidate;
      }
    }
    if (!subdoc) return null;
    const queue = this.unbatched.get(subdoc) as PendingEntry[];
    while (queue.length > 0 && this.tooLarge(subdoc, queue[0].update.length, `local:${queue[0].localSeq}`)) queue.shift();
    if (queue.length === 0) return this.formOne();
    const first = queue[0];
    const group: PendingEntry[] = [first];
    let bytes = first.update.length;
    for (let index = 1; index < queue.length; index += 1) {
      const entry = queue[index];
      if (entry.provenanceKey !== first.provenanceKey) break;
      if (bytes + entry.update.length > this.limits.batchMaxBytes) break;
      group.push(entry);
      bytes += entry.update.length;
    }
    const merged = group.length === 1 ? first.update : Y.mergeUpdates(group.map((entry) => entry.update));
    const batch = this.store.createBatch(
      this.docId,
      subdoc,
      group.map((entry) => entry.localSeq),
      merged,
      first.provenance,
    );
    queue.splice(0, group.length);
    return batch;
  }

  /** Reports an update over the server limit once; the caller skips it. */
  private tooLarge(subdoc: Subdoc, bytes: number, key: string): boolean {
    const limit = this.limits.maxUpdateBytes ?? SyncLimits.maxUpdateBytes;
    if (bytes <= limit) return false;
    if (!this.reportedUnsendable.has(key)) {
      this.reportedUnsendable.add(key);
      this.logger.error(`An update of ${bytes} bytes for ${this.docId}/${subdoc} exceeds the ${limit}-byte limit and cannot be synced.`);
      this.onUnsendable?.({ subdoc, bytes, limit });
    }
    return true;
  }

  /** Writes unsent batches in clientSeq order while the outstanding window has room. */
  private sendUnsent(): void {
    if (!this.transport) return;
    const maxBatches = this.limits.maxOutstandingBatches ?? DEFAULT_MAX_OUTSTANDING_BATCHES;
    const maxBytes = this.limits.maxOutstandingBytes ?? DEFAULT_MAX_OUTSTANDING_BYTES;
    let count = 0;
    let bytes = 0;
    for (const batch of this.batches) {
      if (!this.sent.has(batch.clientSeq)) continue;
      count += 1;
      bytes += batch.update.length;
    }
    for (const batch of this.batches) {
      if (this.sent.has(batch.clientSeq)) continue;
      if (this.tooLarge(batch.subdoc, batch.update.length, `batch:${batch.clientSeq}`)) continue;
      if (count >= maxBatches || (count > 0 && bytes + batch.update.length > maxBytes)) break;
      if (!this.transmit(batch)) break;
      count += 1;
      bytes += batch.update.length;
    }
    this.scheduleRetry();
  }

  private sendBatch(_batch: OutboundBatch): void {
    this.sendUnsent();
  }

  private transmit(batch: OutboundBatch): boolean {
    if (!this.transport) return false;
    const message: UpdateMessage = {
      type: MessageType.Update,
      docId: this.docId,
      subdoc: batch.subdoc,
      clientSeq: batch.clientSeq,
      update: batch.update,
      ...(batch.provenance ? { provenance: batch.provenance } : {}),
    };
    if (!this.transport.send(message)) return false;
    this.sent.add(batch.clientSeq);
    this.sentAt.set(batch.clientSeq, this.clock.now());
    return true;
  }

  /** The server acknowledged a batch. Returns the covered local_seqs, or null for a duplicate ack. */
  ack(clientSeq: number, serverSeq: number): number[] | null {
    const index = this.batches.findIndex((batch) => batch.clientSeq === clientSeq);
    const localSeqs = this.store.ackBatch(this.docId, clientSeq, serverSeq);
    if (index >= 0) this.batches.splice(index, 1);
    this.sent.delete(clientSeq);
    this.sentAt.delete(clientSeq);
    this.lastProgressAt = this.clock.now();
    this.retryAttempt = 0;
    if (this.batches.length === 0) {
      this.clearRetry();
    } else {
      this.sendUnsent();
    }
    return localSeqs;
  }

  /** Forgets a sub-document's queue after a reject rollback (the store rows are wiped by the hub). */
  dropSubdoc(subdoc: Subdoc): void {
    for (const batch of this.batches) if (batch.subdoc === subdoc) {
      this.sent.delete(batch.clientSeq);
      this.sentAt.delete(batch.clientSeq);
    }
    this.batches = this.batches.filter((batch) => batch.subdoc !== subdoc);
    this.unbatched.delete(subdoc);
    if (this.batches.length === 0) this.clearRetry();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }
}
