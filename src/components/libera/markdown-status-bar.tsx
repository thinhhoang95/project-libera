"use client";

import { memo } from "react";
import { wordCountStatItems } from "@/lib/markdown-word-count";
import { useWordCount } from "./use-word-count";

const countFormatter = new Intl.NumberFormat();

export const MarkdownStatusBar = memo(function MarkdownStatusBar({ content, uploading = false }: { content: string; uploading?: boolean }) {
  const stats = useWordCount(content);

  return (
    <div role="status" aria-label="Document word counts" aria-live="off" className="libera-document-status flex shrink-0 items-center gap-4 overflow-x-auto whitespace-nowrap border-t border-border px-4 py-1.5 text-xs tabular-nums text-muted-foreground">
      {uploading && <span role="status">Uploading images…</span>}
      {wordCountStatItems(stats).map((item) => (
        <span key={item.label}>{item.label}: {countFormatter.format(item.value)}{item.suffix ?? ""}</span>
      ))}
    </div>
  );
});
