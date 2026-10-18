// The renderer replica of one shared document (map §7.1, plan M1.4).
//
// A replica holds one Y.Doc per sub-document (content, annotations, meta) and
// speaks protocol/local.ts with the host's DocHub over a MessagePort:
//
//   attach{stateVectors} → state × N, meta, status, [rejected…], [awareness]
//   then both sides send `update`s.
//
// Updates from the hub are applied with ReplicaOrigin.hub and never echoed.
// Local updates are queued with the provenance the bindings stored on their
// Y transaction and sent once per animation frame, so typing a word costs one
// message, not one per keystroke. The hub commits each update to SQLite
// before it acknowledges it with a status, so the queue is the only window in
// which an edit exists only in this window's memory; `flush()` closes it on
// pagehide.

import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";
import type { Provenance } from "../protocol/actor";
import { ReplicaOrigin, type DocMetaState, type HubToReplica, type ReplicaToHub, type SyncStatus } from "../protocol/local";
import { canWriteSubdoc, type Subdoc } from "../protocol/roles";
import { ContentKeys } from "../protocol/schema";
import { provenanceForTransaction } from "../bindings/codemirror";
import { provenanceOfOrigin } from "../bindings/tiptap-ytext";
import { getCollabBridge } from "../ui/bridge";

/** The sub-documents a file replica holds (the manifest has its own client). */
export const FILE_SUBDOCS: readonly Subdoc[] = ["content", "annotations", "meta"];

/**
 * The shape of a browser MessagePort this replica needs. Electron's renderer
 * MessagePort matches it; tests adapt the host's in-memory pair to it.
 */
export interface ReplicaMessagePort {
  postMessage(message: ReplicaToHub): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  /** Ports from `MessageChannel` deliver nothing until started. */
  start?(): void;
  close(): void;
}

export interface ReplicaRejection {
  subdoc: Subdoc;
  reason: string;
  /** The local text the server refused, for "Copy my unsynced text". */
  rejectedText: string;
}

export interface ReplicaSnapshot {
  /** The hub answered the attach (its first `status` arrived). */
  attached: boolean;
  meta: DocMetaState | null;
  status: SyncStatus | null;
  /** The latest rejection, until the user dismisses it. */
  rejection: ReplicaRejection | null;
  /** Set when the hub closed the document (deleted, hub shut down). */
  closed: string | null;
  error: string | null;
  /** Increases each time the content sub-document is rebuilt; editors rebind on change. */
  generation: number;
}

export interface ReplicaOptions {
  /** Schedules a flush of queued local updates. Defaults to the next animation frame (with a timer fallback). */
  schedule?: (flush: () => void) => void;
  /** Provenance for local updates whose transaction carries none. */
  defaultProvenance?: Provenance;
}

/** Origin for awareness updates applied from the hub, so they are not relayed back. */
const HUB_AWARENESS = "libera-collab:hub-awareness";
const FRAME_FALLBACK_MS = 50;

function defaultSchedule(flush: () => void) {
  // Hidden windows throttle animation frames to nothing; AI results and
  // background panes must still reach the hub promptly.
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    flush();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  setTimeout(run, FRAME_FALLBACK_MS);
}

function sameProvenance(left: Provenance | undefined, right: Provenance | undefined) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function isHubMessage(value: unknown): value is HubToReplica {
  return typeof value === "object" && value !== null && typeof (value as { t?: unknown }).t === "string";
}

interface QueuedUpdate {
  subdoc: Subdoc;
  update: Uint8Array;
  provenance?: Provenance;
}

export class CollabReplica {
  readonly awareness: Awareness;
  private readonly docs = new Map<Subdoc, Y.Doc>();
  private readonly docListeners = new Map<Subdoc, () => void>();
  private queue: QueuedUpdate[] = [];
  private flushScheduled = false;
  private readonly schedule: (flush: () => void) => void;
  private readonly defaultProvenance: Provenance;
  private snapshot: ReplicaSnapshot = { attached: false, meta: null, status: null, rejection: null, closed: null, error: null, generation: 0 };
  private readonly listeners = new Set<() => void>();
  private readonly rebuildListeners = new Set<(subdoc: Subdoc) => void>();
  private readonly attachedWaiters: Array<() => void> = [];
  // Rejections already acted on: the hub repeats stored rejections on every
  // attach, and rebuilding again for those would loop.
  private readonly handledRejections = new Set<string>();
  private destroyed = false;
  private readonly onPortMessage = (event: { data: unknown }) => {
    if (isHubMessage(event.data)) this.receive(event.data);
  };

  constructor(readonly docId: string, private readonly port: ReplicaMessagePort, options: ReplicaOptions = {}) {
    this.schedule = options.schedule ?? defaultSchedule;
    this.defaultProvenance = options.defaultProvenance ?? { source: "typing" };
    for (const subdoc of FILE_SUBDOCS) this.installDoc(subdoc, new Y.Doc());
    // Presence has its own Y.Doc: awareness takes its client id from it, and
    // that id must outlive a rebuilt content document.
    this.awareness = new Awareness(new Y.Doc());
    this.awareness.on("update", this.onAwarenessUpdate);
    port.addEventListener("message", this.onPortMessage);
    port.start?.();
    this.attach();
  }

  /* ---- Documents ------------------------------------------------------------ */

  doc(subdoc: Subdoc): Y.Doc {
    const doc = this.docs.get(subdoc);
    if (!doc) throw new Error(`A file replica has no ${subdoc} sub-document.`);
    return doc;
  }

  get content(): Y.Doc { return this.doc("content"); }
  get annotations(): Y.Doc { return this.doc("annotations"); }
  get meta(): Y.Doc { return this.doc("meta"); }
  /** The shared source text. Re-read after a rebuild: it is a new Y.Text then. */
  get ytext(): Y.Text { return this.content.getText(ContentKeys.source); }
  text(): string { return this.ytext.toString(); }

  getSnapshot = (): ReplicaSnapshot => this.snapshot;

  /** Whether local content edits are allowed (role, schema and access permitting). */
  canEditContent(): boolean {
    const { meta, status, closed } = this.snapshot;
    if (this.destroyed || closed || !meta) return false;
    if (meta.readOnly || !canWriteSubdoc(meta.role, "content")) return false;
    return status?.state !== "read-only" && status?.state !== "access-changed";
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Called after a sub-document was replaced; bindings must rebind to the new Y.Doc. */
  onRebuild(listener: (subdoc: Subdoc) => void): () => void {
    this.rebuildListeners.add(listener);
    return () => { this.rebuildListeners.delete(listener); };
  }

  /** Resolves once the hub has answered the attach. */
  whenAttached(): Promise<void> {
    if (this.snapshot.attached) return Promise.resolve();
    return new Promise((resolve) => this.attachedWaiters.push(resolve));
  }

  dismissRejection(): void {
    if (this.snapshot.rejection) this.publish({ rejection: null });
  }

  private publish(patch: Partial<ReplicaSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private installDoc(subdoc: Subdoc, doc: Y.Doc) {
    const onUpdate = (update: Uint8Array, origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
      if (origin === ReplicaOrigin.hub || this.destroyed) return;
      // Read now: the CodeMirror binding reuses one origin object, but `meta`
      // is fixed per transaction. The Visual bridge carries its provenance on
      // its origin instead.
      const provenance = provenanceForTransaction(transaction) ?? provenanceOfOrigin(origin) ?? (subdoc === "content" ? this.defaultProvenance : undefined);
      this.enqueue({ subdoc, update, ...(provenance ? { provenance } : {}) });
    };
    doc.on("update", onUpdate);
    this.docs.set(subdoc, doc);
    this.docListeners.set(subdoc, () => doc.off("update", onUpdate));
  }

  /* ---- Outgoing --------------------------------------------------------------- */

  private post(message: ReplicaToHub) {
    if (this.destroyed && message.t !== "detach") return;
    try {
      this.port.postMessage(message);
    } catch (error) {
      this.publish({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  private attach() {
    const stateVectors: Partial<Record<Subdoc, Uint8Array>> = {};
    for (const [subdoc, doc] of this.docs) stateVectors[subdoc] = Y.encodeStateVector(doc);
    this.post({ t: "attach", docId: this.docId, stateVectors });
  }

  private enqueue(entry: QueuedUpdate) {
    this.queue.push(entry);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.schedule(() => this.flush());
  }

  /** Sends every queued local update now (also called on pagehide and before detach). */
  flush(): void {
    this.flushScheduled = false;
    if (!this.queue.length || this.snapshot.closed) {
      this.queue = [];
      return;
    }
    const queued = this.queue;
    this.queue = [];
    // Consecutive updates of one sub-document with the same provenance merge
    // into one message; a change of provenance starts a new one, so the hub
    // records an AI edit apart from the typing around it.
    let index = 0;
    while (index < queued.length) {
      const first = queued[index];
      const group = [first.update];
      let next = index + 1;
      while (next < queued.length && queued[next].subdoc === first.subdoc && sameProvenance(queued[next].provenance, first.provenance)) {
        group.push(queued[next].update);
        next += 1;
      }
      const update = group.length === 1 ? group[0] : Y.mergeUpdates(group);
      this.post({ t: "update", docId: this.docId, subdoc: first.subdoc, update, ...(first.provenance ? { provenance: first.provenance } : {}) });
      index = next;
    }
  }

  private onAwarenessUpdate = (change: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === HUB_AWARENESS) return;
    const clients = [...change.added, ...change.updated, ...change.removed];
    if (!clients.length) return;
    this.post({ t: "awareness", docId: this.docId, update: encodeAwarenessUpdate(this.awareness, clients) });
  };

  /* ---- Incoming --------------------------------------------------------------- */

  private receive(message: HubToReplica) {
    if (this.destroyed || message.docId !== this.docId) return;
    switch (message.t) {
      case "state":
      case "update": {
        const doc = this.docs.get(message.subdoc);
        if (!doc) return;
        try {
          Y.applyUpdate(doc, message.update, ReplicaOrigin.hub);
        } catch (error) {
          this.publish({ error: `Invalid update from the host: ${String(error)}` });
        }
        return;
      }
      case "awareness":
        try {
          applyAwarenessUpdate(this.awareness, message.update, HUB_AWARENESS);
        } catch {
          // Presence is best effort; a malformed state is dropped.
        }
        return;
      case "meta":
        this.publish({ meta: message.meta });
        return;
      case "status": {
        const firstStatus = !this.snapshot.attached;
        this.publish({ status: message.status, attached: true });
        if (firstStatus) for (const resolve of this.attachedWaiters.splice(0)) resolve();
        return;
      }
      case "rejected":
        this.handleRejected(message.subdoc, message.reason, message.rejectedText ?? "");
        return;
      case "closed":
        this.queue = [];
        this.publish({ closed: message.reason });
        return;
      case "error":
        this.publish({ error: message.message });
        return;
    }
  }

  /**
   * The server refused an update and the hub rolled the sub-document back
   * (plan M1.8). Local state for it is now garbage: replace the Y.Doc, drop
   * its queued updates, tell bindings to rebind, and attach again so the hub
   * sends its (reloaded) state. The refused text stays for the banner.
   */
  private handleRejected(subdoc: Subdoc, reason: string, rejectedText: string) {
    const rejection: ReplicaRejection = { subdoc, reason, rejectedText };
    const key = JSON.stringify(rejection);
    if (this.handledRejections.has(key) || !this.docs.has(subdoc)) {
      this.publish({ rejection });
      return;
    }
    this.handledRejections.add(key);
    this.queue = this.queue.filter((entry) => entry.subdoc !== subdoc);
    this.docListeners.get(subdoc)?.();
    const old = this.docs.get(subdoc);
    this.installDoc(subdoc, new Y.Doc());
    old?.destroy();
    this.publish({ rejection, generation: subdoc === "content" ? this.snapshot.generation + 1 : this.snapshot.generation });
    for (const listener of [...this.rebuildListeners]) listener(subdoc);
    this.attach();
  }

  /* ---- Lifecycle ---------------------------------------------------------------- */

  get isDestroyed(): boolean { return this.destroyed; }

  /** Sends what is queued, withdraws this window's presence, detaches and closes the port. */
  destroy(): void {
    if (this.destroyed) return;
    this.flush();
    if (this.awareness.getLocalState() !== null) removeAwarenessStates(this.awareness, [this.awareness.clientID], "local");
    this.destroyed = true;
    this.post({ t: "detach", docId: this.docId });
    this.port.removeEventListener("message", this.onPortMessage);
    try { this.port.close(); } catch { /* already closed */ }
    this.awareness.off("update", this.onAwarenessUpdate);
    this.awareness.destroy();
    for (const unsubscribe of this.docListeners.values()) unsubscribe();
    for (const doc of this.docs.values()) doc.destroy();
    this.listeners.clear();
    this.rebuildListeners.clear();
  }
}

/** Opens a replica of `docId` over `port` and attaches it to the hub. */
export function openReplica(docId: string, port: ReplicaMessagePort, options?: ReplicaOptions): CollabReplica {
  return new CollabReplica(docId, port, options);
}

/** Whether live documents can be attached in this window (`window.liberaCollab` exists unless collaboration is turned off with LIBERA_COLLAB=0). */
export function isLiveCollabAvailable(): boolean {
  return getCollabBridge() !== null;
}

/**
 * Opens a replica through `window.liberaCollab.attach` (Electron's preload).
 * Resolves to null when the bridge is missing: collaboration is off in this
 * window and the file behaves like any other.
 */
export async function attachShared(docId: string, options?: ReplicaOptions): Promise<CollabReplica | null> {
  const bridge = getCollabBridge();
  if (!bridge) return null;
  const port = await bridge.attach(docId);
  return openReplica(docId, port as unknown as ReplicaMessagePort, options);
}
