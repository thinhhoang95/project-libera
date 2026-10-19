// Chaos proxy: a pure Node TCP proxy between collab hosts and the server, so
// the harness can inject network faults without Docker or Toxiproxy (source
// plan §11 "Chaos").
//
// Every simulated client gets its own ProxyLink with its own listen port, so
// faults can target one client (a partition of Alice) while the rest keep
// working. A link forwards raw TCP, so HTTP (token refresh, REST) and the
// sync WebSocket both go through it and fail together, as they do on a real
// network.
//
// Faults, all switchable at runtime:
// - latency (one way) with jitter, and a bandwidth cap per direction; order
//   is preserved, as on one TCP stream;
// - stall: hold every byte (or one direction's) until resume, e.g. a
//   congested link, or acks held back while updates still arrive;
// - blackhole: accept and keep connections open but never forward a byte
//   (a dead Wi-Fi after a network switch: the socket looks alive);
// - partition: reset existing connections and reset every new one at once;
// - reset now, or at random intervals;
// - frame-level duplication and reordering on the sync WebSocket. The proxy
//   parses WebSocket frames after the upgrade, so it can repeat a whole
//   `update` (client to server) or `remote`/`ack` (server to client) frame,
//   or swap two server frames, without corrupting the byte stream.

import { connect, createServer, type Server, type Socket } from "node:net";

import { MessageType } from "../../../src/lib/collab/protocol/messages";

export interface LinkConditions {
  /** One-way delay added to every chunk; a round trip costs twice this. */
  latencyMs: number;
  /** Extra random delay in [0, jitterMs) per chunk, never reordering bytes. */
  jitterMs: number;
  /** Per-direction throughput cap, or null for unlimited. */
  bandwidthBytesPerSec: number | null;
  /** Probability that a sync data frame (update, remote, ack) is sent twice. */
  duplicateRate: number;
  /** Probability that a server frame is held back and sent after the next one. */
  reorderRate: number;
}

export const IDEAL_CONDITIONS: LinkConditions = {
  latencyMs: 0,
  jitterMs: 0,
  bandwidthBytesPerSec: null,
  duplicateRate: 0,
  reorderRate: 0,
};

export interface LinkStats {
  connections: number;
  resets: number;
  bytesUp: number;
  bytesDown: number;
  droppedBytes: number;
  duplicatedFrames: number;
  reorderedFrames: number;
}

export type Direction = "up" | "down";

/** Client frames whose duplication the protocol must tolerate. */
const DUPLICABLE_UP = new Set<number>([MessageType.Update]);
/** Server frames whose duplication or reordering the client must tolerate. */
const DUPLICABLE_DOWN = new Set<number>([MessageType.Remote, MessageType.Ack]);
const REORDERABLE_DOWN = new Set<number>([MessageType.Remote]);
/** A held frame is released after this long even if no next frame comes. */
const REORDER_HOLD_MS = 25;

interface Frame {
  bytes: Buffer;
  /** First payload byte of a final binary frame (the sync message type), else null. */
  messageType: number | null;
}

/**
 * Splits one direction of a connection into forwardable units: the HTTP
 * head and any non-WebSocket traffic pass through as raw chunks; after a
 * WebSocket upgrade, complete frames.
 */
class StreamSplitter {
  private mode: "head" | "raw" | "frames" = "head";
  private buffer: Buffer = Buffer.alloc(0);

  constructor(
    private readonly direction: Direction,
    private readonly onHead: (head: string) => "raw" | "frames",
  ) {}

  /** Switches the upstream splitter to frames once the server accepted the upgrade. */
  forceMode(mode: "raw" | "frames"): void {
    if (this.mode === "head") return;
    this.mode = mode;
  }

  push(chunk: Buffer): Frame[] {
    if (this.mode === "raw") return [{ bytes: chunk, messageType: null }];
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: Frame[] = [];
    if (this.mode === "head") {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        // Heads are small; anything this large is not HTTP we understand.
        if (this.buffer.length > 64 * 1024) {
          this.mode = "raw";
          out.push({ bytes: this.buffer, messageType: null });
          this.buffer = Buffer.alloc(0);
        }
        return out;
      }
      const head = this.buffer.subarray(0, end + 4);
      out.push({ bytes: head, messageType: null });
      this.buffer = this.buffer.subarray(end + 4);
      this.mode = this.onHead(head.toString("latin1"));
      if (this.mode === "raw") {
        if (this.buffer.length > 0) out.push({ bytes: this.buffer, messageType: null });
        this.buffer = Buffer.alloc(0);
        return out;
      }
    }
    for (;;) {
      const frame = this.nextFrame();
      if (!frame) break;
      out.push(frame);
    }
    return out;
  }

  private nextFrame(): Frame | null {
    const buffer = this.buffer;
    if (buffer.length < 2) return null;
    const fin = (buffer[0] & 0x80) !== 0;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return null;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return null;
      length = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }
    const maskOffset = offset;
    if (masked) offset += 4;
    const total = offset + length;
    if (buffer.length < total) return null;
    let messageType: number | null = null;
    if (fin && opcode === 2 && length > 0) {
      messageType = buffer[offset] ^ (masked ? buffer[maskOffset] : 0);
    }
    // Copy: the frame may be queued while the buffer is reused.
    const bytes = Buffer.from(buffer.subarray(0, total));
    this.buffer = buffer.subarray(total);
    return { bytes, messageType };
  }

  get isFrames(): boolean {
    return this.mode === "frames";
  }

  get directionName(): Direction {
    return this.direction;
  }
}

/** Delays and forwards one direction of one connection, in order. */
class Pipe {
  private readonly queue: Array<{ bytes: Buffer; at: number }> = [];
  private lastAt = 0;
  private wireFreeAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private held: { frame: Frame; timer: NodeJS.Timeout } | null = null;
  private ending = false;
  private ended = false;

  constructor(
    private readonly link: ProxyLink,
    private readonly direction: Direction,
    private readonly target: () => Socket | null,
    readonly splitter: StreamSplitter,
    private readonly isDead: () => boolean,
  ) {}

  private get dropping(): boolean {
    return this.link.isBlackholed || this.isDead();
  }

  push(chunk: Buffer): void {
    if (this.dropping) {
      this.link.stats.droppedBytes += chunk.length;
      return;
    }
    for (const frame of this.splitter.push(chunk)) this.route(frame);
  }

  private route(frame: Frame): void {
    const conditions = this.link.conditions;
    const random = this.link.random;
    if (this.direction === "down" && this.held) {
      // Send the newer frame first, then the one held back.
      const held = this.held;
      this.held = null;
      clearTimeout(held.timer);
      this.forward(frame);
      this.forward(held.frame);
      return;
    }
    if (
      this.direction === "down" &&
      frame.messageType !== null &&
      REORDERABLE_DOWN.has(frame.messageType) &&
      conditions.reorderRate > 0 &&
      random() < conditions.reorderRate
    ) {
      this.link.stats.reorderedFrames += 1;
      this.held = {
        frame,
        timer: setTimeout(() => {
          const held = this.held;
          this.held = null;
          if (held) this.forward(held.frame);
        }, REORDER_HOLD_MS),
      };
      return;
    }
    this.forward(frame);
  }

  private forward(frame: Frame): void {
    this.enqueue(frame.bytes);
    const duplicable = this.direction === "up" ? DUPLICABLE_UP : DUPLICABLE_DOWN;
    if (
      frame.messageType !== null &&
      duplicable.has(frame.messageType) &&
      this.link.conditions.duplicateRate > 0 &&
      this.link.random() < this.link.conditions.duplicateRate
    ) {
      this.link.stats.duplicatedFrames += 1;
      // A WebSocket frame is self-contained (masking is per frame), so the
      // receiver sees the same message twice.
      this.enqueue(Buffer.from(frame.bytes));
    }
  }

  private enqueue(bytes: Buffer): void {
    const conditions = this.link.conditions;
    const now = Date.now();
    let at = now + conditions.latencyMs + (conditions.jitterMs > 0 ? this.link.random() * conditions.jitterMs : 0);
    if (conditions.bandwidthBytesPerSec) {
      const start = Math.max(now, this.wireFreeAt);
      this.wireFreeAt = start + (bytes.length * 1000) / conditions.bandwidthBytesPerSec;
      at = Math.max(at, this.wireFreeAt + conditions.latencyMs);
    }
    // One TCP stream never reorders bytes: jitter only stretches gaps.
    at = Math.max(at, this.lastAt);
    this.lastAt = at;
    this.queue.push({ bytes, at });
    this.pump();
  }

  /** Forwards everything that is due, then waits for the next item. */
  pump(): void {
    if (this.timer) return;
    while (this.queue.length > 0) {
      if (this.link.isStalledFor(this.direction)) return;
      if (this.dropping) {
        for (const item of this.queue) this.link.stats.droppedBytes += item.bytes.length;
        this.queue.length = 0;
        break;
      }
      const next = this.queue[0];
      const wait = next.at - Date.now();
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.pump();
        }, wait);
        return;
      }
      this.queue.shift();
      const socket = this.target();
      if (!socket || socket.destroyed) continue;
      if (this.direction === "up") this.link.stats.bytesUp += next.bytes.length;
      else this.link.stats.bytesDown += next.bytes.length;
      socket.write(next.bytes);
    }
    if (this.ending && !this.ended && this.queue.length === 0 && !this.held) {
      this.ended = true;
      const socket = this.target();
      if (socket && !socket.destroyed) socket.end();
    }
  }

  /** The source half-closed: end the target once queued bytes are out. */
  end(): void {
    if (this.held) {
      clearTimeout(this.held.timer);
      const held = this.held;
      this.held = null;
      this.forward(held.frame);
    }
    this.ending = true;
    this.pump();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.held) clearTimeout(this.held.timer);
    this.held = null;
    this.queue.length = 0;
  }
}

function hardReset(socket: Socket | null): void {
  if (!socket || socket.destroyed) return;
  const resettable = socket as Socket & { resetAndDestroy?: () => Socket };
  try {
    if (resettable.resetAndDestroy && !socket.connecting) resettable.resetAndDestroy();
    else socket.destroy();
  } catch {
    socket.destroy();
  }
}

class ProxiedConnection {
  upstream: Socket | null = null;
  /** Silently dead (network switched away): kept open, forwards nothing. */
  dead = false;
  private readonly up: Pipe;
  private readonly down: Pipe;
  private closed = false;

  constructor(
    private readonly link: ProxyLink,
    readonly client: Socket,
    target: { host: string; port: number },
    blackholed: boolean,
  ) {
    const downSplitter = new StreamSplitter("down", (head) => {
      const upgraded = /^HTTP\/1\.1 101/i.test(head);
      upSplitter.forceMode(upgraded ? "frames" : "raw");
      return upgraded ? "frames" : "raw";
    });
    // The request head decides provisionally; the response confirms.
    const upSplitter = new StreamSplitter("up", (head) => (/\r\nupgrade:\s*websocket/i.test(head) ? "frames" : "raw"));
    this.up = new Pipe(link, "up", () => this.upstream, upSplitter, () => this.dead);
    this.down = new Pipe(link, "down", () => this.client, downSplitter, () => this.dead);

    client.on("data", (chunk: Buffer) => this.up.push(chunk));
    client.on("end", () => this.up.end());
    client.on("error", () => this.reset());
    client.on("close", () => this.closeFrom("client"));

    if (blackholed) return; // Accept, hold the socket, forward nothing.
    const upstream = connect({ host: target.host, port: target.port, allowHalfOpen: true });
    upstream.setNoDelay(true);
    this.upstream = upstream;
    upstream.on("data", (chunk: Buffer) => this.down.push(chunk));
    upstream.on("end", () => this.down.end());
    // The server is down or reset us: the client sees a reset too.
    upstream.on("error", () => this.reset());
    upstream.on("close", () => this.closeFrom("upstream"));
  }

  private closeFrom(side: "client" | "upstream"): void {
    if (this.closed) return;
    if (side === "client") {
      this.closed = true;
      this.dispose();
      this.upstream?.destroy();
    } else if (this.client.destroyed) {
      this.closed = true;
      this.dispose();
    }
    // An upstream close after a clean end lets the down pipe drain first:
    // the close frame (e.g. 4001 or 4026) must still reach the client.
  }

  reset(): void {
    if (this.closed) return;
    this.closed = true;
    this.link.stats.resets += 1;
    this.dispose();
    hardReset(this.client);
    hardReset(this.upstream);
  }

  /** Re-runs queued forwarding (after a stall ends). */
  pump(): void {
    this.up.pump();
    this.down.pump();
  }

  private dispose(): void {
    this.up.dispose();
    this.down.dispose();
    this.link.forget(this);
  }
}

export class ProxyLink {
  readonly name: string;
  readonly stats: LinkStats = {
    connections: 0,
    resets: 0,
    bytesUp: 0,
    bytesDown: 0,
    droppedBytes: 0,
    duplicatedFrames: 0,
    reorderedFrames: 0,
  };
  conditions: LinkConditions = { ...IDEAL_CONDITIONS };
  random: () => number;
  private server: Server | null = null;
  private portNumber = 0;
  private readonly connections = new Set<ProxiedConnection>();
  private partitioned = false;
  private blackholed = false;
  private stalled: { up: boolean; down: boolean } = { up: false, down: false };
  private stallTimer: NodeJS.Timeout | null = null;
  private randomResetTimer: NodeJS.Timeout | null = null;

  constructor(
    name: string,
    private readonly target: () => { host: string; port: number },
    random: () => number = Math.random,
  ) {
    this.name = name;
    this.random = random;
  }

  async listen(port = 0): Promise<number> {
    const server = createServer({ allowHalfOpen: true, pauseOnConnect: false }, (socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    this.portNumber = typeof address === "object" && address ? address.port : 0;
    return this.portNumber;
  }

  get port(): number {
    return this.portNumber;
  }

  /** http:// origin of this link (REST and, with ws://, the sync socket). */
  get url(): string {
    return `http://127.0.0.1:${this.portNumber}`;
  }

  get isBlackholed(): boolean {
    return this.blackholed;
  }

  get isStalled(): boolean {
    return this.stalled.up || this.stalled.down;
  }

  isStalledFor(direction: Direction): boolean {
    return this.stalled[direction];
  }

  get isPartitioned(): boolean {
    return this.partitioned;
  }

  get openConnections(): number {
    return this.connections.size;
  }

  private accept(socket: Socket): void {
    socket.setNoDelay(true);
    if (this.partitioned) {
      this.stats.resets += 1;
      socket.on("error", () => undefined);
      hardReset(socket);
      return;
    }
    this.stats.connections += 1;
    this.connections.add(new ProxiedConnection(this, socket, this.target(), this.blackholed));
  }

  /** @internal */
  forget(connection: ProxiedConnection): void {
    this.connections.delete(connection);
  }

  /** Changes latency, jitter, bandwidth, duplication or reordering. */
  set(conditions: Partial<LinkConditions>): void {
    this.conditions = { ...this.conditions, ...conditions };
  }

  /** Resets every open connection (the client sees ECONNRESET). */
  reset(): void {
    for (const connection of [...this.connections]) connection.reset();
  }

  /** Cuts the client off: open connections reset, new ones reset on accept. */
  partition(): void {
    this.partitioned = true;
    this.reset();
  }

  /**
   * Accepts connections but forwards nothing in either direction, including
   * on connections that are already open (they look alive but are dead).
   */
  blackhole(): void {
    this.blackholed = true;
  }

  /**
   * A network switch: the connections open now go silently dead (they stay
   * open and forward nothing, like a socket on the old Wi-Fi), while new
   * connections work normally. Only a ping timeout or a nudge can notice.
   */
  killSilently(): void {
    for (const connection of this.connections) connection.dead = true;
  }

  /** Holds every byte (client to server "up", server to client "down", or both) until resume() or for `ms`. */
  stall(ms?: number, direction: Direction | "both" = "both"): void {
    this.stalled = { up: direction !== "down", down: direction !== "up" };
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = ms === undefined ? null : setTimeout(() => this.resume(), ms);
  }

  resume(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    this.stalled = { up: false, down: false };
    for (const connection of this.connections) connection.pump();
  }

  /** Lifts partition, blackhole and stall. Black-holed connections are reset (they lost data). */
  heal(): void {
    this.partitioned = false;
    if (this.blackholed) {
      this.blackholed = false;
      this.reset();
    }
    this.resume();
  }

  /** Resets the link's connections at random, on average every `meanMs`. */
  startRandomResets(meanMs: number): void {
    this.stopRandomResets();
    const schedule = () => {
      const delay = -Math.log(1 - this.random()) * meanMs;
      this.randomResetTimer = setTimeout(() => {
        this.reset();
        schedule();
      }, delay);
    };
    schedule();
  }

  stopRandomResets(): void {
    if (this.randomResetTimer) clearTimeout(this.randomResetTimer);
    this.randomResetTimer = null;
  }

  /** Back to an ideal network: no faults, no conditions. */
  clear(): void {
    this.stopRandomResets();
    this.conditions = { ...IDEAL_CONDITIONS };
    this.heal();
  }

  async close(): Promise<void> {
    this.stopRandomResets();
    if (this.stallTimer) clearTimeout(this.stallTimer);
    for (const connection of [...this.connections]) connection.reset();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A set of links to one upstream (the collab server), one per simulated client. */
export class ChaosProxy {
  private readonly links = new Map<string, ProxyLink>();
  private upstream: { host: string; port: number };

  constructor(
    upstream: { host?: string; port: number },
    private readonly random: () => number = Math.random,
  ) {
    this.upstream = { host: upstream.host ?? "127.0.0.1", port: upstream.port };
  }

  /** Points every link at a new upstream port; existing connections keep their old target. */
  retarget(port: number): void {
    this.upstream = { ...this.upstream, port };
  }

  async addLink(name: string): Promise<ProxyLink> {
    if (this.links.has(name)) throw new Error(`Link ${name} already exists`);
    const link = new ProxyLink(name, () => this.upstream, this.random);
    await link.listen();
    this.links.set(name, link);
    return link;
  }

  link(name: string): ProxyLink {
    const link = this.links.get(name);
    if (!link) throw new Error(`No link named ${name}`);
    return link;
  }

  all(): ProxyLink[] {
    return [...this.links.values()];
  }

  async removeLink(name: string): Promise<void> {
    const link = this.links.get(name);
    if (!link) return;
    this.links.delete(name);
    await link.close();
  }

  async close(): Promise<void> {
    await Promise.all([...this.links.values()].map((link) => link.close()));
    this.links.clear();
  }
}
