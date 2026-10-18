// Background jobs (compaction, checkpoints, notification digests). Each job
// module exports a function registered here with its interval.

import { Gauge, type Registry } from "prom-client";

import type { ServerContext } from "../context.js";
import { reportError } from "../observability/reporter.js";
import { storageMetricsJob } from "../observability/storage-metrics.js";
import { checkpointJob } from "./checkpoints.js";
import { compactionJob } from "./compaction.js";
import { digestJob } from "./digest.js";

export interface Job {
  name: string;
  intervalMs: number;
  /** Also run once when the jobs start (gauges that should not wait an interval). */
  runAtStart?: boolean;
  run(context: ServerContext): Promise<void>;
}

export interface JobRunner {
  /** Runs one job immediately (tests and the admin CLI). */
  runNow(name: string): Promise<void>;
  stop(): void;
}

export const jobs: Job[] = [compactionJob, checkpointJob, digestJob, storageMetricsJob];

const lastSuccess = new WeakMap<Registry, Gauge<"name">>();

/** libera_job_last_success_timestamp_seconds{name}: alerts on a stalled compaction ("job" would clash with Prometheus's own label). */
function lastSuccessGauge(registry: Registry): Gauge<"name"> {
  let gauge = lastSuccess.get(registry);
  if (!gauge) {
    gauge = new Gauge({
      name: "libera_job_last_success_timestamp_seconds",
      help: "Unix time of each background job's last successful run.",
      labelNames: ["name"],
      registers: [registry],
    });
    lastSuccess.set(registry, gauge);
  }
  return gauge;
}

export function startJobs(context: ServerContext, options: { enabled: boolean }): JobRunner {
  const timers: NodeJS.Timeout[] = [];
  const running = new Set<string>();

  async function run(job: Job) {
    if (running.has(job.name)) return;
    running.add(job.name);
    try {
      await job.run(context);
      lastSuccessGauge(context.metrics).set({ name: job.name }, Date.now() / 1000);
    } catch (error) {
      context.log.error({ err: error, job: job.name }, "Job failed");
      reportError(context, error, { area: "job", job: job.name });
    } finally {
      running.delete(job.name);
    }
  }

  if (options.enabled) {
    for (const job of jobs) {
      const timer = setInterval(() => void run(job), job.intervalMs);
      timer.unref();
      timers.push(timer);
      if (job.runAtStart) void run(job);
    }
  }

  return {
    async runNow(name) {
      const job = jobs.find((candidate) => candidate.name === name);
      if (!job) throw new Error(`Unknown job: ${name}`);
      await job.run(context);
    },
    stop() {
      for (const timer of timers) clearInterval(timer);
    },
  };
}
