"use client";
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import type { ReviewRange } from "@/lib/markdown-review";

/**
 * The source range an editor shows, kept outside the review context: it
 * changes while you scroll, and only the Comments rail reads it. The rail
 * registers as a follower of its document's tab; editors measure the viewport
 * only while their tab is followed.
 */
export type ViewportStore = {
  report: (range: ReviewRange | null) => void;
  start: () => number | undefined;
  isFollowed: (tabId: string) => boolean;
  follow: (tabId: string) => () => void;
  subscribe: (listener: () => void) => () => void;
};
export function createViewportStore(): ViewportStore {
  let range: ReviewRange | null = null;
  const followers = new Map<string, number>();
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of [...listeners]) listener(); };
  return {
    report: (next) => {
      if (range?.start === next?.start && range?.end === next?.end) return;
      range = next; emit();
    },
    start: () => range?.start,
    isFollowed: (tabId) => followers.has(tabId),
    follow: (tabId) => {
      followers.set(tabId, (followers.get(tabId) ?? 0) + 1); emit();
      return () => {
        const left = (followers.get(tabId) ?? 1) - 1;
        if (left > 0) followers.set(tabId, left); else followers.delete(tabId);
        emit();
      };
    },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export const ReviewViewportContext = createContext<{ store: ViewportStore; tabId: string | null } | null>(null);
/** The tab an editor pane shows, when the pane knows it (split canvases); otherwise the review's active tab. */
export const ReviewPaneContext = createContext<string | null>(null);

const never = () => () => undefined;

/** The Comments rail: the first source offset on screen, for shared documents. */
export function useReviewViewportStart(): number | undefined {
  const viewport = useContext(ReviewViewportContext);
  return useSyncExternalStore(viewport?.store.subscribe ?? never, viewport?.store.start ?? (() => undefined), () => undefined);
}

/** The Comments rail follows its document's scrolling while `follow` is true. */
export function useFollowReviewViewport(follow: boolean) {
  const viewport = useContext(ReviewViewportContext);
  const store = viewport?.store, tabId = viewport?.tabId;
  useEffect(() => (follow && store && tabId ? store.follow(tabId) : undefined), [follow, store, tabId]);
}

/** An editor: the function that reports its viewport, or null while no rail follows this pane's document. Stable. */
export function useReviewViewportReporter(): ViewportStore["report"] | null {
  const viewport = useContext(ReviewViewportContext);
  const pane = useContext(ReviewPaneContext);
  const store = viewport?.store, tab = pane ?? viewport?.tabId ?? null;
  const followed = useSyncExternalStore(store?.subscribe ?? never, () => !!store && !!tab && store.isFollowed(tab), () => false);
  return followed && store ? store.report : null;
}
