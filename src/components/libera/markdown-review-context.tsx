"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { syncReview, paragraphRange, type ReviewDocument, type ReviewRange } from "@/lib/markdown-review";
import type { ChatContext } from "@/lib/document-chat";
import type { OpenTab } from "./types";
import { apiRequest } from "./api-client";

type EditorBridge = { snapshot: () => string; apply: (text: string) => void; focus: (range: ReviewRange) => void };
export type ReviewSelection = { range: ReviewRange; x: number; y: number };
type ContextValue = {
  doc: ReviewDocument | null; enabled: boolean; busy: string; locked: boolean; error: string; recovery: boolean;
  selection: ReviewSelection | null; selectedThread: string | null; chatReview: boolean;
  register: (bridge: EditorBridge) => () => void;
  select: (range: ReviewRange, x: number, y: number) => void;
  clearSelection: () => void; focus: (range: ReviewRange) => void;
  selectThread: (id: string | null) => void; setChatReview: (value: boolean) => void;
  snapshot: () => string; reload: () => Promise<void>; restore: () => void;
  action: (action: string, fields?: Record<string, unknown>) => Promise<boolean>;
  generate: (action: "plan" | "generate" | "revise", prompt: string, ids?: string[], references?: ChatContext[], suggestionId?: string) => Promise<boolean>;
  recoverDraft: (key: string, snapshot: string) => void;
  stop: () => void; reportError: (message: string) => void;
};
const ReviewContext = createContext<ContextValue | null>(null);
export const useMarkdownReview = () => useContext(ReviewContext);
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
  const bridge = useRef<EditorBridge | null>(null);
  const current = useRef({ activeTab, getDraft, applyDraft, openChat, openComments });
  useLayoutEffect(() => { current.current = { activeTab, getDraft, applyDraft, openChat, openComments }; }, [activeTab, getDraft, applyDraft, openChat, openComments]);
  const latest = useRef<ReviewDocument | null>(null);
  const pending = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const lastTab = useRef<{ id: string; key: string; doc: ReviewDocument | null } | null>(null);
  const key = activeTab?.file.fileType === "markdown" ? (activeTab.standaloneSaveId ? `standalone:${activeTab.standaloneSaveId}` : activeTab.untitled ? `draft:${activeTab.id}` : activeTab.file.path) : null;
  const tabId = activeTab?.id;
  const publish = useCallback((next: ReviewDocument | null) => { latest.current = next; setDoc(next); }, []);
  const snapshot = useCallback(() => {
    const tab = current.current.activeTab;
    if (!tab) throw new Error("Open the review document first.");
    return bridge.current?.snapshot() ?? current.current.getDraft(tab.id);
  }, []);
  const register = useCallback((adapter: EditorBridge) => {
    bridge.current = adapter;
    return () => { if (bridge.current === adapter) bridge.current = null; };
  }, []);
  useEffect(() => {
    let disposed = false;
    pending.current?.abort();
    busyRef.current = false;
    latest.current = null;
    queueMicrotask(() => { if (!disposed) { setBusy(""); setError(""); setSelection(null); selectThread(null); setRecovery(false); publish(null); } });
    const prior = lastTab.current;
    if (!key) return;
    const text = current.current.getDraft(tabId!);
    async function load() {
      // Saving an untitled/standalone draft preserves its review identity.
      if (prior && prior.id === tabId && prior.key !== key && prior.doc && (prior.key.startsWith("draft:") || prior.key.startsWith("standalone:"))) {
        await apiRequest<ReviewDocument>("/api/markdown-reviews", { method: "POST", body: JSON.stringify({ action: "migrate", id: prior.doc.id, revision: prior.doc.revision, snapshot: text, key }) });
      }
      const loaded = await apiRequest<ReviewDocument>("/api/markdown-reviews", { method: "POST", body: JSON.stringify({ action: "load", key, snapshot: text }) });
      if (disposed) return;
      if (loaded.schemaVersion !== 1 || !Array.isArray(loaded.threads) || !Array.isArray(loaded.undo)) throw new Error("Could not load valid review metadata. Reload review to retry.");
      publish(loaded);
      lastTab.current = { id: tabId!, key: key!, doc: loaded };
      // Never automatically overwrite disk/user content with a recovered buffer.
      setRecovery(loaded.snapshot !== text && !!loaded.undo.length && loaded.undo.at(-1)?.after === loaded.snapshot);
    }
    void load().catch((cause) => { if (!disposed) setError(cause instanceof Error ? cause.message : "Could not load review."); });
    return () => { disposed = true; };
  }, [key, tabId, publish]);
  useEffect(() => { if (lastTab.current && lastTab.current.id === tabId) lastTab.current.doc = doc; }, [doc, tabId]);

  const action = useCallback(async (name: string, fields: Record<string, unknown> = {}) => {
    const stored = latest.current, tab = current.current.activeTab;
    if (!stored || !tab || busyRef.current) return false;
    const controller = new AbortController(); pending.current = controller;
    busyRef.current = true; setBusy(name); setError("");
    try {
      const before = snapshot();
      const result = await apiRequest<ReviewDocument>("/api/markdown-reviews", { method: "POST", signal: controller.signal, body: JSON.stringify({ ...fields, action: name, id: stored.id, revision: stored.revision, snapshot: before }) });
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
    } catch (cause) { setError(controller.signal.aborted ? "Review operation stopped. Reload review to check its saved state." : cause instanceof Error ? cause.message : "Review failed."); return false; }
    finally { if (pending.current === controller) { pending.current = null; busyRef.current = false; setBusy(""); } }
  }, [publish, snapshot]);

  const generate = useCallback(async (stage: "plan" | "generate" | "revise", prompt: string, ids?: string[], references?: ChatContext[], suggestionId?: string) => {
    const stored = latest.current, tab = current.current.activeTab;
    if (!stored || !tab || busyRef.current) return false;
    const controller = new AbortController(); pending.current = controller;
    busyRef.current = true; setBusy(stage); setError("");
    try {
      const result = await apiRequest<ReviewDocument>("/api/document-review", { method: "POST", signal: controller.signal, body: JSON.stringify({ action: stage, id: stored.id, revision: stored.revision, snapshot: snapshot(), prompt, ids, references, suggestionId, planVersion: stored.session?.plan.version }) });
      if (controller.signal.aborted || current.current.activeTab?.id !== tab.id) return false;
      publish(result); return true;
    } catch (cause) { if (current.current.activeTab?.id === tab.id) setError(controller.signal.aborted ? "Generation stopped. No proposed changes were applied. Reload review before retrying." : cause instanceof Error ? cause.message : "Agentic review failed."); return false; }
    finally { if (pending.current === controller) { pending.current = null; busyRef.current = false; setBusy(""); } }
  }, [publish, snapshot]);
  const reload = useCallback(async () => {
    if (busyRef.current) return;
    try {
      const next = latest.current ? await apiRequest<ReviewDocument>(`/api/markdown-reviews?id=${encodeURIComponent(latest.current.id)}`) : key ? await apiRequest<ReviewDocument>("/api/markdown-reviews", { method: "POST", body: JSON.stringify({ action: "load", key, snapshot: snapshot() }) }) : null;
      publish(next); setError(""); setRecovery(!!next && next.snapshot !== snapshot() && !!next.undo.length && next.undo.at(-1)?.after === next.snapshot);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Reload failed."); }
  }, [key, publish, snapshot]);
  // Persist anchor positions against the unsaved buffer, without ever saving
  // Markdown. Wait until generation finishes to avoid invalidating its CAS.
  useEffect(() => {
    if (!doc || !activeTab || busy || recovery || (!doc.threads.length && !doc.session) || doc.snapshot === activeTab.draft) return;
    const timer = window.setTimeout(() => { void action("sync"); }, 900);
    return () => window.clearTimeout(timer);
  }, [activeTab, action, busy, doc, recovery]);
  const locked = !!busy && !["plan", "generate", "revise"].includes(busy);
  const shown = doc?.key === key && activeTab ? syncReview(doc, activeTab.draft) : null;
  function select(range: ReviewRange, x: number, y: number) {
    try {
      const expanded = paragraphRange(snapshot(), range);
      if (expanded) setSelection({ range: expanded, x, y });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Selection failed."); }
  }
  return <ReviewContext.Provider value={{ doc: shown, enabled: !!shown?.enabled, busy, locked, error, recovery, selection, selectedThread, chatReview, register, select, snapshot, reload, action, generate,
    selectThread: (id) => { selectThread(id); if (id) current.current.openComments(); },
    clearSelection: () => setSelection(null), focus: (range) => bridge.current?.focus(range),
    setChatReview: (value) => { setChatReviewState(value); if (value) current.current.openChat(); },
    restore: () => { try { const saved = latest.current; if (!saved || !current.current.activeTab) return; const before = snapshot(); if (!current.current.applyDraft(current.current.activeTab.id, before, saved.snapshot)) throw new Error("Document changed. Retry recovery."); bridge.current?.apply(saved.snapshot); setRecovery(false); } catch (cause) { setError(cause instanceof Error ? cause.message : "Recovery failed."); } },
    stop: () => pending.current?.abort(), reportError: setError, recoverDraft,
  }}>{children}</ReviewContext.Provider>;
}
