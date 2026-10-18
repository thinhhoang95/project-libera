// POST /v1/telemetry: client metrics reported by the desktop host (source
// plan §11 "client metrics", implementation plan §7 "client metrics reported
// by the host in batches"). The contract is TelemetryReport in api.ts.
//
// Reports are counts only. The server keeps the latest gauges per
// installation in memory for 15 minutes and exports aggregates, so no label
// carries an account or client id:
//   libera_client_reporting                  installations heard from in 15 min
//   libera_client_pending_updates            sum of unacked updates
//   libera_client_oldest_unacked_seconds     max age of an unacked update
//   libera_client_stale_unacked_clients      installations with one older than 5 min (alert)
//   libera_client_pending_commands           sum of queued offline commands
//   libera_client_reports_total, ..._reconnects_total, ..._rejects_total{reason},
//   libera_client_divergence_checks_total, libera_client_divergence_failures_total (alert)

import type { FastifyInstance } from "fastify";
import { Counter, Gauge, type Registry } from "prom-client";
import { z } from "zod";

import { requireAccount } from "../api/common.js";
import { enforce, RateLimiter } from "../api/rate-limit.js";
import type { ServerContext } from "../context.js";
import { isClientId } from "../ids.js";
import { ApiRoutes, type RejectReason, type TelemetryResponse } from "../protocol.js";

/** Unacked updates older than this count as stale (source plan §11 alert). */
export const STALE_UNACKED_SECONDS = 300;
/** A client that stopped reporting drops out of the gauges after this long. */
export const CLIENT_TTL_MS = 15 * 60_000;
const MAX_CLIENTS = 20_000;
const NEXT_REPORT_SECONDS = 60;

const REJECT_REASONS: readonly RejectReason[] = [
  "forbidden",
  "invalid-update",
  "too-large",
  "schema-newer",
  "not-open",
  "rate-limited",
  "annotation-ownership",
];

const count = z.number().int().min(0).max(1_000_000);

export const telemetrySchema = z.object({
  clientId: z.string().refine(isClientId, "Expected a sync clientId."),
  appVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,40}$/),
  protocolVersion: z.number().int().min(0).max(10_000),
  pendingUpdates: count,
  oldestUnackedSeconds: z.number().min(0).max(10 * 365 * 24 * 3600),
  pendingCommands: count,
  openDocuments: count,
  reconnects: count,
  rejects: z.partialRecord(z.enum(REJECT_REASONS as unknown as [RejectReason, ...RejectReason[]]), count).default({}),
  divergenceChecks: count,
  divergenceFailures: count,
});

interface ClientState {
  pendingUpdates: number;
  oldestUnackedSeconds: number;
  pendingCommands: number;
  at: number;
}

export class TelemetryStore {
  private readonly clients = new Map<string, ClientState>();
  readonly reports: Counter;
  readonly reconnects: Counter;
  readonly rejects: Counter<"reason">;
  readonly divergenceChecks: Counter;
  readonly divergenceFailures: Counter;
  readonly limiter = new RateLimiter(6, 60_000);

  constructor(registry: Registry, private readonly now: () => number = Date.now) {
    const registers = [registry];
    const store = this;
    const gauge = (name: string, help: string, value: (states: ClientState[]) => number) =>
      new Gauge({
        name,
        help,
        registers,
        collect() {
          this.set(value(store.live()));
        },
      });
    gauge("libera_client_reporting", "Installations that reported in the last 15 minutes.", (states) => states.length);
    gauge("libera_client_pending_updates", "Unacked updates over all reporting installations.", (states) =>
      states.reduce((sum, state) => sum + state.pendingUpdates, 0),
    );
    gauge("libera_client_oldest_unacked_seconds", "Age of the oldest unacked update on any installation.", (states) =>
      states.reduce((max, state) => Math.max(max, state.oldestUnackedSeconds), 0),
    );
    gauge(
      "libera_client_stale_unacked_clients",
      `Installations with an update unacked for more than ${STALE_UNACKED_SECONDS} s.`,
      (states) => states.filter((state) => state.oldestUnackedSeconds > STALE_UNACKED_SECONDS).length,
    );
    gauge("libera_client_pending_commands", "Queued offline commands over all reporting installations.", (states) =>
      states.reduce((sum, state) => sum + state.pendingCommands, 0),
    );
    this.reports = new Counter({ name: "libera_client_reports_total", help: "Accepted telemetry reports.", registers });
    this.reconnects = new Counter({ name: "libera_client_reconnects_total", help: "Reconnects reported by hosts.", registers });
    this.rejects = new Counter({
      name: "libera_client_rejects_total",
      help: "Rejected updates reported by hosts, by reason.",
      labelNames: ["reason"],
      registers,
    });
    this.divergenceChecks = new Counter({
      name: "libera_client_divergence_checks_total",
      help: "Conclusive divergence checks reported by hosts.",
      registers,
    });
    this.divergenceFailures = new Counter({
      name: "libera_client_divergence_failures_total",
      help: "Divergence checks where the host and server disagree.",
      registers,
    });
  }

  record(accountId: string, report: z.infer<typeof telemetrySchema>): void {
    const key = `${accountId}/${report.clientId}`;
    if (!this.clients.has(key) && this.clients.size >= MAX_CLIENTS) this.prune();
    if (!this.clients.has(key) && this.clients.size >= MAX_CLIENTS) return;
    this.clients.set(key, {
      pendingUpdates: report.pendingUpdates,
      oldestUnackedSeconds: report.oldestUnackedSeconds,
      pendingCommands: report.pendingCommands,
      at: this.now(),
    });
    this.reports.inc();
    if (report.reconnects > 0) this.reconnects.inc(report.reconnects);
    for (const [reason, value] of Object.entries(report.rejects)) if (value) this.rejects.inc({ reason }, value);
    if (report.divergenceChecks > 0) this.divergenceChecks.inc(report.divergenceChecks);
    if (report.divergenceFailures > 0) this.divergenceFailures.inc(report.divergenceFailures);
  }

  live(): ClientState[] {
    this.prune();
    return [...this.clients.values()];
  }

  private prune(): void {
    const cutoff = this.now() - CLIENT_TTL_MS;
    for (const [key, state] of this.clients) if (state.at < cutoff) this.clients.delete(key);
  }
}

const stores = new WeakMap<object, TelemetryStore>();

export function telemetryStore(context: ServerContext): TelemetryStore {
  let store = stores.get(context);
  if (!store) {
    store = new TelemetryStore(context.metrics);
    stores.set(context, store);
  }
  return store;
}

export function registerTelemetryRoutes(app: FastifyInstance, context: ServerContext): void {
  const store = telemetryStore(context);
  app.post(ApiRoutes.telemetry, { bodyLimit: 16 * 1024 }, async (request, reply): Promise<TelemetryResponse> => {
    const { accountId } = await requireAccount(context, request);
    enforce(reply, [[store.limiter, accountId]]);
    store.record(accountId, telemetrySchema.parse(request.body));
    return { nextReportSeconds: NEXT_REPORT_SECONDS };
  });
}
