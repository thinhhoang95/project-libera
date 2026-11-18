"use client";

import { Download, Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { formatBytesIn } from "@/components/libera/audio/media-format";
import { ModalDialog } from "@/components/libera/modal-dialog";
import {
  cancelLocalModelDownload,
  fetchLocalModelStatus,
  getLocalModelGate,
  settleLocalModelGate,
  startLocalModelDownload,
  subscribeLocalModelGate,
  type LocalModelId,
  type LocalModelStatus,
} from "@/components/libera/local-models/local-model-client";

const CLOSED = { model: null };

const COPY_KEYS = {
  search: { title: "searchTitle", description: "searchDescription", offer: "searchOffer" },
  reading: { title: "readingTitle", description: "readingDescription", offer: "readingOffer" },
  "read-aloud": { title: "readAloudTitle", description: "readAloudDescription", offer: "readAloudOffer" },
} as const satisfies Record<LocalModelId, { title: string; description: string; offer: string }>;

/**
 * Offers a local model's download when a feature needs it and shows its
 * progress. The download goes into Libera's application data, or the folder
 * chosen in Preferences. Mounted once for the whole app.
 */
export function LocalModelDialog() {
  const t = useTranslations("localModels.localModelDialog");
  const locale = useLocale();
  const megabytes = (bytes: number) => formatBytesIn(locale, bytes);
  const gate = useSyncExternalStore(subscribeLocalModelGate, getLocalModelGate, () => CLOSED);
  const model = gate.model;
  const [status, setStatus] = useState<LocalModelStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!model) return;
    try {
      const next = await fetchLocalModelStatus(model);
      setStatus(next);
      setError("");
      if (next.state === "ready") settleLocalModelGate(true);
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : t("checkModelFailed"));
    }
  }, [model, t]);

  // Poll while open: the download runs on the server, and Preferences can
  // change the folder while this dialog waits.
  const current = status?.id === model ? status : null;
  useEffect(() => {
    if (!model) return;
    const first = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), current?.state === "downloading" ? 700 : 2000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [model, refresh, current?.state]);

  async function act(work: (id: LocalModelId) => Promise<LocalModelStatus>) {
    if (!model) return;
    setBusy(true);
    setError("");
    try {
      setStatus(await work(model));
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : t("requestFailed"));
    } finally {
      setBusy(false);
    }
  }

  const close = () => settleLocalModelGate(false);
  const state = current?.state;
  const copy = COPY_KEYS[model ?? "reading"];
  const progress = current && current.totalBytes ? Math.min(1, current.downloadedBytes / current.totalBytes) : 0;
  const buttonClass = "inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
  const primaryClass = "inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40";

  let footer = null;
  if (state === "missing" || state === "error") {
    footer = (
      <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(startLocalModelDownload)}>
        {busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Download aria-hidden className="h-4 w-4" />}
        {state === "error" ? t("tryAgain") : t("download", { size: megabytes(current?.totalBytes ?? 0) })}
      </button>
    );
  } else if (state === "downloading") {
    footer = (
      <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(cancelLocalModelDownload)}>
        {t("cancelDownload")}
      </button>
    );
  }

  return (
    <ModalDialog open={Boolean(model)} title={t(copy.title)} description={t(copy.description)} onClose={close} footer={footer}>
      <div className="space-y-3 text-sm leading-relaxed">
        {!current && !error ? (
          <p className="flex items-center gap-2 text-muted-foreground"><Loader2 aria-hidden className="h-4 w-4 animate-spin" /> {t("checking")}</p>
        ) : null}
        {state === "missing" ? <p>{t(copy.offer)}</p> : null}
        {state === "downloading" ? (
          <div className="space-y-1.5">
            <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
              <div className="h-full bg-primary transition-[width]" style={{ width: `${progress * 100}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("downloadProgress", { downloaded: megabytes(current?.downloadedBytes ?? 0), total: megabytes(current?.totalBytes ?? 0) })}
            </p>
          </div>
        ) : null}
        {state === "error" ? <p role="alert" className="text-destructive">{current?.error}</p> : null}
        {current?.directory ? (
          <p className="truncate text-[11px] text-muted-foreground" title={current.directory}>{t("folder", { directory: current.directory })}</p>
        ) : null}
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      </div>
    </ModalDialog>
  );
}
