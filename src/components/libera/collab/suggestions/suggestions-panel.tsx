"use client";

// The Suggestions panel of a shared document (plan M3.1, M3.3): pending,
// stale and decided suggestions, filterable by author (AI included), with
// linked suggestions grouped and decided together. Editors accept and
// reject (one at a time, or all with a checkpoint); authors withdraw or edit
// their own; anyone who can comment replies (a comment thread on the
// suggestion's range, linked to it). Arrow keys (or j and k) step
// through the list and show each suggestion in the editor.

import { Bot, Check, ChevronDown, ChevronUp, Loader2, MessageSquare, Pencil, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { SharedDocSession } from "@/lib/collab/client/registry";
import type { SuggestionGroupView, SuggestionsController } from "@/lib/collab/client/suggestions";
import { ListFilterButton, ShowMoreButton, usePagedList } from "../../list-controls";
import { MentionTextarea } from "../mentions/mention-textarea";
import { useSuggestions } from "./use-suggestions";

export type SuggestionAuthorFilter = "all" | "ai" | `user:${string}`;
export type SuggestionStatusFilter = "all" | "open" | "decided";

export interface SuggestionsPanelProps {
  session: SharedDocSession;
  /** Initial author filter (tests, deep links). */
  initialFilter?: SuggestionAuthorFilter;
}

// The same buttons, fields and cards as the Comments tab (markdown-review-ui.tsx).
const buttonClass = "review-button";
const iconButtonClass = "libera-sidebar-icon-button inline-flex h-[29px] w-[29px] shrink-0 items-center justify-center rounded-lg disabled:opacity-40";

/** Groups that pass the author filter. */
export function filterSuggestionGroups(groups: readonly SuggestionGroupView[], filter: SuggestionAuthorFilter): SuggestionGroupView[] {
  if (filter === "all") return [...groups];
  if (filter === "ai") return groups.filter((group) => group.isAi);
  const userId = filter.slice("user:".length);
  return groups.filter((group) => group.createdBy === userId);
}

function statusLabel(group: SuggestionGroupView): string {
  if (group.pending) {
    const verb = group.pending.decision === "accept" ? "Accepting…" : "Rejecting…";
    return group.pending.phase === "queued" ? `${verb} (offline, sends when connected)` : verb;
  }
  if (group.state === "stale") return group.items.some((item) => item.resolved.staleReason === "target-removed") ? "Stale · text removed" : "Stale · text changed";
  if (group.state === "pending") return "Pending";
  switch (group.status) {
    case "accepted": return group.decidedBy ? `Accepted by ${group.decidedBy.name}` : "Accepted";
    case "rejected": return group.decidedBy ? `Rejected by ${group.decidedBy.name}` : "Rejected";
    case "withdrawn": return "Withdrawn";
    default: return group.status;
  }
}

function quote(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
}

/** The Reply box of a suggestion: a comment thread on its range, linked to it. */
function ReplyBox({ group, controller, projectId, selfId }: { group: SuggestionGroupView; controller: SuggestionsController; projectId: string; selfId: string | null }) {
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="mt-1.5 space-y-1"
      aria-label="Reply to this suggestion"
      onClick={(event) => event.stopPropagation()}
      onSubmit={async (event) => {
        event.preventDefault();
        setSending(true);
        setError("");
        const result = await controller.sendReply(group.id, text, mentions);
        setSending(false);
        if (result.ok) setText("");
        else setError(result.message);
      }}
    >
      <MentionTextarea autoFocus aria-label="Reply to this suggestion" rows={2} className="review-textarea" projectId={projectId} selfId={selfId} value={text} onChange={setText} onMentionsChange={setMentions} placeholder="Reply… Type @ to mention someone" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); controller.cancelReply(); } }} />
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-1">
        <button type="submit" className={buttonClass} disabled={!text.trim() || sending}>{sending ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : null}Send reply</button>
        <button type="button" className={buttonClass} onClick={() => controller.cancelReply()}>Cancel</button>
      </div>
    </form>
  );
}

function SuggestionCard({ group, controller, selected, onSelect, replying, projectId, selfId }: { group: SuggestionGroupView; controller: SuggestionsController; selected: boolean; onSelect: () => void; replying: boolean; projectId: string; selfId: string | null }) {
  const [editing, setEditing] = useState<string | null>(null);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  const single = group.items.length === 1 ? group.items[0] : null;
  return (
    <li
      ref={ref}
      role="option"
      aria-selected={selected}
      data-suggestion-group={group.id}
      data-state={group.state}
      data-selected={selected}
      className="libera-suggestion-card review-comment-card libera-panel-card cursor-pointer p-3 text-[13px] transition"
      onClick={onSelect}
    >
      <div className="flex items-center gap-1.5 text-xs">
        {group.isAi ? <Bot aria-hidden className="h-3.5 w-3.5 shrink-0" style={{ color: group.author.color }} /> : <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: group.author.color }} />}
        <span className="min-w-0 truncate font-medium" data-testid="suggestion-author">{group.label}</span>
        {group.items.length > 1 ? <span className="shrink-0 text-muted-foreground">· {group.items.length} linked changes</span> : null}
        <span className="ml-auto shrink-0 text-muted-foreground" data-testid="suggestion-status">
          {group.pending ? <Loader2 aria-hidden className="mr-1 inline h-3 w-3 animate-spin" /> : null}
          {statusLabel(group)}
        </span>
      </div>
      {group.items[0].record.title || group.items[0].record.reason ? (
        <p className="mt-1 text-xs text-muted-foreground">{group.items[0].record.title}{group.items[0].record.reason ? ` — ${group.items[0].record.reason}` : ""}</p>
      ) : null}
      <ul className="mt-1 space-y-1">
        {group.items.map((item) => (
          <li key={item.id} className="text-xs leading-5" data-suggestion-id={item.id}>
            {item.record.baseQuote ? <del className="rounded-sm bg-red-500/10 px-0.5 text-red-700 dark:text-red-300">{quote(item.record.baseQuote)}</del> : null}
            {item.record.baseQuote && item.record.replacement ? " → " : null}
            {item.record.replacement ? <ins className="rounded-sm bg-green-500/15 px-0.5 text-green-800 no-underline dark:text-green-300">{quote(item.record.replacement)}</ins> : item.record.baseQuote ? <span className="text-muted-foreground"> (delete)</span> : null}
            {item.resolved.isStale && item.status !== "accepted" && item.status !== "rejected" && item.status !== "withdrawn" ? (
              <span className="mt-0.5 block text-amber-700 dark:text-amber-300" data-testid="suggestion-stale">
                {item.resolved.staleReason === "target-removed" ? "The text it was made for was deleted." : <>Now: <q>{quote(item.resolved.currentText) || "(empty)"}</q></>}
              </span>
            ) : null}
            {item.outcome ? <span className="mt-0.5 block text-muted-foreground" role="status" data-outcome={item.outcome.kind}>{item.outcome.message}</span> : null}
          </li>
        ))}
      </ul>
      {editing !== null && single ? (
        <form className="mt-1.5 flex items-start gap-1.5" onSubmit={(event) => { event.preventDefault(); controller.edit(single.id, editing); setEditing(null); }}>
          <textarea aria-label="Edit your suggestion" rows={2} className="review-textarea min-w-0 flex-1" value={editing} onChange={(event) => setEditing(event.target.value)} />
          <button type="submit" className={buttonClass}>Save</button>
          <button type="button" className={buttonClass} onClick={() => setEditing(null)}>Cancel</button>
        </form>
      ) : null}
      <div className="mt-1.5 flex flex-wrap gap-1" onClick={(event) => event.stopPropagation()}>
        {group.canAccept ? <button type="button" className={`${buttonClass} text-green-700 dark:text-green-300`} data-action="accept" onClick={() => { controller.decide(group.items.map((item) => item.id), "accept"); }}><Check aria-hidden className="h-3.5 w-3.5" />Accept</button> : null}
        {group.canReject ? <button type="button" className={`${buttonClass} text-red-700 dark:text-red-300`} data-action="reject" onClick={() => { controller.decide(group.items.map((item) => item.id), "reject"); }}><X aria-hidden className="h-3.5 w-3.5" />Reject</button> : null}
        {group.canEdit && single && editing === null ? <button type="button" className={buttonClass} data-action="edit" onClick={() => setEditing(single.record.replacement)}><Pencil aria-hidden className="h-3.5 w-3.5" />Edit</button> : null}
        {group.canWithdraw ? <button type="button" className={buttonClass} data-action="withdraw" onClick={() => controller.withdraw(group.id)}>Withdraw</button> : null}
        {group.canRevert ? <button type="button" className={buttonClass} data-action="revert" onClick={() => { void controller.revert(group.id); }}><Undo2 aria-hidden className="h-3.5 w-3.5" />Undo acceptance</button> : null}
        {group.state !== "decided" && !replying ? <button type="button" className={buttonClass} data-action="reply" onClick={() => controller.reply(group.id)}><MessageSquare aria-hidden className="h-3.5 w-3.5" />Reply</button> : null}
      </div>
      {replying ? <ReplyBox group={group} controller={controller} projectId={projectId} selfId={selfId} /> : null}
    </li>
  );
}

export function SuggestionsPanel({ session, initialFilter = "all" }: SuggestionsPanelProps) {
  const { controller, snapshot } = useSuggestions(session);
  const [filter, setFilter] = useState<SuggestionAuthorFilter>(initialFilter);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<SuggestionStatusFilter>("all");

  const groups = useMemo(() => snapshot?.groups ?? [], [snapshot]);
  const decidedCount = groups.filter((group) => group.state === "decided").length;
  // The server mirror says who decided what; refresh it when decisions land.
  useEffect(() => {
    if (controller) void controller.loadHistory();
  }, [controller, decidedCount]);

  const authors = useMemo(() => {
    const seen = new Map<string, { name: string; color: string }>();
    for (const group of groups) if (!seen.has(group.createdBy)) seen.set(group.createdBy, group.author);
    return [...seen.entries()];
  }, [groups]);
  const byAuthor = useMemo(() => filterSuggestionGroups(groups, filter), [groups, filter]);
  const visible = useMemo(() => byAuthor.filter((group) => status === "all" || (status === "decided") === (group.state === "decided")), [byAuthor, status]);
  const live = visible.filter((group) => group.state !== "decided");
  const selectedIndex = visible.findIndex((group) => group.id === selectedId);
  // Stepping with the keys past the first page keeps the selected card rendered.
  const page = usePagedList(visible, `${filter}|${status}`, selectedIndex);

  if (!controller || !snapshot) return null;

  const step = (delta: number) => {
    if (!visible.length) return;
    // From nothing selected, Next starts at the first and Previous at the last; both wrap.
    const from = selectedIndex < 0 ? (delta > 0 ? -1 : visible.length) : selectedIndex;
    const next = visible[(from + delta + visible.length) % visible.length];
    setSelectedId(next.id);
    if (next.state !== "decided") controller.reveal(next.id);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Typing in a field (editing a suggestion) keeps its keys.
    const tag = (event.target as Element).tagName;
    if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
    if (event.key === "ArrowDown" || event.key === "j") { event.preventDefault(); step(1); }
    else if (event.key === "ArrowUp" || event.key === "k") { event.preventDefault(); step(-1); }
    else if (event.key === "Enter" && selectedId) { event.preventDefault(); controller.reveal(selectedId); }
  };
  const pendingCount = groups.filter((group) => group.state === "pending" && !group.pending).length;
  const liveCount = groups.filter((group) => group.state !== "decided" && !group.pending).length;

  return (
    <section className="libera-suggestions-panel flex min-h-0 flex-1 flex-col" aria-label="Suggestions" data-doc={snapshot.docId}>
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2">
        <ListFilterButton label="Filter suggestions" groups={[
          { label: "Status", value: status, defaultValue: "all", onChange: (value) => setStatus(value as SuggestionStatusFilter), options: [
            { value: "all", label: "All suggestions", count: byAuthor.length },
            { value: "open", label: "Open", count: byAuthor.filter((group) => group.state !== "decided").length },
            { value: "decided", label: "Decided", count: byAuthor.filter((group) => group.state === "decided").length },
          ] },
          { label: "Author", value: filter, defaultValue: "all", onChange: (value) => setFilter(value as SuggestionAuthorFilter), options: [
            { value: "all", label: "Everyone" },
            { value: "ai", label: "AI suggestions" },
            ...authors.map(([id, author]) => ({ value: `user:${id}`, label: id === snapshot.localUserId ? `${author.name} (you)` : author.name })),
          ] },
        ]} />
        <button type="button" className={iconButtonClass} aria-label="Previous suggestion" title="Previous suggestion (↑ or k)" onClick={() => step(-1)}><ChevronUp aria-hidden className="h-3.5 w-3.5" /></button>
        <button type="button" className={iconButtonClass} aria-label="Next suggestion" title="Next suggestion (↓ or j)" onClick={() => step(1)}><ChevronDown aria-hidden className="h-3.5 w-3.5" /></button>
        {snapshot.canDecide ? (
          <span className="ml-auto flex gap-1">
            <button type="button" className={buttonClass} data-action="accept-all" disabled={!pendingCount} title="Accept every pending suggestion (a checkpoint is saved first; stale ones are skipped)" onClick={() => { controller.acceptAll(); }}>Accept all</button>
            <button type="button" className={buttonClass} data-action="reject-all" disabled={!liveCount} onClick={() => { controller.rejectAll(); }}>Reject all</button>
          </span>
        ) : null}
      </div>
      <ul role="listbox" tabIndex={0} aria-label="Suggestions in this document" className="min-h-0 flex-1 space-y-2 overflow-auto px-3 pb-4 pt-3 outline-none" onKeyDown={onKeyDown}>
        {visible.length === 0 ? (
          <li className="rounded-lg border border-dashed border-input px-4 py-8 text-center text-sm text-muted-foreground">{groups.length ? "No suggestions match this filter." : snapshot.canSuggest ? "No suggestions yet. Turn on Suggesting, or use Suggest edit on a selection." : "No suggestions yet."}</li>
        ) : page.visible.map((group) => (
          <SuggestionCard key={group.id} group={group} controller={controller} selected={group.id === selectedId} replying={snapshot.replyingTo === group.id} projectId={session.resolved.projectId} selfId={snapshot.localUserId} onSelect={() => { setSelectedId(group.id); if (group.state !== "decided") controller.reveal(group.id); }} />
        ))}
        {page.remaining > 0 ? <li role="presentation"><ShowMoreButton remaining={page.remaining} onClick={page.showMore} /></li> : null}
      </ul>
      <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground" aria-live="polite">
        {live.length} open{snapshot.history ? ` · ${snapshot.history.filter((info) => info.status === "accepted" || info.status === "rejected").length} decided on the server` : snapshot.historyError ? " · history unavailable offline" : ""}
      </p>
    </section>
  );
}
