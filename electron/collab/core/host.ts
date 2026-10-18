// CollabHost: the facade the Electron adapter and the control API use.
// It wires the store, the hub registry, the sync and REST clients, the
// pending command queue and compaction. Plain Node: no Electron imports.

import { ApiRoutes } from "../../../src/lib/collab/protocol/api";
import { SyncLimits } from "../../../src/lib/collab/protocol/version";
import { ApiClient, type FetchLike } from "./api-client";
import type { Clock, Logger } from "./clock";
import { Emitter, consoleLogger, systemClock } from "./clock";
import { Compactor, type CompactorOptions } from "./compaction";
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
  type TokenProvider,
  type WebSocketFactory,
} from "./sync-client";

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
}

export type CollabHostEvent =
  | { source: "sync"; event: SyncClientEvent }
  | { source: "commands"; event: PendingCommandEvent }
  | { source: "doc"; docId: string; kind: "rejected"; edit: RejectedEdit };

function syncUrlFor(account: CollabAccount): string {
  if (account.syncUrl) return account.syncUrl;
  const url = new URL(ApiRoutes.sync, account.serverUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
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
  private syncClient: SyncClient | null = null;
  private apiClient: ApiClient | null = null;
  private account: CollabAccount | null = null;
  private readonly syncRegistrations = new Map<DocHub, () => void>();
  /** Docs held open only to push unacknowledged local work to the server. */
  private readonly background = new Map<string, () => void>();
  private stopping: Promise<void> | null = null;

  constructor(options: CollabHostOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? consoleLogger;
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
    this.commandsInstance.on((event) => this.events.emit({ source: "commands", event }));
    if (this.account) this.connectAccount(this.account);
  }

  /** Flushes snapshot work, closes every hub and the database. */
  stop(): Promise<void> {
    if (!this.stopping) this.stopping = this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    this.syncClient?.stop();
    this.commandsInstance?.stop();
    for (const release of this.background.values()) release();
    this.background.clear();
    await this.registryInstance?.closeAll("host-stopped");
    for (const unregister of this.syncRegistrations.values()) unregister();
    this.syncRegistrations.clear();
    await this.compactor?.close();
    this.storeInstance?.close();
    this.storeInstance = null;
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

  /** REST client for the signed-in account, or null when signed out. */
  get api(): ApiClient | null {
    return this.apiClient;
  }

  get connectionState(): ConnectionState {
    return this.syncClient?.connectionState ?? "idle";
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
    const clientId = `${this.options.installationId}:${account.accountId}`;
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
    });
    this.syncClient = client;
    client.on((event) => {
      if (event.type === "state") this.commandsInstance?.setOnline(event.state === "connected");
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
    hub.onRejected((edit) => this.events.emit({ source: "doc", docId, kind: "rejected", edit }));
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

  /** Lifts an access-revoked or schema read-only state for a doc (access restored, app updated). */
  clearReadOnly(docId: string): void {
    const hub = this.registryInstance?.get(docId);
    if (hub) hub.clearReadOnly();
    else this.store.updateDocMeta(docId, { readOnlyReason: null });
  }
}
