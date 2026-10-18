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
import type { Clock, Logger, TimerHandle } from "./clock";
import type { HostStore, OutboundBatch } from "./store";

export interface OutboundTransport {
  /** Sends an update frame; returns false when the socket is not writable. */
  send(message: UpdateMessage): boolean;
}

export interface OutboundLimits {
  batchWindowMs: number;
  batchMaxBytes: number;
}

export interface OutboundOptions {
  docId: string;
  store: HostStore;
  clock: Clock;
  limits: OutboundLimits;
  logger: Logger;
  /** Time slice for forming batches before yielding to the event loop. */
  sliceMs?: number;
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
  private readonly unbatched = new Map<Subdoc, PendingEntry[]>();
  private batches: OutboundBatch[];
  private transport: OutboundTransport | null = null;
  /** clientSeqs already written to the current connection. */
  private sent = new Set<number>();
  private timer: TimerHandle | null = null;
  private forming = false;
  private epoch = 0;
  private disposed = false;

  constructor(options: OutboundOptions) {
    this.docId = options.docId;
    this.store = options.store;
    this.clock = options.clock;
    this.limits = options.limits;
    this.logger = options.logger;
    this.sliceMs = options.sliceMs ?? 6;
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
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
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

  private sendUnsent(): void {
    for (const batch of this.batches) this.sendBatch(batch);
  }

  private sendBatch(batch: OutboundBatch): void {
    if (!this.transport || this.sent.has(batch.clientSeq)) return;
    const message: UpdateMessage = {
      type: MessageType.Update,
      docId: this.docId,
      subdoc: batch.subdoc,
      clientSeq: batch.clientSeq,
      update: batch.update,
      ...(batch.provenance ? { provenance: batch.provenance } : {}),
    };
    if (this.transport.send(message)) this.sent.add(batch.clientSeq);
  }

  /** The server acknowledged a batch. Returns the covered local_seqs, or null for a duplicate ack. */
  ack(clientSeq: number, serverSeq: number): number[] | null {
    const index = this.batches.findIndex((batch) => batch.clientSeq === clientSeq);
    const localSeqs = this.store.ackBatch(this.docId, clientSeq, serverSeq);
    if (index >= 0) this.batches.splice(index, 1);
    this.sent.delete(clientSeq);
    return localSeqs;
  }

  /** Forgets a sub-document's queue after a reject rollback (the store rows are wiped by the hub). */
  dropSubdoc(subdoc: Subdoc): void {
    for (const batch of this.batches) if (batch.subdoc === subdoc) this.sent.delete(batch.clientSeq);
    this.batches = this.batches.filter((batch) => batch.subdoc !== subdoc);
    this.unbatched.delete(subdoc);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }
}
