"use client";

import { Clock3, Database, Loader2, Pause, Play, RefreshCw, RotateCcw, Settings2, Sparkles, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { useIndexStatusText } from "@/components/libera/global-search/search-view";
import {
  forgetRecentSearches,
  nudgeSearchStatus,
  requestSearch,
  searchIndexAction,
  useSearchStatusPolling,
  useSearchStore,
} from "@/components/libera/global-search/search-store";
import { IndexMismatch, IndexSetup, canManageIndexFile, revealSearchIndex } from "@/components/libera/global-search/index-setup";
import { openLocalModelDialog } from "@/components/libera/local-models/local-model-client";
import { ModalDialog } from "@/components/libera/modal-dialog";

function fileName(filePath?: string) {
  return filePath ? filePath.split(/[\\/]/).at(-1) : "";
}

const iconButton = "libera-sidebar-icon-button inline-flex h-9 w-9 items-center justify-center rounded-lg disabled:pointer-events-none disabled:opacity-40";

function Stat({ label, value, tone }: { label: string; value: number; tone?: "destructive" }) {
  const format = useFormatter();
  return (
    <div className="libera-search-panel-stat flex flex-col-reverse rounded-[10px] px-2.5 py-2">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className={`text-sm font-semibold tabular-nums ${tone === "destructive" ? "text-destructive" : ""}`}>{format.number(value)}</dd>
    </div>
  );
}

/** The left panel beside the Search page: the index, the model, and recent searches. */
export function SearchPanel({ onOpenPreferences }: { onOpenPreferences?: () => void }) {
  const t = useTranslations("globalSearch.searchPanel");
  const statusText = useIndexStatusText();
  useSearchStatusPolling();
  const { status, statusError, statusFailed, recent } = useSearchStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const summary = statusText.summary(status);
  const working = status?.state === "scanning" || status?.state === "embedding";
  const progress = working && status?.total ? Math.min(100, Math.round((status.done / status.total) * 100)) : null;
  const noIndex = status ? !status.exists : false;

  async function act(action: Parameters<typeof searchIndexAction>[0]) {
    setBusy(true);
    setError("");
    try {
      await searchIndexAction(action);
      nudgeSearchStatus();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : t("updateError"));
    } finally {
      setBusy(false);
    }
  }

  const errorText = error || statusError || (statusFailed ? t("readIndexFailed") : "") || status?.error;
  const modelState = !status?.model.configured
    ? { label: t("modelNotSetUp"), tone: "idle" }
    : status.model.error || status.model.state === "error"
      ? { label: t("modelError"), tone: "error" }
      : status.model.state === "ready"
        ? { label: t("modelLoaded"), tone: "ready" }
        : status.model.state === "loading"
          ? { label: t("modelLoading"), tone: "busy" }
          : { label: t("modelLoadsWhenNeeded"), tone: "idle" };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="libera-notebook-heading flex items-center justify-between px-3 pb-2 pt-4">
        <h2 className="min-w-0 truncate text-sm font-semibold">{t("searchHeading")}</h2>
        <div className="flex items-center">
          <button type="button" className={iconButton} disabled={busy || working || noIndex} aria-label={t("updateIndex")} title={t("updateIndexTitle")} onClick={() => void act("scan")}>
            <RefreshCw aria-hidden className={`h-4 w-4 ${working ? "animate-spin" : ""}`} />
          </button>
          {status?.state === "paused" ? (
            <button type="button" className={iconButton} disabled={busy} aria-label={t("resumeIndexing")} title={t("resumeIndexing")} onClick={() => void act("resume")}>
              <Play aria-hidden className="h-4 w-4" />
            </button>
          ) : (
            <button type="button" className={iconButton} disabled={busy || noIndex} aria-label={t("pauseIndexing")} title={t("pauseIndexingTitle")} onClick={() => void act("pause")}>
              <Pause aria-hidden className="h-4 w-4" />
            </button>
          )}
          <button type="button" className={iconButton} disabled={busy || noIndex} aria-label={t("rebuildIndex")} title={t("rebuildIndexTitle")} onClick={() => setConfirmRebuild(true)}>
            <RotateCcw aria-hidden className="h-4 w-4" />
          </button>
          {onOpenPreferences ? (
            <button type="button" className={iconButton} aria-label={t("searchPreferences")} title={t("searchPreferencesTitle")} onClick={onOpenPreferences}>
              <Settings2 aria-hidden className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>
      <p className="px-3 pb-2 text-xs leading-relaxed text-muted-foreground">
        {t("description")}
      </p>

      <div className="min-h-0 flex-1 space-y-5 overflow-auto px-3 pb-4 pt-2">
        {errorText ? <div role="alert" className="rounded-lg bg-destructive-muted p-3 text-xs leading-relaxed text-destructive">{errorText}</div> : null}

        <section className="space-y-2" aria-label={t("searchIndexLabel")}>
          <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("indexHeading")}</h3>
          {status && noIndex && !working ? <IndexSetup status={status} compact /> : <>
          <div className="libera-search-panel-card flex items-center gap-3 p-2.5">
            <span className="libera-notebook-emoji flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[#5b8def] text-white">
              {working ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Database aria-hidden className="h-4 w-4" />}
            </span>
            <span className="min-w-0 flex-1">
              <span role="status" className="block truncate text-sm font-medium">{summary.text}</span>
              <span className="block truncate text-xs text-muted-foreground" title={working ? status?.current : status?.indexPath}>
                {working && status?.current ? fileName(status.current) : statusText.schedule(status)}
              </span>
            </span>
            {progress !== null ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{progress}%</span> : null}
          </div>
          {progress !== null ? (
            <div className="mx-1 h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={t("indexingProgress")} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${progress}%` }} />
            </div>
          ) : null}
          {status ? (
            <dl className="grid grid-cols-2 gap-1.5">
              <Stat label={t("files")} value={status.files} />
              <Stat label={t("passages")} value={status.chunks} />
              <Stat label={t("withVectors")} value={status.embeddedChunks} />
              <Stat label={t("images")} value={status.images} />
              {status.failedFiles ? <Stat label={t("unreadable")} value={status.failedFiles} tone="destructive" /> : null}
            </dl>
          ) : null}
          {status ? <IndexMismatch status={status} /> : null}
          {status ? (
            canManageIndexFile() ? (
              <button
                type="button"
                className="block w-full truncate rounded px-1 text-left text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                title={t("showIndexLocation", { place: navigator.platform.toLowerCase().includes("mac") ? "finder" : "explorer", path: status.indexPath })}
                onClick={() => void revealSearchIndex(status.indexPath).then((shown) => {
                  if (!shown) setError(t("indexFileNotFound"));
                })}
              >
                {status.indexPath}
              </button>
            ) : (
              <p className="truncate px-1 text-[11px] text-muted-foreground" title={status.indexPath}>{status.indexPath}</p>
            )
          ) : null}
          </>}
        </section>

        <section className="space-y-2" aria-label={t("embeddingModelLabel")}>
          <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("modelHeading")}</h3>
          <div className="libera-search-panel-card flex items-center gap-3 p-2.5">
            <span className="libera-notebook-emoji flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[#8b7fd1] text-white">
              <Sparkles aria-hidden className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">EmbeddingGemma 2</span>
              <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                <span aria-hidden className="libera-search-status-dot" data-tone={modelState.tone} />
                {status ? modelState.label : t("checking")}
              </span>
            </span>
          </div>
          {!status ? null : !status.model.configured ? (
            <p className="px-1 text-xs leading-relaxed text-muted-foreground">
              {t.rich("keywordOnlyNotice", {
                link: (chunks) => <button type="button" className="font-medium text-accent hover:underline" onClick={() => openLocalModelDialog("search")}>{chunks}</button>,
              })}
            </p>
          ) : (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-1 text-xs">
              <dt className="text-muted-foreground">{t("textWeights")}</dt>
              <dd className="truncate text-right" title={status.model.textWeights}>{fileName(status.model.textWeights)}</dd>
              <dt className="text-muted-foreground">{t("visionWeights")}</dt>
              <dd className="truncate text-right" title={status.model.visionWeights}>{status.model.vision ? fileName(status.model.visionWeights) : t("off")}</dd>
              <dt className="text-muted-foreground">{t("dimensions")}</dt>
              <dd className="text-right tabular-nums">{status.model.dimensions}</dd>
            </dl>
          )}
          {status?.model.error ? <p role="alert" className="rounded-lg bg-destructive-muted p-3 text-xs leading-relaxed text-destructive">{status.model.error}</p> : null}
        </section>

        <section className="space-y-1" aria-label={t("recentSearchesLabel")}>
          <div className="flex h-7 items-center justify-between px-1">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("recentHeading")}</h3>
            {recent.length ? (
              <button type="button" className="libera-sidebar-icon-button inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground" aria-label={t("clearRecent")} title={t("clearRecent")} onClick={forgetRecentSearches}>
                <X aria-hidden className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          {recent.length ? (
            <ul className="space-y-0.5">
              {recent.map((item) => (
                <li key={`${item.at}-${item.label}`}>
                  <button type="button" className="libera-notebook-row flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px]" title={item.label} onClick={() => requestSearch(item.parts)}>
                    <Clock3 aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{item.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded-lg border border-dashed border-input p-4 text-sm text-muted-foreground">{t("noRecent")}</div>
          )}
        </section>
      </div>

      <ModalDialog
        open={confirmRebuild}
        title={t("rebuildTitle")}
        description={t("rebuildDescription")}
        onClose={() => setConfirmRebuild(false)}
        footer={
          <>
            <button className="rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted" type="button" onClick={() => setConfirmRebuild(false)}>
              {t("cancel")}
            </button>
            <button
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              type="button"
              onClick={() => {
                setConfirmRebuild(false);
                void act("rebuild");
              }}
            >
              {t("rebuild")}
            </button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          {t("rebuildWarning")}
        </p>
      </ModalDialog>
    </div>
  );
}
