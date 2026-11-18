"use client";

// "Activity log" in a shared notebook's sharing dialog (plan M3.6), for
// owners: the project's audit log from the server, newest first and paged,
// with who did it (AI labelled with the person it acted for), what, on what,
// and when, filterable by kind of action.

import { LoaderCircle, ScrollText } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuditEntry, Member } from "@/lib/collab/local-api";
import type { Actor } from "@/lib/collab/protocol/actor";
import { createReviewsApi, type ReviewsApi } from "@/lib/collab/client/reviews";
import { useDescribeError } from "@/lib/collab/ui/use-describe-error";
import { timeAgo } from "@/lib/collab/ui/wording";
import { dateTimeFormat } from "@/lib/i18n/format";

const SMALL_BUTTON = "inline-flex items-center justify-center gap-1 rounded-md border border-input px-2 py-1 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Filter choices (labels are the `filters.*` messages): an action, or a prefix of actions ("review" is every review action). */
export const AUDIT_FILTERS: { value: string; key: string }[] = [
  { value: "", key: "all" },
  { value: "suggestion", key: "suggestion" },
  { value: "suggestions.decide-all", key: "decideAll" },
  { value: "review", key: "review" },
  { value: "document.restore", key: "restore" },
  { value: "member", key: "member" },
  { value: "invitation", key: "invitation" },
  { value: "document", key: "document" },
  { value: "project", key: "project" },
];

const ACTION_KEYS: Record<string, string> = {
  "suggestion.decide": "suggestionDecide",
  "suggestion.revert": "suggestionRevert",
  "suggestions.decide-all": "suggestionsDecideAll",
  "review.request": "reviewRequest",
  "review.decide": "reviewDecide",
  "review.close": "reviewClose",
  "document.restore": "documentRestore",
  "document.delete": "documentDelete",
  "member.role": "memberRole",
  "invitation.create": "invitationCreate",
  "invitation.accept": "invitationAccept",
  "invitation.revoke": "invitationRevoke",
  "project.create": "projectCreate",
  "project.rename": "projectRename",
  "project.delete": "projectDelete",
};

/** `t`: the `collab.activityLog` messages. */
export function auditActionLabel(action: string, t: Translate): string {
  const key = ACTION_KEYS[action];
  return key ? t(`actions.${key}`) : action;
}

/** "Ada", "AI · requested by Ada", or "Libera" for system actions. `t`: the `collab.activityLog` messages. */
export function auditActorLabel(actor: Actor | null, names: ReadonlyMap<string, string>, t: Translate): string {
  if (!actor) return t("actors.system");
  if (actor.kind === "user") return names.get(actor.userId) ?? t("actors.formerMember");
  if (actor.kind === "ai") return t("actors.ai", { name: names.get(actor.onBehalfOf) ?? t("actors.aFormerMember") });
  return actor.onBehalfOf ? t("actors.systemFor", { name: names.get(actor.onBehalfOf) ?? t("actors.aFormerMember") }) : t("actors.system");
}

/** A short line from an entry's details: the decision, outcome or role. */
function detailLine(entry: AuditEntry, names: ReadonlyMap<string, string>, t: Translate): string {
  const details = entry.details ?? {};
  const parts: string[] = [];
  for (const key of ["decision", "outcome", "role", "status"] as const) {
    const value = details[key];
    if (typeof value === "string") parts.push(t("detailValue", { key: value.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase()), raw: value.replace(/-/g, " ") }));
  }
  if (typeof details.count === "number") parts.push(t("suggestionCount", { count: details.count }));
  const target = names.get(entry.target);
  return [target ? t("forTarget", { name: target }) : entry.target ? entry.target : "", ...parts].filter(Boolean).join(" · ");
}

export function ActivityLogSection({ projectId, members, api }: { projectId: string; members: Member[] | null; api?: ReviewsApi }) {
  const t = useTranslations("collab.activityLog");
  const tWording = useTranslations("lib.collab.ui.wording");
  const describeError = useDescribeError();
  const locale = useLocale();
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
  }, [client, projectId, describeError]);
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
        <h3 className="flex-1 text-sm font-medium" id="collab-activity-log"><ScrollText aria-hidden className="mr-1 inline h-3.5 w-3.5" />{t("title")}</h3>
        <button type="button" className={SMALL_BUTTON} aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? t("hide") : t("show")}</button>
      </div>
      {open ? <>
        <p className="text-xs text-muted-foreground">{t("intro")}</p>
        <select aria-label={t("filter")} className="h-8 w-full rounded-md border border-input bg-card px-2 text-xs" value={filter} onChange={(event) => { setEntries(null); setFilter(event.target.value); }}>
          {AUDIT_FILTERS.map((option) => <option key={option.value} value={option.value}>{t(`filters.${option.key}`)}</option>)}
        </select>
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        {entries === null ? <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status"><LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />{t("loading")}</p>
          : !entries.length ? <p className="text-xs text-muted-foreground">{t("empty")}</p>
            : <ol className="max-h-72 divide-y divide-border overflow-auto" aria-label={t("list")}>
              {entries.map((entry) => {
                const at = Date.parse(entry.at);
                return <li key={entry.id} className="py-1.5 text-xs" data-action={entry.action} data-actor-kind={entry.actor?.kind ?? "system"}>
                  <span className="font-medium">{auditActorLabel(entry.actor, names, t)}</span> {auditActionLabel(entry.action, t)}
                  <span className="block text-[11px] text-muted-foreground">{detailLine(entry, names, t)}{Number.isFinite(at) ? <>{detailLine(entry, names, t) ? " · " : ""}<span title={dateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(at)}>{timeAgo(Math.max(0, now - at), tWording)}</span></> : null}</span>
                </li>;
              })}
            </ol>}
        {nextBefore ? <button type="button" className={SMALL_BUTTON} disabled={busy} onClick={() => void load(filter, nextBefore)}>{t("loadOlder")}</button> : null}
      </> : null}
    </section>
  );
}
