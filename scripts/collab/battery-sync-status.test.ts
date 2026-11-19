// Battery: one shared document's sync status does not wake the window.
//
// Status frames (phase, pending count, server ack) reach only the subscribers
// of that document's replica; the registry version, the root hook
// (useSharedTabs) and panes on other documents stay quiet. Attachment,
// deletion, read-only and rebuild still bump the version. The host status
// store ignores identical payloads and does not fetch before sign-in.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement, type ReactElement } from "react";
import { cleanup, flush, hostStatus, project, render } from "./ui-support";

import { SharedDocRegistry, setSharedDocRegistry } from "../../src/lib/collab/client/registry";
import { useSharedTab, useSharedTabs } from "../../src/lib/collab/bindings/react-shared-tabs";
import type { HostEvent, HostStatus, ResolvedDoc } from "../../src/lib/collab/local-api";
import type { SyncStatus } from "../../src/lib/collab/protocol/local";
import { createCollabStatusStore, setCollabStatusStore, type CollabStatusStore } from "../../src/lib/collab/ui/status-store";
import type { CollabClient } from "../../src/lib/collab/ui/client";

afterEach(async () => {
  await cleanup();
  setSharedDocRegistry(null);
  setCollabStatusStore(null);
});

type Listener = (event: { data: unknown }) => void;

function handPort() {
  const delivered = new Set<Listener>();
  const port = {
    postMessage: () => {},
    addEventListener: (_type: "message", listener: Listener) => { delivered.add(listener); },
    removeEventListener: (_type: "message", listener: Listener) => { delivered.delete(listener); },
    close: () => {},
  };
  const hub = (data: unknown) => { for (const listener of [...delivered]) listener({ data }); };
  return { port, hub };
}

function doc(docId: string, path: string): ResolvedDoc {
  return { docId, projectId: "p1", fileId: `f_${docId}`, path, kind: "markdown", role: "editor", readOnly: false };
}

function sync(pending: number, state: SyncStatus["state"] = "saving"): SyncStatus {
  return { state, pending, oldestPendingAgeMs: 0, lastAckAt: null, connected: true };
}

const META = (docId: string, readOnly = false) => ({ docId, projectId: "p1", role: "editor", schemaVersion: 1, readOnly });

function fakeStatusClient(calls: { status: number }, status: () => HostStatus): CollabClient {
  return { status: async () => { calls.status += 1; return status(); } } as unknown as CollabClient;
}

function tab(id: string, path: string) {
  return { id, draft: "", saved: "", file: { path, notebook: "Shared", fileType: "markdown" as const } };
}

const TABS = [tab("tA", "Shared/a.md"), tab("tB", "Shared/b.md")];

async function setup(options: { enabled?: boolean; status?: () => HostStatus } = {}) {
  const ports = { d1: handPort(), d2: handPort() };
  const docs: Record<string, ResolvedDoc> = { "Shared/a.md": doc("d1", "Shared/a.md"), "Shared/b.md": doc("d2", "Shared/b.md") };
  const registry = new SharedDocRegistry({
    resolve: async (path) => docs[path] ?? null,
    attach: async (docId) => (docId === "d1" ? ports.d1.port : ports.d2.port) as never,
    subscribeEvents: () => () => {},
    replicaOptions: { schedule: queueMicrotask },
    available: () => true,
  });
  setSharedDocRegistry(registry);
  const calls = { status: 0 };
  const events = new Set<(event: HostEvent) => void>();
  const store: CollabStatusStore = createCollabStatusStore({
    client: fakeStatusClient(calls, options.status ?? (() => hostStatus({ projects: [project({ notebook: "Shared" })] }))),
    subscribeEvents: (listener) => { events.add(listener); return () => { events.delete(listener); }; },
    hasLiveEvents: () => true,
    retryMs: 0,
  });
  setCollabStatusStore(store);
  const renders = { root: 0, paneB: 0, badgeA: 0 };
  const Root = ({ enabled }: { enabled: boolean }): ReactElement => {
    renders.root += 1;
    useSharedTabs(TABS, { onText: () => {}, enabled });
    return createElement("div");
  };
  const PaneB = (): ReactElement => {
    renders.paneB += 1;
    useSharedTab("tB", "pane-b", { snapshot: false });
    return createElement("div");
  };
  const BadgeA = (): ReactElement => {
    renders.badgeA += 1;
    useSharedTab("tA", "badge-a");
    return createElement("div");
  };
  const App = ({ enabled }: { enabled: boolean }): ReactElement => createElement("div", null, createElement(Root, { enabled }), createElement(PaneB), createElement(BadgeA));
  const view = await render(createElement(App, { enabled: options.enabled ?? true }));
  await flush();
  const emit = (event: HostEvent) => events.forEach((listener) => listener(event));
  return { registry, ports, renders, calls, store, emit, view, App };
}

test("status frames of one document wake only that document's subscribers", async () => {
  const { registry, ports, renders } = await setup();
  ports.d1.hub({ t: "meta", docId: "d1", meta: META("d1") });
  ports.d1.hub({ t: "status", docId: "d1", status: sync(0, "saved-remote") });
  ports.d2.hub({ t: "meta", docId: "d2", meta: META("d2") });
  ports.d2.hub({ t: "status", docId: "d2", status: sync(0, "saved-remote") });
  await flush();
  assert.equal(registry.session("d1")?.replica.getSnapshot().attached, true);

  const version = registry.getVersion();
  const before = { ...renders };
  let durability = 0;
  registry.subscribeDurability(() => { durability += 1; });
  for (let pending = 1; pending <= 5; pending += 1) {
    ports.d1.hub({ t: "status", docId: "d1", status: sync(pending) });
    await flush(1);
  }
  assert.equal(registry.getVersion(), version, "no version bump for sync status");
  assert.equal(renders.root, before.root, "the root hook did not render");
  assert.equal(renders.paneB, before.paneB, "a pane on another document did not render");
  assert.equal(renders.badgeA - before.badgeA, 5, "the document's own badge rendered once per status");
  assert.equal(durability, 5, "the unconfirmed count's observers still hear of status changes");
});

test("attachment, read-only, deletion and rebuild still bump the registry version", async () => {
  const { registry, ports } = await setup();
  await registry.acquire(doc("d1", "Shared/a.md"), "probe").ready;
  const base = registry.getVersion();
  ports.d1.hub({ t: "status", docId: "d1", status: sync(0, "saved-remote") });
  assert.equal(registry.getVersion(), base + 1, "attached");
  ports.d1.hub({ t: "meta", docId: "d1", meta: { ...META("d1", true), readOnlyReason: "role" } });
  assert.equal(registry.getVersion(), base + 2, "read-only reason");
  ports.d1.hub({ t: "status", docId: "d1", status: sync(0, "read-only") });
  assert.equal(registry.getVersion(), base + 3, "a lock state");
  ports.d1.hub({ t: "rejected", docId: "d1", subdoc: "content", reason: "too big", rejectedText: "x" });
  assert.ok(registry.getVersion() > base + 3, "rebuild of the content subdoc");
  const afterRebuild = registry.getVersion();
  ports.d1.hub({ t: "closed", docId: "d1", reason: "document-deleted" });
  assert.ok(registry.getVersion() > afterRebuild, "deletion");
});

test("identical status payloads publish nothing", async () => {
  const { store, emit } = await setup();
  let publications = 0;
  store.subscribe(() => { publications += 1; });
  const payload = hostStatus({ projects: [project({ notebook: "Shared" })], pendingCommands: 2 });
  emit({ t: "status", status: payload });
  assert.equal(publications, 1);
  emit({ t: "status", status: structuredClone(payload) });
  emit({ t: "status", status: structuredClone(payload) });
  assert.equal(publications, 1, "equal payloads keep the snapshot");
  emit({ t: "status", status: { ...payload, pendingCommands: 3 } });
  assert.equal(publications, 2);
});

test("the root hook ignores status changes other than projects and account", async () => {
  const { renders, emit } = await setup();
  const base = hostStatus({ projects: [project({ notebook: "Shared" })] });
  emit({ t: "status", status: { ...base, pendingCommands: 1 } });
  await flush();
  const before = renders.root;
  emit({ t: "status", status: { ...base, pendingCommands: 2 } });
  emit({ t: "status", status: { ...base, pendingCommands: 3, connection: "offline" } });
  emit({ t: "status", status: structuredClone({ ...base, pendingCommands: 3, connection: "offline" }) });
  await flush();
  assert.equal(renders.root, before, "connection and command counts do not wake the root");
  emit({ t: "status", status: { ...base, projects: [project({ notebook: "Shared" }), project({ projectId: "p2", notebook: "Lab" })] } });
  await flush();
  assert.ok(renders.root > before, "a changed project list still does");
});

test("no status request before the user is signed in", async () => {
  const { calls, view, App, store } = await setup({ enabled: false });
  assert.equal(calls.status, 0, "nothing fetched while signed out");
  await flush();
  assert.equal(calls.status, 0);
  await view.rerender(createElement(App, { enabled: true }));
  await flush();
  assert.ok(calls.status >= 1, "fetched once signed in");
  assert.equal(store.getSnapshot().phase, "ready");
});

test("the unconfirmed count follows status changes", async () => {
  const { registry, ports } = await setup();
  await registry.acquire(doc("d1", "Shared/a.md"), "probe").ready;
  ports.d1.hub({ t: "status", docId: "d1", status: sync(0, "saved-remote") });
  await flush();
  const replica = registry.session("d1")!.replica;
  let wakes = 0;
  registry.subscribeDurability(() => { wakes += 1; });
  replica.ytext.insert(0, "abc");
  await Promise.resolve();
  assert.equal(registry.unconfirmedDocumentCount(), 1);
  ports.d1.hub({ t: "status", docId: "d1", status: sync(1) });
  assert.ok(wakes >= 1, "libera-app's dirty count is told the document has unconfirmed work");
});
