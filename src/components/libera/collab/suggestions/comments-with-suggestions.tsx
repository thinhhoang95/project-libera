"use client";

// The Comments rail of a shared document gains a Suggestions tab. Files that
// are not shared show the comments exactly as before.

import { useState, type ReactNode } from "react";
import { useSharedTab } from "@/lib/collab/bindings/react-shared-tabs";
import { SuggestionsPanel } from "./suggestions-panel";
import { useSuggestions } from "./use-suggestions";

const tabClass = "inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-xs font-medium aria-selected:bg-muted aria-selected:text-foreground text-muted-foreground hover:text-foreground";

export function CommentsWithSuggestions({ tabId, comments }: { tabId?: string; comments: ReactNode }) {
  const shared = useSharedTab(tabId, "suggestions-rail");
  const session = shared.snapshot?.attached ? shared.session : null;
  const { snapshot } = useSuggestions(session);
  const [view, setView] = useState<"comments" | "suggestions">("comments");
  if (!session) return <>{comments}</>;
  const open = snapshot?.groups.filter((group) => group.state !== "decided").length ?? 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="Comments and suggestions" className="flex gap-1 border-b border-border px-2 py-1.5">
        <button type="button" role="tab" aria-selected={view === "comments"} className={tabClass} onClick={() => setView("comments")}>Comments</button>
        <button type="button" role="tab" aria-selected={view === "suggestions"} className={tabClass} onClick={() => setView("suggestions")}>
          Suggestions
          {open ? <span className="rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground">{open}</span> : null}
        </button>
      </div>
      {view === "comments" ? comments : <SuggestionsPanel session={session} />}
    </div>
  );
}
