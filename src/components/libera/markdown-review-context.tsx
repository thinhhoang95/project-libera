"use client";

import { createContext, createRef, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { syncReview, commentRange, paragraphRange, plainParagraphRange, ReviewDraftTracker, type ReviewDocument, type ReviewRange } from "@/lib/markdown-review";
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
import { useSuggestions } from "./collab/suggestions/use-suggestions";
import { agenticGroupId, reviewThreadsForPlanning, syncAgenticReviewSuggestions, withOverlayStatuses } from "@/lib/collab/client/agentic-review";
import { registerSuggestionReplyHandler } from "@/lib/collab/client/suggestions";
import { pendingReviewOpen, subscribeReviewOpen } from "@/lib/collab/client/reviews";

type EditorBridge = {
  isComposing: () => boolean; snapshot: () => string; apply: (text: string) => void; focus: (range: ReviewRange) => void;
  /** The editor's current selection as source offsets (Request review… on a selection). */
  selection?: () => ReviewRange | null;
};
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
  /** The active editor's selection in source offsets, or null (nothing selected, or no editor). */
  editorSelection: () => ReviewRange | null;
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
// agentic-review session (toggle, sync, undo, redo, new-round, plan and
// generate) stays private in the same file's local review; on a shared
// document its proposals are overlay suggestions and "decision" is a server
// decision on them (sharedDecision).
const SHARED_ACTIONS = new Set(["comment", "reply", "edit", "resolve", "reattach", "delete", "delete-message", "retry", "discard"]);
// The review is stored at most this often while you type (see `syncDue`), or
// sooner once this many separate edits are waiting.
const SYNC_INTERVAL_MS = 60_000;
const SYNC_EDIT_LIMIT = 100;
type ReviewTabState = { doc: ReviewDocument | null; due: boolean; adapter: EditorBridge | null; write: { task: Promise<ReviewDocument>; snapshot: string; action: string } | null; flush: Promise<unknown> | null };
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
  // Writes storing a tab that was just left; a load waits for them.
  const leaving = useRef(new Set<Promise<unknown>>());
  useSessionEndRevisions();
  const lastTab = useRef<{ id: string; key: string; doc: ReviewDocument | null } | null>(null);
  const key = activeTab?.file.fileType === "markdown" || activeTab?.file.fileType === "latex" ? (activeTab.standaloneSaveId ? `standalone:${activeTab.standaloneSaveId}` : activeTab.untitled ? `draft:${activeTab.id}` : activeTab.file.path) : null;
  const tabId = activeTab?.id;
  const tabState = useMemo(() => ({ key, tabId, tracker: new ReviewDraftTracker() }), [key, tabId]);
  const tracker = tabState.tracker;
  // The outgoing tab keeps its ref until its last write completes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tabRef = useMemo(() => createRef<ReviewTabState>(), [tabState]);
  useLayoutEffect(() => { tabRef.current ??= { doc: null, due: false, adapter: null, write: null, flush: null }; }, [tabRef]);
  const activeState = useRef(tabState);
  useLayoutEffect(() => { activeState.current = tabState; }, [tabState]);
  const publish = useCallback((next: ReviewDocument | null) => { tabRef.current!.doc = next; latest.current = next; setDoc(next); }, [tabRef]);
  const snapshot = useCallback(() => {
    const tab = current.current.activeTab;
    if (!tab) throw new Error("Open the review document first.");
    return bridge.current?.snapshot() ?? current.current.getDraft(tab.id);
  }, []);
  // The local store is the review route, exactly as before (one per key);
  // every call below passes the snapshot it was made against.
  const localStore = useMemo(() => (key ? new LocalReviewStore({ key, request: apiRequest }) : null), [key]);
  const register = useCallback((adapter: EditorBridge) => {
    bridge.current = adapter; tabRef.current!.adapter = adapter;
    return () => {
      const stored = tabRef.current!.doc;
      try { if (stored) tracker.advance(stored, adapter.snapshot()); } catch { /* The editor may already be destroyed or composing. */ }
      if (bridge.current === adapter) bridge.current = null;
      if (tabRef.current!.adapter === adapter) tabRef.current!.adapter = null;
    };
  }, [tabRef, tracker]);
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
      await Promise.all(leaving.current);
      if (disposed) return;
      // Saving an untitled/standalone draft preserves its review identity.
      if (prior && prior.id === tabId && prior.key !== key && prior.doc && (prior.key.startsWith("draft:") || prior.key.startsWith("standalone:"))) {
        await apiRequest("/api/markdown-reviews", { method: "POST", body: JSON.stringify({ action: "migrate-path", from: prior.key, to: key, snapshot: text }) });
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
  // Agentic-review proposals on a shared document are overlay suggestions;
  // their decisions and statuses come from this controller (plan M3.4).
  const { controller: sharedSuggestions, snapshot: suggestionsSnapshot } = useSuggestions(sharedProjection ? sharedSession : null);
  const sharedSuggestionsRef = useRef<typeof sharedSuggestions>(null);
  useLayoutEffect(() => { sharedSuggestionsRef.current = sharedSuggestions; }, [sharedSuggestions]);
  // Opening a review (from a notification) shows the Comments rail, where its Reviews tab is.
  useEffect(() => subscribeReviewOpen(() => { if (pendingReviewOpen()) current.current.openComments(); }), []);
  // Replies to suggestions are comment threads in this store, anchored on
  // the suggestion's range (its paragraph for a pure insertion).
  const sharedDocId = sharedProjection?.docId ?? null;
  useEffect(() => {
    if (!sharedDocId) return;
    return registerSuggestionReplyHandler(sharedDocId, {
      open: () => current.current.openComments(),
      send: async (request) => {
        const store = sharedStore.current;
        if (!store || store.docId !== request.docId) throw new Error("Open the document's comments to reply.");
        const text = store.getProjection().text;
        const range = request.end > request.start ? { start: request.start, end: request.end } : paragraphRange(text, { start: request.start, end: request.end }) ?? plainParagraphRange(text, { start: request.start, end: request.end });
        if (!range || range.end <= range.start) throw new Error("The suggestion's passage is no longer in the document.");
        await store.comment({ range, text: request.body, mentions: request.mentions });
        const threadId = store.lastCreatedThreadId();
        if (!threadId) throw new Error("The reply could not be created.");
        return threadId;
      },
    });
  }, [sharedDocId]);

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

  // Accept and reject of a proposal on a shared document are server
  // decisions on its overlay group (anyone allowed to decide sees the same
  // group); the session's local snapshot apply is for local documents.
  const sharedDecision = useCallback(async (fields: Record<string, unknown>) => {
    const controller = sharedSuggestionsRef.current;
    const ids = Array.isArray(fields.ids) ? (fields.ids as unknown[]).filter((id): id is string => typeof id === "string") : [];
    const decision = fields.decision;
    if (!controller || !ids.length) return false;
    if (decision !== "accept" && decision !== "reject") { setError("A decided suggestion in a shared document cannot be reopened. Ask for a revision instead."); return false; }
    setError("");
    const outcomes = await controller.decide(ids.map(agenticGroupId), decision, { checkpoint: ids.length > 1 }).settled;
    const failed = [...outcomes.values()].find((outcome) => outcome.kind === "failed" || outcome.kind === "stale" || outcome.kind === "not-found");
    if (failed) { setError(failed.message); return false; }
    return true;
  }, []);
  const action = useCallback(async (name: string, fields: Record<string, unknown> = {}) => {
    if (sharedStore.current && SHARED_ACTIONS.has(name)) return sharedAction(name, fields);
    if (sharedStore.current && name === "decision") return sharedDecision(fields);
    const stored = latest.current, tab = current.current.activeTab;
    if (!stored || !tab || busyRef.current || !localStore) return false;
    const controller = new AbortController(); pending.current = controller;
    busyRef.current = true; setBusy(name); setError("");
    try {
      const before = snapshot();
      const edits = tracker.checkpoint(stored, before);
      const write = localStore.mutate(name, { ...fields, ...(edits.length ? { edits } : {}) }, { doc: stored, snapshot: before });
      const operation = { task: write, snapshot: before, action: name };
      tabRef.current!.write = operation;
      const result = await write;
      tracker.acknowledge(stored, result); tabRef.current!.doc = result;
      if (activeState.current !== tabState || controller.signal.aborted) return false;
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
    finally { tabRef.current!.write = null; if (pending.current === controller) { pending.current = null; busyRef.current = false; setBusy(""); } }
  }, [publish, snapshot, localStore, sharedAction, sharedDecision, tracker, tabState, tabRef]);

  const generate = useCallback(async (stage: "plan" | "generate" | "revise", prompt: string, ids?: string[], references?: ChatContext[], suggestionId?: string) => {
    const stored = latest.current, tab = current.current.activeTab;
    if (!stored || !tab || busyRef.current) return false;
    const controller = new AbortController(); pending.current = controller;
    busyRef.current = true; setBusy(stage); setError("");
    try {
      const shared = sharedStore.current;
      const text = snapshot();
      const edits = tracker.checkpoint(stored, text);
      const sharedThreads = shared ? reviewThreadsForPlanning(shared.getProjection().threads) : undefined;
      const write = apiRequest<ReviewDocument>("/api/document-review", { method: "POST", signal: controller.signal, body: JSON.stringify({ action: stage, id: stored.id, revision: stored.revision, snapshot: text, ...(edits.length ? { edits } : {}), prompt, ids, references, suggestionId, planVersion: stored.session?.plan.version, ...(sharedThreads ? { sharedThreads } : {}) }) });
      tabRef.current!.write = { task: write, snapshot: text, action: stage };
      const result = await write;
      tracker.acknowledge(stored, result); tabRef.current!.doc = result;
      if (controller.signal.aborted || activeState.current !== tabState) return false;
      publish(result);
      // Replies the confirmed plan posted on the server show up in the
      // Comments panel without waiting for the next live update.
      if (shared && (result.session?.replies?.length ?? 0) > (stored.session?.replies?.length ?? 0)) void shared.load().catch(() => {});
      const suggestions = sharedSuggestionsRef.current;
      if (shared && suggestions) {
        // Proposals become overlay groups collaborators see; superseded ones
        // (a revision, a new plan) are withdrawn.
        const synced = await syncAgenticReviewSuggestions({ doc: result, controller: suggestions, snapshot: result.snapshot });
        if (synced.failed.length) setError(`${synced.failed.length === 1 ? "A proposed change" : `${synced.failed.length} proposed changes`} could not be shared as suggestions: ${synced.failed[0].message}`);
      }
      return true;
    } catch (cause) { if (pending.current === controller && current.current.activeTab?.id === tab.id) setError(controller.signal.aborted ? "Generation stopped. No proposed changes were applied. Reload review before retrying." : cause instanceof Error ? cause.message : "Agentic review failed."); return false; }
    finally { tabRef.current!.write = null; if (pending.current === controller) { pending.current = null; busyRef.current = false; setBusy(""); } }
  }, [publish, snapshot, tracker, tabState, tabRef]);
  const reload = useCallback(async () => {
    const tab = current.current.activeTab;
    if (busyRef.current || !tab || !localStore) return;
    const controller = new AbortController(); pending.current = controller;
    busyRef.current = true; setBusy("reload");
    try {
      const shared = sharedStore.current;
      const next = latest.current ? await localStore.read(latest.current.id, controller.signal) : key ? await localStore.load(controller.signal, snapshot()) : null;
      if (shared) await shared.load();
      if (controller.signal.aborted || activeState.current !== tabState) return;
      const text = snapshot();
      publish(next); setError(""); setRecovery(!!next && next.snapshot !== text && !!next.undo.length && next.undo.at(-1)?.after === next.snapshot);
    } catch (cause) {
      if (pending.current === controller && current.current.activeTab?.id === tab.id) setError(cause instanceof Error ? cause.message : "Reload failed.");
    } finally {
      if (pending.current === controller) { pending.current = null; busyRef.current = false; setBusy(""); }
    }
  }, [key, publish, snapshot, localStore, tabState]);
  const draft = activeTab?.draft;
  // Anchors follow the unsaved buffer in memory as you type (`tracker`). The
  // review is stored, with the edits that led to the buffer, only now and
  // then: SYNC_INTERVAL_MS after the first unstored change, when the file is
  // saved, when the window loses focus or is hidden, when another tab opens,
  // and before the app quits. Markdown is never saved here. Waits until
  // generation finishes to avoid invalidating its CAS. A shared document's
  // comments are anchored in the replica, so only an agentic-review session
  // needs this there.
  const mapped = useMemo(() => doc?.key === key && draft !== undefined ? tracker.advance(doc, draft) : null, [doc, key, draft, tracker]);
  const syncEligible = !!doc && !!mapped && !error && !recovery && (sharedProjection ? !!doc.session : !!(doc.threads.length || doc.session || doc.agentSuggestions?.length));
  const syncDue = syncEligible && doc.snapshot !== draft && !busy;
  useLayoutEffect(() => { if (mapped) tabRef.current!.due = syncEligible; }, [mapped, syncEligible, tabRef]);
  const manyEdits = syncDue && tracker.count >= SYNC_EDIT_LIMIT;
  const syncDueRef = useRef(false);
  useLayoutEffect(() => { syncDueRef.current = syncDue; }, [syncDue]);
  // A background write must not interrupt an IME session or surface a
  // "finish composing" error as though review storage had failed.
  const syncNow = useCallback(() => !syncDueRef.current || bridge.current?.isComposing() ? undefined : action("sync"), [action]);
  useEffect(() => {
    if (!syncDue) return;
    let timer: number;
    const syncWhenReady = () => {
      if (bridge.current?.isComposing()) timer = window.setTimeout(syncWhenReady, 250);
      else void syncNow();
    };
    timer = window.setTimeout(syncWhenReady, manyEdits ? 900 : SYNC_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [syncDue, manyEdits, syncNow]);
  const tabStatus = activeTab?.status;
  useEffect(() => { if (tabStatus === "clean") void syncNow(); }, [tabStatus, syncNow, syncDue]);
  const flushTab = useCallback(() => {
    if (tabRef.current!.flush) return tabRef.current!.flush;
    const stored = tabRef.current!.doc, operation = tabRef.current!.write, due = tabRef.current!.due;
    if (!stored || (!due && !operation)) return;
    let text = tracker.draft;
    try { text = tabRef.current!.adapter?.snapshot() ?? text; } catch { /* Keep the last complete draft during composition or editor teardown. */ }
    tracker.advance(stored, text);
    if (!operation && stored.snapshot === text) return;
    const edits = tracker.edits(stored);
    const prior = lastTab.current;
    const task = (async () => {
      const result = await operation?.task.catch((cause) => {
        if (operation.action === "sync" || (activeState.current !== tabState && ["plan", "generate", "revise"].includes(operation.action))) return null;
        throw cause;
      });
      // A decision's returned text is recovered on the next load, never undone by a leave sync.
      if (!due || (result && result.snapshot !== operation!.snapshot)) return;
      const store = new LocalReviewStore({ key: stored.key, request: apiRequest });
      let base = result ?? await store.read(stored.id);
      if (base.snapshot === text) return;
      for (let attempt = 0; ; attempt++) {
        if (base.snapshot !== (result?.snapshot ?? stored.snapshot)) throw new Error("Review text changed in another window. Reload review before retrying.");
        try {
          base = await store.mutate("sync", { edits: base.snapshot === stored.snapshot ? edits : tracker.edits(base, text) }, { doc: base, snapshot: text });
          break;
        } catch (cause) {
          if (attempt || !(cause instanceof Error) || !/Reload review|Reload before retrying/i.test(cause.message)) throw cause;
          base = await store.read(stored.id);
        }
      }
      tabRef.current!.doc = base;
      if (prior?.doc?.id === stored.id) prior.doc = base;
      if (activeState.current === tabState) { publish(base); setError(""); }
    })();
    tabRef.current!.flush = task;
    void task.finally(() => { if (tabRef.current!.flush === task) tabRef.current!.flush = null; }).catch(() => undefined);
    return task;
  }, [tabState, tracker, publish, tabRef]);
  useEffect(() => {
    const onBlur = () => {
      if (bridge.current?.isComposing()) return;
      if (!tabRef.current!.write) {
        const stored = tabRef.current!.doc;
        if (stored && tabRef.current!.due && stored.snapshot !== snapshot()) void action("sync");
        return;
      }
      void flushTab()?.catch((cause) => { if (activeState.current === tabState) setError(cause instanceof Error ? cause.message : "Review sync failed."); });
    };
    const onVisibility = () => { if (document.visibilityState === "hidden") onBlur(); };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.removeEventListener("blur", onBlur); document.removeEventListener("visibilitychange", onVisibility); };
  }, [action, snapshot, flushTab, tabState, tabRef]);
  useEffect(() => registerStateFlusher(() => Promise.all([flushTab(), ...leaving.current])), [flushTab]);
  useEffect(() => () => {
    const write = flushTab();
    if (!write) return;
    leaving.current.add(write);
    void write.finally(() => leaving.current.delete(write)).catch(() => undefined);
  }, [flushTab]);
  // Sync/reload only persist/read metadata. Toggling contenteditable for them
  // drops browser focus and can leave an IME composition stranded.
  const locked = !!busy && !["plan", "generate", "revise", "sync", "reload"].includes(busy);
  // Scroll/view-state updates do not change anchors. Preserve the projection's
  // identity so they also do not trigger a full visual comment remapping.
  // Shared threads are already resolved against the live text; the local
  // document only contributes Review Mode's switch and agentic review.
  const shown = useMemo(() => {
    if (sharedProjection) {
      const base = doc?.key === key ? syncReview(doc, sharedProjection.text) : null;
      return sharedReviewDocument(sharedProjection, base && suggestionsSnapshot ? withOverlayStatuses(base, suggestionsSnapshot.groups) : base);
    }
    return mapped;
  }, [doc, key, mapped, sharedProjection, suggestionsSnapshot]);
  const shared = useMemo<SharedReviewState | null>(() => sharedProjection ? {
    docId: sharedProjection.docId, projectId: sharedProjection.projectId, projection: sharedProjection,
    reattachCandidates: (threadId) => sharedStore.current?.reattachCandidates(threadId) ?? [],
  } : null, [sharedProjection]);
  const select = useCallback((range: ReviewRange, x: number, y: number) => {
    try {
      // A selection is commented on exactly; a bare caret takes its paragraph.
      const expanded = commentRange(snapshot(), range, current.current.activeTab?.file.fileType === "latex" ? plainParagraphRange : paragraphRange);
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
  const editorSelection = useCallback(() => {
    try { return bridge.current?.selection?.() ?? null; } catch { return null; }
  }, []);
  const value = useMemo<ContextValue>(() => ({ editorSelection, doc: shown, enabled: !!shown?.enabled, busy, locked, error, recovery, selection: liveSelection, selectedThread, chatReview, shared, viewport, reportViewport, register, select, snapshot, reload, action, generate,
    selectThread: (id) => { selectThread(id); if (id) current.current.openComments(); },
    showComments: () => current.current.openComments(),
    clearSelection: () => setSelection(null), focus: (range) => bridge.current?.focus(range),
    setChatReview: (value) => { setChatReviewState(value); if (value) current.current.openChat(); },
    restore: () => { try { const saved = latest.current; if (!saved || !current.current.activeTab) return; const before = snapshot(); if (!current.current.applyDraft(current.current.activeTab.id, before, saved.snapshot)) throw new Error("Document changed. Retry recovery."); bridge.current?.apply(saved.snapshot); setRecovery(false); } catch (cause) { setError(cause instanceof Error ? cause.message : "Recovery failed."); } },
    stop: () => pending.current?.abort(), reportError: setError,
    recoverDraft: (key, text) => current.current.recoverDraft(key, text),
  }), [editorSelection, shown, busy, locked, error, recovery, liveSelection, selectedThread, chatReview, shared, viewport, reportViewport, register, select, snapshot, reload, action, generate]);
  return <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>;
}
