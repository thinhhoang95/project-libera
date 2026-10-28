"use client";

import { Bookmark, Brush, ClipboardPaste, Copy, Eraser, Hand, Highlighter, LassoSelect, PenLine, Redo2, Scissors, Trash2, Undo2, X, Zap } from "lucide-react";
import type { CSSProperties } from "react";
import { PDF_HIGHLIGHT_COLORS, PDF_INK_COLORS, PDF_TEXT_COLORS } from "@/lib/pdf-annotation-style";
import { INK_ERASER_RADII, INK_WIDTH_PRESETS } from "@/lib/ink/tools";
import type { InkBrush, InkLineStyle } from "@/lib/ink/types";
import { SwatchPicker } from "../annotation-style-controls";
import { useInkSelection } from "./ink-selection";
import { activeInkStyle, inkTools, useInkTools, type InkTool } from "./use-ink-tools";

/*
 * The ink toolbox, shared by every ink surface: brushes, the eraser (choose it
 * again for the partial eraser), the lasso and what it can do to a selection,
 * tip widths, colors, line styles, saved pens and undo. Pressing a control
 * keeps the editor's selection and focus.
 */

const TOOLS: { tool: InkTool; label: string; icon: typeof PenLine }[] = [
  { tool: "pen", label: "Pen", icon: PenLine },
  { tool: "marker", label: "Marker", icon: Brush },
  { tool: "highlighter", label: "Highlighter", icon: Highlighter },
  { tool: "eraser", label: "Eraser", icon: Eraser },
  { tool: "select", label: "Lasso: select strokes to move, recolor, copy or delete", icon: LassoSelect },
];

const LINE_STYLES: { value: InkLineStyle; label: string }[] = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
];

// Dark inks for writing first, then the strong markup colors.
const PEN_COLORS = [PDF_TEXT_COLORS[1], PDF_TEXT_COLORS[0], ...PDF_INK_COLORS.filter((color) => color.value !== PDF_TEXT_COLORS[0].value && color.value !== PDF_TEXT_COLORS[1].value)];

const keep = (event: { preventDefault: () => void }) => event.preventDefault();

export function InkToolbar({ canUndo, canRedo, onUndo, onRedo, className }: { canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void; className?: string }) {
  const tools = useInkTools();
  const selection = useInkSelection();
  const style = activeInkStyle(tools);
  const brush: InkBrush = style?.brush ?? tools.lastBrush;
  const colors = brush === "highlighter" ? PDF_HIGHLIGHT_COLORS : PEN_COLORS;

  return (
    <div className={`libera-ink-toolbar ${className ?? ""}`} role="toolbar" aria-label="Ink tools" onMouseDown={keep} data-ink-ui>
      <div role="radiogroup" aria-label="Ink tool" className="annotation-choices">
        {TOOLS.map(({ tool, label, icon: Icon }) => {
          const eraser = tool === "eraser";
          const partial = eraser && tools.eraserMode === "partial";
          const title = eraser ? (partial ? "Partial eraser: cuts strokes (choose again for whole strokes)" : "Eraser: whole strokes (choose again to cut strokes)") : label;
          const ShownIcon = partial ? Scissors : Icon;
          return (
            <button key={tool} type="button" role="radio" aria-checked={tools.tool === tool} aria-label={eraser ? (partial ? "Partial eraser" : "Eraser") : label} title={title} className="annotation-choice" onClick={() => inkTools.selectTool(tool)}>
              <ShownIcon aria-hidden className="h-4 w-4" />
            </button>
          );
        })}
      </div>

      {tools.tool === "select" ? (
        <div className="libera-ink-selection" role="group" aria-label="Selected ink">
          <span className="libera-ink-selection-count" aria-live="polite">{selection.count ? `${selection.count} selected` : "Draw around strokes"}</span>
          {selection.count ? (
            <>
              <SwatchPicker colors={PEN_COLORS} label="Recolor selection" value="" onChange={(color) => selection.actions?.recolor(color as `#${string}`)} />
              <select aria-label="Selection line style" title="Line style of the selection" className="annotation-font-select" value="" onChange={(event) => { if (event.target.value) selection.actions?.restyle(event.target.value as InkLineStyle); }}>
                <option value="" disabled>Line style</option>
                {LINE_STYLES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <button type="button" className="annotation-choice" aria-label="Copy selection" title="Copy (Ctrl+C)" onClick={() => selection.actions?.copy()}><Copy aria-hidden className="h-4 w-4" /></button>
              <button type="button" className="annotation-choice" aria-label="Delete selection" title="Delete (Del)" onClick={() => selection.actions?.remove()}><Trash2 aria-hidden className="h-4 w-4" /></button>
            </>
          ) : null}
          <button type="button" className="annotation-choice" aria-label="Paste ink" title="Paste (Ctrl+V)" disabled={!selection.clipboard || !selection.paste} onClick={() => selection.paste?.()}><ClipboardPaste aria-hidden className="h-4 w-4" /></button>
        </div>
      ) : style ? (
        <>
          <div role="radiogroup" aria-label="Tip width" className="annotation-choices">
            {INK_WIDTH_PRESETS[brush].map((width) => (
              <button key={width} type="button" role="radio" aria-checked={Math.abs(style.width - width) < 0.01} aria-label={`${width} pt tip`} title={`${width} pt tip`} className="annotation-choice" onClick={() => inkTools.setStyle(brush, { width })}>
                <span aria-hidden className="annotation-stroke-dot" style={{ background: style.color, opacity: brush === "highlighter" ? 0.6 : 1, height: Math.min(18, Math.max(2, width * (brush === "highlighter" ? 1 : 2.4))), width: Math.min(18, Math.max(2, width * (brush === "highlighter" ? 1 : 2.4))) }} />
              </button>
            ))}
          </div>
          <SwatchPicker colors={colors} label="Ink color" value={style.color} onChange={(color) => inkTools.setStyle(brush, { color: color as `#${string}` })} />
          <label className="libera-ink-custom-color" title="Custom color">
            <span className="sr-only">Custom color</span>
            <input type="color" value={style.color.slice(0, 7)} onChange={(event) => inkTools.setStyle(brush, { color: event.target.value as `#${string}` })} />
          </label>
          <select aria-label="Line style" title="Line style" className="annotation-font-select" value={style.lineStyle} onChange={(event) => inkTools.setStyle(brush, { lineStyle: event.target.value as InkLineStyle })}>
            {LINE_STYLES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </>
      ) : (
        <div role="radiogroup" aria-label="Eraser size" className="annotation-choices">
          {INK_ERASER_RADII.map((radius) => (
            <button key={radius} type="button" role="radio" aria-checked={tools.eraserRadius === radius} aria-label={`Eraser ${radius * 2} px`} title={`Eraser ${radius * 2} px`} className="annotation-choice" onClick={() => inkTools.setEraserRadius(radius)}>
              <span aria-hidden className="libera-ink-eraser-dot" style={{ width: Math.min(20, radius), height: Math.min(20, radius) }} />
            </button>
          ))}
        </div>
      )}

      <div className="libera-ink-presets" role="group" aria-label="Saved pens">
        {tools.presets.map((preset, index) => (
          <span key={`${preset.brush}-${preset.color}-${preset.width}-${preset.lineStyle}-${index}`} className="libera-ink-preset">
            <button type="button" title={`${preset.brush} ${preset.width} pt ${preset.lineStyle}`} aria-label={`Use saved ${preset.brush}, ${preset.width} pt, ${preset.lineStyle}`} style={{ "--swatch": preset.color } as CSSProperties} onClick={() => inkTools.usePreset(preset)}>
              <span aria-hidden />
            </button>
            <button type="button" className="libera-ink-preset-remove" aria-label="Remove saved pen" title="Remove saved pen" onClick={() => inkTools.removePreset(index)}>
              <X aria-hidden className="h-3 w-3" />
            </button>
          </span>
        ))}
        {style ? (
          <button type="button" className="annotation-choice" aria-label="Save this pen" title="Save this pen" onClick={() => inkTools.savePreset()}>
            <Bookmark aria-hidden className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      <button type="button" className="annotation-choice" role="switch" aria-checked={tools.drawWithFinger} aria-label="Draw with finger" title={tools.drawWithFinger ? "Fingers draw (turn off to scroll with fingers)" : "Fingers scroll (turn on to draw with fingers)"} onClick={() => inkTools.setDrawWithFinger(!tools.drawWithFinger)}>
        <Hand aria-hidden className="h-4 w-4" />
      </button>
      <button type="button" className="annotation-choice" role="switch" aria-checked={tools.lowLatency} aria-label="Lowest latency" title={tools.lowLatency ? "Lowest latency: on (more wakeups while drawing)" : "Lowest latency: off (samples once a frame, saves energy)"} onClick={() => inkTools.setLowLatency(!tools.lowLatency)}>
        <Zap aria-hidden className="h-4 w-4" />
      </button>
      <button type="button" className="annotation-choice" aria-label="Undo ink" title="Undo ink" disabled={!canUndo} onClick={onUndo}><Undo2 aria-hidden className="h-4 w-4" /></button>
      <button type="button" className="annotation-choice" aria-label="Redo ink" title="Redo ink" disabled={!canRedo} onClick={onRedo}><Redo2 aria-hidden className="h-4 w-4" /></button>
    </div>
  );
}
