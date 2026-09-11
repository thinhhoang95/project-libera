"use client";

import { useEffect, useRef, useState } from "react";
import { MessageSquarePlus, Check, X, Sparkles, Undo2, Redo2, Plus } from "lucide-react";
import type { ReviewSuggestion } from "@/lib/markdown-review";
import { reviewIntent } from "@/lib/markdown-review";
import { useMarkdownReview } from "./markdown-review-context";
import { apiRequest } from "./api-client";
import { ChatFileComposer } from "./chat-file-composer";
import type { ChatContext } from "@/lib/document-chat";
import type { OpenTab } from "./types";
import type { LiberaFileNode } from "@/lib/types";

const button = "review-button";
export function ReviewToggle() {
  const review = useMarkdownReview();
  if (!review) return null;
  return <button type="button" className="review-toggle inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted aria-pressed:bg-muted aria-pressed:text-accent" aria-label="Review mode" title="Review mode" aria-pressed={review.enabled} disabled={!!review.busy || !review.doc} onClick={() => void review.action("toggle", { enabled: !review.enabled })}><MessageSquarePlus size={16} /></button>;
}
export function ReviewComments() {
  const r = useMarkdownReview();
  const [reply, setReply] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const selectedCard = useRef<HTMLElement | null>(null);
  useEffect(() => {
    selectedCard.current?.scrollIntoView({ block: "nearest" });
  }, [r?.selectedThread]);
  if (!r) return null;
  const threads = r.doc?.threads ?? [];
  const active = threads.find((t) => t.id === r.selectedThread);
  return <section className="review-comments flex min-h-0 flex-1 flex-col" aria-label="Review comments">
    <header className="shrink-0 space-y-3 border-b border-border px-3 py-3">
      <div className="flex items-center gap-1">
        <h2 className="min-w-0 flex-1 text-sm font-semibold">Comments</h2>
        <span className="mr-1 whitespace-nowrap text-xs text-muted-foreground">{threads.filter((t) => t.status !== "resolved").length} open</span>
        <button type="button" className="libera-sidebar-icon-button inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full disabled:opacity-40" aria-label="Undo acceptance" title="Undo acceptance" disabled={!!r.busy || !r.doc?.undo.length} onClick={() => void r.action("undo")}><Undo2 aria-hidden size={14} /></button>
        <button type="button" className="libera-sidebar-icon-button inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full disabled:opacity-40" aria-label="Redo acceptance" title="Redo acceptance" disabled={!!r.busy || !r.doc?.redo?.length} onClick={() => void r.action("redo")}><Redo2 aria-hidden size={14} /></button>
      </div>
      <button className={`${button} w-full`} aria-pressed={r.chatReview} title={r.chatReview ? "Return to regular chat" : "Plan how to address comments"} onClick={() => r.setChatReview(!r.chatReview)}><Sparkles size={14} /> Agentic review</button>
      {r.doc && <>
        <p className="text-xs text-muted-foreground">{r.enabled ? "Select a passage in either editor to comment. ⌘/Ctrl+Alt+M" : "Enable Review Mode to highlight passages and add comments."}</p>
      </>}
    </header>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
    {r.error && <p role="alert" className="mt-2 text-sm text-destructive">{r.error} <button className={button} onClick={() => void r.reload()}>Reload review</button></p>}
    {r.recovery && <div className="mt-2 rounded border border-border p-2 text-sm"><p>A saved review result differs from the current file. Restore its unsaved draft or keep your current text.</p><div className="flex gap-2"><button className={button} onClick={r.restore}>Restore review draft</button><button className={button} onClick={() => void r.action("sync")}>Keep current text</button></div></div>}
      {!r.doc ? <p className="text-sm text-muted-foreground">Open a Markdown document to see its comments.</p> : !threads.length && <p className="text-sm text-muted-foreground">No comments yet. Select a paragraph in either editor to add one.</p>}
      {threads.map((thread, index) => <article key={thread.id} ref={active?.id === thread.id ? selectedCard : undefined} className={`review-comment-card rounded-lg border p-3 text-sm ${active?.id === thread.id ? "border-accent" : "border-border"}`} aria-label={`Comment ${index + 1}`}>
        <button className="w-full text-left" aria-expanded={active?.id === thread.id} onClick={() => { r.selectThread(active?.id === thread.id ? null : thread.id); setReply(""); setEditing(null); if (thread.anchor.state === "attached") r.focus(thread.anchor); }}>
          <span className="flex flex-wrap items-center justify-between gap-1"><strong>Comment {index + 1}</strong><span className="text-xs capitalize text-muted-foreground">{thread.status}{thread.anchor.state !== "attached" && ` · ${thread.anchor.state}`}</span></span>
          <span className="my-2 line-clamp-3 border-l-2 border-border pl-2 text-xs text-muted-foreground">{thread.anchor.quote}</span>
          <span className="block whitespace-pre-wrap">{thread.messages[0]?.text}</span>
          {thread.messages.length > 1 && <span className="mt-2 block text-xs text-muted-foreground">{thread.messages.length - 1} {thread.messages.length === 2 ? "reply" : "replies"}</span>}
        </button>
        {active?.id === thread.id && <div className="mt-2 space-y-2">
          {thread.messages.map((m, i) => <div key={m.id}>{i > 0 && <p className="whitespace-pre-wrap">{m.text}</p>}<button className={button} onClick={() => { setEditing(m.id); setReply(m.text); }}>{i === 0 ? "Edit comment" : "Edit reply"}</button></div>)}
          <textarea aria-label={editing ? "Edit comment" : "Reply to comment"} className="review-textarea" value={reply} onChange={(e) => setReply(e.target.value)} />
          <div className="flex flex-wrap gap-1"><button className={button} disabled={!reply.trim() || !!r.busy} onClick={async () => { if (await r.action(editing ? "edit" : "reply", { threadId: thread.id, messageId: editing, text: reply })) { setReply(""); setEditing(null); } }}>{editing ? "Save comment" : "Reply"}</button>
          <button className={button} disabled={!!r.busy} onClick={() => void r.action("resolve", { threadId: thread.id, resolved: thread.status !== "resolved" })}>{thread.status === "resolved" ? "Reopen" : "Resolve"}</button>
          <button className={button} disabled={!!r.busy || !r.selection} onClick={() => void r.action("reattach", { threadId: thread.id, range: r.selection?.range })}>Reattach to selection</button>
          <button className={button} disabled={!!r.busy} onClick={() => void r.action("delete", { threadId: thread.id })}>Delete</button></div>
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
    {suggestion.edits.length > 1 && <p className="mt-1 text-xs font-semibold">Linked changes · accepted together</p>}
    {suggestion.edits.map((edit, index) => <div key={index} className="review-diff"><div aria-label="Original text"><span className="review-diff-label">Original</span><pre>{edit.before}</pre></div><div aria-label="Proposed text"><span className="review-diff-label">Proposed</span><pre>{edit.after || "(delete passage)"}</pre></div></div>)}
    <p className="text-xs text-muted-foreground">Comments {suggestion.commentIds.map((id) => (r.doc?.threads.findIndex((t) => t.id === id) ?? -1) + 1).join(", ")}</p>
    <div className="mt-2 flex flex-wrap gap-1">
      {pending && <><button className={button} disabled={!!r.busy || r.recovery} onClick={() => void r.action("decision", { ids: [suggestion.id], decision: "accept" })}><Check size={14} /> Accept</button><button className={button} disabled={!!r.busy} onClick={() => void r.action("decision", { ids: [suggestion.id], decision: "reject" })}><X size={14} /> Reject</button></>}
      {conflicted && <button className={button} disabled={!!r.busy} onClick={() => void r.action("decision", { ids: [suggestion.id], decision: "reject" })}>Reject</button>}
      {(pending || conflicted) && <button className={button} disabled={!!r.busy} onClick={() => setRevision(revision === null ? "" : null)}>Request revision</button>}
      {suggestion.status === "rejected" && <button className={button} disabled={!!r.busy} onClick={() => void r.action("decision", { ids: [suggestion.id], decision: "reopen" })}>Reopen change</button>}
    </div>
    {revision !== null && <form className="mt-2" onSubmit={async (e) => { e.preventDefault(); if (await r.generate("revise", revision, undefined, undefined, suggestion.id)) setRevision(null); }}><textarea aria-label={`Revision for change ${number}`} className="review-textarea" value={revision} onChange={(e) => setRevision(e.target.value)} /><button className={button} disabled={!revision.trim() || !!r.busy}>Revise this change</button></form>}
  </article>;
}
export function ReviewPopover() {
  const r = useMarkdownReview();
  const [text, setText] = useState("");
  const [composing, setComposing] = useState(false);
  if (!r?.enabled || !r.selection || !r.doc) return null;
  const { range, x, y } = r.selection;
  const overlaps = (a: { start: number; end: number }) => a.start < range.end && a.end > range.start;
  const suggestions = r.doc.session?.suggestions ?? [];
  const visible = suggestions.filter((s) => ["pending", "conflicted"].includes(s.status) && s.edits.some(overlaps));
  const threads = r.doc.threads.filter((t) => t.anchor.state === "attached" && overlaps(t.anchor));
  return <div className="review-popover" role="dialog" aria-label="Passage review" onKeyDown={(e) => { if (e.key === "Escape") { r.clearSelection(); setComposing(false); setText(""); } }} style={{ left: Math.max(8, Math.min(x, (typeof window === "undefined" ? 1000 : window.innerWidth) - 376)), top: Math.max(8, Math.min(y + 8, (typeof window === "undefined" ? 800 : window.innerHeight) - 320)) }}>
    <div className="flex items-center gap-2"><strong className="flex-1 text-sm">Passage review</strong><button className={button} aria-label="Close passage review" onClick={() => { r.clearSelection(); setComposing(false); setText(""); }}><X size={14} /></button></div>
    <blockquote className="my-2 max-h-20 overflow-auto whitespace-pre-wrap border-l-2 border-accent pl-2 text-xs text-muted-foreground">{r.doc.snapshot.slice(range.start, range.end)}</blockquote>
    {threads.map((t) => <button key={t.id} className="my-1 block w-full rounded bg-muted p-2 text-left text-sm" onClick={() => { r.selectThread(t.id); r.clearSelection(); }}>{t.messages[0]?.text} <span className="text-xs text-muted-foreground">· {t.messages.length} message(s)</span></button>)}
    {visible.map((s) => <ReviewSuggestionCard key={s.id} suggestion={s} number={suggestions.indexOf(s) + 1} />)}
    {composing ? <form onSubmit={async (e) => { e.preventDefault(); if (await r.action("comment", { range, text })) { setText(""); setComposing(false); r.clearSelection(); } }}><textarea autoFocus aria-label="New review comment" className="review-textarea" value={text} onChange={(e) => setText(e.target.value)} /><button className={button} disabled={!text.trim() || !!r.busy}>Add comment</button></form> : <button className={button} disabled={!!r.busy} onClick={() => setComposing(true)}><MessageSquarePlus size={14} /> Add comment</button>}
  </div>;
}
export function ReviewChatPanel({ files, tabs }: { files: LiberaFileNode[]; tabs: OpenTab[] }) {
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
    <header className="flex h-12 shrink-0 items-center gap-2 px-3">
      <Sparkles size={16} /><strong className="flex-1 text-sm">Agentic review</strong>
      <button type="button" className="libera-sidebar-icon-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full disabled:opacity-40" aria-label="New review round" title="New review round" disabled={!doc || !!r.busy || attachmentBusy || r.recovery} onClick={() => void r.action("new-round")}><Plus aria-hidden size={16} /></button>
    </header>
    <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
      {!doc ? <><p className="text-sm">Open a Markdown document to review.</p>{recoverable.length > 0 && <section className="space-y-2"><strong className="text-sm">Recover unsaved reviews</strong>{recoverable.map((draft) => <button key={draft.id} className="review-button w-full flex-col items-start text-left" onClick={() => r.recoverDraft(draft.key, draft.snapshot)}><span className="line-clamp-2">{draft.snapshot.slice(0, 120) || "Untitled review"}</span><span>{draft.commentCount} comments · restore draft</span></button>)}</section>}</> : <>
      <p className="break-all text-xs text-muted-foreground">Reviewing: {doc.key} · round {doc.round ?? 1} · full current draft</p>
      <details open={!session}><summary className="cursor-pointer text-sm">Comments to address ({selectedIds.length})</summary>{doc.threads.filter((t) => t.status === "open").map((t) => <label key={t.id} className="mt-2 flex gap-2 text-sm"><input type="checkbox" checked={!excluded.includes(t.id)} onChange={(e) => setExcluded(e.target.checked ? excluded.filter((id) => id !== t.id) : [...excluded, t.id])} />{t.messages[0]?.text}</label>)}</details>
      {!session && <p className="text-sm text-muted-foreground">First, the agent plans how to address your comments. Confirm the plan to generate changes, then accept or reject each change.</p>}
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
        <section className="rounded-lg border border-border p-3 text-sm"><strong>Plan {session.plan.version}</strong><p className="mt-2 whitespace-pre-wrap">{session.plan.summary}</p><ol className="my-2 list-decimal space-y-2 pl-5">{session.plan.steps.map((step, i) => <li key={i}><p>{step.proposedChange}</p><p className="text-xs text-muted-foreground">{step.rationale}</p></li>)}</ol>{session.plan.dispositions.map((d) => <p key={d.commentId} className="mt-1 text-xs">{d.reason}</p>)}{session.plan.blockingQuestions.map((q, i) => <p key={i} className="mt-2 font-medium">Question: {q}</p>)}{session.plan.revisionSummary && <p className="mt-2 text-xs">{session.plan.revisionSummary}</p>}</section>
        {session.messages.at(-1)?.role === "assistant" && session.confirmedVersion && <p className="whitespace-pre-wrap text-sm">{session.messages.at(-1)!.text}</p>}
        {session.phase === "stale" && <p role="status" className="text-sm text-destructive">The document or comments changed. Send a request to refresh the plan.</p>}
        {session.phase === "awaiting_confirmation" && contextChanged && <p className="text-sm">Comments or references changed. Send a request to refresh the plan.</p>}
        {session.phase === "awaiting_confirmation" && <button className={button} disabled={!!r.busy || !!session.plan.blockingQuestions.length || r.recovery || contextChanged} onClick={() => void r.generate("generate", "Confirm the current plan and generate changes.")}>Confirm plan & generate changes</button>}
        {!!suggestions.length && <><p className="text-xs">{pending.length} pending · {suggestions.filter((s) => s.status === "conflicted").length} conflicted · {suggestions.filter((s) => s.status === "accepted").length} accepted · {suggestions.filter((s) => s.status === "rejected").length} rejected</p><div className="flex flex-wrap gap-1"><button className={button} disabled={!pending.length || !!r.busy || r.recovery} onClick={() => void r.action("decision", { ids: pending.map((s) => s.id), decision: "accept" })}>Accept all remaining</button><button className={button} disabled={!pending.length || !!r.busy} onClick={() => void r.action("decision", { ids: pending.map((s) => s.id), decision: "reject" })}>Reject all remaining</button><button className={button} disabled={!doc.undo.length || !!r.busy} onClick={() => void r.action("undo")}>Undo acceptance</button></div></>}
        {suggestions.map((s, i) => s.status !== "superseded" && <ReviewSuggestionCard key={s.id} suggestion={s} number={i + 1} />)}
        {session.phase === "completed" && <p className="text-sm">Review decisions complete. Save when ready; unresolved comments remain open.</p>}
      </>}
      </>}
      {(r.error || error) && <p role="alert" className="text-sm text-destructive">{r.error || error} <button className={button} onClick={() => void r.reload()}>Reload review</button></p>}
      {!!r.busy && <p role="status" className="text-sm">{r.busy === "plan" ? "Planning…" : ["generate", "revise"].includes(r.busy) ? "Generating proposed changes…" : "Saving review…"} {["plan", "generate", "revise"].includes(r.busy) && <button className={button} onClick={r.stop}>Stop</button>}</p>}
    </div>
    <form className="shrink-0 space-y-2 border-t border-border p-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      {references.map((ref) => <div key={ref.path} className="flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate" title={ref.path}>@{ref.name}</span><button type="button" className={button} aria-label={`Remove reference ${ref.name}`} onClick={() => setReferences(references.filter((r) => r.path !== ref.path))}>×</button></div>)}
      <ChatFileComposer chatId={`review-${doc?.id}-${doc?.round ?? 1}`} value={prompt} disabled={!doc || !!r.busy} files={files} tabs={tabs} composerRef={input} onChange={setPrompt} onLoading={setAttachmentBusy} onError={setError} onSend={() => void send()} onAttach={(ref) => setReferences([...references.filter((r) => r.path !== ref.path), ref])} />
      <button className={button} disabled={!doc || !!r.busy || attachmentBusy || (!prompt.trim() && !selectedIds.length)}>{session ? "Send review request" : "Plan review"}</button>
    </form>
  </aside>;
}
