"use client";

import { useEffect, useRef, useState } from "react";
import { Check, PencilLine, RotateCcw, Save, Search, Send, Sparkles, Trash2, X } from "lucide-react";
import { pdfCommentPages, sortPdfCommentThreads } from "@/lib/pdf-comments";
import { timeAgo } from "@/lib/collab/ui/wording";
import { useNow } from "./markdown-review-ui";
import { changePdfComments, clearPdfCommentsError, focusPdfComment, loadPdfComments, selectPdfComment, usePdfComments } from "./pdf-comments-store";
import type { PdfCommentMessage, PdfCommentThread } from "@/lib/types";

// The Comments tab for a PDF: the same cards as a Markdown document's
// (markdown-review-ui.tsx), in reading order, numbered like the marks on the
// pages. Comments start from a text selection in the viewer (Add comment);
// here you reply, edit, resolve, reopen and delete them. The agent can read
// them and reply, never start a thread.

function AgentChip({ title }: { title: string }) {
  return <span className="review-comment-author inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground" title={title}><Sparkles aria-hidden size={10} /> Agent</span>;
}

function MessageMeta({ message, now }: { message: PdfCommentMessage; now: number }) {
  return <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
    {message.author === "agent" ? <AgentChip title="Replied by the AI agent" /> : <span>You</span>}
    <span title={new Date(message.createdAt).toLocaleString()}>{timeAgo(now - Date.parse(message.createdAt))}</span>
    {message.editedAt && <span>· edited</span>}
  </span>;
}

export function PdfReviewComments({ path }: { path: string }) {
  const state = usePdfComments(path);
  const now = useNow();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const selectedCard = useRef<HTMLElement | null>(null);
  const busy = !!state.busy;
  const threads = sortPdfCommentThreads(state.threads);
  const active = threads.find((thread) => thread.id === state.selectedId) ?? null;

  useEffect(() => {
    selectedCard.current?.scrollIntoView({ block: "nearest" });
  }, [state.selectedId]);

  // A different thread starts with an empty box.
  const [draftFor, setDraftFor] = useState(state.selectedId);
  if (draftFor !== state.selectedId) {
    setDraftFor(state.selectedId);
    setDraft("");
    setEditing(null);
  }

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = threads.map((thread, index) => ({ thread, index })).filter(({ thread, index }) => {
    if (!terms.length) return true;
    const haystack = [`comment ${index + 1}`, thread.status, pdfCommentPages(thread.anchor), thread.anchor.quote, ...thread.messages.map((m) => `${m.author ?? ""}\n${m.text}`)].join("\n").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });

  async function send(thread: PdfCommentThread) {
    const text = draft.trim();
    if (!text) return;
    const done = editing
      ? await changePdfComments(path, { action: "edit", threadId: thread.id, messageId: editing, text })
      : await changePdfComments(path, { action: "reply", threadId: thread.id, text });
    if (done) { setDraft(""); setEditing(null); }
  }

  return <section className="review-comments flex min-h-0 flex-1 flex-col" aria-label="Review comments">
    <header className="shrink-0 space-y-3 px-3 pb-3 pt-4">
      <div className="libera-notebook-heading flex items-center gap-1">
        <h2 className="min-w-0 flex-1 text-sm font-semibold">Comments</h2>
        <span className="mr-1 whitespace-nowrap text-xs tabular-nums text-muted-foreground">{threads.filter((t) => t.status === "open").length} open</span>
      </div>
      {threads.length > 0 && <div className="review-comment-search relative">
        <Search aria-hidden size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input type="search" aria-label="Search comments" placeholder="Search comments…" className="libera-panel-field h-9 w-full pl-8 pr-7 text-xs" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); } }} />
        {query && <button type="button" className="libera-sidebar-icon-button absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md" aria-label="Clear comment search" title="Clear search" onClick={() => setQuery("")}><X aria-hidden size={12} /></button>}
      </div>}
      <p className="px-1 text-xs leading-relaxed text-muted-foreground">Select text on a page and choose Add comment. The AI agent can read these comments and reply to them.</p>
    </header>
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-4">
      {state.error && <p role="alert" className="mt-2 text-sm text-destructive">{state.error} <button type="button" className="review-button" onClick={() => { clearPdfCommentsError(path); void loadPdfComments(path); }}>Reload comments</button></p>}
      {!state.loaded ? <p className="px-1 py-6 text-center text-sm text-muted-foreground">Loading comments…</p>
        : !threads.length ? <p className="rounded-lg border border-dashed border-input px-4 py-8 text-center text-sm text-muted-foreground">No comments yet. Select text on a page to add one.</p>
        : !shown.length && <p className="rounded-lg border border-dashed border-input px-4 py-3 text-sm text-muted-foreground">No comments match “{query.trim()}”.</p>}
      {shown.map(({ thread, index }) => {
        const selected = active?.id === thread.id;
        const replies = thread.messages.slice(1);
        return <article key={thread.id} ref={selected ? selectedCard : undefined} data-selected={selected} data-pdf-comment-card={thread.id} className="review-comment-card libera-panel-card p-3 text-[13px] transition" aria-label={`Comment ${index + 1}`}>
          <button type="button" className="w-full text-left" aria-expanded={selected} onClick={() => { if (selected) selectPdfComment(path, null); else focusPdfComment(path, thread.id); }}>
            <span className="flex flex-wrap items-center justify-between gap-1">
              <span className="flex items-center gap-1.5"><strong className="text-xs font-semibold">Comment {index + 1}</strong><span className="text-[11px] text-muted-foreground">{pdfCommentPages(thread.anchor)}</span></span>
              <span className="text-[11px] capitalize text-muted-foreground">{thread.status}</span>
            </span>
            {thread.anchor.quote && <span className="my-2 line-clamp-3 text-xs italic text-muted-foreground">{thread.anchor.quote}</span>}
            <span className="block whitespace-pre-wrap">{thread.messages[0]?.text}</span>
            {!selected && replies.length > 0 && <span className="mt-2 block text-xs text-muted-foreground">{replies.length} {replies.length === 1 ? "reply" : "replies"}{replies.some((m) => m.author === "agent") ? " · Agent replied" : ""}</span>}
          </button>
          {selected && <div className="mt-2 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <MessageMeta message={thread.messages[0]} now={now} />
              <button type="button" className="review-comment-icon" data-tone="blue" aria-label="Edit comment" title="Edit comment" disabled={busy} onClick={() => { setEditing(thread.messages[0].id); setDraft(thread.messages[0].text); }}><PencilLine aria-hidden size={16} /></button>
            </div>
            {replies.map((message) => <div key={message.id} className="space-y-1 border-l-2 border-border pl-2" data-author={message.author ?? "user"}>
              <div className="flex items-center justify-between gap-2">
                <MessageMeta message={message} now={now} />
                {message.author !== "agent" && <button type="button" className="review-comment-icon" data-tone="blue" aria-label="Edit reply" title="Edit reply" disabled={busy} onClick={() => { setEditing(message.id); setDraft(message.text); }}><PencilLine aria-hidden size={16} /></button>}
              </div>
              <p className="whitespace-pre-wrap">{message.text}</p>
            </div>)}
            <textarea aria-label={editing ? "Edit comment" : "Reply to comment"} className="review-textarea" placeholder={editing ? "Edit your comment…" : "Write a reply…"} rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(thread); }
              if (e.key === "Escape" && editing) { e.stopPropagation(); setEditing(null); setDraft(""); }
            }} />
            <div className="review-comment-actions">
              <button type="button" className="review-comment-icon" data-tone="blue" aria-label={editing ? "Save comment" : "Reply"} title={editing ? "Save comment" : "Reply"} disabled={!draft.trim() || busy} onClick={() => void send(thread)}>{editing ? <Save aria-hidden size={16} /> : <Send aria-hidden size={16} />}</button>
              <button type="button" className="review-comment-icon" data-tone="green" aria-label={thread.status === "open" ? "Resolve" : "Reopen"} title={thread.status === "open" ? "Resolve" : "Reopen"} disabled={busy} onClick={() => void changePdfComments(path, { action: "resolve", threadId: thread.id, resolved: thread.status === "open" })}>{thread.status === "open" ? <Check aria-hidden size={16} /> : <RotateCcw aria-hidden size={16} />}</button>
              <button type="button" className="review-comment-icon review-comment-delete" data-tone="red" aria-label="Delete comment" title="Delete comment" disabled={busy} onClick={() => void changePdfComments(path, { action: "delete", threadId: thread.id })}><Trash2 aria-hidden size={16} /></button>
            </div>
          </div>}
        </article>;
      })}
    </div>
  </section>;
}
