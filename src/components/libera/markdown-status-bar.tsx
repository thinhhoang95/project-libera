"use client";

import { memo, useMemo, type ReactNode } from "react";
import { getMarkdownWordCountStats, wordCountStatItems } from "@/lib/markdown-word-count";
import { useHorizontalToolbarScroll } from "./use-horizontal-toolbar-scroll";
import { useWordCount } from "./use-word-count";

const countFormatter = new Intl.NumberFormat();

type Props = {
  content: string;
  /** The selected text, when there is a selection: Words then reads selected/total. */
  selectedText?: string;
  uploading?: boolean;
  /** Controls at the right end, e.g. the text zoom. */
  trailing?: ReactNode;
  /** A shared note's sync status and people, after a separator. */
  collab?: ReactNode;
};

export const MarkdownStatusBar = memo(function MarkdownStatusBar({ content, selectedText, uploading = false, trailing, collab }: Props) {
  const stats = useWordCount(content);
  const selectedItems = useMemo(() => (selectedText?.trim() ? wordCountStatItems(getMarkdownWordCountStats(selectedText)) : null), [selectedText]);
  // A bar wider than the pane scrolls with the mouse wheel, without a scrollbar.
  const scrollRef = useHorizontalToolbarScroll();

  return (
    <div ref={scrollRef} className="libera-document-status libera-horizontal-toolbar flex shrink-0 items-center gap-4 overflow-x-auto whitespace-nowrap border-t border-border px-4 py-1.5 text-xs tabular-nums text-muted-foreground">
      <div role="status" aria-label="Document word counts" aria-live="off" className="flex shrink-0 items-center gap-[inherit]">
        {uploading && <span role="status">Uploading images…</span>}
        {wordCountStatItems(stats).map((item, index) => (
          <span key={item.label}>{item.label}: {selectedItems && !item.suffix ? `${countFormatter.format(selectedItems[index].value)}/` : ""}{countFormatter.format(item.value)}{item.suffix ?? ""}</span>
        ))}
      </div>
      {trailing || collab ? (
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {trailing}
          {trailing && collab ? <span aria-hidden className="h-4 w-px shrink-0 bg-border" /> : null}
          {collab ? <div className="flex shrink-0 items-center gap-2" data-shared-status="">{collab}</div> : null}
        </div>
      ) : null}
    </div>
  );
});
