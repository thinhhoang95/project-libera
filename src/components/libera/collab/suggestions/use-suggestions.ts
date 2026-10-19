"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { SharedDocSession } from "@/lib/collab/client/registry";
import { suggestionsFor, type SuggestionsController, type SuggestionsSnapshot } from "@/lib/collab/client/suggestions";

const noopSubscribe = () => () => {};
const nullSnapshot = () => null;

/** The document's suggestions controller and its current snapshot (null without a shared session). */
export function useSuggestions(session: SharedDocSession | null): { controller: SuggestionsController | null; snapshot: SuggestionsSnapshot | null } {
  const replica = session?.replica ?? null;
  // One controller per replica; the session object changes on content rebuilds.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const controller = useMemo(() => (session ? suggestionsFor(session) : null), [replica]);
  const snapshot = useSyncExternalStore(controller?.subscribe ?? noopSubscribe, controller?.getSnapshot ?? nullSnapshot, nullSnapshot);
  return { controller, snapshot };
}
