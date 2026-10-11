"use client";

import { EditorView } from "@codemirror/view";
import { Check, ChevronDown, ChevronUp, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { decideReviewHunks, type AiChangeSource, type ReviewHunk } from "@/lib/latex/codemirror/review";

const SOURCE_LABELS: Record<AiChangeSource, string> = { rewrite: "AI Rewrite", write: "Write with AI", format: "AI Format" };
const navClass = "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground";

/** Summary of proposed AI changes with navigation and Accept/Reject all. */
export function LatexChangeBar({ view, hunks }: { view: EditorView; hunks: ReviewHunk[] }) {
  const [index, setIndex] = useState(0);
  const current = Math.min(index, hunks.length - 1);
  const sources = [...new Set(hunks.map((hunk) => hunk.source))];
  const title = sources.length === 1 ? SOURCE_LABELS[sources[0]] : "AI changes";

  function reveal(next: number) {
    const target = (next + hunks.length) % hunks.length;
    setIndex(target);
    view.dispatch({ selection: { anchor: hunks[target].from }, effects: EditorView.scrollIntoView(hunks[target].from, { y: "center" }) });
    view.focus();
  }

  return (
    <div role="toolbar" aria-label="Proposed changes" className="libera-change-bar absolute bottom-4 left-1/2 z-20 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-1 rounded-xl border border-border bg-card p-1 pl-3 text-sm shadow-lg">
      <Sparkles aria-hidden className="h-4 w-4 shrink-0 text-accent" />
      <span className="mr-1 min-w-0 truncate font-medium">{title}</span>
      <button type="button" className={navClass} aria-label="Previous change" title="Previous change" onClick={() => reveal(current - 1)}><ChevronUp aria-hidden className="h-4 w-4" /></button>
      <span aria-live="polite" className="min-w-14 whitespace-nowrap text-center text-xs tabular-nums text-muted-foreground">{current + 1} of {hunks.length}</span>
      <button type="button" className={navClass} aria-label="Next change" title="Next change" onClick={() => reveal(current + 1)}><ChevronDown aria-hidden className="h-4 w-4" /></button>
      <button type="button" className="libera-change-bar-reject ml-1 inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md px-2.5 font-medium" title="Reject all changes (⌘/Ctrl+Shift+Backspace)"
        onMouseDown={(event) => event.preventDefault()} onClick={() => { decideReviewHunks(view, "all", "reject"); view.focus(); }}><X aria-hidden className="h-3.5 w-3.5" />Reject all</button>
      <button type="button" className="libera-change-bar-accept inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md px-2.5 font-medium" title="Accept all changes (⌘/Ctrl+Shift+Enter)"
        onMouseDown={(event) => event.preventDefault()} onClick={() => { decideReviewHunks(view, "all", "accept"); view.focus(); }}><Check aria-hidden className="h-3.5 w-3.5" />Accept all</button>
    </div>
  );
}
