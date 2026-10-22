"use client";

import { Braces } from "lucide-react";
import { mayUseMarkdownMacros } from "@/lib/markdown-macros";

/**
 * Expand macros: opens the document as plain Markdown in a new, unsaved tab,
 * with every macro and counter replaced and the macro blocks removed
 * (docs/features/markdown-macros.md). The document itself is unchanged.
 */
export function ExpandMacrosButton({ className, markdown, getMarkdown, onExpand }: {
  className: string;
  /** The current draft, to tell whether the document uses macros. */
  markdown: string;
  /** The latest text at click time (the Visual editor serializes it). */
  getMarkdown: () => string;
  onExpand?: (markdown: string) => void;
}) {
  if (!onExpand) return null;
  const available = mayUseMarkdownMacros(markdown);
  const title = available ? "Expand macros: open a copy as plain Markdown in a new tab" : "Expand macros (this document has no macros or counters)";
  return (
    <button type="button" aria-label="Expand macros into a new tab" title={title} className={className} disabled={!available}
      onMouseDown={(event) => event.preventDefault()} onClick={() => onExpand(getMarkdown())}>
      <Braces aria-hidden className="h-4 w-4" />
    </button>
  );
}
