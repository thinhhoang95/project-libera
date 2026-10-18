// Tab-level registry of shared documents (plan M1.4).
//
// Editors are keyed by tab and unmount on every tab switch
// (docs/audits/2026-09-14-tab-lifecycle.md), so a replica cannot live in an
// editor component: the Y.Doc, its undo history and the presence state must
// survive the switch. The registry owns one replica per docId for this window
// and counts the holders using it: the tab that shows the file (released when
// the tab closes) and every panel that mounts an editor for it. The hub counts
// windows on its side.
//
// Path resolution goes through `/api/collab/docs/resolve?path=` and is cached,
// including negative answers, until a `files-changed` or `project-changed`
// host event says the manifest moved on.

import * as Y from "yjs";
import type { HostEvent, ResolvedDoc } from "../local-api";
import type { CollabUser } from "../awareness";
import { setLocalUser } from "../awareness";
import { collabClient } from "../ui/client";
import { getCollabBridge, subscribeHostEvents } from "../ui/bridge";
import { openReplica, type CollabReplica, type ReplicaMessagePort, type ReplicaOptions } from "./replica";

/** Origin of programmatic edits (applyTextToShared); the tab's undo manager tracks it. */
export class SharedEditOrigin {
  constructor(readonly docId: string) {}
}

export interface SharedDocSession {
  readonly docId: string;
  readonly resolved: ResolvedDoc;
  readonly replica: CollabReplica;
  /**
   * Undo history of the document in this window, shared by every editor that
   * binds it, so Undo after a tab switch still undoes the last local edit.
   * Recreated when the content sub-document is rebuilt.
   */
  readonly undoManager: Y.UndoManager;
  readonly editOrigin: SharedEditOrigin;
}

export type SharedTabState =
  /** Not a shared file (or collaboration is unavailable). */
  | { kind: "none" }
  /** In a shared notebook; resolving the path or attaching the replica. */
  | { kind: "pending"; path: string }
  | { kind: "shared"; path: string; session: SharedDocSession }
  | { kind: "error"; path: string; message: string };

export interface SharedDocLease {
  readonly docId: string;
  /** Resolves when the replica exists (its hub handshake may still be running). */
  readonly ready: Promise<SharedDocSession>;
  session(): SharedDocSession | null;
  release(): void;
}

export interface SharedDocRegistryOptions {
  resolve?: (path: string) => Promise<ResolvedDoc | null>;
  attach?: (docId: string) => Promise<ReplicaMessagePort>;
  subscribeEvents?: (listener: (event: HostEvent) => void) => () => void;
  replicaOptions?: ReplicaOptions;
  /** Whether live documents can be attached at all (the desktop bridge exists). */
  available?: () => boolean;
}

interface DocEntry {
  docId: string;
  resolved: ResolvedDoc;
  holders: Set<string>;
  session: SharedDocSession | null;
  ready: Promise<SharedDocSession>;
  failed: string | null;
  unsubscribe: Array<() => void>;
}

interface TabBinding {
  path: string;
  state: SharedTabState;
  lease: SharedDocLease | null;
  /** Bumped per bind call, so a slow resolve cannot overwrite a newer one. */
  token: number;
  /** A bindTab call for this binding is still resolving or attaching. */
  inflight: boolean;
}

const DEFAULT_USER: CollabUser = { name: "Me", color: "#30bced" };

function createUndoManager(replica: CollabReplica, origin: SharedEditOrigin) {
  return new Y.UndoManager(replica.ytext, { trackedOrigins: new Set([origin]) });
}

export class SharedDocRegistry {
  private readonly resolveImpl: (path: string) => Promise<ResolvedDoc | null>;
  private readonly attachImpl: (docId: string) => Promise<ReplicaMessagePort>;
  private readonly replicaOptions: ReplicaOptions | undefined;
  private readonly availableImpl: () => boolean;
  private readonly resolutions = new Map<string, { value: ResolvedDoc | null } | Promise<ResolvedDoc | null>>();
  private readonly entries = new Map<string, DocEntry>();
  private readonly tabs = new Map<string, TabBinding>();
  private readonly listeners = new Set<() => void>();
  private readonly statusReveal = new Set<(tabId: string) => void>();
  private version = 0;
  private user: CollabUser = DEFAULT_USER;
  private readonly stopEvents: () => void;
  private readonly onPageHide = () => this.flushAll();

  constructor(options: SharedDocRegistryOptions = {}) {
    this.resolveImpl = options.resolve ?? ((path) => collabClient.resolve(path));
    this.attachImpl = options.attach ?? (async (docId) => {
      const bridge = getCollabBridge();
      if (!bridge) throw new Error("Live collaboration needs the Libera desktop app.");
      return (await bridge.attach(docId)) as unknown as ReplicaMessagePort;
    });
    this.availableImpl = options.available ?? (() => getCollabBridge() !== null);
    this.replicaOptions = options.replicaOptions;
    this.stopEvents = (options.subscribeEvents ?? subscribeHostEvents)((event) => this.handleHostEvent(event));
    if (typeof window !== "undefined") {
      // The hub commits on receipt, so flushing the frame batch is all that is
      // needed before a reload or quit; server acks are not waited for.
      window.addEventListener("pagehide", this.onPageHide);
      window.addEventListener("beforeunload", this.onPageHide);
    }
  }

  get available(): boolean { return this.availableImpl(); }

  /* ---- Subscriptions (useSyncExternalStore) -------------------------------------- */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getVersion = (): number => this.version;

  private emit() {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  /* ---- Resolution ---------------------------------------------------------------- */

  /** The cached answer for a path: a ResolvedDoc, null (not shared) or undefined (unknown). */
  cachedResolution(path: string): ResolvedDoc | null | undefined {
    const cached = this.resolutions.get(path);
    return cached && !(cached instanceof Promise) ? cached.value : undefined;
  }

  resolvePath(path: string): Promise<ResolvedDoc | null> {
    const cached = this.resolutions.get(path);
    if (cached) return cached instanceof Promise ? cached : Promise.resolve(cached.value);
    const request = this.resolveImpl(path).then(
      (value) => {
        if (this.resolutions.get(path) === request) this.resolutions.set(path, { value: value ?? null });
        return value ?? null;
      },
      (error) => {
        // Not cached: a failed lookup is retried on the next open.
        if (this.resolutions.get(path) === request) this.resolutions.delete(path);
        throw error;
      },
    );
    this.resolutions.set(path, request);
    return request;
  }

  /** Forgets cached resolutions: all, or those for the given paths / project. */
  invalidate(filter: { paths?: string[]; projectId?: string } = {}) {
    if (!filter.paths && !filter.projectId) {
      this.resolutions.clear();
    } else {
      const paths = new Set(filter.paths ?? []);
      for (const [path, cached] of this.resolutions) {
        if (cached instanceof Promise) continue;
        // A project change can add files that were "not shared" a moment ago.
        if (paths.has(path) || (filter.projectId && (cached.value === null || cached.value.projectId === filter.projectId))) {
          this.resolutions.delete(path);
        }
      }
    }
    this.emit();
  }

  private handleHostEvent(event: HostEvent) {
    if (event.t === "files-changed") this.invalidate({ paths: event.paths, projectId: event.paths.length ? undefined : event.projectId });
    else if (event.t === "project-changed") this.invalidate({ projectId: event.projectId });
  }

  /* ---- Replicas, ref-counted by docId -------------------------------------------- */

  acquire(resolved: ResolvedDoc, holder: string): SharedDocLease {
    let entry = this.entries.get(resolved.docId);
    if (!entry) entry = this.openEntry(resolved);
    entry.holders.add(holder);
    const docId = resolved.docId;
    let released = false;
    const current = entry;
    return {
      docId,
      ready: current.ready,
      session: () => (released ? null : current.session),
      release: () => {
        if (released) return;
        released = true;
        this.releaseHolder(docId, holder);
      },
    };
  }

  /** Holders currently using a document (tabs and panels). */
  holders(docId: string): string[] {
    return [...(this.entries.get(docId)?.holders ?? [])];
  }

  session(docId: string): SharedDocSession | null {
    return this.entries.get(docId)?.session ?? null;
  }

  private openEntry(resolved: ResolvedDoc): DocEntry {
    const attaching = this.attachImpl(resolved.docId);
    const entry: DocEntry = {
      docId: resolved.docId,
      resolved,
      holders: new Set(),
      session: null,
      ready: attaching.then((port) => this.startSession(entry, port)),
      failed: null,
      unsubscribe: [],
    };
    entry.ready.catch((error: unknown) => {
      entry.failed = error instanceof Error ? error.message : String(error);
      this.emit();
    });
    this.entries.set(resolved.docId, entry);
    return entry;
  }

  private startSession(entry: DocEntry, port: ReplicaMessagePort): SharedDocSession {
    const { resolved } = entry;
    if (this.entries.get(resolved.docId) !== entry) {
      port.close();
      throw new Error("The shared document was closed while it opened.");
    }
    const replica = openReplica(resolved.docId, port, this.replicaOptions);
    setLocalUser(replica.awareness, this.user);
    const editOrigin = new SharedEditOrigin(resolved.docId);
    let session: SharedDocSession = { docId: resolved.docId, resolved, replica, editOrigin, undoManager: createUndoManager(replica, editOrigin) };
    entry.session = session;
    entry.unsubscribe.push(
      replica.subscribe(() => this.emit()),
      replica.onRebuild((subdoc) => {
        if (subdoc !== "content") return;
        // The old history refers to items of a destroyed Y.Doc.
        session.undoManager.destroy();
        session = { ...session, undoManager: createUndoManager(replica, editOrigin) };
        entry.session = session;
        this.emit();
      }),
    );
    this.emit();
    return session;
  }

  private releaseHolder(docId: string, holder: string) {
    const entry = this.entries.get(docId);
    if (!entry) return;
    entry.holders.delete(holder);
    if (entry.holders.size) return;
    this.entries.delete(docId);
    for (const unsubscribe of entry.unsubscribe) unsubscribe();
    if (entry.session) {
      entry.session.undoManager.destroy();
      entry.session.replica.destroy();
    }
    this.emit();
  }

  /* ---- Tabs ------------------------------------------------------------------------ */

  /**
   * Makes the tab `tabId` (showing `path`) use its shared document when the
   * path is shared. Idempotent: calling it again with the same path keeps the
   * binding unless the cached resolution was invalidated and changed.
   */
  async bindTab(tabId: string, path: string): Promise<SharedTabState> {
    const existing = this.tabs.get(tabId);
    const cached = this.cachedResolution(path);
    if (existing && existing.path === path) {
      if (existing.inflight) return existing.state;
      const boundDoc = existing.state.kind === "shared" ? existing.state.session.docId : null;
      if (cached !== undefined && (cached?.docId ?? null) === boundDoc && existing.state.kind !== "error") return existing.state;
    }
    const token = (existing?.token ?? 0) + 1;
    const binding: TabBinding = {
      path,
      token,
      inflight: true,
      lease: existing?.path === path ? existing.lease : null,
      state: existing?.path === path && existing.state.kind === "shared" ? existing.state : { kind: "pending", path },
    };
    if (existing && existing.path !== path) existing.lease?.release();
    this.tabs.set(tabId, binding);
    if (binding.state.kind === "pending") this.emit();

    const settle = (state: SharedTabState) => {
      if (this.tabs.get(tabId) !== binding) return this.tabs.get(tabId)?.state ?? { kind: "none" as const };
      binding.inflight = false;
      binding.state = state;
      this.emit();
      return state;
    };

    let resolved: ResolvedDoc | null;
    try {
      resolved = await this.resolvePath(path);
    } catch (error) {
      binding.lease?.release();
      binding.lease = null;
      return settle({ kind: "error", path, message: error instanceof Error ? error.message : "Could not open the shared document." });
    }
    if (this.tabs.get(tabId) !== binding) return this.tabs.get(tabId)?.state ?? { kind: "none" };
    if (!resolved) {
      binding.lease?.release();
      binding.lease = null;
      return settle({ kind: "none" });
    }
    if (binding.lease?.docId !== resolved.docId) {
      binding.lease?.release();
      binding.lease = this.acquire(resolved, `tab:${tabId}`);
    }
    try {
      const session = await binding.lease.ready;
      return settle({ kind: "shared", path, session });
    } catch (error) {
      return settle({ kind: "error", path, message: error instanceof Error ? error.message : "Could not open the shared document." });
    }
  }

  /** Marks a tab as possibly shared before its path resolves, so no regular editor mounts meanwhile. */
  markPending(tabId: string, path: string) {
    const existing = this.tabs.get(tabId);
    if (existing && existing.path === path) return;
    existing?.lease?.release();
    this.tabs.set(tabId, { path, token: (existing?.token ?? 0) + 1, inflight: false, lease: null, state: { kind: "pending", path } });
    this.emit();
  }

  /** Releases the tab's hold on its document (the tab closed or left the shared notebook). */
  releaseTab(tabId: string) {
    const binding = this.tabs.get(tabId);
    if (!binding) return;
    this.tabs.delete(tabId);
    binding.lease?.release();
    this.emit();
  }

  tabState(tabId: string): SharedTabState {
    const state = this.tabs.get(tabId)?.state ?? { kind: "none" as const };
    if (state.kind !== "shared") return state;
    const session = this.entries.get(state.session.docId)?.session;
    return session && session !== state.session ? { ...state, session } : state;
  }

  boundTabIds(): string[] {
    return [...this.tabs.keys()];
  }

  /** True for tabs whose content belongs to a shared document (even while it opens). */
  isSharedTab(tabId: string): boolean {
    const kind = this.tabs.get(tabId)?.state.kind;
    return kind === "shared" || kind === "pending";
  }

  sessionForTab(tabId: string): SharedDocSession | null {
    const state = this.tabs.get(tabId)?.state;
    if (state?.kind !== "shared") return null;
    // The entry keeps the current session (it changes when content is rebuilt).
    return this.entries.get(state.session.docId)?.session ?? null;
  }

  /** The live shared text of a tab, or null when it is not shared or not attached yet. */
  readTabText(tabId: string): string | null {
    const session = this.sessionForTab(tabId);
    return session && session.replica.getSnapshot().attached ? session.replica.text() : null;
  }

  /* ---- Presence and status ------------------------------------------------------------ */

  setLocalUser(user: CollabUser) {
    this.user = user;
    for (const entry of this.entries.values()) if (entry.session) setLocalUser(entry.session.replica.awareness, user);
  }

  get localUser(): CollabUser { return this.user; }

  /** Asks the tab's status pill to show its detail (Cmd/Ctrl+S on a shared tab). */
  revealStatus(tabId: string) {
    for (const listener of [...this.statusReveal]) listener(tabId);
  }

  onRevealStatus(listener: (tabId: string) => void): () => void {
    this.statusReveal.add(listener);
    return () => { this.statusReveal.delete(listener); };
  }

  flushAll() {
    for (const entry of this.entries.values()) entry.session?.replica.flush();
  }

  destroy() {
    this.stopEvents();
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.onPageHide);
      window.removeEventListener("beforeunload", this.onPageHide);
    }
    for (const tabId of [...this.tabs.keys()]) this.releaseTab(tabId);
    for (const [docId, entry] of [...this.entries]) for (const holder of [...entry.holders]) this.releaseHolder(docId, holder);
    this.listeners.clear();
  }
}

let sharedRegistry: SharedDocRegistry | null = null;

/** The window's registry. */
export function getSharedDocRegistry(): SharedDocRegistry {
  sharedRegistry ??= new SharedDocRegistry();
  return sharedRegistry;
}

/** Replaces the window's registry (tests); null recreates the default on next use. */
export function setSharedDocRegistry(registry: SharedDocRegistry | null) {
  if (sharedRegistry && sharedRegistry !== registry) sharedRegistry.destroy();
  sharedRegistry = registry;
}
