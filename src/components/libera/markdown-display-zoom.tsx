"use client";

import { ZoomIn } from "lucide-react";
import { useMarkdownDisplayPreferences } from "./markdown-display-preferences";

type Props = {
  markdownBaseFontSize: number;
  markdownZoom: number;
  onMarkdownZoomChange: (zoom: number) => void;
};

export function MarkdownDisplayZoom({ markdownBaseFontSize, markdownZoom, onMarkdownZoomChange }: Props) {
  const { flushPreferences } = useMarkdownDisplayPreferences();
  const markdownFontSize = markdownBaseFontSize * (markdownZoom / 100);
  const formattedFontSize = Number.isInteger(markdownFontSize)
    ? String(markdownFontSize)
    : markdownFontSize.toFixed(1);

  return (
    <label
      aria-label={`Rendered Markdown text size: ${formattedFontSize}px at ${markdownZoom}% zoom`}
      className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-border bg-muted px-3 text-sm font-medium text-foreground"
      title={`Rendered Markdown text size: ${formattedFontSize}px at ${markdownZoom}% zoom`}
    >
      <ZoomIn aria-hidden className="h-4 w-4" />
      <input
        className="h-2 w-32 accent-foreground"
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
      <span className="min-w-20 text-right tabular-nums">
        {markdownZoom}% / {formattedFontSize}px
      </span>
    </label>
  );
}
