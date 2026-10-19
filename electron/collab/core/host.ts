// CollabHost: the facade the Electron adapter and the control API use.
// It wires the store, the hub registry, the sync and REST clients, the
// pending command queue, compaction, and the Phase 4 operations pieces:
// the divergence check, telemetry and the diagnostics journal.
// Plain Node: no Electron imports.

import { createHash } from "node:crypto";

import * as Y from "yjs";

import { ApiRoutes } from "../../../src/lib/collab/protocol/api";
import type { DivergenceRecord } from "../../../src/lib/collab/ui/diagnostics-types";
import { SyncLimits } from "../../../src/lib/collab/protocol/version";
import { ApiClient, type FetchLike } from "./api-client";
import type { Clock, Logger } from "./clock";
import { Emitter, consoleLogger, systemClock } from "./clock";
import { CommandOutcomes } from "./command-outcomes";
import { Compactor, type CompactorOptions } from "./compaction";
import { DivergenceChecker, type DivergenceCheckerOptions } from "./divergence";
import { DocHub, type RejectedEdit, type ReplicaConnection } from "./doc-hub";
import { PendingCommands, type PendingCommandEvent } from "./pending-commands";
import type { ReplicaPort } from "./ports";
import { DocHubRegistry, type AcquireOptions } from "./registry";
import { HostStore } from "./store";
import {
  SyncClient,
  singleFlightTokenProvider,
  type ConnectionState,
  type SyncClientEvent,
  type SyncTarget,
  type TokenProvider,
  type WebSocketFactory,
} from "./sync-client";
import {
  HostJournal,
  TelemetryReporter,
  journaledLogger,
  openRunLedger,
  type RunLedger,
  type TelemetryGauges,
  type TelemetryReporterOptions,
} from "./telemetry";

export interface CollabAccount {
  accountId: string;
  /** https:// origin of the collab server. */
  serverUrl: string;
  /** Sync endpoint; defaults to serverUrl with a ws(s) scheme and /sync. */
  syncUrl?: string;
  tokenProvider: TokenProvider;
}

export interface CollabHostOptions {
  /** SQLite file, normally userData/collab/<accountId>.sqlite. */
  dbPath: string;
  appVersion: string;
  /** Stable per installation; combined with the account id into the sync clientId. */
  installationId: string;
  clock?: Clock;
  random?: () => number;
  logger?: Logger;
  webSocketFactory?: WebSocketFactory;
  fetch?: FetchLike;
  /** Delay before an unreferenced hub closes. */
  hubIdleMs?: number;
  limits?: Partial<Record<keyof typeof SyncLimits, number>>;
  /** Compaction settings, or false to disable local snapshots. */
  compaction?: Omit<CompactorOptions, "store" | "logger"> | false;
  connectTimeoutMs?: number;
  /** How long a nudge waits for a pong before replacing a live-looking socket. */
  nudgePongTimeoutMs?: number;
  /** Telemetry schedule (tests shorten it), or false for no reports. */
  telemetry?: Pick<TelemetryReporterOptions, "initialDelayMs" | "intervalMs" | "minIntervalMs"> | false;
  /** Divergence-check schedule, or false for no periodic checks (on-demand checks still work). */
  divergence?: Pick<DivergenceCheckerOptions, "intervalMs" | "retryMs" | "recentMs" | "recoveryTimeoutMs"> | false;
}

export type CollabHostEvent =
  | { source: "sync"; event: SyncClientEvent }
  | { source: "commands"; event: PendingCommandEvent }
  | { source: "doc"; docId: string; kind: "rejected"; edit: RejectedEdit }
  /** A divergence check found the replica differing from the server (record.recovered says how it ended). */
  | { source: "divergence"; docId: string; record: DivergenceRecord };

/** Empty state vector: `open` with it makes the server send the document's whole state. */
const EMPTY_STATE_VECTOR = Y.encodeStateVector(new Y.Doc());

/**
 * The server accepts client ids of 8–80 characters from [A-Za-z0-9_-] and
 * dedupes updates per (doc, clientId, clientSeq), so the id must be stable
 * for one installation and account across restarts.
 */
export function syncClientId(installationId: string, accountId: string): string {
  const digest = createHash("sha256").update(`${installationId}\u0000${accountId}`).digest("base64url");
  return `host_${digest.slice(0, 32)}`;
}

function syncUrlFor(account: CollabAccount): string {
  if (account.syncUrl) return account.syncUrl;
  const url = new URL(ApiRoutes.sync, account.serverUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

/** True when the server answers GET /healthz (any 2xx); used while it refuses sync connections. */
async function probeServer(serverUrl: string, fetchImpl?: FetchLike): Promise<boolean> {
  const doFetch = fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  try {
    const response = await doFetch(new URL(ApiRoutes.health, serverUrl).toString(), { method: "GET", signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

export class CollabHost {
  private readonly options: CollabHostOptions;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly events = new Emitter<CollabHostEvent>();
  private storeInstance: HostStore | null = null;
  private registryInstance: DocHubRegistry | null = null;
  private compactor: Compactor | null = null;
  private commandsInstance: PendingCommands | null = null;
  private outcomesInstance: CommandOutcomes | null = null;
  private syncClient: SyncClient | null = null;
  private apiClient: ApiClient | null = null;
  private account: CollabAccount | null = null;
  private readonly syncRegistrations = new Map<DocHub, () => void>();
  /** Docs held open only to push unacknowledged local work to the server. */
  private readonly background = new Map<string, () => void>();
  private stopping: Promise<void> | null = null;
  /** Connection history, recent errors and counters for diagnostics and telemetry. */
  readonly journal: HostJournal;
  private divergenceInstance: DivergenceChecker | null = null;
  private telemetryInstance: TelemetryReporter | null = null;
  private runLedger: RunLedger | null = null;

  constructor(options: CollabHostOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.journal = new HostJournal(this.clock);
    this.logger = journaledLogger(options.logger ?? consoleLogger, this.journal);
  }

  // ------------------------------------------------------------ lifecycle

  /** Opens the database (throws HostStoreLockedError if another host owns it). */
  start(): void {
    if (this.storeInstance) return;
    const store = new HostStore({ path: this.options.dbPath, now: () => this.clock.now() });
    this.storeInstance = store;
    this.compactor =
      this.options.compaction === false
        ? null
        : new Compactor({ store, logger: this.logger, ...(this.options.compaction ?? {}) });
    this.registryInstance = new DocHubRegistry({
      clock: this.clock,
      logger: this.logger,
      idleMs: this.options.hubIdleMs,
      create: (docId, acquireOptions) => this.createHub(docId, acquireOptions),
    });
    this.commandsInstance = new PendingCommands({
      store,
      clock: this.clock,
      random: this.options.random,
      logger: this.logger,
      backoffBaseMs: this.options.limits?.backoffBaseMs,
      backoffMaxMs: this.options.limits?.backoffMaxMs,
    });
    this.commandsInstance.on((event) => {
      if (event.type === "settled" && !event.ok) {
        this.journal.noteError({
          source: "command",
          code: event.error?.code ?? `http-${event.status}`,
          message: `${event.kind} was refused${event.error?.message ? `: ${event.error.message}` : "."}`,
        });
      }
      this.events.emit({ source: "commands", event });
    });
    this.outcomesInstance = new CommandOutcomes(this.commandsInstance, () => this.clock.now());
    this.runLedger = openRunLedger(this.options.dbPath, () => this.clock.now());
    if (this.runLedger.previousRunUnclean) {
      this.journal.noteHostRestart();
      this.logger.warn("The previous collaboration host on this database did not stop cleanly.");
    }
    this.divergenceInstance = new DivergenceChecker({
      host: {
        api: () => this.apiClient,
        store: () => this.store,
        openHub: (docId) => this.registryInstance?.get(docId) ?? null,
        openDocIds: () => (this.registryInstance?.hubs() ?? []).map((hub) => hub.docId),
        acquire: (docId) => this.acquire(docId),
        release: (docId) => this.release(docId),
        reopenFull: (hub, timeoutMs) => this.reopenFull(hub, timeoutMs),
      },
      clock: this.clock,
      logger: this.logger,
      ...(this.options.divergence || {}),
      onRecord: (record) => {
        this.journal.noteDivergence(record);
        if (record.outcome === "mismatch") this.events.emit({ source: "divergence", docId: record.docId, record });
      },
    });
    if (this.options.divergence !== false) this.divergenceInstance.start();
    this.telemetryInstance = new TelemetryReporter({
      source: {
        api: () => this.apiClient,
        clientId: () => (this.account ? syncClientId(this.options.installationId, this.account.accountId) : null),
        gauges: () => this.telemetryGauges(),
      },
      journal: this.journal,
      appVersion: this.options.appVersion,
      clock: this.clock,
      logger: this.logger,
      ...(this.options.telemetry || {}),
    });
    if (this.options.telemetry !== false) this.telemetryInstance.start();
    if (this.account) this.connectAccount(this.account);
  }

  /** Flushes snapshot work, closes every hub and the database. */
  stop(): Promise<void> {
    if (!this.stopping) this.stopping = this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    this.divergenceInstance?.stop();
    this.telemetryInstance?.stop();
    this.syncClient?.stop();
    this.commandsInstance?.stop();
    this.outcomesInstance?.stop();
    for (const release of this.background.values()) release();
    this.background.clear();
    await this.registryInstance?.closeAll("host-stopped");
    for (const unregister of this.syncRegistrations.values()) unregister();
    this.syncRegistrations.clear();
    await this.compactor?.close();
    this.storeInstance?.close();
    this.storeInstance = null;
    // Only a stop that got this far counts as clean (see openRunLedger).
    this.runLedger?.clean();
    this.runLedger = null;
    this.registryInstance = null;
    this.syncClient = null;
  }

  get store(): HostStore {
    if (!this.storeInstance) throw new Error("CollabHost.start() has not been called");
    return this.storeInstance;
  }

  get registry(): DocHubRegistry {
    if (!this.registryInstance) throw new Error("CollabHost.start() has not been called");
    return this.registryInstance;
  }

  get commands(): PendingCommands {
    if (!this.commandsInstance) throw new Error("CollabHost.start() has not been called");
    return this.commandsInstance;
  }

  /** Offline commands the server refused, kept until a window discards them. */
  get commandOutcomes(): CommandOutcomes {
    if (!this.outcomesInstance) throw new Error("CollabHost.start() has not been called");
    return this.outcomesInstance;
  }

  /** REST client for the signed-in account, or null when signed out. */
  get api(): ApiClient | null {
    return this.apiClient;
  }

  get connectionState(): ConnectionState {
    return this.syncClient?.connectionState ?? "idle";
  }

  get appVersion(): string {
    return this.options.appVersion;
  }

  get dbPath(): string {
    return this.options.dbPath;
  }

  get installationId(): string {
    return this.options.installationId;
  }

  /** The signed-in account id, or null. */
  get accountId(): string | null {
    return this.account?.accountId ?? null;
  }

  get serverUrl(): string | null {
    return this.account?.serverUrl ?? null;
  }

  get divergence(): DivergenceChecker {
    if (!this.divergenceInstance) throw new Error("CollabHost.start() has not been called");
    return this.divergenceInstance;
  }

  get telemetry(): TelemetryReporter {
    if (!this.telemetryInstance) throw new Error("CollabHost.start() has not been called");
    return this.telemetryInstance;
  }

  /** Queue gauges for telemetry and diagnostics, over every document (open or not). */
  telemetryGauges(): TelemetryGauges {
    let pendingUpdates = 0;
    let oldest: number | null = null;
    let pendingCommands = 0;
    const store = this.storeInstance;
    if (store && !store.isClosed) {
      for (const docId of store.docsWithUnacked()) {
        for (const row of store.unackedSummary(docId)) {
          pendingUpdates += 1;
          if (oldest === null || row.createdAt < oldest) oldest = row.createdAt;
        }
      }
      pendingCommands = store.listCommands().length;
    }
    const openDocuments = (this.registryInstance?.hubs() ?? []).filter((hub) => hub.getStatus().connected).length;
    return {
      pendingUpdates,
      oldestUnackedSeconds: oldest === null ? 0 : Math.max(0, (this.clock.now() - oldest) / 1000),
      pendingCommands,
      openDocuments,
    };
  }

  on(listener: (event: CollabHostEvent) => void): () => void {
    return this.events.on(listener);
  }

  // ------------------------------------------------------------ account and connection

  /** Signs the host in to an account (or out with null) and (re)connects. */
  setAccount(account: CollabAccount | null): void {
    this.disconnectAccount();
    this.account = account ? { ...account, tokenProvider: singleFlightTokenProvider(account.tokenProvider) } : null;
    if (this.account && this.storeInstance) this.connectAccount(this.account);
  }

  /** Resume from sleep or network online: reconnect now and retry queued commands. */
  nudge(): void {
    this.syncClient?.nudge();
    this.commandsInstance?.kick();
  }

  private connectAccount(account: CollabAccount): void {
    const clientId = syncClientId(this.options.installationId, account.accountId);
    this.apiClient = new ApiClient({
      baseUrl: account.serverUrl,
      tokenProvider: account.tokenProvider,
      fetch: this.options.fetch,
      clientId,
    });
    const client = new SyncClient({
      url: syncUrlFor(account),
      appVersion: this.options.appVersion,
      clientId,
      tokenProvider: account.tokenProvider,
      webSocketFactory: this.options.webSocketFactory,
      clock: this.clock,
      random: this.options.random,
      logger: this.logger,
      limits: this.options.limits,
      connectTimeoutMs: this.options.connectTimeoutMs,
      nudgePongTimeoutMs: this.options.nudgePongTimeoutMs,
      probe: () => probeServer(account.serverUrl, this.options.fetch),
    });
    this.syncClient = client;
    client.on((event) => {
      if (event.type === "state") {
        this.journal.noteConnection(event.state);
        this.commandsInstance?.setOnline(event.state === "connected");
      } else if (event.type === "error") {
        this.journal.noteError({ source: "sync", code: event.code, message: event.message, ...(event.docId ? { docId: event.docId } : {}) });
      }
      this.events.emit({ source: "sync", event });
    });
    for (const hub of this.registry.hubs()) this.registerWithSync(hub);
    this.commands.setApi(this.apiClient);
    client.start();
    this.syncPendingDocs();
  }

  private disconnectAccount(): void {
    for (const unregister of this.syncRegistrations.values()) unregister();
    this.syncRegistrations.clear();
    for (const release of this.background.values()) release();
    this.background.clear();
    this.syncClient?.stop();
    this.syncClient = null;
    this.apiClient = null;
    this.commandsInstance?.setApi(null);
    this.commandsInstance?.setOnline(false);
    for (const hub of this.registryInstance?.hubs() ?? []) hub.connectionChanged(null, "Not signed in.");
  }

  private registerWithSync(hub: DocHub): void {
    if (!this.syncClient || this.syncRegistrations.has(hub)) return;
    this.syncRegistrations.set(hub, this.syncClient.register(hub));
  }

  /**
   * Keeps docs with unacknowledged local work open until the server has it,
   * so edits made offline sync even after their window closed.
   */
  private syncPendingDocs(): void {
    if (!this.storeInstance || !this.syncClient) return;
    for (const docId of this.store.docsWithUnacked()) {
      if (this.background.has(docId)) continue;
      if (this.store.getDocMeta(docId)?.readOnlyReason === "access-revoked") continue;
      const hub = this.registry.acquire(docId);
      let released = false;
      let unsubscribe: () => void = () => {};
      const release = () => {
        if (released) return;
        released = true;
        unsubscribe();
        this.background.delete(docId);
        this.registryInstance?.release(docId);
      };
      this.background.set(docId, release);
      unsubscribe = hub.onStatus((status) => {
        if (status.pending === 0 || status.state === "access-changed") release();
      });
      if (hub.pendingCount === 0) release();
    }
  }

  // ------------------------------------------------------------ documents

  private createHub(docId: string, acquireOptions: AcquireOptions): DocHub {
    const hub = new DocHub({
      docId,
      store: this.store,
      kind: acquireOptions.kind,
      projectId: acquireOptions.projectId,
      clock: this.clock,
      logger: this.logger,
      limits: this.options.limits,
      compactor: this.compactor,
    });
    hub.onRejected((edit) => {
      // The reason and server message only; edit.rejectedText is the user's text.
      this.journal.noteReject(edit.reason);
      this.journal.noteError({ source: "reject", code: edit.reason, message: edit.message, docId });
      this.events.emit({ source: "doc", docId, kind: "rejected", edit });
    });
    this.divergenceInstance?.noteDoc(docId);
    hub.onClose(() => {
      const unregister = this.syncRegistrations.get(hub);
      this.syncRegistrations.delete(hub);
      unregister?.();
    });
    this.registerWithSync(hub);
    return hub;
  }

  /** Takes a reference on a doc's hub (control API, materializer, agent). Pair with release(). */
  acquire(docId: string, options?: AcquireOptions): DocHub {
    return this.registry.acquire(docId, options);
  }

  release(docId: string): void {
    this.registryInstance?.release(docId);
  }

  /**
   * Connects a renderer replica. The hub stays open until the replica
   * detaches (detach message, port close, or the returned function).
   */
  attachReplica(docId: string, port: ReplicaPort, options?: AcquireOptions): { hub: DocHub; connection: ReplicaConnection; detach: () => void } {
    const hub = this.registry.acquire(docId, options);
    let released = false;
    const connection = hub.attachReplica(port, () => {
      if (released) return;
      released = true;
      this.release(docId);
    });
    return { hub, connection, detach: () => connection.detach(true) };
  }

  /**
   * Divergence recovery: sends `open` for the doc again with empty state
   * vectors, so the server's `opened` carries its whole state, which the hub
   * persists and merges like any catch-up (local updates are never dropped;
   * the hub then sends whatever the server lacks). Done by registering a
   * stand-in sync target that answers stateVectors() once with empty vectors
   * and otherwise forwards to the hub; it stays registered afterwards and
   * behaves exactly like the hub. Resolves true when that `opened` arrived.
   */
  private reopenFull(hub: DocHub, timeoutMs: number): Promise<boolean> {
    const client = this.syncClient;
    if (!client || !client.connected || hub.isClosed || !hub.canSync() || !this.syncRegistrations.has(hub)) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let sentEmpty = false;
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timer);
        resolve(value);
      };
      const timer = this.clock.setTimeout(() => finish(false), timeoutMs);
      const target: SyncTarget = {
        docId: hub.docId,
        canSync: () => hub.canSync(),
        stateVectors: () => {
          if (sentEmpty) return hub.stateVectors();
          sentEmpty = true;
          return hub.subdocs.map((subdoc) => ({ subdoc, stateVector: EMPTY_STATE_VECTOR }));
        },
        connectionChanged: (transport, detail) => {
          hub.connectionChanged(transport, detail);
          if (!transport) finish(false);
        },
        setConnectionDetail: (detail) => hub.setConnectionDetail(detail),
        handleOpened: (message) => {
          hub.handleOpened(message);
          finish(true);
        },
        handleAck: (message) => hub.handleAck(message),
        handleReject: (message) => hub.handleReject(message),
        handleRemote: (message) => hub.handleRemote(message),
        handleAwareness: (update) => hub.handleAwareness(update),
        handleClosed: (message) => {
          hub.handleClosed(message);
          if (message.reason !== "client-closed") finish(false);
        },
        handleError: (message) => hub.handleError(message),
      };
      // Registering under the same docId replaces the hub in the sync
      // client without a `close`, then sends `open` with the empty vectors.
      // The hub's old unregister function is now a no-op for the client.
      this.syncRegistrations.set(hub, client.register(target));
    });
  }

  /** Lifts an access-revoked or schema read-only state for a doc (access restored, app updated). */
  clearReadOnly(docId: string): void {
    const hub = this.registryInstance?.get(docId);
    if (hub) hub.clearReadOnly();
    else this.store.updateDocMeta(docId, { readOnlyReason: null });
  }
}
