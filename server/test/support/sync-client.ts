// A headless sync client for tests: one WebSocket, Y.Docs per (doc, subdoc),
// remote updates applied as they arrive, and helpers to wait for frames.

import { randomBytes } from "node:crypto";

import { WebSocket } from "ws";
import * as Y from "yjs";

import {
  decodeMessage,
  encodeMessage,
  MessageType,
  PROTOCOL_VERSION,
  type AckMessage,
  type ClientMessage,
  type OpenedMessage,
  type Provenance,
  type RejectMessage,
  type Subdoc,
  type SyncMessage,
  type WelcomeMessage,
} from "../../src/protocol.js";

const LOCAL = Symbol("local");
const REMOTE = Symbol("remote");

export function newClientId(): string {
  return `cli_${randomBytes(12).toString("base64url")}`;
}

interface Waiter {
  predicate: (message: SyncMessage) => boolean;
  resolve: (message: SyncMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ConnectOptions {
  token: string;
  clientId?: string;
  protocolVersion?: number;
  /** Skip sending hello (tests of the hello timeout and first-frame rules). */
  skipHello?: boolean;
}

export interface SentUpdate {
  docId: string;
  subdoc: Subdoc;
  clientSeq: number;
  update: Uint8Array;
  provenance?: Provenance;
}

export class SyncTestClient {
  readonly received: SyncMessage[] = [];
  readonly docs = new Map<string, Map<Subdoc, Y.Doc>>();
  readonly closed: Promise<{ code: number; reason: string }>;
  closeCode: number | undefined;
  welcome: WelcomeMessage | undefined;
  /** Remote frames applied to the local docs, in arrival order. */
  readonly remotes: SyncMessage[] = [];

  private readonly taken = new Set<SyncMessage>();
  private waiters: Waiter[] = [];
  private seq = 0;

  private constructor(
    readonly ws: WebSocket,
    readonly clientId: string,
  ) {
    this.closed = new Promise((resolve) => {
      ws.on("close", (code, reason) => {
        this.closeCode = code;
        for (const waiter of this.waiters) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error(`Socket closed (${code} ${reason.toString()}) while waiting`));
        }
        this.waiters = [];
        resolve({ code, reason: reason.toString() });
      });
    });
    ws.on("error", () => undefined);
    ws.on("message", (data: Buffer) => this.onFrame(new Uint8Array(data)));
  }

  static async connect(url: string, options: ConnectOptions): Promise<SyncTestClient> {
    const ws = new WebSocket(url);
    const client = new SyncTestClient(ws, options.clientId ?? newClientId());
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      ws.once("close", () => resolve());
    });
    if (options.skipHello || ws.readyState !== ws.OPEN) return client;
    client.send({
      type: MessageType.Hello,
      protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
      appVersion: "test",
      token: options.token,
      clientId: client.clientId,
    });
    await Promise.race([client.waitFor((m) => m.type === MessageType.Welcome).catch(() => undefined), client.closed]);
    client.welcome = client.received.find((m): m is WelcomeMessage => m.type === MessageType.Welcome);
    return client;
  }

  private onFrame(bytes: Uint8Array): void {
    const message = decodeMessage(bytes);
    if (message.type === MessageType.Remote) {
      Y.applyUpdate(this.doc(message.docId, message.subdoc), message.update, REMOTE);
      this.remotes.push(message);
    }
    this.received.push(message);
    const waiter = this.waiters.find((candidate) => candidate.predicate(message));
    if (waiter) {
      this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
      clearTimeout(waiter.timer);
      this.taken.add(message);
      waiter.resolve(message);
    }
  }

  send(message: ClientMessage): void {
    this.ws.send(encodeMessage(message));
  }

  sendRaw(data: Uint8Array | string): void {
    this.ws.send(data);
  }

  /** Waits for the first matching frame not already returned by an earlier wait. */
  waitFor<T extends SyncMessage = SyncMessage>(predicate: (message: SyncMessage) => boolean, timeoutMs = 5000): Promise<T> {
    const existing = this.received.find((message) => !this.taken.has(message) && predicate(message));
    if (existing) {
      this.taken.add(existing);
      return Promise.resolve(existing as T);
    }
    if (this.closeCode !== undefined) return Promise.reject(new Error(`Socket already closed (${this.closeCode})`));
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve: resolve as (message: SyncMessage) => void,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
          reject(new Error("Timed out waiting for a frame"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /** Resolves true if a matching frame arrives within `ms`, without consuming it. */
  async sees(predicate: (message: SyncMessage) => boolean, ms = 300): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.received.some(predicate)) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.received.some(predicate);
  }

  doc(docId: string, subdoc: Subdoc): Y.Doc {
    let subdocs = this.docs.get(docId);
    if (!subdocs) {
      subdocs = new Map();
      this.docs.set(docId, subdocs);
    }
    let doc = subdocs.get(subdoc);
    if (!doc) {
      doc = new Y.Doc();
      subdocs.set(subdoc, doc);
    }
    return doc;
  }

  text(docId: string): string {
    return this.doc(docId, "content").getText("source").toString();
  }

  /** Opens a document with the local state vectors and applies the diffs. */
  async open(docId: string): Promise<OpenedMessage> {
    const local = this.docs.get(docId);
    this.send({
      type: MessageType.Open,
      docId,
      subdocs: [...(local ?? new Map<Subdoc, Y.Doc>())].map(([subdoc, doc]) => ({
        subdoc,
        stateVector: Y.encodeStateVector(doc),
      })),
    });
    const opened = await this.waitFor<SyncMessage>(
      (m) => (m.type === MessageType.Opened || m.type === MessageType.Closed) && m.docId === docId,
    );
    if (opened.type !== MessageType.Opened) throw new Error(`Open refused: ${JSON.stringify(opened)}`);
    for (const entry of opened.subdocs) Y.applyUpdate(this.doc(docId, entry.subdoc), entry.diff, REMOTE);
    return opened;
  }

  /**
   * What a real client does after a reject: drop the local replica and load
   * the server's state again (source plan §4).
   */
  rollback(docId: string): Promise<OpenedMessage> {
    this.docs.delete(docId);
    return this.open(docId);
  }

  /** Applies `change` locally and sends the resulting update with the next clientSeq. */
  edit(docId: string, subdoc: Subdoc, change: (doc: Y.Doc) => void, provenance?: Provenance): SentUpdate {
    const doc = this.doc(docId, subdoc);
    let update: Uint8Array | undefined;
    const capture = (bytes: Uint8Array, origin: unknown) => {
      if (origin === LOCAL) update = bytes;
    };
    doc.on("update", capture);
    doc.transact(() => change(doc), LOCAL);
    doc.off("update", capture);
    if (!update) throw new Error("The change produced no update");
    return this.sendUpdate({ docId, subdoc, clientSeq: this.nextSeq(), update, provenance });
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  sendUpdate(sent: SentUpdate): SentUpdate {
    this.send({ type: MessageType.Update, ...sent });
    return sent;
  }

  /** Waits for the ack or reject of one update. */
  result(sent: { docId: string; clientSeq: number }, timeoutMs = 5000): Promise<AckMessage | RejectMessage> {
    return this.waitFor<AckMessage | RejectMessage>(
      (m) =>
        (m.type === MessageType.Ack || m.type === MessageType.Reject) &&
        m.docId === sent.docId &&
        m.clientSeq === sent.clientSeq,
      timeoutMs,
    );
  }

  async acked(sent: { docId: string; clientSeq: number }): Promise<AckMessage> {
    const result = await this.result(sent);
    if (result.type !== MessageType.Ack) throw new Error(`Expected ack, got reject: ${result.reason} ${result.message}`);
    return result;
  }

  async rejected(sent: { docId: string; clientSeq: number }): Promise<RejectMessage> {
    const result = await this.result(sent);
    if (result.type !== MessageType.Reject) throw new Error(`Expected reject, got ack ${result.serverSeq}`);
    return result;
  }

  async close(): Promise<void> {
    if (this.closeCode === undefined) this.ws.close();
    await this.closed;
  }
}
