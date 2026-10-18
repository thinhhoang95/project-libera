// In-process fake sync server for host tests, built only from the protocol
// codec and yjs (the real server is developed separately). Sockets are
// in-memory WebSocketLike objects; every frame is encoded and decoded, so the
// binary path is exercised. Knobs let tests ack, hold, drop, reject and
// disconnect.

import * as Y from "yjs";

import {
  decodeMessage,
  encodeMessage,
  MessageType,
  type ClientMessage,
  type ClosedReason,
  type RejectReason,
  type ServerMessage,
  type UpdateMessage,
} from "../../../src/lib/collab/protocol/messages";
import type { Role, Subdoc } from "../../../src/lib/collab/protocol/roles";
import type { WebSocketLike } from "../../../electron/collab/core/sync-client";

interface SubdocState {
  doc: Y.Doc;
  log: { serverSeq: number; update: Uint8Array; clientId: string; clientSeq: number | null }[];
}

interface DocState {
  subdocs: Map<Subdoc, SubdocState>;
  serverSeq: number;
}

export class FakeSocket implements WebSocketLike {
  binaryType = "blob";
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  clientId = "";
  token = "";
  authed = false;
  readonly openDocs = new Set<string>();
  readonly received: ClientMessage[] = [];

  constructor(
    private readonly server: FakeSyncServer,
    readonly url: string,
  ) {
    setImmediate(() => {
      if (this.readyState !== 0) return;
      if (server.refuseConnections) {
        this.readyState = 3;
        this.onclose?.({ code: 1006, reason: "refused" });
        return;
      }
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data: Uint8Array): void {
    if (this.readyState !== 1) throw new Error("socket not open");
    const copy = new Uint8Array(data);
    setImmediate(() => {
      if (this.readyState === 1) this.server.receive(this, copy);
    });
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.server.forget(this);
    setImmediate(() => this.onclose?.({ code, reason }));
  }

  /** Server → client frame. */
  push(message: ServerMessage): void {
    if (this.readyState !== 1) return;
    const bytes = encodeMessage(message);
    setImmediate(() => {
      if (this.readyState === 1) this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    });
  }

  /** Server-initiated close. */
  serverClose(code: number, reason = ""): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.server.forget(this);
    setImmediate(() => this.onclose?.({ code, reason }));
  }
}

export interface RejectRule {
  reason: RejectReason;
  match?: (message: UpdateMessage) => boolean;
  /** Reject every matching update rather than just the next one. */
  sticky?: boolean;
}

export class FakeSyncServer {
  /** Tokens accepted at hello; an empty set accepts any non-empty token. */
  readonly validTokens = new Set<string>();
  minProtocolVersion = 1;
  role: Role = "editor";
  schemaVersion = 1;
  projectId = "p1";
  userId = "u1";
  refuseConnections = false;
  /** Close code sent right after hello instead of welcome. */
  closeOnHello: number | null = null;
  holdAcks = false;
  respondToPing = true;
  /** Updates to swallow without applying or acking. */
  dropNext = 0;
  readonly rejectRules: RejectRule[] = [];
  /** Docs whose `open` is answered with closed{reason}. */
  readonly closedDocs = new Map<string, ClosedReason>();
  readonly sockets: FakeSocket[] = [];
  readonly docs = new Map<string, DocState>();
  /** Every client message received, in order. */
  readonly received: ClientMessage[] = [];
  helloCount = 0;
  private readonly heldAcks: Array<() => void> = [];
  private readonly dedupe = new Map<string, number>();

  readonly factory = (url: string): WebSocketLike => {
    const socket = new FakeSocket(this, url);
    this.sockets.push(socket);
    return socket;
  };

  get liveSockets(): FakeSocket[] {
    return this.sockets.filter((socket) => socket.readyState === 1);
  }

  forget(socket: FakeSocket): void {
    socket.openDocs.clear();
  }

  docState(docId: string): DocState {
    let state = this.docs.get(docId);
    if (!state) {
      state = { subdocs: new Map(), serverSeq: 0 };
      this.docs.set(docId, state);
    }
    return state;
  }

  subdoc(docId: string, subdoc: Subdoc): SubdocState {
    const state = this.docState(docId);
    let entry = state.subdocs.get(subdoc);
    if (!entry) {
      entry = { doc: new Y.Doc(), log: [] };
      state.subdocs.set(subdoc, entry);
    }
    return entry;
  }

  text(docId: string, subdoc: Subdoc = "content"): string {
    return this.subdoc(docId, subdoc).doc.getText("source").toString();
  }

  updates(): UpdateMessage[] {
    return this.received.filter((message): message is UpdateMessage => message.type === MessageType.Update);
  }

  releaseAcks(): void {
    this.holdAcks = false;
    for (const send of this.heldAcks.splice(0)) send();
  }

  disconnectAll(code = 1006, reason = "test disconnect"): void {
    for (const socket of this.liveSockets) socket.serverClose(code, reason);
  }

  /** Revokes access to a doc for every open socket and future opens. */
  revoke(docId: string, reason: ClosedReason = "access-revoked"): void {
    this.closedDocs.set(docId, reason);
    for (const socket of this.liveSockets) {
      if (socket.openDocs.delete(docId)) socket.push({ type: MessageType.Closed, docId, reason });
    }
  }

  /** Another user's edit, persisted and fanned out as `remote`. */
  remoteEdit(docId: string, subdoc: Subdoc, edit: (doc: Y.Doc) => void, userId = "u2", clientId = "other"): number {
    const entry = this.subdoc(docId, subdoc);
    const updates: Uint8Array[] = [];
    const listener = (update: Uint8Array) => updates.push(update);
    entry.doc.on("update", listener);
    entry.doc.transact(() => edit(entry.doc));
    entry.doc.off("update", listener);
    const update = Y.mergeUpdates(updates);
    const state = this.docState(docId);
    state.serverSeq += 1;
    entry.log.push({ serverSeq: state.serverSeq, update, clientId, clientSeq: null });
    for (const socket of this.liveSockets) {
      if (socket.openDocs.has(docId)) {
        socket.push({ type: MessageType.Remote, docId, subdoc, serverSeq: state.serverSeq, update, userId, clientId });
      }
    }
    return state.serverSeq;
  }

  sendEvent(kind: string, payload: unknown, id = "u1"): void {
    for (const socket of this.liveSockets) socket.push({ type: MessageType.Event, scope: "user", id, kind, payload });
  }

  receive(socket: FakeSocket, bytes: Uint8Array): void {
    const message = decodeMessage(bytes) as ClientMessage;
    this.received.push(message);
    socket.received.push(message);
    switch (message.type) {
      case MessageType.Hello: {
        this.helloCount += 1;
        socket.clientId = message.clientId;
        socket.token = message.token;
        if (message.protocolVersion < this.minProtocolVersion) return socket.serverClose(4026, "client too old");
        if (this.closeOnHello !== null) return socket.serverClose(this.closeOnHello, "closed on hello");
        if (!message.token || (this.validTokens.size > 0 && !this.validTokens.has(message.token))) {
          return socket.serverClose(4001, "token expired");
        }
        socket.authed = true;
        socket.push({
          type: MessageType.Welcome,
          protocolVersion: 1,
          minProtocolVersion: this.minProtocolVersion,
          userId: this.userId,
          serverTime: Date.now(),
        });
        return;
      }
      case MessageType.Ping:
        if (this.respondToPing) socket.push({ type: MessageType.Pong, nonce: message.nonce });
        return;
      case MessageType.RefreshToken:
        socket.token = message.token;
        return;
      case MessageType.Open: {
        const closed = this.closedDocs.get(message.docId);
        if (closed) {
          socket.push({ type: MessageType.Closed, docId: message.docId, reason: closed });
          return;
        }
        socket.openDocs.add(message.docId);
        const state = this.docState(message.docId);
        socket.push({
          type: MessageType.Opened,
          docId: message.docId,
          projectId: this.projectId,
          role: this.role,
          schemaVersion: this.schemaVersion,
          serverSeq: state.serverSeq,
          subdocs: message.subdocs.map((entry) => {
            const doc = this.subdoc(message.docId, entry.subdoc).doc;
            return {
              subdoc: entry.subdoc,
              diff: Y.encodeStateAsUpdate(doc, entry.stateVector),
              stateVector: Y.encodeStateVector(doc),
            };
          }),
        });
        return;
      }
      case MessageType.Update:
        this.handleUpdate(socket, message);
        return;
      case MessageType.Awareness:
        for (const other of this.liveSockets) {
          if (other !== socket && other.openDocs.has(message.docId)) {
            other.push({ type: MessageType.Awareness, docId: message.docId, update: message.update });
          }
        }
        return;
      case MessageType.Close:
        socket.openDocs.delete(message.docId);
        socket.push({ type: MessageType.Closed, docId: message.docId, reason: "client-closed" });
        return;
    }
  }

  private handleUpdate(socket: FakeSocket, message: UpdateMessage): void {
    if (this.dropNext > 0) {
      this.dropNext -= 1;
      return;
    }
    const ruleIndex = this.rejectRules.findIndex((rule) => !rule.match || rule.match(message));
    if (ruleIndex >= 0) {
      const rule = this.rejectRules[ruleIndex];
      if (!rule.sticky) this.rejectRules.splice(ruleIndex, 1);
      socket.push({
        type: MessageType.Reject,
        docId: message.docId,
        subdoc: message.subdoc,
        clientSeq: message.clientSeq,
        reason: rule.reason,
        message: `rejected: ${rule.reason}`,
      });
      return;
    }
    const key = `${message.docId}|${socket.clientId}|${message.clientSeq}`;
    let serverSeq = this.dedupe.get(key);
    if (serverSeq === undefined) {
      const entry = this.subdoc(message.docId, message.subdoc);
      Y.applyUpdate(entry.doc, message.update);
      const state = this.docState(message.docId);
      state.serverSeq += 1;
      serverSeq = state.serverSeq;
      entry.log.push({ serverSeq, update: message.update, clientId: socket.clientId, clientSeq: message.clientSeq });
      this.dedupe.set(key, serverSeq);
      for (const other of this.liveSockets) {
        if (other !== socket && other.openDocs.has(message.docId)) {
          other.push({
            type: MessageType.Remote,
            docId: message.docId,
            subdoc: message.subdoc,
            serverSeq,
            update: message.update,
            userId: this.userId,
            clientId: socket.clientId,
            ...(message.provenance ? { provenance: message.provenance } : {}),
          });
        }
      }
    }
    const ackSeq = serverSeq;
    const sendAck = () =>
      socket.push({
        type: MessageType.Ack,
        docId: message.docId,
        subdoc: message.subdoc,
        clientSeq: message.clientSeq,
        serverSeq: ackSeq,
      });
    if (this.holdAcks) this.heldAcks.push(sendAck);
    else sendAck();
  }

  /** Number of distinct (clientId, clientSeq) pairs applied for a doc. */
  appliedCount(docId: string): number {
    let count = 0;
    for (const key of this.dedupe.keys()) if (key.startsWith(`${docId}|`)) count += 1;
    return count;
  }
}
