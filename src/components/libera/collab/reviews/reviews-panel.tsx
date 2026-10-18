"use client";

// The Reviews section of a shared document's Comments rail (plan M3.5): the
// document's review requests with their scope, note and status, each
// reviewer's decision bound to the revision they read, "changed since you
// approved" when the scope moved on, and Close. An assignee opens a review
// in checkpoint mode: the frozen base revision with "N changes since this
// revision" and a diff to now, while everyone keeps drafting live.

import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, ClipboardCheck, Clock, History, Loader2, X } from "lucide-react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import type { SharedDocSession } from "@/lib/collab/client/registry";
import { consumeReviewOpen, pendingReviewOpen, subscribeReviewOpen, type ReviewsController, type ReviewsSnapshot } from "@/lib/collab/client/reviews";
import type { Review, ReviewAssignment, UserSummary } from "@/lib/collab/protocol/api";
import { roleAtLeast, type Role } from "@/lib/collab/protocol/roles";
import { describeError } from "@/lib/collab/ui/client";
import { timeAgo } from "@/lib/collab/ui/wording";
import { loadProjectMembers } from "../mentions/mention-textarea";
import { attributeUpdates, contentUpdates, DiffView, historyApi, RevisionView, type Attribution, type HistoryApi } from "../history";
import { useReviews } from "./use-reviews";

const buttonClass = "inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50";

const STATUS: Record<Review["status"], string> = {
  open: "Open",
  approved: "Approved",
  "changes-requested": "Changes requested",
  closed: "Closed",
};

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** "N changes since this revision" (the server counts updates that changed the scope's text). */
export function changesSinceLabel(review: Pick<Review, "changesSinceBase">): string {
  return review.changesSinceBase ? `${plural(review.changesSinceBase, "change")} since this revision` : "No changes since this revision";
}

function decisionLabel(assignment: ReviewAssignment, me: string | null): string {
  const mine = assignment.reviewer.id === me;
  if (assignment.decision === "pending") return mine ? "Waiting for you" : "Waiting";
  const verb = assignment.decision === "approved" ? "Approved" : "Requested changes";
  return assignment.outdated ? `${verb} · ${mine ? "changed since you approved" : "changed since"}` : verb;
}

/** A reviewer's line: decision, outdated badge, and when. */
function AssignmentLine({ assignment, me, now }: { assignment: ReviewAssignment; me: string | null; now: number }) {
  const decided = assignment.decidedAt ? Date.parse(assignment.decidedAt) : NaN;
  return <li className="flex items-center gap-1.5 text-xs" data-reviewer={assignment.reviewer.id} data-decision={assignment.decision} data-outdated={assignment.outdated || undefined}>
    {assignment.decision === "approved" ? <Check aria-hidden className="h-3.5 w-3.5 text-green-600" /> : assignment.decision === "changes-requested" ? <X aria-hidden className="h-3.5 w-3.5 text-amber-600" /> : <Clock aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />}
    <span className="font-medium" style={{ color: assignment.reviewer.color || undefined }}>{assignment.reviewer.displayName}</span>
    <span className="text-muted-foreground">{decisionLabel(assignment, me)}</span>
    {assignment.outdated ? <span className="rounded bg-amber-500/15 px-1 text-[10px] font-medium text-amber-700 dark:text-amber-300" data-testid="review-outdated">outdated</span> : null}
    {Number.isFinite(decided) ? <span className="ml-auto text-[11px] text-muted-foreground" title={new Date(decided).toLocaleString()}>{timeAgo(Math.max(0, now - decided))}</span> : null}
  </li>;
}

function DecisionButtons({ review, controller, snapshot, revisionId, compact }: { review: Review; controller: ReviewsController; snapshot: ReviewsSnapshot; revisionId?: string; compact?: boolean }) {
  const [comment, setComment] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  const pending = snapshot.pending[review.id];
  const decide = async (decision: "approved" | "changes-requested") => {
    setError("");
    try {
      await controller.decide(review.id, decision, { ...(revisionId ? { revisionId } : {}), comment });
      setComment("");
      setAsking(false);
    } catch (cause) {
      setError(describeError(cause));
    }
  };
  if (pending) {
    return <p role="status" className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="review-pending">
      <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
      {pending.decision === "approved" ? "Approving…" : "Requesting changes…"}{pending.phase === "queued" ? " (offline, sends when connected)" : ""}
    </p>;
  }
  return <div className="space-y-1">
    {asking ? <textarea aria-label="What should change?" className="review-textarea" rows={2} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="What should change? (optional)" /> : null}
    <div className="flex flex-wrap gap-1">
      <button type="button" className={`${buttonClass} text-green-700 dark:text-green-300`} data-action="approve" onClick={() => void decide("approved")}><Check aria-hidden className="h-3.5 w-3.5" />{compact ? "Approve" : "Approve this revision"}</button>
      {asking
        ? <button type="button" className={`${buttonClass} text-amber-700 dark:text-amber-300`} data-action="request-changes" onClick={() => void decide("changes-requested")}>Send: request changes</button>
        : <button type="button" className={`${buttonClass} text-amber-700 dark:text-amber-300`} data-action="ask-changes" onClick={() => setAsking(true)}><X aria-hidden className="h-3.5 w-3.5" />Request changes</button>}
    </div>
    {error || snapshot.failed[review.id] ? <p role="alert" className="text-xs text-destructive">{error || snapshot.failed[review.id]}</p> : null}
  </div>;
}

function ReviewCard({ review, controller, snapshot, role, now, onOpen }: { review: Review; controller: ReviewsController; snapshot: ReviewsSnapshot; role: Role | null; now: number; onOpen: () => void }) {
  const me = snapshot.localUserId;
  const mine = review.assignments.find((assignment) => assignment.reviewer.id === me);
  const canClose = review.status !== "closed" && (review.requestedBy.id === me || (!!role && roleAtLeast(role, "editor")));
  const [error, setError] = useState("");
  const created = Date.parse(review.createdAt);
  return <li className="libera-review-request rounded-lg border border-border bg-card px-2.5 py-2 text-sm" data-review-id={review.id} data-status={review.status}>
    <div className="flex items-center gap-1.5 text-xs">
      <ClipboardCheck aria-hidden className="h-3.5 w-3.5 shrink-0" style={{ color: review.requestedBy.color }} />
      <span className="min-w-0 truncate font-medium">{review.requestedBy.id === me ? "You" : review.requestedBy.displayName} asked for a review</span>
      <span className="ml-auto shrink-0 text-muted-foreground" data-testid="review-status">{STATUS[review.status]}</span>
    </div>
    <p className="mt-1 text-xs text-muted-foreground">{review.scope.kind === "document" ? "Whole document" : <>Passage: <q>{review.scope.quote.length > 120 ? `${review.scope.quote.slice(0, 117)}…` : review.scope.quote}</q></>}{Number.isFinite(created) ? ` · ${timeAgo(Math.max(0, now - created))}` : ""}</p>
    {review.note ? <p className="mt-1 whitespace-pre-wrap text-xs">{review.note}</p> : null}
    <ul className="mt-1.5 space-y-0.5">{review.assignments.map((assignment) => <AssignmentLine key={assignment.reviewer.id} assignment={assignment} me={me} now={now} />)}</ul>
    {review.status !== "closed" ? <p className="mt-1 text-[11px] text-muted-foreground" data-testid="review-changes">{review.changesSinceBase ? `${plural(review.changesSinceBase, "change")} in scope since the review started` : "No changes in scope since the review started"}</p> : null}
    <div className="mt-1.5 flex flex-wrap gap-1">
      {mine && review.status !== "closed" ? <button type="button" className={buttonClass} data-action="open-review" onClick={onOpen}><History aria-hidden className="h-3.5 w-3.5" />Open review</button> : null}
      {canClose ? <button type="button" className={buttonClass} data-action="close-review" onClick={() => { setError(""); controller.close(review.id).catch((cause: unknown) => setError(describeError(cause))); }}>Close review</button> : null}
    </div>
    {mine && review.status !== "closed" ? <div className="mt-1.5"><DecisionButtons review={review} controller={controller} snapshot={snapshot} compact /></div> : null}
    {error ? <p role="alert" className="mt-1 text-xs text-destructive">{error}</p> : null}
  </li>;
}

/**
 * Checkpoint mode: the review's base revision, frozen, with how much the
 * scope changed since and a diff to now. Decisions made here are bound to
 * that revision.
 */
export function ReviewCheckpoint({ review, session, controller, snapshot, onClose, api = historyApi }: { review: Review; session: SharedDocSession; controller: ReviewsController; snapshot: ReviewsSnapshot; onClose: () => void; api?: HistoryApi }) {
  const docId = session.docId;
  const [base, setBase] = useState<{ text: string; serverSeq: number } | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [diff, setDiff] = useState<{ before: string; attribution: Attribution } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api.content(docId, review.baseRevisionId).then(
      (content) => { if (live) setBase({ text: content.text, serverSeq: content.revision.serverSeq }); },
      (cause: unknown) => { if (live) setError(describeError(cause)); },
    );
    return () => { live = false; };
  }, [api, docId, review.baseRevisionId]);
  useEffect(() => {
    if (!showDiff || !base) return;
    let live = true;
    (async () => {
      const members = await loadProjectMembers(session.resolved.projectId).catch(() => []);
      const users = new Map(members.map((member) => [member.id, member as UserSummary]));
      const page = await contentUpdates(api, docId, null);
      if (live) setDiff({ before: base.text, attribution: attributeUpdates(page, base.serverSeq, null, users) });
    })().catch((cause: unknown) => { if (live) setError(describeError(cause)); });
    return () => { live = false; };
  }, [api, docId, base, showDiff, session.resolved.projectId]);
  const current = controller.review(review.id) ?? review;
  const mine = current.assignments.find((assignment) => assignment.reviewer.id === snapshot.localUserId);
  return <ModalDialog open title="Review" description={`${session.resolved.path} · as it was when the review was requested`} panelClassName="max-w-4xl w-full" onClose={onClose} footer={<button className="rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted" type="button" onClick={onClose}>Close</button>}>
    <div className="space-y-2" data-testid="review-checkpoint">
      <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs" data-testid="review-checkpoint-banner">
        <History aria-hidden size={14} />
        <span>{changesSinceLabel(current)}. Collaborators keep editing the live document; you are reading the revision the review was requested on.</span>
        <button type="button" className={`${buttonClass} ml-auto`} aria-pressed={showDiff} onClick={() => setShowDiff((value) => !value)}>{showDiff ? "Show the revision" : "Show changes since"}</button>
      </div>
      {current.note ? <p className="whitespace-pre-wrap text-xs"><strong>Note:</strong> {current.note}</p> : null}
      {current.scope.kind === "range" ? <p className="text-xs text-muted-foreground">Scope: <q>{current.scope.quote}</q></p> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {!base ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />Loading the revision…</p>
        : showDiff ? (diff ? <DiffView attribution={diff.attribution} before={diff.before} /> : <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />Comparing…</p>)
          : <RevisionView text={base.text} onSelection={() => {}} />}
      {mine && current.status !== "closed" ? <DecisionButtons review={current} controller={controller} snapshot={snapshot} revisionId={current.baseRevisionId} /> : null}
    </div>
  </ModalDialog>;
}

export function ReviewsPanel({ session }: { session: SharedDocSession }) {
  const { controller, snapshot } = useReviews(session);
  const [openId, setOpenId] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const request = useSyncExternalStore(subscribeReviewOpen, pendingReviewOpen, () => null);
  // A notification asked to open one of this document's reviews: an
  // assignee gets it in checkpoint mode, anyone else sees it listed.
  const requested = request && request.docId === session.docId ? request : null;
  const [handledSeq, setHandledSeq] = useState(0);
  const target = requested && requested.seq !== handledSeq ? snapshot?.reviews?.find((review) => review.id === requested.reviewId) : undefined;
  if (requested && target) {
    setHandledSeq(requested.seq);
    if (target.status !== "closed" && target.assignments.some((assignment) => assignment.reviewer.id === snapshot?.localUserId)) setOpenId(target.id);
  }
  useEffect(() => {
    if (!requested || !snapshot?.reviews) return;
    if (requested.seq === handledSeq) consumeReviewOpen(requested.seq);
    // Not in the list yet (the notification came first): read it again once.
    else if (!snapshot.reviews.some((review) => review.id === requested.reviewId)) void controller?.load().then(() => consumeReviewOpen(requested.seq));
  }, [requested, handledSeq, snapshot?.reviews, controller]);
  if (!controller || !snapshot) return null;
  const role = session.replica.getSnapshot().meta?.role ?? session.resolved.role;
  const reviews = snapshot.reviews ?? [];
  const open = reviews.filter((review) => review.status !== "closed");
  const closed = reviews.filter((review) => review.status === "closed");
  const shown = openId ? reviews.find((review) => review.id === openId) ?? null : null;
  return <section className="libera-reviews-panel flex min-h-0 flex-1 flex-col" aria-label="Reviews" data-doc={snapshot.docId}>
    <ul className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2" aria-label="Review requests">
      {snapshot.reviews === null ? <li className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground"><Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />Loading reviews…</li>
        : !reviews.length ? <li className="px-1 py-6 text-center text-sm text-muted-foreground">{snapshot.canRequest ? "No reviews yet. Use Request review… in the tab bar to ask collaborators." : "No reviews of this document yet."}</li>
          : [...open, ...closed].map((review) => <ReviewCard key={review.id} review={review} controller={controller} snapshot={snapshot} role={role} now={now} onOpen={() => setOpenId(review.id)} />)}
    </ul>
    {snapshot.error ? <p role="alert" className="border-t border-border px-3 py-1.5 text-xs text-destructive">{snapshot.error}</p> : null}
    <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground" aria-live="polite">{open.length} open</p>
    {shown ? <ReviewCheckpoint key={shown.id} review={shown} session={session} controller={controller} snapshot={snapshot} onClose={() => setOpenId(null)} /> : null}
  </section>;
}
