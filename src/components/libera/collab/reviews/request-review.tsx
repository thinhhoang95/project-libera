"use client";

// "Request review…" in the tab bar of a shared document, next to the Review
// mode toggle (plan M3.5). Editors and owners pick the scope (the whole
// document, or the passage selected in the editor, anchored so it follows
// edits), the reviewers among the notebook's members, an optional note, and
// whether agentic review should run first, as the requester.

import { useState } from "react";
import { ClipboardCheck } from "lucide-react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import { useMarkdownReview } from "@/components/libera/markdown-review-context";
import { useSharedTab } from "@/lib/collab/bindings/react-shared-tabs";
import { can } from "@/lib/collab/protocol/roles";
import { describeError } from "@/lib/collab/ui/client";
import type { ReviewRange } from "@/lib/markdown-review";
import { useProjectMembers } from "../mentions/mention-textarea";
import { useReviews } from "./use-reviews";

const AI_FIRST_PROMPT = "Review this draft before my reviewers read it: plan how to address the open comments, and point out unclear or unsupported passages.";

export function RequestReviewButton({ tabId }: { tabId?: string }) {
  const shared = useSharedTab(tabId, "request-review");
  const session = shared.snapshot?.attached ? shared.session : null;
  const role = shared.snapshot?.meta?.role ?? session?.resolved.role ?? null;
  const review = useMarkdownReview();
  const [open, setOpen] = useState<{ selection: ReviewRange | null } | null>(null);
  if (!session || !role || !can(role, "request-review")) return null;
  return <>
    <button
      type="button"
      className="inline-flex h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted-foreground hover:bg-muted"
      title="Ask collaborators to review this document"
      // The editor's selection is read before focus moves to the dialog.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => setOpen({ selection: review?.editorSelection() ?? null })}
    ><ClipboardCheck aria-hidden size={15} />Request review…</button>
    {open ? <RequestReviewDialog key={tabId} session={session} selection={open.selection} onClose={() => setOpen(null)} /> : null}
  </>;
}

function RequestReviewDialog({ session, selection, onClose }: { session: NonNullable<ReturnType<typeof useSharedTab>["session"]>; selection: ReviewRange | null; onClose: () => void }) {
  const { controller, snapshot } = useReviews(session);
  const review = useMarkdownReview();
  const members = useProjectMembers(session.resolved.projectId);
  const others = members.filter((member) => member.id !== snapshot?.localUserId && member.role !== "viewer");
  const [scope, setScope] = useState<"document" | "selection">(selection ? "selection" : "document");
  const [assignees, setAssignees] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [aiFirst, setAiFirst] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const quote = selection ? session.replica.text().slice(selection.start, selection.end) : "";

  async function submit() {
    if (!controller) return;
    setBusy(true);
    setError("");
    try {
      await controller.request({ ...(scope === "selection" && selection ? { range: selection } : {}), assignees, note });
      if (aiFirst && review) {
        // Agentic review runs as the requester, on the comments still open.
        review.setChatReview(true);
        const open = review.doc?.threads.filter((thread) => thread.status === "open").map((thread) => thread.id) ?? [];
        if (open.length) void review.generate("plan", note.trim() || AI_FIRST_PROMPT, open);
      }
      onClose();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return <ModalDialog open title="Request review" description={session.resolved.path} onClose={onClose} footer={<>
    <button type="button" className="rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted" onClick={onClose}>Cancel</button>
    <button type="button" className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50" disabled={busy || !assignees.length || (scope === "selection" && !selection)} onClick={() => void submit()}>Request review</button>
  </>}>
    <form className="space-y-3 text-sm" aria-label="Review request" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <fieldset className="space-y-1">
        <legend className="text-xs font-semibold">What to review</legend>
        <label className="flex items-center gap-2"><input type="radio" name="review-scope" checked={scope === "document"} onChange={() => setScope("document")} />The whole document</label>
        <label className="flex items-start gap-2"><input type="radio" name="review-scope" disabled={!selection} checked={scope === "selection"} onChange={() => setScope("selection")} />
          <span>The selected passage{selection ? <q className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{quote}</q> : <span className="block text-xs text-muted-foreground">Select text in the editor first.</span>}</span>
        </label>
      </fieldset>
      <fieldset className="space-y-1">
        <legend className="text-xs font-semibold">Reviewers</legend>
        {others.length ? others.map((member) => <label key={member.id} className="flex items-center gap-2">
          <input type="checkbox" checked={assignees.includes(member.id)} onChange={(event) => setAssignees((current) => event.target.checked ? [...current, member.id] : current.filter((id) => id !== member.id))} />
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: member.color }} />{member.displayName}<span className="text-xs text-muted-foreground">{member.role}</span>
        </label>) : <p className="text-xs text-muted-foreground">Invite someone to this notebook to ask them for a review.</p>}
      </fieldset>
      <label className="block space-y-1"><span className="text-xs font-semibold">Note (optional)</span>
        <textarea aria-label="Note for the reviewers" className="review-textarea" rows={3} maxLength={5000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="What should they look at?" />
      </label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={aiFirst} onChange={(event) => setAiFirst(event.target.checked)} />Run AI review first (agentic review, as you)</label>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </form>
  </ModalDialog>;
}
