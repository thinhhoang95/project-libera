"use client";

import { Loader2, Play } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { LATEX_COMPILE_FAILED, latexPdfUrl } from "./latex-build-store";
import { LatexPdfPreview, type PdfHighlightRequest, type PdfZoom } from "./latex-pdf-preview";
import { latexPdfChannelName, type LatexPdfInverseSync, type LatexPdfWindowBuild, type LatexPdfWindowMessage } from "./latex-pdf-window";

const ZOOM_STORAGE_KEY = "libera.latexPdfWindowZoom";
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const compileShortcut = IS_MAC ? "⌘↵" : "Ctrl+Enter";

function readStoredZoom(): PdfZoom {
  try {
    const stored = window.localStorage.getItem(ZOOM_STORAGE_KEY);
    const value = Number.parseFloat(stored ?? "");
    return Number.isFinite(value) ? value : "width";
  } catch {
    return "width";
  }
}

// The compiled PDF of a LaTeX main file, moved into its own window. The main
// window keeps compiling and sends each new build over a BroadcastChannel.
export function LatexPdfWindowPage({ rootPath }: { rootPath: string }) {
  const t = useTranslations("latex.latexPdfWindowPage");
  const tBuild = useTranslations("latex.latexBuildStore");
  const format = useFormatter();
  const formatDuration = (milliseconds: number) => milliseconds < 1000
    ? format.number(milliseconds, { style: "unit", unit: "millisecond" })
    : format.number(milliseconds / 1000, { style: "unit", unit: "second", minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fileName = rootPath.split("/").at(-1) ?? "";
  const [build, setBuild] = useState<LatexPdfWindowBuild | null>(null);
  const [highlight, setHighlight] = useState<PdfHighlightRequest | null>(null);
  const [zoom, setZoom] = useState<PdfZoom>("width");
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    document.title = fileName ? t("pageTitle", { name: fileName.replace(/\.tex$/i, ".pdf") }) : t("pdfTitle");
  }, [fileName, t]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setZoom(readStoredZoom()));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!rootPath || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(latexPdfChannelName(rootPath));
    channelRef.current = channel;
    channel.addEventListener("message", (event: MessageEvent<LatexPdfWindowMessage>) => {
      const message = event.data;
      if (message?.type === "build") setBuild(message.build);
      else if (message?.type === "highlight") setHighlight(message.highlight);
    });
    channel.postMessage({ type: "hello" } satisfies LatexPdfWindowMessage);
    const announceClosed = () => channel.postMessage({ type: "closed" } satisfies LatexPdfWindowMessage);
    window.addEventListener("pagehide", announceClosed);
    return () => {
      window.removeEventListener("pagehide", announceClosed);
      channelRef.current = null;
      channel.close();
    };
  }, [rootPath]);

  function post(message: LatexPdfWindowMessage) {
    channelRef.current?.postMessage(message);
  }

  function inverseSync(location: LatexPdfInverseSync) {
    post({ type: "inverse-sync", location });
    // Bring the editor forward so the revealed line is visible.
    try { window.opener?.focus(); } catch { /* The opener may be gone. */ }
  }

  function changeZoom(next: PdfZoom) {
    setZoom(next);
    try { window.localStorage.setItem(ZOOM_STORAGE_KEY, String(next)); } catch { /* Storage may be unavailable. */ }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      post({ type: "compile" });
    }
  }

  const status = !build
    ? t("waitingForMainWindow")
    : build.compiling
      ? t("compiling")
      : build.requestError
        ? build.requestError === LATEX_COMPILE_FAILED ? tBuild("compileFailed") : build.requestError
        : build.status === "failure"
          ? t("compileFailed")
          : build.status && build.durationMs !== null
            ? t(build.status === "error" ? "compiledWithErrorsIn" : "compiledIn", { duration: formatDuration(build.durationMs) })
            : t("notCompiledYet");
  const failed = build?.status === "failure" || Boolean(build?.requestError);

  return (
    <main className="libera-workspace-region flex h-full min-h-0 flex-col bg-background text-foreground" onKeyDown={handleKeyDown}>
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-card px-3">
        <button
          type="button"
          className="libera-latex-icon-button disabled:opacity-50"
          aria-label={t("recompile")}
          title={t("recompileTitle", { name: fileName, shortcut: compileShortcut })}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          disabled={!build || build.compiling}
          onClick={() => post({ type: "compile" })}
        >
          {build?.compiling ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Play aria-hidden className="h-4 w-4" />}
        </button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium" title={rootPath}>{fileName || t("pdfTitle")}</h1>
        <span className={`shrink-0 truncate text-xs ${failed ? "text-destructive" : "text-muted-foreground"}`}>{status}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {rootPath ? (
          <LatexPdfPreview
            url={build?.buildId ? latexPdfUrl(rootPath, build.buildId) : null}
            zoom={zoom}
            highlight={highlight}
            busy={build?.compiling ?? false}
            downloadUrl={build?.buildId ? latexPdfUrl(rootPath, build.buildId, true) : null}
            emptyState={!build
              ? t("emptyWaiting")
              : build.compiling
                ? <span className="inline-flex items-center gap-2"><Loader2 aria-hidden className="h-4 w-4 animate-spin" />{t("emptyCompiling")}</span>
                : build.status === "failure" ? t("emptyFailed") : t("emptyIdle")}
            onZoomChange={changeZoom}
            onScrollChange={() => {}}
            onInverseSync={inverseSync}
          />
        ) : (
          <p role="alert" className="p-6 text-sm text-destructive">{t("noDocument")}</p>
        )}
      </div>
    </main>
  );
}
