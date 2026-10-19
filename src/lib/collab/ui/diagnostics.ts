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

/** Shown above the bundle, so users know what they are about to share. */
export const DIAGNOSTICS_INCLUDED: readonly string[] = [
  "Libera, collaboration host and operating system versions",
  "The last 50 connection changes (connected, offline, reconnecting) with times",
  "Per shared document: its id, sync state, how many changes wait to be sent, and rejected-edit reasons",
  "Counts: queued changes and comments, reconnects, divergence checks, host restarts",
  "Recent error codes and messages, with emails, paths and tokens removed",
  "Local database size",
];

export const DIAGNOSTICS_EXCLUDED: readonly string[] = [
  "Document text, file names and notebook names",
  "Comment and reply bodies",
  "Your email, password and sign-in tokens",
];

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
export function diagnosticsSummary(bundle: HostDiagnostics): DiagnosticsSummaryLine[] {
  const stuck = bundle.docs.filter((doc) => doc.pending > 0);
  const oldestMinutes = Math.floor(bundle.pending.oldestUnackedSeconds / 60);
  const unresolved = bundle.divergence.filter((record) => record.outcome === "mismatch" && !record.recovered).length;
  return [
    { label: "Connection", value: bundle.connection.current },
    {
      label: "Waiting to sync",
      value:
        bundle.pending.unackedUpdates === 0
          ? "Nothing"
          : `${bundle.pending.unackedUpdates} ${bundle.pending.unackedUpdates === 1 ? "change" : "changes"} in ${stuck.length || bundle.pending.docsWithUnacked} ${(stuck.length || bundle.pending.docsWithUnacked) === 1 ? "document" : "documents"}${oldestMinutes > 0 ? `, oldest ${oldestMinutes} min` : ""}`,
      warn: bundle.pending.oldestUnackedSeconds > 300,
    },
    {
      label: "Comments waiting",
      value: String(bundle.pending.commands),
      warn: bundle.pending.commands > 0 && bundle.connection.current === "connected",
    },
    {
      label: "Divergence checks",
      value: `${bundle.counters.divergenceChecks} checked, ${bundle.counters.divergenceFailures} differed${unresolved ? `, ${unresolved} unresolved` : ""}`,
      warn: unresolved > 0,
    },
    { label: "Recent errors", value: String(bundle.errors.length), warn: bundle.errors.length > 0 },
    { label: "Versions", value: `Libera ${bundle.appVersion} · host ${bundle.hostVersion} · protocol ${bundle.protocolVersion}` },
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
