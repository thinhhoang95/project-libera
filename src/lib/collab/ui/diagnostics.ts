// "Report sync problem": fetches the host's diagnostics bundle (no content,
// see diagnostics-types.ts) and turns it into what the dialog shows, copies
// and saves.

import { ControlRoutes } from "@/lib/collab/local-api";
import { collabClient, type CollabClient } from "./client";
import type { HostDiagnostics } from "./diagnostics-types";

export type {
  DiagnosticsCounters,
  DiagnosticsDoc,
  DiagnosticsError,
  DiagnosticsTransition,
  DivergenceOutcome,
  DivergenceRecord,
  HostDiagnostics,
} from "./diagnostics-types";

export function fetchDiagnostics(client: CollabClient = collabClient): Promise<HostDiagnostics> {
  return client.request<HostDiagnostics>("GET", ControlRoutes.diagnostics);
}

/** What `useTranslations("lib.collab.ui.diagnostics")` returns, as far as this file needs it. */
export type DiagnosticsTranslator = (key: string, values?: Record<string, string | number>) => string;

/** Message keys (`included.*`) for what the bundle holds, shown above it so users know what they are about to share. */
export const DIAGNOSTICS_INCLUDED: readonly string[] = ["versions", "connectionChanges", "perDocument", "counts", "errors", "databaseSize"];

/** Message keys (`excluded.*`) for what it never holds. */
export const DIAGNOSTICS_EXCLUDED: readonly string[] = ["documentText", "commentBodies", "credentials"];

export function diagnosticsText(bundle: HostDiagnostics): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/** libera-sync-report-20261018-142233.json (local time). */
export function diagnosticsFileName(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `libera-sync-report-${stamp}.json`;
}

export interface DiagnosticsSummaryLine {
  label: string;
  value: string;
  /** Worth the user's attention (pending for long, divergence, errors). */
  warn?: boolean;
}

/** A few human-readable lines above the raw bundle. */
export function diagnosticsSummary(bundle: HostDiagnostics, t: DiagnosticsTranslator): DiagnosticsSummaryLine[] {
  const stuck = bundle.docs.filter((doc) => doc.pending > 0);
  const oldestMinutes = Math.floor(bundle.pending.oldestUnackedSeconds / 60);
  const unresolved = bundle.divergence.filter((record) => record.outcome === "mismatch" && !record.recovered).length;
  return [
    { label: t("rows.connection"), value: t("rows.connectionValue", { state: bundle.connection.current }) },
    {
      label: t("rows.waiting"),
      value:
        bundle.pending.unackedUpdates === 0
          ? t("rows.waitingNothing")
          : t("rows.waitingValue", {
              changes: bundle.pending.unackedUpdates,
              docs: stuck.length || bundle.pending.docsWithUnacked,
              hasOldest: oldestMinutes > 0 ? "yes" : "no",
              minutes: oldestMinutes,
            }),
      warn: bundle.pending.oldestUnackedSeconds > 300,
    },
    {
      label: t("rows.commentsWaiting"),
      value: String(bundle.pending.commands),
      warn: bundle.pending.commands > 0 && bundle.connection.current === "connected",
    },
    {
      label: t("rows.divergence"),
      value: t("rows.divergenceValue", {
        checked: bundle.counters.divergenceChecks,
        differed: bundle.counters.divergenceFailures,
        hasUnresolved: unresolved ? "yes" : "no",
        unresolved,
      }),
      warn: unresolved > 0,
    },
    { label: t("rows.errors"), value: String(bundle.errors.length), warn: bundle.errors.length > 0 },
    {
      label: t("rows.versions"),
      value: t("rows.versionsValue", { app: bundle.appVersion, host: bundle.hostVersion, protocol: bundle.protocolVersion }),
    },
  ];
}

/** Offers the bundle as a .json download (Electron shows its save dialog). */
export function saveDiagnosticsFile(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // The download has started from the click; give the browser a moment to read the blob.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
