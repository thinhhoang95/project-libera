"use client";

import { ZoomIn } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useMarkdownDisplayPreferenceActions } from "./markdown-display-preferences";

type Props = {
  markdownBaseFontSize: number;
  markdownZoom: number;
  onMarkdownZoomChange: (zoom: number) => void;
  /** A smaller control sized for the document status bar. */
  compact?: boolean;
  /** What the zoom sizes, for its labels: rendered Markdown (the default) or a text file's editor. */
  subject?: "markdown" | "text";
};

export function MarkdownDisplayZoom({ markdownBaseFontSize, markdownZoom, onMarkdownZoomChange, compact = false, subject = "markdown" }: Props) {
  const t = useTranslations("markdownDisplayZoom");
  const format = useFormatter();
  const { flushPreferences } = useMarkdownDisplayPreferenceActions();
  const markdownFontSize = markdownBaseFontSize * (markdownZoom / 100);
  const formattedFontSize = format.number(markdownFontSize, { maximumFractionDigits: 1 });
  const sizeLabel = t(subject === "text" ? "textSizeLabel" : "sizeLabel", { size: formattedFontSize, zoom: markdownZoom / 100 });

  return (
    <label
      aria-label={sizeLabel}
      className={compact
        ? "inline-flex shrink-0 items-center gap-2 text-xs text-muted-foreground"
        : "inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-border bg-muted px-3 text-sm font-medium text-foreground"}
      title={sizeLabel}
    >
      <ZoomIn aria-hidden className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
      <input
        className={compact ? "h-1.5 w-24 accent-foreground" : "h-2 w-32 accent-foreground"}
        type="range"
        min="75"
        max="250"
        step="5"
        value={markdownZoom}
        aria-label={t(subject === "text" ? "textZoomLabel" : "zoomLabel")}
        onChange={(event) => onMarkdownZoomChange(Number(event.target.value))}
        onPointerUp={flushPreferences}
        onPointerCancel={flushPreferences}
        onKeyUp={flushPreferences}
        onBlur={flushPreferences}
      />
      {/* The status bar shows the zoom alone; the pixel size stays in the title. */}
      <span className={compact ? "min-w-9 text-right tabular-nums" : "min-w-20 text-right tabular-nums"}>
        {compact ? format.number(markdownZoom / 100, { style: "percent" }) : t("zoomValue", { zoom: markdownZoom / 100, size: formattedFontSize })}
      </span>
    </label>
  );
}
