// Shared by the agent route and the chat panel; keep free of Node imports.

export const AGENT_PERMISSIONS = ["read-only", "open-files", "notebook"] as const;
export type AgentPermission = typeof AGENT_PERMISSIONS[number];

export function isAgentPermission(value: unknown): value is AgentPermission {
  return AGENT_PERMISSIONS.some((permission) => permission === value);
}

export const AGENT_PERMISSION_LABELS: Record<AgentPermission, string> = {
  "read-only": "Read Only",
  "open-files": "Modify opened files only",
  notebook: "Modify all files in Notebook/Folder",
};

/**
 * The same modes in a shared notebook (plan M3.4), where the agent's changes
 * are suggestions others review: it never edits a shared file directly.
 */
export const SHARED_AGENT_PERMISSION_LABELS: Record<AgentPermission, string> = {
  "read-only": "Read Only",
  "open-files": "Suggest in opened files",
  notebook: "Suggest in notebook",
};

export function agentPermissionLabel(permission: AgentPermission, shared: boolean): string {
  return (shared ? SHARED_AGENT_PERMISSION_LABELS : AGENT_PERMISSION_LABELS)[permission];
}

export type AgentTaskStatus = "pending" | "in_progress" | "completed";
export type AgentTask = { id: string; subject: string; status: AgentTaskStatus };

export type AgentOutcome = "completed" | "stopped" | "limit" | "stuck" | "error";

/** One visible step of a run, in the order it happened. */
export type AgentStep =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      /** Plain-language line, e.g. "Searching for “budget”". */
      summary: string;
      status: "running" | "ok" | "error";
      /** One-line outcome, e.g. "12 matches in 3 files". */
      result?: string;
      /** Short excerpt shown when the step is expanded. */
      detail?: string;
      /** Removed and added text for an edit, shown as a diff. */
      diff?: { removed: string; added: string };
    };

/** `suggested`: a file in a shared notebook, where the change is a pending suggestion (the text is unchanged). */
export type AgentFileChange = { path: string; created: boolean; reverted?: boolean; suggested?: boolean };

/** Review comments a run added to one file. */
export type AgentCommentsAdded = { path: string; count: number };

/** Persisted with an assistant message produced in Agent mode. */
export type AgentRunRecord = {
  runId: string;
  permission: AgentPermission;
  steps: AgentStep[];
  tasks: AgentTask[];
  changes: AgentFileChange[];
  comments?: AgentCommentsAdded[];
  outcome?: AgentOutcome;
};

export type UndoResult = {
  path: string;
  status: "restored" | "deleted" | "conflict" | "missing" | "already-reverted";
  /** The restored disk content, for open tabs. */
  content?: string;
  /** The unsaved draft to put back in an open tab. */
  draft?: string;
  message?: string;
  /**
   * The file is in a shared notebook and was restored through the collab
   * host; open tabs follow through their live replica, not from `content`.
   */
  shared?: boolean;
  /** Shared notebooks: how many of the run's pending suggestions were withdrawn. */
  withdrawn?: number;
};

export type AgentEvent =
  | { type: "run_started"; runId: string; model: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_started"; id: string; name: string; summary: string; diff?: { removed: string; added: string } }
  | { type: "tool_finished"; id: string; status: "ok" | "error"; result: string; detail?: string }
  /**
   * `shared`: the file is in a shared notebook and the change went through the
   * collab host. Open tabs get it from their live replica, so the panel must
   * not reload them from disk (the working copy lags the document).
   * `suggested`: the change is a pending suggestion; the text is unchanged.
   */
  | { type: "file_changed"; path: string; created: boolean; shared?: boolean; suggested?: boolean }
  | { type: "comments_added"; path: string; count: number }
  | { type: "tasks_updated"; tasks: AgentTask[] }
  | { type: "usage"; usage: { inputTokens: number; outputTokens: number; cachedTokens?: number } }
  | { type: "done"; outcome: AgentOutcome; message?: string }
  | { type: "error"; message: string };

const MAX_STORED_STEPS = 400;

function isShortString(value: unknown, limit: number) {
  return typeof value === "string" && value.length <= limit;
}

export function validateAgentRunRecord(value: unknown): value is AgentRunRecord {
  if (!value || typeof value !== "object") return false;
  const run = value as AgentRunRecord;
  return isShortString(run.runId, 128) && isAgentPermission(run.permission) &&
    (run.outcome === undefined || ["completed", "stopped", "limit", "stuck", "error"].includes(run.outcome)) &&
    Array.isArray(run.steps) && run.steps.length <= MAX_STORED_STEPS && run.steps.every((step) => step && (
      (step.kind === "text" && isShortString(step.text, 200_000)) ||
      (step.kind === "tool" && isShortString(step.id, 256) && isShortString(step.name, 64) && isShortString(step.summary, 1_000) &&
        (step.status === "running" || step.status === "ok" || step.status === "error") &&
        (step.result === undefined || isShortString(step.result, 2_000)) &&
        (step.detail === undefined || isShortString(step.detail, 20_000)) &&
        (step.diff === undefined || (isShortString(step.diff?.removed, 20_000) && isShortString(step.diff?.added, 20_000))))
    )) &&
    Array.isArray(run.tasks) && run.tasks.length <= 100 && run.tasks.every((task) => task && isShortString(task.id, 32) && isShortString(task.subject, 500) &&
      (task.status === "pending" || task.status === "in_progress" || task.status === "completed")) &&
    Array.isArray(run.changes) && run.changes.length <= 500 && run.changes.every((change) => change && isShortString(change.path, 4_096) &&
      typeof change.created === "boolean" && (change.reverted === undefined || typeof change.reverted === "boolean") &&
      (change.suggested === undefined || typeof change.suggested === "boolean")) &&
    (run.comments === undefined || (Array.isArray(run.comments) && run.comments.length <= 500 && run.comments.every((entry) => entry && isShortString(entry.path, 4_096) &&
      Number.isInteger(entry.count) && entry.count >= 0)));
}

/** Keeps a stored run within the history limits, dropping the oldest tool steps first. */
export function compactAgentRunRecord(run: AgentRunRecord): AgentRunRecord {
  if (run.steps.length <= MAX_STORED_STEPS) return run;
  const overflow = run.steps.length - MAX_STORED_STEPS;
  let dropped = 0;
  const steps = run.steps.filter((step) => step.kind !== "tool" || dropped >= overflow || (dropped++, false));
  return { ...run, steps: steps.slice(-MAX_STORED_STEPS) };
}
