import type { AgentPermission } from "@/lib/agent/types";

/**
 * The files an Agent run may change, claimed while it runs so that two runs
 * never edit the same file: each run keeps its own baselines and undo
 * snapshots, and undoing one would drop the other's edits.
 */
export type AgentWriteScope = {
  /** Set when the run may change and create any file in this notebook. */
  notebook?: string;
  /** The open files it may change, with the notebook each belongs to. */
  files: { path: string; notebook: string }[];
};

export function agentWriteScope(permission: AgentPermission, notebook: string | undefined, openFiles: { path: string; notebook: string }[]): AgentWriteScope | null {
  if (permission === "read-only") return null;
  if (permission === "notebook") return notebook ? { notebook, files: [] } : null;
  return { files: openFiles };
}

/** Returns a notebook or file the two scopes share, or null when they do not overlap. */
export function agentWriteOverlap(a: AgentWriteScope, b: AgentWriteScope): string | null {
  if (a.notebook && a.notebook === b.notebook) return a.notebook;
  const inNotebook = (scope: AgentWriteScope, other: AgentWriteScope) => scope.notebook ? other.files.find((file) => file.notebook === scope.notebook) : undefined;
  const crossing = inNotebook(a, b) ?? inNotebook(b, a);
  if (crossing) return crossing.path;
  const shared = a.files.find((file) => b.files.some((other) => other.path === file.path));
  return shared?.path ?? null;
}
