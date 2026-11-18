"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { apiRequest } from "./api-client";
import type { PythonRuntimeStatus } from "@/lib/python/runtime";

// The Agent's line about Python for notes while its runtime is being set up
// (the app starts that on a new computer, see libera-app.tsx), or when the
// setup failed, with Retry. Nothing shows once Python is ready.

export function PythonSetupStatus() {
  const t = useTranslations("pythonSetupStatus");
  const tCommon = useTranslations("common");
  const [status, setStatus] = useState<PythonRuntimeStatus | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer = 0;
    const poll = () => {
      void apiRequest<PythonRuntimeStatus>("/api/python").then((next) => {
        if (disposed) return;
        setStatus(next);
        // The app starts the setup a few seconds after it opens; look again until it runs.
        if (next.job?.running) timer = window.setTimeout(poll, 2_000);
        else if (!next.ready && !next.job) timer = window.setTimeout(poll, 10_000);
      }).catch(() => undefined);
    };
    poll();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, []);

  const job = status?.job;
  if (!status || status.ready || !job || (!job.running && !job.error)) return null;
  if (job.running) {
    const percent = job.phase === "uv" && job.totalBytes ? job.downloadedBytes / job.totalBytes : -1;
    return <p role="status" className="truncate text-xs text-muted-foreground" title={t("runningTitle", { megabytes: Math.round(status.estimatedBytes / 1e6) })}>{percent >= 0 ? t("runningStatusPercent", { phase: t(`phase.${job.phase}`), fraction: percent }) : t("runningStatus", { phase: t(`phase.${job.phase}`) })}</p>;
  }
  const retry = () => {
    void apiRequest<PythonRuntimeStatus>("/api/python", { method: "POST" }).then((next) => {
      setStatus(next);
      const poll = () => void apiRequest<PythonRuntimeStatus>("/api/python").then((current) => {
        setStatus(current);
        if (current.job?.running) window.setTimeout(poll, 2_000);
      }).catch(() => undefined);
      window.setTimeout(poll, 2_000);
    }).catch(() => undefined);
  };
  return (
    <p role="alert" className="flex items-center gap-1 text-xs text-destructive" title={job.error}>
      <span className="min-w-0 flex-1 truncate">{t("notSetUp", { error: job.error })}</span>
      <button type="button" className="shrink-0 underline" onClick={retry}>{tCommon("retry")}</button>
    </p>
  );
}
