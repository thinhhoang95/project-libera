"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { SharedDocSession } from "@/lib/collab/client/registry";
import { reviewsFor, type ReviewsController, type ReviewsSnapshot } from "@/lib/collab/client/reviews";

const noopSubscribe = () => () => {};
const nullSnapshot = () => null;

/** The document's reviews controller and snapshot (null without a shared session); loads the list once mounted. */
export function useReviews(session: SharedDocSession | null): { controller: ReviewsController | null; snapshot: ReviewsSnapshot | null } {
  const replica = session?.replica ?? null;
  // One controller per replica; the session object changes on content rebuilds.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const controller = useMemo(() => (session ? reviewsFor(session) : null), [replica]);
  useEffect(() => {
    if (controller && !controller.getSnapshot().reviews) void controller.load();
  }, [controller]);
  const snapshot = useSyncExternalStore(controller?.subscribe ?? noopSubscribe, controller?.getSnapshot ?? nullSnapshot, nullSnapshot);
  return { controller, snapshot };
}
