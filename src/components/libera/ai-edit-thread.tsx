"use client";

import { useSyncExternalStore } from "react";
import { DatabaseZap, FileText } from "lucide-react";
import { MAX_AI_EDIT_TURNS } from "@/lib/ai-document-context";
import type { TokenUsage } from "@/lib/chat-token-usage";
import { saveIncludeDocumentContext, useIncludeDocumentContext } from "./ai-document-context-preference";

/**
 * Cached threads for AI Rewrite and Write with AI, one per document (see
 * src/lib/ai-edit.ts). Follow-up requests on a document resend the earlier
 * turns exactly as the server built them, so the provider reads the
 * instructions and the document from its cache and each new turn stays
 * short. A thread ends when the user clears it, the document-context choice
 * changes, it reaches the turn limit, or it sits idle past the cache lifetime.
 */
export type AiEditTurn = { user: string; assistant: string };
export type AiEditThreadResult = { id: string; caching: boolean; turn: AiEditTurn; usage?: TokenUsage };
export type AiEditThreadRequest = { id: string; turns: AiEditTurn[] };
type AiEditThread = AiEditThreadRequest & { includeDocument: boolean; usage?: TokenUsage };

// Provider caches typically last five minutes; resending a longer history
// after that costs more than starting again from the current document.
const IDLE_MS = 5 * 60_000;
const MAX_THREAD_LENGTH = 400_000;
const threads = new Map<string, AiEditThread>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function newThreadId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Forget a document's thread; the next request starts from scratch. */
export function clearAiEditThread(key: string | undefined) {
  if (!key) return;
  clearTimeout(timers.get(key));
  timers.delete(key);
  if (threads.delete(key)) notify();
}

/** The thread to send with a request on `key`: the current one, or a new empty one. */
export function aiEditThreadFor(key: string | undefined, includeDocument: boolean): AiEditThreadRequest | undefined {
  if (!key) return undefined;
  const thread = threads.get(key);
  const length = thread?.turns.reduce((total, turn) => total + turn.user.length + turn.assistant.length, 0) ?? 0;
  if (thread && thread.includeDocument === includeDocument && thread.turns.length < MAX_AI_EDIT_TURNS && length < MAX_THREAD_LENGTH) {
    return { id: thread.id, turns: thread.turns };
  }
  return { id: newThreadId(), turns: [] };
}

/** Keep the turn a successful request added. Results of a thread that was cleared or moved on meanwhile are dropped. */
export function recordAiEditTurn(key: string | undefined, includeDocument: boolean, sent: AiEditThreadRequest | undefined, result: AiEditThreadResult | undefined) {
  if (!key || !sent) return;
  if (!result?.caching || result.id !== sent.id) {
    clearAiEditThread(key);
    return;
  }
  const current = threads.get(key);
  if (sent.turns.length && (current?.id !== sent.id || current.turns.length !== sent.turns.length)) return;
  threads.set(key, { id: sent.id, includeDocument, turns: [...sent.turns, result.turn], ...(result.usage ? { usage: result.usage } : {}) });
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => clearAiEditThread(key), IDLE_MS));
  notify();
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}

export function useAiEditThread(key: string | undefined) {
  return useSyncExternalStore(subscribe, () => key ? threads.get(key) : undefined, () => undefined);
}

function threadTitle(thread: AiEditThread) {
  const requests = `${thread.turns.length} earlier request${thread.turns.length === 1 ? "" : "s"}`;
  const usage = thread.usage?.cachedTokens !== undefined && thread.usage.inputTokens
    ? ` The last request read ${thread.usage.cachedTokens.toLocaleString()} of ${thread.usage.inputTokens.toLocaleString()} input tokens from the cache.`
    : "";
  return `Continuing a cached thread (${requests} on this document): instructions${thread.includeDocument ? " and the document are" : " are"} not sent again, so follow-ups cost less.${usage} Click to start fresh.`;
}

/** The options row under AI Rewrite / Write with AI: the whole-document toggle and, while a thread continues, its cache indicator. */
export function AiEditOptions({ id, documentPath }: { id: string; documentPath?: string }) {
  const includeDocument = useIncludeDocumentContext();
  const thread = useAiEditThread(documentPath);
  const active = thread && thread.includeDocument === includeDocument ? thread : undefined;
  return <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
    <label htmlFor={id} title="Send the whole document as context with AI Rewrite and Write with AI" className="flex cursor-pointer items-center gap-1.5">
      <input id={id} type="checkbox" checked={includeDocument} onChange={(event) => saveIncludeDocumentContext(event.target.checked)} />
      <FileText aria-hidden className="h-3.5 w-3.5" />
      Whole document
    </label>
    {active ? <button
      type="button"
      title={threadTitle(active)}
      aria-label={`Cached AI thread, ${active.turns.length} earlier request${active.turns.length === 1 ? "" : "s"}. Clear it to start fresh`}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-primary hover:bg-muted"
      onClick={() => clearAiEditThread(documentPath)}
    >
      <DatabaseZap aria-hidden className="h-3.5 w-3.5" />
      {active.turns.length}
    </button> : null}
  </div>;
}
