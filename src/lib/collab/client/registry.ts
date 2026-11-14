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
  /** First wait between attempts to re-attach to a restarted host (doubles up to 10 s). Defaults to 1 s. */
  reconnectDelayMs?: number;
}

interface DocEntry {
  docId: string;
  resolved: ResolvedDoc;
  holders: Set<string>;
  session: SharedDocSession | null;
  ready: Promise<SharedDocSession>;
  failed: string | null;
  unsubscribe: Array<() => void>;
  /** A re-attach to a restarted host is running. */
  reconnecting?: boolean;
  /** Another host generation arrived meanwhile: attach once more when this attempt ends. */
  reconnectAgain?: boolean;
}

interface TabBinding {
  path: string;
  state: SharedTabState;
  lease: SharedDocLease | null;
  /** Bumped per bind call, so a slow resolve cannot overwrite a newer one. */
  token: number;
  /** A bindTab call for this binding is still resolving or attaching. */
  inflight: boolean;
  /** The path was removed while this tab was resolving or attached. */
  deleted: boolean;
}

const DEFAULT_USER: CollabUser = { name: "Me", color: "#30bced" };

function createUndoManager(replica: CollabReplica, origin: SharedEditOrigin) {
  return new Y.UndoManager(replica.ytext, { trackedOrigins: new Set([origin]) });
}

/** ResolvedDoc is plain data: equal when every field (binding, role, read-only, revoked) matches. */
function sameResolution(a: ResolvedDoc, b: ResolvedDoc): boolean {
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    // An absent flag and false mean the same.
    if ((left[key] ?? false) !== (right[key] ?? false)) return false;
  }
  return true;
}

export class SharedDocRegistry {
  private readonly resolveImpl: (path: string) => Promise<ResolvedDoc | null>;
  private readonly attachImpl: (docId: string) => Promise<ReplicaMessagePort>;
  private readonly replicaOptions: ReplicaOptions | undefined;
  private readonly availableImpl: () => boolean;
  private readonly reconnectDelayMs: number;
  private readonly resolutions = new Map<string, { value: ResolvedDoc | null } | Promise<ResolvedDoc | null>>();
  /** Paths with a background re-check running (one at a time per path). */
  private readonly revalidating = new Set<string>();
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
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
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

  /**
   * Forgets cached resolutions: all, or those for the given paths / project.
   * `unsharedOnly` keeps paths known to be shared documents (a working-copy
   * write leaves a path bound to the same document). Subscribers hear of it
   * only when something was forgotten.
   */
  invalidate(filter: { paths?: string[]; projectId?: string; unsharedOnly?: boolean } = {}): boolean {
    let forgot = false;
    if (!filter.paths && !filter.projectId) {
      forgot = this.resolutions.size > 0;
      this.resolutions.clear();
    } else {
      const paths = new Set(filter.paths ?? []);
      for (const [path, cached] of this.resolutions) {
        if (cached instanceof Promise) continue;
        if (filter.unsharedOnly && cached.value !== null) continue;
        // A project change can add files that were "not shared" a moment ago.
        if (paths.has(path) || (filter.projectId && (cached.value === null || cached.value.projectId === filter.projectId))) {
          this.resolutions.delete(path);
          forgot = true;
        }
      }
    }
    if (forgot) this.emit();
    return forgot;
  }

  /**
   * Looks a cached shared path up again without telling anyone. A repaired or
   * restored manifest can bind the same path to another document without any
   * tree event, so the answer is compared: only a different one forgets the
   * entry (and wakes subscribers, so tabs re-bind). Errors keep the cached entry.
   */
  private revalidate(path: string) {
    const cached = this.resolutions.get(path);
    if (!cached || cached instanceof Promise || cached.value === null || this.revalidating.has(path)) return;
    this.revalidating.add(path);
    this.resolveImpl(path).then(
      (value) => {
        this.revalidating.delete(path);
        // A newer invalidation or lookup replaced the entry meanwhile: that answer wins.
        if (this.resolutions.get(path) !== cached) return;
        if (cached.value && value && sameResolution(cached.value, value)) return;
        this.resolutions.delete(path);
        this.emit();
      },
      () => { this.revalidating.delete(path); },
    );
  }

  private handleHostEvent(event: HostEvent) {
    if (event.t === "host-down") {
      // The ports of the dead process carry nothing any more: keep the edits
      // in this window and count them as unsaved until the replacement is up.
      for (const entry of this.entries.values()) entry.session?.replica.hostLost();
      this.emit();
    } else if (event.t === "host-ready") {
      for (const entry of [...this.entries.values()]) this.reconnectEntry(entry);
    } else if (event.t === "tree-changed") {
      const removed = new Set(event.removed);
      let marked = false;
      for (const binding of this.tabs.values()) {
        if (!removed.has(binding.path)) continue;
        binding.deleted = true;
        marked = true;
        if (binding.state.kind === "shared") binding.state.session.replica.markDeleted();
      }
      const forgot = this.invalidate({ paths: [...event.added, ...event.removed, ...event.moves.flatMap((move) => [move.from, move.to])] });
      if (marked && !forgot) this.emit();
    } else if (event.t === "files-changed") {
      // The host writes a shared document's working copy every few seconds while anyone
      // types: that path almost always stays the same document, so it is kept and
      // checked quietly. Only a file that was not shared a moment ago (created or turned
      // into a document since) is dropped and looked up again right away.
      this.invalidate({ paths: event.paths, projectId: event.paths.length ? undefined : event.projectId, unsharedOnly: event.paths.length > 0 });
      for (const path of event.paths) this.revalidate(path);
    }
    else if (event.t === "project-changed") this.invalidate({ projectId: event.projectId });
  }

  /**
   * A (re)started host does not know this window's replicas: ask for a fresh
   * port, retrying while the host is still coming up, and let the replica
   * re-attach and hand over whatever the old host never confirmed.
   */
  private reconnectEntry(entry: DocEntry) {
    if (!entry.session) return;
    if (entry.reconnecting) {
      entry.reconnectAgain = true;
      return;
    }
    entry.reconnecting = true;
    void (async () => {
      let delay = this.reconnectDelayMs;
      while (true) {
        entry.reconnectAgain = false;
        const replica = entry.session?.replica;
        if (!replica || replica.isDestroyed || this.entries.get(entry.docId) !== entry) break;
        replica.hostLost();
        try {
          const port = await this.attachImpl(entry.docId);
          if (replica.isDestroyed || this.entries.get(entry.docId) !== entry) {
            port.close();
            break;
          }
          replica.rebind(port);
          this.emit();
          if (!entry.reconnectAgain) break;
        } catch {
          // The host is not accepting ports yet (restarting): try again.
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 10_000);
        }
      }
      entry.reconnecting = false;
    })();
  }

  /** Shared documents holding edits the host has not confirmed as saved (host lost, or acknowledgements pending). */
  unconfirmedDocumentCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.session?.replica.hasUnconfirmedWork()) count += 1;
    return count;
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
    // A deleted tab remains a recovery view, even if another file reuses its path.
    if (existing?.path === path && existing.state.kind === "shared" &&
        (existing.state.session.replica.getSnapshot().closed === "document-deleted" || existing.state.session.replica.getSnapshot().meta?.readOnlyReason === "document-deleted")) return existing.state;
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
      deleted: existing?.path === path && existing.deleted,
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
      if (binding.deleted) return settle({ kind: "error", path, message: "This shared file was deleted." });
      return settle({ kind: "none" });
    }
    if (binding.lease?.docId !== resolved.docId) {
      binding.lease?.release();
      binding.lease = this.acquire(resolved, `tab:${tabId}`);
    }
    try {
      const session = await binding.lease.ready;
      if (binding.deleted) session.replica.markDeleted();
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
    this.tabs.set(tabId, { path, token: (existing?.token ?? 0) + 1, inflight: false, deleted: false, lease: null, state: { kind: "pending", path } });
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

/* ---- Undo scope of programmatic edits ---------------------------------------------- */

/**
 * Where a programmatic edit (AI result, review apply, image insertion) is
 * recorded for Undo. By default that is the session's undo manager, which the
 * CodeMirror editors share. A mounted Visual editor undoes through its
 * bridge's own Y.UndoManager instead, so while one is bound the edit is made
 * with an origin only that manager tracks: Undo in Visual then removes the AI
 * result in one step. Exactly one manager tracks each edit, so it can never
 * be undone twice.
 */
export interface UndoScope {
  readonly origin: object;
  readonly undoManager: Y.UndoManager;
  /** Sends the editor's pending local changes first, so they are not merged into the edit. */
  flush?(): void;
}

const undoScopes = new WeakMap<CollabReplica, UndoScope[]>();

/** Registers an editor-owned undo manager for programmatic edits; returns the unregister function. */
export function registerUndoScope(replica: CollabReplica, undoManager: Y.UndoManager, flush?: () => void): () => void {
  const scope: UndoScope = { origin: new SharedEditOrigin(replica.docId), undoManager, flush };
  undoManager.addTrackedOrigin(scope.origin);
  const scopes = undoScopes.get(replica) ?? [];
  scopes.push(scope);
  undoScopes.set(replica, scopes);
  return () => {
    undoManager.removeTrackedOrigin(scope.origin);
    const list = undoScopes.get(replica);
    const index = list?.indexOf(scope) ?? -1;
    if (list && index >= 0) list.splice(index, 1);
  };
}

/** The scope a programmatic edit on `session` is recorded in right now (the latest Visual editor, else the session). */
export function undoScopeFor(session: SharedDocSession): UndoScope {
  const scopes = undoScopes.get(session.replica);
  return scopes?.length ? scopes[scopes.length - 1] : { origin: session.editOrigin, undoManager: session.undoManager };
}
