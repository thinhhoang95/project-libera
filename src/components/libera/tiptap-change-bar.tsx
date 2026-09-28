"use client";

import { useState } from "react";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { Selection } from "@tiptap/pm/state";
import { Check, ChevronDown, ChevronUp, Sparkles, X } from "lucide-react";
import { decideTiptapChanges, tiptapChangeUnits, tiptapChangesKey, type ChangeSource, type TrackedChange } from "@/lib/tiptap-changes";

const NO_CHANGES: TrackedChange[] = [];
const SOURCE_LABELS: Record<ChangeSource, string> = { rewrite: "AI Rewrite", write: "Write with AI", format: "AI Format", image: "AI Image to Markdown", review: "Agentic review" };
const navClass = "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground";

/** Summary of proposed changes with navigation and Accept/Reject all. */
export function TiptapChangeBar({ editor }: { editor: Editor }) {
  const changes = useEditorState({
    editor,
    selector: ({ editor: current }) => tiptapChangesKey.getState(current.state)?.changes ?? NO_CHANGES,
    // Plugin state is immutable; a deep comparison would walk every fragment.
    equalityFn: (a, b) => a === b,
  });
  const [index, setIndex] = useState(0);
  const units = tiptapChangeUnits(changes);
  if (!units.length) return null;
  const current = Math.min(index, units.length - 1);
  const sources = [...new Set(units.map((unit) => unit.source))];
  const title = sources.length === 1 ? SOURCE_LABELS[sources[0]] : "AI changes";

  function reveal(next: number) {
    const target = (next + units.length) % units.length;
    const { state, view } = editor;
    setIndex(target);
    view.dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(Math.min(units[target].from, state.doc.content.size)))).scrollIntoView());
    view.focus();
  }

  return <div role="toolbar" aria-label="Proposed changes" className="libera-change-bar absolute bottom-4 left-1/2 z-20 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-1 rounded-xl border border-border bg-card p-1 pl-3 text-sm shadow-lg">
    <Sparkles aria-hidden className="h-4 w-4 shrink-0 text-accent" />
    <span className="mr-1 min-w-0 truncate font-medium">{title}</span>
    <button type="button" className={navClass} aria-label="Previous change" title="Previous change" onClick={() => reveal(current - 1)}><ChevronUp aria-hidden className="h-4 w-4" /></button>
    <span aria-live="polite" className="min-w-14 whitespace-nowrap text-center text-xs tabular-nums text-muted-foreground">{current + 1} of {units.length}</span>
    <button type="button" className={navClass} aria-label="Next change" title="Next change" onClick={() => reveal(current + 1)}><ChevronDown aria-hidden className="h-4 w-4" /></button>
    <button type="button" className="libera-change-bar-reject ml-1 inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md px-2.5 font-medium" title="Reject all changes (⌘/Ctrl+Shift+Backspace)"
      onMouseDown={(event) => event.preventDefault()} onClick={() => decideTiptapChanges(editor.view, "all", "reject")}><X aria-hidden className="h-3.5 w-3.5" />Reject all</button>
    <button type="button" className="libera-change-bar-accept inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md px-2.5 font-medium" title="Accept all changes (⌘/Ctrl+Shift+Enter)"
      onMouseDown={(event) => event.preventDefault()} onClick={() => decideTiptapChanges(editor.view, "all", "accept")}><Check aria-hidden className="h-3.5 w-3.5" />Accept all</button>
  </div>;
}
