// Helpers for the p3b-* tests (Phase 3 part B): real hosts behind their
// control APIs against the real collab server, renderer windows (registry,
// replica, suggestions controller) on a host, and what a jsdom window needs
// to run the real React UI on top of one host: `/api/collab/*` routed to its
// control API, `window.liberaCollab` events, and a status store with its
// account.
//
// Import this before React or any editor module: it installs the jsdom
// window (wire-dom) and then puts Node's own Event back so the host's real
// WebSockets keep working (p3a-node-websocket).

import { restoreNodeEvent } from "./p3a-node-websocket";
import { dom } from "./wire-dom";

import assert from "node:assert/strict";
import path from "node:path";

import { startControlApp, type ControlApp } from "../../../electron/collab/control";
import type { SecretCodec } from "../../../electron/collab/control/account";
import type { NotebookService } from "../../../electron/collab/control/types";
import type { FetchLike } from "../../../electron/collab/core/api-client";
import { createMemoryPortPair } from "../../../electron/collab/core/ports";
import { defaultWebSocketFactory, type WebSocketFactory, type WebSocketLike } from "../../../electron/collab/core/sync-client";
import { createSharedDocument } from "../../../electron/collab/notebooks/documents";
import { SharedDocRegistry, type SharedDocSession } from "../../../src/lib/collab/client/registry";
import { suggestionsFor, type SuggestionsController } from "../../../src/lib/collab/client/suggestions";
import { createSuggestionsApi } from "../../../src/lib/collab/client/suggestions-api";
import { ControlRoutes, type HostEvent, type HostStatus, type LiberaCollabBridge, type ResolvedDoc } from "../../../src/lib/collab/local-api";
import type { Invitation, UserSummary } from "../../../src/lib/collab/protocol/api";
import type { Role } from "../../../src/lib/collab/protocol/roles";
import type { DocKind } from "../../../src/lib/collab/protocol/schema";
import { createCollabClient, type CollabClient } from "../../../src/lib/collab/ui/client";
import type { CollabSnapshot, CollabStatusStore } from "../../../src/lib/collab/ui/status-store";
import { browserPort } from "./wire-harness";

restoreNodeEvent();
// What React and the panels use beyond wire-dom's globals.
for (const key of ["HTMLButtonElement", "HTMLSelectElement", "HTMLFormElement", "FocusEvent", "PointerEvent", "InputEvent", "StorageEvent", "localStorage", "CustomEvent"] as const) {
  if (key in dom.window) Object.defineProperty(globalThis, key, { value: dom.window[key as keyof typeof dom.window], configurable: true, writable: true });
}
dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};

export { dom };

const quietLogger = { warn() {}, error() {} };
const fakeSecrets: SecretCodec = {
  encrypt: async (plaintext) => `enc:${Buffer.from(plaintext).toString("base64")}`,
  decrypt: async (ciphertext) => Buffer.from(ciphertext.slice(4), "base64").toString(),
};

export async function until(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A host's network: off, every socket drops and every request fails as a network error. */
export function networkSwitch() {
  let online = true;
  const sockets = new Set<WebSocketLike>();
  const factory: WebSocketFactory = (url) => {
    if (!online) {
      const refused: WebSocketLike = { binaryType: "arraybuffer", readyState: 3, onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} };
      setTimeout(() => { refused.onerror?.({}); refused.onclose?.({ code: 1006, reason: "offline" }); }, 5);
      return refused;
    }
    const socket = defaultWebSocketFactory(url);
    sockets.add(socket);
    return socket;
  };
  const fetchImpl: FetchLike = (url, init) => (online ? fetch(url, init) : Promise.reject(new TypeError("fetch failed (offline)")));
  return {
    factory,
    fetch: fetchImpl,
    get online() { return online; },
    set(value: boolean) {
      online = value;
      if (value) return;
      for (const socket of sockets) {
        try { socket.close(4000, "offline"); } catch { /* already closed */ }
      }
      sockets.clear();
    },
  };
}

export type NetworkSwitch = ReturnType<typeof networkSwitch>;

/** A notebook service that maps fixed Libera paths to documents (no folders on disk). */
export function fixedNotebooks(docs: () => ResolvedDoc[]) {
  return (): NotebookService => ({
    start: async () => {},
    stop: async () => {},
    resolvePath: (liberaPath) => docs().find((doc) => doc.path === liberaPath) ?? null,
    resolveDoc: (docId) => docs().find((doc) => doc.docId === docId) ?? null,
    accountChanged: async () => {},
    registerRoutes: () => {},
    localProjects: () => [],
  });
}

export interface Client {
  name: string;
  app: ControlApp;
  events: HostEvent[];
  listeners: Set<(event: HostEvent) => void>;
  userId: string;
  account: UserSummary;
  /** Typed client on this host's control API (what `/api/collab/*` reaches). */
  client: CollabClient;
  network: NetworkSwitch | null;
  call<T>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }>;
  /** Paths this host resolves (fixedNotebooks); tests push to it. */
  docs: ResolvedDoc[];
}

export interface StartClientOptions {
  network?: NetworkSwitch;
  invitationToken?: string;
}

export async function startClient(root: string, name: string, serverUrl: string, options: StartClientOptions = {}): Promise<Client> {
  const events: HostEvent[] = [];
  const listeners = new Set<(event: HostEvent) => void>();
  const docs: ResolvedDoc[] = [];
  const network = options.network ?? null;
  const app = await startControlApp({
    collabDir: path.join(root, name),
    libraryRoot: path.join(root, name, "library"),
    appVersion: "test",
    installationId: `inst_${name}_p3b`,
    secrets: fakeSecrets,
    emit: (event) => {
      events.push(event);
      for (const listener of [...listeners]) listener(event);
    },
    logger: quietLogger,
    createNotebookService: fixedNotebooks(() => docs),
    ...(network ? { fetch: network.fetch } : {}),
    host: { compaction: false, hubIdleMs: 50, limits: { backoffBaseMs: 40, backoffMaxMs: 250 }, ...(network ? { webSocketFactory: network.factory } : {}) },
  });
  const authorization = `Bearer ${app.address.token}`;
  const fetchControl = (input: string, init?: RequestInit) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), authorization } });
  const call = async <T>(method: string, route: string, body?: unknown) => {
    const response = await fetchControl(`${app.address.url}${route}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
  const registered = await call<HostStatus>("POST", ControlRoutes.register, {
    serverUrl,
    email: `${name}@example.test`,
    password: "correct horse battery",
    displayName: name[0].toUpperCase() + name.slice(1),
    ...(options.invitationToken ? { invitationToken: options.invitationToken } : {}),
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  await until(() => app.runtime.host.connectionState === "connected", `${name} to connect`);
  const account = registered.body.account!;
  return {
    name,
    app,
    events,
    listeners,
    userId: account.id,
    account: { id: account.id, displayName: account.displayName, color: account.color },
    client: createCollabClient({ prefix: app.address.url, fetch: fetchControl }),
    network,
    call,
    docs,
  };
}

/** Subscribes like window.liberaCollab.onEvent on this client's host. */
export function hostEvents(client: Client) {
  return (listener: (event: HostEvent) => void) => {
    client.listeners.add(listener);
    return () => { client.listeners.delete(listener); };
  };
}

export interface Project {
  projectId: string;
  /** Invites `email` with `role`; returns the invitation link. */
  invite(email: string, role: Exclude<Role, "owner">): Promise<string>;
  /** Creates a shared document and registers its path on the given clients. */
  addDoc(path: string, text: string, clients: Array<[Client, Role]>, kind?: DocKind): Promise<ResolvedDoc & { docId: string }>;
}

let docCounter = 0;

export async function createProject(owner: Client, name: string, serverUrl: string): Promise<Project> {
  const api = owner.app.runtime.host.api!;
  const project = await api.createProject({ name });
  return {
    projectId: project.id,
    async invite(email, role) {
      const created = await owner.call<Invitation>("POST", ControlRoutes.invitations(project.id), { email, role });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      return `${serverUrl}/invite/${created.body.token}`;
    },
    async addDoc(liberaPath, text, clients, kind = "markdown") {
      docCounter += 1;
      const suffix = `${Date.now().toString(36)}${docCounter}`;
      const ids = { docId: `doc_p3b_${suffix}`, fileId: `file_p3b_${suffix}` };
      await createSharedDocument(api, project.id, ids, kind, text);
      let base: ResolvedDoc | null = null;
      for (const [client, role] of clients) {
        const resolved: ResolvedDoc = { docId: ids.docId, projectId: project.id, fileId: ids.fileId, path: liberaPath, kind, role, readOnly: false };
        client.docs.push(resolved);
        base ??= resolved;
      }
      return base!;
    },
  };
}

export interface Window {
  client: Client;
  registry: SharedDocRegistry;
  session: SharedDocSession;
  controller: SuggestionsController;
  tabId: string;
  text(): string;
  close(): void;
}

/** A renderer window on `client`'s host: replica, registry and controller on that host's control API. */
export async function openWindow(client: Client, resolved: ResolvedDoc, options: { tabId?: string; role?: Role } = {}): Promise<Window> {
  const host = client.app.runtime.host;
  const hub = host.acquire(resolved.docId, { projectId: resolved.projectId });
  const registry = new SharedDocRegistry({
    resolve: async (liberaPath) => (liberaPath === resolved.path ? resolved : null),
    attach: async () => {
      const pair = createMemoryPortPair();
      hub.attachReplica(pair.hub);
      return browserPort(pair.replica);
    },
    subscribeEvents: () => () => {},
    replicaOptions: { schedule: (run) => queueMicrotask(run) },
    available: () => true,
  });
  registry.setLocalUser({ name: client.account.displayName, color: client.account.color, userId: client.userId });
  const tabId = options.tabId ?? `tab-${client.name}`;
  await registry.bindTab(tabId, resolved.path);
  const session = registry.sessionForTab(tabId)!;
  await session.replica.whenAttached();
  const role = options.role ?? resolved.role;
  await until(() => session.replica.getSnapshot().meta?.role === role && session.replica.getSnapshot().status?.state !== "loading", `${client.name}'s replica to load as ${role}`);
  const controller = suggestionsFor(session, {
    api: createSuggestionsApi(client.client),
    registry,
    subscribeEvents: hostEvents(client),
    loadMembers: (projectId) => client.client.members(projectId),
    pollMs: 150,
  });
  return {
    client,
    registry,
    session,
    controller,
    tabId,
    text: () => session.replica.text(),
    close() {
      controller.destroy();
      registry.destroy();
      host.release(resolved.docId);
    },
  };
}

type Route = (body: unknown, url: URL) => unknown | Response | Promise<unknown | Response>;

/**
 * The renderer's global fetch for one window on `client`: `/api/collab/*`
 * reaches the host's control API, `routes` ("METHOD /path") answer other app
 * routes, and anything absolute passes through (the host's own requests).
 */
export function installRendererFetch(client: Client, routes: Record<string, Route> = {}) {
  const original = globalThis.fetch;
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(input instanceof Request ? input.url : input);
    if (/^https?:/.test(raw)) return original(input, init);
    const url = new URL(raw, "http://localhost");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });
    if (url.pathname.startsWith("/api/collab/")) {
      return original(`${client.app.address.url}${url.pathname.slice("/api/collab".length)}${url.search}`, {
        ...init,
        headers: { ...(init?.headers as Record<string, string> | undefined), authorization: `Bearer ${client.app.address.token}` },
      });
    }
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) return new Response(JSON.stringify({ error: `No fake for ${method} ${url.pathname}` }), { status: 404 });
    const result = await handler(body, url);
    if (result instanceof Response) return result;
    return result === undefined ? new Response(null, { status: 204 }) : Response.json(result);
  };
  Object.defineProperty(globalThis, "fetch", { value: fetchImpl, configurable: true, writable: true });
  return { calls, restore: () => Object.defineProperty(globalThis, "fetch", { value: original, configurable: true, writable: true }) };
}

/** `window.liberaCollab` with `client`'s host events. */
export function installBridge(client: Client) {
  const bridge: LiberaCollabBridge = {
    attach: () => Promise.reject(new Error("Windows in these tests attach through their registry.")),
    onEvent: hostEvents(client),
    nudge() {},
  };
  Object.defineProperty(dom.window, "liberaCollab", { value: bridge, configurable: true, writable: true });
  return { remove: () => Reflect.deleteProperty(dom.window, "liberaCollab") };
}

/** A status store that says `client` is signed in and connected (setConnection changes it). */
export function statusStoreFor(client: Client, projects: HostStatus["projects"] = []): CollabStatusStore & { setConnection(connection: HostStatus["connection"]): void } {
  const status = (connection: HostStatus["connection"]): HostStatus => ({
    hostVersion: 1,
    connection,
    account: { id: client.userId, email: `${client.name}@example.test`, displayName: client.account.displayName, color: client.account.color, serverUrl: "http://collab.test" },
    projects,
    pendingCommands: 0,
  });
  let snapshot: CollabSnapshot = { phase: "ready", status: status("connected") };
  const listeners = new Set<() => void>();
  const set = (next: HostStatus) => { snapshot = { phase: "ready", status: next }; for (const listener of [...listeners]) listener(); };
  return {
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    refresh: async () => {},
    refreshProjects: async () => {},
    setStatus: set,
    setConnection: (connection) => set(status(connection)),
  };
}

/**
 * Browsers refuse `queueMicrotask` (and timers) called with a foreign
 * `this` ("Illegal invocation"); Node does not care. Installs that check so
 * a test sees what Electron would.
 */
export function strictBrowserGlobals(): () => void {
  const originals = { queueMicrotask: globalThis.queueMicrotask, setTimeout: globalThis.setTimeout };
  const guard = <T extends (...args: never[]) => unknown>(name: string, fn: T) => function (this: unknown, ...args: Parameters<T>) {
    if (this !== undefined && this !== globalThis && this !== dom.window) throw new TypeError(`Failed to execute '${name}' on 'Window': Illegal invocation`);
    return fn.apply(globalThis, args);
  };
  Object.defineProperty(globalThis, "queueMicrotask", { value: guard("queueMicrotask", originals.queueMicrotask), configurable: true, writable: true });
  return () => Object.defineProperty(globalThis, "queueMicrotask", { value: originals.queueMicrotask, configurable: true, writable: true });
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
