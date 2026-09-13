"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import {
  getRenderedMarkdownFontStack,
  type MarkdownPreferences,
} from "@/lib/markdown-preferences";

type Snapshot = { content: string; documentPath: string; title: string };

export function MarkdownPreviewPage({
  markdownPreferences,
}: {
  markdownPreferences: MarkdownPreferences;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(() => {
    if (!window.opener || window.opener.closed) {
      setError("The main window is closed. Reopen the document there to create a new preview.");
      return;
    }
    clearTimeout(timer.current);
    setBusy(true);
    setError("");
    window.opener.postMessage({ type: "libera-markdown-refresh", requestId: ++request.current }, window.location.origin);
    timer.current = setTimeout(() => {
      setBusy(false);
      setError("The main window did not respond. Try refreshing again.");
    }, 15000);
  }, []);

  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== window.opener ||
          event.data?.type !== "libera-markdown-snapshot" || event.data.requestId !== request.current) return;
      clearTimeout(timer.current);
      setBusy(false);
      if (event.data.error) {
        setError(event.data.error);
      } else {
        setSnapshot(event.data);
        setError("");
        document.title = `${event.data.title} — Preview`;
      }
    }
    window.addEventListener("message", receive);
    const frame = window.requestAnimationFrame(refresh);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("message", receive);
      clearTimeout(timer.current);
    };
  }, [refresh]);

  return (
    <main className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{snapshot?.title ?? "Markdown preview"}</h1>
        <span className="text-xs text-muted-foreground">Read-only snapshot</span>
        <button type="button" onClick={refresh} disabled={busy} aria-label="Refresh from main app" title="Refresh from main app"
          className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
          <RefreshCw aria-hidden className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
        </button>
      </header>
      {error ? <p role="alert" className="px-5 py-2 text-sm text-destructive">{error}</p> : null}
      <div className="min-h-0 flex-1 overflow-auto" aria-busy={busy}>
        <article className="mx-auto max-w-4xl p-8">
          {snapshot ? (
            <MarkdownRenderer
              mathMarkers={markdownPreferences}
              content={snapshot.content}
              documentPath={snapshot.documentPath}
              fontFamily={getRenderedMarkdownFontStack(
                markdownPreferences.renderedMarkdownFontFamily,
              )}
            />
          ) : (
            <p className="text-sm text-muted-foreground" role="status">
              {busy ? "Loading preview…" : "No preview loaded."}
            </p>
          )}
        </article>
      </div>
    </main>
  );
}
