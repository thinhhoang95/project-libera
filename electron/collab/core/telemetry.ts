// Client metrics (source plan §11, implementation plan §7 "client metrics
// reported by the host in batches").
//
// - HostJournal records what diagnostics and telemetry need while the host
//   runs: the last connection-state changes, recent errors (scrubbed), and
//   cumulative counters (reconnects, rejects by reason, divergence results).
// - TelemetryReporter POSTs a TelemetryReport to /v1/telemetry about once a
//   minute while signed in. Counters are sent as increments since the last
//   report the server accepted: the reporter keeps the cumulative values it
//   last had accepted and subtracts them, so a failed or rate-limited report
//   is folded into the next one and nothing is counted twice.
// - Run markers detect host restarts: a marker file next to the database is
//   written at start and removed on a clean stop, so finding one at start
//   means the previous host on this database crashed or was killed.
//
// Nothing here ever reads document content: reports carry counts, the
// installation's sync clientId, and versions.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { ApiRoutes, type TelemetryReport, type TelemetryResponse } from "../../../src/lib/collab/protocol/api";
import type { RejectReason } from "../../../src/lib/collab/protocol/messages";
import { PROTOCOL_VERSION } from "../../../src/lib/collab/protocol/version";
import type {
  DiagnosticsCounters,
  DiagnosticsError,
  DiagnosticsTransition,
  DivergenceRecord,
} from "../../../src/lib/collab/ui/diagnostics-types";
import { ApiClientError, type ApiClient } from "./api-client";
import type { Clock, Logger, TimerHandle } from "./clock";
import { consoleLogger, systemClock } from "./clock";

export const CONNECTION_HISTORY_LIMIT = 50;
export const ERROR_HISTORY_LIMIT = 100;
const MESSAGE_LIMIT = 300;

/** Reasons the server's schema accepts (server/src/admin/telemetry.ts). Others are not sent. */
export const TELEMETRY_REJECT_REASONS: readonly RejectReason[] = [
  "forbidden",
  "invalid-update",
  "too-large",
  "schema-newer",
  "not-open",
  "rate-limited",
  "annotation-ownership",
];

// ---------------------------------------------------------------- scrubbing

/**
 * Removes secrets and personal data from a free-text message (log lines,
 * server error messages): tokens, long opaque strings, emails and absolute
 * paths, then truncates. Applied when the journal records a message and
 * again over the whole diagnostics bundle.
 */
export function scrubText(value: string, limit = MESSAGE_LIMIT): string {
  let text = String(value)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[token]")
    .replace(/\b(Bearer|Basic)\s+[^\s"',]+/gi, "$1 [token]")
    .replace(/\b(token|password|secret|refreshToken|accessToken)=([^\s&"',]+)/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b[A-Za-z]:\\[^\s"'<>|]*/g, "[path]")
    .replace(/(^|[\s("'=])\/(?:Users|home|root|var|tmp|private|mnt|Volumes|opt|srv|data)\/[^\s"'<>]*/g, "$1[path]")
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, "[redacted]");
  // Control characters make a copied bundle hard to read and can hide text.
  text = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function errorText(detail: unknown): { code?: string; message?: string } {
  if (detail instanceof ApiClientError) return { code: detail.code, message: detail.message };
  if (detail instanceof Error) {
    const code = (detail as { code?: unknown }).code;
    return { ...(typeof code === "string" ? { code } : {}), message: detail.message };
  }
  if (typeof detail === "string") return { message: detail };
  return {};
}

// ---------------------------------------------------------------- journal

export interface ErrorInput {
  source: string;
  code?: string;
  message: string;
  docId?: string;
}

export class HostJournal {
  private readonly clock: Clock;
  private readonly transitions: DiagnosticsTransition[] = [];
  private readonly errorList: DiagnosticsError[] = [];
  private readonly totals: Omit<DiagnosticsCounters, "rejects"> & { rejects: Record<string, number> } = {
    reconnects: 0,
    reconnectSeconds: 0,
    rejects: {},
    divergenceChecks: 0,
    divergenceFailures: 0,
    hostRestarts: 0,
    telemetryReportsSent: 0,
  };
  private everConnected = false;
  private lostAt: number | null = null;
  private lastState: string | null = null;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  /** A sync ConnectionState change. Counts a reconnect each time "connected" comes back. */
  noteConnection(state: string): void {
    if (state === this.lastState) return;
    const now = this.clock.now();
    this.lastState = state;
    this.transitions.push({ at: now, state });
    if (this.transitions.length > CONNECTION_HISTORY_LIMIT) this.transitions.splice(0, this.transitions.length - CONNECTION_HISTORY_LIMIT);
    if (state === "connected") {
      if (this.everConnected) {
        this.totals.reconnects += 1;
        if (this.lostAt !== null) this.totals.reconnectSeconds += Math.max(0, now - this.lostAt) / 1000;
      }
      this.everConnected = true;
      this.lostAt = null;
    } else if (this.everConnected && this.lostAt === null && state !== "stopped" && state !== "idle") {
      // "stopped" and "idle" are sign-out and shutdown, not a lost connection.
      this.lostAt = now;
    } else if (state === "stopped" || state === "idle") {
      this.lostAt = null;
      this.everConnected = false;
    }
  }

  noteError(input: ErrorInput): void {
    const entry: DiagnosticsError = {
      at: this.clock.now(),
      source: input.source,
      message: scrubText(input.message),
      ...(input.code ? { code: scrubText(input.code, 80) } : {}),
      ...(input.docId ? { docId: input.docId } : {}),
    };
    this.errorList.push(entry);
    if (this.errorList.length > ERROR_HISTORY_LIMIT) this.errorList.splice(0, this.errorList.length - ERROR_HISTORY_LIMIT);
  }

  noteReject(reason: string): void {
    this.totals.rejects[reason] = (this.totals.rejects[reason] ?? 0) + 1;
  }

  noteDivergence(record: DivergenceRecord): void {
    if (record.outcome === "match" || record.outcome === "mismatch") this.totals.divergenceChecks += 1;
    if (record.outcome === "mismatch") {
      this.totals.divergenceFailures += 1;
      this.noteError({
        source: "divergence",
        code: record.recovered ? "recovered" : "unresolved",
        message: `Replica differs from the server (${record.detail ?? "mismatch"}).`,
        docId: record.docId,
      });
    }
  }

  noteHostRestart(): void {
    this.totals.hostRestarts += 1;
  }

  noteReportSent(): void {
    this.totals.telemetryReportsSent += 1;
  }

  /** Cumulative counters since this host process started. */
  counters(): DiagnosticsCounters {
    return { ...this.totals, rejects: { ...this.totals.rejects } };
  }

  history(): DiagnosticsTransition[] {
    return [...this.transitions];
  }

  errors(): DiagnosticsError[] {
    return [...this.errorList];
  }
}

/** A logger that also records warnings and errors (scrubbed) in the journal. */
export function journaledLogger(inner: Logger, journal: HostJournal): Logger {
  const record = (message: string, detail: unknown) => {
    const extra = errorText(detail);
    journal.noteError({
      source: "host",
      ...(extra.code ? { code: extra.code } : {}),
      message: extra.message ? `${message}: ${extra.message}` : message,
    });
  };
  return {
    warn(message, detail) {
      record(message, detail);
      inner.warn(message, detail);
    },
    error(message, detail) {
      record(message, detail);
      inner.error(message, detail);
    },
  };
}

// ---------------------------------------------------------------- run markers

export interface RunLedger {
  /** The previous run on this database ended without a clean stop. */
  previousRunUnclean: boolean;
  /** Unclean exits seen on this database so far, this one included. */
  uncleanTotal: number;
  /** Removes the marker; call on a clean stop. */
  clean(): void;
}

/**
 * Writes `<dbPath>.running` (and keeps `<dbPath>.runs.json` with the total).
 * Failures are ignored: the counter is diagnostics, never a reason not to start.
 */
export function openRunLedger(dbPath: string, now: () => number = Date.now): RunLedger {
  const marker = `${dbPath}.running`;
  const totals = `${dbPath}.runs.json`;
  let uncleanTotal = 0;
  try {
    const parsed = JSON.parse(readFileSync(totals, "utf8")) as { unclean?: unknown };
    if (typeof parsed.unclean === "number" && Number.isFinite(parsed.unclean)) uncleanTotal = Math.max(0, Math.floor(parsed.unclean));
  } catch {
    // First run, or an unreadable file: start from zero.
  }
  const previousRunUnclean = existsSync(marker);
  try {
    if (previousRunUnclean) {
      uncleanTotal += 1;
      writeFileSync(totals, JSON.stringify({ unclean: uncleanTotal }));
    }
    writeFileSync(marker, JSON.stringify({ pid: process.pid, startedAt: now() }));
  } catch {
    // Read-only or vanished directory: the store will report the real problem.
  }
  return {
    previousRunUnclean,
    uncleanTotal,
    clean() {
      try {
        rmSync(marker, { force: true });
      } catch {
        // Nothing to clean.
      }
    },
  };
}

// ---------------------------------------------------------------- reporter

/** TelemetryReport plus counters the server may not know yet (it ignores unknown keys). */
export interface HostTelemetryReport extends TelemetryReport {
  /** Seconds spent reconnecting since the previous accepted report. */
  reconnectSeconds: number;
  /** Host restarts after an unclean exit since the previous accepted report. */
  hostRestarts: number;
}

export interface TelemetryGauges {
  pendingUpdates: number;
  oldestUnackedSeconds: number;
  pendingCommands: number;
  openDocuments: number;
}

export interface TelemetrySource {
  /** REST client while signed in, else null (no reports). */
  api(): ApiClient | null;
  clientId(): string | null;
  gauges(): TelemetryGauges;
}

export interface TelemetryReporterOptions {
  source: TelemetrySource;
  journal: HostJournal;
  appVersion: string;
  clock?: Clock;
  logger?: Logger;
  /** Delay before the first report after start. */
  initialDelayMs?: number;
  /** Used until the server says otherwise (TelemetryResponse.nextReportSeconds). */
  intervalMs?: number;
  /** Never send two reports closer than this (the server allows 6 per minute). */
  minIntervalMs?: number;
}

export type ReportOutcome = "sent" | "signed-out" | "too-soon" | "rate-limited" | "failed";

type CounterSnapshot = Pick<DiagnosticsCounters, "reconnects" | "reconnectSeconds" | "rejects" | "divergenceChecks" | "divergenceFailures" | "hostRestarts">;

const APP_VERSION = /^[0-9A-Za-z.+-]{1,40}$/;
const MAX_COUNT = 1_000_000;

function clampCount(value: number): number {
  return Math.min(MAX_COUNT, Math.max(0, Math.round(value)));
}

export class TelemetryReporter {
  private readonly source: TelemetrySource;
  private readonly journal: HostJournal;
  private readonly appVersion: string;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly initialDelayMs: number;
  private readonly minIntervalMs: number;
  private intervalMs: number;
  /** Cumulative counters the server has accepted so far. */
  private accepted: CounterSnapshot = { reconnects: 0, reconnectSeconds: 0, rejects: {}, divergenceChecks: 0, divergenceFailures: 0, hostRestarts: 0 };
  private timer: TimerHandle | null = null;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private blockedUntil = 0;
  private inFlight: Promise<ReportOutcome> | null = null;
  private running = false;

  constructor(options: TelemetryReporterOptions) {
    this.source = options.source;
    this.journal = options.journal;
    this.appVersion = APP_VERSION.test(options.appVersion) ? options.appVersion : "unknown";
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? consoleLogger;
    this.initialDelayMs = options.initialDelayMs ?? 60_000;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.minIntervalMs = options.minIntervalMs ?? 10_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(this.initialDelayMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  /** The report that would be sent now (increments since the last accepted one). */
  buildReport(): HostTelemetryReport | null {
    const clientId = this.source.clientId();
    if (!clientId) return null;
    const totals = this.journal.counters();
    const gauges = this.source.gauges();
    const rejects: TelemetryReport["rejects"] = {};
    for (const reason of TELEMETRY_REJECT_REASONS) {
      const delta = (totals.rejects[reason] ?? 0) - (this.accepted.rejects[reason] ?? 0);
      if (delta > 0) rejects[reason] = clampCount(delta);
    }
    return {
      clientId,
      appVersion: this.appVersion,
      protocolVersion: PROTOCOL_VERSION,
      pendingUpdates: clampCount(gauges.pendingUpdates),
      oldestUnackedSeconds: Math.max(0, Math.min(10 * 365 * 24 * 3600, Math.floor(gauges.oldestUnackedSeconds))),
      pendingCommands: clampCount(gauges.pendingCommands),
      openDocuments: clampCount(gauges.openDocuments),
      reconnects: clampCount(totals.reconnects - this.accepted.reconnects),
      rejects,
      divergenceChecks: clampCount(totals.divergenceChecks - this.accepted.divergenceChecks),
      divergenceFailures: clampCount(totals.divergenceFailures - this.accepted.divergenceFailures),
      reconnectSeconds: Math.max(0, Math.round(totals.reconnectSeconds - this.accepted.reconnectSeconds)),
      hostRestarts: clampCount(totals.hostRestarts - this.accepted.hostRestarts),
    };
  }

  /** Sends a report now unless signed out, rate limited, or one was sent moments ago. */
  reportNow(): Promise<ReportOutcome> {
    this.inFlight ??= this.send().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.reportNow().finally(() => this.schedule(Math.max(this.intervalMs, this.blockedUntil - this.clock.now())));
    }, Math.max(0, delayMs));
  }

  private async send(): Promise<ReportOutcome> {
    const api = this.source.api();
    if (!api) return "signed-out";
    const now = this.clock.now();
    if (now < this.blockedUntil) return "rate-limited";
    if (now - this.lastAttemptAt < this.minIntervalMs) return "too-soon";
    const totals = this.journal.counters();
    const report = this.buildReport();
    if (!report) return "signed-out";
    this.lastAttemptAt = now;
    try {
      const response = await api.request<TelemetryResponse | undefined>("POST", ApiRoutes.telemetry, { body: report });
      // Everything in this report is now counted on the server.
      this.accepted = {
        reconnects: totals.reconnects,
        reconnectSeconds: totals.reconnectSeconds,
        rejects: { ...totals.rejects },
        divergenceChecks: totals.divergenceChecks,
        divergenceFailures: totals.divergenceFailures,
        hostRestarts: totals.hostRestarts,
      };
      this.journal.noteReportSent();
      const next = response?.nextReportSeconds;
      if (typeof next === "number" && Number.isFinite(next)) this.intervalMs = Math.min(3_600_000, Math.max(this.minIntervalMs, next * 1000));
      return "sent";
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 429) {
        const retry = (error.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
        const seconds = typeof retry === "number" && retry > 0 ? retry : 60;
        this.blockedUntil = this.clock.now() + seconds * 1000;
        return "rate-limited";
      }
      // Not worth a journal entry each minute while offline; the counts wait for the next report.
      if (!(error instanceof ApiClientError && error.transient)) this.logger.warn("Telemetry report was refused", error);
      return "failed";
    }
  }
}
