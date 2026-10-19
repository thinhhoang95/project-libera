"use client";

import { useEffect, useSyncExternalStore } from "react";
import { apiRequest } from "@/components/libera/api-client";
import type { PdfCommentAnchor, PdfCommentsPayload, PdfCommentThread } from "@/lib/types";

// The review comments of open PDFs, shared by the viewer (marks on the page,
// Add comment) and the Comments panel (cards, replies). One entry per path;
// every change goes through /api/pdf-comments, which returns the PDF's
// threads, and is broadcast so other windows showing the PDF adopt it.

export type PdfCommentsState = {
  threads: PdfCommentThread[];
  loaded: boolean;
  /** The action being sent ("comment", "reply"…), or "". */
  busy: string;
  error: string;
  /** The thread whose card is open and whose passage is marked as selected. */
  selectedId: string | null;
};

export type PdfCommentChange =
  | { action: "comment"; anchor: PdfCommentAnchor; text: string }
  | { action: "reply"; threadId: string; text: string }
  | { action: "edit"; threadId: string; messageId: string; text: string }
  | { action: "resolve"; threadId: string; resolved: boolean }
  | { action: "delete"; threadId: string };

const EMPTY: PdfCommentsState = { threads: [], loaded: false, busy: "", error: "", selectedId: null };
const ROUTE = "/api/pdf-comments";
const CHANNEL = "libera-pdf-comments";
const FOCUS_EVENT = "libera:pdf-comment-focus";
const windowId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random());

const states = new Map<string, PdfCommentsState>();
const listeners = new Map<string, Set<() => void>>();
const loads = new Map<string, Promise<void>>();

function set(path: string, patch: Partial<PdfCommentsState>) {
  states.set(path, { ...(states.get(path) ?? EMPTY), ...patch });
  for (const listener of [...(listeners.get(path) ?? [])]) listener();
}

function adopt(path: string, received: unknown) {
  const threads = Array.isArray(received) ? received as PdfCommentThread[] : [];
  const selectedId = states.get(path)?.selectedId ?? null;
  set(path, { threads, loaded: true, error: "", selectedId: selectedId && threads.some((thread) => thread.id === selectedId) ? selectedId : null });
}

export function pdfCommentsState(path: string): PdfCommentsState {
  return states.get(path) ?? EMPTY;
}

function subscribe(path: string, listener: () => void) {
  let group = listeners.get(path);
  if (!group) listeners.set(path, group = new Set());
  group.add(listener);
  return () => {
    group.delete(listener);
    if (!group.size) listeners.delete(path);
  };
}

/** Reads the PDF's threads from storage (again). Concurrent calls share one request. */
export function loadPdfComments(path: string): Promise<void> {
  const pending = loads.get(path);
  if (pending) return pending;
  const work = apiRequest<PdfCommentsPayload>(`${ROUTE}?path=${encodeURIComponent(path)}`)
    .then((payload) => adopt(path, payload.threads))
    .catch((error) => set(path, { loaded: true, error: error instanceof Error ? error.message : "Could not load comments." }))
    .finally(() => loads.delete(path));
  loads.set(path, work);
  return work;
}

/** Reloads a PDF's comments if something shows them (after the agent replied, say). */
export function refreshPdfComments(path: string) {
  if (states.has(path) || listeners.has(path)) void loadPdfComments(path);
}

/** Sends one change; resolves false (with the error shown) when it was refused. */
export async function changePdfComments(path: string, change: PdfCommentChange): Promise<PdfCommentThread[] | null> {
  set(path, { busy: change.action, error: "" });
  try {
    const payload = await apiRequest<PdfCommentsPayload>(ROUTE, { method: "POST", body: JSON.stringify({ ...change, path }) });
    adopt(path, payload.threads);
    const threads = pdfCommentsState(path).threads;
    broadcast(path, threads);
    return threads;
  } catch (error) {
    set(path, { error: error instanceof Error ? error.message : "Could not save the comment." });
    return null;
  } finally {
    set(path, { busy: "" });
  }
}

export function selectPdfComment(path: string, threadId: string | null) {
  if (pdfCommentsState(path).selectedId !== threadId) set(path, { selectedId: threadId });
}

export function clearPdfCommentsError(path: string) {
  if (pdfCommentsState(path).error) set(path, { error: "" });
}

/** The panel asks the viewer showing `path` to scroll a thread's passage into view. */
export function focusPdfComment(path: string, threadId: string) {
  selectPdfComment(path, threadId);
  window.dispatchEvent(new CustomEvent(FOCUS_EVENT, { detail: { path, threadId } }));
}

export function onPdfCommentFocus(path: string, handler: (threadId: string) => void) {
  function receive(event: Event) {
    const detail = (event as CustomEvent<{ path: string; threadId: string }>).detail;
    if (detail?.path === path) handler(detail.threadId);
  }
  window.addEventListener(FOCUS_EVENT, receive);
  return () => window.removeEventListener(FOCUS_EVENT, receive);
}

function broadcast(path: string, threads: PdfCommentThread[]) {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(`${CHANNEL}:${path}`);
  channel.postMessage({ sender: windowId, path, threads });
  channel.close();
}

/** The PDF's comments, loaded on first use and kept in step with other windows. */
export function usePdfComments(path: string | null | undefined): PdfCommentsState {
  const key = path ?? "";
  const state = useSyncExternalStore(
    (listener) => key ? subscribe(key, listener) : () => undefined,
    () => key ? pdfCommentsState(key) : EMPTY,
    () => EMPTY,
  );
  useEffect(() => {
    if (!key) return;
    if (!pdfCommentsState(key).loaded) void loadPdfComments(key);
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(`${CHANNEL}:${key}`);
    channel.addEventListener("message", (event: MessageEvent<{ sender?: string; path?: string; threads?: unknown }>) => {
      if (event.data?.sender !== windowId && event.data?.path === key && Array.isArray(event.data.threads)) adopt(key, event.data.threads);
    });
    return () => channel.close();
  }, [key]);
  return state;
}
