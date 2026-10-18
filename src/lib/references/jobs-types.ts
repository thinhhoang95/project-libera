// Background reference jobs (docs/references/lanes.md "Background jobs"):
// the status the jobs API returns and the panel shows. Pure types only.

export type ReferenceJobKind = "resolve-pdfs" | "resolve-paths";
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

export function isActiveReferenceJob(job: Pick<ReferenceJobStatus, "state">) {
  return job.state === "queued" || job.state === "running";
}
