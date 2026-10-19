// One room per open document: the live Y.Docs of its sub-documents, the
// awareness relay, and the queue that serializes every write to it.

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";

import { encodeMessage, MessageType, type Subdoc } from "../protocol.js";
import type { DocumentKind, LoadedDocument } from "./store.js";
import { PREDEFINED_MAPS, type ChangedTypes } from "./validate.js";

/** Runs tasks one at a time in submission order. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Resolves once everything queued so far has finished. */
  async whenIdle(): Promise<void> {
    await this.tail;
  }
}

/** A socket that has the document open. */
export interface RoomMember {
  sendFrame(frame: Uint8Array): void;
}

export class DocumentMissingError extends Error {
  constructor(docId: string) {
    super(`Document ${docId} does not exist.`);
    this.name = "DocumentMissingError";
  }
}

export class InvalidUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUpdateError";
  }
}

/** Origin of updates the server applies to live documents. */
export const SERVER_ORIGIN = Symbol("libera-server");
const PROBE_ORIGIN = Symbol("libera-probe");
const AWARENESS_SERVER_ORIGIN = "server";

function predefine(doc: Y.Doc, subdoc: Subdoc): void {
  // An update that references a root type nobody has asked for yet creates a
  // placeholder, and the changed-types map would point at that placeholder
  // instead of the Y.Map the validators read.
  for (const name of PREDEFINED_MAPS[subdoc] ?? []) doc.getMap(name);
}

export class Room {
  readonly queue = new SerialQueue();
  readonly awareness: Awareness;
  /** Sockets with the document open, and the awareness clientIDs each introduced. */
  readonly members = new Map<RoomMember, Set<number>>();
  readonly ready: Promise<void>;

  projectId = "";
  kind: DocumentKind = "manifest";
  schemaVersion = 1;
  /** Highest serverSeq applied to the live documents. */
  serverSeq = 0;
  readonly docs = new Map<Subdoc, Y.Doc>();
  /**
   * Probe copies, kept in step with the live documents so validating an
   * update costs the size of the update, not of the document. A probe is
   * dropped whenever it may differ from the live document (a rejected or
   * unpersisted update, an aborted server change) and rebuilt on next use.
   */
  private readonly shadows = new Map<Subdoc, Y.Doc>();

  /** Open sockets plus in-flight server operations; the room unloads at zero. */
  refs = 0;
  disposed = false;
  idleTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly docId: string,
    load: () => Promise<LoadedDocument | null>,
  ) {
    this.awareness = new Awareness(new Y.Doc());
    // The server relays presence; it has none of its own.
    this.awareness.setLocalState(null);
    this.awareness.on("update", this.onAwarenessUpdate);

    this.ready = this.queue.run(async () => {
      const loaded = await load();
      if (!loaded) throw new DocumentMissingError(docId);
      this.projectId = loaded.projectId;
      this.kind = loaded.kind;
      this.schemaVersion = loaded.schemaVersion;
      this.serverSeq = loaded.serverSeq;
      for (const [subdoc, doc] of loaded.docs) {
        predefine(doc, subdoc);
        this.docs.set(subdoc, doc);
      }
    });
    // Callers await `ready`; this only keeps a failed load from being reported as unhandled.
    this.ready.catch(() => undefined);
  }

  hasSubdoc(subdoc: Subdoc): boolean {
    return this.docs.has(subdoc);
  }

  live(subdoc: Subdoc): Y.Doc {
    const doc = this.docs.get(subdoc);
    if (!doc) throw new Error(`${this.docId} has no ${subdoc} sub-document.`);
    return doc;
  }

  shadow(subdoc: Subdoc): Y.Doc {
    let shadow = this.shadows.get(subdoc);
    if (!shadow) {
      shadow = new Y.Doc();
      Y.applyUpdate(shadow, Y.encodeStateAsUpdate(this.live(subdoc)));
      predefine(shadow, subdoc);
      this.shadows.set(subdoc, shadow);
    }
    return shadow;
  }

  discardShadow(subdoc: Subdoc): void {
    this.shadows.get(subdoc)?.destroy();
    this.shadows.delete(subdoc);
  }

  /**
   * Applies a client update to the probe and reports which keys changed.
   * Throws InvalidUpdateError (and drops the probe) when the update does not
   * decode or depends on changes the server does not have.
   */
  probe(subdoc: Subdoc, update: Uint8Array): ChangedTypes {
    const shadow = this.shadow(subdoc);
    const changed: ChangedTypes = new Map();
    const collect = (transaction: Y.Transaction) => {
      for (const [type, keys] of transaction.changed) {
        const entry = changed.get(type) ?? new Set<string | null>();
        for (const key of keys) entry.add(key);
        changed.set(type, entry);
      }
    };
    shadow.on("afterTransaction", collect);
    try {
      Y.applyUpdate(shadow, update, PROBE_ORIGIN);
    } catch (error) {
      this.discardShadow(subdoc);
      throw new InvalidUpdateError(`Update does not decode: ${(error as Error).message}`);
    } finally {
      shadow.off("afterTransaction", collect);
    }
    if (shadow.store.pendingStructs !== null || shadow.store.pendingDs !== null) {
      // Persisting it would store an update no replica can integrate until
      // some other, unknown update arrives.
      this.discardShadow(subdoc);
      throw new InvalidUpdateError("Update depends on changes the server does not have.");
    }
    return changed;
  }

  /** Applies a persisted update to the live document. The probe already has it. */
  commit(subdoc: Subdoc, update: Uint8Array, serverSeq: number): void {
    Y.applyUpdate(this.live(subdoc), update, SERVER_ORIGIN);
    this.serverSeq = serverSeq;
  }

  broadcast(frame: Uint8Array, except?: RoomMember): void {
    for (const member of this.members.keys()) if (member !== except) member.sendFrame(frame);
  }

  join(member: RoomMember): void {
    if (!this.members.has(member)) this.members.set(member, new Set());
  }

  /** Removes the member and the awareness states it introduced (broadcast to the rest). */
  leave(member: RoomMember): void {
    const owned = this.members.get(member);
    if (!owned) return;
    this.members.delete(member);
    if (owned.size > 0) removeAwarenessStates(this.awareness, [...owned], AWARENESS_SERVER_ORIGIN);
  }

  /**
   * Applies a member's awareness update. Entries for clientIDs another member
   * introduced are dropped, so one socket cannot overwrite or remove someone
   * else's cursor. Throws when the update does not decode.
   */
  applyAwareness(member: RoomMember, update: Uint8Array): void {
    const foreign = new Set<number>();
    for (const [other, owned] of this.members) if (other !== member) for (const id of owned) foreign.add(id);
    const decoder = decoding.createDecoder(update);
    const encoder = encoding.createEncoder();
    const count = decoding.readVarUint(decoder);
    const kept: Array<[number, number, string]> = [];
    for (let index = 0; index < count; index += 1) {
      const clientId = decoding.readVarUint(decoder);
      const clock = decoding.readVarUint(decoder);
      const state = decoding.readVarString(decoder);
      JSON.parse(state);
      if (!foreign.has(clientId)) kept.push([clientId, clock, state]);
    }
    if (decoding.hasContent(decoder)) throw new Error("Trailing bytes in awareness update.");
    if (kept.length === 0) return;
    encoding.writeVarUint(encoder, kept.length);
    for (const [clientId, clock, state] of kept) {
      encoding.writeVarUint(encoder, clientId);
      encoding.writeVarUint(encoder, clock);
      encoding.writeVarString(encoder, state);
    }
    applyAwarenessUpdate(this.awareness, encoding.toUint8Array(encoder), member);
  }

  /** Every current awareness state, or null when there are none. */
  awarenessSnapshot(): Uint8Array | null {
    const clients = [...this.awareness.getStates().keys()];
    return clients.length > 0 ? encodeAwarenessUpdate(this.awareness, clients) : null;
  }

  private readonly onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    const owner = this.members.get(origin as RoomMember);
    if (owner) for (const id of [...added, ...updated]) owner.add(id);
    for (const id of removed) for (const owned of this.members.values()) owned.delete(id);
    // Heartbeats (updated with the same state) are relayed too: they keep
    // the 30 s awareness timeout from firing on the other clients.
    const changed = [...added, ...updated, ...removed];
    if (changed.length === 0 || this.disposed) return;
    const frame = encodeMessage({
      type: MessageType.Awareness,
      docId: this.docId,
      update: encodeAwarenessUpdate(this.awareness, changed),
    });
    this.broadcast(frame, owner ? (origin as RoomMember) : undefined);
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.idleTimer);
    this.awareness.off("update", this.onAwarenessUpdate);
    this.awareness.destroy();
    this.awareness.doc.destroy();
    for (const doc of this.docs.values()) doc.destroy();
    for (const doc of this.shadows.values()) doc.destroy();
    this.shadows.clear();
    this.members.clear();
  }
}
