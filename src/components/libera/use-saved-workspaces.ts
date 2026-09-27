"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { apiRequest, encodeFilePath } from "./api-client";
import type { OpenTab } from "./types";
import type { LiberaFileNode, LiberaFilePayload, LiberaTree, LiberaTreeNode } from "@/lib/types";
import {
  applyWorkspaceView, createWorkspaceView, captureWorkspaceSession, emptyWorkspaceLibrary, emptyWorkspaceSession,
  filterWorkspaceTree, parseWorkspaceLibrary, remapWorkspacePaths, saveWorkspaceSession, trackWorkspaceFileChange,
  type SavedWorkspace, type WorkspaceLibrary, type WorkspaceSession, type WorkspaceFileChange, type WorkspaceView,
} from "@/lib/workspaces";

import { readSidebarSortToken } from "./sidebar-sort-preference";
import { readNotebookFileSort, readNotebookFileView } from "./notebook-home-preferences";

type Options = {
  authenticated: boolean;
  tree: LiberaTree;
  refreshTree: () => Promise<LiberaTree>;
  session: WorkspaceSession;
  readDraft: (tab: OpenTab) => string;
  applySession: (session: WorkspaceSession) => void;
  onError: (message: string) => void;
};

export function useSavedWorkspaces(options: Options) {
  const [library, setLibrary] = useState(emptyWorkspaceLibrary);
  const [ready, setReady] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const current = useRef(options);
  const libraryRef = useRef(library);
  const locked = useRef(false);
  const readyRef = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const lastSaved = useRef("");
  const pendingSnapshot = useRef<WorkspaceLibrary | null>(null);
  const epoch = useRef(0);
  const fileChanges = useRef(new Set<Promise<unknown>>());
  useLayoutEffect(() => { current.current = options; });

  const journalKey = `libera:workspaces:v1:${options.tree.root}`;
  function publish(next: WorkspaceLibrary) {
    libraryRef.current = next;
    setLibrary(next);
  }
  function initialView() {
    return { ...createWorkspaceView(current.current.tree), sidebarSort: readSidebarSortToken(), fileSort: readNotebookFileSort(), fileView: readNotebookFileView() };
  }
  function snapshot() {
    return saveWorkspaceSession(libraryRef.current, captureWorkspaceSession(current.current.session, current.current.readDraft));
  }
  function journal(next: WorkspaceLibrary, closing = false) {
    if (closing && window.liberaWorkspaces) {
      const result = window.liberaWorkspaces.checkpoint(JSON.stringify(next));
      if (!result.saved) throw new Error(result.error ?? "Could not save workspace before closing.");
    }
    try { window.localStorage.setItem(journalKey, JSON.stringify(next)); }
    catch { current.current.onError("Local recovery storage is full. Keep Libera open until your workspace is saved."); }
  }
  function persist(next: WorkspaceLibrary) {
    pendingSnapshot.current = next;
    journal(next);
    const body = JSON.stringify(next);
    const task = queue.current.catch(() => undefined).then(() => apiRequest("/api/workspaces", { method: "PUT", body }));
    queue.current = task;
    return task;
  }
  async function restore(session: WorkspaceSession, tree: LiberaTree) {
    const files = new Map<string, LiberaFileNode>();
    function collect(nodes: LiberaTreeNode[]) {
      for (const node of nodes) {
        if (node.kind === "folder") collect(node.children);
        else files.set(node.path, node);
      }
    }
    tree.notebooks.forEach((notebook) => collect(notebook.children));
    const restored = await Promise.all(session.tabs.map(async (tab): Promise<OpenTab | null> => {
      if (tab.untitled || tab.standaloneSaveId) return { ...tab, status: tab.draft === tab.saved ? "clean" : "dirty" };
      if (!files.has(tab.file.path)) {
        // Recover unsaved text even if its original file was removed outside Libera.
        return tab.draft !== tab.saved ? { ...tab, untitled: true, status: "dirty" } : null;
      }
      const payload = await apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(tab.file.path)}`);
      const draft = tab.draft === tab.saved ? payload.content ?? "" : tab.draft;
      const saved = payload.content ?? "";
      return { ...tab, file: payload.file, draft, saved, status: draft === saved ? "clean" : "dirty", rawUrl: payload.rawUrl ?? `/api/files/raw/${encodeFilePath(tab.file.path)}` };
    }));
    const tabs = restored.filter((tab): tab is OpenTab => tab !== null);
    return { ...session, tabs, activeTabId: session.activeTabId === "" ? "" : tabs.some((tab) => tab.id === session.activeTabId) ? session.activeTabId : tabs[0]?.id ?? "" };
  }

  useEffect(() => {
    if (!options.authenticated || !options.tree.root) return;
    let cancelled = false;
    readyRef.current = false;
    locked.current = true;
    async function load() {
      setReady(false);
      try {
        let next = parseWorkspaceLibrary(await apiRequest("/api/workspaces"));
        let recovery: string | null = null;
        try { recovery = window.localStorage.getItem(journalKey); } catch { /* Disk persistence remains available. */ }
        if (recovery) {
          try {
            const local = parseWorkspaceLibrary(JSON.parse(recovery));
            if (local.updatedAt > next.updatedAt) next = local;
          } catch { /* Keep the valid disk copy when the recovery journal is malformed. */ }
        }
        next = { ...next, workspaces: next.workspaces.map((workspace) => workspace.view ? workspace : { ...workspace, view: initialView() }) };
        const session = next.workspaces.find((workspace) => workspace.id === next.activeWorkspaceId)?.session ?? next.librarySession;
        const restored = session ? await restore(session, current.current.tree) : null;
        if (cancelled) return;
        publish(next);
        if (restored) current.current.applySession(restored);
        readyRef.current = true;
        locked.current = false;
        setReady(true);
        setLoadError("");
      } catch (error) {
        if (cancelled) return;
        locked.current = false;
        setLoadError(error instanceof Error ? error.message : "Could not load workspaces.");
      }
    }
    void load();
    return () => { cancelled = true; readyRef.current = false; };
    // The tree may refresh while editing; restore only on login or data-root changes.
  }, [options.authenticated, options.tree.root, journalKey, attempt]);

  useEffect(() => {
    if (!ready || !options.authenticated) return;
    function checkpoint() {
      if (locked.current || !readyRef.current) return;
      const next = snapshot();
      const token = JSON.stringify({ ...next, updatedAt: 0 });
      if (token === lastSaved.current) return;
      libraryRef.current = next;
      lastSaved.current = token;
      void persist(next).catch((error: Error) => {
        lastSaved.current = "";
        current.current.onError(`Could not save workspace: ${error.message}`);
      });
    }
    // Capture editor readers too: visual editors can hold a draft before React receives it.
    const timer = window.setTimeout(checkpoint, 300);
    const interval = window.setInterval(checkpoint, 2000);
    function onLeave() {
      if (!readyRef.current) return;
      const next = locked.current ? pendingSnapshot.current : snapshot();
      if (!next) return;
      try { journal(next, true); }
      catch (error) { current.current.onError(error instanceof Error ? error.message : "Could not save workspace."); }
      // Web fallback; Electron has already saved synchronously, even if its server is stopping.
      void persist(next).catch(() => undefined);
    }
    window.addEventListener("beforeunload", onLeave);
    window.addEventListener("pagehide", onLeave);
    const onVisibility = () => { if (document.visibilityState === "hidden") onLeave(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
      window.removeEventListener("beforeunload", onLeave);
      window.removeEventListener("pagehide", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, options.authenticated, options.session, journalKey]);

  async function commit(change: (library: WorkspaceLibrary) => WorkspaceLibrary, switchTo?: string | null) {
    if (locked.current || !readyRef.current) throw new Error("Please wait for your workspace to finish loading.");
    locked.current = true;
    setSwitching(true);
    epoch.current += 1;
    try {
      // Finish changes owned by the outgoing workspace before saving/switching it.
      await Promise.allSettled([...fileChanges.current]);
      const previous = snapshot();
      await persist(previous);
      let next = change(previous);
      let restored: WorkspaceSession | undefined;
      if (switchTo !== undefined && switchTo !== previous.activeWorkspaceId) {
        next = { ...next, activeWorkspaceId: switchTo };
        const session = next.workspaces.find((workspace) => workspace.id === switchTo)?.session ?? next.librarySession ?? emptyWorkspaceSession();
        restored = await restore(session, await current.current.refreshTree());
      }
      next = { ...next, updatedAt: Math.max(Date.now(), previous.updatedAt + 1) };
      await persist(next);
      publish(next);
      if (restored) current.current.applySession(restored);
    } catch (error) {
      current.current.onError(error instanceof Error ? error.message : "Could not update workspace.");
      throw error;
    } finally {
      locked.current = false;
      setSwitching(false);
    }
  }

  useEffect(() => {
    function blockShortcuts(event: KeyboardEvent) {
      if (!locked.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    window.addEventListener("keydown", blockShortcuts, true);
    return () => window.removeEventListener("keydown", blockShortcuts, true);
  }, []);

  const activeWorkspace = library.workspaces.find((workspace) => workspace.id === library.activeWorkspaceId);
  const organizedTree = useMemo(() => applyWorkspaceView(options.tree, activeWorkspace?.view), [options.tree, activeWorkspace?.view]);
  const visibleTree = useMemo(() => filterWorkspaceTree(options.tree, activeWorkspace?.scope, activeWorkspace?.view), [options.tree, activeWorkspace?.scope, activeWorkspace?.view]);
  function updateView(change: (view: WorkspaceView) => WorkspaceView) {
    if (locked.current || !readyRef.current) throw new Error("Please wait for your workspace to finish loading.");
    const workspaceId = libraryRef.current.activeWorkspaceId;
    if (!workspaceId) throw new Error("No workspace is active.");
    const previous = snapshot();
    const next = { ...previous, workspaces: previous.workspaces.map((workspace) => workspace.id === workspaceId ? { ...workspace, view: change(workspace.view ?? initialView()) } : workspace) };
    publish(next);
    // Keep failed writes in the recovery journal and let normal checkpoints retry.
    const task = persist(next).then(() => undefined).catch((error: Error) => {
      lastSaved.current = "";
      current.current.onError(`Could not save workspace settings: ${error.message}`);
    });
    fileChanges.current.add(task);
    void task.finally(() => fileChanges.current.delete(task));
    return task;
  }
  return {
    workspaces: library.workspaces, activeWorkspace, ready, switching, loadError, epoch,
    retry: () => setAttempt((value) => value + 1),
    visibleTree, organizedTree, updateView,
    organizeTree: (tree: LiberaTree) => applyWorkspaceView(tree, libraryRef.current.workspaces.find((workspace) => workspace.id === libraryRef.current.activeWorkspaceId)?.view),
    runFileChange: async <T,>(operation: () => Promise<T>, describe: (result: T) => WorkspaceFileChange): Promise<T> => {
      if (locked.current || !readyRef.current) throw new Error("Please wait for your workspace to finish loading.");
      const workspaceId = libraryRef.current.activeWorkspaceId;
      const task = (async () => {
        const result = await operation();
        const next = trackWorkspaceFileChange(snapshot(), workspaceId, describe(result));
        publish(next);
        // A disk-write failure must not turn a successful file operation into a
        // retry that creates a duplicate. Keep the journal and retry checkpoints.
        await persist(next).catch((error: Error) => {
          lastSaved.current = "";
          current.current.onError(`File changed, but workspace could not be saved: ${error.message}`);
        });
        return result;
      })();
      fileChanges.current.add(task);
      try { return await task; }
      finally { fileChanges.current.delete(task); }
    },
    switchWorkspace: (id: string | null) => commit((value) => value, id),
    saveWorkspace: (workspace: Omit<SavedWorkspace, "session">) => {
      const exists = libraryRef.current.workspaces.some((item) => item.id === workspace.id);
      return commit((value) => ({ ...value, workspaces: exists
        ? value.workspaces.map((item) => item.id === workspace.id ? { ...item, ...workspace } : item)
        : [...value.workspaces, { ...workspace, view: initialView(), session: emptyWorkspaceSession() }] }), exists ? undefined : workspace.id);
    },
    deleteWorkspace: (id: string) => commit((value) => ({ ...value, workspaces: value.workspaces.filter((item) => item.id !== id) }), libraryRef.current.activeWorkspaceId === id ? null : undefined),
    remapPaths: (from: string, to: string) => {
      if (!readyRef.current || from === to) return;
      const next = remapWorkspacePaths(snapshot(), from, to);
      publish(next);
      void persist(next).catch((error: Error) => current.current.onError(error.message));
    },
    checkpoint: async () => { if (readyRef.current) await persist(snapshot()); },
  };
}
