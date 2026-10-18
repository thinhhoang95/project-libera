// One load-generator worker thread: simulated collaborators for a share of
// the documents. Every client of a document lives in the same worker, so
// fan-out latency (one client's send to another client's receive) is
// measured on one clock.
//
// A client is one WebSocket speaking the sync protocol like the desktop host:
// hello, open with state vectors, updates with increasing clientSeq, pings
// every 20 s, and y-protocols awareness (heartbeat every 15 s, cursor moves
// while typing). Typists type in bursts; the others only keep presence.

import { randomBytes } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";

import { WebSocket } from "ws";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

import { decodeMessage, encodeMessage, MessageType, PROTOCOL_VERSION, SyncLimits, type ClientMessage } from "../../src/protocol.js";
import { Histogram, type SerializedHistogram } from "./histogram.js";

export interface WorkerClient {
  token: string;
  name: string;
  typist: boolean;
}

export interface WorkerDoc {
  docId: string;
  clients: WorkerClient[];
}

export interface WorkerInput {
  wsUrl: string;
  docs: WorkerDoc[];
  /** Characters per second while a typist is in a burst. */
  cps: number;
  burstSeconds: [number, number];
  pauseSeconds: [number, number];
  /** New sockets per second for this worker. */
  connectRate: number;
  /** Apply remote updates on every client (true) or on typists only. */
  applyAllRemotes: boolean;
}

export interface WorkerStats {
  clients: number;
  connected: number;
  opened: number;
  connectFailures: number;
  unexpectedCloses: Record<string, number>;
  sent: number;
  acked: number;
  rejected: Record<string, number>;
  errors: Record<string, number>;
  remotes: number;
  awarenessSent: number;
  awarenessReceived: number;
  bytesSent: number;
  bytesReceived: number;
  unacked: number;
  ack: SerializedHistogram;
  fanout: SerializedHistogram;
  open: SerializedHistogram;
  loopDelayP99Ms: number;
}

type ToWorker = { type: "measure" } | { type: "stop" };
type FromWorker =
  | { type: "progress"; connected: number; opened: number }
  | { type: "ready"; stats: WorkerStats }
  | { type: "stats"; stats: WorkerStats };

const input = workerData as WorkerInput;
const port = parentPort;
if (!port) throw new Error("worker.ts must run as a worker thread");

const LOCAL = Symbol("local");
const ack = new Histogram();
const fanout = new Histogram();
const open = new Histogram();
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

const stats = {
  connected: 0,
  opened: 0,
  connectFailures: 0,
  unexpectedCloses: {} as Record<string, number>,
  sent: 0,
  acked: 0,
  rejected: {} as Record<string, number>,
  errors: {} as Record<string, number>,
  remotes: 0,
  awarenessSent: 0,
  awarenessReceived: 0,
  bytesSent: 0,
  bytesReceived: 0,
};
let stopping = false;
let typing = false;

const bump = (record: Record<string, number>, key: string) => (record[key] = (record[key] ?? 0) + 1);
const between = ([min, max]: [number, number]) => (min + Math.random() * (max - min)) * 1000;

/** Send times of each client's updates, for fan-out latency on the receivers. */
interface DocState {
  docId: string;
  sends: Map<string, number[]>;
  clients: Client[];
}

class Client {
  readonly clientId = `load_${randomBytes(9).toString("base64url")}`;
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  ws: WebSocket | undefined;
  seq = 0;
  readonly pending = new Map<number, number>();
  /** Per sender: how many of its updates this client has received. */
  readonly seen = new Map<string, number>();
  cursor = 0;
  isOpen = false;
  private timers: NodeJS.Timeout[] = [];
  private lastAwareness = 0;

  constructor(
    readonly state: DocState,
    readonly spec: WorkerClient,
  ) {
    this.awareness.setLocalStateField("user", { name: spec.name, color: "#2563eb" });
    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin !== "local" || !this.isOpen) return;
      const changed = [...added, ...updated, ...removed];
      this.send({ type: MessageType.Awareness, docId: this.state.docId, update: encodeAwarenessUpdate(this.awareness, changed) });
      stats.awarenessSent += 1;
    });
  }

  send(message: ClientMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const frame = encodeMessage(message);
    stats.bytesSent += frame.byteLength;
    this.ws.send(frame);
  }

  connect(): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(input.wsUrl, { perMessageDeflate: false });
      this.ws = ws;
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const openedAt = performance.now();
      ws.on("open", () => {
        stats.connected += 1;
        this.send({ type: MessageType.Hello, protocolVersion: PROTOCOL_VERSION, appVersion: "load", token: this.spec.token, clientId: this.clientId });
      });
      ws.on("message", (data: Buffer) => {
        stats.bytesReceived += data.byteLength;
        const message = decodeMessage(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        switch (message.type) {
          case MessageType.Welcome:
            this.send({ type: MessageType.Open, docId: this.state.docId, subdocs: [] });
            break;
          case MessageType.Opened:
            for (const entry of message.subdocs) if (entry.subdoc === "content") Y.applyUpdate(this.doc, entry.diff);
            this.isOpen = true;
            stats.opened += 1;
            open.record(performance.now() - openedAt);
            this.cursor = Math.floor(Math.random() * this.text().length);
            // Announce presence (the awareness heartbeat renews it every 15 s).
            this.awareness.setLocalStateField("cursor", { index: this.cursor });
            this.startTimers();
            done();
            break;
          case MessageType.Ack: {
            const sentAt = this.pending.get(message.clientSeq);
            if (sentAt !== undefined) {
              ack.record(performance.now() - sentAt);
              this.pending.delete(message.clientSeq);
            }
            stats.acked += 1;
            break;
          }
          case MessageType.Reject:
            this.pending.delete(message.clientSeq);
            bump(stats.rejected, message.reason);
            break;
          case MessageType.Remote: {
            stats.remotes += 1;
            if (message.subdoc === "content" && (input.applyAllRemotes || this.spec.typist)) Y.applyUpdate(this.doc, message.update);
            const sends = this.state.sends.get(message.clientId);
            if (sends) {
              const index = this.seen.get(message.clientId) ?? 0;
              this.seen.set(message.clientId, index + 1);
              const sentAt = sends[index];
              if (sentAt !== undefined) fanout.record(performance.now() - sentAt);
            }
            break;
          }
          case MessageType.Awareness:
            stats.awarenessReceived += 1;
            break;
          case MessageType.Error:
            bump(stats.errors, message.code);
            break;
          case MessageType.Closed:
            bump(stats.errors, `closed:${message.reason}`);
            break;
          default:
            break;
        }
      });
      ws.on("error", () => {
        if (!settled) stats.connectFailures += 1;
        done();
      });
      ws.on("close", (code) => {
        this.isOpen = false;
        this.stopTimers();
        if (!stopping) bump(stats.unexpectedCloses, String(code));
        done();
      });
    });
  }

  text(): string {
    return this.doc.getText("source").toString();
  }

  private startTimers(): void {
    this.timers.push(setInterval(() => this.send({ type: MessageType.Ping, nonce: Date.now() % 1_000_000 }), SyncLimits.pingIntervalMs));
    if (this.spec.typist) this.scheduleBurst(between(input.pauseSeconds));
  }

  private stopTimers(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.awareness.destroy();
  }

  /** Alternates bursts of typing at `cps` with pauses. */
  private scheduleBurst(delay: number): void {
    const timer = setTimeout(() => {
      if (!this.isOpen || stopping) return;
      const until = performance.now() + between(input.burstSeconds);
      const tick = () => {
        if (!this.isOpen || stopping) return;
        if (typing) this.keystroke();
        if (performance.now() < until) {
          this.timers.push(setTimeout(tick, (1000 / input.cps) * (0.5 + Math.random())));
        } else {
          this.scheduleBurst(between(input.pauseSeconds));
        }
      };
      tick();
    }, delay);
    this.timers.push(timer);
  }

  private keystroke(): void {
    const text = this.doc.getText("source");
    const length = text.length;
    this.cursor = Math.min(this.cursor, length);
    let update: Uint8Array | undefined;
    const capture = (bytes: Uint8Array, origin: unknown) => {
      if (origin === LOCAL) update = bytes;
    };
    this.doc.on("update", capture);
    this.doc.transact(() => {
      if (Math.random() < 0.1 && this.cursor > 0) {
        text.delete(this.cursor - 1, 1);
        this.cursor -= 1;
      } else {
        const char = Math.random() < 0.17 ? " " : String.fromCharCode(97 + Math.floor(Math.random() * 26));
        text.insert(this.cursor, char);
        this.cursor += 1;
      }
    }, LOCAL);
    this.doc.off("update", capture);
    if (!update) return;
    this.seq += 1;
    const now = performance.now();
    this.pending.set(this.seq, now);
    let sends = this.state.sends.get(this.clientId);
    if (!sends) {
      sends = [];
      this.state.sends.set(this.clientId, sends);
    }
    sends.push(now);
    stats.sent += 1;
    this.send({ type: MessageType.Update, docId: this.state.docId, subdoc: "content", clientSeq: this.seq, update });
    // The cursor moves with the text; presence follows at most twice a second.
    if (now - this.lastAwareness > 500) {
      this.lastAwareness = now;
      this.awareness.setLocalStateField("cursor", { index: this.cursor });
    }
  }

  close(): void {
    this.stopTimers();
    this.ws?.close();
  }
}

function snapshot(): WorkerStats {
  let unacked = 0;
  for (const state of docs) for (const client of state.clients) unacked += client.pending.size;
  return {
    clients: docs.reduce((sum, state) => sum + state.clients.length, 0),
    ...structuredClone(stats),
    unacked,
    ack: ack.serialize(),
    fanout: fanout.serialize(),
    open: open.serialize(),
    loopDelayP99Ms: loop.percentile(99) / 1e6,
  };
}

const docs: DocState[] = input.docs.map((doc) => {
  const state: DocState = { docId: doc.docId, sends: new Map(), clients: [] };
  state.clients = doc.clients.map((spec) => new Client(state, spec));
  return state;
});

function post(message: FromWorker): void {
  port?.postMessage(message);
}

async function connectAll(): Promise<void> {
  const all = docs.flatMap((state) => state.clients);
  const gap = 1000 / input.connectRate;
  const started = performance.now();
  const opens: Promise<void>[] = [];
  for (let index = 0; index < all.length; index += 1) {
    const wait = started + index * gap - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    opens.push(all[index].connect());
    if (index % 50 === 0) post({ type: "progress", connected: stats.connected, opened: stats.opened });
  }
  await Promise.all(opens);
}

port.on("message", (message: ToWorker) => {
  if (message.type === "measure") {
    // Steady state starts now: drop what the ramp-up recorded.
    ack.reset();
    fanout.reset();
    loop.reset();
    for (const key of ["sent", "acked", "remotes", "awarenessSent", "awarenessReceived", "bytesSent", "bytesReceived"] as const) stats[key] = 0;
    stats.rejected = {};
    stats.errors = {};
  } else if (message.type === "stop") {
    typing = false;
    // Give in-flight acks and remotes a moment, then report and close.
    setTimeout(() => {
      const final = snapshot();
      stopping = true;
      for (const state of docs) for (const client of state.clients) client.close();
      post({ type: "stats", stats: final });
      setTimeout(() => process.exit(0), 500).unref();
    }, 3000);
  }
});

await connectAll();
typing = true;
post({ type: "ready", stats: snapshot() });
