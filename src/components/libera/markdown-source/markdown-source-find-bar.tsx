"use client";

import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

/* Both Markdown Source editors use these controls, labels and keys,
 * including Wildcards, together with useMarkdownSourceFind. */

const ICON_BUTTON = "inline-flex h-8 w-8 items-center justify-center rounded text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40";
const TEXT_BUTTON = "h-8 rounded px-2 text-xs text-foreground hover:bg-muted disabled:opacity-40";

export function MarkdownSourceFindBar({
  activeIndex,
  findInputRef,
  matchCount,
  query,
  replacement,
  wildcards,
  onClose,
  onNext,
  onPrevious,
  onQueryChange,
  onReplace,
  onReplaceAll,
  onReplacementChange,
  onWildcardsChange,
}: {
  activeIndex: number;
  findInputRef: RefObject<HTMLInputElement | null>;
  matchCount: number;
  query: string;
  replacement: string;
  wildcards: boolean;
  onClose: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onQueryChange: (query: string) => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onReplacementChange: (replacement: string) => void;
  onWildcardsChange: (wildcards: boolean) => void;
}) {
  const current = matchCount ? Math.min(activeIndex + 1, matchCount) : 0;

  function handleFindKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) onPrevious();
      else onNext();
    }
  }

  function handleReplaceKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Enter") {
      event.preventDefault();
      onReplace();
    }
  }

  return (
    <div className="absolute right-3 top-3 z-20 flex w-[30rem] max-w-[calc(100%-1.5rem)] flex-col gap-1 rounded-lg border border-border bg-card p-1 shadow-lg">
      <div className="flex min-w-0 items-center gap-1">
        <Search aria-hidden className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          ref={findInputRef}
          aria-label="Find in note"
          className="h-8 min-w-24 flex-1 border-0 px-1 text-sm outline-none"
          value={query}
          placeholder="Find in note"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={handleFindKeyDown}
        />
        <span className="min-w-16 text-center text-xs text-muted-foreground">{query ? `${current}/${matchCount}` : "0/0"}</span>
        <button className={ICON_BUTTON} type="button" aria-label="Previous match" title="Previous match" disabled={!matchCount} onClick={onPrevious}>
          <ChevronUp aria-hidden className="h-4 w-4" />
        </button>
        <button className={ICON_BUTTON} type="button" aria-label="Next match" title="Next match" disabled={!matchCount} onClick={onNext}>
          <ChevronDown aria-hidden className="h-4 w-4" />
        </button>
        <button className={ICON_BUTTON} type="button" aria-label="Close find" title="Close" onClick={onClose}>
          <X aria-hidden className="h-4 w-4" />
        </button>
      </div>
      <div className="flex min-w-0 items-center gap-1 pl-7">
        <input
          aria-label="Replace with"
          className="h-8 min-w-20 flex-1 rounded border border-border bg-background px-2 text-sm outline-none"
          value={replacement}
          placeholder="Replace with"
          onChange={(event) => onReplacementChange(event.target.value)}
          onKeyDown={handleReplaceKeyDown}
        />
        <button type="button" className={TEXT_BUTTON} disabled={!matchCount} onClick={onReplace}>Replace</button>
        <button type="button" className={TEXT_BUTTON} disabled={!matchCount} onClick={onReplaceAll}>Replace all</button>
        <label className="flex shrink-0 items-center gap-1 px-1 text-xs text-muted-foreground" title="Use * for any text and ? for one character">
          <input type="checkbox" aria-label="Wildcard matches" checked={wildcards} onChange={(event) => onWildcardsChange(event.target.checked)} />
          Wildcards
        </label>
      </div>
    </div>
  );
}
