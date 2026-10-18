// Prometheus metrics for the sync service, registered on context.metrics.

import { Counter, Gauge, Histogram, type Registry } from "prom-client";

const LATENCY_BUCKETS = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

export interface SyncMetrics {
  persistSeconds: Histogram;
  fanoutSeconds: Histogram;
  updates: Counter<"subdoc" | "source">;
  rejects: Counter<"reason">;
}

export function createSyncMetrics(registry: Registry, sizes: { rooms(): number; sockets(): number }): SyncMetrics {
  new Gauge({
    name: "libera_sync_rooms",
    help: "Documents loaded in memory.",
    registers: [registry],
    collect() {
      this.set(sizes.rooms());
    },
  });
  new Gauge({
    name: "libera_sync_sockets",
    help: "Open sync WebSockets.",
    registers: [registry],
    collect() {
      this.set(sizes.sockets());
    },
  });
  return {
    persistSeconds: new Histogram({
      name: "libera_sync_persist_seconds",
      help: "Time to persist one update (transaction commit).",
      buckets: LATENCY_BUCKETS,
      registers: [registry],
    }),
    fanoutSeconds: new Histogram({
      name: "libera_sync_fanout_seconds",
      help: "Time to send one persisted update to the other sockets of its room.",
      buckets: LATENCY_BUCKETS,
      registers: [registry],
    }),
    updates: new Counter({
      name: "libera_sync_updates_total",
      help: "Updates by sub-document and source (client, server, duplicate).",
      labelNames: ["subdoc", "source"],
      registers: [registry],
    }),
    rejects: new Counter({
      name: "libera_sync_rejects_total",
      help: "Rejected updates by reason.",
      labelNames: ["reason"],
      registers: [registry],
    }),
  };
}
