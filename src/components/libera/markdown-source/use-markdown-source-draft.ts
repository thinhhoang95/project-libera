"use client";

import { startTransition, useCallback, useLayoutEffect, useRef } from "react";
import { SOURCE_DRAFT_DELAY_MS } from "@/lib/markdown-source";
import { useCanvasViewStateCapture } from "../canvas-view-state";

/** Live drafts, delayed publication and lifecycle flushes are the same for
 * both Source editors. Each editor supplies its own live text storage. */
export function useMarkdownSourceDraft(initialValue: string, options: {
  readText: () => string | null;
  isComposing: () => boolean;
  onChange: (text: string) => void;
  onPublish?: (text: string) => void;
  onRegisterDraft?: (read: () => string) => () => void;
}) {
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; });
  const lastPublishedRef = useRef(initialValue);
  const publishedDraftsRef = useRef<string[]>([]);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readDraft = useCallback(() => {
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = null;
    const text = latest.current.readText() ?? lastPublishedRef.current;
    if (text !== lastPublishedRef.current) {
      latest.current.onPublish?.(text);
      lastPublishedRef.current = text;
      publishedDraftsRef.current.push(text);
      latest.current.onChange(text);
    }
    return text;
  }, []);
  const schedulePublish = useCallback(() => {
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(function publishAfterPause() {
      if (latest.current.isComposing()) draftTimerRef.current = setTimeout(publishAfterPause, SOURCE_DRAFT_DELAY_MS);
      else startTransition(() => { readDraft(); });
    }, SOURCE_DRAFT_DELAY_MS);
  }, [readDraft]);
  const register = options.onRegisterDraft;
  useLayoutEffect(() => {
    const unregister = register?.(readDraft);
    window.addEventListener("pagehide", readDraft);
    return () => { readDraft(); unregister?.(); window.removeEventListener("pagehide", readDraft); };
  }, [register, readDraft]);
  useCanvasViewStateCapture(readDraft);
  return { readDraft, schedulePublish, lastPublishedRef, publishedDraftsRef, draftTimerRef };
}
