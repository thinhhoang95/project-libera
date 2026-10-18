// Phase 2 test peers: a full control app (CollabRuntime with the real
// NotebookService and CollabHost) per person against the real collab server,
// plus what the renderer would use on top of it: a typed client on the
// control API, renderer replicas on memory ports, and SharedReviewStores.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { startControlApp, type ControlApp } from "../../../electron/collab/control";
import type { SecretCodec } from "../../../electron/collab/control/account";
import { createMemoryPortPair } from "../../../electron/collab/core/ports";
import { openReplica, type CollabReplica } from "../../../src/lib/collab/client/replica";
import { ControlRoutes, type HostEvent, type HostStatus, type Invitation, type ResolvedDoc } from "../../../src/lib/collab/local-api";
import type { UserSummary } from "../../../src/lib/collab/protocol/api";
import { createThreadApi, type ThreadApi } from "../../../src/lib/collab/review-store/api";
import { SharedReviewStore } from "../../../src/lib/collab/review-store/shared";
import { createCollabClient, type CollabClient } from "../../../src/lib/collab/ui/client";
import type { ServerProcess } from "./server-process";
import { browserPort } from "./wire-harness";

const fakeSecrets: SecretCodec = {
  encrypt: async (plaintext) => `enc:${Buffer.from(plaintext).toString("base64")}`,
  decrypt: async (ciphertext) => Buffer.from(ciphertext.slice(4), "base64").toString(),
};

const quietLogger = { warn() {}, error() {} };

export async function until(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export interface P2Peer {
  name: string;
  dir: string;
  library: string;
  app: ControlApp;
  events: HostEvent[];
  /** Subscribes like window.liberaCollab.onEvent. */
  subscribe(listener: (event: HostEvent) => void): () => void;
  call<T>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }>;
  client: CollabClient;
  threads: ThreadApi;
  account: UserSummary;
  /** What the renderer's status store would say about the connection. */
  online: boolean;
  replica(docId: string): Promise<CollabReplica>;
  store(resolved: ResolvedDoc, replica: CollabReplica, options?: { detachDelayMs?: number }): SharedReviewStore;
  close(): Promise<void>;
}

export async function startPeer(root: string, name: string, server: ServerProcess): Promise<P2Peer> {
  const dir = path.join(root, name);
  const library = path.join(dir, "library");
  mkdirSync(library, { recursive: true });
  const listeners = new Set<(event: HostEvent) => void>();
  const events: HostEvent[] = [];
  const app = await startControlApp({
    collabDir: dir,
    libraryRoot: library,
    appVersion: "test",
    installationId: `inst_${name}_p2`,
    secrets: fakeSecrets,
    emit: (event) => {
      events.push(event);
      for (const listener of [...listeners]) listener(event);
    },
    logger: quietLogger,
    host: { compaction: false, hubIdleMs: 60_000, limits: { backoffBaseMs: 50, backoffMaxMs: 400 } },
  });
  const authorization = `Bearer ${app.address.token}`;
  const fetchControl = (input: string, init?: RequestInit) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), authorization } });
  const client = createCollabClient({ prefix: app.address.url, fetch: fetchControl });
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
    serverUrl: server.url,
    email: `${name.toLowerCase()}@example.test`,
    password: "correct horse battery",
    displayName: name,
  });
  if (registered.status !== 201 || !registered.body.account) throw new Error(`register ${name}: ${registered.status} ${JSON.stringify(registered.body)}`);
  const account = { id: registered.body.account.id, displayName: registered.body.account.displayName, color: registered.body.account.color };
  await until(() => app.runtime.host.connectionState === "connected", `${name} to connect`);
  const replicas: CollabReplica[] = [];
  const stores: SharedReviewStore[] = [];
  const peer: P2Peer = {
    name,
    dir,
    library,
    app,
    events,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    call,
    client,
    threads: createThreadApi(client.request),
    account,
    online: true,
    async replica(docId) {
      const pair = createMemoryPortPair();
      app.runtime.host.attachReplica(docId, pair.hub);
      const replica = openReplica(docId, browserPort(pair.replica), { schedule: queueMicrotask });
      replicas.push(replica);
      await replica.whenAttached();
      // The hub answers the attach before its first server state; tests
      // start from the document as the server has it.
      await until(() => replica.getSnapshot().status?.state !== "loading", `${name}'s replica of ${docId} to load`);
      return replica;
    },
    store(resolved, replica, options = {}) {
      const store = new SharedReviewStore({
        docId: resolved.docId,
        projectId: resolved.projectId,
        key: resolved.path,
        replica,
        me: () => account,
        role: () => replica.getSnapshot().meta?.role ?? resolved.role,
        online: () => peer.online,
        api: peer.threads,
        subscribeEvents: (listener) => peer.subscribe(listener),
        detachDelayMs: options.detachDelayMs ?? 100,
      });
      stores.push(store);
      return store;
    },
    async close() {
      for (const store of stores) store.destroy();
      for (const replica of replicas) replica.destroy();
      await app.close();
    },
  };
  return peer;
}

/** Writes files into `owner`'s library and shares the notebook; returns the projectId. */
export async function shareNotebook(owner: P2Peer, notebook: string, files: Record<string, string>): Promise<string> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(owner.library, notebook, ...relative.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const shared = await owner.call<{ projectId: string }>("POST", ControlRoutes.share, { notebook });
  if (shared.status !== 200) throw new Error(`share: ${shared.status} ${JSON.stringify(shared.body)}`);
  await until(() => owner.app.runtime.status().projects.some((project) => project.projectId === shared.body.projectId), "the shared project in status");
  return shared.body.projectId;
}

/** Invites `member` with `role` and joins through their control API; returns the joined notebook folder. */
export async function joinNotebook(owner: P2Peer, member: P2Peer, projectId: string, role: "editor" | "commenter" | "viewer"): Promise<string> {
  const invitation = await owner.call<Invitation>("POST", ControlRoutes.invitations(projectId), { email: `${member.name.toLowerCase()}@example.test`, role });
  if (invitation.status !== 201) throw new Error(`invite: ${invitation.status} ${JSON.stringify(invitation.body)}`);
  const joined = await member.call<{ notebook: string }>("POST", ControlRoutes.join, { invitation: invitation.body.token });
  if (joined.status !== 200) throw new Error(`join: ${joined.status} ${JSON.stringify(joined.body)}`);
  return joined.body.notebook;
}

export async function resolvePath(peer: P2Peer, liberaPath: string): Promise<ResolvedDoc> {
  let resolved: ResolvedDoc | null = null;
  await until(async () => {
    resolved = (await peer.call<ResolvedDoc | null>("GET", `${ControlRoutes.resolve}?path=${encodeURIComponent(liberaPath)}`)).body;
    return !!resolved;
  }, `${peer.name} to resolve ${liberaPath}`);
  return resolved!;
}
