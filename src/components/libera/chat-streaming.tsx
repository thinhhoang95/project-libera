"use client";

import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { ChatMessage, ChatStore } from "@/lib/document-chat";

/**
 * The reply being written, by message id. Each chunk of a reply lands here, and
 * only LiveMessage renders for it; the chat panel (composer, chips, every other
 * message) renders when the reply starts, ends, is interrupted or takes a new
 * step, because those go through the saved chat as before.
 */
const live = new Map<string, ChatMessage>();
const listeners = new Map<string, Set<() => void>>();

export const streamingMessages = {
  set(message: ChatMessage) {
    live.set(message.id, message);
    for (const listener of [...(listeners.get(message.id) ?? [])]) listener();
  },
  clear(id: string) {
    if (!live.delete(id)) return;
    for (const listener of [...(listeners.get(id) ?? [])]) listener();
  },
  get: (id: string) => live.get(id),
  subscribe(id: string, listener: () => void) {
    const set = listeners.get(id) ?? new Set();
    set.add(listener);
    listeners.set(id, set);
    return () => {
      set.delete(listener);
      if (!set.size) listeners.delete(id);
    };
  },
};

/** `store` with the newest text of each reply the panel still holds as streaming, for a save that must not lose tokens. */
export function withLiveReplies(store: ChatStore): ChatStore {
  let changed = false;
  const chats = store.chats.map((chat) => {
    const messages = chat.messages.map((message) => message.status === "streaming" ? streamingMessages.get(message.id) ?? message : message);
    if (messages.every((message, index) => message === chat.messages[index])) return chat;
    changed = true;
    return { ...chat, messages };
  });
  return changed ? { ...store, chats } : store;
}

/**
 * `message` as the panel saved it, or the newer text of a reply still streaming.
 * `render` draws the body; `onGrow` runs after each change (it keeps the log scrolled to the end).
 */
export function LiveMessage({ message, render, onGrow }: { message: ChatMessage; render: (shown: ChatMessage) => ReactNode; onGrow: () => void }) {
  const subscribe = useCallback((listener: () => void) => streamingMessages.subscribe(message.id, listener), [message.id]);
  const newest = useSyncExternalStore(subscribe, () => streamingMessages.get(message.id), () => undefined);
  // A saved finished or interrupted message is the truth; a copy still marked streaming is older than `newest`.
  const shown = message.status === "streaming" && newest ? newest : message;
  useEffect(() => {
    if (shown.status === "streaming") onGrow();
  }, [shown, onGrow]);
  return <>{render(shown)}</>;
}
