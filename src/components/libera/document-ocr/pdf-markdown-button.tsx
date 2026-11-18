"use client";

import { Loader2, ScanText } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import {
  cancelPdfMarkdownJob,
  dismissPdfMarkdownJob,
  getPdfMarkdownJobs,
  getPdfReadingSettings,
  startPdfMarkdownJob,
  subscribePdfMarkdownJobs,
  type PdfMarkdownConversion,
  type PdfMarkdownWarning,
  type PdfReadingSettings,
} from "@/components/libera/document-ocr/pdf-markdown-jobs";
import type { MathMarkerSettings } from "@/lib/math-markers";

const EMPTY_JOBS = new Map();


/** The PDF toolbar's Convert to Markdown button, with its setup and progress dialog. */
export function PdfMarkdownButton({
  pdfPath,
  src,
  pageCount,
  className,
  mathMarkers,
  conversion,
}: {
  pdfPath: string;
  src: string;
  pageCount: number;
  className: string;
  mathMarkers?: MathMarkerSettings;
  conversion: PdfMarkdownConversion;
}) {
  const t = useTranslations("documentOcr.pdfMarkdownButton");
  const duration = (milliseconds: number) => {
    const seconds = Math.max(0, Math.round(milliseconds / 1000));
    if (seconds < 60) return t("durationSeconds", { seconds });
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? t("durationMinutes", { minutes, seconds: seconds % 60 }) : t("durationHours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
  };
  const warningText = (warning: PdfMarkdownWarning) => {
    if (warning.kind === "headingLevels") return t("warningHeadingLevels");
    if (warning.kind === "incomplete") return t("warningIncomplete", { page: warning.page });
    return warning.message ? t("warningUnreadable", { page: warning.page, message: warning.message }) : t("warningUnreadableNoReason", { page: warning.page });
  };
  const jobs = useSyncExternalStore(subscribePdfMarkdownJobs, getPdfMarkdownJobs, () => EMPTY_JOBS);
  const job = jobs.get(pdfPath);
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const from = range?.from ?? "1";
  const to = range?.to ?? String(pageCount || 1);
  const firstPage = Math.max(1, Math.min(pageCount, Number.parseInt(from, 10) || 1));
  const lastPage = Math.max(firstPage, Math.min(pageCount, Number.parseInt(to, 10) || pageCount));
  const running = job?.state === "running";
  const [now, setNow] = useState(() => Date.now());
  const [settings, setSettings] = useState<PdfReadingSettings | null>(null);
  const engine = job?.engine ?? settings?.engine ?? "local";

  // Preferences can change between conversions, so ask each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    getPdfReadingSettings(controller.signal).then(setSettings, () => undefined);
    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    if (!running || !open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, open]);

  const start = () => {
    dismissPdfMarkdownJob(pdfPath);
    startPdfMarkdownJob({ pdfPath, src, firstPage, lastPage, mathMarkers, conversion });
  };

  const close = () => {
    setOpen(false);
    if (job && job.state !== "running") dismissPdfMarkdownJob(pdfPath);
  };

  const total = job ? job.lastPage - job.firstPage + 1 : 0;
  const elapsed = job ? Math.max(0, now - job.startedAt) : 0;
  const remaining = job && job.done ? (elapsed / job.done) * (total - job.done) : 0;
  const primaryClass = "rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40";
  const secondaryClass = "rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-muted";

  let footer;
  if (running) {
    footer = <button type="button" className={secondaryClass} onClick={() => cancelPdfMarkdownJob(pdfPath)}>{t("stop")}</button>;
  } else if (job?.state === "done" && job.file) {
    footer = <button type="button" className={primaryClass} onClick={() => { conversion.openFile(job.file!); close(); }}>{t("openFile", { name: job.file.name })}</button>;
  } else {
    footer = <button type="button" className={primaryClass} disabled={!pageCount} onClick={start}>{job ? t("convertAgain") : t("convert")}</button>;
  }

  return (
    <>
      <button
        type="button"
        aria-label={t("convertTitle")}
        title={running ? (job.engine === "openrouter" ? t("readingPagesRunning", { done: job.done, total }) : t("readingPageRunning", { current: job.current, lastPage: job.lastPage })) : t("convertTitle")}
        className={className}
        onClick={() => setOpen(true)}
      >
        {running ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <ScanText aria-hidden className="h-4 w-4" />}
        {running ? <span className="ml-1 text-xs tabular-nums">{job.done}/{total}</span> : null}
      </button>
      <ModalDialog
        open={open}
        title={t("convertTitle")}
        description={engine === "openrouter"
          ? t("sendsEachPage", { model: settings?.model ?? t("openRouterModelFallback") })
          : t("readsLocally")}
        onClose={close}
        footer={footer}
      >
        <div className="space-y-3 text-sm leading-relaxed">
          {!job || (!running && job.state !== "done" && job.state !== "error") ? (
            <>
              <div className="flex items-center gap-2">
                <label htmlFor="pdf-markdown-from">{t("pagesLabel")}</label>
                <input id="pdf-markdown-from" className="w-20 rounded-md border border-input bg-card px-2 py-1" inputMode="numeric" value={from} onChange={(event) => setRange({ from: event.target.value, to })} />
                <span>{t("to")}</span>
                <input aria-label={t("lastPageLabel")} className="w-20 rounded-md border border-input bg-card px-2 py-1" inputMode="numeric" value={to} onChange={(event) => setRange({ from, to: event.target.value })} />
                <span className="text-muted-foreground">{t("ofCount", { count: pageCount })}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {engine === "openrouter"
                  ? t(settings?.cleanup ? "readsPagesAtOnce" : "readsPagesAtOncePlain", { count: settings?.concurrency ?? t("several") })
                  : t("expectMinutes")}{" "}
                {t("savedAsFinish")} {t("chooseModel")}
              </p>
              {engine === "openrouter" && settings && !settings.available ? (
                <p role="alert" className="text-xs text-destructive">{t("addKeyFirst")}</p>
              ) : null}
              {job?.state === "cancelled" && job.file ? <p className="text-xs">{t("stoppedAfter", { done: job.done, total, file: job.file.name })}</p> : null}
            </>
          ) : null}
          {running ? (
            <div className="space-y-1.5">
              <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={job.done}>
                <div className="h-full bg-primary transition-[width]" style={{ width: `${total ? (job.done / total) * 100 : 0}%` }} />
              </div>
              <p className="text-xs text-muted-foreground">
                {job.tidying ? t("tidying") : job.engine === "openrouter" ? t("readingPagesFrom", { current: job.current }) : t("readingPage", { current: job.current, lastPage: job.lastPage })}{" "}
                {job.done
                  ? t("progressRemaining", { done: job.done, elapsed: duration(elapsed), remaining: duration(remaining) })
                  : t("progressNoRemaining", { done: job.done, elapsed: duration(elapsed) })}
              </p>
            </div>
          ) : null}
          {job?.state === "done" ? <p>{t("convertedPages", { count: job.done, file: job.file?.name ?? "" })}</p> : null}
          {job?.state === "error" ? <p role="alert" className="text-destructive">{job.errorKind ? t(`error.${job.errorKind}`) : job.error}</p> : null}
          {job?.warnings.length ? (
            <p className="text-xs text-muted-foreground">{t("warningsSuffix", { warnings: job.warnings.map(warningText).join(" ") })}</p>
          ) : null}
        </div>
      </ModalDialog>
    </>
  );
}
