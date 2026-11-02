"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { Check, ChevronDown, ChevronRight, FileDiff, X } from "lucide-react";
import { agentReviewStore, reviewLineCounts } from "@/lib/agent-review/store";
import type { AgentReviewRevertResult } from "@/lib/agent/types";

type Row = { path: string; name: string; added: number; removed: number; created: boolean };

/**
 * Manual review: the files with agent changes still to review, above the
 * composer. Each file opens in its tab, where its changes are accepted or
 * rejected one by one; here they are accepted or rejected per file or all
 * at once. `readTabDraft` gives an open tab's live text, which the counts
 * follow; `revision` changes when tabs do.
 */
export function AgentReviewStrip({ readTabDraft, revision, onOpenFile, onReverted, onError }: {
  readTabDraft: (path: string) => string | null;
  revision: unknown;
  onOpenFile: (path: string) => void;
  onReverted: (results: AgentReviewRevertResult[], drafts: Record<string, string | null>) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const version = useSyncExternalStore(agentReviewStore.subscribe, agentReviewStore.version, () => 0);
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const reviewError = agentReviewStore.error();
  const rows = useMemo<Row[]>(() => {
    void version;
    void revision;
    return agentReviewStore.list().flatMap((file) => {
      const text = readTabDraft(file.path) ?? file.current;
      // CodeMirror represents CRLF documents with LF in its live text.
      const baseline = file.baseline.includes("\r\n") && file.current.includes("\r\n") && !text.includes("\r\n") ? file.baseline.replace(/\r\n/g, "\n") : file.baseline;
      // An open tab back at its baseline is reviewed; saving it settles the file.
      if (text === baseline && !(file.created && text === "")) return [];
      const counts = reviewLineCounts(baseline, text);
      return [{ path: file.path, name: file.path.split("/").at(-1) ?? file.path, added: counts.added, removed: counts.removed, created: file.created }];
    });
  }, [version, revision, readTabDraft]);
  if (!rows.length) return reviewError ? <p role="alert" className="text-xs text-destructive">{reviewError}</p> : null;

  async function decide(paths: string[], decision: "keep" | "revert") {
    if (busy) return;
    setBusy(true);
    try {
      if (decision === "keep") await agentReviewStore.keep(paths);
      else {
        const drafts = Object.fromEntries(paths.map((path) => [path, readTabDraft(path)]));
        const results = await agentReviewStore.revert(paths);
        await onReverted(results, drafts);
        const problems = results.filter((result) => result.status === "missing" || result.status === "conflict").map((result) => result.message ?? result.path);
        if (problems.length) { onError(problems.join(" ")); void agentReviewStore.refresh(); }
      }
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Could not update the review.");
      void agentReviewStore.refresh();
    } finally {
      setBusy(false);
    }
  }

  const all = rows.map((row) => row.path);
  const iconButton = "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40";
  return <section className="libera-agent-review rounded-xl border border-border bg-card text-xs" aria-label="Agent changes to review">
    {reviewError && <p role="alert" className="px-2 py-1 text-destructive">{reviewError}</p>}
    <div className="flex items-center gap-1 px-2 py-1">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-0.5 text-left font-medium" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
        {collapsed ? <ChevronRight aria-hidden size={13} className="shrink-0" /> : <ChevronDown aria-hidden size={13} className="shrink-0" />}
        <FileDiff aria-hidden size={13} className="shrink-0 text-accent" />
        <span className="truncate">{rows.length === 1 ? "1 file to review" : `${rows.length} files to review`}</span>
      </button>
      <button type="button" disabled={busy} className="libera-change-bar-reject inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md px-2 font-medium disabled:opacity-40"
        title="Reject every change the agent made in these files" onClick={() => void decide(all, "revert")}><X aria-hidden size={12} />Reject all</button>
      <button type="button" disabled={busy} className="libera-change-bar-accept inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md px-2 font-medium disabled:opacity-40"
        title="Accept every change the agent made in these files" onClick={() => void decide(all, "keep")}><Check aria-hidden size={12} />Accept all</button>
    </div>
    {!collapsed && <ul className="max-h-40 overflow-auto border-t border-border py-1">
      {rows.map((row) => <li key={row.path} className="flex items-center gap-1 px-2">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-muted" aria-label={`Review ${row.path}`} title={`Review ${row.path}`} onClick={() => onOpenFile(row.path)}>
          <span className="min-w-0 truncate">{row.name}</span>
          {row.created && <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">new</span>}
          <span className="ml-auto shrink-0 tabular-nums"><span className="libera-agent-review-added">+{row.added}</span> <span className="libera-agent-review-removed">−{row.removed}</span></span>
        </button>
        <button type="button" disabled={busy} className={iconButton} aria-label={`Reject changes in ${row.path}`} title={row.created ? "Reject: remove the file the agent created" : "Reject the agent's changes in this file"} onClick={() => void decide([row.path], "revert")}><X aria-hidden size={13} /></button>
        <button type="button" disabled={busy} className={iconButton} aria-label={`Accept changes in ${row.path}`} title="Accept the agent's changes in this file" onClick={() => void decide([row.path], "keep")}><Check aria-hidden size={13} /></button>
      </li>)}
    </ul>}
  </section>;
}
