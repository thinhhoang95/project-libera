import type { StrokeOptions } from "perfect-freehand";
import { isHexColor, isInkBrush, isInkLineStyle, type InkBrush, type InkLineStyle } from "@/lib/ink/types";

/*
 * Brushes, tip widths and pen presets. Widths here are on-screen sizes at
 * 100% zoom (CSS px, which is 1 pt on a PDF at 100%); a stroke stores its
 * width in surface units, converted when it starts (`widthInUnits`). Tuning
 * values are provisional until stylus hardware is tried (docs/ink-plan.md).
 */

export type InkToolStyle = {
  brush: InkBrush;
  color: `#${string}`;
  width: number;
  lineStyle: InkLineStyle;
  opacity: number;
};

export type InkEraserMode = "stroke" | "partial";

export const INK_WIDTH_PRESETS: Record<InkBrush, readonly number[]> = {
  pen: [0.35, 0.5, 0.7, 1, 1.5, 2.5],
  marker: [1, 2, 4, 6],
  highlighter: [8, 12, 18],
};

export const INK_MIN_WIDTH = 0.25;
export const INK_MAX_WIDTH = 40;

export const INK_DEFAULT_STYLES: Record<InkBrush, InkToolStyle> = {
  pen: { brush: "pen", color: "#1f2328", width: 1, lineStyle: "solid", opacity: 1 },
  marker: { brush: "marker", color: "#d92d20", width: 2, lineStyle: "solid", opacity: 1 },
  highlighter: { brush: "highlighter", color: "#ffe45c", width: 12, lineStyle: "solid", opacity: 0.35 },
};

/** Eraser radius in CSS px. */
export const INK_ERASER_RADII = [4, 8, 16, 32] as const;
export const INK_DEFAULT_ERASER_RADIUS = 8;

export const MAX_INK_PRESETS = 8;

/** Ink width in surface units for an on-screen width, given CSS px per unit at the current zoom. */
export function widthInUnits(cssWidth: number, cssPxPerUnit: number) {
  return cssPxPerUnit > 0 ? cssWidth / cssPxPerUnit : cssWidth;
}

/**
 * `perfect-freehand` options for a brush. `size` is the tip's diameter; the
 * pen thins with light pressure, the marker and highlighter keep their width.
 */
export function strokeOptions(brush: string, width: number, complete: boolean, simulatePressure = false): StrokeOptions {
  if (brush === "marker") {
    return { size: width, thinning: 0, smoothing: 0.5, streamline: 0.4, simulatePressure: false, last: complete };
  }
  if (brush === "highlighter") {
    return { size: width, thinning: 0, smoothing: 0.6, streamline: 0.5, simulatePressure: false, start: { cap: false }, end: { cap: false }, last: complete };
  }
  // Pens (and brushes this version does not know).
  return {
    size: width * 1.6,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.35,
    simulatePressure,
    easing: (pressure) => Math.sin((pressure * Math.PI) / 2),
    start: { taper: 0, cap: true },
    end: { taper: 0, cap: true },
    last: complete,
  };
}

/** `setLineDash` pattern for a line style, in the same units as `width`. */
export function dashPattern(lineStyle: InkLineStyle, width: number): number[] {
  if (lineStyle === "dashed") return [width * 3, width * 2.5];
  // Zero-length dashes with round caps are dots.
  if (lineStyle === "dotted") return [0, width * 2.2];
  return [];
}

export function clampInkWidth(width: number) {
  return Math.min(INK_MAX_WIDTH, Math.max(INK_MIN_WIDTH, width));
}

/** A tool style read from preferences, or null when it is not one. */
export function normalizeInkToolStyle(value: unknown): InkToolStyle | null {
  if (typeof value !== "object" || value === null) return null;
  const { brush, color, width, lineStyle, opacity } = value as Record<string, unknown>;
  if (!isInkBrush(brush) || !isHexColor(color) || typeof width !== "number" || !Number.isFinite(width)) return null;
  return {
    brush,
    color,
    width: clampInkWidth(width),
    lineStyle: isInkLineStyle(lineStyle) ? lineStyle : "solid",
    opacity: typeof opacity === "number" && Number.isFinite(opacity) ? Math.min(1, Math.max(0.05, opacity)) : INK_DEFAULT_STYLES[brush].opacity,
  };
}

/** Saved pens: at most `MAX_INK_PRESETS`, malformed ones dropped. */
export function normalizeInkPresets(value: unknown): InkToolStyle[] {
  return (Array.isArray(value) ? value : []).map(normalizeInkToolStyle).filter((style): style is InkToolStyle => style !== null).slice(0, MAX_INK_PRESETS);
}
