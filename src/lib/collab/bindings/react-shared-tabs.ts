"use client";

// React glue between the workspace's tabs and the shared document registry.
//
//   useSharedTabs(tabs, { onText, onAttached })   in the workspace hook: binds
//     the text tabs of shared notebooks, releases closed ones, publishes the
//     local presence user and mirrors each shared text into the tab state.
//   useSharedTab(tabId, holder)                   in a panel: the tab's state,
//     plus a panel-level hold on the replica while the panel shows it.
//   useSharedPresence(session)                    remote users for avatars.

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { remoteUsers, type RemoteUser } from "../awareness";
import { getCollabStatusStore, type CollabSnapshot } from "../ui/status-store";
import { getSharedDocRegistry, type SharedDocSession, type SharedTabState } from "../client/registry";
import type { ReplicaSnapshot } from "../client/replica";
import { isShareableTab } from "../client/workspace";
import type { LiberaFileType } from "@/lib/types";

/** Shared text reaches the tab state (preview, outline, status bar) after this pause, like editor drafts. */
export const SHARED_MIRROR_DELAY_MS = 250;

interface TabLike {
  id: string;
  draft: string;
  saved: string;
  untitled?: boolean;
  gallery?: unknown;
  standaloneSaveId?: string;
  file: { path: string; notebook: string; fileType: LiberaFileType };
}

export interface UseSharedTabsOptions {
  /** The shared text of a tab changed (debounced) or was first attached. */
  onText(tabId: string, text: string): void;
  /** A tab's shared document finished attaching (once per replica generation). */
  onAttached?(tabId: string, session: SharedDocSession): void;
  /** The shared text changed, by this window (`local`) or by someone else. Not debounced. */
  onEdit?(tabId: string, local: boolean, text: string): void;
}

const noopSubscribe = () => () => {};
const NO_STATUS: CollabSnapshot = { phase: "disabled", status: null };
const noStatus = () => NO_STATUS;

function useRegistryVersion() {
  const registry = getSharedDocRegistry();
  return useSyncExternalStore(registry.subscribe, registry.getVersion, () => 0);
}

interface Mirror {
  ytext: Y.Text;
  attachedReported: boolean;
  observer: (event: Y.YTextEvent, transaction: Y.Transaction) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Binds the workspace's tabs to shared documents. Returns the ids of shared (or opening) tabs. */
export function useSharedTabs(tabs: readonly TabLike[], options: UseSharedTabsOptions): ReadonlySet<string> {
  const registry = getSharedDocRegistry();
  const version = useRegistryVersion();
  // Without the desktop bridge nothing can be attached, so the status is not
  // even fetched: every tab behaves exactly as without collaboration.
  const statusStore = registry.available ? getCollabStatusStore() : null;
  const { status } = useSyncExternalStore(statusStore?.subscribe ?? noopSubscribe, statusStore?.getSnapshot ?? noStatus, noStatus);
  const latest = useRef(options);
  useEffect(() => { latest.current = options; });

  const projects = status?.projects;
  const sharedNotebooks = useMemo(() => new Set((projects ?? []).map((project) => project.notebook)), [projects]);
  const candidates = useMemo(
    () => tabs.filter((tab) => isShareableTab(tab, sharedNotebooks)).map((tab) => [tab.id, tab.file.path] as const),
    [tabs, sharedNotebooks],
  );
  const candidateKey = candidates.map(([id, path]) => `${id}\u0000${path}`).join("\u0001");

  const account = status?.account;
  useEffect(() => {
    if (!account) return;
    registry.setLocalUser({ name: account.displayName || account.email, color: account.color, userId: account.id });
  }, [registry, account]);

  // Bind and release. Re-runs when the candidates change or the resolution
  // cache is invalidated (version), and bindTab is idempotent otherwise.
  useEffect(() => {
    // Without the desktop bridge nothing can be attached: collaboration is
    // off in this window and every file behaves as before.
    if (!registry.available) {
      for (const tabId of registry.boundTabIds()) registry.releaseTab(tabId);
      return;
    }
    const wanted = new Map(candidates);
    for (const tabId of registry.boundTabIds()) if (!wanted.has(tabId)) registry.releaseTab(tabId);
    for (const [tabId, path] of wanted) {
      const state = registry.tabState(tabId);
      // Errors are retried when the candidates change, not on every render.
      if (state.kind === "error" && state.path === path) continue;
      void registry.bindTab(tabId, path);
    }
    // candidateKey stands for candidates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, candidateKey, version]);

  // Mirror the shared text into the tab state.
  const mirrors = useRef(new Map<string, Mirror>());
  useEffect(() => {
    const current = mirrors.current;
    const seen = new Set<string>();
    for (const tabId of registry.boundTabIds()) {
      const session = registry.sessionForTab(tabId);
      if (!session || !session.replica.getSnapshot().attached) continue;
      seen.add(tabId);
      const ytext = session.replica.ytext;
      let mirror = current.get(tabId);
      if (mirror && mirror.ytext !== ytext) {
        mirror.ytext.unobserve(mirror.observer);
        if (mirror.timer) clearTimeout(mirror.timer);
        current.delete(tabId);
        mirror = undefined;
      }
      if (!mirror) {
        const created: Mirror = {
          ytext,
          attachedReported: false,
          timer: null,
          observer: (_event, transaction) => {
            latest.current.onEdit?.(tabId, transaction.local, created.ytext.toString());
            if (created.timer) clearTimeout(created.timer);
            created.timer = setTimeout(() => {
              created.timer = null;
              latest.current.onText(tabId, created.ytext.toString());
            }, SHARED_MIRROR_DELAY_MS);
          },
        };
        ytext.observe(created.observer);
        current.set(tabId, created);
        mirror = created;
      }
      if (!mirror.attachedReported) {
        mirror.attachedReported = true;
        latest.current.onAttached?.(tabId, session);
        latest.current.onText(tabId, ytext.toString());
      }
    }
    for (const [tabId, mirror] of current) {
      if (seen.has(tabId)) continue;
      mirror.ytext.unobserve(mirror.observer);
      if (mirror.timer) clearTimeout(mirror.timer);
      current.delete(tabId);
    }
  }, [registry, version]);

  useEffect(() => () => {
    for (const mirror of mirrors.current.values()) {
      mirror.ytext.unobserve(mirror.observer);
      if (mirror.timer) clearTimeout(mirror.timer);
    }
    mirrors.current.clear();
  }, []);

  return useMemo(() => {
    void version;
    return new Set(registry.boundTabIds().filter((tabId) => registry.isSharedTab(tabId)));
  }, [registry, version]);
}

export interface SharedTabView {
  state: SharedTabState;
  session: SharedDocSession | null;
  snapshot: ReplicaSnapshot | null;
}

const NONE: SharedTabState = { kind: "none" };

/**
 * The shared state of a tab for one panel. While the panel shows a shared
 * tab it also holds the replica (`holder` names the panel), so a second panel
 * on the same document keeps it open when the first one closes.
 */
export function useSharedTab(tabId: string | undefined, holder: string): SharedTabView {
  const registry = getSharedDocRegistry();
  const version = useRegistryVersion();
  const state = useMemo(() => {
    void version;
    return tabId ? registry.tabState(tabId) : NONE;
  }, [registry, tabId, version]);
  const session = state.kind === "shared" ? state.session : null;
  const resolved = session?.resolved;
  useEffect(() => {
    if (!resolved) return;
    const lease = registry.acquire(resolved, `panel:${holder}`);
    return () => lease.release();
  }, [registry, resolved, holder]);
  const snapshot = useSyncExternalStore(
    session?.replica.subscribe ?? noopSubscribe,
    session?.replica.getSnapshot ?? nullSnapshot,
    nullSnapshot,
  );
  return { state, session, snapshot };
}

const nullSnapshot = () => null;

/** Collaborators in the document (other windows and other people), kept current by awareness. */
export function useSharedPresence(session: SharedDocSession | null): RemoteUser[] {
  const replica = session?.replica ?? null;
  const cache = useRef<{ key: string; users: RemoteUser[] }>({ key: "", users: [] });
  const subscribe = useMemo(() => (listener: () => void) => {
    if (!replica) return () => {};
    replica.awareness.on("change", listener);
    const unsubscribe = replica.subscribe(listener);
    return () => {
      replica.awareness.off("change", listener);
      unsubscribe();
    };
  }, [replica]);
  const read = useMemo(() => () => {
    if (!replica || replica.isDestroyed) return EMPTY_USERS;
    const users = remoteUsers(replica.awareness, replica.ytext);
    const key = JSON.stringify(users);
    if (key !== cache.current.key) cache.current = { key, users };
    return cache.current.users;
  }, [replica]);
  return useSyncExternalStore(subscribe, read, () => EMPTY_USERS);
}

const EMPTY_USERS: RemoteUser[] = [];
