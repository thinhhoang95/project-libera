"use client";

import { ListChecks, ListX } from "lucide-react";

const button = "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40";

/** Icon-button pair for the search bar of a file/folder selector. */
export function FileSelectionActions({ onSelectAll, onClear }: { onSelectAll: () => void; onClear: () => void }) {
  return <div className="flex items-center gap-0.5">
    <button type="button" className={button} title="Select all" aria-label="Select all" onClick={onSelectAll}><ListChecks aria-hidden className="h-4 w-4" /></button>
    <button type="button" className={button} title="Clear selection" aria-label="Clear selection" onClick={onClear}><ListX aria-hidden className="h-4 w-4" /></button>
  </div>;
}
