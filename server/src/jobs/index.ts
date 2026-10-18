// Background jobs (compaction, checkpoints, notification digests). Each job
// module exports a function registered here with its interval.

import type { ServerContext } from "../context.js";

export interface Job {
  name: string;
  intervalMs: number;
  run(context: ServerContext): Promise<void>;
}

export interface JobRunner {
  /** Runs one job immediately (tests and the admin CLI). */
  runNow(name: string): Promise<void>;
  stop(): void;
}

export const jobs: Job[] = [];

export function startJobs(context: ServerContext, options: { enabled: boolean }): JobRunner {
  const timers: NodeJS.Timeout[] = [];
  const running = new Set<string>();

  async function run(job: Job) {
    if (running.has(job.name)) return;
    running.add(job.name);
    try {
      await job.run(context);
    } catch (error) {
      context.log.error({ err: error, job: job.name }, "Job failed");
    } finally {
      running.delete(job.name);
    }
  }

  if (options.enabled) {
    for (const job of jobs) {
      const timer = setInterval(() => void run(job), job.intervalMs);
      timer.unref();
      timers.push(timer);
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
