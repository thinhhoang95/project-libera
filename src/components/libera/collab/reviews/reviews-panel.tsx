"use client";

// The Reviews section of a shared document's Comments rail (plan M3.5): the
// document's review requests with their scope, note and status, each
// reviewer's decision bound to the revision they read, "changed since you
// approved" when the scope moved on, and Close. An assignee opens a review
// in checkpoint mode: the frozen base revision with "N changes since this
// revision" and a diff to now, while everyone keeps drafting live.

import { isPdfDocId } from "@/lib/collab/protocol/pdf";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, ClipboardCheck, Clock, History, Loader2, X } from "lucide-react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import type { SharedDocSession } from "@/lib/collab/client/registry";
import { consumeReviewOpen, pendingReviewOpen, subscribeReviewOpen, type ReviewsController, type ReviewsSnapshot } from "@/lib/collab/client/reviews";
import type { Review, ReviewAssignment, UserSummary } from "@/lib/collab/protocol/api";
import { roleAtLeast, type Role } from "@/lib/collab/protocol/roles";
import { useDescribeError } from "@/lib/collab/ui/use-describe-error";
import { timeAgo } from "@/lib/collab/ui/wording";
import { dateTimeFormat } from "@/lib/i18n/format";
import { ListFilterButton, ShowMoreButton, usePagedList } from "../../list-controls";
import { loadProjectMembers } from "../mentions/mention-textarea";
import { attributeUpdates, contentUpdates, DiffView, historyApi, RevisionView, type Attribution, type HistoryApi } from "../history";
import { useReviews } from "./use-reviews";

// The same buttons and cards as the Comments tab (markdown-review-ui.tsx).
const buttonClass = "review-button";

type ReviewStatusFilter = "all" | "open" | "closed";

type Translate = (key: string, values?: Record<string, string | number>) => string;

const STATUS_KEY: Record<Review["status"], string> = {
  open: "open",
  approved: "approved",
  "changes-requested": "changesRequested",
  closed: "closed",
};

/** "N changes since this revision" (the server counts updates that changed the scope's text). `t`: the `collab.reviews.reviewsPanel` messages. */
export function changesSinceLabel(review: Pick<Review, "changesSinceBase">, t: Translate): string {
  return t("changesSince", { count: review.changesSinceBase ?? 0 });
}

function decisionLabel(assignment: ReviewAssignment, me: string | null, t: Translate): string {
  const mine = assignment.reviewer.id === me;
  if (assignment.decision === "pending") return mine ? t("waitingForYou") : t("waiting");
  return t("decision", { decision: assignment.decision, outdated: assignment.outdated ? (mine ? "mine" : "yes") : "no" });
}

/** A reviewer's line: decision, outdated badge, and when. */
function AssignmentLine({ assignment, me, now }: { assignment: ReviewAssignment; me: string | null; now: number }) {
  const t = useTranslations("collab.reviews.reviewsPanel");
  const tWording = useTranslations("lib.collab.ui.wording");
  const locale = useLocale();
  const decided = assignment.decidedAt ? Date.parse(assignment.decidedAt) : NaN;
  return <li className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs" data-reviewer={assignment.reviewer.id} data-decision={assignment.decision} data-outdated={assignment.outdated || undefined}>
    {assignment.decision === "approved" ? <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-green-600" /> : assignment.decision === "changes-requested" ? <X aria-hidden className="h-3.5 w-3.5 shrink-0 text-amber-600" /> : <Clock aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
    <span className="min-w-0 max-w-full truncate font-medium" title={assignment.reviewer.displayName} style={{ color: assignment.reviewer.color || undefined }}>{assignment.reviewer.displayName}</span>
    <span className="text-muted-foreground">{decisionLabel(assignment, me, t)}</span>
    {assignment.outdated ? <span className="rounded bg-amber-500/15 px-1 text-[10px] font-medium text-amber-700 dark:text-amber-300" data-testid="review-outdated">{t("outdated")}</span> : null}
    {Number.isFinite(decided) ? <span className="ml-auto text-[11px] text-muted-foreground" title={dateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(decided)}>{timeAgo(Math.max(0, now - decided), tWording)}</span> : null}
  </li>;
}

function DecisionButtons({ review, controller, snapshot, revisionId, compact }: { review: Review; controller: ReviewsController; snapshot: ReviewsSnapshot; revisionId?: string; compact?: boolean }) {
  const t = useTranslations("collab.reviews.reviewsPanel");
  const describeError = useDescribeError();
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
      {t(`pending.${pending.decision === "approved" ? "approving" : "requesting"}${pending.phase === "queued" ? "Queued" : ""}`)}
    </p>;
  }
  return <div className="space-y-1">
    {asking ? <textarea aria-label={t("whatShouldChange")} className="review-textarea" rows={2} value={comment} onChange={(event) => setComment(event.target.value)} placeholder={t("whatShouldChangeOptional")} /> : null}
    <div className="flex flex-wrap gap-1">
      <button type="button" className={`${buttonClass} text-green-700 dark:text-green-300`} data-action="approve" onClick={() => void decide("approved")}><Check aria-hidden className="h-3.5 w-3.5" />{compact ? t("approve") : t("approveRevision")}</button>
      {asking
        ? <button type="button" className={`${buttonClass} text-amber-700 dark:text-amber-300`} data-action="request-changes" onClick={() => void decide("changes-requested")}>{t("sendRequestChanges")}</button>
        : <button type="button" className={`${buttonClass} text-amber-700 dark:text-amber-300`} data-action="ask-changes" onClick={() => setAsking(true)}><X aria-hidden className="h-3.5 w-3.5" />{t("requestChanges")}</button>}
    </div>
    {error || snapshot.failed[review.id] ? <p role="alert" className="text-xs text-destructive">{error || snapshot.failed[review.id]}</p> : null}
  </div>;
}

function ReviewCard({ review, controller, snapshot, role, now, onOpen }: { review: Review; controller: ReviewsController; snapshot: ReviewsSnapshot; role: Role | null; now: number; onOpen: () => void }) {
  const t = useTranslations("collab.reviews.reviewsPanel");
  const tWording = useTranslations("lib.collab.ui.wording");
  const describeError = useDescribeError();
  const me = snapshot.localUserId;
  const mine = review.assignments.find((assignment) => assignment.reviewer.id === me);
  const canClose = review.status !== "closed" && (review.requestedBy.id === me || (!!role && roleAtLeast(role, "editor")));
  const [error, setError] = useState("");
  const created = Date.parse(review.createdAt);
  return <li className="libera-review-request review-comment-card libera-panel-card p-3 text-[13px]" data-review-id={review.id} data-status={review.status}>
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
      <span className="flex min-w-0 max-w-full items-center gap-1.5">
        <ClipboardCheck aria-hidden className="h-3.5 w-3.5 shrink-0" style={{ color: review.requestedBy.color }} />
        <span className="min-w-0 truncate font-medium">{t("askedForReview", { you: review.requestedBy.id === me ? "yes" : "no", name: review.requestedBy.displayName })}</span>
      </span>
      <span className="ml-auto min-w-0 max-w-full truncate text-muted-foreground" data-testid="review-status">{t(`status.${STATUS_KEY[review.status]}`)}</span>
    </div>
    <p className="mt-1 text-xs text-muted-foreground">{review.scope.kind === "document" ? t("wholeDocument") : t.rich("passage", { quote: review.scope.quote.length > 120 ? `${review.scope.quote.slice(0, 117)}…` : review.scope.quote, q: (chunks) => <q>{chunks}</q> })}{Number.isFinite(created) ? ` · ${timeAgo(Math.max(0, now - created), tWording)}` : ""}</p>
    {review.note ? <p className="mt-1 whitespace-pre-wrap text-xs">{review.note}</p> : null}
    <ul className="mt-1.5 space-y-0.5">{review.assignments.map((assignment) => <AssignmentLine key={assignment.reviewer.id} assignment={assignment} me={me} now={now} />)}</ul>
    {review.status !== "closed" ? <p className="mt-1 text-[11px] text-muted-foreground" data-testid="review-changes">{t("changesInScope", { count: review.changesSinceBase ?? 0 })}</p> : null}
    <div className="mt-1.5 flex flex-wrap gap-1">
      {mine && review.status !== "closed" ? <button type="button" className={buttonClass} data-action="open-review" onClick={onOpen}><History aria-hidden className="h-3.5 w-3.5" />{t("openReview")}</button> : null}
      {canClose ? <button type="button" className={buttonClass} data-action="close-review" onClick={() => { setError(""); controller.close(review.id).catch((cause: unknown) => setError(describeError(cause))); }}>{t("closeReview")}</button> : null}
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
  const t = useTranslations("collab.reviews.reviewsPanel");
  const tCommon = useTranslations("common");
  const tAttribution = useTranslations("collab.history.attribution");
  const describeError = useDescribeError();
  // A PDF has no text to show as it was: its reviewer reads it in the viewer.
  const pdf = isPdfDocId(docId);
  const [base, setBase] = useState<{ text: string; serverSeq: number } | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [diff, setDiff] = useState<{ before: string; attribution: Attribution } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (pdf) return;
    let live = true;
    api.content(docId, review.baseRevisionId).then(
      (content) => { if (live) setBase({ text: content.text, serverSeq: content.revision.serverSeq }); },
      (cause: unknown) => { if (live) setError(describeError(cause)); },
    );
    return () => { live = false; };
  }, [api, docId, pdf, review.baseRevisionId, describeError]);
  useEffect(() => {
    if (!showDiff || !base) return;
    let live = true;
    (async () => {
      const members = await loadProjectMembers(session.resolved.projectId).catch(() => []);
      const users = new Map(members.map((member) => [member.id, member as UserSummary]));
      const page = await contentUpdates(api, docId, null);
      if (live) setDiff({ before: base.text, attribution: attributeUpdates(page, base.serverSeq, null, users, tAttribution) });
    })().catch((cause: unknown) => { if (live) setError(describeError(cause)); });
    return () => { live = false; };
  }, [api, docId, base, showDiff, session.resolved.projectId, describeError, tAttribution]);
  const current = controller.review(review.id) ?? review;
  const mine = current.assignments.find((assignment) => assignment.reviewer.id === snapshot.localUserId);
  return <ModalDialog open title={t("checkpointTitle")} description={t("checkpointDescription", { path: session.resolved.path })} panelClassName="max-w-4xl w-full" onClose={onClose} footer={<button className="rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted" type="button" onClick={onClose}>{tCommon("close")}</button>}>
    <div className="space-y-2" data-testid="review-checkpoint">
      <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs" data-testid="review-checkpoint-banner">
        <History aria-hidden size={14} />
        {pdf
          ? <span>{t("pdfCovers")}</span>
          : <>
            <span>{t("checkpointBanner", { changes: changesSinceLabel(current, t) })}</span>
            <button type="button" className={`${buttonClass} ml-auto`} aria-pressed={showDiff} onClick={() => setShowDiff((value) => !value)}>{showDiff ? t("showRevision") : t("showChangesSince")}</button>
          </>}
      </div>
      {current.note ? <p className="whitespace-pre-wrap text-xs"><strong>{t("note")}</strong> {current.note}</p> : null}
      {current.scope.kind === "range" ? <p className="text-xs text-muted-foreground">{t.rich("scope", { quote: current.scope.quote, q: (chunks) => <q>{chunks}</q> })}</p> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {pdf ? null : !base ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />{t("loadingRevision")}</p>
        : showDiff ? (diff ? <DiffView attribution={diff.attribution} before={diff.before} /> : <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />{t("comparing")}</p>)
          : <RevisionView text={base.text} onSelection={() => {}} />}
      {mine && current.status !== "closed" ? <DecisionButtons review={current} controller={controller} snapshot={snapshot} revisionId={current.baseRevisionId} /> : null}
    </div>
  </ModalDialog>;
}

export function ReviewsPanel({ session }: { session: SharedDocSession }) {
  const { controller, snapshot } = useReviews(session);
  const t = useTranslations("collab.reviews.reviewsPanel");
  const [openId, setOpenId] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const [status, setStatus] = useState<ReviewStatusFilter>("all");
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
  const reviews = snapshot?.reviews ?? [];
  const open = reviews.filter((review) => review.status !== "closed");
  const closed = reviews.filter((review) => review.status === "closed");
  const listed = status === "open" ? open : status === "closed" ? closed : [...open, ...closed];
  const page = usePagedList(listed, status);
  if (!controller || !snapshot) return null;
  const role = session.replica.getSnapshot().meta?.role ?? session.resolved.role;
  const shown = openId ? reviews.find((review) => review.id === openId) ?? null : null;
  return <section className="libera-reviews-panel flex min-h-0 flex-1 flex-col" aria-label={t("title")} data-doc={snapshot.docId}>
    <div className="flex items-center gap-1 border-b border-border px-3 py-2">
      <span className="min-w-0 flex-1 text-xs font-semibold">{t("reviewRequests")}</span>
      <ListFilterButton label={t("filter")} groups={[{ label: t("filterStatus"), value: status, defaultValue: "all", onChange: (value) => setStatus(value as ReviewStatusFilter), options: [
        { value: "all", label: t("filterAll"), count: reviews.length },
        { value: "open", label: t("status.open"), count: open.length },
        { value: "closed", label: t("status.closed"), count: closed.length },
      ] }]} />
    </div>
    <ul className="min-h-0 flex-1 space-y-2 overflow-auto px-3 pb-4 pt-3" aria-label={t("reviewRequests")}>
      {snapshot.reviews === null ? <li className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground"><Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />{t("loadingReviews")}</li>
        : !reviews.length ? <li className="rounded-lg border border-dashed border-input px-4 py-8 text-center text-sm text-muted-foreground">{snapshot.canRequest ? t("emptyCanRequest") : t("empty")}</li>
          : !listed.length ? <li className="rounded-lg border border-dashed border-input px-4 py-3 text-sm text-muted-foreground">{t("noneOfStatus", { status })}</li>
            : page.visible.map((review) => <ReviewCard key={review.id} review={review} controller={controller} snapshot={snapshot} role={role} now={now} onOpen={() => setOpenId(review.id)} />)}
      {page.remaining > 0 ? <li><ShowMoreButton remaining={page.remaining} onClick={page.showMore} /></li> : null}
    </ul>
    {snapshot.error ? <p role="alert" className="border-t border-border px-3 py-1.5 text-xs text-destructive">{snapshot.error}</p> : null}
    <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground" aria-live="polite">{t("openCount", { count: open.length })}</p>
    {shown ? <ReviewCheckpoint key={shown.id} review={shown} session={session} controller={controller} snapshot={snapshot} onClose={() => setOpenId(null)} /> : null}
  </section>;
}
