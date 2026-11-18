"use client";

import { useState, type KeyboardEvent as ReactKeyboardEvent, type Ref, type UIEvent } from "react";
import type { QueryPart, ReplacementPart } from "@/lib/find";

/* A find or replace field that draws holes and references as coloured chips.
 * The text is typed in a transparent input/textarea; a mirror behind it holds
 * the same text with backgrounds, kept scrolled with the field. */

const GROUP_COLORS = [
  "bg-sky-400/30",
  "bg-amber-400/35",
  "bg-emerald-400/30",
  "bg-fuchsia-400/30",
  "bg-rose-400/30",
  "bg-violet-400/30",
];

export function groupColor(group: number) {
  return GROUP_COLORS[(Math.max(1, group) - 1) % GROUP_COLORS.length];
}

type Highlight = { from: number; to: number; className: string };

export function queryHighlights(parts: readonly QueryPart[]): Highlight[] {
  return parts.flatMap((part): Highlight[] => {
    if (part.kind === "hole") return [{ from: part.from, to: part.to, className: `${groupColor(part.group)} rounded-sm${part.backref ? " outline outline-1 outline-current/40" : ""}` }];
    if (part.kind === "escape" || part.kind === "space") return [{ from: part.from, to: part.to, className: "bg-muted rounded-sm" }];
    if (part.kind === "error") return [{ from: part.from, to: part.to, className: "underline decoration-wavy decoration-red-500" }];
    return [];
  });
}

export function replacementHighlights(parts: readonly ReplacementPart[]): Highlight[] {
  return parts.flatMap((part): Highlight[] => {
    if (part.kind === "ref") return [{ from: part.from, to: part.to, className: `${groupColor(part.group)} rounded-sm` }];
    if (part.kind === "expression") return [{ from: part.from, to: part.to, className: `${part.groups.length ? groupColor(part.groups[0]) : "bg-muted"} rounded-sm` }];
    if (part.kind === "counter" || part.kind === "escape") return [{ from: part.from, to: part.to, className: "bg-muted rounded-sm" }];
    if (part.kind === "error") return [{ from: part.from, to: part.to, className: "underline decoration-wavy decoration-red-500" }];
    return [];
  });
}

function mirrorPieces(value: string, highlights: readonly Highlight[]) {
  const pieces: { text: string; className?: string }[] = [];
  let at = 0;
  for (const highlight of [...highlights].sort((a, b) => a.from - b.from)) {
    if (highlight.from < at) continue;
    if (highlight.from > at) pieces.push({ text: value.slice(at, highlight.from) });
    pieces.push({ text: value.slice(highlight.from, highlight.to), className: highlight.className });
    at = highlight.to;
  }
  if (at < value.length) pieces.push({ text: value.slice(at) });
  // A trailing line break needs a character after it to take up a line.
  pieces.push({ text: "​" });
  return pieces;
}

const FIELD_TEXT = "font-mono text-[13px] leading-5 tracking-normal";

export function FindField({
  value,
  onChange,
  onKeyDown,
  highlights,
  multiline = false,
  label,
  placeholder,
  inputRef,
  textareaRef,
  invalid = false,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  highlights: readonly Highlight[];
  multiline?: boolean;
  label: string;
  placeholder?: string;
  inputRef?: Ref<HTMLInputElement>;
  textareaRef?: Ref<HTMLTextAreaElement>;
  invalid?: boolean;
  className?: string;
}) {
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const onScroll = (event: UIEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const target = event.currentTarget;
    setScroll({ left: target.scrollLeft, top: target.scrollTop });
  };
  const rows = multiline ? Math.min(6, value.split("\n").length) : 1;
  const shell = `relative min-w-0 flex-1 overflow-hidden rounded border bg-background ${invalid ? "border-red-500/70" : "border-border"} ${className}`;
  const padding = "px-2 py-1.5";
  const pieces = highlights.length ? mirrorPieces(value, highlights) : null;
  return (
    <div className={shell}>
      {pieces ? (
        <div aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden ${padding} ${FIELD_TEXT} text-transparent ${multiline ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}>
          <div style={{ transform: `translate(${-scroll.left}px, ${-scroll.top}px)` }}>
            {pieces.map((piece, index) => piece.className
              ? <span key={index} className={piece.className}>{piece.text}</span>
              : <span key={index}>{piece.text}</span>)}
          </div>
        </div>
      ) : null}
      {multiline ? (
        <textarea
          ref={textareaRef}
          aria-label={label}
          aria-invalid={invalid || undefined}
          className={`relative block w-full resize-none border-0 bg-transparent ${padding} ${FIELD_TEXT} text-foreground outline-none`}
          rows={rows}
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onScroll={onScroll}
        />
      ) : (
        <input
          ref={inputRef}
          aria-label={label}
          aria-invalid={invalid || undefined}
          className={`relative block h-8 w-full border-0 bg-transparent ${padding} ${FIELD_TEXT} text-foreground outline-none`}
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onScroll={onScroll}
        />
      )}
    </div>
  );
}
