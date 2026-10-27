"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { HostEvent, HostStatus, LocalProject } from "@/lib/collab/local-api";
import { subscribeHostEvents } from "./bridge";
import { getCollabStatusStore, type CollabSnapshot } from "./status-store";

const SERVER_SNAPSHOT: CollabSnapshot = { phase: "loading", status: null };

export interface CollabStatusState extends CollabSnapshot {
  /** False only when the host said collaboration is off; loading counts as enabled-but-unknown. */
  enabled: boolean;
  /** A collaboration account is configured (in any connection state but signed-out). */
  signedIn: boolean;
  refresh(): Promise<void>;
  refreshProjects(): Promise<void>;
  setStatus(status: HostStatus): void;
}

/**
 * The host status: one GET /status, then live `status` host events. Works
 * without `window.liberaCollab` (it then polls), and reports
 * `phase: "disabled"` when the routes answer 503 `collab-disabled` so callers
 * can hide the feature.
 */
export function useCollabStatus(): CollabStatusState {
  const store = getCollabStatusStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, () => SERVER_SNAPSHOT);
  const connection = snapshot.status?.connection;
  return {
    ...snapshot,
    enabled: snapshot.phase !== "disabled",
    signedIn: Boolean(snapshot.status?.account) && connection !== "signed-out",
    refresh: store.refresh,
    refreshProjects: store.refreshProjects,
    setStatus: store.setStatus,
  };
}

export interface CollabProjectsState {
  projects: LocalProject[];
  /** The shared project materialized as this top-level notebook, if any. */
  projectForNotebook(notebook: string): LocalProject | undefined;
  projectById(projectId: string | null | undefined): LocalProject | undefined;
  refresh(): Promise<void>;
}

const NO_PROJECTS: LocalProject[] = [];

/** Shared notebooks of the signed-in account; kept current by `project-changed` events. */
export function useCollabProjects(): CollabProjectsState {
  const { status, refreshProjects } = useCollabStatus();
  const projects = status?.projects ?? NO_PROJECTS;
  // Shared albums are gallery folders, not notebooks, even when a notebook has the same name.
  const byNotebook = useMemo(() => new Map(projects.filter((project) => project.kind !== "album").map((project) => [project.notebook, project])), [projects]);
  const byId = useMemo(() => new Map(projects.map((project) => [project.projectId, project])), [projects]);
  return {
    projects,
    projectForNotebook: useCallback((notebook: string) => byNotebook.get(notebook), [byNotebook]),
    projectById: useCallback((projectId: string | null | undefined) => (projectId ? byId.get(projectId) : undefined), [byId]),
    refresh: refreshProjects,
  };
}

export type HostEventOf<K extends HostEvent["t"]> = Extract<HostEvent, { t: K }>;

/**
 * Calls `listener` for each host event of `kind`. The latest listener is used
 * without resubscribing, so callers can pass inline functions.
 */
export function useHostEvents<K extends HostEvent["t"]>(kind: K, listener: (event: HostEventOf<K>) => void): void {
  const listenerRef = useRef(listener);
  useEffect(() => {
    listenerRef.current = listener;
  });
  useEffect(
    () =>
      subscribeHostEvents((event) => {
        if (event.t === kind) listenerRef.current(event as HostEventOf<K>);
      }),
    [kind],
  );
}
