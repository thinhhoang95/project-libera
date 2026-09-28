"use client";

import { useEffect, useRef } from "react";

// Annotations are saved as whole lists, so two windows showing the same PDF or
// image (a tab duplicated into its own window) would overwrite each other's
// edits. After each successful save a window broadcasts the saved list, and
// every other window showing that file adopts it.
const CHANNEL_NAME = "libera-annotations";

export type AnnotationKind = "pdf" | "image";

const windowId = crypto.randomUUID();

type AnnotationMessage = { sender?: string; kind: AnnotationKind; path: string; annotations: unknown[] };

// Channels are opened per use and closed right after: an open channel would
// keep a page (or a Node test process) holding a live handle for no reason.
export function broadcastSavedAnnotations(kind: AnnotationKind, path: string, annotations: unknown[]) {
  if (typeof BroadcastChannel === "undefined") {
    return;
  }

  const channel = new BroadcastChannel(`${CHANNEL_NAME}:${kind}:${path}`);
  channel.postMessage({ sender: windowId, kind, path, annotations } satisfies AnnotationMessage);
  channel.close();
}

export function useAnnotationSync<T>(
  kind: AnnotationKind,
  path: string,
  onRemoteSave: (annotations: T[]) => void,
) {
  const onRemoteSaveRef = useRef(onRemoteSave);

  useEffect(() => {
    onRemoteSaveRef.current = onRemoteSave;
  });

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") {
      return;
    }

    const channel = new BroadcastChannel(`${CHANNEL_NAME}:${kind}:${path}`);

    function receive(event: MessageEvent<AnnotationMessage>) {
      const message = event.data;

      if (message?.sender !== windowId && message?.kind === kind && message.path === path && Array.isArray(message.annotations)) {
        onRemoteSaveRef.current(message.annotations as T[]);
      }
    }

    channel.addEventListener("message", receive);
    return () => channel.close();
  }, [kind, path]);
}
