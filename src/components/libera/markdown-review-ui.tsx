"use client";

import { useMemo, useEffect, useRef, useState, type RefObject } from "react";
import { MessageSquarePlus, Check, X, Sparkles, Undo2, Redo2, Plus, ArrowLeft, ArrowUp, BookOpen, ListChecks, PencilLine, ShieldCheck, Send, Link2, Trash2, RotateCcw, Save, Search, CloudUpload, Clock, AlertTriangle } from "lucide-react";
import type { AgentSuggestion, ReviewSuggestion } from "@/lib/markdown-review";
import { isSharedThread, type PendingInfo, type SharedReviewMessage, type SharedReviewThread } from "@/lib/collab/review-store/types";
import { commentAuthorLabel, initials } from "@/lib/collab/review-store/authors";
import { localCommentsSummary, migrateLocalComments } from "@/lib/collab/review-store/api";
import type { LocalCommentsSummary } from "@/lib/collab/local-api";
import type { UserSummary } from "@/lib/collab/protocol/api";
import { describeError } from "@/lib/collab/ui/client";
import { timeAgo } from "@/lib/collab/ui/wording";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { MentionTextarea } from "./collab/mentions/mention-textarea";
import { reviewIntent } from "@/lib/markdown-review";
import { useMarkdownReview, type SharedReviewState } from "./markdown-review-context";
import { apiRequest } from "./api-client";
import { ChatFileComposer } from "./chat-file-composer";
import { usePaletteCommands } from "./command-palette/commands";
import type { ChatContext } from "@/lib/document-chat";
import type { OpenTab } from "./types";
import type { LiberaFileNode } from "@/lib/types";

const button = "review-button";
export function ReviewToggle() {
  const review = useMarkdownReview();
  if (!review) return null;
  return <button type="button" className="review-toggle inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted aria-pressed:bg-muted aria-pressed:text-accent" aria-label="Review mode" title="Review mode" aria-pressed={review.enabled} disabled={!!review.busy || !review.doc} onClick={() => void review.action("toggle", { enabled: !review.enabled })}><MessageSquarePlus size={16} /></button>;
}
/** Comment commands for the command palette; renders nothing. */
export function ReviewPaletteCommands() {
  const review = useMarkdownReview();
  usePaletteCommands(null, () => {
    if (!review?.doc) return [];
    const group = "Comments";
    return [
      {
        id: "review:add-comment",
        title: "Add comment on selection",
        group,
        icon: MessageSquarePlus,
        shortcut: "Ctrl/⌘+Alt+M",
        keywords: "review note annotate",
        disabled: !review.enabled || !!review.busy,
        run: () => {
          const range = review.editorSelection();
          if (range) review.select(range, window.innerWidth / 2, 160);
          else review.reportError("Select a passage in the editor to comment on.");
        },
      },
      {
        id: "review:toggle-mode",
        title: review.enabled ? "Turn off Review mode" : "Turn on Review mode",
        group,
        icon: MessageSquarePlus,
        keywords: "comments suggestions",
        disabled: !!review.busy,
        run: () => void review.action("toggle", { enabled: !review.enabled }),
      },
      { id: "review:show-comments", title: "Open comments panel", group, icon: MessageSquarePlus, shortcut: "Ctrl/⌘+3", run: review.showComments },
    ];
  });
  return null;
}
export function ReviewComments() {
  const r = useMarkdownReview();
  const [reply, setReply] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const selectedCard = useRef<HTMLElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    selectedCard.current?.scrollIntoView({ block: "nearest" });
  }, [r?.selectedThread]);
  // Shared documents: the cards follow the editor's scroll position, so the
  // comments beside the text are the ones about it. A selected card keeps
  // the panel where it is.
  const viewportStart = r?.shared ? r.viewport?.start : undefined;
  const followScroll = !!r?.shared && !r.selectedThread && !query;
  useEffect(() => {
    const container = list.current;
    if (!followScroll || viewportStart === undefined || !container) return;
    const cards = [...container.querySelectorAll<HTMLElement>("[data-anchor-end]")];
    const target = cards.find((card) => Number(card.dataset.anchorEnd) >= viewportStart);
    if (!target) return;
    const top = target.offsetTop - container.offsetTop - 8;
    if (Math.abs(container.scrollTop - top) > 4) container.scrollTo?.({ top: Math.max(0, top) });
  }, [followScroll, viewportStart]);
  if (!r) return null;
  const threads = r.doc?.threads ?? [];
  const active = threads.find((t) => t.id === r.selectedThread);
  // Agent suggestions keep their numbering too; only open ones are listed.
  const agentSuggestions = r.doc?.agentSuggestions ?? [];
  const openSuggestions = agentSuggestions.map((suggestion, index) => ({ suggestion, index })).filter(({ suggestion }) => suggestion.status === "pending" || suggestion.status === "conflicted");
  const pendingSuggestions = openSuggestions.filter(({ suggestion }) => suggestion.status === "pending");
  // Comments keep their document numbering while filtered.
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = threads.map((thread, index) => ({ thread, index })).filter(({ thread, index }) => {
    if (!terms.length) return true;
    const haystack = [`comment ${index + 1}`, thread.status, thread.messages[0]?.author ?? "", thread.anchor.quote, ...thread.messages.map((m) => m.text), ...(isSharedThread(thread) ? [thread.shared.detached ? "detached" : "", ...thread.messages.map((m) => m.shared.author.displayName)] : [])].join("\n").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  const shownSuggestions = openSuggestions.filter(({ suggestion, index }) => {
    if (!terms.length) return true;
    const haystack = [`edit ${index + 1}`, "agent", suggestion.status, suggestion.title, suggestion.reason, ...suggestion.edits.flatMap((edit) => [edit.before, edit.after])].join("\n").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  return <section className="review-comments flex min-h-0 flex-1 flex-col" aria-label="Review comments">
    <header className="shrink-0 space-y-3 px-3 pb-3 pt-4">
      <div className="libera-notebook-heading flex items-center gap-1">
        <h2 className="min-w-0 flex-1 text-sm font-semibold">Comments</h2>
        <span className="mr-1 whitespace-nowrap text-xs tabular-nums text-muted-foreground">{threads.filter((t) => t.status === "open").length} open{openSuggestions.length > 0 && <span className="review-agent-suggestion-count" title="Suggested edits from the agent, waiting for your decision"> · {openSuggestions.length} suggested</span>}</span>
        <button type="button" className="libera-sidebar-icon-button inline-flex h-[29px] w-[29px] shrink-0 items-center justify-center rounded-lg disabled:opacity-40" aria-label="Undo acceptance" title="Undo acceptance" disabled={!!r.busy || !r.doc?.undo.length} onClick={() => void r.action("undo")}><Undo2 aria-hidden size={14} /></button>
        <button type="button" className="libera-sidebar-icon-button inline-flex h-[29px] w-[29px] shrink-0 items-center justify-center rounded-lg disabled:opacity-40" aria-label="Redo acceptance" title="Redo acceptance" disabled={!!r.busy || !r.doc?.redo?.length} onClick={() => void r.action("redo")}><Redo2 aria-hidden size={14} /></button>
      </div>
      <button type="button" className="libera-panel-button h-9 w-full" aria-pressed={r.chatReview} title={r.chatReview ? "Return to regular chat" : "Plan how to address comments"} onClick={() => r.setChatReview(!r.chatReview)}><Sparkles size={14} /> Agentic review</button>
      {r.doc && <>
        {(threads.length > 0 || openSuggestions.length > 0) && <div className="review-comment-search relative">
          <Search aria-hidden size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input type="search" aria-label="Search comments" placeholder="Search comments…" className="libera-panel-field h-9 w-full pl-8 pr-7 text-xs" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); } }} />
          {query && <button type="button" className="libera-sidebar-icon-button absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md" aria-label="Clear comment search" title="Clear search" onClick={() => setQuery("")}><X aria-hidden size={12} /></button>}
        </div>}
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">{r.enabled ? "Select a passage in either editor to comment. ⌘/Ctrl+Alt+M" : "Enable Review Mode to highlight passages and add comments."}</p>
      </>}
      {r.shared && <SharedCommentsNotices shared={r.shared} />}
    </header>
    <div ref={list} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-4">
    {r.error && <p role="alert" className="mt-2 text-sm text-destructive">{r.error} <button className={button} onClick={() => void r.reload()}>Reload review</button></p>}
    {r.recovery && <div className="libera-panel-card space-y-2 p-3 text-sm"><p>A saved review result differs from the current file. Restore its unsaved draft or keep your current text.</p><div className="flex gap-2"><button className={button} onClick={r.restore}>Restore review draft</button><button className={button} onClick={() => void r.action("sync")}>Keep current text</button></div></div>}
      {!r.doc ? <p className="rounded-lg border border-dashed border-input px-4 py-8 text-center text-sm text-muted-foreground">Open a Markdown or LaTeX document to see its comments.</p> : !threads.length && !openSuggestions.length ? <p className="rounded-lg border border-dashed border-input px-4 py-8 text-center text-sm text-muted-foreground">No comments yet. Select text in the editor to add one.</p> : !shown.length && !shownSuggestions.length && <p className="rounded-lg border border-dashed border-input px-4 py-3 text-sm text-muted-foreground">No comments match “{query.trim()}”.</p>}
      {shownSuggestions.length > 0 && <section className="space-y-2" aria-label="Suggested edits">
        {pendingSuggestions.length > 1 && <div className="flex flex-wrap items-center gap-1">
          <span className="min-w-0 flex-1 text-xs font-semibold">Suggested edits</span>
          <button type="button" className={button} disabled={!!r.busy || r.recovery} onClick={() => void r.action("agent-decision", { ids: pendingSuggestions.map(({ suggestion }) => suggestion.id), decision: "accept" })}><Check size={14} /> Accept all</button>
          <button type="button" className={button} disabled={!!r.busy} onClick={() => void r.action("agent-decision", { ids: pendingSuggestions.map(({ suggestion }) => suggestion.id), decision: "reject" })}><X size={14} /> Reject all</button>
        </div>}
        {shownSuggestions.map(({ suggestion, index }) => <AgentSuggestionCard key={suggestion.id} suggestion={suggestion} number={index + 1} />)}
      </section>}
      {shown.map(({ thread, index }) => isSharedThread(thread) && r.shared ? <SharedThreadCard key={thread.id} thread={thread} index={index} shared={r.shared} selected={active?.id === thread.id} cardRef={active?.id === thread.id ? selectedCard : undefined} reply={reply} setReply={setReply} mentions={mentions} setMentions={setMentions} editing={editing} setEditing={setEditing} /> : <article key={thread.id} ref={active?.id === thread.id ? selectedCard : undefined} data-selected={active?.id === thread.id} className="review-comment-card libera-panel-card p-3 text-[13px] transition" aria-label={`Comment ${index + 1}`}>
        <button className="w-full text-left" aria-expanded={active?.id === thread.id} onClick={() => { r.selectThread(active?.id === thread.id ? null : thread.id); setReply(""); setEditing(null); if (thread.anchor.state === "attached") r.focus(thread.anchor); }}>
          <span className="flex flex-wrap items-center justify-between gap-1"><span className="flex items-center gap-1.5"><strong className="text-xs font-semibold">Comment {index + 1}</strong>{thread.messages[0]?.author === "agent" && <span className="review-comment-author inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground" title="Left by the AI agent"><Sparkles aria-hidden size={10} /> Agent</span>}</span><span className="text-[11px] capitalize text-muted-foreground">{thread.status === "addressed" ? "completed" : thread.status}{thread.status === "open" && thread.anchor.state !== "attached" && ` · ${thread.anchor.state}`}</span></span>
          <span className="my-2 line-clamp-3 text-xs italic text-muted-foreground">{thread.anchor.quote}</span>
          <span className="block whitespace-pre-wrap">{thread.messages[0]?.text}</span>
          {thread.messages.length > 1 && <span className="mt-2 block text-xs text-muted-foreground">{thread.messages.length - 1} {thread.messages.length === 2 ? "reply" : "replies"}</span>}
        </button>
        {active?.id === thread.id && <div className="mt-2 space-y-2">
          {thread.messages.map((m, i) => <div key={m.id}>{i > 0 && <p className="whitespace-pre-wrap">{m.text}</p>}<button type="button" className="review-comment-icon" data-tone="blue" aria-label={i === 0 ? "Edit comment" : "Edit reply"} title={i === 0 ? "Edit comment" : "Edit reply"} disabled={!!r.busy} onClick={() => { setEditing(m.id); setReply(m.text); }}><PencilLine aria-hidden size={16} /></button></div>)}
          <textarea aria-label={editing ? "Edit comment" : "Reply to comment"} className="review-textarea" placeholder={editing ? "Edit your comment…" : "Write a reply…"} rows={2} value={reply} onChange={(e) => setReply(e.target.value)} />
          <div className="review-comment-actions"><button type="button" className="review-comment-icon" data-tone="blue" aria-label={editing ? "Save comment" : "Reply"} title={editing ? "Save comment" : "Reply"} disabled={!reply.trim() || !!r.busy} onClick={async () => { if (await r.action(editing ? "edit" : "reply", { threadId: thread.id, messageId: editing, text: reply })) { setReply(""); setEditing(null); } }}>{editing ? <Save aria-hidden size={16} /> : <Send aria-hidden size={16} />}</button>
          <button type="button" className="review-comment-icon" data-tone="green" aria-label={thread.status === "open" ? "Resolve" : "Reopen"} title={thread.status === "open" ? "Resolve" : "Reopen"} disabled={!!r.busy} onClick={() => void r.action("resolve", { threadId: thread.id, resolved: thread.status === "open" })}>{thread.status === "open" ? <Check aria-hidden size={16} /> : <RotateCcw aria-hidden size={16} />}</button>
          <button type="button" className="review-comment-icon" data-tone="violet" aria-label="Reattach to selection" title="Reattach to selection" disabled={!!r.busy || !r.selection} onClick={() => void r.action("reattach", { threadId: thread.id, range: r.selection?.range })}><Link2 aria-hidden size={16} /></button>
          <button type="button" className="review-comment-icon review-comment-delete" data-tone="red" aria-label="Delete comment" title="Delete comment" disabled={!!r.busy} onClick={() => void r.action("delete", { threadId: thread.id })}><Trash2 aria-hidden size={16} /></button></div>
        </div>}
      </article>)}
    </div>
  </section>;
}
export function ReviewSuggestionCard({ suggestion, number }: { suggestion: ReviewSuggestion; number: number }) {
  const r = useMarkdownReview()!;
  const [revision, setRevision] = useState<string | null>(null);
  const pending = suggestion.status === "pending", conflicted = suggestion.status === "conflicted";
  return <article className="review-suggestion" aria-label={`Change ${number}: ${suggestion.title}`}>
    <div className="flex items-start gap-2"><button className="flex-1 text-left font-semibold" onClick={() => r.focus(suggestion.edits[0])}>Change {number}: {suggestion.title}</button><span className="text-xs capitalize">{suggestion.status}</span></div>
    <p className="mt-1 text-xs text-muted-foreground">{suggestion.reason}</p>
    {r.shared && <p className="mt-1 text-xs text-muted-foreground">Shared as a suggestion: collaborators see it, and an editor accepts or rejects it.</p>}
    {suggestion.edits.length > 1 && <p className="mt-1 text-xs font-semibold">Linked changes · accepted together</p>}
    {suggestion.edits.map((edit, index) => <div key={index} className="review-diff"><div aria-label="Original text"><span className="review-diff-label">Original</span><pre>{edit.before}</pre></div><div aria-label="Proposed text"><span className="review-diff-label">Proposed</span><pre>{edit.after || "(delete passage)"}</pre></div></div>)}
    <p className="text-xs text-muted-foreground">Comments {suggestion.commentIds.map((id) => (r.doc?.threads.findIndex((t) => t.id === id) ?? -1) + 1).join(", ")}</p>
    <div className="mt-2 flex flex-wrap gap-1">
      {pending && <><button className={button} disabled={!!r.busy || r.recovery} onClick={() => void r.action("decision", { ids: [suggestion.id], decision: "accept" })}><Check size={14} /> Accept</button><button className={button} disabled={!!r.busy} onClick={() => void r.action("decision", { ids: [suggestion.id], decision: "reject" })}><X size={14} /> Reject</button></>}
      {conflicted && <button className={button} disabled={!!r.busy} onClick={() => void r.action("decision", { ids: [suggestion.id], decision: "reject" })}>Reject</button>}
      {(pending || conflicted) && <button className={button} disabled={!!r.busy} onClick={() => setRevision(revision === null ? "" : null)}>Request revision</button>}
      {suggestion.status === "rejected" && !r.shared && <button className={button} disabled={!!r.busy} onClick={() => void r.action("decision", { ids: [suggestion.id], decision: "reopen" })}>Reopen change</button>}
    </div>
    {revision !== null && <form className="mt-2" onSubmit={async (e) => { e.preventDefault(); if (await r.generate("revise", revision, undefined, undefined, suggestion.id)) setRevision(null); }}><textarea aria-label={`Revision for change ${number}`} className="review-textarea" value={revision} onChange={(e) => setRevision(e.target.value)} /><button className={button} disabled={!revision.trim() || !!r.busy}>Revise this change</button></form>}
  </article>;
}
// The popover's buttons keep focus where it is (the comment box, or the
// editor before composing): a mousedown that moves focus makes the editor
// blur and resync, and the click must land on the same button it started on.
const keepFocus = (event: { preventDefault(): void }) => event.preventDefault();

/** A suggested edit the agent left (SuggestEdit), decided outside any Agentic Review session. */
export function AgentSuggestionCard({ suggestion, number }: { suggestion: AgentSuggestion; number: number }) {
  const r = useMarkdownReview()!;
  const [revision, setRevision] = useState<string | null>(null);
  const pending = suggestion.status === "pending", conflicted = suggestion.status === "conflicted";
  const comments = suggestion.commentIds.map((id) => (r.doc?.threads.findIndex((t) => t.id === id) ?? -1) + 1).filter((n) => n > 0);
  return <article className="review-suggestion review-agent-suggestion libera-panel-card p-3 text-[13px]" aria-label={`Suggested edit ${number}: ${suggestion.title}`} data-status={suggestion.status}>
    <div className="flex items-start gap-2">
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { if (suggestion.anchors[0]?.state === "attached") r.focus(suggestion.edits[0]); }}>
        <span className="flex flex-wrap items-center gap-1.5"><strong className="text-xs font-semibold">Edit {number}</strong><span className="review-comment-author inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground" title="Suggested by the AI agent"><Sparkles aria-hidden size={10} /> Agent</span></span>
        <span className="mt-1 block font-semibold">{suggestion.title}</span>
      </button>
      <span className="text-[11px] capitalize text-muted-foreground">{conflicted ? "text changed" : suggestion.status}</span>
    </div>
    {suggestion.reason && suggestion.reason !== suggestion.title && <p className="mt-1 text-xs text-muted-foreground">{suggestion.reason}</p>}
    {suggestion.edits.map((edit, index) => <div key={index} className="review-diff"><div aria-label="Original text"><span className="review-diff-label">Original</span><pre>{edit.before}</pre></div><div aria-label="Proposed text"><span className="review-diff-label">Proposed</span><pre>{edit.after || "(delete passage)"}</pre></div></div>)}
    {conflicted && <p className="text-xs text-muted-foreground">The passage changed since the agent suggested this, so it cannot be applied as is.</p>}
    {comments.length > 0 && <p className="text-xs text-muted-foreground">{comments.length === 1 ? "Comment" : "Comments"} {comments.join(", ")}</p>}
    <div className="mt-2 flex flex-wrap gap-1">
      {pending && <button type="button" className={button} disabled={!!r.busy || r.recovery} onClick={() => void r.action("agent-decision", { ids: [suggestion.id], decision: "accept" })}><Check size={14} /> Accept</button>}
      <button type="button" className={button} disabled={!!r.busy} onClick={() => void r.action("agent-decision", { ids: [suggestion.id], decision: "reject" })}><X size={14} /> Reject</button>
      <button type="button" className={button} disabled={!!r.busy || suggestion.anchors.every((anchor) => anchor.state !== "attached")} onClick={() => setRevision(revision === null ? "" : null)}>Request revision</button>
    </div>
    {revision !== null && <form className="mt-2" onSubmit={async (e) => { e.preventDefault(); if (await r.action("agent-revision", { suggestionId: suggestion.id, text: revision })) setRevision(null); }}>
      <textarea aria-label={`Revision for suggested edit ${number}`} className="review-textarea" placeholder="What should change? This becomes a comment on the passage." value={revision} onChange={(e) => setRevision(e.target.value)} />
      <button type="submit" className={button} disabled={!revision.trim() || !!r.busy}>Send revision request</button>
    </form>}
  </article>;
}
export function ReviewPopover() {
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
  return <div className="review-popover" role="dialog" aria-label="Passage review" onKeyDown={(e) => { if (e.key === "Escape") { r.clearSelection(); setComposing(false); setText(""); } }} style={{ left: Math.max(8, Math.min(x, (typeof window === "undefined" ? 1000 : window.innerWidth) - 376)), top: Math.max(8, Math.min(y + 8, (typeof window === "undefined" ? 800 : window.innerHeight) - 320)) }}>
    <div className="flex items-center gap-2"><strong className="flex-1 text-sm">Passage review</strong><button className={button} aria-label="Close passage review" onClick={() => { r.clearSelection(); setComposing(false); setText(""); }}><X size={14} /></button></div>
    <blockquote className="my-2 max-h-20 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{r.doc.snapshot.slice(range.start, range.end)}</blockquote>
    {threads.map((t) => <button key={t.id} className="my-1 block w-full rounded bg-muted p-2 text-left text-sm" onClick={() => { r.selectThread(t.id); r.clearSelection(); }}>{t.messages[0]?.text} <span className="text-xs text-muted-foreground">· {t.messages.length} message(s)</span></button>)}
    {visible.map((s) => <ReviewSuggestionCard key={s.id} suggestion={s} number={suggestions.indexOf(s) + 1} />)}
    {agentVisible.map((s) => <AgentSuggestionCard key={s.id} suggestion={s} number={agentSuggestions.indexOf(s) + 1} />)}
    {composing ? <form onSubmit={async (e) => { e.preventDefault(); if (await r.action("comment", { range, text, ...(r.shared ? { mentions } : {}) })) { setText(""); setMentions([]); setComposing(false); r.clearSelection(); } }}>{r.shared ? <MentionTextarea autoFocus aria-label="New review comment" className="review-textarea" projectId={r.shared.projectId} selfId={r.shared.projection.me?.id} value={text} onChange={setText} onMentionsChange={setMentions} placeholder="Comment… Type @ to mention someone" /> : <textarea autoFocus aria-label="New review comment" className="review-textarea" value={text} onChange={(e) => setText(e.target.value)} />}<button className={button} disabled={!text.trim() || !!r.busy} onMouseDown={keepFocus}>Add comment</button></form> : <button className={button} disabled={!!r.busy} onMouseDown={keepFocus} onClick={() => setComposing(true)}><MessageSquarePlus size={14} /> Add comment</button>}
  </div>;
}
export function ReviewChatPanel({ files, tabs }: { files: LiberaFileNode[]; tabs: OpenTab[] }) {
  const markdownFiles = useMemo(() => files.filter((file) => file.fileType === "markdown"), [files]);
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
    void apiRequest<typeof recoverable>("/api/markdown-reviews?drafts=1").then((rows) => { if (active && Array.isArray(rows)) setRecoverable(rows); }).catch(() => { if (active) setError("Could not load recoverable review drafts."); });
    return () => { active = false; };
  }, [doc]);
  const suggestions = session?.suggestions ?? [];
  const pending = suggestions.filter((s) => s.status === "pending");
  // A shared document's threads come from the collab server; the plan
  // addresses them by id like local comments.
  const selectedIds = doc?.threads.filter((t) => t.status === "open" && !excluded.includes(t.id)).map((t) => t.id) ?? [];
  const contextChanged = !!session && (JSON.stringify(references) !== JSON.stringify(session.references) || JSON.stringify([...selectedIds].sort()) !== JSON.stringify([...session.selectedIds].sort()));
  async function send() {
    setError("");
    const intent = reviewIntent(prompt);
    let okay = false;
    if (intent.action === "confirm") {
      if (contextChanged) { setError("Selected comments or reference files changed. Send a request to refresh the plan first."); return; }
      const version = prompt.match(/\bplan\s+(\d+)/i)?.[1];
      if (version && Number(version) !== session?.plan.version) { setError("Confirm the latest displayed plan version."); return; }
      okay = await r.generate("generate", prompt);
    } else if (intent.action === "accept" || intent.action === "reject") {
      const selected = intent.numbers === "all" ? pending : intent.numbers.map((n) => suggestions[n - 1]);
      if (!selected.length || selected.some((s) => !s || s.status !== "pending")) { setError("Choose currently pending change numbers."); return; }
      okay = await r.action("decision", { ids: selected.map((s) => s.id), decision: intent.action });
    } else okay = await r.generate("plan", prompt, selectedIds, references);
    if (okay) setPrompt("");
  }
  return <aside id="document-chat-panel" aria-label="Agentic review" className="libera-glass-panel libera-chat-panel flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-border bg-card">
    <header className="libera-chat-header libera-window-drag-region flex shrink-0 items-center gap-2 px-3">
      <span className="libera-ai-mark" aria-hidden><Sparkles size={22} /></span>
      <strong className="min-w-0 flex-1 text-sm">Agentic review</strong>
      <button type="button" className="libera-sidebar-icon-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full disabled:opacity-40" aria-label="New review round" title="New review round" disabled={!doc || !!r.busy || attachmentBusy || r.recovery} onClick={() => void r.action("new-round")}><Plus aria-hidden size={16} /></button>
      <button type="button" className="libera-sidebar-icon-button libera-window-no-drag inline-flex h-8 w-8 shrink-0 items-center justify-center" aria-label="Return to AI chat" title="Return to AI chat" onClick={() => r.setChatReview(false)}><ArrowLeft aria-hidden size={17} /></button>
    </header>
    <div className={`libera-chat-log min-h-0 flex-1 space-y-3 overflow-auto p-3 ${!session ? "flex flex-col" : ""}`}>
      {!session && <div className="libera-chat-welcome libera-review-welcome">
        <span className="libera-ai-orb" aria-hidden><PencilLine size={30} strokeWidth={1.5} /></span>
        <h2>A fresh perspective.<br />A stronger draft.</h2>
        <p>{doc ? "Turn your ideas and feedback into thoughtful improvements." : "Open a Markdown document to start your next review."}</p>
        {doc ? <div className="libera-chat-starters">
          {[
            { icon: PencilLine, label: "Make the writing clearer", prompt: "Review this draft for clarity. Suggest ways to make the writing easier to follow while preserving its meaning." },
            { icon: ListChecks, label: "Strengthen the structure", prompt: "Review the structure and flow of this draft. Plan improvements to the organization and transitions." },
            { icon: ShieldCheck, label: selectedIds.length ? "Work through my comments" : "Check for consistency", prompt: selectedIds.length ? "Plan how to address the selected review comments while preserving the intent of the draft." : "Review this draft for inconsistent terminology, gaps in the explanation, and unsupported claims. Plan targeted improvements." },
          ].map(({icon: Icon, label, prompt: starter}) => <button key={label} type="button" disabled={!!r.busy || attachmentBusy || r.recovery} onClick={() => { setPrompt(starter); input.current?.focus(); }}><Icon aria-hidden size={16} /><span>{label}</span><ArrowUp aria-hidden size={13} /></button>)}
        </div> : <div className="libera-review-intro"><BookOpen aria-hidden size={18} /><span>Your document and comments stay at the heart of every review.</span></div>}
        <p className="libera-chat-context-hint">Start with a plan. Confirm it to generate suggestions, then accept or reject each change.</p>
        {doc && <p className="libera-chat-context-hint">Type @ to include a reference file.</p>}
      </div>}

      {!doc ? <>{recoverable.length > 0 && <section className="space-y-2"><strong className="text-sm">Recover unsaved reviews</strong>{recoverable.map((draft) => <button key={draft.id} className="review-button w-full flex-col items-start text-left" onClick={() => r.recoverDraft(draft.key, draft.snapshot)}><span className="line-clamp-2">{draft.snapshot.slice(0, 120) || "Untitled review"}</span><span>{draft.commentCount} comments · restore draft</span></button>)}</section>}</> : <>
      {session && <p className="break-all text-xs text-muted-foreground">Reviewing: {doc.key} · round {doc.round ?? 1} · full current draft</p>}
      {(session || doc.threads.some((thread) => thread.status === "open")) && <details className="libera-review-comment-picker" open={!session}><summary className="cursor-pointer text-sm">Comments to address ({selectedIds.length})</summary>{doc.threads.filter((t) => t.status === "open").map((t) => <label key={t.id} className="mt-2 flex gap-2 text-sm"><input type="checkbox" checked={!excluded.includes(t.id)} onChange={(e) => setExcluded(e.target.checked ? excluded.filter((id) => id !== t.id) : [...excluded, t.id])} />{t.messages[0]?.text}</label>)}</details>}
      {!!doc.previousRounds?.length && <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">Previous rounds ({doc.previousRounds.length})</summary>
        {doc.previousRounds.map((round) => <details key={round.session.id} className="mt-2 rounded-lg border border-border p-2 text-xs">
          <summary className="cursor-pointer">Round {round.number} · {round.session.plan.summary}</summary>
          <p className="mt-2 text-muted-foreground">Archived. These proposals cannot be applied in the current round.</p>
          <ol className="my-2 list-decimal space-y-1 pl-4">{round.session.plan.steps.map((step, i) => <li key={i}>{step.proposedChange}</li>)}</ol>
          {round.session.messages.map((m, i) => <p key={i} className="my-2 whitespace-pre-wrap"><strong>{m.role === "user" ? "You" : "Assistant"}: </strong>{m.text}</p>)}
          {round.session.suggestions.filter((s) => s.status !== "superseded").map((s) => <div key={s.id} className="mt-2"><strong>{s.title}</strong><span className="ml-1 text-muted-foreground">· {s.status === "pending" || s.status === "conflicted" ? "not applied" : s.status}</span>{s.edits.map((edit, i) => <div key={i} className="review-diff"><div><span className="review-diff-label">Original</span><pre>{edit.before}</pre></div><div><span className="review-diff-label">Proposed</span><pre>{edit.after || "(delete passage)"}</pre></div></div>)}</div>)}
        </details>)}
      </details>}
      {session && <>
        <details><summary className="cursor-pointer text-sm">Review conversation</summary>{session.messages.map((m, i) => <div key={i} className="my-2 whitespace-pre-wrap text-sm"><strong>{m.role === "user" ? "You" : "Assistant"}</strong><p>{m.text}</p></div>)}</details>
        <section className="rounded-lg border border-border p-3 text-sm"><strong>Plan {session.plan.version}</strong><p className="mt-2 whitespace-pre-wrap">{session.plan.summary}</p><ol className="my-2 list-decimal space-y-2 pl-5">{session.plan.steps.map((step, i) => <li key={i}><p>{step.proposedChange}</p><p className="text-xs text-muted-foreground">{step.rationale}</p></li>)}</ol>{!!session.plan.dispositions.length && <><p className="mt-2 text-xs font-medium">No edit needed</p><ul className="mt-1 list-disc space-y-1 pl-5 text-xs">{session.plan.dispositions.map((d) => <li key={d.commentId}>{d.reason}</li>)}</ul></>}{session.plan.blockingQuestions.map((q, i) => <p key={i} className="mt-2 font-medium">Question: {q}</p>)}{session.plan.revisionSummary && <p className="mt-2 text-xs">{session.plan.revisionSummary}</p>}</section>
        {session.messages.at(-1)?.role === "assistant" && session.confirmedVersion && <p className="whitespace-pre-wrap text-sm">{session.messages.at(-1)!.text}</p>}
        {session.phase === "stale" && <p role="status" className="text-sm text-destructive">The document or comments changed. Send a request to refresh the plan.</p>}
        {session.phase === "awaiting_confirmation" && contextChanged && <p className="text-sm">Comments or references changed. Send a request to refresh the plan.</p>}
        {session.phase === "awaiting_confirmation" && <button className={button} disabled={!!r.busy || !!session.plan.blockingQuestions.length || r.recovery || contextChanged} onClick={() => void r.generate("generate", "Confirm the current plan and generate changes.")}>{session.plan.steps.length ? "Confirm plan & generate changes" : "Confirm plan (no edits)"}</button>}
        {!!suggestions.length && <><p className="text-xs">{pending.length} pending · {suggestions.filter((s) => s.status === "conflicted").length} conflicted · {suggestions.filter((s) => s.status === "accepted").length} accepted · {suggestions.filter((s) => s.status === "rejected").length} rejected</p><div className="flex flex-wrap gap-1"><button className={button} disabled={!pending.length || !!r.busy || r.recovery} onClick={() => void r.action("decision", { ids: pending.map((s) => s.id), decision: "accept" })}>Accept all remaining</button><button className={button} disabled={!pending.length || !!r.busy} onClick={() => void r.action("decision", { ids: pending.map((s) => s.id), decision: "reject" })}>Reject all remaining</button><button className={button} disabled={!doc.undo.length || !!r.busy} onClick={() => void r.action("undo")}>Undo acceptance</button></div></>}
        {suggestions.map((s, i) => s.status !== "superseded" && <ReviewSuggestionCard key={s.id} suggestion={s} number={i + 1} />)}
        {session.phase === "completed" && <p className="text-sm">Review decisions complete. Save when ready; unresolved comments remain open.</p>}
      </>}
      </>}
      {(r.error || error) && <p role="alert" className="text-sm text-destructive">{r.error || error} <button className={button} onClick={() => void r.reload()}>Reload review</button></p>}
      {!!r.busy && <p role="status" className="flex flex-wrap items-center gap-2 text-sm"><span className="libera-chat-thinking text-muted-foreground">{r.busy === "plan" ? "Planning…" : ["generate", "revise"].includes(r.busy) ? "Generating proposed changes…" : "Saving review…"}</span>{["plan", "generate", "revise"].includes(r.busy) && <button className={button} onClick={r.stop}>Stop</button>}</p>}
    </div>
    <form className="libera-chat-form shrink-0 space-y-2 p-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      {doc && <div className="libera-chat-context flex items-center gap-2"><BookOpen aria-hidden size={13} className="shrink-0" /><p className="min-w-0 truncate" title={doc.key}>{doc.key.split("/").at(-1)} · Round {doc.round ?? 1}</p></div>}
      {references.map((ref) => <div key={ref.path} className="flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate" title={ref.path}>@{ref.name}</span><button type="button" className={button} aria-label={`Remove reference ${ref.name}`} onClick={() => setReferences(references.filter((r) => r.path !== ref.path))}>×</button></div>)}
      <div className="libera-chat-composer">
      <ChatFileComposer placeholder={doc ? session ? "Ask a follow-up… Type @ to add files" : "What would you like to improve?" : "Open a Markdown document to begin"} chatId={`review-${doc?.id}-${doc?.round ?? 1}`} value={prompt} disabled={!doc || !!r.busy} files={markdownFiles} composerRef={input} onChange={setPrompt} onSend={() => void send()} onAttachFile={async (file) => {
        setAttachmentBusy(true);
        setError("");
        try {
          const tab = tabs.find((item) => !item.untitled && item.file.path === file.path);
          const existing = references.find((ref) => ref.path === file.path);
          const payload = existing || tab ? null : await apiRequest<{ content?: string }>(`/api/files?path=${encodeURIComponent(file.path)}`);
          const text = existing?.text ?? tab?.draft ?? payload?.content;
          if (typeof text !== "string") throw new Error(`Could not read ${file.name}.`);
          if (text.length > 500_000) throw new Error(`${file.name} is too large to attach (maximum 500,000 characters).`);
          setReferences((current) => [...current.filter((ref) => ref.path !== file.path), { kind: "document", path: file.path, name: file.name, text }]);
          return true;
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not attach file.");
          return false;
        } finally {
          setAttachmentBusy(false);
        }
      }} />
      <div className="libera-chat-composer-actions flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{session ? "Continue review" : "Plan review"}</span>
        <button type="submit" className="libera-chat-send inline-flex h-8 w-8 shrink-0 items-center justify-center disabled:opacity-40" aria-label={session ? "Send review request" : "Plan review"} title={session ? "Send review request" : "Plan review"} disabled={!doc || !!r.busy || attachmentBusy || (!prompt.trim() && !selectedIds.length)}><ArrowUp aria-hidden size={18} /></button>
      </div>
      </div>
      <p className="libera-chat-key-hint">Enter to send · Shift + Enter for a new line</p>
    </form>
  </aside>;
}

// ---- Shared documents (plan M2.1–M2.3, M2.6): authors, pending chips,
// detached anchors and the one-time move of local comments.

/** The time, refreshed every minute, for "5 min ago" labels. */
export function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function AuthorAvatar({ user, ai }: { user: UserSummary; ai?: boolean }) {
  return <span aria-hidden className="review-comment-avatar inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white" style={{ background: user.color || "#64748b" }}>{ai ? <Sparkles size={10} /> : initials(user.displayName)}</span>;
}

function AuthorLine({ message, now }: { message: SharedReviewMessage; now: number }) {
  const { author, actor, editedAt } = message.shared;
  const label = commentAuthorLabel(actor, author);
  const created = Date.parse(message.createdAt);
  return <span className="review-comment-author flex min-w-0 items-center gap-1.5 text-[11px]" data-author-id={author.id}>
    <AuthorAvatar user={author} ai={actor?.kind === "ai"} />
    <span className="min-w-0 truncate font-semibold" style={{ color: author.color || undefined }} title={label}>{label}</span>
    {Number.isFinite(created) && <span className="shrink-0 text-muted-foreground" title={new Date(created).toLocaleString()}>{timeAgo(Math.max(0, now - created))}</span>}
    {editedAt && !message.shared.deleted && <span className="shrink-0 text-muted-foreground">· edited</span>}
  </span>;
}

export function PendingChip({ pending, onRetry, onDiscard }: { pending: PendingInfo; onRetry: () => void; onDiscard: () => void }) {
  if (pending.state === "failed") {
    return <div role="alert" className="review-comment-failed mt-2 flex flex-wrap items-center gap-1.5 rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
      <AlertTriangle aria-hidden size={12} /><span className="min-w-0 flex-1">Not sent: {pending.error ?? "the server refused it."}</span>
      <button type="button" className={button} onClick={onRetry}>Retry</button>
      <button type="button" className={button} onClick={onDiscard}>Discard</button>
    </div>;
  }
  return <span className="review-comment-pending mt-1 inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground" data-state={pending.state} title={pending.state === "queued" ? "Saved on this device. It is sent when you are back online." : "Sending to the shared notebook…"}>
    <Clock aria-hidden size={10} /> {pending.state === "queued" ? "Pending" : "Sending…"}
  </span>;
}

function SharedMessageView({ message, first, now, busy, onEdit, onDelete, onRetry, onDiscard }: { message: SharedReviewMessage; first: boolean; now: number; busy: boolean; onEdit: () => void; onDelete: () => void; onRetry: (commandId: string) => void; onDiscard: (commandId: string) => void }) {
  const info = message.shared;
  return <div className="review-comment-message space-y-1" data-message-id={message.id} data-pending={info.pending?.state ?? undefined}>
    <div className="flex items-center gap-1">
      <AuthorLine message={message} now={now} />
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        {info.canEdit && <button type="button" className="review-comment-icon" data-tone="blue" aria-label={first ? "Edit comment" : "Edit reply"} title={first ? "Edit comment" : "Edit reply"} disabled={busy} onClick={onEdit}><PencilLine aria-hidden size={14} /></button>}
        {info.canDelete && !first && <button type="button" className="review-comment-icon review-comment-delete" data-tone="red" aria-label="Delete reply" title="Delete reply" disabled={busy} onClick={onDelete}><Trash2 aria-hidden size={14} /></button>}
      </span>
    </div>
    {info.deleted ? <p className="text-xs italic text-muted-foreground">This message was deleted.</p> : <MarkdownRenderer content={message.text} className="review-comment-body min-w-0 break-words text-[13px]" renderImages={false} />}
    {info.pending && <PendingChip pending={info.pending} onRetry={() => onRetry(info.pending!.commandId)} onDiscard={() => onDiscard(info.pending!.commandId)} />}
  </div>;
}

function SharedThreadCard({ thread, index, shared, selected, cardRef, reply, setReply, mentions, setMentions, editing, setEditing }: {
  thread: SharedReviewThread; index: number; shared: SharedReviewState; selected: boolean; cardRef?: RefObject<HTMLElement | null>;
  reply: string; setReply: (value: string) => void; mentions: string[]; setMentions: (ids: string[]) => void; editing: string | null; setEditing: (id: string | null) => void;
}) {
  const r = useMarkdownReview()!;
  const now = useNow();
  const info = thread.shared;
  const first = thread.messages[0];
  const me = shared.projection.me;
  const canComment = !!me && shared.projection.role !== "viewer";
  const deletedText = info.detached && info.detachReason === "deleted";
  const candidates = selected && info.detached && info.canManage ? shared.reattachCandidates(thread.id) : [];
  const retry = (commandId: string) => void r.action("retry", { commandId });
  const discard = (commandId: string) => void r.action("discard", { commandId });
  const status = info.status === "resolved" ? "resolved" : info.detached ? "detached" : "open";
  return <article ref={cardRef} data-anchor-end={thread.anchor.state === "attached" ? thread.anchor.end : undefined} data-selected={selected} data-detached={info.detached} data-thread-id={thread.id} className="review-comment-card libera-panel-card p-3 text-[13px] transition" aria-label={`Comment ${index + 1}`}>
    <button className="w-full text-left" aria-expanded={selected} onClick={() => { r.selectThread(selected ? null : thread.id); setReply(""); setMentions([]); setEditing(null); if (thread.anchor.state === "attached") r.focus(thread.anchor); }}>
      <span className="flex flex-wrap items-center justify-between gap-1"><span className="flex min-w-0 items-center gap-1.5"><strong className="text-xs font-semibold">Comment {index + 1}</strong>{first && <AuthorLine message={first} now={now} />}</span><span className="text-[11px] capitalize text-muted-foreground">{status}</span></span>
      <span className="my-2 line-clamp-3 text-xs italic text-muted-foreground">{thread.anchor.quote}</span>
      {!selected && <span className="block line-clamp-4 whitespace-pre-wrap">{first?.shared.deleted ? "This comment was deleted." : first?.text}</span>}
      {!selected && thread.messages.length > 1 && <span className="mt-2 block text-xs text-muted-foreground">{thread.messages.length - 1} {thread.messages.length === 2 ? "reply" : "replies"}</span>}
    </button>
    {info.pending && <PendingChip pending={info.pending} onRetry={() => retry(info.pending!.commandId)} onDiscard={() => discard(info.pending!.commandId)} />}
    {!selected && !info.pending && first?.shared.pending && <PendingChip pending={first.shared.pending} onRetry={() => retry(first.shared.pending!.commandId)} onDiscard={() => discard(first.shared.pending!.commandId)} />}
    {info.detached && <div className="review-comment-detached mt-2 space-y-1.5 rounded-md border border-dashed border-input p-2 text-xs" role="note">
      <p>{deletedText ? "The text this comment was attached to was deleted." : info.detachReason === "missing" ? "This comment's place in the text has not synced yet." : "This comment's place in the text could not be found."}</p>
      {info.canManage && <button type="button" className={button} disabled={!r.selection} title={r.selection ? "Attach this comment to the selected passage" : "Select a passage in the editor first"} onClick={() => void r.action("reattach", { threadId: thread.id, range: r.selection?.range })}><Link2 aria-hidden size={14} /> Reattach to selection</button>}
      {candidates.length > 0 && <div className="space-y-1">
        <p className="text-muted-foreground">Found similar text:</p>
        {candidates.map((candidate) => <button key={`${candidate.start}:${candidate.end}`} type="button" className="review-button w-full flex-col items-start text-left" onClick={() => void r.action("reattach", { threadId: thread.id, range: { start: candidate.start, end: candidate.end } })}>
          <span className="line-clamp-2 italic">{shared.projection.text.slice(candidate.start, candidate.end)}</span><span>Attach here</span>
        </button>)}
      </div>}
    </div>}
    {selected && <div className="mt-2 space-y-3">
      {thread.messages.map((m, i) => <SharedMessageView key={m.id} message={m} first={i === 0} now={now} busy={!!r.busy} onEdit={() => { setEditing(m.id); setReply(m.text); }} onDelete={() => void r.action("delete-message", { messageId: m.id })} onRetry={retry} onDiscard={discard} />)}
      {canComment && <>
        <MentionTextarea aria-label={editing ? "Edit comment" : "Reply to comment"} className="review-textarea" placeholder={editing ? "Edit your comment…" : "Write a reply… Type @ to mention someone"} rows={2} projectId={shared.projectId} selfId={me?.id} value={reply} onChange={setReply} onMentionsChange={setMentions} />
        <div className="review-comment-actions">
          <button type="button" className="review-comment-icon" data-tone="blue" aria-label={editing ? "Save comment" : "Reply"} title={editing ? "Save comment" : "Reply"} disabled={!reply.trim() || !!r.busy} onClick={async () => { if (await r.action(editing ? "edit" : "reply", { threadId: thread.id, messageId: editing, text: reply, mentions })) { setReply(""); setMentions([]); setEditing(null); } }}>{editing ? <Save aria-hidden size={16} /> : <Send aria-hidden size={16} />}</button>
          {info.canManage && <button type="button" className="review-comment-icon" data-tone="green" aria-label={thread.status === "open" ? "Resolve" : "Reopen"} title={thread.status === "open" ? "Resolve" : "Reopen"} disabled={!!r.busy} onClick={() => void r.action("resolve", { threadId: thread.id, resolved: thread.status === "open" })}>{thread.status === "open" ? <Check aria-hidden size={16} /> : <RotateCcw aria-hidden size={16} />}</button>}
          {info.canManage && !info.detached && <button type="button" className="review-comment-icon" data-tone="violet" aria-label="Reattach to selection" title="Reattach to selection" disabled={!!r.busy || !r.selection} onClick={() => void r.action("reattach", { threadId: thread.id, range: r.selection?.range })}><Link2 aria-hidden size={16} /></button>}
          {info.canManage && <button type="button" className="review-comment-icon review-comment-delete" data-tone="red" aria-label="Delete comment" title="Delete comment" disabled={!!r.busy} onClick={() => void r.action("delete", { threadId: thread.id })}><Trash2 aria-hidden size={16} /></button>}
        </div>
      </>}
    </div>}
  </article>;
}

const migrationSummaries = new Map<string, Promise<LocalCommentsSummary>>();

/** Load errors, and for the owner the one-time move of comments made before sharing. */
function SharedCommentsNotices({ shared }: { shared: SharedReviewState }) {
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
      setMessage(`Moved ${result.threads} ${result.threads === 1 ? "comment" : "comments"} to the shared notebook${result.detached ? ` (${result.detached} need reattaching: their text changed)` : ""}.`);
      await r.reload();
    } catch (cause) {
      setMessage(describeError(cause));
    } finally {
      setMoving(false);
    }
  }
  return <>
    {projection.error && !projection.loaded && <p role="alert" className="px-1 text-xs text-destructive">Shared comments could not be loaded: {projection.error} <button className={button} onClick={() => void r.reload()}>Retry</button></p>}
    {owner && local && local.threads > 0 && <div className="libera-panel-card space-y-2 p-3 text-xs">
      <p>{local.threads} {local.threads === 1 ? "comment" : "comments"} from before this notebook was shared {local.threads === 1 ? "is" : "are"} still only on this device.</p>
      <button type="button" className={button} disabled={moving} onClick={() => void move()}><CloudUpload aria-hidden size={14} /> {moving ? "Moving…" : "Move existing comments to the shared notebook"}</button>
    </div>}
    {message && <p role="status" className="px-1 text-xs text-muted-foreground">{message}</p>}
  </>;
}
