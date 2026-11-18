"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { useNotebookCodeBlockRenderer } from "@/components/libera/slide-live-blocks";
import { useMarkdownAccents } from "@/components/libera/use-markdown-accents";
import { editorThemeFontStacks, useEditorThemes } from "@/components/libera/use-editor-themes";
import type { ResolvedEditorThemes } from "../../../electron/editor-themes.cjs";
import { ReferenceRenderProvider, referenceNotebookForPath } from "@/components/libera/references/reference-render-context";
import type { MarkdownPreferences } from "@/lib/markdown-preferences";

type Snapshot = { content: string; documentPath: string; title: string };

export function MarkdownPreviewPage({
  markdownPreferences,
  editorThemes,
}: {
  markdownPreferences: MarkdownPreferences;
  /** The preview takes the visual editor's heading colors. */
  editorThemes: ResolvedEditorThemes;
}) {
  const t = useTranslations("markdownPreviewPage");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  // A message of ours ("closed" / "noResponse") or the text the main window sent back.
  const [error, setError] = useState<{ code: "closed" | "noResponse" } | { text: string } | null>(null);
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useMarkdownAccents(markdownPreferences);
  const themes = useEditorThemes(editorThemes);
  const fontFamily = editorThemeFontStacks(themes).rendered;
  const renderCodeBlock = useNotebookCodeBlockRenderer(snapshot?.documentPath, fontFamily);

  const refresh = useCallback(() => {
    if (!window.opener || window.opener.closed) {
      setError({ code: "closed" });
      return;
    }
    clearTimeout(timer.current);
    setBusy(true);
    setError(null);
    window.opener.postMessage({ type: "libera-markdown-refresh", requestId: ++request.current }, window.location.origin);
    timer.current = setTimeout(() => {
      setBusy(false);
      setError({ code: "noResponse" });
    }, 15000);
  }, []);

  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== window.opener ||
          event.data?.type !== "libera-markdown-snapshot" || event.data.requestId !== request.current) return;
      clearTimeout(timer.current);
      setBusy(false);
      if (event.data.error) {
        setError({ text: String(event.data.error) });
      } else {
        setSnapshot(event.data);
        setError(null);
        document.title = t("documentTitle", { title: event.data.title });
      }
    }
    window.addEventListener("message", receive);
    const frame = window.requestAnimationFrame(refresh);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("message", receive);
      clearTimeout(timer.current);
    };
  }, [refresh, t]);

  return (
    <main className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{snapshot?.title ?? t("fallbackTitle")}</h1>
        <span className="text-xs text-muted-foreground">{t("readOnlySnapshot")}</span>
        <button type="button" onClick={refresh} disabled={busy} aria-label={t("refreshLabel")} title={t("refreshLabel")}
          className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
          <RefreshCw aria-hidden className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
        </button>
      </header>
      {error ? <p role="alert" className="px-5 py-2 text-sm text-destructive">{"text" in error ? error.text : error.code === "closed" ? t("windowClosedError") : t("noResponseError")}</p> : null}
      <div className="min-h-0 flex-1 overflow-auto" aria-busy={busy}>
        <article className="markdown-preview-window mx-auto max-w-4xl p-8">
          {snapshot ? (
            <ReferenceRenderProvider notebook={referenceNotebookForPath(snapshot.documentPath)}>
              <MarkdownRenderer
                mathMarkers={markdownPreferences}
                content={snapshot.content}
                documentPath={snapshot.documentPath}
                fontFamily={fontFamily}
                renderCodeBlock={renderCodeBlock}
              />
            </ReferenceRenderProvider>
          ) : (
            <p className="text-sm text-muted-foreground" role="status">
              {busy ? t("loadingPreview") : t("noPreview")}
            </p>
          )}
        </article>
      </div>
    </main>
  );
}
