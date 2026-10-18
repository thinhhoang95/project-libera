"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { syncReview, paragraphRange, plainParagraphRange, type ReviewDocument, type ReviewRange } from "@/lib/markdown-review";
import type { ChatContext } from "@/lib/document-chat";
import type { OpenTab } from "./types";
import { apiRequest } from "./api-client";
import { registerStateFlusher } from "./deferred-save";
import { LocalReviewStore } from "@/lib/collab/review-store/local";
import { SharedReviewStore } from "@/lib/collab/review-store/shared";
import { sharedReviewDocument, type SharedReviewProjection } from "@/lib/collab/review-store/types";
import { relativeRange, resolveRelativeRange, type ReattachCandidate } from "@/lib/collab/anchors";
import type { RelativePositionJSON } from "@/lib/collab/protocol/schema";
import { useSharedTab } from "@/lib/collab/bindings/react-shared-tabs";
import { getCollabStatusStore } from "@/lib/collab/ui/status-store";
import { useSessionEndRevisions } from "./collab/history/session-end";

type EditorBridge = { isComposing: () => boolean; snapshot: () => string; apply: (text: string) => void; focus: (range: ReviewRange) => void };
export type ReviewSelection = {
  range: ReviewRange; x: number; y: number;
  /** Shared documents: the selection as Yjs positions, so it follows collaborators' edits while the popover is open. */
  anchor?: { start: RelativePositionJSON; end: RelativePositionJSON };
};
/** Review Mode on a shared document: threads come from the collab server (SharedReviewStore). */
export type SharedReviewState = {
  docId: string; projectId: string; projection: SharedReviewProjection;
  reattachCandidates: (threadId: string) => ReattachCandidate[];
};
type ContextValue = {
  doc: ReviewDocument | null; enabled: boolean; busy: string; locked: boolean; error: string; recovery: boolean;
  selection: ReviewSelection | null; selectedThread: string | null; chatReview: boolean;
  /** Set for a shared document; null keeps every local behaviour. */
  shared: SharedReviewState | null;
  /** The source range the editor shows (shared documents align the sidebar to it). */
  viewport: ReviewRange | null; reportViewport: (range: ReviewRange | null) => void;
  register: (bridge: EditorBridge) => () => void;
  select: (range: ReviewRange, x: number, y: number) => void;
  clearSelection: () => void; focus: (range: ReviewRange) => void;
  selectThread: (id: string | null) => void; setChatReview: (value: boolean) => void; showComments: () => void;
  snapshot: () => string; reload: () => Promise<void>; restore: () => void;
  action: (action: string, fields?: Record<string, unknown>) => Promise<boolean>;
  generate: (action: "plan" | "generate" | "revise", prompt: string, ids?: string[], references?: ChatContext[], suggestionId?: string) => Promise<boolean>;
  recoverDraft: (key: string, snapshot: string) => void;
  stop: () => void; reportError: (message: string) => void;
};
const ReviewContext = createContext<ContextValue | null>(null);
export const useMarkdownReview = () => useContext(ReviewContext);
// Comment operations a shared document sends to its SharedReviewStore. The
// agentic-review actions (toggle, sync, decision, undo, redo, new-round) and
// plan/generate keep the local path for now, on the same file's local review.
const SHARED_ACTIONS = new Set(["comment", "reply", "edit", "resolve", "reattach", "delete", "delete-message", "retry", "discard"]);
function sharedAccount() {
  const account = getCollabStatusStore().getSnapshot().status?.account;
  return account ? { id: account.id, displayName: account.displayName || account.email, color: account.color } : null;
}
export function MarkdownReviewProvider({ activeTab, getDraft, applyDraft, recoverDraft, openChat, openComments, children }: {
  activeTab?: OpenTab; getDraft: (id: string) => string; applyDraft: (id: string, before: string, after: string) => boolean; openChat: () => void; openComments: () => void; recoverDraft: (key: string, snapshot: string) => void; children: ReactNode;
}) {
  const [doc, setDoc] = useState<ReviewDocument | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [selection, setSelection] = useState<ReviewSelection | null>(null);
  const [selectedThread, selectThread] = useState<string | null>(null);
  const [chatReview, setChatReviewState] = useState(false);
  const [viewport, setViewport] = useState<ReviewRange | null>(null);
  const bridge = useRef<EditorBridge | null>(null);
  const current = useRef({ activeTab, getDraft, applyDraft, openChat, openComments, recoverDraft });
  useLayoutEffect(() => { current.current = { activeTab, getDraft, applyDraft, openChat, openComments, recoverDraft }; }, [activeTab, getDraft, applyDraft, openChat, openComments, recoverDraft]);
  const latest = useRef<ReviewDocument | null>(null);
  const pending = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const metadataWrite = useRef<Promise<unknown> | null>(null);
  useEffect(() => registerStateFlusher(() => metadataWrite.current ?? undefined), []);
  useSessionEndRevisions();
  const lastTab = useRef<{ id: string; key: string; doc: ReviewDocument | null } | null>(null);
  const key = activeTab?.file.fileType === "markdown" || activeTab?.file.fileType === "latex" ? (activeTab.standaloneSaveId ? `standalone:${activeTab.standaloneSaveId}` : activeTab.untitled ? `draft:${activeTab.id}` : activeTab.file.path) : null;
  const tabId = activeTab?.id;
  const publish = useCallback((next: ReviewDocument | null) => { latest.current = next; setDoc(next); }, []);
  const snapshot = useCallback(() => {
    const tab = current.current.activeTab;
    if (!tab) throw new Error("Open the review document first.");
    return bridge.current?.snapshot() ?? current.current.getDraft(tab.id);
  }, []);
  // The local store is the review route, exactly as before (one per key);
  // every call below passes the snapshot it was made against.
  const localStore = useMemo(() => (key ? new LocalReviewStore({ key, request: apiRequest }) : null), [key]);
  const register = useCallback((adapter: EditorBridge) => {
    bridge.current = adapter;
    return () => { if (bridge.current === adapter) bridge.current = null; };
  }, []);
  useEffect(() => {
    let disposed = false;
    const loadController = new AbortController();
    pending.current?.abort();
    pending.current = null;
    busyRef.current = false;
    latest.current = null;
    queueMicrotask(() => { if (!disposed) { setBusy(""); setError(""); setSelection(null); selectThread(null); setRecovery(false); setViewport(null); publish(null); } });
    const prior = lastTab.current;
    lastTab.current = null;
    if (!key || !localStore) return () => { disposed = true; };
    const text = current.current.getDraft(tabId!);
    async function load() {
      // Saving an untitled/standalone draft preserves its review identity.
      if (prior && prior.id === tabId && prior.key !== key && prior.doc && (prior.key.startsWith("draft:") || prior.key.startsWith("standalone:"))) {
        await localStore!.migrate(prior.doc, text);
      }
      if (disposed) return;
      const loaded = await localStore!.load(loadController.signal, text);
      if (disposed) return;
      if (loaded.schemaVersion !== 1 || !Array.isArray(loaded.threads) || !Array.isArray(loaded.undo)) throw new Error("Could not load valid review metadata. Reload review to retry.");
      publish(loaded);
      lastTab.current = { id: tabId!, key: key!, doc: loaded };
      // Never automatically overwrite disk/user content with a recovered buffer.
      setRecovery(loaded.snapshot !== text && !!loaded.undo.length && loaded.undo.at(-1)?.after === loaded.snapshot);
    }
    void load().catch((cause) => { if (!disposed) setError(cause instanceof Error ? cause.message : "Could not load review."); });
    return () => {
      disposed = true;
      loadController.abort();
      pending.current?.abort();
      pending.current = null;
      busyRef.current = false;
    };
  }, [key, tabId, publish, localStore]);
  useEffect(() => { if (lastTab.current && lastTab.current.id === tabId) lastTab.current.doc = doc; }, [doc, tabId]);

  // ---- Shared documents: threads from the collab server, anchors in the replica.
  const { session: sharedSession } = useSharedTab(tabId, "review");
  const sharedReplica = sharedSession?.replica ?? null;
  const sharedResolved = sharedSession?.resolved ?? null;
  const [projection, setProjection] = useState<SharedReviewProjection | null>(null);
  const sharedStore = useRef<SharedReviewStore | null>(null);
  useEffect(() => {
    if (!sharedReplica || !sharedResolved) {
      sharedStore.current = null;
      queueMicrotask(() => setProjection(null));
      return;
    }
    const store = new SharedReviewStore({
      docId: sharedResolved.docId,
      projectId: sharedResolved.projectId,
      key: sharedResolved.path,
      replica: sharedReplica,
      me: sharedAccount,
      role: () => sharedReplica.getSnapshot().meta?.role ?? sharedResolved.role,
      online: () => getCollabStatusStore().getSnapshot().status?.connection === "connected",
    });
    sharedStore.current = store;
    const off = store.subscribeProjection(setProjection);
    queueMicrotask(() => { if (sharedStore.current === store) setProjection(store.getProjection()); });
    void store.load();
    // The account and connection can become known after the panel mounted
    // (the status store retries after a failed first read): re-project with
    // the account, and load once the host is reachable.
    const statusStore = getCollabStatusStore();
    const offStatus = statusStore.subscribe(() => {
      store.refresh();
      if (statusStore.getSnapshot().status?.connection === "connected") void store.loadIfNeeded();
    });
    return () => { off(); offStatus(); store.destroy(); if (sharedStore.current === store) sharedStore.current = null; };
  }, [sharedReplica, sharedResolved]);
  const sharedProjection = projection && projection.docId === sharedResolved?.docId ? projection : null;

  const sharedAction = useCallback(async (name: string, fields: Record<string, unknown>) => {
    const store = sharedStore.current;
    if (!store) return false;
    setError("");
    const text = typeof fields.text === "string" ? fields.text : "";
    const mentions = Array.isArray(fields.mentions) ? (fields.mentions as unknown[]).filter((id): id is string => typeof id === "string") : undefined;
    const threadId = typeof fields.threadId === "string" ? fields.threadId : "";
    try {
      switch (name) {
        case "comment":
          await store.comment({ range: fields.range as ReviewRange, text, mentions });
          current.current.openComments();
          selectThread(store.lastCreatedThreadId());
          break;
        case "reply": await store.reply({ threadId, text, mentions }); break;
        case "edit": await store.edit({ threadId, messageId: String(fields.messageId ?? ""), text, mentions }); break;
        case "resolve": await store.resolve({ threadId, resolved: fields.resolved === true }); break;
        case "reattach": await store.reattach({ threadId, range: fields.range as ReviewRange }); break;
        case "delete": await store.delete({ threadId }); break;
        case "delete-message": await store.deleteMessage(String(fields.messageId ?? "")); break;
        case "retry": await store.retry(String(fields.commandId ?? "")); break;
        case "discard": store.discard(String(fields.commandId ?? "")); break;
      }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Review failed.");
      return false;
    }
  }, []);

  const action = useCallback(async (name: string, fields: Record<string, unknown> = {}) => {
    if (sharedStore.current && SHARED_ACTIONS.has(name)) return sharedAction(name, fields);
    const stored = latest.current, tab = current.current.activeTab;
    if (!stored || !tab || busyRef.current || !localStore) return false;
    const controller = new AbortController(); pending.current = controller;
    busyRef.current = true; setBusy(name); setError("");
    try {
      const before = snapshot();
      const write = localStore.mutate(name, fields, { doc: stored, snapshot: before, signal: controller.signal });
      metadataWrite.current = write;
      const result = await write;
      if (current.current.activeTab?.id !== tab.id || controller.signal.aborted) return false;
      if (result.snapshot !== before) {
        if (snapshot() !== before || !current.current.applyDraft(tab.id, before, result.snapshot)) {
          publish(result); setRecovery(true); throw new Error("The document changed while applying. Your text was preserved; recover the review result or reload review.");
        }
        bridge.current?.apply(result.snapshot);
      }
      publish(result); setRecovery(false);
      if (name === "comment" || (name === "toggle" && result.enabled)) current.current.openComments();
      if (name === "comment") selectThread(result.threads.at(-1)?.id ?? null);
      if (name === "toggle" && !result.enabled) setChatReviewState(false);
      return true;
    } catch (cause) {
      if (pending.current === controller && current.current.activeTab?.id === tab.id) {
        setError(controller.signal.aborted ? "Review operation stopped. Reload review to check its saved state." : cause instanceof Error ? cause.message : "Review failed.");
      }
      return false;
    }
    finally { metadataWrite.current = null; if (pending.current === controller) { pending.current = null; busyRef.current = false; setBusy(""); } }
  }, [publish, snapshot, localStore, sharedAction]);

  const generate = useCallback(async (stage: "plan" | "generate" | "revise", prompt: string, ids?: string[], references?: ChatContext[], suggestionId?: string) => {
    const stored = latest.current, tab = current.current.activeTab;
    if (!stored || !tab || busyRef.current) return false;
    const controller = new AbortController(); pending.current = controller;
    busyRef.current = true; setBusy(stage); setError("");
    try {
      const result = await apiRequest<ReviewDocument>("/api/document-review", { method: "POST", signal: controller.signal, body: JSON.stringify({ action: stage, id: stored.id, revision: stored.revision, snapshot: snapshot(), prompt, ids, references, suggestionId, planVersion: stored.session?.plan.version }) });
      if (controller.signal.aborted || current.current.activeTab?.id !== tab.id) return false;
      publish(result); return true;
    } catch (cause) { if (pending.current === controller && current.current.activeTab?.id === tab.id) setError(controller.signal.aborted ? "Generation stopped. No proposed changes were applied. Reload review before retrying." : cause instanceof Error ? cause.message : "Agentic review failed."); return false; }
    finally { if (pending.current === controller) { pending.current = null; busyRef.current = false; setBusy(""); } }
  }, [publish, snapshot]);
  const reload = useCallback(async () => {
    const tab = current.current.activeTab;
    if (busyRef.current || !tab || !localStore) return;
    const controller = new AbortController(); pending.current = controller;
    busyRef.current = true; setBusy("reload");
    try {
      const shared = sharedStore.current;
      const next = latest.current ? await localStore.read(latest.current.id, controller.signal) : key ? await localStore.load(controller.signal, snapshot()) : null;
      if (shared) await shared.load();
      if (controller.signal.aborted || current.current.activeTab?.id !== tab.id) return;
      const text = snapshot();
      publish(next); setError(""); setRecovery(!!next && next.snapshot !== text && !!next.undo.length && next.undo.at(-1)?.after === next.snapshot);
    } catch (cause) {
      if (pending.current === controller && current.current.activeTab?.id === tab.id) setError(cause instanceof Error ? cause.message : "Reload failed.");
    } finally {
      if (pending.current === controller) { pending.current = null; busyRef.current = false; setBusy(""); }
    }
  }, [key, publish, snapshot, localStore]);
  const draft = activeTab?.draft;
  // Persist anchor positions against the unsaved buffer, without ever saving
  // Markdown. Wait until generation finishes to avoid invalidating its CAS.
  // A shared document's comments are anchored in the replica, so only an
  // agentic-review session needs this there.
  useEffect(() => {
    if (!doc || draft === undefined || busy || error || recovery || (sharedProjection ? !doc.session : (!doc.threads.length && !doc.session)) || doc.snapshot === draft) return;
    let timer: number;
    const syncWhenReady = () => {
      // A background snapshot must not interrupt an IME session or surface a
      // "finish composing" error as though review storage had failed.
      if (bridge.current?.isComposing()) timer = window.setTimeout(syncWhenReady, 250);
      else void action("sync");
    };
    timer = window.setTimeout(syncWhenReady, 900);
    return () => window.clearTimeout(timer);
  }, [tabId, draft, action, busy, doc, error, recovery, sharedProjection]);
  // Sync/reload only persist/read metadata. Toggling contenteditable for them
  // drops browser focus and can leave an IME composition stranded.
  const locked = !!busy && !["plan", "generate", "revise", "sync", "reload"].includes(busy);
  // Scroll/view-state updates do not change anchors. Preserve the projection's
  // identity so they also do not trigger a full visual comment remapping.
  // Shared threads are already resolved against the live text; the local
  // document only contributes Review Mode's switch and agentic review.
  const shown = useMemo(() => {
    if (sharedProjection) return sharedReviewDocument(sharedProjection, doc?.key === key ? syncReview(doc, sharedProjection.text) : null);
    return doc?.key === key && draft !== undefined ? syncReview(doc, draft) : null;
  }, [doc, key, draft, sharedProjection]);
  const shared = useMemo<SharedReviewState | null>(() => sharedProjection ? {
    docId: sharedProjection.docId, projectId: sharedProjection.projectId, projection: sharedProjection,
    reattachCandidates: (threadId) => sharedStore.current?.reattachCandidates(threadId) ?? [],
  } : null, [sharedProjection]);
  const select = useCallback((range: ReviewRange, x: number, y: number) => {
    try {
      const expanded = (current.current.activeTab?.file.fileType === "latex" ? plainParagraphRange : paragraphRange)(snapshot(), range);
      if (!expanded) return;
      const replica = sharedStore.current ? sharedReplica : null;
      setSelection({ range: expanded, x, y, ...(replica && expanded.end <= replica.ytext.length ? { anchor: relativeRange(replica.ytext, expanded.start, expanded.end) } : {}) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Selection failed."); }
  }, [snapshot, sharedReplica]);
  // A collaborator's edit moves the selected passage; the projection changes
  // with every text change, so resolving here keeps the popover on it.
  const liveSelection = useMemo<ReviewSelection | null>(() => {
    if (!selection?.anchor || !sharedReplica || !sharedProjection) return selection;
    const range = resolveRelativeRange(sharedReplica.ytext, selection.anchor.start, selection.anchor.end);
    if (!range || range.end <= range.start) return null;
    return range.start === selection.range.start && range.end === selection.range.end ? selection : { ...selection, range };
  }, [selection, sharedReplica, sharedProjection]);
  const reportViewport = useCallback((range: ReviewRange | null) => {
    setViewport((previous) => previous?.start === range?.start && previous?.end === range?.end ? previous : range);
  }, []);
  const value = useMemo<ContextValue>(() => ({ doc: shown, enabled: !!shown?.enabled, busy, locked, error, recovery, selection: liveSelection, selectedThread, chatReview, shared, viewport, reportViewport, register, select, snapshot, reload, action, generate,
    selectThread: (id) => { selectThread(id); if (id) current.current.openComments(); },
    showComments: () => current.current.openComments(),
    clearSelection: () => setSelection(null), focus: (range) => bridge.current?.focus(range),
    setChatReview: (value) => { setChatReviewState(value); if (value) current.current.openChat(); },
    restore: () => { try { const saved = latest.current; if (!saved || !current.current.activeTab) return; const before = snapshot(); if (!current.current.applyDraft(current.current.activeTab.id, before, saved.snapshot)) throw new Error("Document changed. Retry recovery."); bridge.current?.apply(saved.snapshot); setRecovery(false); } catch (cause) { setError(cause instanceof Error ? cause.message : "Recovery failed."); } },
    stop: () => pending.current?.abort(), reportError: setError,
    recoverDraft: (key, text) => current.current.recoverDraft(key, text),
  }), [shown, busy, locked, error, recovery, liveSelection, selectedThread, chatReview, shared, viewport, reportViewport, register, select, snapshot, reload, action, generate]);
  return <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>;
}
