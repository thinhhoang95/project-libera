// Background reference jobs (docs/references/lanes.md "Background jobs"):
// the status the jobs API returns and the panel shows. Pure types only.

/**
 * `check-retractions` checks every entry with a DOI against Crossref for
 * retractions, corrections and expressions of concern (retraction.ts). Its
 * `total`/`done`/`failed` count entries, `current` and error `path`s are
 * citation keys, and `updatedEntryIds` lists the entries whose status changed.
 */
export type ReferenceJobKind = "resolve-pdfs" | "resolve-paths" | "check-retractions";
export type ReferenceJobState = "queued" | "running" | "done" | "failed" | "cancelled";

export type ReferenceJobStatus = {
  id: string;
  notebook: string;
  kind: ReferenceJobKind;
  state: ReferenceJobState;
  /** Files the job will process. A `resolve-pdfs` job counts them when it starts. */
  total: number;
  /** Files processed without error, including files skipped because they already had an entry. */
  done: number;
  /** Files that failed; each has an entry in `errors`. */
  failed: number;
  /** The file being processed. */
  current?: string;
  createdEntryIds: string[];
  updatedEntryIds: string[];
  errors: { path: string; message: string }[];
  webSearch: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export const REFERENCE_JOB_ACTIONS = ["resolve-pdfs", "resolve-paths", "cancel"] as const;
export type ReferenceJobAction = typeof REFERENCE_JOB_ACTIONS[number];

/** Body of POST /api/references/jobs. */
export type ReferenceJobRequest = {
  notebook: string;
  action: ReferenceJobAction;
  /** Library-relative paths, for `resolve-paths`. */
  paths?: string[];
  /** For `cancel`. */
  jobId?: string;
  /** Let the model search the web; defaults to the preference. */
  webSearch?: boolean;
};

/** Body of POST /api/references/retractions. */
export type RetractionCheckRequest = {
  notebook: string;
  /** Check now even when the last check is less than RETRACTION_CHECK_INTERVAL_MS old. */
  force?: boolean;
};

/** Reply of POST /api/references/retractions: the job, or null when no check was due (or nothing has a DOI). */
export type RetractionCheckResponse = {
  job: ReferenceJobStatus | null;
  /** When the last check completed. */
  lastCheckedAt?: string;
  /** Why no check started: online lookups are off, the last check is recent, or no entry has a DOI. */
  skipped?: "lookups-off" | "not-due" | "no-dois";
};

/** A notebook's library is checked at most this often unless forced: 7 days. */
export const RETRACTION_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export function isActiveReferenceJob(job: Pick<ReferenceJobStatus, "state">) {
  return job.state === "queued" || job.state === "running";
}
