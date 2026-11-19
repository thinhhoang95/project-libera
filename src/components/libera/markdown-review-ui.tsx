"use client";

import { useId, useMemo, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { MessageSquarePlus, Check, X, Sparkles, Undo2, Redo2, Plus, ArrowLeft, ArrowUp, BookOpen, ListChecks, PencilLine, ShieldCheck, Send, Link2, Trash2, RotateCcw, Save, Search, CloudUpload, Clock, AlertTriangle, Circle, CircleCheck, CircleHelp } from "lucide-react";
import type { AgentSuggestion, ReviewQuestion, ReviewSuggestion } from "@/lib/markdown-review";
import { isSharedThread, type PendingInfo, type SharedReviewMessage, type SharedReviewThread } from "@/lib/collab/review-store/types";
import { commentAuthorLabel, initials } from "@/lib/collab/review-store/authors";
import { localCommentsSummary, migrateLocalComments } from "@/lib/collab/review-store/api";
import type { LocalCommentsSummary } from "@/lib/collab/local-api";
import type { UserSummary } from "@/lib/collab/protocol/api";
import { describeError } from "@/lib/collab/ui/client";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { MentionTextarea } from "./collab/mentions/mention-textarea";
import { reviewIntent, reviewQuestion } from "@/lib/markdown-review";
import { useMarkdownReview, type SharedReviewState } from "./markdown-review-context";
import { useClockNow } from "./review-clock";
import { useFollowReviewViewport, useReviewViewportStart } from "./review-viewport";
import { apiRequest } from "./api-client";
import { ChatFileComposer } from "./chat-file-composer";
import { ListFilterButton, ShowMoreButton, usePagedList } from "./list-controls";
import { usePaletteCommands } from "./command-palette/commands";
import { useAppMenuItems } from "./app-menu";
import type { ChatContext } from "@/lib/document-chat";
import type { OpenTab } from "./types";
import { isTextFileType, type LiberaFileNode } from "@/lib/types";

const button = "review-button";
type Translate = ReturnType<typeof useTranslations>;
const SUGGESTION_STATUSES = new Set(["pending", "accepted", "rejected", "superseded", "conflicted"]);
/** A suggestion's status in words; statuses this build does not know show as they are. */
function suggestionStatus(t: Translate, status: string) {
  return SUGGESTION_STATUSES.has(status) ? t(`suggestionStatus.${status}`) : status;
}
/** A local comment's status: an open comment whose passage was lost says so. */
function localThreadStatus(t: Translate, thread: { status: string; anchor: { state: string } }) {
  if (thread.status === "addressed") return t("threadStatus.addressed");
  if (thread.status === "open") return t("threadStatus.openAnchor", { state: thread.anchor.state === "attached" ? "attached" : thread.anchor.state === "ambiguous" ? "ambiguous" : "orphaned" });
  return thread.status === "resolved" ? t("threadStatus.resolved") : thread.status;
}
export function ReviewToggle() {
  const t = useTranslations("markdownReviewUi");
  const review = useMarkdownReview();
  if (!review) return null;
  return <button type="button" className="review-toggle inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted aria-pressed:bg-muted aria-pressed:text-accent" aria-label={t("reviewMode")} title={t("reviewMode")} aria-pressed={review.enabled} disabled={!!review.busy || !review.doc} onClick={() => void review.action("toggle", { enabled: !review.enabled })}><MessageSquarePlus size={16} /></button>;
}
/** Comment commands for the command palette and the macOS AI menu; renders nothing. */
export function ReviewPaletteCommands() {
  const t = useTranslations("markdownReviewUi");
  const review = useMarkdownReview();
  useAppMenuItems("ai", 1, () => {
    if (!review) return [];
    const addComment = () => {
      const range = review.editorSelection();
      if (range) review.select(range, window.innerWidth / 2, 160);
      else review.reportError(t("selectPassageToComment"));
    };
    return [
      ...(review.doc ? [
        { id: "review-mode", label: t("menuReviewMode"), type: "checkbox" as const, checked: review.enabled, enabled: !review.busy, onSelect: () => void review.action("toggle", { enabled: !review.enabled }) },
        { id: "add-comment", label: t("menuAddComment"), enabled: review.enabled && !review.busy, onSelect: addComment },
      ] : []),
      { id: "agentic-review", label: t("menuAgenticReview"), type: "checkbox", checked: review.chatReview, onSelect: () => review.setChatReview(!review.chatReview) },
      { id: "show-comments", label: t("menuShowComments"), onSelect: review.showComments },
    ];
  });
  usePaletteCommands(null, () => {
    if (!review?.doc) return [];
    const group = t("paletteGroupComments");
    return [
      {
        id: "review:add-comment",
        title: t("paletteAddComment"),
        group,
        icon: MessageSquarePlus,
        shortcut: "Ctrl/⌘+Alt+M",
        keywords: "review note annotate",
        disabled: !review.enabled || !!review.busy,
        run: () => {
          const range = review.editorSelection();
          if (range) review.select(range, window.innerWidth / 2, 160);
          else review.reportError(t("selectPassageToComment"));
        },
      },
      {
        id: "review:toggle-mode",
        title: review.enabled ? t("paletteTurnOffReview") : t("paletteTurnOnReview"),
        group,
        icon: MessageSquarePlus,
        keywords: "comments suggestions",
        disabled: !!review.busy,
        run: () => void review.action("toggle", { enabled: !review.enabled }),
      },
      { id: "review:show-comments", title: t("paletteOpenComments"), group, icon: MessageSquarePlus, shortcut: "Ctrl/⌘+3", run: review.showComments },
    ];
  });
  return null;
}
export function ReviewComments() {
  const t = useTranslations("markdownReviewUi");
  const r = useMarkdownReview();
  const [reply, setReply] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<CommentStatusFilter>("all");
  const selectedCard = useRef<HTMLElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    selectedCard.current?.scrollIntoView({ block: "nearest" });
  }, [r?.selectedThread]);
  // Shared documents: the cards follow the editor's scroll position, so the
  // comments beside the text are the ones about it. A selected card keeps
  // the panel where it is.
  const followScroll = !!r?.shared && !r.selectedThread && !query;
  useFollowReviewViewport(followScroll);
  const viewportStart = useReviewViewportStart();
  useEffect(() => {
    const container = list.current;
    if (!followScroll || viewportStart === undefined || !container) return;
    const cards = [...container.querySelectorAll<HTMLElement>("[data-anchor-end]")];
    const target = cards.find((card) => Number(card.dataset.anchorEnd) >= viewportStart);
    if (!target) return;
    const top = target.offsetTop - container.offsetTop - 8;
    if (Math.abs(container.scrollTop - top) > 4) container.scrollTo?.({ top: Math.max(0, top) });
  }, [followScroll, viewportStart]);
  const threads = r?.doc?.threads ?? [];
  const active = threads.find((t) => t.id === r?.selectedThread);
  // Agent suggestions keep their numbering too; only open ones are listed.
  const agentSuggestions = r?.doc?.agentSuggestions ?? [];
  const openSuggestions = agentSuggestions.map((suggestion, index) => ({ suggestion, index })).filter(({ suggestion }) => suggestion.status === "pending" || suggestion.status === "conflicted");
  const pendingSuggestions = openSuggestions.filter(({ suggestion }) => suggestion.status === "pending");
  // Comments keep their document numbering while filtered.
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  // A local review lists its newest comment first. A shared document keeps
  // document order instead, since its cards follow the editor's scroll.
  const numbered = threads.map((thread, index) => ({ thread, index }));
  const shown = (r?.shared ? numbered : numbered.reverse()).filter(({ thread, index }) => {
    if (!matchesCommentStatus(thread.status, status)) return false;
    if (!terms.length) return true;
    const haystack = [t("commentNumber", { number: index + 1 }), localThreadStatus(t, thread), thread.messages[0]?.author === "agent" ? t("agentLabel") : thread.messages[0]?.author ?? "", thread.anchor.quote, ...thread.messages.map((m) => m.text), ...(isSharedThread(thread) ? [thread.shared.detached ? t("threadStatus.detached") : "", ...thread.messages.map((m) => m.shared.author.displayName)] : [])].join("\n").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  // Suggested edits are always open: a decided one leaves the list.
  const shownSuggestions = status === "resolved" ? [] : openSuggestions.filter(({ suggestion, index }) => {
    if (!terms.length) return true;
    const haystack = [t("editNumber", { number: index + 1 }), t("agentLabel"), suggestionStatus(t, suggestion.status), suggestion.title, suggestion.reason, ...suggestion.edits.flatMap((edit) => [edit.before, edit.after])].join("\n").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  // One page across both: suggested edits first, then the comments. The
  // selected comment, and the one beside the editor's viewport, stay rendered.
  const items = [...shownSuggestions.map((entry) => ({ kind: "suggestion" as const, ...entry })), ...shown.map((entry) => ({ kind: "thread" as const, ...entry }))];
  const pinThread = active ?? (followScroll && viewportStart !== undefined ? shown.find(({ thread }) => thread.anchor.state === "attached" && thread.anchor.end >= viewportStart)?.thread : undefined);
  const pinIndex = pinThread ? items.findIndex((item) => item.kind === "thread" && item.thread.id === pinThread.id) : -1;
  const page = usePagedList(items, `${r?.doc?.id ?? ""}|${status}|${query.trim()}`, pinIndex);
  const pageSuggestions = page.visible.flatMap((item) => item.kind === "suggestion" ? [item] : []);
  const pageThreads = page.visible.flatMap((item) => item.kind === "thread" ? [item] : []);
  if (!r) return null;
  const openThreads = threads.filter((t) => t.status === "open").length;
  return <section className="review-comments flex min-h-0 flex-1 flex-col" aria-label={t("sectionLabel")}>
    <header className="shrink-0 space-y-3 px-3 pb-3 pt-4">
      {/* The open count drops out first when the panel is too narrow for it. */}
      <div className="libera-notebook-heading @container flex items-center gap-1">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t("commentsHeading")}</h2>
        <span className="mr-1 hidden whitespace-nowrap @[17rem]:inline text-xs tabular-nums text-muted-foreground">{t("openCount", { count: openThreads })}{openSuggestions.length > 0 && <span className="review-agent-suggestion-count" title={t("suggestedCountTitle")}> {t("suggestedCount", { count: openSuggestions.length })}</span>}</span>
        {r.doc && <CommentStatusFilterButton value={status} onChange={setStatus} open={openThreads + openSuggestions.length} resolved={threads.length - openThreads} all={threads.length + openSuggestions.length} />}
        <button type="button" className="libera-sidebar-icon-button inline-flex h-[29px] w-[29px] shrink-0 items-center justify-center rounded-lg disabled:opacity-40" aria-label={t("undoAcceptance")} title={t("undoAcceptance")} disabled={!!r.busy || !r.doc?.undo.length} onClick={() => void r.action("undo")}><Undo2 aria-hidden size={14} /></button>
        <button type="button" className="libera-sidebar-icon-button inline-flex h-[29px] w-[29px] shrink-0 items-center justify-center rounded-lg disabled:opacity-40" aria-label={t("redoAcceptance")} title={t("redoAcceptance")} disabled={!!r.busy || !r.doc?.redo?.length} onClick={() => void r.action("redo")}><Redo2 aria-hidden size={14} /></button>
      </div>
      <button type="button" className="libera-panel-button h-9 w-full" aria-pressed={r.chatReview} title={r.chatReview ? t("returnToChat") : t("planAddressingComments")} onClick={() => r.setChatReview(!r.chatReview)}><Sparkles size={14} /> <span className="libera-btn-label">{t("agenticReview")}</span></button>
      {r.doc && <>
        {(threads.length > 0 || openSuggestions.length > 0) && <div className="review-comment-search relative">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input type="search" aria-label={t("searchComments")} placeholder={t("searchCommentsPlaceholder")} className="libera-panel-field libera-panel-field--search w-full" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); } }} />
          {query && <button type="button" className="libera-sidebar-icon-button absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md" aria-label={t("clearSearch")} title={t("clearSearch")} onClick={() => setQuery("")}><X aria-hidden size={12} /></button>}
        </div>}
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">{r.enabled ? t("selectPassageHint") : t("enableReviewHint")}</p>
      </>}
      {r.shared && <SharedCommentsNotices shared={r.shared} />}
    </header>
    <div ref={list} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-4">
    {r.error && <p role="alert" className="mt-2 text-sm text-destructive">{r.error} <button className={button} onClick={() => void r.reload()}>{t("reloadReview")}</button></p>}
    {r.recovery && <div className="libera-panel-card space-y-2 p-3 text-sm"><p>{t("recoveryMessage")}</p><div className="flex gap-2"><button className={button} onClick={r.restore}>{t("restoreDraft")}</button><button className={button} onClick={() => void r.action("sync")}>{t("keepCurrentText")}</button></div></div>}
      {!r.doc ? <p className="rounded-lg border border-dashed border-input px-4 py-8 text-center text-sm text-muted-foreground">{t("openDocumentForComments")}</p> : !threads.length && !openSuggestions.length ? <p className="rounded-lg border border-dashed border-input px-4 py-8 text-center text-sm text-muted-foreground">{t("noCommentsYet")}</p> : !shown.length && !shownSuggestions.length && <p className="rounded-lg border border-dashed border-input px-4 py-3 text-sm text-muted-foreground">{query.trim() ? t("noCommentsMatch", { status, query: query.trim() }) : t("noStatusComments", { status })}</p>}
      {pageSuggestions.length > 0 && <section className="space-y-2" aria-label={t("suggestedEdits")}>
        {pendingSuggestions.length > 1 && <div className="flex flex-wrap items-center gap-1">
          <span className="min-w-0 flex-1 text-xs font-semibold">{t("suggestedEdits")}</span>
          <button type="button" className={button} disabled={!!r.busy || r.recovery} onClick={() => void r.action("agent-decision", { ids: pendingSuggestions.map(({ suggestion }) => suggestion.id), decision: "accept" })}><Check size={14} /> {t("acceptAll")}</button>
          <button type="button" className={button} disabled={!!r.busy} onClick={() => void r.action("agent-decision", { ids: pendingSuggestions.map(({ suggestion }) => suggestion.id), decision: "reject" })}><X size={14} /> {t("rejectAll")}</button>
        </div>}
        {pageSuggestions.map(({ suggestion, index }) => <AgentSuggestionCard key={suggestion.id} suggestion={suggestion} number={index + 1} />)}
      </section>}
      {pageThreads.map(({ thread, index }) => isSharedThread(thread) && r.shared ? <SharedThreadCard key={thread.id} thread={thread} index={index} shared={r.shared} selected={active?.id === thread.id} cardRef={active?.id === thread.id ? selectedCard : undefined} reply={reply} setReply={setReply} mentions={mentions} setMentions={setMentions} editing={editing} setEditing={setEditing} /> : <article key={thread.id} ref={active?.id === thread.id ? selectedCard : undefined} data-selected={active?.id === thread.id} className="review-comment-card libera-panel-card p-3 text-[13px] transition" aria-label={t("commentCardLabel", { number: index + 1 })}>
        <button className="w-full text-left" aria-expanded={active?.id === thread.id} onClick={() => { r.selectThread(active?.id === thread.id ? null : thread.id); setReply(""); setEditing(null); if (thread.anchor.state === "attached") r.focus(thread.anchor); }}>
          <span className="flex flex-wrap items-center justify-between gap-1"><span className="flex items-center gap-1.5"><strong className="text-xs font-semibold">{t("commentNumber", { number: index + 1 })}</strong>{thread.messages[0]?.author === "agent" && <span className="review-comment-author inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground" title={t("agentCommentTitle")}><Sparkles aria-hidden size={10} /> {t("agentLabel")}</span>}</span><CommentStatusLabel open={thread.status === "open"}>{localThreadStatus(t, thread)}</CommentStatusLabel></span>
          <span className="my-2 line-clamp-3 text-xs italic text-muted-foreground">{thread.anchor.quote}</span>
          {active?.id !== thread.id && thread.messages[0] && <CommentBody text={thread.messages[0].text} preview />}
          {active?.id !== thread.id && thread.messages.length > 1 && <span className="mt-2 block text-xs text-muted-foreground">{t("repliesCount", { count: thread.messages.length - 1 })}</span>}
        </button>
        {active?.id === thread.id && <div className="mt-2 space-y-2">
          {thread.messages.map((m, i) => <div key={m.id} className="space-y-1"><CommentBody text={m.text} /><button type="button" className="review-comment-icon review-comment-pen" data-tone="blue" aria-label={i === 0 ? t("editComment") : t("editReply")} title={i === 0 ? t("editComment") : t("editReply")} disabled={!!r.busy} onClick={() => { setEditing(m.id); setReply(m.text); }}><PencilLine aria-hidden size={16} /></button></div>)}
          <textarea aria-label={editing ? t("editComment") : t("replyToComment")} className="review-textarea" placeholder={editing ? t("editPlaceholder") : t("replyPlaceholder")} rows={2} value={reply} onChange={(e) => setReply(e.target.value)} />
          <div className="review-comment-actions"><button type="button" className="review-comment-icon" data-tone="blue" aria-label={editing ? t("saveComment") : t("reply")} title={editing ? t("saveComment") : t("reply")} disabled={!reply.trim() || !!r.busy} onClick={async () => { if (await r.action(editing ? "edit" : "reply", { threadId: thread.id, messageId: editing, text: reply })) { setReply(""); setEditing(null); } }}>{editing ? <Save aria-hidden size={16} /> : <Send aria-hidden size={16} />}</button>
          <button type="button" className="review-comment-icon" data-tone="green" aria-label={thread.status === "open" ? t("resolve") : t("reopen")} title={thread.status === "open" ? t("resolve") : t("reopen")} disabled={!!r.busy} onClick={() => void r.action("resolve", { threadId: thread.id, resolved: thread.status === "open" })}>{thread.status === "open" ? <Check aria-hidden size={16} /> : <RotateCcw aria-hidden size={16} />}</button>
          <button type="button" className="review-comment-icon" data-tone="violet" aria-label={t("reattachToSelection")} title={t("reattachToSelection")} disabled={!!r.busy || !r.selection} onClick={() => void r.action("reattach", { threadId: thread.id, range: r.selection?.range })}><Link2 aria-hidden size={16} /></button>
          <button type="button" className="review-comment-icon review-comment-delete" data-tone="red" aria-label={t("deleteComment")} title={t("deleteComment")} disabled={!!r.busy} onClick={() => void r.action("delete", { threadId: thread.id })}><Trash2 aria-hidden size={16} /></button></div>
        </div>}
      </article>)}
      <ShowMoreButton remaining={page.remaining} onClick={page.showMore} />
    </div>
  </section>;
}

export type CommentStatusFilter = "all" | "open" | "resolved";
/** A comment card's status, led by its mark: a check once resolved or
 * completed, an empty circle while open. */
function CommentStatusLabel({ open, children }: { open: boolean; children: ReactNode }) {
  return <span className="review-comment-status inline-flex items-center gap-1 text-[11px] text-muted-foreground" data-open={open}>
    {open ? <Circle aria-hidden size={12} /> : <CircleCheck aria-hidden size={12} className="text-emerald-500" />}{children}
  </span>;
}
/** "Resolved" covers comments the agent completed (addressed) too. */
export function matchesCommentStatus(status: string, filter: CommentStatusFilter) {
  return filter === "all" || (filter === "open" ? status === "open" : status !== "open");
}
export function CommentStatusFilterButton({ value, onChange, open, resolved, all }: { value: CommentStatusFilter; onChange: (value: CommentStatusFilter) => void; open: number; resolved: number; all: number }) {
  const t = useTranslations("markdownReviewUi");
  return <ListFilterButton label={t("filterComments")} groups={[{ label: t("filterStatus"), value, defaultValue: "all", onChange: (next) => onChange(next as CommentStatusFilter), options: [
    { value: "all", label: t("allComments"), count: all },
    { value: "open", label: t("threadStatus.open"), count: open },
    { value: "resolved", label: t("threadStatus.resolved"), count: resolved },
  ] }]} />;
}
export function ReviewSuggestionCard({ suggestion, number }: { suggestion: ReviewSuggestion; number: number }) {
  const t = useTranslations("markdownReviewUi");
  const r = useMarkdownReview()!;
  const [revision, setRevision] = useState<string | null>(null);
  const pending = suggestion.status === "pending", conflicted = suggestion.status === "conflicted";
  return <article className="review-suggestion" aria-label={t("changeLabel", { number, title: suggestion.title })}>
    <div className="flex items-start gap-2"><button className="min-w-0 flex-1 text-left font-semibold" onClick={() => r.focus(suggestion.edits[0])}>{t("changeLabel", { number, title: suggestion.title })}</button><span className="text-xs">{suggestionStatus(t, suggestion.status)}</span></div>
    <div className="mt-1 text-muted-foreground"><ReviewMarkdown text={suggestion.reason} small /></div>
    {r.shared && <p className="mt-1 text-xs text-muted-foreground">{t("sharedSuggestionNote")}</p>}
    {suggestion.edits.length > 1 && <p className="mt-1 text-xs font-semibold">{t("linkedChanges")}</p>}
    {suggestion.edits.map((edit, index) => <div key={index} className="review-diff"><div aria-label={t("originalText")}><span className="review-diff-label">{t("original")}</span><pre>{edit.before}</pre></div><div aria-label={t("proposedText")}><span className="review-diff-label">{t("proposed")}</span><pre>{edit.after || t("deletePassage")}</pre></div></div>)}
    <p className="text-xs text-muted-foreground">{t("commentsList", { list: suggestion.commentIds.map((id) => (r.doc?.threads.findIndex((thread) => thread.id === id) ?? -1) + 1).join(", ") })}</p>
    <div className="mt-2 flex flex-wrap gap-1">
      {pending && <><button className={button} disabled={!!r.busy || r.recovery} onClick={() => void r.action("decision", { ids: [suggestion.id], decision: "accept" })}><Check size={14} /> {t("accept")}</button><button className={button} disabled={!!r.busy} onClick={() => void r.action("decision", { ids: [suggestion.id], decision: "reject" })}><X size={14} /> {t("reject")}</button></>}
      {conflicted && <button className={button} disabled={!!r.busy} onClick={() => void r.action("decision", { ids: [suggestion.id], decision: "reject" })}>{t("reject")}</button>}
      {(pending || conflicted) && <button className={button} disabled={!!r.busy} onClick={() => setRevision(revision === null ? "" : null)}>{t("requestRevision")}</button>}
      {suggestion.status === "rejected" && !r.shared && <button className={button} disabled={!!r.busy} onClick={() => void r.action("decision", { ids: [suggestion.id], decision: "reopen" })}>{t("reopenChange")}</button>}
    </div>
    {revision !== null && <form className="mt-2" onSubmit={async (e) => { e.preventDefault(); if (await r.generate("revise", revision, undefined, undefined, suggestion.id)) setRevision(null); }}><textarea aria-label={t("reviseChangeLabel", { number })} className="review-textarea" value={revision} onChange={(e) => setRevision(e.target.value)} /><button className={button} disabled={!revision.trim() || !!r.busy}>{t("reviseThisChange")}</button></form>}
  </article>;
}
// The popover's buttons keep focus where it is (the comment box, or the
// editor before composing): a mousedown that moves focus makes the editor
// blur and resync, and the click must land on the same button it started on.
const keepFocus = (event: { preventDefault(): void }) => event.preventDefault();

/** A suggested edit the agent left (SuggestEdit), decided outside any Agentic Review session. */
export function AgentSuggestionCard({ suggestion, number }: { suggestion: AgentSuggestion; number: number }) {
  const t = useTranslations("markdownReviewUi");
  const r = useMarkdownReview()!;
  const [revision, setRevision] = useState<string | null>(null);
  const pending = suggestion.status === "pending", conflicted = suggestion.status === "conflicted";
  const comments = suggestion.commentIds.map((id) => (r.doc?.threads.findIndex((t) => t.id === id) ?? -1) + 1).filter((n) => n > 0);
  return <article className="review-suggestion review-agent-suggestion libera-panel-card p-3 text-[13px]" aria-label={t("suggestedEditLabel", { number, title: suggestion.title })} data-status={suggestion.status}>
    <div className="flex items-start gap-2">
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { if (suggestion.anchors[0]?.state === "attached") r.focus(suggestion.edits[0]); }}>
        <span className="flex flex-wrap items-center gap-1.5"><strong className="text-xs font-semibold">{t("editNumber", { number })}</strong><span className="review-comment-author inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground" title={t("suggestedByAgent")}><Sparkles aria-hidden size={10} /> {t("agentLabel")}</span></span>
        <span className="mt-1 block font-semibold">{suggestion.title}</span>
      </button>
      <span className="text-[11px] text-muted-foreground">{conflicted ? t("textChanged") : suggestionStatus(t, suggestion.status)}</span>
    </div>
    {suggestion.reason && suggestion.reason !== suggestion.title && <p className="mt-1 text-xs text-muted-foreground">{suggestion.reason}</p>}
    {suggestion.edits.map((edit, index) => <div key={index} className="review-diff"><div aria-label={t("originalText")}><span className="review-diff-label">{t("original")}</span><pre>{edit.before}</pre></div><div aria-label={t("proposedText")}><span className="review-diff-label">{t("proposed")}</span><pre>{edit.after || t("deletePassage")}</pre></div></div>)}
    {conflicted && <p className="text-xs text-muted-foreground">{t("passageChangedSinceSuggestion")}</p>}
    {comments.length > 0 && <p className="text-xs text-muted-foreground">{t("commentsPlural", { count: comments.length, list: comments.join(", ") })}</p>}
    <div className="mt-2 flex flex-wrap gap-1">
      {pending && <button type="button" className={button} disabled={!!r.busy || r.recovery} onClick={() => void r.action("agent-decision", { ids: [suggestion.id], decision: "accept" })}><Check size={14} /> {t("accept")}</button>}
      <button type="button" className={button} disabled={!!r.busy} onClick={() => void r.action("agent-decision", { ids: [suggestion.id], decision: "reject" })}><X size={14} /> {t("reject")}</button>
      <button type="button" className={button} disabled={!!r.busy || suggestion.anchors.every((anchor) => anchor.state !== "attached")} onClick={() => setRevision(revision === null ? "" : null)}>{t("requestRevision")}</button>
    </div>
    {revision !== null && <form className="mt-2" onSubmit={async (e) => { e.preventDefault(); if (await r.action("agent-revision", { suggestionId: suggestion.id, text: revision })) setRevision(null); }}>
      <textarea aria-label={t("revisionLabel", { number })} className="review-textarea" placeholder={t("revisionPlaceholder")} value={revision} onChange={(e) => setRevision(e.target.value)} />
      <button type="submit" className={button} disabled={!revision.trim() || !!r.busy}>{t("sendRevisionRequest")}</button>
    </form>}
  </article>;
}
export function ReviewPopover() {
  const t = useTranslations("markdownReviewUi");
  const r = useMarkdownReview();
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [composing, setComposing] = useState(false);
  if (!r?.enabled || !r.selection || !r.doc) return null;
  const { range, x, y } = r.selection;
  const overlaps = (a: { start: number; end: number }) => a.start < range.end && a.end > range.start;
  const suggestions = r.doc.session?.suggestions ?? [];
  const visible = suggestions.filter((s) => ["pending", "conflicted"].includes(s.status) && s.edits.some(overlaps));
  const threads = r.doc.threads.filter((t) => t.anchor.state === "attached" && overlaps(t.anchor));
  const agentSuggestions = r.doc.agentSuggestions ?? [];
  const agentVisible = agentSuggestions.filter((s) => (s.status === "pending" || s.status === "conflicted") && s.edits.some(overlaps));
  return <div className="review-popover" role="dialog" aria-label={t("passageReview")} onKeyDown={(e) => { if (e.key === "Escape") { r.clearSelection(); setComposing(false); setText(""); } }} style={{ left: Math.max(8, Math.min(x, (typeof window === "undefined" ? 1000 : window.innerWidth) - 376)), top: Math.max(8, Math.min(y + 8, (typeof window === "undefined" ? 800 : window.innerHeight) - 320)) }}>
    <div className="flex items-center gap-2"><strong className="flex-1 text-sm">{t("passageReview")}</strong><button className={button} aria-label={t("closePassageReview")} onClick={() => { r.clearSelection(); setComposing(false); setText(""); }}><X size={14} /></button></div>
    <blockquote className="my-2 max-h-20 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{r.doc.snapshot.slice(range.start, range.end)}</blockquote>
    {threads.map((thread) => <button key={thread.id} className="my-1 block w-full rounded bg-muted p-2 text-left text-sm" onClick={() => { r.selectThread(thread.id); r.clearSelection(); }}>{thread.messages[0]?.text} <span className="text-xs text-muted-foreground">· {t("messageCount", { count: thread.messages.length })}</span></button>)}
    {visible.map((s) => <ReviewSuggestionCard key={s.id} suggestion={s} number={suggestions.indexOf(s) + 1} />)}
    {agentVisible.map((s) => <AgentSuggestionCard key={s.id} suggestion={s} number={agentSuggestions.indexOf(s) + 1} />)}
    {composing ? <form className="flex flex-col gap-2" onSubmit={async (e) => { e.preventDefault(); if (await r.action("comment", { range, text, ...(r.shared ? { mentions } : {}) })) { setText(""); setMentions([]); setComposing(false); r.clearSelection(); } }}>{r.shared ? <MentionTextarea autoFocus aria-label={t("newReviewComment")} className="review-textarea" projectId={r.shared.projectId} selfId={r.shared.projection.me?.id} value={text} onChange={setText} onMentionsChange={setMentions} placeholder={t("commentPlaceholder")} /> : <textarea autoFocus aria-label={t("newReviewComment")} className="review-textarea" value={text} onChange={(e) => setText(e.target.value)} />}<button className={`${button} self-start`} disabled={!text.trim() || !!r.busy} onMouseDown={keepFocus}><MessageSquarePlus size={14} /> {t("addComment")}</button></form> : <button className={button} disabled={!!r.busy} onMouseDown={keepFocus} onClick={() => setComposing(true)}><MessageSquarePlus size={14} /> {t("addComment")}</button>}
  </div>;
}
export function ReviewChatPanel({ files, readOpenTabs }: { files: LiberaFileNode[]; /** The open tabs with their text as of now, read when a file is attached. */ readOpenTabs: () => readonly OpenTab[] }) {
  const t = useTranslations("markdownReviewUi");
  const referenceFiles = useMemo(() => files.filter((file) => isTextFileType(file.fileType)), [files]);
  const r = useMarkdownReview()!;
  const [prompt, setPrompt] = useState("");
  const [references, setReferences] = useState<ChatContext[]>(r.doc?.session?.references ?? []);
  const [excluded, setExcluded] = useState<string[]>(() => r.doc?.session ? r.doc.threads.filter((t) => !r.doc!.session!.selectedIds.includes(t.id)).map((t) => t.id) : []);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const doc = r.doc, session = doc?.session;
  useEffect(() => { if (doc?.round) input.current?.focus(); }, [doc?.round]);
  const [recoverable, setRecoverable] = useState<{ id: string; key: string; snapshot: string; commentCount: number }[]>([]);
  useEffect(() => {
    if (doc) return;
    let active = true;
    void apiRequest<typeof recoverable>("/api/markdown-reviews?drafts=1").then((rows) => { if (active && Array.isArray(rows)) setRecoverable(rows); }).catch(() => { if (active) setError(t("couldNotLoadDrafts")); });
    return () => { active = false; };
  }, [doc, t]);
  const suggestions = session?.suggestions ?? [];
  const pending = suggestions.filter((s) => s.status === "pending");
  // A shared document's threads come from the collab server; the plan
  // addresses them by id like local comments.
  const selectedIds = doc?.threads.filter((t) => t.status === "open" && !excluded.includes(t.id)).map((t) => t.id) ?? [];
  const plannedReplies = session?.plan.dispositions.filter((d) => d.reply).length ?? 0;
  const contextChanged = !!session && (JSON.stringify(references) !== JSON.stringify(session.references) || JSON.stringify([...selectedIds].sort()) !== JSON.stringify([...session.selectedIds].sort()));
  async function send() {
    setError("");
    const intent = reviewIntent(prompt);
    let okay = false;
    if (intent.action === "confirm") {
      if (contextChanged) { setError(t("selectionChangedRefresh")); return; }
      const version = prompt.match(/\bplan\s+(\d+)/i)?.[1];
      if (version && Number(version) !== session?.plan.version) { setError(t("confirmLatestPlan")); return; }
      okay = await r.generate("generate", prompt);
    } else if (intent.action === "accept" || intent.action === "reject") {
      const selected = intent.numbers === "all" ? pending : intent.numbers.map((n) => suggestions[n - 1]);
      if (!selected.length || selected.some((s) => !s || s.status !== "pending")) { setError(t("choosePendingNumbers")); return; }
      okay = await r.action("decision", { ids: selected.map((s) => s.id), decision: intent.action });
    } else okay = await r.generate("plan", prompt, selectedIds, references);
    if (okay) setPrompt("");
  }
  return <aside id="document-chat-panel" aria-label={t("agenticReviewPanel")} className="libera-glass-panel libera-chat-panel flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-border bg-card">
    <header className="libera-chat-header libera-window-drag-region flex shrink-0 items-center gap-2 px-3">
      <span className="libera-ai-mark" aria-hidden><Sparkles size={22} /></span>
      <strong className="min-w-0 flex-1 text-sm">{t("agenticReview")}</strong>
      <button type="button" className="libera-sidebar-icon-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full disabled:opacity-40" aria-label={t("newReviewRound")} title={t("newReviewRound")} disabled={!doc || !!r.busy || attachmentBusy || r.recovery} onClick={() => void r.action("new-round")}><Plus aria-hidden size={16} /></button>
      <button type="button" className="libera-sidebar-icon-button libera-window-no-drag inline-flex h-8 w-8 shrink-0 items-center justify-center" aria-label={t("returnToAiChat")} title={t("returnToAiChat")} onClick={() => r.setChatReview(false)}><ArrowLeft aria-hidden size={17} /></button>
    </header>
    <div className={`libera-chat-log min-h-0 flex-1 space-y-3 overflow-auto p-3 wrap-anywhere ${!session ? "flex flex-col" : ""}`}>
      {!session && <div className="libera-chat-welcome libera-review-welcome">
        <span className="libera-ai-orb" aria-hidden><PencilLine size={30} strokeWidth={1.5} /></span>
        <h2>{t.rich("welcomeHeading", { line: (chunks) => <span className="block">{chunks}</span> })}</h2>
        <p>{doc ? t("welcomeWithDocument") : t("welcomeWithoutDocument")}</p>
        {doc ? <div className="libera-chat-starters">
          {[
            { icon: PencilLine, label: t("starterClarity"), prompt: "Review this draft for clarity. Suggest ways to make the writing easier to follow while preserving its meaning." },
            { icon: ListChecks, label: t("starterStructure"), prompt: "Review the structure and flow of this draft. Plan improvements to the organization and transitions." },
            { icon: ShieldCheck, label: selectedIds.length ? t("starterWorkComments") : t("starterConsistency"), prompt: selectedIds.length ? "Plan how to address the selected review comments while preserving the intent of the draft." : "Review this draft for inconsistent terminology, gaps in the explanation, and unsupported claims. Plan targeted improvements." },
          ].map(({icon: Icon, label, prompt: starter}) => <button key={label} type="button" disabled={!!r.busy || attachmentBusy || r.recovery} onClick={() => { setPrompt(starter); input.current?.focus(); }}><Icon aria-hidden size={16} /><span>{label}</span><ArrowUp aria-hidden size={13} /></button>)}
        </div> : <div className="libera-review-intro"><BookOpen aria-hidden size={18} /><span>{t("sharedSafeHint")}</span></div>}
        <p className="libera-chat-context-hint">{t("startWithPlan")}</p>
        {doc && <p className="libera-chat-context-hint">{t("typeAtForReference")}</p>}
      </div>}

      {!doc ? <>{recoverable.length > 0 && <section className="space-y-2"><strong className="text-sm">{t("recoverUnsaved")}</strong>{recoverable.map((draft) => <button key={draft.id} className="review-button w-full flex-col items-start text-left" onClick={() => r.recoverDraft(draft.key, draft.snapshot)}><span className="line-clamp-2">{draft.snapshot.slice(0, 120) || t("untitledReview")}</span><span>{t("draftCommentCount", { count: draft.commentCount })}</span></button>)}</section>}</> : <>
      {session && <p className="break-all text-xs text-muted-foreground">{t("reviewingLine", { key: doc.key, round: doc.round ?? 1 })}</p>}
      {(session || doc.threads.some((thread) => thread.status === "open")) && <details className="libera-review-comment-picker" open={!session}><summary className="cursor-pointer text-sm">{t("commentsToAddress", { count: selectedIds.length })}</summary>{doc.threads.filter((t) => t.status === "open").map((t) => <label key={t.id} className="mt-2 flex gap-2 text-sm"><input type="checkbox" checked={!excluded.includes(t.id)} onChange={(e) => setExcluded(e.target.checked ? excluded.filter((id) => id !== t.id) : [...excluded, t.id])} />{t.messages[0]?.text}</label>)}</details>}
      {!!doc.previousRounds?.length && <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">{t("previousRounds", { count: doc.previousRounds.length })}</summary>
        {doc.previousRounds.map((round) => <details key={round.session.id} className="mt-2 rounded-lg border border-border p-2 text-xs">
          <summary className="cursor-pointer">{t("roundSummary", { number: round.number, summary: round.session.plan.summary })}</summary>
          <p className="mt-2 text-muted-foreground">{t("archivedNote")}</p>
          <ol className="my-2 list-decimal space-y-1 pl-4">{round.session.plan.steps.map((step, i) => <li key={i}>{step.proposedChange}</li>)}</ol>
          {round.session.messages.map((m, i) => <div key={i} className="my-2"><strong>{m.role === "user" ? t("you") : t("assistant")}</strong><ReviewMarkdown text={m.text} small /></div>)}
          {round.session.suggestions.filter((s) => s.status !== "superseded").map((s) => <div key={s.id} className="mt-2"><strong>{s.title}</strong><span className="ml-1 text-muted-foreground">· {s.status === "pending" || s.status === "conflicted" ? t("notApplied") : suggestionStatus(t, s.status)}</span>{s.edits.map((edit, i) => <div key={i} className="review-diff"><div><span className="review-diff-label">{t("original")}</span><pre>{edit.before}</pre></div><div><span className="review-diff-label">{t("proposed")}</span><pre>{edit.after || t("deletePassage")}</pre></div></div>)}</div>)}
        </details>)}
      </details>}
      {session && <>
        <details><summary className="cursor-pointer text-sm">{t("reviewConversation")}</summary>{session.messages.map((m, i) => <div key={i} className="my-2 text-sm"><strong>{m.role === "user" ? t("you") : t("assistant")}</strong><ReviewMarkdown text={m.text} /></div>)}</details>
        <section className="rounded-lg border border-border p-3 text-sm">
          <strong>{t("planVersion", { version: session.plan.version })}</strong>
          <div className="mt-2"><ReviewMarkdown text={session.plan.summary} /></div>
          <ol className="my-2 list-decimal space-y-2 pl-5">{session.plan.steps.map((step, i) => <li key={i}><ReviewMarkdown text={step.proposedChange} /><div className="mt-0.5 text-muted-foreground"><ReviewMarkdown text={step.rationale} small /></div></li>)}</ol>
          {!!session.plan.dispositions.length && <><p className="mt-2 text-xs font-medium">{t("noEditNeeded")}</p><ul className="mt-1 list-disc space-y-1 pl-5 text-xs">{session.plan.dispositions.map((d) => <li key={d.commentId}><ReviewMarkdown text={d.reason} small />{d.reply && <div className="mt-1 text-muted-foreground"><span className="font-medium">{session.replies?.some((reply) => reply.commentId === d.commentId) ? t("repliedLabel") : t("replyLabel")}</span><ReviewMarkdown text={d.reply} small /></div>}</li>)}</ul></>}
          {session.plan.revisionSummary && <div className="mt-2"><ReviewMarkdown text={session.plan.revisionSummary} small /></div>}
        </section>
        {!!session.plan.blockingQuestions.length && <ReviewQuestions key={`${session.id}-${session.plan.version}`} questions={session.plan.blockingQuestions.map(reviewQuestion)} disabled={!!r.busy || attachmentBusy || r.recovery} onAnswer={(text) => r.generate("plan", text, selectedIds, references)} />}
        {session.messages.at(-1)?.role === "assistant" && session.confirmedVersion && <ReviewMarkdown text={session.messages.at(-1)!.text} />}
        {session.phase === "stale" && <p role="status" className="text-sm text-destructive">{t("documentOrCommentsChanged")}</p>}
        {session.phase === "awaiting_confirmation" && contextChanged && <p className="text-sm">{t("commentsOrReferencesChanged")}</p>}
        {session.phase === "awaiting_confirmation" && plannedReplies > 0 && <p className="text-xs text-muted-foreground">{t("confirmingPosts", { count: plannedReplies, shared: r.shared ? "yes" : "no" })}</p>}
        {session.phase === "awaiting_confirmation" && <button className={button} disabled={!!r.busy || !!session.plan.blockingQuestions.length || r.recovery || contextChanged} onClick={() => void r.generate("generate", "Confirm the current plan and generate changes.")}>{session.plan.steps.length ? t("confirmAndGenerate") : t("confirmNoEdits")}</button>}
        {!!suggestions.length && <><p className="text-xs">{t("suggestionTally", { pending: pending.length, conflicted: suggestions.filter((s) => s.status === "conflicted").length, accepted: suggestions.filter((s) => s.status === "accepted").length, rejected: suggestions.filter((s) => s.status === "rejected").length })}</p><div className="flex flex-wrap gap-1"><button className={button} disabled={!pending.length || !!r.busy || r.recovery} onClick={() => void r.action("decision", { ids: pending.map((s) => s.id), decision: "accept" })}>{t("acceptAllRemaining")}</button><button className={button} disabled={!pending.length || !!r.busy} onClick={() => void r.action("decision", { ids: pending.map((s) => s.id), decision: "reject" })}>{t("rejectAllRemaining")}</button><button className={button} disabled={!doc.undo.length || !!r.busy} onClick={() => void r.action("undo")}>{t("undoAcceptance")}</button></div></>}
        {suggestions.map((s, i) => s.status !== "superseded" && <ReviewSuggestionCard key={s.id} suggestion={s} number={i + 1} />)}
        {session.phase === "completed" && <p className="text-sm">{t("reviewComplete")}</p>}
      </>}
      </>}
      {(r.error || error) && <p role="alert" className="text-sm text-destructive">{r.error || error} <button className={button} onClick={() => void r.reload()}>{t("reloadReview")}</button></p>}
      {!!r.busy && <p role="status" className="flex flex-wrap items-center gap-2 text-sm"><span className="libera-chat-thinking text-muted-foreground">{r.busy === "plan" ? t("planning") : ["generate", "revise"].includes(r.busy) ? t("generatingChanges") : t("savingReview")}</span>{["plan", "generate", "revise"].includes(r.busy) && <button className={button} onClick={r.stop}>{t("stop")}</button>}</p>}
    </div>
    <form className="libera-chat-form shrink-0 space-y-2 p-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      {doc && <div className="libera-chat-context flex items-center gap-2"><BookOpen aria-hidden size={13} className="shrink-0" /><p className="min-w-0 truncate" title={doc.key}>{t("keyRound", { name: doc.key.split("/").at(-1) ?? doc.key, round: doc.round ?? 1 })}</p></div>}
      {references.map((ref) => <div key={ref.path} className="flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate" title={ref.path}>@{ref.name}</span><button type="button" className={button} aria-label={t("removeReference", { name: ref.name })} onClick={() => setReferences(references.filter((r) => r.path !== ref.path))}>×</button></div>)}
      <div className="libera-chat-composer">
      <ChatFileComposer placeholder={doc ? session ? t("composerFollowUp") : t("composerStart") : t("composerNoDocument")} chatId={`review-${doc?.id}-${doc?.round ?? 1}`} value={prompt} disabled={!doc || !!r.busy} files={referenceFiles} composerRef={input} onChange={setPrompt} onSend={() => void send()} onAttachFile={async (file) => {
        setAttachmentBusy(true);
        setError("");
        try {
          const tab = readOpenTabs().find((item) => !item.untitled && item.file.path === file.path);
          const existing = references.find((ref) => ref.path === file.path);
          const payload = existing || tab ? null : await apiRequest<{ content?: string }>(`/api/files?path=${encodeURIComponent(file.path)}`);
          const text = existing?.text ?? tab?.draft ?? payload?.content;
          if (typeof text !== "string") throw new Error(t("couldNotReadFile", { name: file.name }));
          if (text.length > 500_000) throw new Error(t("fileTooLarge", { name: file.name }));
          setReferences((current) => [...current.filter((ref) => ref.path !== file.path), { kind: "document", path: file.path, name: file.name, text }]);
          return true;
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : t("couldNotAttach"));
          return false;
        } finally {
          setAttachmentBusy(false);
        }
      }} />
      <div className="libera-chat-composer-actions flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{session ? t("continueReview") : t("planReview")}</span>
        <button type="submit" className="libera-chat-send inline-flex h-8 w-8 shrink-0 items-center justify-center disabled:opacity-40" aria-label={session ? t("sendReviewRequest") : t("planReview")} title={session ? t("sendReviewRequest") : t("planReview")} disabled={!doc || !!r.busy || attachmentBusy || (!prompt.trim() && !selectedIds.length)}><ArrowUp aria-hidden size={18} /></button>
      </div>
      </div>
      <p className="libera-chat-key-hint">{t("keyHint")}</p>
    </form>
  </aside>;
}

/**
 * The review model's own text (plan, reasons, conversation) as Markdown, like
 * AI chat. A shared document's review drew on collaborators' words, so it
 * gets the shared trust policy.
 */
function ReviewMarkdown({ text, small = false }: { text: string; small?: boolean }) {
  const shared = !!useMarkdownReview()?.shared;
  return <MarkdownRenderer content={text} baseFontSize={small ? 12 : 13.5} baseLineHeight={1.5} renderImages={false} contentTrust={shared ? "shared" : "local"} className="libera-chat-markdown review-comment-body min-w-0 wrap-anywhere" />;
}

/** The plan's blocking questions, answered by choice or in the user's own words, then sent as one follow-up. */
function ReviewQuestions({ questions, disabled, onAnswer }: { questions: ReviewQuestion[]; disabled: boolean; onAnswer: (text: string) => Promise<boolean> }) {
  const t = useTranslations("markdownReviewUi");
  const groupId = useId();
  // A question without choices (from a plan saved before they existed) opens on "Other".
  const [choices, setChoices] = useState<(number | "other" | null)[]>(() => questions.map((q) => q.options.length ? null : "other"));
  const [other, setOther] = useState<string[]>(() => questions.map(() => ""));
  const answers = questions.map((q, i) => { const c = choices[i]; return c === "other" ? other[i].trim() : c === null ? "" : q.options[c] ?? ""; });
  const ready = answers.every(Boolean);
  const choose = (i: number, choice: number | "other") => setChoices((current) => current.map((c, j) => j === i ? choice : c));
  async function submit() {
    if (!ready || disabled) return;
    const text = "Answers to the plan's questions:\n\n" + questions.map((q, i) => `${i + 1}. ${q.question}\n\n   **Answer:** ${answers[i]}`).join("\n\n");
    await onAnswer(text);
  }
  return <section className="review-questions" aria-label={questions.length === 1 ? t("questionsLabel") : t("questionsLabelPlural")}>
    <p className="review-questions-heading"><CircleHelp aria-hidden size={15} />{questions.length === 1 ? t("oneQuestionHeading") : t("questionsHeading", { count: questions.length })}</p>
    {questions.map((q, i) => <div key={i} className="review-question">
      <div id={`${groupId}-${i}`} className="review-question-text">{questions.length > 1 && <span className="review-question-number" aria-hidden>{i + 1}</span>}<ReviewMarkdown text={q.question} /></div>
      <div role="radiogroup" aria-labelledby={`${groupId}-${i}`} className="review-question-options">
        {q.options.map((option, j) => <label key={j} className="review-question-option" data-selected={choices[i] === j || undefined}>
          <input type="radio" name={`${groupId}-${i}`} checked={choices[i] === j} disabled={disabled} onChange={() => choose(i, j)} />
          <ReviewMarkdown text={option} />
        </label>)}
        <label className="review-question-option" data-selected={choices[i] === "other" || undefined}>
          <input type="radio" name={`${groupId}-${i}`} checked={choices[i] === "other"} disabled={disabled} onChange={() => choose(i, "other")} />
          <span>{t("otherOption")}</span>
        </label>
        {choices[i] === "other" && <textarea aria-label={t("yourAnswerLabel", { number: i + 1 })} className="review-textarea review-question-other" rows={2} placeholder={t("writeAnswer")} value={other[i]} disabled={disabled} autoFocus={q.options.length > 0}
          onChange={(e) => { const value = e.target.value; setOther((current) => current.map((v, j) => j === i ? value : v)); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }} />}
      </div>
    </div>)}
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{ready ? t("planRevisedWithAnswers") : questions.length === 1 ? t("pickAnAnswer") : t("answeredCount", { answered: answers.filter(Boolean).length, total: questions.length })}</span>
      <button type="button" className={button} disabled={!ready || disabled} onClick={() => void submit()}><Send aria-hidden size={14} /> {questions.length === 1 ? t("sendAnswer") : t("sendAnswers")}</button>
    </div>
  </section>;
}

// ---- Shared documents (plan M2.1–M2.3, M2.6): authors, pending chips,
// detached anchors and the one-time move of local comments.

/** The time, refreshed every minute, for "5 min ago" labels. */
/**
 * A comment or reply as Markdown with KaTeX math. `preview` clamps it for a
 * collapsed card, whose toggle button takes the clicks instead of its links.
 */
export function CommentBody({ text, preview = false, shared = false }: { text: string; preview?: boolean; shared?: boolean }) {
  return <MarkdownRenderer content={text} baseFontSize={13} baseLineHeight={1.5} renderImages={false} contentTrust={shared ? "shared" : "local"} className={`review-comment-body min-w-0 wrap-anywhere${preview ? " review-comment-preview" : ""}`} />;
}

/** The current time from the one shared minute clock; with `times` it re-renders only when one of their relative labels changes. */
export const useNow = useClockNow;

function AuthorAvatar({ user, ai }: { user: UserSummary; ai?: boolean }) {
  return <span aria-hidden className="review-comment-avatar inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white" style={{ background: user.color || "#64748b" }}>{ai ? <Sparkles size={10} /> : initials(user.displayName)}</span>;
}

/** `compact` (the card header, inside an `@container`) drops the name and
 * keeps just the avatar once the header is too narrow to fit it on one line. */
function AuthorLine({ message, now, compact }: { message: SharedReviewMessage; now: number; compact?: boolean }) {
  const t = useTranslations("markdownReviewUi");
  const format = useFormatter();
  const { author, actor, editedAt } = message.shared;
  const label = commentAuthorLabel(actor, author);
  const created = Date.parse(message.createdAt);
  return <span className="review-comment-author flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11px]" data-author-id={author.id} title={compact ? label : undefined}>
    <AuthorAvatar user={author} ai={actor?.kind === "ai"} />
    <span className={`min-w-0 truncate font-semibold${compact ? " hidden @[15rem]:inline" : ""}`} style={{ color: author.color || undefined }} title={label}>{label}</span>
    {Number.isFinite(created) && <span className="shrink-0 text-muted-foreground" title={format.dateTime(new Date(created), { dateStyle: "medium", timeStyle: "short" })}>{format.relativeTime(Math.min(created, now), now)}</span>}
    {editedAt && !message.shared.deleted && <span className="shrink-0 text-muted-foreground">{t("edited")}</span>}
  </span>;
}

export function PendingChip({ pending, onRetry, onDiscard }: { pending: PendingInfo; onRetry: () => void; onDiscard: () => void }) {
  const t = useTranslations("markdownReviewUi");
  if (pending.state === "failed") {
    return <div role="alert" className="review-comment-failed mt-2 flex flex-wrap items-center gap-1.5 rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
      <AlertTriangle aria-hidden size={12} /><span className="min-w-0 flex-1">{t("notSent", { reason: pending.error ?? t("serverRefused") })}</span>
      <button type="button" className={button} onClick={onRetry}>{t("retry")}</button>
      <button type="button" className={button} onClick={onDiscard}>{t("discard")}</button>
    </div>;
  }
  return <span className="review-comment-pending mt-1 inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground" data-state={pending.state} title={pending.state === "queued" ? t("pendingQueuedTitle") : t("pendingSendingTitle")}>
    <Clock aria-hidden size={10} /> {pending.state === "queued" ? t("pendingQueuedLabel") : t("pendingSendingLabel")}
  </span>;
}

function SharedMessageView({ message, first, now, busy, onEdit, onDelete, onRetry, onDiscard }: { message: SharedReviewMessage; first: boolean; now: number; busy: boolean; onEdit: () => void; onDelete: () => void; onRetry: (commandId: string) => void; onDiscard: (commandId: string) => void }) {
  const t = useTranslations("markdownReviewUi");
  const info = message.shared;
  return <div className="review-comment-message space-y-1" data-message-id={message.id} data-pending={info.pending?.state ?? undefined}>
    <div className="flex items-center gap-1">
      <AuthorLine message={message} now={now} />
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        {info.canEdit && <button type="button" className="review-comment-icon" data-tone="blue" aria-label={first ? t("editComment") : t("editReply")} title={first ? t("editComment") : t("editReply")} disabled={busy} onClick={onEdit}><PencilLine aria-hidden size={14} /></button>}
        {info.canDelete && !first && <button type="button" className="review-comment-icon review-comment-delete" data-tone="red" aria-label={t("deleteReplyLabel")} title={t("deleteReplyLabel")} disabled={busy} onClick={onDelete}><Trash2 aria-hidden size={14} /></button>}
      </span>
    </div>
    {info.deleted ? <p className="text-xs italic text-muted-foreground">{t("messageDeleted")}</p> : <CommentBody text={message.text} shared />}
    {info.pending && <PendingChip pending={info.pending} onRetry={() => onRetry(info.pending!.commandId)} onDiscard={() => onDiscard(info.pending!.commandId)} />}
  </div>;
}

function SharedThreadCard({ thread, index, shared, selected, cardRef, reply, setReply, mentions, setMentions, editing, setEditing }: {
  thread: SharedReviewThread; index: number; shared: SharedReviewState; selected: boolean; cardRef?: RefObject<HTMLElement | null>;
  reply: string; setReply: (value: string) => void; mentions: string[]; setMentions: (ids: string[]) => void; editing: string | null; setEditing: (id: string | null) => void;
}) {
  const t = useTranslations("markdownReviewUi");
  const r = useMarkdownReview()!;
  const times = useMemo(() => thread.messages.map((message) => Date.parse(message.createdAt)).filter(Number.isFinite), [thread.messages]);
  const now = useNow(times);
  const info = thread.shared;
  const first = thread.messages[0];
  const me = shared.projection.me;
  const canComment = !!me && shared.projection.role !== "viewer";
  const deletedText = info.detached && info.detachReason === "deleted";
  const candidates = selected && info.detached && info.canManage ? shared.reattachCandidates(thread.id) : [];
  const retry = (commandId: string) => void r.action("retry", { commandId });
  const discard = (commandId: string) => void r.action("discard", { commandId });
  const status = info.status === "resolved" ? "resolved" : info.detached ? "detached" : "open";
  return <article ref={cardRef} data-anchor-end={thread.anchor.state === "attached" ? thread.anchor.end : undefined} data-selected={selected} data-detached={info.detached} data-thread-id={thread.id} className="review-comment-card libera-panel-card p-3 text-[13px] transition" aria-label={t("commentCardLabel", { number: index + 1 })}>
    <button className="w-full text-left" aria-expanded={selected} onClick={() => { r.selectThread(selected ? null : thread.id); setReply(""); setMentions([]); setEditing(null); if (thread.anchor.state === "attached") r.focus(thread.anchor); }}>
      <span className="@container flex flex-wrap items-center justify-between gap-1"><span className="flex min-w-0 items-center gap-1.5"><strong className="shrink-0 whitespace-nowrap text-xs font-semibold">{t("commentNumber", { number: index + 1 })}</strong>{first && <AuthorLine message={first} now={now} compact />}</span><CommentStatusLabel open={status !== "resolved"}>{t(`threadStatus.${status}`)}</CommentStatusLabel></span>
      <span className="my-2 line-clamp-3 text-xs italic text-muted-foreground">{thread.anchor.quote}</span>
      {!selected && (first?.shared.deleted ? <span className="block text-xs italic text-muted-foreground">{t("deletedFirstMessage")}</span> : first && <CommentBody text={first.text} preview shared />)}
      {!selected && thread.messages.length > 1 && <span className="mt-2 block text-xs text-muted-foreground">{t("repliesCount", { count: thread.messages.length - 1 })}</span>}
    </button>
    {info.pending && <PendingChip pending={info.pending} onRetry={() => retry(info.pending!.commandId)} onDiscard={() => discard(info.pending!.commandId)} />}
    {!selected && !info.pending && first?.shared.pending && <PendingChip pending={first.shared.pending} onRetry={() => retry(first.shared.pending!.commandId)} onDiscard={() => discard(first.shared.pending!.commandId)} />}
    {info.detached && <div className="review-comment-detached mt-2 space-y-1.5 rounded-md border border-dashed border-input p-2 text-xs" role="note">
      <p>{deletedText ? t("detachedDeletedText") : info.detachReason === "missing" ? t("detachedMissingText") : t("detachedNotFoundText")}</p>
      {info.canManage && <button type="button" className={button} disabled={!r.selection} title={r.selection ? t("reattachHereTitle") : t("selectPassageFirstTitle")} onClick={() => void r.action("reattach", { threadId: thread.id, range: r.selection?.range })}><Link2 aria-hidden size={14} /> {t("reattachButton")}</button>}
      {candidates.length > 0 && <div className="space-y-1">
        <p className="text-muted-foreground">{t("foundSimilarText")}</p>
        {candidates.map((candidate) => <button key={`${candidate.start}:${candidate.end}`} type="button" className="review-button w-full flex-col items-start text-left" onClick={() => void r.action("reattach", { threadId: thread.id, range: { start: candidate.start, end: candidate.end } })}>
          <span className="line-clamp-2 italic">{shared.projection.text.slice(candidate.start, candidate.end)}</span><span>{t("attachHere")}</span>
        </button>)}
      </div>}
    </div>}
    {selected && <div className="mt-2 space-y-3">
      {thread.messages.map((m, i) => <SharedMessageView key={m.id} message={m} first={i === 0} now={now} busy={!!r.busy} onEdit={() => { setEditing(m.id); setReply(m.text); }} onDelete={() => void r.action("delete-message", { messageId: m.id })} onRetry={retry} onDiscard={discard} />)}
      {canComment && <>
        <MentionTextarea aria-label={editing ? t("editComment") : t("replyToComment")} className="review-textarea" placeholder={editing ? t("editFieldPlaceholder") : t("replyFieldPlaceholder")} rows={2} projectId={shared.projectId} selfId={me?.id} value={reply} onChange={setReply} onMentionsChange={setMentions} />
        <div className="review-comment-actions">
          <button type="button" className="review-comment-icon" data-tone="blue" aria-label={editing ? t("saveComment") : t("reply")} title={editing ? t("saveComment") : t("reply")} disabled={!reply.trim() || !!r.busy} onClick={async () => { if (await r.action(editing ? "edit" : "reply", { threadId: thread.id, messageId: editing, text: reply, mentions })) { setReply(""); setMentions([]); setEditing(null); } }}>{editing ? <Save aria-hidden size={16} /> : <Send aria-hidden size={16} />}</button>
          {info.canManage && <button type="button" className="review-comment-icon" data-tone="green" aria-label={thread.status === "open" ? t("resolve") : t("reopen")} title={thread.status === "open" ? t("resolve") : t("reopen")} disabled={!!r.busy} onClick={() => void r.action("resolve", { threadId: thread.id, resolved: thread.status === "open" })}>{thread.status === "open" ? <Check aria-hidden size={16} /> : <RotateCcw aria-hidden size={16} />}</button>}
          {info.canManage && !info.detached && <button type="button" className="review-comment-icon" data-tone="violet" aria-label={t("reattachToSelection")} title={t("reattachToSelection")} disabled={!!r.busy || !r.selection} onClick={() => void r.action("reattach", { threadId: thread.id, range: r.selection?.range })}><Link2 aria-hidden size={16} /></button>}
          {info.canManage && <button type="button" className="review-comment-icon review-comment-delete" data-tone="red" aria-label={t("deleteComment")} title={t("deleteComment")} disabled={!!r.busy} onClick={() => void r.action("delete", { threadId: thread.id })}><Trash2 aria-hidden size={16} /></button>}
        </div>
      </>}
    </div>}
  </article>;
}

const migrationSummaries = new Map<string, Promise<LocalCommentsSummary>>();

/** Load errors, and for the owner the one-time move of comments made before sharing. */
function SharedCommentsNotices({ shared }: { shared: SharedReviewState }) {
  const t = useTranslations("markdownReviewUi");
  const r = useMarkdownReview()!;
  const { projection, projectId } = shared;
  const owner = projection.role === "owner";
  const [summary, setSummary] = useState<{ projectId: string; value: LocalCommentsSummary } | null>(null);
  const [moving, setMoving] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!owner) return;
    let live = true;
    let request = migrationSummaries.get(projectId);
    if (!request) {
      request = localCommentsSummary(projectId);
      migrationSummaries.set(projectId, request);
      request.catch(() => migrationSummaries.delete(projectId));
    }
    request.then((value) => { if (live) setSummary({ projectId, value }); }, () => undefined);
    return () => { live = false; };
  }, [owner, projectId]);
  const local = summary?.projectId === projectId ? summary.value : null;
  async function move() {
    setMoving(true);
    setMessage("");
    try {
      const result = await migrateLocalComments(projectId);
      migrationSummaries.delete(projectId);
      setSummary({ projectId, value: { documents: 0, threads: 0 } });
      setMessage(result.detached ? t("movedCommentsDetached", { count: result.threads, detached: result.detached }) : t("movedComments", { count: result.threads }));
      await r.reload();
    } catch (cause) {
      setMessage(describeError(cause));
    } finally {
      setMoving(false);
    }
  }
  return <>
    {projection.error && !projection.loaded && <p role="alert" className="px-1 text-xs text-destructive">{t("sharedLoadError", { error: projection.error })} <button className={button} onClick={() => void r.reload()}>{t("retry")}</button></p>}
    {owner && local && local.threads > 0 && <div className="libera-panel-card space-y-2 p-3 text-xs">
      <p>{t("localCommentsBeforeShare", { count: local.threads })}</p>
      <button type="button" className={button} disabled={moving} onClick={() => void move()}><CloudUpload aria-hidden size={14} /> {moving ? t("movingLabel") : t("moveCommentsButton")}</button>
    </div>}
    {message && <p role="status" className="px-1 text-xs text-muted-foreground">{message}</p>}
  </>;
}
