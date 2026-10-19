"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isActiveReferenceJob, type ReferenceJobRequest, type ReferenceJobStatus } from "@/lib/references/jobs-types";

// Background reference jobs in the References panel ("Background jobs" in
// docs/references/lanes.md): start a job, poll GET /api/references/jobs every
// 2 s while one is active (and not at all otherwise), cancel it, and tell the
// panel when a job's counts change so it reloads the library and new entries
// appear as they are created.

export const REFERENCE_JOB_POLL_MS = 2000;
let pollInterval = REFERENCE_JOB_POLL_MS;

/** Tests: poll faster. */
export function setReferenceJobPollInterval(ms: number) {
  pollInterval = ms;
}

/** Jobs this window saw running, per notebook, so their summary shows once they finish (and not for old jobs). */
const watched = new Map<string, Set<string>>();
/** Finished jobs whose summary the user dismissed. */
const dismissed = new Set<string>();

function watchedFor(notebook: string) {
  let ids = watched.get(notebook);
  if (!ids) {
    ids = new Set();
    watched.set(notebook, ids);
  }
  return ids;
}

/** Tests: forget watched and dismissed jobs. */
export function resetReferenceJobs() {
  watched.clear();
  dismissed.clear();
  pollInterval = REFERENCE_JOB_POLL_MS;
}

async function errorMessage(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON.
  }
  return fallback;
}

export async function fetchReferenceJobs(notebook: string): Promise<ReferenceJobStatus[]> {
  const response = await fetch(`/api/references/jobs?notebook=${encodeURIComponent(notebook)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(await errorMessage(response, "Could not read the reference jobs."));
  const { jobs } = await response.json() as { jobs?: ReferenceJobStatus[] };
  return Array.isArray(jobs) ? jobs : [];
}

export async function postReferenceJob(request: ReferenceJobRequest): Promise<ReferenceJobStatus> {
  const response = await fetch("/api/references/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(await errorMessage(response, "The reference job could not be started."));
  return (await response.json() as { job: ReferenceJobStatus }).job;
}

/** What changes as a job makes progress; a change means the library may have changed too. */
function progressSignature(job: ReferenceJobStatus) {
  return [job.state, job.done, job.failed, job.createdEntryIds.length, job.updatedEntryIds.length].join("|");
}

/**
 * The notebook's reference jobs. `onProgress` runs whenever a job this
 * window follows reports new counts (reload the library there). `job` is the
 * one to show: an active job, else the latest one that finished while this
 * window followed it and that was not dismissed.
 */
export function useReferenceJobs(notebook: string, onProgress: () => void) {
  const [jobs, setJobs] = useState<ReferenceJobStatus[]>([]);
  const [error, setError] = useState("");
  const [, setDismissals] = useState(0);
  const signatures = useRef(new Map<string, string>());
  /** Bumped when this window starts or cancels a job, so a listing requested before that cannot hide it. */
  const generation = useRef(0);
  const progressRef = useRef(onProgress);
  useEffect(() => {
    progressRef.current = onProgress;
  }, [onProgress]);

  const adopt = useCallback((next: ReferenceJobStatus[]) => {
    const ids = watchedFor(notebook);
    let changed = false;
    for (const job of next) {
      if (isActiveReferenceJob(job)) ids.add(job.id);
      if (!ids.has(job.id)) continue;
      const signature = progressSignature(job);
      const known = signatures.current.get(job.id);
      if (known !== undefined && known !== signature) changed = true;
      signatures.current.set(job.id, signature);
    }
    setJobs(next);
    if (changed) progressRef.current();
  }, [notebook]);

  /** The jobs, unless this window started or cancelled one while they were being read. */
  const load = useCallback(async () => {
    const asked = generation.current;
    const next = await fetchReferenceJobs(notebook);
    if (asked === generation.current) adopt(next);
  }, [notebook, adopt]);

  const refresh = useCallback(async () => {
    try {
      await load();
      setError("");
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Could not read the reference jobs.");
    }
  }, [load]);

  // Once on mount, to pick up a job started elsewhere or before this panel opened.
  useEffect(() => {
    const asked = generation.current;
    fetchReferenceJobs(notebook).then((next) => {
      if (asked === generation.current) adopt(next);
    }, () => undefined);
    // A remount or another notebook makes the answer stale.
    return () => {
      generation.current += 1;
    };
  }, [notebook, adopt]);

  const active = jobs.some(isActiveReferenceJob);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void refresh(), pollInterval);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  const start = useCallback(async (request: Omit<ReferenceJobRequest, "notebook">) => {
    setError("");
    const job = await postReferenceJob({ notebook, ...request });
    generation.current += 1;
    watchedFor(notebook).add(job.id);
    signatures.current.set(job.id, progressSignature(job));
    setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
    return job;
  }, [notebook]);

  const cancel = useCallback(async (jobId: string) => {
    setError("");
    try {
      const job = await postReferenceJob({ notebook, action: "cancel", jobId });
      generation.current += 1;
      setJobs((current) => current.map((item) => item.id === job.id ? job : item));
      // The runner may still finish the file in hand; one more poll settles the counts.
      void refresh();
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "The job could not be cancelled.");
    }
  }, [notebook, refresh]);

  const dismiss = useCallback((jobId: string) => {
    dismissed.add(jobId);
    setDismissals((count) => count + 1);
  }, []);

  const ids = watchedFor(notebook);
  const followed = jobs
    .filter((item) => ids.has(item.id) && (isActiveReferenceJob(item) || !dismissed.has(item.id)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const job = followed.find(isActiveReferenceJob) ?? followed[0] ?? null;

  return { jobs, job, active, error, start, cancel, dismiss, refresh };
}
