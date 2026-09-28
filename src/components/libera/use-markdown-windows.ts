"use client";

import { useEffect, useRef } from "react";
import type { LiberaFileNode, LiberaFilePayload } from "@/lib/types";
import type { OpenTab } from "./types";
import { apiRequest } from "./api-client";

// Each window owns its snapshot; the main app only sends content on request.
export function useMarkdownWindows(
  tabs: OpenTab[],
  getDraft: (tab: OpenTab) => string,
  onError: (message: string) => void,
) {
  // Track authorization without keeping closed windows and their DOMs alive.
  const windows = useRef(new WeakMap<Window, { file: LiberaFileNode; tabId?: string }>());

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
          error: error instanceof Error ? error.message : "Could not refresh this document." }, event.origin);
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
      if (!fileWindow) onError("Could not open the file window. Please allow pop-up windows and try again.");
      return;
    }
    if (file.fileType !== "markdown") return;
    const child = window.open("/markdown-preview", "_blank", "popup,width=900,height=800");
    if (!child) {
      onError("Could not open the Markdown window. Please allow pop-up windows and try again.");
      return;
    }
    windows.current.set(child, { file, tabId: tabs.find((tab) => tab.file.path === file.path)?.id });
  };
}
