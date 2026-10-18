// DocHub: the host's single owner of one document (collaboration map §2, §7.1).
//
// The hub holds one Y.Doc per sub-document, loaded from the latest local
// snapshot plus the log tail. Renderer replicas attach through ReplicaPorts;
// in-process users (control API, materializer, agent) use the methods below.
//
// Ordering for a local edit (replica or in-process):
//   1. apply to the hub doc; an update that changes nothing stops here
//   2. append to SQLite and commit
//   3. broadcast to the other replicas (origin "local")
//   4. enqueue for the server with its provenance
//   5. emit status
// Remote updates are persisted (acked) before they are applied and broadcast.

import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";

import type { Provenance } from "../../../src/lib/collab/protocol/actor";
import type { DocMetaState, HubToReplica, ReplicaToHub, SyncStatus } from "../../../src/lib/collab/protocol/local";
import type {
  AckMessage,
  ClosedMessage,
  ErrorMessage,
  OpenedMessage,
  RejectMessage,
  RemoteMessage,
  SubdocStateVector,
} from "../../../src/lib/collab/protocol/messages";
import type { Role, Subdoc } from "../../../src/lib/collab/protocol/roles";
import { AnnotationKeys, ContentKeys, ManifestKeys, MetaKeys } from "../../../src/lib/collab/protocol/schema";
import { DOC_SCHEMA_VERSION, SyncLimits } from "../../../src/lib/collab/protocol/version";
import type { Clock, Logger, TimerHandle } from "./clock";
import { Emitter, consoleLogger, systemClock } from "./clock";
import type { CompactionTarget, Compactor } from "./compaction";
import { OutboundQueue, hasStructs, type OutboundLimits, type OutboundTransport } from "./outbound";
import type { ReplicaPort } from "./ports";
import { StatusTracker, type StatusInputs } from "./status";
import type { DocKindTag, DocMetaRow, HostStore, ReadOnlyReason, RejectedEditRow } from "./store";

export type HubKind = DocKindTag;

export const SUBDOCS_BY_KIND: Record<HubKind, readonly Subdoc[]> = {
  file: ["content", "annotations", "meta"],
  manifest: ["manifest"],
};

/** Where a change to a hub sub-document came from. */
export type HubChangeOrigin =
  /** An attached renderer replica. */
  | "replica"
  /** applyLocalChange (control API, materializer, agent). */
  | "local"
  /** A live update from another client, via the server. */
  | "remote"
  /** Catch-up state from the server's `opened`. */
  | "server"
  /** The sub-document was replaced (reject rollback); re-read it with getDoc. */
  | "rebuilt";

export interface HubChange {
  subdoc: Subdoc;
  update: Uint8Array;
  origin: HubChangeOrigin;
  provenance?: Provenance;
}

export type RejectedEdit = RejectedEditRow;

/** What the sync client gives a hub while the socket is up. */
export interface HubTransport extends OutboundTransport {
  sendAwareness(update: Uint8Array): void;
  /** Sends `open` again with the hub's current state vectors (after a rollback). */
  reopen(): void;
}

export interface DocHubOptions {
  docId: string;
  store: HostStore;
  /** Defaults to the kind stored in doc_meta, else "file". */
  kind?: HubKind;
  projectId?: string;
  clock?: Clock;
  logger?: Logger;
  limits?: Partial<OutboundLimits>;
  compactor?: Compactor | null;
}

interface CommittedUpdate {
  subdoc: Subdoc;
  localSeq: number;
  update: Uint8Array;
  provenance?: Provenance;
}

type Origin =
  | { kind: "load" }
  | { kind: "replica"; replica: ReplicaConnection; provenance?: Provenance }
  | { kind: "local"; provenance?: Provenance }
  | { kind: "remote" }
  | { kind: "server"; serverSeq: number; persistEffective: boolean };

const LOAD_ORIGIN: Origin = { kind: "load" };
const REMOTE_ORIGIN: Origin = { kind: "remote" };
const REMOTE_AWARENESS = "libera-collab:remote";
const DISCONNECT_AWARENESS = "libera-collab:disconnect";

function isOrigin(value: unknown): value is Origin {
  return typeof value === "object" && value !== null && typeof (value as { kind?: unknown }).kind === "string";
}

/** One attached renderer replica. */
export class ReplicaConnection {
  attached = false;
  /** Awareness client ids this replica announced, removed when it detaches. */
  readonly awarenessClients = new Set<number>();
  private detached = false;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    private readonly hub: DocHub,
    readonly port: ReplicaPort,
    private readonly onDetach: () => void,
  ) {
    this.unsubscribe.push(port.onMessage((message) => this.hub.handleReplicaMessage(this, message)));
    if (port.onClose) this.unsubscribe.push(port.onClose(() => this.detach()));
  }

  get isDetached(): boolean {
    return this.detached;
  }

  post(message: HubToReplica): void {
    if (this.detached) return;
    try {
      this.port.postMessage(message);
    } catch {
      // A port that cannot carry messages is gone.
      this.detach();
    }
  }

  /** Detaches from the hub. `closePort` also closes the port. */
  detach(closePort = false): void {
    if (this.detached) return;
    this.detached = true;
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.hub.replicaDetached(this);
    if (closePort) {
      try {
        this.port.close();
      } catch {
        // Already closed.
      }
    }
    this.onDetach();
  }
}

export class DocHub implements CompactionTarget {
  readonly docId: string;
  readonly kind: HubKind;
  readonly subdocs: readonly Subdoc[];
  readonly awareness: Awareness;

  private readonly store: HostStore;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly compactor: Compactor | null;
  private readonly outbound: OutboundQueue;
  private readonly status: StatusTracker;
  private readonly docs = new Map<Subdoc, Y.Doc>();
  private readonly generations = new Map<Subdoc, number>();
  private readonly tails = new Map<Subdoc, { count: number; bytes: number; lastSeq: number }>();
  private readonly pendingLocal = new Map<number, { subdoc: Subdoc; createdAt: number }>();
  private readonly replicas = new Set<ReplicaConnection>();
  private readonly remoteAwarenessClients = new Set<number>();
  private readonly rejected = new Map<Subdoc, RejectedEdit>();
  private readonly changes = new Emitter<HubChange>();
  private readonly rejections = new Emitter<RejectedEdit>();
  private readonly metaChanges = new Emitter<DocMetaState>();
  private readonly closeListeners = new Emitter<void>();
  private readonly unpersisted: Array<{ subdoc: Subdoc; update: Uint8Array; provenance?: Provenance }> = [];
  private meta: DocMetaRow;
  /** Set while the doc may send on the current connection. */
  private transport: HubTransport | null = null;
  /** The current connection, kept while sending is stopped (for reopen). */
  private link: HubTransport | null = null;
  private connected = false;
  private opened = false;
  private hasData = false;
  private lastAckAt: number | null = null;
  private connectionDetail: string | undefined;
  private persistError: string | undefined;
  private persistRetry: TimerHandle | null = null;
  private lastLocalUpdate: { origin: Origin; update: Uint8Array } | null = null;
  private closed = false;

  constructor(options: DocHubOptions) {
    this.docId = options.docId;
    this.store = options.store;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? consoleLogger;
    this.compactor = options.compactor ?? null;

    const stored = this.store.getDocMeta(this.docId);
    this.kind = options.kind ?? stored?.kind ?? "file";
    this.subdocs = SUBDOCS_BY_KIND[this.kind];
    this.store.updateDocMeta(this.docId, {
      kind: this.kind,
      lastOpenedAt: this.clock.now(),
      ...(options.projectId ? { projectId: options.projectId } : {}),
    });
    this.meta = this.store.getDocMeta(this.docId) as DocMetaRow;
    this.hasData = this.meta.lastSeenServerSeq > 0;

    for (const subdoc of this.subdocs) this.load(subdoc);
    for (const row of this.store.unackedSummary(this.docId)) {
      this.pendingLocal.set(row.localSeq, { subdoc: row.subdoc, createdAt: row.createdAt });
    }
    for (const edit of this.store.listRejected(this.docId)) this.rejected.set(edit.subdoc, edit);

    this.outbound = new OutboundQueue({
      docId: this.docId,
      store: this.store,
      clock: this.clock,
      logger: this.logger,
      limits: {
        batchWindowMs: options.limits?.batchWindowMs ?? SyncLimits.batchWindowMs,
        batchMaxBytes: options.limits?.batchMaxBytes ?? SyncLimits.batchMaxBytes,
      },
    });
    this.status = new StatusTracker(this.clock, () => this.statusInputs());
    this.status.onChange((status) => {
      for (const replica of this.replicas) {
        if (replica.attached) replica.post({ t: "status", docId: this.docId, status });
      }
    });

    // The hub relays awareness; it has no presence of its own.
    this.awareness = new Awareness(new Y.Doc());
    this.awareness.setLocalState(null);
    (this.awareness as unknown as { _checkInterval?: { unref?: () => void } })._checkInterval?.unref?.();
    this.awareness.on("update", this.onAwarenessUpdate);
  }

  // ------------------------------------------------------------ loading

  private load(subdoc: Subdoc): void {
    const doc = this.createDoc(subdoc);
    const { snapshot, tail } = this.store.loadSubdoc(this.docId, subdoc);
    if (snapshot) Y.applyUpdate(doc, snapshot.state, LOAD_ORIGIN);
    if (tail.length > 0) Y.applyUpdate(doc, Y.mergeUpdates(tail.map((row) => row.update)), LOAD_ORIGIN);
    if (snapshot || tail.length > 0) this.hasData = true;
    this.tails.set(subdoc, {
      count: tail.length,
      bytes: tail.reduce((total, row) => total + row.update.length, 0),
      lastSeq: Math.max(snapshot?.uptoLocalSeq ?? 0, tail.length > 0 ? tail[tail.length - 1].localSeq : 0),
    });
    this.generations.set(subdoc, (this.generations.get(subdoc) ?? 0) + 1);
  }

  private createDoc(subdoc: Subdoc): Y.Doc {
    const doc = new Y.Doc();
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (this.docs.get(subdoc) === doc) this.onDocUpdate(subdoc, update, origin);
    });
    this.docs.set(subdoc, doc);
    return doc;
  }

  // ------------------------------------------------------------ in-process API

  /** The live Y.Doc of a sub-document. It is replaced after a reject rollback ("rebuilt" change). */
  getDoc(subdoc: Subdoc): Y.Doc {
    const doc = this.docs.get(subdoc);
    if (!doc) throw new Error(`Document ${this.docId} has no ${subdoc} sub-document`);
    return doc;
  }

  /** Content source text, or the JSON of a map sub-document. */
  getText(subdoc: Subdoc = this.kind === "manifest" ? "manifest" : "content"): string {
    return subdocText(subdoc, this.getDoc(subdoc));
  }

  stateVectors(): SubdocStateVector[] {
    return this.subdocs.map((subdoc) => ({ subdoc, stateVector: Y.encodeStateVector(this.getDoc(subdoc)) }));
  }

  /**
   * Runs `fn` in one transaction on the hub doc, attributed to the local user
   * with `provenance`. The change is persisted, broadcast to every replica
   * and queued for the server. Returns the update, or null if nothing changed.
   */
  applyLocalChange(subdoc: Subdoc, fn: (doc: Y.Doc) => void, provenance?: Provenance): Uint8Array | null {
    this.assertOpen();
    const doc = this.getDoc(subdoc);
    const origin: Origin = provenance ? { kind: "local", provenance } : { kind: "local" };
    this.lastLocalUpdate = null;
    doc.transact(() => fn(doc), origin);
    const captured = this.lastLocalUpdate as { origin: Origin; update: Uint8Array } | null;
    this.lastLocalUpdate = null;
    return captured && captured.origin === origin ? captured.update : null;
  }

  /** Subscribes to changes of one sub-document, or all of them with null. */
  observe(subdoc: Subdoc | null, listener: (change: HubChange) => void): () => void {
    return this.changes.on((change) => {
      if (subdoc === null || change.subdoc === subdoc) listener(change);
    });
  }

  onStatus(listener: (status: SyncStatus) => void): () => void {
    return this.status.onChange(listener);
  }

  getStatus(): SyncStatus {
    return this.status.current();
  }

  getMeta(): DocMetaState {
    const role: Role = this.meta.role ?? "editor";
    const reason = this.meta.readOnlyReason ?? (role === "viewer" ? "role" : undefined);
    return {
      docId: this.docId,
      projectId: this.meta.projectId ?? "",
      role,
      schemaVersion: this.meta.schemaVersion ?? DOC_SCHEMA_VERSION,
      readOnly: reason !== undefined,
      ...(reason ? { readOnlyReason: reason } : {}),
    };
  }

  onMeta(listener: (meta: DocMetaState) => void): () => void {
    return this.metaChanges.on(listener);
  }

  /** Text removed by the last reject rollback, per sub-document ("Copy my unsynced text"). */
  getRejected(subdoc?: Subdoc): RejectedEdit[] {
    const all = [...this.rejected.values()];
    return subdoc ? all.filter((edit) => edit.subdoc === subdoc) : all;
  }

  dismissRejected(subdoc: Subdoc): void {
    this.rejected.delete(subdoc);
    this.store.deleteRejected(this.docId, subdoc);
  }

  onRejected(listener: (edit: RejectedEdit) => void): () => void {
    return this.rejections.on(listener);
  }

  /** Unacknowledged local updates. */
  get pendingCount(): number {
    return this.pendingLocal.size;
  }

  get replicaCount(): number {
    let count = 0;
    for (const replica of this.replicas) if (!replica.isDetached) count += 1;
    return count;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get readOnlyReason(): ReadOnlyReason | null {
    return this.meta.readOnlyReason;
  }

  /** Outbound batches awaiting ack (tests, diagnostics). */
  pendingBatches() {
    return this.outbound.pendingBatches();
  }

  /** Forms batches from queued updates now instead of waiting for the batch window. */
  flushOutbound(): Promise<void> {
    return this.outbound.flush();
  }

  /** Clears an access-revoked or schema read-only state (access restored, app updated). */
  clearReadOnly(): void {
    if (this.meta.readOnlyReason === null) return;
    this.store.updateDocMeta(this.docId, { readOnlyReason: null });
    this.refreshMeta();
    this.link?.reopen();
    this.status.changed();
  }

  onClose(listener: () => void): () => void {
    return this.closeListeners.on(listener);
  }

  // ------------------------------------------------------------ replicas

  /** Connects a replica port. The replica must send `attach` first. */
  attachReplica(port: ReplicaPort, onDetach: () => void = () => {}): ReplicaConnection {
    this.assertOpen();
    const connection = new ReplicaConnection(this, port, onDetach);
    this.replicas.add(connection);
    return connection;
  }

  /** @internal Routed from ReplicaConnection. */
  handleReplicaMessage(replica: ReplicaConnection, message: ReplicaToHub): void {
    if (this.closed || replica.isDetached) return;
    if (message.docId !== this.docId) {
      replica.post({ t: "error", docId: message.docId, message: `This port serves ${this.docId}` });
      return;
    }
    switch (message.t) {
      case "attach":
        this.handleAttach(replica, message.stateVectors);
        break;
      case "update":
        if (!replica.attached) {
          replica.post({ t: "error", docId: this.docId, message: "Send attach before updates" });
          return;
        }
        this.applyReplicaUpdate(replica, message.subdoc, message.update, message.provenance);
        break;
      case "awareness":
        try {
          applyAwarenessUpdate(this.awareness, message.update, replica);
        } catch {
          replica.post({ t: "error", docId: this.docId, message: "Invalid awareness update" });
        }
        break;
      case "detach":
        replica.detach(true);
        break;
    }
  }

  private handleAttach(replica: ReplicaConnection, stateVectors: Partial<Record<Subdoc, Uint8Array>>): void {
    for (const subdoc of this.subdocs) {
      const doc = this.getDoc(subdoc);
      let update: Uint8Array;
      try {
        const vector = stateVectors[subdoc];
        update = vector ? Y.encodeStateAsUpdate(doc, vector) : Y.encodeStateAsUpdate(doc);
      } catch {
        // A malformed state vector: send everything; Yjs dedupes.
        update = Y.encodeStateAsUpdate(doc);
      }
      replica.post({ t: "state", docId: this.docId, subdoc, update });
    }
    replica.post({ t: "meta", docId: this.docId, meta: this.getMeta() });
    replica.post({ t: "status", docId: this.docId, status: this.status.current() });
    for (const edit of this.rejected.values()) {
      replica.post({ t: "rejected", docId: this.docId, subdoc: edit.subdoc, reason: edit.reason, rejectedText: edit.rejectedText });
    }
    const states = [...this.awareness.getStates().keys()];
    if (states.length > 0) {
      replica.post({ t: "awareness", docId: this.docId, update: encodeAwarenessUpdate(this.awareness, states) });
    }
    replica.attached = true;
  }

  private applyReplicaUpdate(replica: ReplicaConnection, subdoc: Subdoc, update: Uint8Array, provenance?: Provenance): void {
    const doc = this.docs.get(subdoc);
    if (!doc) {
      replica.post({ t: "error", docId: this.docId, message: `Unknown sub-document ${subdoc}` });
      return;
    }
    const hadPending = doc.store.pendingStructs !== null || doc.store.pendingDs !== null;
    try {
      Y.applyUpdate(doc, update, { kind: "replica", replica, provenance } satisfies Origin);
    } catch (error) {
      replica.post({ t: "error", docId: this.docId, message: `Invalid update: ${String(error)}` });
      return;
    }
    if (!hadPending && (doc.store.pendingStructs !== null || doc.store.pendingDs !== null)) {
      // The update depends on state the hub does not have: the replica built
      // it on a sub-document that was rolled back before it saw `rejected`.
      // Whatever did integrate is already persisted; the rest is dropped.
      doc.store.pendingStructs = null;
      doc.store.pendingDs = null;
      replica.post({
        t: "error",
        docId: this.docId,
        message: `Dropped an update for ${subdoc} that depends on discarded state; rebuild from the hub's state.`,
      });
    }
  }

  /** @internal Called by ReplicaConnection.detach. */
  replicaDetached(replica: ReplicaConnection): void {
    this.replicas.delete(replica);
    const clients = [...replica.awarenessClients].filter((client) => this.awareness.getStates().has(client));
    if (clients.length > 0) removeAwarenessStates(this.awareness, clients, replica);
  }

  private broadcast(message: HubToReplica, except?: ReplicaConnection): void {
    for (const replica of this.replicas) {
      if (replica !== except && replica.attached) replica.post(message);
    }
  }

  // ------------------------------------------------------------ the update pipeline

  private onDocUpdate(subdoc: Subdoc, update: Uint8Array, rawOrigin: unknown): void {
    const origin: Origin = isOrigin(rawOrigin) ? rawOrigin : { kind: "local" };
    switch (origin.kind) {
      case "load":
        return;
      case "replica":
      case "local": {
        this.lastLocalUpdate = { origin, update };
        const committed = this.persistLocal(subdoc, update, origin.provenance);
        this.broadcast(
          { t: "update", docId: this.docId, subdoc, update, origin: "local" },
          origin.kind === "replica" ? origin.replica : undefined,
        );
        for (const entry of committed) this.outbound.enqueue(entry.subdoc, entry.localSeq, entry.update, entry.provenance);
        this.changes.emit({
          subdoc,
          update,
          origin: origin.kind,
          ...(origin.provenance ? { provenance: origin.provenance } : {}),
        });
        this.status.changed();
        return;
      }
      case "server":
        if (origin.persistEffective) this.persistAcked(subdoc, update, origin.serverSeq, { kind: "server" });
        this.broadcast({ t: "update", docId: this.docId, subdoc, update, origin: "server" });
        this.changes.emit({ subdoc, update, origin: "server" });
        return;
      case "remote":
        this.broadcast({ t: "update", docId: this.docId, subdoc, update, origin: "remote" });
        this.changes.emit({ subdoc, update, origin: "remote" });
        return;
    }
  }

  private persistLocal(subdoc: Subdoc, update: Uint8Array, provenance?: Provenance): CommittedUpdate[] {
    this.unpersisted.push({ subdoc, update, provenance });
    return this.drainUnpersisted();
  }

  /**
   * Commits queued local updates in order and returns the committed ones. On
   * failure the rest stay queued (and count as pending) and are retried.
   */
  private drainUnpersisted(): CommittedUpdate[] {
    const committed: CommittedUpdate[] = [];
    while (this.unpersisted.length > 0 && !this.closed) {
      const next = this.unpersisted[0];
      let localSeq: number;
      try {
        localSeq = this.store.appendLocal(this.docId, next.subdoc, next.update, next.provenance);
      } catch (error) {
        this.persistError = error instanceof Error ? error.message : String(error);
        this.logger.error(`Could not persist a local update for ${this.docId}`, error);
        this.broadcast({ t: "error", docId: this.docId, message: `Could not save on this device: ${this.persistError}` });
        if (!this.persistRetry) {
          this.persistRetry = this.clock.setTimeout(() => {
            this.persistRetry = null;
            for (const entry of this.drainUnpersisted()) {
              this.outbound.enqueue(entry.subdoc, entry.localSeq, entry.update, entry.provenance);
            }
            this.status.changed();
          }, 1000);
        }
        return committed;
      }
      this.unpersisted.shift();
      this.persistError = undefined;
      this.hasData = true;
      this.pendingLocal.set(localSeq, { subdoc: next.subdoc, createdAt: this.clock.now() });
      this.noteAppended(next.subdoc, localSeq, next.update.length);
      committed.push({ ...next, localSeq });
    }
    return committed;
  }

  private persistAcked(
    subdoc: Subdoc,
    update: Uint8Array,
    serverSeq: number,
    origin: { kind: "server" } | { kind: "remote"; userId: string; clientId: string; provenance?: Provenance },
  ): void {
    const localSeq = this.store.appendAcked(this.docId, subdoc, update, origin, serverSeq);
    this.hasData = true;
    this.noteAppended(subdoc, localSeq, update.length);
  }

  private noteAppended(subdoc: Subdoc, localSeq: number, bytes: number): void {
    const tail = this.tails.get(subdoc);
    if (!tail) return;
    tail.count += 1;
    tail.bytes += bytes;
    tail.lastSeq = Math.max(tail.lastSeq, localSeq);
    if (this.compactor?.shouldCompact(tail.count, tail.bytes)) void this.compactor.schedule(this, subdoc);
  }

  // ------------------------------------------------------------ compaction target

  generation(subdoc: Subdoc): number {
    return this.generations.get(subdoc) ?? 0;
  }

  lastPersistedSeq(subdoc: Subdoc): number {
    return this.tails.get(subdoc)?.lastSeq ?? 0;
  }

  compacted(subdoc: Subdoc): void {
    const stats = this.store.tailStats(this.docId, subdoc);
    this.tails.set(subdoc, { count: stats.count, bytes: stats.bytes, lastSeq: stats.lastLocalSeq });
  }

  /** Snapshots every sub-document whose log has any tail (tests, shutdown). */
  async compactNow(): Promise<void> {
    if (!this.compactor) return;
    await Promise.all(this.subdocs.map((subdoc) => this.compactor?.schedule(this, subdoc)));
  }

  // ------------------------------------------------------------ sync (called by SyncClient)

  /** False once access was revoked: the doc is never opened again until cleared. */
  canSync(): boolean {
    return !this.closed && this.meta.readOnlyReason !== "access-revoked";
  }

  /** The socket finished hello/welcome (transport) or dropped (null). */
  connectionChanged(transport: HubTransport | null, detail?: string): void {
    this.transport = transport;
    this.link = transport;
    this.connected = transport !== null;
    this.connectionDetail = transport ? undefined : detail;
    this.opened = false;
    this.outbound.stop();
    if (!transport) this.dropRemoteAwareness();
    this.status.changed();
  }

  /** The connection is down for a reason the user should see (sign in, update). */
  setConnectionDetail(detail: string | undefined): void {
    this.connectionDetail = detail;
    this.status.changed();
  }

  handleOpened(message: OpenedMessage): void {
    if (this.closed) return;
    const schemaNewer = message.schemaVersion > DOC_SCHEMA_VERSION;
    const reason: ReadOnlyReason | null = schemaNewer
      ? "schema-newer"
      : this.meta.readOnlyReason === "schema-newer"
        ? null
        : this.meta.readOnlyReason;
    this.store.updateDocMeta(this.docId, {
      projectId: message.projectId,
      role: message.role,
      schemaVersion: message.schemaVersion,
      readOnlyReason: reason,
    });
    const serverStateVectors = new Map<Subdoc, Uint8Array>();
    for (const entry of message.subdocs) {
      const doc = this.docs.get(entry.subdoc);
      if (!doc) continue;
      serverStateVectors.set(entry.subdoc, entry.stateVector);
      this.applyServerUpdate(entry.subdoc, doc, entry.diff, message.serverSeq);
    }
    this.store.noteServerSeq(this.docId, message.serverSeq);
    this.hasData = true;
    this.opened = true;
    this.connectionDetail = undefined;
    if (this.link && this.meta.readOnlyReason !== "access-revoked") this.transport = this.link;
    this.refreshMeta();
    if (this.transport && this.meta.readOnlyReason === null) {
      void this.outbound.start(this.transport, serverStateVectors, (subdoc, known) =>
        Y.encodeStateAsUpdate(this.getDoc(subdoc), known),
      );
    }
    this.status.changed();
  }

  private applyServerUpdate(subdoc: Subdoc, doc: Y.Doc, diff: Uint8Array, serverSeq: number): void {
    try {
      if (hasStructs(diff)) {
        // Persist before apply, so what replicas see is always on disk.
        this.persistAcked(subdoc, diff, serverSeq, { kind: "server" });
        Y.applyUpdate(doc, diff, { kind: "server", serverSeq, persistEffective: false } satisfies Origin);
      } else {
        // A delete set the server always includes; persist it only if it
        // changes something, so reconnects do not grow the log.
        Y.applyUpdate(doc, diff, { kind: "server", serverSeq, persistEffective: true } satisfies Origin);
      }
    } catch (error) {
      this.logger.error(`Invalid server diff for ${this.docId}/${subdoc}`, error);
    }
  }

  handleAck(message: AckMessage): void {
    const localSeqs = this.outbound.ack(message.clientSeq, message.serverSeq);
    if (!localSeqs) return;
    for (const localSeq of localSeqs) this.pendingLocal.delete(localSeq);
    this.lastAckAt = this.clock.now();
    this.status.changed();
  }

  handleReject(message: RejectMessage): void {
    if (!this.outbound.hasBatch(message.clientSeq)) return;
    this.rollback(message.subdoc, message.reason, message.message);
  }

  /**
   * Reject rollback (plan M1.8): keep the sub-document's current text for
   * "Copy my unsynced text", drop all local state for it, and reload it from
   * the server by reopening with an empty state vector for that sub-document.
   */
  rollback(subdoc: Subdoc, reason: string, message: string): RejectedEdit {
    const doc = this.getDoc(subdoc);
    const edit: RejectedEdit = {
      docId: this.docId,
      subdoc,
      reason,
      message,
      rejectedText: subdocText(subdoc, doc),
      at: this.clock.now(),
    };
    this.store.transaction(() => {
      this.store.putRejected(edit);
      this.store.wipeSubdoc(this.docId, subdoc);
    });
    this.rejected.set(subdoc, edit);
    this.outbound.dropSubdoc(subdoc);
    for (const [localSeq, info] of this.pendingLocal) if (info.subdoc === subdoc) this.pendingLocal.delete(localSeq);
    for (let index = this.unpersisted.length - 1; index >= 0; index -= 1) {
      if (this.unpersisted[index].subdoc === subdoc) this.unpersisted.splice(index, 1);
    }
    this.docs.delete(subdoc);
    doc.destroy();
    const fresh = this.createDoc(subdoc);
    this.generations.set(subdoc, this.generation(subdoc) + 1);
    this.tails.set(subdoc, { count: 0, bytes: 0, lastSeq: 0 });

    this.broadcast({ t: "rejected", docId: this.docId, subdoc, reason, rejectedText: edit.rejectedText });
    this.broadcast({ t: "state", docId: this.docId, subdoc, update: Y.encodeStateAsUpdate(fresh) });
    this.changes.emit({ subdoc, update: new Uint8Array(0), origin: "rebuilt" });
    this.rejections.emit(edit);
    this.link?.reopen();
    this.status.changed(true);
    return edit;
  }

  handleRemote(message: RemoteMessage): void {
    const doc = this.docs.get(message.subdoc);
    if (!doc || this.closed) return;
    this.persistAcked(message.subdoc, message.update, message.serverSeq, {
      kind: "remote",
      userId: message.userId,
      clientId: message.clientId,
      ...(message.provenance ? { provenance: message.provenance } : {}),
    });
    try {
      Y.applyUpdate(doc, message.update, REMOTE_ORIGIN);
    } catch (error) {
      this.logger.error(`Invalid remote update for ${this.docId}/${message.subdoc}`, error);
    }
  }

  handleAwareness(update: Uint8Array): void {
    try {
      applyAwarenessUpdate(this.awareness, update, REMOTE_AWARENESS);
    } catch (error) {
      this.logger.warn(`Invalid awareness update for ${this.docId}`, error);
    }
  }

  handleClosed(message: ClosedMessage): void {
    switch (message.reason) {
      case "access-revoked":
      case "forbidden":
        // Local work stays in SQLite; nothing more is sent for this doc.
        this.store.updateDocMeta(this.docId, { readOnlyReason: "access-revoked" });
        this.stopSyncing();
        this.refreshMeta();
        break;
      case "document-deleted":
        this.stopSyncing();
        this.broadcast({ t: "closed", docId: this.docId, reason: message.reason });
        break;
      case "not-found":
        this.stopSyncing();
        if (this.meta.lastSeenServerSeq > 0 || this.hasData) {
          // The server knew this document before. "Not found" now means the
          // account lost access (for example while offline) or the project
          // went away: keep local work, stop sending, show Access changed.
          this.store.updateDocMeta(this.docId, { readOnlyReason: "access-revoked" });
          this.connectionDetail = "You no longer have access to this document.";
          this.refreshMeta();
        } else {
          this.connectionDetail = "This document is not on the server.";
        }
        break;
      case "client-closed":
        return;
    }
    this.status.changed();
  }

  handleError(message: ErrorMessage): void {
    this.broadcast({ t: "error", docId: this.docId, message: message.message });
  }

  private stopSyncing(): void {
    this.transport = null;
    this.opened = false;
    this.outbound.stop();
    this.dropRemoteAwareness();
  }

  private refreshMeta(): void {
    const before = JSON.stringify(this.getMeta());
    this.meta = this.store.getDocMeta(this.docId) as DocMetaRow;
    const meta = this.getMeta();
    if (JSON.stringify(meta) === before) return;
    this.broadcast({ t: "meta", docId: this.docId, meta });
    this.metaChanges.emit(meta);
  }

  // ------------------------------------------------------------ awareness

  private onAwarenessUpdate = (
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    const changed = [...change.added, ...change.updated, ...change.removed];
    if (changed.length === 0) return;
    if (origin instanceof ReplicaConnection) {
      for (const client of [...change.added, ...change.updated]) origin.awarenessClients.add(client);
      for (const client of change.removed) origin.awarenessClients.delete(client);
    } else if (origin === REMOTE_AWARENESS) {
      for (const client of [...change.added, ...change.updated]) this.remoteAwarenessClients.add(client);
      for (const client of change.removed) this.remoteAwarenessClients.delete(client);
    }
    const update = encodeAwarenessUpdate(this.awareness, changed);
    for (const replica of this.replicas) {
      if (replica !== origin && replica.attached) replica.post({ t: "awareness", docId: this.docId, update });
    }
    // Only this machine's presence goes to the server: remote states and
    // local timeouts of remote states are the server's business.
    const ours = origin instanceof ReplicaConnection || origin === "local";
    if (ours && this.transport && this.meta.readOnlyReason !== "access-revoked") this.transport.sendAwareness(update);
  };

  private dropRemoteAwareness(): void {
    const clients = [...this.remoteAwarenessClients].filter((client) => this.awareness.getStates().has(client));
    this.remoteAwarenessClients.clear();
    if (clients.length > 0) removeAwarenessStates(this.awareness, clients, DISCONNECT_AWARENESS);
  }

  // ------------------------------------------------------------ status

  private statusInputs(): StatusInputs {
    let oldestPendingAt: number | null = null;
    for (const info of this.pendingLocal.values()) {
      oldestPendingAt = info.createdAt;
      break;
    }
    return {
      connected: this.connected,
      opened: this.opened,
      hasData: this.hasData,
      pending: this.pendingLocal.size + this.unpersisted.length,
      oldestPendingAt,
      lastAckAt: this.lastAckAt,
      readOnlyReason: this.meta.readOnlyReason,
      ...(this.connectionDetail ? { connectionDetail: this.connectionDetail } : {}),
      ...(this.persistError ? { persistError: this.persistError } : {}),
    };
  }

  // ------------------------------------------------------------ lifecycle

  private assertOpen(): void {
    if (this.closed) throw new Error(`Document hub ${this.docId} is closed`);
  }

  /** Waits for queued snapshot work, so closing never abandons a half-done compaction. */
  async prepareClose(): Promise<void> {
    await this.compactor?.whenIdle(this.docId);
  }

  /** Closes the hub. Replicas still attached get `closed` and their ports are closed. */
  close(reason = "hub-closed"): void {
    if (this.closed) return;
    // Keep retrying a failed commit one last time; anything still failing
    // stays only in replicas' memory, which the error already reported.
    this.drainUnpersisted();
    this.closed = true;
    if (this.persistRetry) this.clock.clearTimeout(this.persistRetry);
    for (const replica of [...this.replicas]) {
      replica.post({ t: "closed", docId: this.docId, reason });
      replica.detach(true);
    }
    this.outbound.dispose();
    this.status.dispose();
    this.awareness.off("update", this.onAwarenessUpdate);
    this.awareness.destroy();
    for (const doc of this.docs.values()) doc.destroy();
    this.transport = null;
    this.link = null;
    this.closeListeners.emit();
    this.closeListeners.clear();
    this.changes.clear();
  }
}

/** Plain text of a sub-document: the content source, or JSON of the maps. */
export function subdocText(subdoc: Subdoc, doc: Y.Doc): string {
  const maps = (keys: readonly string[]) =>
    JSON.stringify(Object.fromEntries(keys.map((key) => [key, doc.getMap(key).toJSON()])), null, 2);
  switch (subdoc) {
    case "content":
      return doc.getText(ContentKeys.source).toString();
    case "annotations":
      return maps(Object.values(AnnotationKeys));
    case "meta":
      return maps(Object.values(MetaKeys));
    case "manifest":
      return maps(Object.values(ManifestKeys));
  }
}
