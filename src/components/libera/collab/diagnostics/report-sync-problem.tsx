"use client";

// "Report sync problem" (implementation plan §7, private beta): shows the
// host's diagnostics bundle inline in the Collaboration dialog, says what is
// and is not in it, and lets the user copy it or save it as a file to send
// to whoever runs their server. Inline rather than a second modal, so focus
// stays in the one dialog.

import { Bug, Check, Copy, Download, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useDescribeError } from "@/lib/collab/ui/use-describe-error";
import {
  DIAGNOSTICS_EXCLUDED,
  DIAGNOSTICS_INCLUDED,
  diagnosticsFileName,
  diagnosticsSummary,
  diagnosticsText,
  fetchDiagnostics,
  saveDiagnosticsFile,
  type HostDiagnostics,
} from "@/lib/collab/ui/diagnostics";
import { copyText } from "../collab-banners";

const BUTTON =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";

type Phase = { kind: "closed" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; bundle: HostDiagnostics; text: string };

export interface ReportSyncProblemProps {
  /** Replaces the host request (tests). */
  load?: () => Promise<HostDiagnostics>;
}

export function ReportSyncProblem({ load = () => fetchDiagnostics() }: ReportSyncProblemProps) {
  const id = useId();
  const t = useTranslations("collab.diagnostics.reportSyncProblem");
  const tCommon = useTranslations("common");
  const tDiagnostics = useTranslations("lib.collab.ui.diagnostics");
  const describeError = useDescribeError();
  const [phase, setPhase] = useState<Phase>({ kind: "closed" });
  const [notice, setNotice] = useState("");

  async function open() {
    setPhase({ kind: "loading" });
    setNotice("");
    try {
      const bundle = await load();
      setPhase({ kind: "ready", bundle, text: diagnosticsText(bundle) });
    } catch (error) {
      setPhase({ kind: "error", message: describeError(error) });
    }
  }

  if (phase.kind === "closed") {
    return (
      <section aria-label={t("title")} className="libera-dialog-section space-y-2">
        <button className={BUTTON} type="button" onClick={() => void open()}>
          <Bug aria-hidden className="h-3.5 w-3.5" /> {t("open")}
        </button>
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby={`${id}-title`} className="libera-dialog-section space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium" id={`${id}-title`}>
          {t("title")}
        </h3>
        <button aria-label={t("closeReport")} className={BUTTON} type="button" onClick={() => setPhase({ kind: "closed" })}>
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="grid gap-3 text-xs text-muted-foreground sm:grid-cols-2">
        <div>
          <p className="font-medium text-foreground">{t("included")}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {DIAGNOSTICS_INCLUDED.map((line) => (
              <li key={line}>{tDiagnostics(`included.${line}`)}</li>
            ))}
          </ul>
        </div>
        <div>
          <p className="font-medium text-foreground">{t("neverIncluded")}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {DIAGNOSTICS_EXCLUDED.map((line) => (
              <li key={line}>{tDiagnostics(`excluded.${line}`)}</li>
            ))}
          </ul>
        </div>
      </div>
      {phase.kind === "loading" ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <LoaderCircle aria-hidden className="h-4 w-4 animate-spin" /> {t("collecting")}
        </p>
      ) : phase.kind === "error" ? (
        <div className="space-y-2 text-sm" role="alert">
          <p className="text-destructive">{phase.message}</p>
          <button className={BUTTON} type="button" onClick={() => void open()}>
            <RefreshCw aria-hidden className="h-3.5 w-3.5" /> {tCommon("tryAgain")}
          </button>
        </div>
      ) : (
        <>
          <dl aria-label={t("summary")} className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {diagnosticsSummary(phase.bundle, tDiagnostics).map((line) => (
              <div key={line.label} className="contents" data-warn={line.warn ? "true" : undefined}>
                <dt className="text-muted-foreground">{line.label}</dt>
                <dd className={line.warn ? "font-medium text-destructive" : "text-foreground"}>{line.value}</dd>
              </div>
            ))}
          </dl>
          <pre
            aria-label={t("report")}
            className="max-h-56 overflow-auto rounded-lg border border-border bg-muted p-2 font-mono text-[11px] leading-4"
            tabIndex={0}
          >
            {phase.text}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className={BUTTON}
              type="button"
              onClick={() => {
                void copyText(phase.text).then((copied) => setNotice(copied ? t("copied") : t("copyFailed")));
              }}
            >
              <Copy aria-hidden className="h-3.5 w-3.5" /> {tCommon("copy")}
            </button>
            <button
              className={BUTTON}
              type="button"
              onClick={() => {
                try {
                  saveDiagnosticsFile(phase.text, diagnosticsFileName(phase.bundle.generatedAt));
                  setNotice(t("chooseWhereToSave"));
                } catch (error) {
                  setNotice(describeError(error));
                }
              }}
            >
              <Download aria-hidden className="h-3.5 w-3.5" /> {t("saveToFile")}
            </button>
            <button className={BUTTON} type="button" onClick={() => void open()}>
              <RefreshCw aria-hidden className="h-3.5 w-3.5" /> {tCommon("refresh")}
            </button>
            {notice ? (
              <p className="flex items-center gap-1 text-xs text-muted-foreground" role="status">
                <Check aria-hidden className="h-3.5 w-3.5" /> {notice}
              </p>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
