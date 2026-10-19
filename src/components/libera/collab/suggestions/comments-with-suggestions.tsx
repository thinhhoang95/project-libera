"use client";

// The Comments rail of a shared document gains Suggestions and Reviews tabs.
// Files that are not shared show the comments exactly as before.

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { useSharedTab } from "@/lib/collab/bindings/react-shared-tabs";
import { pendingReviewOpen, subscribeReviewOpen } from "@/lib/collab/client/reviews";
import { ReviewsPanel } from "../reviews/reviews-panel";
import { useReviews } from "../reviews/use-reviews";
import { SuggestionsPanel } from "./suggestions-panel";
import { useSuggestions } from "./use-suggestions";

const tabClass = "inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-xs font-medium aria-selected:bg-muted aria-selected:text-foreground text-muted-foreground hover:text-foreground";
const badgeClass = "rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground";

type RailView = "comments" | "suggestions" | "reviews";

export function CommentsWithSuggestions({ tabId, comments }: { tabId?: string; comments: ReactNode }) {
  const shared = useSharedTab(tabId, "suggestions-rail");
  const session = shared.snapshot?.attached ? shared.session : null;
  const { controller, snapshot } = useSuggestions(session);
  const { snapshot: reviews } = useReviews(session);
  const [chosen, setView] = useState<RailView>("comments");
  // A notification that opens one of this document's reviews shows the Reviews tab.
  const request = useSyncExternalStore(subscribeReviewOpen, pendingReviewOpen, () => null);
  const [seenRequest, setSeenRequest] = useState(0);
  if (session && request && request.docId === session.docId && request.seq !== seenRequest) {
    setSeenRequest(request.seq);
    setView("reviews");
  }
  // A Reply gesture (in the panel or inline in an editor) shows its box here.
  const view: RailView = snapshot?.replyingTo ? "suggestions" : chosen;
  if (!session) return <>{comments}</>;
  const open = snapshot?.groups.filter((group) => group.state !== "decided").length ?? 0;
  const me = reviews?.localUserId;
  const waiting = reviews?.reviews?.filter((review) => review.status !== "closed" && review.assignments.some((assignment) => assignment.reviewer.id === me && (assignment.decision === "pending" || assignment.outdated))).length ?? 0;
  const choose = (next: RailView) => { if (next !== "suggestions") controller?.cancelReply(); setView(next); };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="Comments, suggestions and reviews" className="flex gap-1 border-b border-border px-2 py-1.5">
        <button type="button" role="tab" aria-selected={view === "comments"} className={tabClass} onClick={() => choose("comments")}>Comments</button>
        <button type="button" role="tab" aria-selected={view === "suggestions"} className={tabClass} onClick={() => choose("suggestions")}>
          Suggestions
          {open ? <span className={badgeClass}>{open}</span> : null}
        </button>
        <button type="button" role="tab" aria-selected={view === "reviews"} className={tabClass} onClick={() => choose("reviews")}>
          Reviews
          {waiting ? <span className={badgeClass} title="Reviews waiting for you">{waiting}</span> : null}
        </button>
      </div>
      {view === "comments" ? comments : view === "suggestions" ? <SuggestionsPanel session={session} /> : <ReviewsPanel session={session} />}
    </div>
  );
}
