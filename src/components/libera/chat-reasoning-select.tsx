"use client";

import { useRef, useState } from "react";
import { CHAT_REASONING_EFFORTS, isChatReasoningEffort, type ChatReasoningEffort } from "@/lib/document-chat";

/** Pixels of horizontal drag per reasoning level. */
const DRAG_STEP = 22;
/** Less movement than this is a click, however unsteady. */
const DRAG_THRESHOLD = 3;

export function effortAfterDrag(start: ChatReasoningEffort, deltaX: number) {
  const index = CHAT_REASONING_EFFORTS.indexOf(start) + Math.round(deltaX / DRAG_STEP);
  return CHAT_REASONING_EFFORTS[Math.max(0, Math.min(CHAT_REASONING_EFFORTS.length - 1, index))];
}

/**
 * The composer's reasoning effort. Drag sideways to step through the levels, or
 * click for the list. A select opens its list on mouse down, before a drag can
 * be told from a click, so that is held back and a click opens it on release.
 */
export function ChatReasoningSelect({ value, disabled, onChange }: { value: ChatReasoningEffort; disabled?: boolean; onChange: (effort: ChatReasoningEffort) => void }) {
  const drag = useRef<{ x: number; start: ChatReasoningEffort; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  return <select
    aria-label="Reasoning effort"
    title="Reasoning effort: drag sideways to change it, or click to choose"
    data-dragging={dragging || undefined}
    className="w-auto max-w-24 cursor-ew-resize touch-pan-y select-none appearance-none border-0 bg-transparent px-1 py-2 text-xs text-muted-foreground shadow-none outline-none hover:text-foreground focus-visible:underline data-[dragging]:text-foreground"
    value={value}
    disabled={disabled}
    onChange={(event) => { if (isChatReasoningEffort(event.target.value)) onChange(event.target.value); }}
    onMouseDown={(event) => { if (event.button === 0) event.preventDefault(); }}
    onPointerDown={(event) => {
      if (event.button !== 0 || disabled) return;
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, start: value, moved: false };
    }}
    onPointerMove={(event) => {
      const current = drag.current;
      if (!current) return;
      const deltaX = event.clientX - current.x;
      if (!current.moved && Math.abs(deltaX) < DRAG_THRESHOLD) return;
      if (!current.moved) {
        current.moved = true;
        setDragging(true);
      }
      const next = effortAfterDrag(current.start, deltaX);
      if (next !== value) onChange(next);
    }}
    onPointerUp={(event) => {
      const moved = drag.current?.moved;
      drag.current = null;
      setDragging(false);
      if (moved === false) event.currentTarget.showPicker();
    }}
    onPointerCancel={() => {
      drag.current = null;
      setDragging(false);
    }}
  >{CHAT_REASONING_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort === "xhigh" ? "Extra High" : effort[0].toUpperCase() + effort.slice(1)}</option>)}</select>;
}
