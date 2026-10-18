"use client";

// "Activity log" in a shared notebook's sharing dialog (plan M3.6), for
// owners: the project's audit log from the server, newest first and paged,
// with who did it (AI labelled with the person it acted for), what, on what,
// and when, filterable by kind of action.

import { LoaderCircle, ScrollText } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuditEntry, Member } from "@/lib/collab/local-api";
import type { Actor } from "@/lib/collab/protocol/actor";
import { createReviewsApi, type ReviewsApi } from "@/lib/collab/client/reviews";
import { describeError } from "@/lib/collab/ui/client";
import { timeAgo } from "@/lib/collab/ui/wording";

const SMALL_BUTTON = "inline-flex items-center justify-center gap-1 rounded-md border border-input px-2 py-1 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";

/** Filter choices: an action, or a prefix of actions ("review" is every review action). */
export const AUDIT_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All activity" },
  { value: "suggestion", label: "Suggestion decisions" },
  { value: "suggestions.decide-all", label: "Accept or reject all" },
  { value: "review", label: "Reviews" },
  { value: "document.restore", label: "Restores" },
  { value: "member", label: "Roles" },
  { value: "invitation", label: "Invitations" },
  { value: "document", label: "Documents" },
  { value: "project", label: "Notebook" },
];

const ACTIONS: Record<string, string> = {
  "suggestion.decide": "decided a suggestion",
  "suggestion.revert": "undid an acceptance",
  "suggestions.decide-all": "decided all suggestions",
  "review.request": "requested a review",
  "review.decide": "decided a review",
  "review.close": "closed a review",
  "document.restore": "restored a version",
  "document.delete": "deleted a document",
  "member.role": "changed a role",
  "invitation.create": "invited someone",
  "invitation.accept": "accepted an invitation",
  "invitation.revoke": "revoked an invitation",
  "project.create": "shared the notebook",
  "project.rename": "renamed the notebook",
  "project.delete": "deleted the notebook",
};

export function auditActionLabel(action: string): string {
  return ACTIONS[action] ?? action;
}

/** "Ada", "AI · requested by Ada", or "Libera" for system actions. */
export function auditActorLabel(actor: Actor | null, names: ReadonlyMap<string, string>): string {
  if (!actor) return "Libera";
  if (actor.kind === "user") return names.get(actor.userId) ?? "A former member";
  if (actor.kind === "ai") return `AI · requested by ${names.get(actor.onBehalfOf) ?? "a former member"}`;
  return actor.onBehalfOf ? `Libera, for ${names.get(actor.onBehalfOf) ?? "a former member"}` : "Libera";
}

/** A short line from an entry's details: the decision, outcome or role. */
function detailLine(entry: AuditEntry, names: ReadonlyMap<string, string>): string {
  const details = entry.details ?? {};
  const parts: string[] = [];
  for (const key of ["decision", "outcome", "role", "status"] as const) {
    const value = details[key];
    if (typeof value === "string") parts.push(value.replace(/-/g, " "));
  }
  if (typeof details.count === "number") parts.push(`${details.count} suggestions`);
  const target = names.get(entry.target);
  return [target ? `for ${target}` : entry.target ? entry.target : "", ...parts].filter(Boolean).join(" · ");
}

export function ActivityLogSection({ projectId, members, api }: { projectId: string; members: Member[] | null; api?: ReviewsApi }) {
  const client = useMemo(() => api ?? createReviewsApi(), [api]);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const names = useMemo(() => new Map((members ?? []).map((member) => [member.id, member.displayName])), [members]);

  const load = useCallback(async (action: string, before: string | null) => {
    setBusy(true);
    setError("");
    try {
      const page = await client.audit(projectId, { limit: 50, ...(action ? { action } : {}), ...(before ? { before } : {}) });
      setEntries((current) => (before && current ? [...current, ...page.entries] : page.entries));
      setNextBefore(page.nextBefore);
      setNow(Date.now());
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }, [client, projectId]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    // Deferred so the loading state is not set during the effect itself.
    queueMicrotask(() => { if (live) void load(filter, null); });
    return () => { live = false; };
  }, [open, filter, load]);

  return (
    <section aria-labelledby="collab-activity-log" className="libera-dialog-section space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-sm font-medium" id="collab-activity-log"><ScrollText aria-hidden className="mr-1 inline h-3.5 w-3.5" />Activity log</h3>
        <button type="button" className={SMALL_BUTTON} aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? "Hide" : "Show"}</button>
      </div>
      {open ? <>
        <p className="text-xs text-muted-foreground">Decisions, reviews, restores and role changes in this notebook. Only owners see this.</p>
        <select aria-label="Filter activity" className="h-8 w-full rounded-md border border-input bg-card px-2 text-xs" value={filter} onChange={(event) => { setEntries(null); setFilter(event.target.value); }}>
          {AUDIT_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        {entries === null ? <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status"><LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />Loading activity…</p>
          : !entries.length ? <p className="text-xs text-muted-foreground">Nothing here yet.</p>
            : <ol className="max-h-72 divide-y divide-border overflow-auto" aria-label="Activity">
              {entries.map((entry) => {
                const at = Date.parse(entry.at);
                return <li key={entry.id} className="py-1.5 text-xs" data-action={entry.action} data-actor-kind={entry.actor?.kind ?? "system"}>
                  <span className="font-medium">{auditActorLabel(entry.actor, names)}</span> {auditActionLabel(entry.action)}
                  <span className="block text-[11px] text-muted-foreground">{detailLine(entry, names)}{Number.isFinite(at) ? <>{detailLine(entry, names) ? " · " : ""}<span title={new Date(at).toLocaleString()}>{timeAgo(Math.max(0, now - at))}</span></> : null}</span>
                </li>;
              })}
            </ol>}
        {nextBefore ? <button type="button" className={SMALL_BUTTON} disabled={busy} onClick={() => void load(filter, nextBefore)}>Load older</button> : null}
      </> : null}
    </section>
  );
}
