// Shared setup for the wire-* tests: a real DocHub on an in-memory store,
// renderer replicas on in-memory ports adapted to the browser MessagePort
// shape, and a registry that resolves paths to that hub.

import { DocHub } from "../../../electron/collab/core/doc-hub";
import { createMemoryPortPair, type ReplicaEnd } from "../../../electron/collab/core/ports";
import { HostStore } from "../../../electron/collab/core/store";
import type { HostEvent, ResolvedDoc } from "../../../src/lib/collab/local-api";
import type { Role } from "../../../src/lib/collab/protocol/roles";
import { openReplica, type CollabReplica, type ReplicaMessagePort } from "../../../src/lib/collab/client/replica";
import { SharedDocRegistry } from "../../../src/lib/collab/client/registry";
import { quietLogger } from "./host-helpers";

/** The replica end of a memory pair, as a browser MessagePort. */
export function browserPort(end: ReplicaEnd): ReplicaMessagePort & { closed: boolean } {
  const unsubscribers = new Map<unknown, () => void>();
  const port = {
    closed: false,
    postMessage: (message: Parameters<ReplicaEnd["postMessage"]>[0]) => end.postMessage(message),
    addEventListener: (_type: "message", listener: (event: { data: unknown }) => void) => {
      unsubscribers.set(listener, end.onMessage((data) => listener({ data })));
    },
    removeEventListener: (_type: "message", listener: (event: { data: unknown }) => void) => {
      unsubscribers.get(listener)?.();
      unsubscribers.delete(listener);
    },
    close: () => { port.closed = true; end.close(); },
  };
  return port;
}

export interface Harness {
  store: HostStore;
  hub: DocHub;
  /** A replica attached to the hub (microtask batching, so tests stay fast). */
  replica(): CollabReplica;
  /** A registry resolving `paths` to this hub's document. */
  registry(options?: { paths?: string[]; kind?: ResolvedDoc["kind"] }): { registry: SharedDocRegistry; resolved: ResolvedDoc; resolveCalls: string[]; emit: (event: HostEvent) => void; ports: Array<{ closed: boolean }> };
  close(): void;
}

export function createHarness(options: { docId?: string; role?: Role; text?: string } = {}): Harness {
  const docId = options.docId ?? "d1";
  const store = new HostStore({ path: ":memory:" });
  if (options.role) store.updateDocMeta(docId, { role: options.role });
  const hub = new DocHub({ docId, store, logger: quietLogger });
  if (options.text) hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, options.text!), { source: "import" });
  const replicas: CollabReplica[] = [];
  const registries: SharedDocRegistry[] = [];
  const connect = () => {
    const pair = createMemoryPortPair();
    hub.attachReplica(pair.hub);
    return browserPort(pair.replica);
  };
  return {
    store,
    hub,
    replica() {
      const replica = openReplica(docId, connect(), { schedule: queueMicrotask });
      replicas.push(replica);
      return replica;
    },
    registry({ paths = ["Shared/note.md"], kind = "markdown" } = {}) {
      const resolved: ResolvedDoc = { docId, projectId: "p1", fileId: "f1", path: paths[0], kind, role: options.role ?? "editor", readOnly: false };
      const resolveCalls: string[] = [];
      let listener: ((event: HostEvent) => void) | null = null;
      const ports: Array<{ closed: boolean }> = [];
      const registry = new SharedDocRegistry({
        resolve: async (path) => { resolveCalls.push(path); return paths.includes(path) ? { ...resolved, path } : null; },
        attach: async () => { const port = connect(); ports.push(port); return port; },
        subscribeEvents: (next) => { listener = next; return () => { listener = null; }; },
        replicaOptions: { schedule: queueMicrotask },
        available: () => true,
      });
      registries.push(registry);
      return { registry, resolved, resolveCalls, emit: (event) => listener?.(event), ports };
    },
    close() {
      for (const registry of registries) registry.destroy();
      for (const replica of replicas) replica.destroy();
      hub.close();
      store.close();
    },
  };
}
