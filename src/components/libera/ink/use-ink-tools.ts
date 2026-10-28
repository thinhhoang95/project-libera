"use client";

import { useSyncExternalStore } from "react";
import {
  INK_DEFAULT_ERASER_RADIUS,
  INK_DEFAULT_STYLES,
  INK_ERASER_RADII,
  MAX_INK_PRESETS,
  normalizeInkPresets,
  normalizeInkToolStyle,
  type InkEraserMode,
  type InkToolStyle,
} from "@/lib/ink/tools";
import { INK_BRUSHES, type InkBrush } from "@/lib/ink/types";

/*
 * The ink tools, shared by every ink surface in the window: the brush in
 * hand, each brush's last style, the eraser and the saved pens. Kept in
 * local storage, which is each Libera user's own (docs/features/users.md).
 */

/** "select" is the lasso: select strokes to move, recolor, copy or delete. */
export type InkTool = InkBrush | "eraser" | "select";

export type InkToolsState = {
  tool: InkTool;
  /** The brush the eraser returns to. */
  lastBrush: InkBrush;
  styles: Record<InkBrush, InkToolStyle>;
  eraserMode: InkEraserMode;
  eraserRadius: number;
  presets: InkToolStyle[];
  drawWithFinger: boolean;
  /** Samples as they arrive (pointerrawupdate) instead of once a frame: less lag, more wakeups. */
  lowLatency: boolean;
};

const STORAGE_KEY = "libera.ink.tools.v1";

const DEFAULTS: InkToolsState = {
  tool: "pen",
  lastBrush: "pen",
  styles: { ...INK_DEFAULT_STYLES },
  eraserMode: "stroke",
  eraserRadius: INK_DEFAULT_ERASER_RADIUS,
  presets: [],
  drawWithFinger: false,
  lowLatency: false,
};

function read(): InkToolsState {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "null") as Partial<Record<keyof InkToolsState, unknown>> | null;
    if (!value || typeof value !== "object") return DEFAULTS;
    const styles = { ...DEFAULTS.styles };
    for (const brush of INK_BRUSHES) {
      const style = normalizeInkToolStyle((value.styles as Record<string, unknown> | undefined)?.[brush]);
      if (style && style.brush === brush) styles[brush] = style;
    }
    const lastBrush = INK_BRUSHES.includes(value.lastBrush as InkBrush) ? value.lastBrush as InkBrush : DEFAULTS.lastBrush;
    return {
      tool: value.tool === "eraser" || value.tool === "select" || INK_BRUSHES.includes(value.tool as InkBrush) ? value.tool as InkTool : DEFAULTS.tool,
      lastBrush,
      styles,
      eraserMode: value.eraserMode === "partial" ? "partial" : "stroke",
      eraserRadius: INK_ERASER_RADII.includes(value.eraserRadius as typeof INK_ERASER_RADII[number]) ? value.eraserRadius as number : DEFAULTS.eraserRadius,
      presets: normalizeInkPresets(value.presets),
      drawWithFinger: value.drawWithFinger === true,
      lowLatency: value.lowLatency === true,
    };
  } catch {
    return DEFAULTS;
  }
}

let state: InkToolsState | null = null;
const listeners = new Set<() => void>();

function current() {
  state ??= read();
  return state;
}

function update(change: (previous: InkToolsState) => InkToolsState) {
  state = change(current());
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* private window or full storage: tools still work */ }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another window of this user changed the tools.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    state = read();
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The style a new stroke takes, or null while erasing or selecting. */
export function activeInkStyle(tools: InkToolsState): InkToolStyle | null {
  return tools.tool === "eraser" || tools.tool === "select" ? null : tools.styles[tools.tool];
}

export const inkTools = {
  get: current,
  selectTool(tool: InkTool) {
    update((previous) => {
      // Choosing the eraser again switches between whole strokes and cutting.
      if (tool === "eraser" && previous.tool === "eraser") return { ...previous, eraserMode: previous.eraserMode === "stroke" ? "partial" : "stroke" };
      return { ...previous, tool, lastBrush: tool === "eraser" || tool === "select" ? previous.lastBrush : tool };
    });
  },
  setStyle(brush: InkBrush, patch: Partial<Omit<InkToolStyle, "brush">>) {
    update((previous) => ({ ...previous, styles: { ...previous.styles, [brush]: normalizeInkToolStyle({ ...previous.styles[brush], ...patch, brush }) ?? previous.styles[brush] } }));
  },
  setEraserRadius(radius: number) {
    update((previous) => ({ ...previous, eraserRadius: radius }));
  },
  setDrawWithFinger(drawWithFinger: boolean) {
    update((previous) => ({ ...previous, drawWithFinger }));
  },
  setLowLatency(lowLatency: boolean) {
    update((previous) => ({ ...previous, lowLatency }));
  },
  savePreset() {
    update((previous) => {
      const style = activeInkStyle(previous);
      if (!style) return previous;
      const same = (item: InkToolStyle) => JSON.stringify(item) === JSON.stringify(style);
      return { ...previous, presets: [style, ...previous.presets.filter((item) => !same(item))].slice(0, MAX_INK_PRESETS) };
    });
  },
  usePreset(preset: InkToolStyle) {
    update((previous) => ({ ...previous, tool: preset.brush, lastBrush: preset.brush, styles: { ...previous.styles, [preset.brush]: preset } }));
  },
  removePreset(index: number) {
    update((previous) => ({ ...previous, presets: previous.presets.filter((_, position) => position !== index) }));
  },
};

export function useInkTools() {
  return useSyncExternalStore(subscribe, current, () => DEFAULTS);
}
