// Sync client: one WebSocket per server, multiplexing every acquired doc
// (protocol in src/lib/collab/protocol/messages.ts, plan M1.7).
//
// Connection: hello → welcome, then `open` for every registered hub with its
// state vectors. The hub applies `opened` diffs and sends what the server
// lacks through its outbound queue, so those bytes get clientSeqs and acks.
//
// Recovery:
// - Network loss, 4029, 4050, missing pong: exponential backoff with full
//   jitter; nudge() (resume, online) reconnects at once and resets it.
// - 4001: refresh the token and reconnect; a failed refresh means "needs
//   sign-in" while local editing continues.
// - 4002: signed out. 4026: update required. Neither reconnects by itself.

import { decodeMessage, encodeMessage, MessageType } from "../../../src/lib/collab/protocol/messages";
import type {
  AckMessage,
  ClientMessage,
  ClosedMessage,
  ErrorMessage,
  EventMessage,
  OpenedMessage,
  RejectMessage,
  RemoteMessage,
  ServerMessage,
  SubdocStateVector,
} from "../../../src/lib/collab/protocol/messages";
import { CloseCode, PROTOCOL_VERSION, SyncLimits } from "../../../src/lib/collab/protocol/version";
import type { Clock, Logger, TimerHandle } from "./clock";
import { Emitter, consoleLogger, systemClock } from "./clock";
import type { HubTransport } from "./doc-hub";

export interface TokenProvider {
  /** The current access token, or null when there is no session. */
  getAccessToken(): Promise<string | null>;
  /**
   * Gets a new access token. Resolves null when the session cannot be
   * refreshed (the user must sign in again); rejects on transient failures.
   */
  refresh(): Promise<string | null>;
  /** When the current access token expires (epoch ms), if known. */
  accessTokenExpiresAt?(): number | null;
}

/**
 * Wraps a provider so concurrent refresh() calls share one request.
 * Refresh tokens rotate, so two parallel refreshes would sign the user out.
 */
export function singleFlightTokenProvider(provider: TokenProvider): TokenProvider {
  let inFlight: Promise<string | null> | null = null;
  return {
    getAccessToken: () => provider.getAccessToken(),
    refresh: () => {
      if (!inFlight) {
        inFlight = provider.refresh().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
    ...(provider.accessTokenExpiresAt ? { accessTokenExpiresAt: () => provider.accessTokenExpiresAt?.() ?? null } : {}),
  };
}

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "backoff"
  | "needs-sign-in"
  | "signed-out"
  | "update-required"
  | "stopped";

/** The subset of the WHATWG WebSocket the client uses. */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const OPEN = 1;

export function defaultWebSocketFactory(url: string): WebSocketLike {
  const Constructor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Constructor) throw new Error("No global WebSocket in this runtime");
  return new Constructor(url);
}

/** What a registered document must handle; DocHub implements it. */
export interface SyncTarget {
  readonly docId: string;
  canSync(): boolean;
  stateVectors(): SubdocStateVector[];
  connectionChanged(transport: HubTransport | null, detail?: string): void;
  setConnectionDetail(detail: string | undefined): void;
  handleOpened(message: OpenedMessage): void;
  handleAck(message: AckMessage): void;
  handleReject(message: RejectMessage): void;
  handleRemote(message: RemoteMessage): void;
  handleAwareness(update: Uint8Array): void;
  handleClosed(message: ClosedMessage): void;
  handleError(message: ErrorMessage): void;
}

export type SyncClientEvent =
  | { type: "state"; state: ConnectionState; detail?: string }
  | { type: "welcome"; userId: string; serverTime: number; protocolVersion: number }
  /** A server EventMessage (threads, decisions, roles, notifications). */
  | { type: "server-event"; event: EventMessage }
  | { type: "update-required"; minProtocolVersion: number | null }
  | { type: "needs-sign-in" }
  | { type: "signed-out" }
  | { type: "error"; code: string; message: string; docId: string };

export interface SyncClientOptions {
  /** wss:// URL of the sync endpoint. */
  url: string;
  appVersion: string;
  /** Stable id of this installation + account. */
  clientId: string;
  tokenProvider: TokenProvider;
  webSocketFactory?: WebSocketFactory;
  clock?: Clock;
  /** Returns [0, 1); injected for deterministic backoff tests. */
  random?: () => number;
  logger?: Logger;
  limits?: Partial<Record<"backoffBaseMs" | "backoffMaxMs" | "pingIntervalMs" | "maxFrameBytes", number>>;
  /** No welcome within this long drops the socket. */
  connectTimeoutMs?: number;
  /** How long a nudge() waits for a pong on an existing socket. */
  nudgePongTimeoutMs?: number;
  /** Refresh the access token this long before it expires. */
  refreshLeadMs?: number;
}

function detailFor(state: ConnectionState): string | undefined {
  switch (state) {
    case "needs-sign-in":
      return "Sign in to sync.";
    case "signed-out":
      return "Signed out.";
    case "update-required":
      return "Update Libera to keep syncing.";
    default:
      return undefined;
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export class SyncClient {
  readonly url: string;
  private readonly options: SyncClientOptions;
  private readonly factory: WebSocketFactory;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly logger: Logger;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly pingIntervalMs: number;
  private readonly maxFrameBytes: number;
  private readonly targets = new Map<string, SyncTarget>();
  private readonly events = new Emitter<SyncClientEvent>();
  private socket: WebSocketLike | null = null;
  private welcomed = false;
  private state: ConnectionState = "idle";
  private attempt = 0;
  private authFailures = 0;
  private generation = 0;
  private nonce = 0;
  private awaitingPong: number | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private pingTimer: TimerHandle | null = null;
  private connectTimer: TimerHandle | null = null;
  private nudgeTimer: TimerHandle | null = null;
  private refreshTimer: TimerHandle | null = null;
  private transports = new Map<string, HubTransport>();
  /** The delay chosen for the last scheduled reconnect (diagnostics, tests). */
  lastBackoffMs: number | null = null;
  userId: string | null = null;

  constructor(options: SyncClientOptions) {
    this.options = options;
    this.url = options.url;
    this.factory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
    this.logger = options.logger ?? consoleLogger;
    this.backoffBaseMs = options.limits?.backoffBaseMs ?? SyncLimits.backoffBaseMs;
    this.backoffMaxMs = options.limits?.backoffMaxMs ?? SyncLimits.backoffMaxMs;
    this.pingIntervalMs = options.limits?.pingIntervalMs ?? SyncLimits.pingIntervalMs;
    this.maxFrameBytes = options.limits?.maxFrameBytes ?? SyncLimits.maxFrameBytes;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  private isStopped(): boolean {
    return this.state === "stopped";
  }

  get connected(): boolean {
    return this.state === "connected";
  }

  on(listener: (event: SyncClientEvent) => void): () => void {
    return this.events.on(listener);
  }

  start(): void {
    if (this.state !== "idle" && this.state !== "stopped") return;
    this.setState("idle");
    void this.connect();
  }

  stop(): void {
    this.setState("stopped");
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    this.welcomed = false;
    if (socket) {
      this.detachSocket(socket);
      try {
        socket.close(CloseCode.Normal, "client stopped");
      } catch {
        // Already closed.
      }
    }
    this.disconnectTargets(undefined);
  }

  /** Resume / online: reconnect now with a fresh backoff, or check a live socket. */
  nudge(): void {
    switch (this.state) {
      case "stopped":
      case "signed-out":
      case "update-required":
        return;
      case "connecting":
        // A handshake started before a network switch can hang without ever
        // failing. A nudge means the network just changed: start over now.
        this.drop("nudge while connecting");
        this.restartNow();
        return;
      case "connected": {
        // After sleep a socket can look open but be dead: ask for a pong soon.
        if (this.nudgeTimer) return;
        const nonce = ++this.nonce;
        this.awaitingPong = nonce;
        this.sendFrame({ type: MessageType.Ping, nonce });
        this.nudgeTimer = this.clock.setTimeout(() => {
          this.nudgeTimer = null;
          if (this.awaitingPong === nonce) this.drop("no pong after nudge");
        }, this.options.nudgePongTimeoutMs ?? 1500);
        return;
      }
      default:
        this.restartNow();
    }
  }

  private restartNow(): void {
    this.attempt = 0;
    this.authFailures = 0;
    if (this.reconnectTimer) this.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    void this.connect();
  }

  /** Another component refreshed the token: hand it to the live socket. */
  async tokenChanged(): Promise<void> {
    if (this.state === "needs-sign-in") {
      this.nudge();
      return;
    }
    if (!this.connected) return;
    const token = await this.options.tokenProvider.getAccessToken();
    if (token && this.connected) this.sendFrame({ type: MessageType.RefreshToken, token });
  }

  /** Registers a document; it is opened now if connected, and on every reconnect. */
  register(target: SyncTarget): () => void {
    this.targets.set(target.docId, target);
    if (this.connected && this.socket) {
      const transport = this.transportFor(this.socket, target);
      target.connectionChanged(transport);
      if (target.canSync()) this.sendOpen(target);
    } else {
      target.connectionChanged(null, detailFor(this.state));
    }
    return () => {
      if (this.targets.get(target.docId) !== target) return;
      this.targets.delete(target.docId);
      this.transports.delete(target.docId);
      if (this.connected) this.sendFrame({ type: MessageType.Close, docId: target.docId });
    };
  }

  // ------------------------------------------------------------ connection

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    const detail = detailFor(state);
    if (state !== "connected") for (const target of this.targets.values()) target.setConnectionDetail(detail);
    this.events.emit(detail ? { type: "state", state, detail } : { type: "state", state });
  }

  private async connect(): Promise<void> {
    if (this.state === "stopped") return;
    if (this.reconnectTimer) this.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const generation = ++this.generation;
    this.setState("connecting");
    let token: string | null;
    try {
      token = await this.options.tokenProvider.getAccessToken();
    } catch (error) {
      if (generation !== this.generation) return;
      this.logger.warn("Could not read the access token", error);
      this.scheduleReconnect();
      return;
    }
    if (generation !== this.generation || this.isStopped()) return;
    if (!token) {
      this.setState("needs-sign-in");
      this.events.emit({ type: "needs-sign-in" });
      return;
    }
    let socket: WebSocketLike;
    try {
      socket = this.factory(this.url);
    } catch (error) {
      this.logger.warn("Could not open the sync socket", error);
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.welcomed = false;
    this.connectTimer = this.clock.setTimeout(() => {
      this.connectTimer = null;
      if (this.socket === socket && !this.welcomed) this.drop("connect timeout");
    }, this.options.connectTimeoutMs ?? 15_000);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.sendRaw(socket, {
        type: MessageType.Hello,
        protocolVersion: PROTOCOL_VERSION,
        appVersion: this.options.appVersion,
        token,
        clientId: this.options.clientId,
      });
    };
    socket.onmessage = (event) => this.handleFrame(socket, event.data);
    socket.onclose = (event) => this.handleClose(socket, event.code, event.reason);
    socket.onerror = () => {
      // Not every implementation follows an error with close: Node's built-in
      // WebSocket (undici) fires only onerror for a refused or reset
      // handshake and stays CONNECTING. Treat the error as the end of this
      // socket so the next backoff tick (or a nudge) can try again.
      if (this.socket === socket) this.drop("socket error");
    };
  }

  private detachSocket(socket: WebSocketLike): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }

  /** Abandons the current socket as if the network dropped it. */
  private drop(reason: string): void {
    const socket = this.socket;
    if (!socket) return;
    this.logger.warn(`Dropping sync socket: ${reason}`);
    this.detachSocket(socket);
    try {
      socket.close(CloseCode.ProtocolError, reason);
    } catch {
      // Already closed.
    }
    this.handleClose(socket, 1006, reason);
  }

  private clearTimers(): void {
    for (const timer of [this.reconnectTimer, this.pingTimer, this.connectTimer, this.nudgeTimer, this.refreshTimer]) {
      if (timer) this.clock.clearTimeout(timer);
    }
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.connectTimer = null;
    this.nudgeTimer = null;
    this.refreshTimer = null;
    this.awaitingPong = null;
  }

  private disconnectTargets(detail: string | undefined): void {
    this.transports.clear();
    for (const target of this.targets.values()) target.connectionChanged(null, detail);
  }

  private handleClose(socket: WebSocketLike, code: number, reason: string): void {
    if (this.socket !== socket) return;
    this.detachSocket(socket);
    this.socket = null;
    this.welcomed = false;
    this.clearTimers();
    if (this.state === "stopped") return;
    this.disconnectTargets(undefined);
    switch (code) {
      case CloseCode.AuthExpired:
        void this.refreshAndReconnect();
        return;
      case CloseCode.AuthRevoked:
        this.setState("signed-out");
        this.events.emit({ type: "signed-out" });
        return;
      case CloseCode.ClientTooOld:
        this.setState("update-required");
        this.events.emit({ type: "update-required", minProtocolVersion: null });
        return;
      default:
        if (reason) this.logger.warn(`Sync socket closed (${code}): ${reason}`);
        this.scheduleReconnect();
    }
  }

  private async refreshAndReconnect(): Promise<void> {
    this.authFailures += 1;
    if (this.authFailures > 2) {
      // The server keeps refusing fresh tokens: stop hammering it.
      this.authFailures = 0;
      this.scheduleReconnect();
      return;
    }
    const generation = ++this.generation;
    this.setState("connecting");
    let token: string | null;
    try {
      token = await this.options.tokenProvider.refresh();
    } catch (error) {
      if (generation !== this.generation) return;
      this.logger.warn("Token refresh failed; retrying with backoff", error);
      this.scheduleReconnect();
      return;
    }
    if (generation !== this.generation || this.isStopped()) return;
    if (!token) {
      this.setState("needs-sign-in");
      this.events.emit({ type: "needs-sign-in" });
      return;
    }
    void this.connect();
  }

  private scheduleReconnect(): void {
    if (this.state === "stopped") return;
    const ceiling = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** this.attempt);
    const delay = Math.floor(this.random() * ceiling);
    this.attempt += 1;
    this.lastBackoffMs = delay;
    this.setState("backoff");
    if (this.reconnectTimer) this.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private schedulePing(): void {
    if (this.pingTimer) this.clock.clearTimeout(this.pingTimer);
    this.pingTimer = this.clock.setTimeout(() => {
      this.pingTimer = null;
      if (!this.connected) return;
      if (this.awaitingPong !== null) {
        this.drop("missing pong");
        return;
      }
      const nonce = ++this.nonce;
      this.awaitingPong = nonce;
      this.sendFrame({ type: MessageType.Ping, nonce });
      this.schedulePing();
    }, this.pingIntervalMs);
  }

  private scheduleTokenRefresh(): void {
    if (this.refreshTimer) this.clock.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    const expiresAt = this.options.tokenProvider.accessTokenExpiresAt?.() ?? null;
    if (expiresAt === null) return;
    // Refresh a minute early, but never more than half the token's remaining
    // life: with a short-lived token (or a skewed clock) a fixed lead would
    // schedule every refresh immediately and loop.
    const remaining = expiresAt - this.clock.now();
    const lead = Math.min(this.options.refreshLeadMs ?? 60_000, Math.max(0, remaining / 2));
    const delay = Math.max(1_000, remaining - lead);
    this.refreshTimer = this.clock.setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshLiveToken();
    }, delay);
  }

  private async refreshLiveToken(): Promise<void> {
    let token: string | null = null;
    try {
      token = await this.options.tokenProvider.refresh();
    } catch (error) {
      this.logger.warn("Background token refresh failed", error);
    }
    if (!this.connected) return;
    if (token) {
      this.sendFrame({ type: MessageType.RefreshToken, token });
      this.scheduleTokenRefresh();
    } else if (this.refreshTimer === null) {
      // Try again shortly; if the token really expires the server closes 4001.
      this.refreshTimer = this.clock.setTimeout(() => {
        this.refreshTimer = null;
        void this.refreshLiveToken();
      }, 30_000);
    }
  }

  // ------------------------------------------------------------ frames

  private sendRaw(socket: WebSocketLike, message: ClientMessage): boolean {
    if (socket.readyState !== OPEN) return false;
    const bytes = encodeMessage(message);
    if (bytes.length > this.maxFrameBytes) {
      this.logger.error(`Refusing to send a ${bytes.length}-byte frame (limit ${this.maxFrameBytes})`);
      return false;
    }
    try {
      socket.send(bytes);
      return true;
    } catch (error) {
      this.logger.warn("Sync send failed", error);
      return false;
    }
  }

  private sendFrame(message: ClientMessage): boolean {
    return this.socket && this.welcomed ? this.sendRaw(this.socket, message) : false;
  }

  private transportFor(socket: WebSocketLike, target: SyncTarget): HubTransport {
    const transport: HubTransport = {
      send: (message) => this.socket === socket && this.sendFrame(message),
      sendAwareness: (update) => {
        if (this.socket === socket) this.sendFrame({ type: MessageType.Awareness, docId: target.docId, update });
      },
      reopen: () => {
        if (this.socket === socket && this.targets.get(target.docId) === target && target.canSync()) this.sendOpen(target);
      },
    };
    this.transports.set(target.docId, transport);
    return transport;
  }

  private sendOpen(target: SyncTarget): void {
    this.sendFrame({ type: MessageType.Open, docId: target.docId, subdocs: target.stateVectors() });
  }

  private handleFrame(socket: WebSocketLike, data: unknown): void {
    if (this.socket !== socket) return;
    const bytes = toBytes(data);
    if (!bytes) {
      this.logger.warn("Ignoring a non-binary sync frame");
      return;
    }
    let message: ServerMessage;
    try {
      message = decodeMessage(bytes) as ServerMessage;
    } catch (error) {
      this.logger.warn("Ignoring an undecodable sync frame", error);
      return;
    }
    try {
      this.dispatch(socket, message);
    } catch (error) {
      this.logger.error(`Handling sync message ${message.type} failed`, error);
    }
  }

  private dispatch(socket: WebSocketLike, message: ServerMessage): void {
    switch (message.type) {
      case MessageType.Welcome:
        this.handleWelcome(socket, message.protocolVersion, message.minProtocolVersion, message.userId, message.serverTime);
        return;
      case MessageType.Pong:
        if (this.awaitingPong === message.nonce) this.awaitingPong = null;
        if (this.nudgeTimer && this.awaitingPong === null) {
          this.clock.clearTimeout(this.nudgeTimer);
          this.nudgeTimer = null;
        }
        return;
      case MessageType.Event:
        this.events.emit({ type: "server-event", event: message });
        return;
      case MessageType.Error:
        this.events.emit({ type: "error", code: message.code, message: message.message, docId: message.docId });
        if (message.code === "not-authenticated") {
          this.detachSocket(socket);
          try {
            socket.close(CloseCode.Normal, "not authenticated");
          } catch {
            // Already closed.
          }
          this.handleClose(socket, CloseCode.AuthExpired, message.message);
          return;
        }
        if (message.docId) this.targets.get(message.docId)?.handleError(message);
        return;
      default:
        break;
    }
    const target = this.targets.get(message.docId);
    if (!target) return;
    switch (message.type) {
      case MessageType.Opened:
        target.handleOpened(message);
        return;
      case MessageType.Ack:
        target.handleAck(message);
        return;
      case MessageType.Reject:
        target.handleReject(message);
        return;
      case MessageType.Remote:
        target.handleRemote(message);
        return;
      case MessageType.Awareness:
        target.handleAwareness(message.update);
        return;
      case MessageType.Closed:
        target.handleClosed(message);
        return;
    }
  }

  private handleWelcome(
    socket: WebSocketLike,
    protocolVersion: number,
    minProtocolVersion: number,
    userId: string,
    serverTime: number,
  ): void {
    if (minProtocolVersion > PROTOCOL_VERSION) {
      this.detachSocket(socket);
      try {
        socket.close(CloseCode.Normal, "client too old");
      } catch {
        // Already closed.
      }
      this.socket = null;
      this.clearTimers();
      this.disconnectTargets(detailFor("update-required"));
      this.setState("update-required");
      this.events.emit({ type: "update-required", minProtocolVersion });
      return;
    }
    if (this.connectTimer) this.clock.clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.welcomed = true;
    this.attempt = 0;
    this.authFailures = 0;
    this.lastBackoffMs = null;
    this.userId = userId;
    this.setState("connected");
    this.events.emit({ type: "welcome", userId, serverTime, protocolVersion });
    this.schedulePing();
    this.scheduleTokenRefresh();
    for (const target of this.targets.values()) {
      target.connectionChanged(this.transportFor(socket, target));
      if (target.canSync()) this.sendOpen(target);
    }
  }
}
