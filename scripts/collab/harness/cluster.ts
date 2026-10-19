// Multi-host driver: the real collab server in a child process, a chaos
// proxy in front of it, and N real CollabHosts (each with its own temp
// SQLite file) connected through their own proxy links.
//
// Hosts run in this process for speed and direct access to their hubs. The
// kill cases spawn a host as a child process instead (host-child.ts), since
// only a real process kill shows what SQLite has committed.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as Y from "yjs";

import { CollabHost, type CollabHostEvent, type CollabHostOptions } from "../../../electron/collab/core/host";
import type { DocHub } from "../../../electron/collab/core/doc-hub";
import type { Logger } from "../../../electron/collab/core/clock";
import type { TokenProvider } from "../../../electron/collab/core/sync-client";
import { ApiRoutes, type AuthResponse, type ProjectSummary } from "../../../src/lib/collab/protocol/api";
import type { Role } from "../../../src/lib/collab/protocol/roles";
import { startServerProcess, type ServerProcess } from "../support/server-process";
import { ChaosProxy, type ProxyLink } from "./chaos-proxy";
import type { CollaboratorConfig } from "./collaborator-child";
import type { ChildHostConfig } from "./host-child";
import { readServerDoc, syncUrlOf, type ServerDocState } from "./server-reader";

export const HARNESS_PASSWORD = "harness correct horse battery";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(condition: () => boolean, label: string, timeoutMs = 15_000, pollMs = 5): Promise<number> {
  const started = performance.now();
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`);
    await sleep(pollMs);
  }
  return performance.now() - started;
}

const debug = Boolean(process.env.LIBERA_HARNESS_DEBUG);

export function harnessLogger(name: string): Logger {
  if (!debug) return { warn() {}, error() {} };
  return {
    warn: (message, detail) => console.log(`[${name}] warn ${message}`, detail ?? ""),
    error: (message, detail) => console.log(`[${name}] error ${message}`, detail ?? ""),
  };
}

export interface HttpResult<T> {
  status: number;
  body: T;
}

export async function httpJson<T>(
  baseUrl: string,
  route: string,
  options: { body?: unknown; token?: string; method?: string } = {},
): Promise<HttpResult<T>> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/**
 * One sign-in (one refresh-token family). Refresh tokens rotate and a reused
 * one revokes the family, so every host of the session shares one
 * single-flight refresh, and a separate process gets its own session.
 */
export class TokenSession {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshCalls = 0;
  refreshFailures = 0;
  private inFlight: Promise<string | null> | null = null;

  constructor(auth: AuthResponse) {
    this.accessToken = auth.accessToken;
    this.refreshToken = auth.refreshToken;
    this.accessTokenExpiresAt = Date.parse(auth.accessTokenExpiresAt);
  }

  /** null when the server refuses the refresh token (sign in again); throws on network errors. */
  refresh(baseUrl: string): Promise<string | null> {
    if (!this.inFlight) {
      this.inFlight = (async () => {
        this.refreshCalls += 1;
        const result = await httpJson<AuthResponse>(baseUrl, ApiRoutes.refresh, { body: { refreshToken: this.refreshToken } });
        if (result.status === 200) {
          this.accessToken = result.body.accessToken;
          this.refreshToken = result.body.refreshToken;
          this.accessTokenExpiresAt = Date.parse(result.body.accessTokenExpiresAt);
          return this.accessToken;
        }
        if (result.status === 400 || result.status === 401 || result.status === 403) {
          this.refreshFailures += 1;
          return null;
        }
        throw new Error(`Refresh failed with HTTP ${result.status}`);
      })().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /** A provider whose refresh goes through `baseUrl` (normally the host's proxy link). */
  provider(baseUrl: () => string): TokenProvider {
    return {
      getAccessToken: async () => this.accessToken,
      refresh: () => this.refresh(baseUrl()),
    };
  }
}

export interface HarnessUser {
  name: string;
  email: string;
  accountId: string;
  session: TokenSession;
}

export interface HostOptions {
  /** Defaults to a new file in the cluster's temp dir. */
  dbPath?: string;
  /** Defaults to a fresh id; reuse it with dbPath to restart "the same installation". */
  installationId?: string;
  /** Use an existing link (e.g. a restarted host keeps its network). */
  link?: ProxyLink;
  limits?: CollabHostOptions["limits"];
  random?: () => number;
  connectTimeoutMs?: number;
  compaction?: CollabHostOptions["compaction"];
  /** Sign-in session; defaults to the user's main session. */
  session?: TokenSession;
}

export class HarnessHost {
  readonly events: CollabHostEvent[] = [];
  host: CollabHost;
  private readonly hubs = new Map<string, DocHub>();
  private stopped = false;

  constructor(
    readonly name: string,
    readonly user: HarnessUser,
    readonly link: ProxyLink,
    readonly dbPath: string,
    readonly installationId: string,
    private readonly options: HostOptions,
    private session: TokenSession,
  ) {
    this.host = this.create();
  }

  private create(): CollabHost {
    const host = new CollabHost({
      dbPath: this.dbPath,
      appVersion: "harness",
      installationId: this.installationId,
      logger: harnessLogger(this.name),
      compaction: this.options.compaction ?? false,
      hubIdleMs: 60_000,
      ...(this.options.limits ? { limits: this.options.limits } : {}),
      ...(this.options.random ? { random: this.options.random } : {}),
      ...(this.options.connectTimeoutMs ? { connectTimeoutMs: this.options.connectTimeoutMs } : {}),
    });
    host.start();
    host.on((event) => {
      this.events.push(event);
      if (this.events.length > 5000) this.events.splice(0, 1000);
      if (debug) console.log(`[${this.name}] event ${JSON.stringify(event).slice(0, 200)}`);
    });
    host.setAccount({
      accountId: this.user.accountId,
      serverUrl: this.link.url,
      syncUrl: syncUrlOf(this.link.url),
      tokenProvider: this.session.provider(() => this.link.url),
    });
    return host;
  }

  /** Opens (acquires) a doc on this host; later calls return the same hub. */
  open(docId: string, projectId?: string): DocHub {
    let hub = this.hubs.get(docId);
    if (!hub || hub.isClosed) {
      hub = this.host.acquire(docId, { kind: "file", ...(projectId ? { projectId } : {}) });
      this.hubs.set(docId, hub);
    }
    return hub;
  }

  hub(docId: string): DocHub {
    const hub = this.hubs.get(docId);
    if (!hub) throw new Error(`${this.name} has not opened ${docId}`);
    return hub;
  }

  text(docId: string): string {
    return this.hub(docId).getText();
  }

  stateVector(docId: string): Map<number, number> {
    return Y.decodeStateVector(Y.encodeStateVector(this.hub(docId).getDoc("content")));
  }

  nudge(): void {
    this.host.nudge();
  }

  /** The user signs in again (after "needs sign-in"): a new session for this host. */
  signIn(session: TokenSession): void {
    this.session = session;
    this.host.setAccount({
      accountId: this.user.accountId,
      serverUrl: this.link.url,
      syncUrl: syncUrlOf(this.link.url),
      tokenProvider: session.provider(() => this.link.url),
    });
  }

  get currentSession(): TokenSession {
    return this.session;
  }

  get connectionState() {
    return this.host.connectionState;
  }

  /** Graceful app quit and relaunch on the same database and network link. */
  async restart(): Promise<void> {
    const reopen = [...this.hubs.keys()];
    await this.host.stop();
    this.hubs.clear();
    this.host = this.create();
    for (const docId of reopen) this.open(docId);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.host.stop();
  }
}

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const CHILD_SCRIPT = path.join(__dirname, "host-child.ts");
const COLLABORATOR_SCRIPT = path.join(__dirname, "collaborator-child.ts");

/** A collaborator process (collaborator-child.ts) and what it reported. */
export class Collaborator {
  readonly typed = new Map<string, { at: number; commitMs: number }>();
  /** marker → epoch ms at which it became visible in this process. */
  readonly received = new Map<string, number>();
  digest: { hash: string; length: number; pending: number } | null = null;
  typingDone = false;
  stderr = "";
  readonly ready: Promise<void>;
  private readonly exited: Promise<void>;

  constructor(readonly config: CollaboratorConfig, readonly child: ChildProcess) {
    let readyResolve: () => void = () => undefined;
    this.ready = new Promise((resolve) => (readyResolve = resolve));
    this.exited = new Promise((resolve) => child.once("exit", () => resolve()));
    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (this.stderr += chunk));
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const [kind, a, b, c] = line.split(" ");
        if (kind === "ready") readyResolve();
        else if (kind === "typed") this.typingDone = true;
        else if (kind === "t") this.typed.set(a, { at: Number(b), commitMs: Number(c) });
        else if (kind === "r" && !this.received.has(a)) this.received.set(a, Number(b));
        else if (kind === "h") this.digest = { hash: a, length: Number(b), pending: Number(c) };
      }
    });
  }

  /** Starts typing. */
  go(): void {
    this.child.stdin?.write("go\n");
  }

  async stop(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    await this.exited;
  }
}

/** A host running in its own process (host-child.ts), killable with SIGKILL. */
export class ChildHost {
  /** Markers whose applyLocalChange returned (committed to SQLite) before the kill. */
  readonly committed: string[] = [];
  readonly statuses: string[] = [];
  done = false;
  stderr = "";
  private readonly exited: Promise<void>;
  private readyResolve: (() => void) | null = null;
  readonly ready: Promise<void>;

  constructor(readonly config: ChildHostConfig, readonly child: ChildProcess) {
    this.ready = new Promise((resolve) => (this.readyResolve = resolve));
    this.exited = new Promise((resolve) => child.once("exit", () => resolve()));
    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (this.stderr += chunk));
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "ready") this.readyResolve?.();
        else if (line === "done") this.done = true;
        else if (line.startsWith("c ")) this.committed.push(line.slice(2));
        else if (line.startsWith("s ")) this.statuses.push(line.slice(2));
      }
    });
  }

  async waitForCommitted(count: number, timeoutMs = 30_000): Promise<void> {
    await waitUntil(() => this.committed.length >= count, `${count} committed edits in the child (stderr: ${this.stderr})`, timeoutMs, 5);
  }

  /** kill -9: no shutdown code runs. */
  async kill(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    await this.exited;
  }
}

export interface ConvergenceResult {
  text: string;
  server: ServerDocState;
  elapsedMs: number;
}

export interface ClusterOptions {
  serverEnv?: Record<string, string>;
  /** Random source for proxy jitter and faults. */
  random?: () => number;
}

let uniqueCounter = 0;
export function uniqueId(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${process.pid.toString(36)}${uniqueCounter.toString(36)}`;
}

function sameVector(a: Map<number, number>, b: Map<number, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [client, clock] of a) if (b.get(client) !== clock) return false;
  return true;
}

export class Cluster {
  server: ServerProcess;
  readonly proxy: ChaosProxy;
  readonly dir: string;
  readonly hosts: HarnessHost[] = [];
  private serverEnv: Record<string, string>;
  private readonly users: HarnessUser[] = [];

  private constructor(server: ServerProcess, proxy: ChaosProxy, dir: string, serverEnv: Record<string, string>) {
    this.server = server;
    this.proxy = proxy;
    this.dir = dir;
    this.serverEnv = serverEnv;
  }

  static async start(options: ClusterOptions = {}): Promise<Cluster> {
    const serverEnv = options.serverEnv ?? {};
    const server = await startServerProcess({ env: serverEnv });
    const proxy = new ChaosProxy({ port: server.port }, options.random);
    const dir = mkdtempSync(path.join(tmpdir(), "libera-harness-"));
    return new Cluster(server, proxy, dir, serverEnv);
  }

  get url(): string {
    return this.server.url;
  }

  /** REST straight to the server (admin actions the test performs, not the host). */
  api<T>(route: string, options: { body?: unknown; token?: string; method?: string } = {}): Promise<HttpResult<T>> {
    return httpJson<T>(this.server.url, route, options);
  }

  async registerUser(name: string): Promise<HarnessUser> {
    const email = `${name.toLowerCase()}.${uniqueId("u").toLowerCase()}@example.test`;
    const result = await this.api<AuthResponse>(ApiRoutes.register, {
      body: { email, password: HARNESS_PASSWORD, displayName: name },
    });
    if (result.status !== 201) throw new Error(`Register ${name} failed: ${result.status} ${JSON.stringify(result.body)}`);
    const user: HarnessUser = { name, email, accountId: result.body.account.id, session: new TokenSession(result.body) };
    this.users.push(user);
    return user;
  }

  /** A second sign-in for the same user (its own refresh-token family). */
  async login(user: HarnessUser): Promise<TokenSession> {
    return new TokenSession(await this.loginAuth(user));
  }

  async loginAuth(user: HarnessUser): Promise<AuthResponse> {
    const result = await this.api<AuthResponse>(ApiRoutes.login, { body: { email: user.email, password: HARNESS_PASSWORD } });
    if (result.status !== 200) throw new Error(`Login ${user.name} failed: ${result.status} ${JSON.stringify(result.body)}`);
    return result.body;
  }

  async createProject(owner: HarnessUser, name = "Harness"): Promise<string> {
    const result = await this.api<ProjectSummary>(ApiRoutes.projects, { body: { name }, token: await this.token(owner) });
    if (result.status !== 201) throw new Error(`Create project failed: ${result.status} ${JSON.stringify(result.body)}`);
    return result.body.id;
  }

  async addMember(projectId: string, owner: HarnessUser, user: HarnessUser, role: Role = "editor"): Promise<void> {
    const invite = await this.api<{ token: string }>(ApiRoutes.projectInvitations(projectId), {
      body: { email: user.email, role },
      token: await this.token(owner),
    });
    if (invite.status !== 201) throw new Error(`Invite ${user.name} failed: ${invite.status} ${JSON.stringify(invite.body)}`);
    const accepted = await this.api(ApiRoutes.acceptInvitation(invite.body.token), {
      body: {},
      token: await this.token(user),
    });
    if (accepted.status !== 200) throw new Error(`Accept for ${user.name} failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
  }

  async removeMember(projectId: string, owner: HarnessUser, user: HarnessUser): Promise<void> {
    const result = await this.api(ApiRoutes.member(projectId, user.accountId), { method: "DELETE", token: await this.token(owner) });
    if (result.status !== 204) throw new Error(`Remove ${user.name} failed: ${result.status} ${JSON.stringify(result.body)}`);
  }

  async setRole(projectId: string, owner: HarnessUser, user: HarnessUser, role: Role): Promise<void> {
    const result = await this.api(ApiRoutes.member(projectId, user.accountId), {
      method: "PATCH",
      body: { role },
      token: await this.token(owner),
    });
    if (result.status !== 200) throw new Error(`Set role for ${user.name} failed: ${result.status} ${JSON.stringify(result.body)}`);
  }

  /** Signs the session out on the server (its refresh token stops working). */
  async logout(session: TokenSession): Promise<void> {
    const result = await this.api(ApiRoutes.logout, { body: { refreshToken: session.refreshToken }, token: session.accessToken });
    if (result.status >= 300) throw new Error(`Logout failed: ${result.status} ${JSON.stringify(result.body)}`);
  }

  async createDoc(projectId: string, owner: HarnessUser): Promise<string> {
    const docId = uniqueId("doc");
    const result = await this.api(ApiRoutes.documents(projectId), {
      body: { docId, fileId: uniqueId("fil"), kind: "markdown" },
      token: await this.token(owner),
    });
    if (result.status !== 201) throw new Error(`Create doc failed: ${result.status} ${JSON.stringify(result.body)}`);
    return docId;
  }

  /** Users, a project with all of them as editors, and one doc. */
  async team(names: string[]): Promise<{ users: HarnessUser[]; projectId: string; docId: string }> {
    const users: HarnessUser[] = [];
    for (const name of names) users.push(await this.registerUser(name));
    const [owner, ...others] = users;
    const projectId = await this.createProject(owner);
    for (const user of others) await this.addMember(projectId, owner, user);
    const docId = await this.createDoc(projectId, owner);
    return { users, projectId, docId };
  }

  async addHost(user: HarnessUser, options: HostOptions = {}, name?: string): Promise<HarnessHost> {
    const hostName = name ?? `${user.name}-${this.hosts.length + 1}`;
    const link = options.link ?? (await this.proxy.addLink(uniqueId(hostName)));
    const host = new HarnessHost(
      hostName,
      user,
      link,
      options.dbPath ?? path.join(this.dir, `${uniqueId(hostName)}.sqlite`),
      options.installationId ?? uniqueId("inst"),
      options,
      options.session ?? user.session,
    );
    this.hosts.push(host);
    return host;
  }

  /** Starts a host in a child process with its own sign-in, on `link`. */
  async spawnChildHost(
    user: HarnessUser,
    options: { docId: string; projectId: string; tag: string; dbPath: string; installationId: string; link: ProxyLink; count?: number; intervalMs?: number; startIndex?: number },
  ): Promise<ChildHost> {
    const config: ChildHostConfig = {
      dbPath: options.dbPath,
      installationId: options.installationId,
      accountId: user.accountId,
      linkUrl: options.link.url,
      auth: await this.loginAuth(user),
      docId: options.docId,
      projectId: options.projectId,
      tag: options.tag,
      count: options.count ?? 1_000_000,
      intervalMs: options.intervalMs ?? 2,
      ...(options.startIndex !== undefined ? { startIndex: options.startIndex } : {}),
    };
    const child = spawn(process.execPath, ["--import", "tsx", CHILD_SCRIPT, JSON.stringify(config)], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const host = new ChildHost(config, child);
    await Promise.race([
      host.ready,
      new Promise<never>((_, reject) => child.once("exit", (code) => reject(new Error(`Child host exited with ${code}: ${host.stderr}`)))),
    ]);
    return host;
  }

  /** Starts a collaborator process for `user` on a new proxy link. */
  async spawnCollaborator(
    user: HarnessUser,
    options: Omit<CollaboratorConfig, "dbPath" | "installationId" | "accountId" | "linkUrl" | "auth">,
  ): Promise<Collaborator> {
    const link = await this.proxy.addLink(uniqueId(options.tag));
    const config: CollaboratorConfig = {
      ...options,
      dbPath: path.join(this.dir, `${uniqueId(options.tag)}.sqlite`),
      installationId: uniqueId("inst"),
      accountId: user.accountId,
      linkUrl: link.url,
      auth: await this.loginAuth(user),
    };
    const child = spawn(process.execPath, ["--import", "tsx", COLLABORATOR_SCRIPT, JSON.stringify(config)], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const collaborator = new Collaborator(config, child);
    await Promise.race([
      collaborator.ready,
      new Promise<never>((_, reject) =>
        child.once("exit", (code) => reject(new Error(`Collaborator exited with ${code}: ${collaborator.stderr}`))),
      ),
    ]);
    return collaborator;
  }

  async removeHost(host: HarnessHost, options: { keepLink?: boolean } = {}): Promise<void> {
    await host.stop();
    const index = this.hosts.indexOf(host);
    if (index >= 0) this.hosts.splice(index, 1);
    if (!options.keepLink) await this.proxy.removeLink(host.link.name);
  }

  /**
   * Restarts the server on the same data directory and port: "kill" is a
   * crash (SIGKILL), "graceful" a deploy. `env` changes its configuration.
   */
  async restartServer(options: { mode?: "kill" | "graceful"; env?: Record<string, string>; downMs?: number } = {}): Promise<void> {
    const { port, dataDir } = this.server;
    if (options.mode === "graceful") await this.server.stop();
    else await this.server.kill();
    if (options.downMs) await sleep(options.downMs);
    if (options.env) this.serverEnv = { ...this.serverEnv, ...options.env };
    this.server = await startServerProcess({ port, dataDir, env: this.serverEnv });
  }

  async stopServer(mode: "kill" | "graceful" = "kill"): Promise<void> {
    if (mode === "graceful") await this.server.stop();
    else await this.server.kill();
  }

  async startServer(env?: Record<string, string>): Promise<void> {
    if (env) this.serverEnv = { ...this.serverEnv, ...env };
    this.server = await startServerProcess({ port: this.server.port, dataDir: this.server.dataDir, env: this.serverEnv });
  }

  async readServer(docId: string, user: HarnessUser = this.users[0]): Promise<ServerDocState> {
    return readServerDoc(this.server.url, await this.token(user), docId);
  }

  /**
   * The user's access token, refreshed first when it is about to expire
   * (tests with a short ACCESS_TOKEN_TTL_SECONDS). The refresh goes straight
   * to the server, and the session is shared, so hosts pick the new token up.
   */
  async token(user: HarnessUser): Promise<string> {
    if (user.session.accessTokenExpiresAt - Date.now() < 1500) {
      const token = await user.session.refresh(this.server.url);
      if (!token) throw new Error(`${user.name}'s session can no longer be refreshed`);
    }
    return user.session.accessToken;
  }

  /** Lifts every fault on every link and nudges every host to reconnect now. */
  healAll(): void {
    for (const link of this.proxy.all()) link.clear();
    for (const host of this.hosts) host.nudge();
  }

  /**
   * Waits until every host has the same text and content state vector, none
   * has unacknowledged edits, and a fresh reader sees the same on the server.
   */
  async awaitConvergence(
    docId: string,
    hosts: HarnessHost[] = this.hosts,
    options: { timeoutMs?: number; reader?: HarnessUser } = {},
  ): Promise<ConvergenceResult> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const started = performance.now();
    const deadline = Date.now() + timeoutMs;
    let lastServerRead = 0;
    let lastServer: ServerDocState | null = null;
    let lastError: unknown = null;
    for (;;) {
      const texts = hosts.map((host) => host.text(docId));
      const settled =
        texts.every((text) => text === texts[0]) &&
        hosts.every((host) => host.hub(docId).pendingCount === 0) &&
        hosts.every((host) => sameVector(host.stateVector(docId), hosts[0].stateVector(docId)));
      if (settled && Date.now() - lastServerRead > 150) {
        lastServerRead = Date.now();
        try {
          lastServer = await this.readServer(docId, options.reader);
          lastError = null;
          if (lastServer.text === texts[0] && sameVector(lastServer.stateVector, hosts[0].stateVector(docId))) {
            return { text: texts[0], server: lastServer, elapsedMs: performance.now() - started };
          }
        } catch (error) {
          lastError = error;
        }
      }
      if (Date.now() > deadline) {
        const lines = hosts.map((host) => {
          const hub = host.hub(docId);
          const status = hub.getStatus();
          return `  ${host.name}: ${host.text(docId).length} chars, pending ${hub.pendingCount}, ${status.state}, socket ${host.connectionState}`;
        });
        if (lastServer) lines.push(`  server: ${lastServer.text.length} chars, serverSeq ${lastServer.serverSeq}`);
        if (lastError) lines.push(`  server read failed: ${String(lastError)}`);
        throw new Error(`No convergence on ${docId} within ${timeoutMs} ms:\n${lines.join("\n")}`);
      }
      await sleep(20);
    }
  }

  async stop(): Promise<void> {
    for (const host of this.hosts) await host.stop().catch(() => undefined);
    this.hosts.length = 0;
    await this.proxy.close();
    await this.server.stop().catch(() => undefined);
    rmSync(this.server.dataDir, { recursive: true, force: true });
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      // Windows can hold a WAL file for a moment; temp dirs are disposable.
    }
  }
}
