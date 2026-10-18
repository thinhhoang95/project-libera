// Storage gauges for the dashboard and alerts (source plan §11: "update log
// growth; snapshot and compaction lag"). They need table scans, so a job
// refreshes them every two minutes instead of computing them on each scrape.

import { sql } from "kysely";
import { Gauge, type Registry } from "prom-client";

import type { ServerContext } from "../context.js";
import type { Job } from "../jobs/index.js";

/** Documents with the largest retained update log, exported with their id. */
export const TOP_LOG_DOCUMENTS = 10;

export interface StorageGauges {
  snapshots: Gauge;
  logUpdates: Gauge;
  logBytes: Gauge;
  lagUpdates: Gauge;
  overThreshold: Gauge;
  docLogBytes: Gauge<"doc_id">;
  quarantined: Gauge;
}

const gauges = new WeakMap<Registry, StorageGauges>();

export function storageGauges(registry: Registry): StorageGauges {
  let value = gauges.get(registry);
  if (!value) {
    const registers = [registry];
    value = {
      snapshots: new Gauge({ name: "libera_storage_snapshots", help: "Rows in doc_snapshots.", registers }),
      logUpdates: new Gauge({ name: "libera_storage_log_updates", help: "Rows in doc_updates (retained log).", registers }),
      logBytes: new Gauge({ name: "libera_storage_log_bytes", help: "Bytes of retained updates.", registers }),
      lagUpdates: new Gauge({
        name: "libera_storage_compaction_lag_updates",
        help: "Largest number of updates any sub-document has after its latest snapshot.",
        registers,
      }),
      overThreshold: new Gauge({
        name: "libera_storage_subdocs_over_snapshot_threshold",
        help: "Sub-documents with SNAPSHOT_EVERY_UPDATES or more unsnapshotted updates (waiting for compaction).",
        registers,
      }),
      docLogBytes: new Gauge({
        name: "libera_storage_doc_log_bytes",
        help: `Retained log bytes of the ${TOP_LOG_DOCUMENTS} documents with the largest logs.`,
        labelNames: ["doc_id"],
        registers,
      }),
      quarantined: new Gauge({
        name: "libera_storage_quarantined_updates",
        help: "Rows in quarantined_updates (admin CLI).",
        registers,
      }),
    };
    gauges.set(registry, value);
  }
  return value;
}

export async function refreshStorageMetrics(context: ServerContext): Promise<void> {
  const { db, config } = context;
  const metrics = storageGauges(context.metrics);

  const snapshots = await db.selectFrom("doc_snapshots").select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirst();
  const log = await db
    .selectFrom("doc_updates")
    .select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.coalesce(eb.fn.sum<number>("size"), sql<number>`0`).as("bytes")])
    .executeTakeFirst();
  const quarantined = await db.selectFrom("quarantined_updates").select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirst();

  // Updates after each sub-document's latest snapshot.
  const lag = await sql<{ worst: number | string | null; over: number | string | null }>`
    select max(n) as worst, count(*) filter (where n >= ${config.SNAPSHOT_EVERY_UPDATES}) as over
    from (
      select count(*) as n
      from doc_updates u
      where u.server_seq > coalesce(
        (select max(s.upto_server_seq) from doc_snapshots s where s.doc_id = u.doc_id and s.subdoc = u.subdoc), 0)
      group by u.doc_id, u.subdoc
    ) per_subdoc
  `.execute(db);

  const top = await db
    .selectFrom("doc_updates")
    .select(["doc_id", (eb) => eb.fn.sum<number>("size").as("bytes")])
    .groupBy("doc_id")
    .orderBy("bytes", "desc")
    .limit(TOP_LOG_DOCUMENTS)
    .execute();

  metrics.snapshots.set(Number(snapshots?.n ?? 0));
  metrics.logUpdates.set(Number(log?.n ?? 0));
  metrics.logBytes.set(Number(log?.bytes ?? 0));
  metrics.quarantined.set(Number(quarantined?.n ?? 0));
  metrics.lagUpdates.set(Number(lag.rows[0]?.worst ?? 0));
  metrics.overThreshold.set(Number(lag.rows[0]?.over ?? 0));
  metrics.docLogBytes.reset();
  for (const row of top) metrics.docLogBytes.set({ doc_id: row.doc_id }, Number(row.bytes));
}

export const storageMetricsJob: Job = {
  name: "storage-metrics",
  intervalMs: 2 * 60_000,
  runAtStart: true,
  run: refreshStorageMetrics,
};
