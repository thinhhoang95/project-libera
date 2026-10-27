"use client";

import { ZoomIn } from "lucide-react";
import { useMarkdownDisplayPreferences } from "./markdown-display-preferences";

type Props = {
  markdownBaseFontSize: number;
  markdownZoom: number;
  onMarkdownZoomChange: (zoom: number) => void;
  /** A smaller control sized for the document status bar. */
  compact?: boolean;
};

export function MarkdownDisplayZoom({ markdownBaseFontSize, markdownZoom, onMarkdownZoomChange, compact = false }: Props) {
  const { flushPreferences } = useMarkdownDisplayPreferences();
  const markdownFontSize = markdownBaseFontSize * (markdownZoom / 100);
  const formattedFontSize = Number.isInteger(markdownFontSize)
    ? String(markdownFontSize)
    : markdownFontSize.toFixed(1);

  return (
    <label
      aria-label={`Rendered Markdown text size: ${formattedFontSize}px at ${markdownZoom}% zoom`}
      className={compact
        ? "inline-flex shrink-0 items-center gap-2 text-xs text-muted-foreground"
        : "inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-border bg-muted px-3 text-sm font-medium text-foreground"}
      title={`Rendered Markdown text size: ${formattedFontSize}px at ${markdownZoom}% zoom`}
    >
      <ZoomIn aria-hidden className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
      <input
        className={compact ? "h-1.5 w-24 accent-foreground" : "h-2 w-32 accent-foreground"}
        type="range"
        min="75"
        max="150"
        step="5"
        value={markdownZoom}
        aria-label="Rendered Markdown text zoom"
        onChange={(event) => onMarkdownZoomChange(Number(event.target.value))}
        onPointerUp={flushPreferences}
        onPointerCancel={flushPreferences}
        onKeyUp={flushPreferences}
        onBlur={flushPreferences}
      />
      {/* The status bar shows the zoom alone; the pixel size stays in the title. */}
      <span className={compact ? "min-w-9 text-right tabular-nums" : "min-w-20 text-right tabular-nums"}>
        {compact ? `${markdownZoom}%` : `${markdownZoom}% / ${formattedFontSize}px`}
      </span>
    </label>
  );
}
