// CollabRuntime: the host process's long-lived state behind the control API.
//
// It owns the account, the CollabHost and the NotebookService. The SQLite
// file is scoped to server and account (or default.sqlite while signed out).
// A verified legacy account-only file keeps its pending work in place with
// a durable authority record. Changing authority starts a separate host and
// notebook service. Shared-notebook routes live in their own Router,
// rebuilt for each service,
// so they always reach the current one.

import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { AuthResponse } from "../../../src/lib/collab/protocol/api";
import { EventKind } from "../../../src/lib/collab/protocol/messages";
import type { HostEvent, HostStatus, LocalProject } from "../../../src/lib/collab/local-api";
import type { NotificationInfo } from "../../../src/lib/collab/protocol/api";
import type { FetchLike } from "../core/api-client";
import { sameAuthority, type AccountAuthority } from "../core/authority";
import { databaseKey, databasePath } from "./databases";
import type { Clock, Logger } from "../core/clock";
import { consoleLogger } from "../core/clock";
import { CollabHost, syncClientId, type CollabHostEvent, type CollabHostOptions } from "../core/host";
import { createNotebookService } from "../notebooks";
import { AccountManager, type SecretCodec } from "./account";
import { SharedSignIn } from "./shared-sign-in";
import { Router } from "./router";
import { HOST_VERSION, connectionDetail, hostConnection } from "./status";
import type { ControlDeps, NotebookService } from "./types";

export { databaseKey } from "./databases";

export type NotebookServiceFactory = (deps: Omit<ControlDeps, "notebooks">) => NotebookService;

export interface CollabRuntimeOptions {
  /** userData/collab: databases, account.json, session.bin. */
  collabDir: string;
  /** `<LIBERA_DATA_DIR>/users/admin`. */
  libraryRoot: string;
  /** `<LIBERA_DATA_DIR>/gallery`, where shared albums live (default: beside users/). */
  galleryRoot?: string;
  appVersion: string;
  installationId: string;
  secrets: SecretCodec;
  emit(event: HostEvent): void;
  createNotebookService?: NotebookServiceFactory;
  /** Extra CollabHost options (tests: compaction off, short idle, fake sockets). */
  host?: Partial<Omit<CollabHostOptions, "dbPath" | "appVersion" | "installationId">>;
  fetch?: FetchLike;
  clock?: Clock;
  logger?: Logger;
  /** Tests: shared sign-in options (cheap scrypt, short poll). */
  sharedSignIn?: { kdf?: { N: number; r: number; p: number }; pollMs?: number };
}

interface Generation {
  key: string;
  clientNamespace?: string;
  host: CollabHost;
  notebooks: NotebookService;
  unsubscribe: () => void;
}

const PROJECT_EVENT_KINDS: ReadonlySet<string> = new Set([EventKind.RoleChanged, EventKind.MemberRemoved, EventKind.ProjectDeleted]);

export class CollabRuntime {
  readonly accounts: AccountManager;
  /** Automatic sign-in through the synced data folder (shared-sign-in.ts). */
  readonly sharedSignIn: SharedSignIn;
  /** Shared-notebook routes of the current NotebookService. */
  readonly notebookRoutes = new Router();
  private readonly options: CollabRuntimeOptions;
  readonly logger: Logger;
  private current: Generation | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lastStatus = "";
  private stopped = false;

  constructor(options: CollabRuntimeOptions) {
    this.options = options;
    this.logger = options.logger ?? consoleLogger;
    this.accounts = new AccountManager({
      dir: options.collabDir,
      secrets: options.secrets,
      fetch: options.fetch,
      clock: options.clock,
      logger: this.logger,
    });
    this.accounts.on(() => this.statusChanged());
    this.sharedSignIn = new SharedSignIn({
      libraryRoot: options.libraryRoot,
      collabDir: options.collabDir,
      accounts: this.accounts,
      api: () => (this.accounts.session ? (this.current?.host.api ?? null) : null),
      signedIn: (serverUrl, auth, canAdopt) => this.signedIn(serverUrl, auth, canAdopt),
      clock: options.clock,
      logger: this.logger,
      ...options.sharedSignIn,
    });
  }

  get host(): CollabHost {
    if (!this.current) throw new Error("The collab runtime has not started");
    return this.current.host;
  }

  get notebooks(): NotebookService {
    if (!this.current) throw new Error("The collab runtime has not started");
    return this.current.notebooks;
  }

  /** The sync clientId of the signed-in account (actors carry it). */
  get clientId(): string | null {
    const account = this.accounts.account;
    return account ? syncClientId(this.options.installationId, this.current?.clientNamespace ?? account.id) : null;
  }

  /** Runs account and database changes one at a time. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  start(): Promise<void> {
    return this.serial(async () => {
      await mkdir(this.options.collabDir, { recursive: true });
      await this.accounts.load();
      const account = this.accounts.account;
      await this.open(account ? { accountId: account.id, serverUrl: account.serverUrl } : null);
      this.applyAccount();
      this.statusChanged();
    });
  }

  stop(): Promise<void> {
    this.current?.host.api?.cancelPending();
    return this.serial(async () => {
      this.stopped = true;
      this.sharedSignIn.stop();
      await this.closeCurrent();
    });
  }

  /** Signs in with a fresh AuthResponse; switches to the account's database first. */
  signedIn(serverUrl: string, auth: AuthResponse, canAdopt: () => boolean = () => true): Promise<void> {
    return this.serial(async () => {
      if (this.stopped || !canAdopt()) return;
      if (this.accounts.account) await this.notebooks.beforeAccountChange?.();
      await this.open({ accountId: auth.account.id, serverUrl });
      if (this.stopped || !canAdopt()) return;
      await this.accounts.signIn(serverUrl, auth);
      this.applyAccount();
      await this.notebooks.accountChanged();
      this.statusChanged();
    });
  }

  /**
   * Signs out. The account's database stays open (and on disk) so unsynced
   * edits survive; signing in to the same account again picks them up.
   */
  signOut(): Promise<void> {
    this.current?.host.api?.cancelPending();
    return this.serial(async () => {
      await this.notebooks.beforeAccountChange?.();
      await this.accounts.signOut();
      this.applyAccount();
      await this.notebooks.accountChanged();
      this.statusChanged();
    });
  }

  /** Pushes an event to every window. */
  emit(event: HostEvent): void {
    this.options.emit(event);
  }

  nudge(): void {
    this.current?.host.nudge();
  }

  private applyAccount(): void {
    const account = this.accounts.account;
    const session = this.accounts.session;
    this.host.setAccount(account && session ? { accountId: account.id, serverUrl: account.serverUrl, tokenProvider: session } : null);
  }

  private async open(authority: AccountAuthority | null): Promise<void> {
    const key = databaseKey(authority?.accountId ?? null, authority?.serverUrl);
    if (this.stopped) throw new Error("The collab host is stopping");
    if (this.current?.key === key) return;
    await this.closeCurrent();
    const remembered = this.accounts.account;
    const dbPath = await databasePath(this.options.collabDir, authority, remembered ? { accountId: remembered.id, serverUrl: remembered.serverUrl } : null, this.logger);
    const clientNamespace = authority && path.basename(dbPath) !== `${databaseKey(authority.accountId)}.sqlite` ? key : undefined;
    const host = new CollabHost({
      logger: this.logger,
      fetch: this.options.fetch,
      clock: this.options.clock,
      ...this.options.host,
      dbPath,
      clientNamespace,
      appVersion: this.options.appVersion,
      installationId: this.options.installationId,
    });
    host.start();
    if (authority) {
      const saved = host.store.databaseAuthority();
      if (saved === undefined) host.store.setDatabaseAuthority(authority);
      else if (saved === null || !sameAuthority(saved, authority)) {
        await host.stop();
        throw new Error("This collaboration database belongs to another account or server; its data was preserved.");
      }
    }
    const factory = this.options.createNotebookService ?? createNotebookService;
    const notebooks = factory({
      host,
      ...(authority ? { authority } : {}),
      libraryRoot: this.options.libraryRoot,
      lifecycleDir: path.join(this.options.collabDir, "notebook-lifecycle"),
      ...(this.options.galleryRoot ? { galleryRoot: this.options.galleryRoot } : {}),
      emit: (event) => {
        this.options.emit(event);
        // Shares, joins, revocations and reconciliations change HostStatus.projects.
        if (event.t === "project-changed" || event.t === "reconcile-needed") this.statusChanged();
      },
      statusChanged: () => this.statusChanged(),
    });
    this.notebookRoutes.clear();
    notebooks.registerRoutes(this.notebookRoutes);
    const unsubscribe = host.on((event) => this.onHostEvent(event));
    this.current = { key, clientNamespace, host, notebooks, unsubscribe };
    try {
      await notebooks.start();
    } catch (error) {
      // The core routes still work without the notebook service.
      this.logger.error("The shared-notebook service did not start", error);
    }
  }

  private async closeCurrent(): Promise<void> {
    const generation = this.current;
    if (!generation) return;
    this.current = null;
    this.notebookRoutes.clear();
    generation.unsubscribe();
    try {
      await generation.notebooks.stop();
    } catch (error) {
      this.logger.error("The shared-notebook service did not stop cleanly", error);
    }
    await generation.host.stop();
  }

  private onHostEvent(event: CollabHostEvent): void {
    if (event.source === "commands") {
      const command = event.event;
      // Windows replace a comment's "pending" chip when its command settles.
      if (command.type === "settled") {
        this.options.emit({
          t: "command-settled",
          id: command.id,
          kind: command.kind,
          ok: command.ok,
          status: command.status,
          body: command.body,
          ...(command.error ? { error: command.error } : {}),
        });
      }
      this.statusChanged();
      return;
    }
    if (event.source === "divergence") {
      this.options.emit({ t: "divergence", docId: event.docId, recovered: event.record.recovered === true });
      return;
    }
    if (event.source !== "sync") return;
    const sync = event.event;
    if (sync.type === "state" || sync.type === "update-required" || sync.type === "needs-sign-in" || sync.type === "signed-out") {
      this.statusChanged();
      return;
    }
    if (sync.type !== "server-event") return;
    const { scope, id, kind, payload } = sync.event;
    this.options.emit({ t: "server-event", scope, id, kind, payload });
    if (kind === EventKind.Notification && payload && typeof payload === "object") {
      this.options.emit({ t: "notification", notification: payload as NotificationInfo });
    }
    if (PROJECT_EVENT_KINDS.has(kind)) {
      // Role and membership events arrive per project and per user.
      const fromPayload = payload && typeof payload === "object" ? (payload as { projectId?: unknown }).projectId : undefined;
      const projectId = typeof fromPayload === "string" ? fromPayload : scope === "project" ? id : null;
      if (projectId) this.options.emit({ t: "project-changed", projectId });
      this.statusChanged();
    }
  }

  status(): HostStatus {
    const account = this.accounts.account;
    const generation = this.current;
    const connection = hostConnection({
      hasAccount: account !== null,
      needsSignIn: this.accounts.needsSignIn,
      state: generation?.host.connectionState ?? "stopped",
    });
    let projects: LocalProject[] = [];
    let pendingCommands = 0;
    if (generation) {
      try {
        const store = generation.host.store;
        // The notebook service knows folders, revocation and pending
        // reconciliations; the projects table is the fallback.
        projects =
          generation.notebooks.localProjects?.() ??
          store.listProjects().map((row) => ({
            projectId: row.projectId,
            name: row.name,
            role: row.role ?? "viewer",
            notebook: row.localRoot ? path.basename(row.localRoot) : row.name,
            revoked: false,
            reconcilePending: 0,
          }));
        pendingCommands = store.listCommands().length;
      } catch {
        // The host is between databases; report what is known.
      }
    }
    const detail = connectionDetail(connection);
    return {
      hostVersion: HOST_VERSION,
      connection,
      account,
      projects,
      pendingCommands,
      ...(detail ? { detail } : {}),
    };
  }

  /** Recomputes HostStatus and pushes it as a `status` event when it changed. */
  statusChanged(): void {
    if (!this.current && !this.stopped) return;
    const status = this.status();
    const json = JSON.stringify(status);
    if (json === this.lastStatus) return;
    this.lastStatus = json;
    this.options.emit({ t: "status", status });
  }
}
