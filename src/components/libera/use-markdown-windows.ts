"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import type { LiberaFileNode, LiberaFilePayload } from "@/lib/types";
import type { OpenTab } from "./types";
import { apiRequest } from "./api-client";
import { remapMovedPath, subscribeFollowedMoves } from "./file-move-channel";

// Each window owns its snapshot; the main app only sends content on request.
export function useMarkdownWindows(
  tabs: OpenTab[],
  getDraft: (tab: OpenTab) => string,
  onError: (message: string) => void,
) {
  const t = useTranslations("useMarkdownWindows");
  // Track authorization without keeping closed windows and their DOMs alive (closed ones are dropped as moves arrive).
  const windows = useRef(new Map<Window, { file: LiberaFileNode; tabId?: string }>());

  // A move or rename changes a tab's id and path: each window keeps finding its document by following the move.
  useEffect(() => subscribeFollowedMoves((moves) => {
    for (const [child, source] of windows.current) {
      if (child.closed) { windows.current.delete(child); continue; }
      const path = remapMovedPath(source.file.path, moves);
      if (path !== source.file.path) source.file = { ...source.file, path, name: path.split("/").at(-1)!, notebook: path.split("/")[0] };
      if (source.tabId) source.tabId = remapMovedPath(source.tabId, moves);
    }
  }), []);

  useEffect(() => {
    async function receive(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.data?.type !== "libera-markdown-refresh") return;
      const child = event.source as Window | null;
      const source = child && windows.current.get(child);
      if (!child || !source || child.closed) return;
      try {
        const tab = tabs.find((item) => item.id === source.tabId || item.file.path === source.file.path);
        const payload = tab
          ? { content: getDraft(tab), file: tab.file }
          : await apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(source.file.path)}`);
        // Remember renamed/moved paths for refreshes after the source tab closes.
        source.file = payload.file;
        child.postMessage({ type: "libera-markdown-snapshot", requestId: event.data.requestId,
          content: payload.content ?? "", documentPath: payload.file.path, title: payload.file.name }, event.origin);
      } catch (error) {
        child.postMessage({ type: "libera-markdown-snapshot", requestId: event.data.requestId,
          error: error instanceof Error ? error.message : t("refreshDocumentError") }, event.origin);
      }
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  });

  return (file: LiberaFileNode) => {
    if (file.fileType === "pdf" || file.fileType === "image") {
      // PDFs and images load straight from the server in their own window, so
      // they need no snapshot channel; annotation edits sync via annotation-sync.
      const fileWindow = window.open(`/file-window?path=${encodeURIComponent(file.path)}`, "_blank", "popup,width=1000,height=850");
      if (!fileWindow) onError(t("popupBlockedFileError"));
      return;
    }
    if (file.fileType !== "markdown") return;
    const child = window.open("/markdown-preview", "_blank", "popup,width=900,height=800");
    if (!child) {
      onError(t("popupBlockedMarkdownError"));
      return;
    }
    for (const [other] of windows.current) if (other.closed) windows.current.delete(other);
    windows.current.set(child,{ file, tabId: tabs.find((tab) => tab.file.path === file.path)?.id });
  };
}
