"use client";

import { Bookmark, Brush, ClipboardPaste, Copy, Eraser, Hand, Highlighter, LassoSelect, PenLine, Redo2, Scissors, Trash2, Undo2, X, Zap } from "lucide-react";
import { useTranslations } from "next-intl";
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

// Labels are messages: `tool.<tool>`.
const TOOLS: { tool: InkTool; icon: typeof PenLine }[] = [
  { tool: "pen", icon: PenLine },
  { tool: "marker", icon: Brush },
  { tool: "highlighter", icon: Highlighter },
  { tool: "eraser", icon: Eraser },
  { tool: "select", icon: LassoSelect },
];

const LINE_STYLES: InkLineStyle[] = ["solid", "dashed", "dotted"];

// Dark inks for writing first, then the strong markup colors.
const PEN_COLORS = [PDF_TEXT_COLORS[1], PDF_TEXT_COLORS[0], ...PDF_INK_COLORS.filter((color) => color.value !== PDF_TEXT_COLORS[0].value && color.value !== PDF_TEXT_COLORS[1].value)];

const keep = (event: { preventDefault: () => void }) => event.preventDefault();

export function InkToolbar({ canUndo, canRedo, onUndo, onRedo, className }: { canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void; className?: string }) {
  const t = useTranslations("ink.inkToolbar");
  const tools = useInkTools();
  const selection = useInkSelection();
  const style = activeInkStyle(tools);
  const brush: InkBrush = style?.brush ?? tools.lastBrush;
  const colors = brush === "highlighter" ? PDF_HIGHLIGHT_COLORS : PEN_COLORS;

  return (
    <div className={`libera-ink-toolbar ${className ?? ""}`} role="toolbar" aria-label={t("toolbarLabel")} onMouseDown={keep} data-ink-ui>
      <div role="radiogroup" aria-label={t("toolGroup")} className="annotation-choices">
        {TOOLS.map(({ tool, icon: Icon }) => {
          const label = t(`tool.${tool}`);
          const eraser = tool === "eraser";
          const partial = eraser && tools.eraserMode === "partial";
          const title = eraser ? (partial ? t("partialEraserTitle") : t("wholeEraserTitle")) : label;
          const ShownIcon = partial ? Scissors : Icon;
          return (
            <button key={tool} type="button" role="radio" aria-checked={tools.tool === tool} aria-label={eraser ? (partial ? t("partialEraser") : label) : label} title={title} className="annotation-choice" onClick={() => inkTools.selectTool(tool)}>
              <ShownIcon aria-hidden className="h-4 w-4" />
            </button>
          );
        })}
      </div>

      {tools.tool === "select" ? (
        <div className="libera-ink-selection" role="group" aria-label={t("selectedInk")}>
          <span className="libera-ink-selection-count" aria-live="polite">{selection.count ? t("selectionCount", { count: selection.count }) : t("drawAroundStrokes")}</span>
          {selection.count ? (
            <>
              <SwatchPicker colors={PEN_COLORS} label={t("recolorSelection")} value="" onChange={(color) => selection.actions?.recolor(color as `#${string}`)} />
              <select aria-label={t("selectionLineStyle")} title={t("selectionLineStyleTitle")} className="annotation-font-select" value="" onChange={(event) => { if (event.target.value) selection.actions?.restyle(event.target.value as InkLineStyle); }}>
                <option value="" disabled>{t("lineStyle")}</option>
                {LINE_STYLES.map((option) => <option key={option} value={option}>{t(`lineStyleOption.${option}`)}</option>)}
              </select>
              <button type="button" className="annotation-choice" aria-label={t("copySelection")} title={t("copyShortcutTitle")} onClick={() => selection.actions?.copy()}><Copy aria-hidden className="h-4 w-4" /></button>
              <button type="button" className="annotation-choice" aria-label={t("deleteSelection")} title={t("deleteShortcutTitle")} onClick={() => selection.actions?.remove()}><Trash2 aria-hidden className="h-4 w-4" /></button>
            </>
          ) : null}
          <button type="button" className="annotation-choice" aria-label={t("pasteInk")} title={t("pasteShortcutTitle")} disabled={!selection.clipboard || !selection.paste} onClick={() => selection.paste?.()}><ClipboardPaste aria-hidden className="h-4 w-4" /></button>
        </div>
      ) : style ? (
        <>
          <div role="radiogroup" aria-label={t("tipWidthGroup")} className="annotation-choices">
            {INK_WIDTH_PRESETS[brush].map((width) => (
              <button key={width} type="button" role="radio" aria-checked={Math.abs(style.width - width) < 0.01} aria-label={t("tipWidth", { width })} title={t("tipWidth", { width })} className="annotation-choice" onClick={() => inkTools.setStyle(brush, { width })}>
                <span aria-hidden className="annotation-stroke-dot" style={{ background: style.color, opacity: brush === "highlighter" ? 0.6 : 1, height: Math.min(18, Math.max(2, width * (brush === "highlighter" ? 1 : 2.4))), width: Math.min(18, Math.max(2, width * (brush === "highlighter" ? 1 : 2.4))) }} />
              </button>
            ))}
          </div>
          <SwatchPicker colors={colors} label={t("inkColor")} value={style.color} onChange={(color) => inkTools.setStyle(brush, { color: color as `#${string}` })} />
          <label className="libera-ink-custom-color" title={t("customColor")}>
            <span className="sr-only">{t("customColor")}</span>
            <input type="color" value={style.color.slice(0, 7)} onChange={(event) => inkTools.setStyle(brush, { color: event.target.value as `#${string}` })} />
          </label>
          <select aria-label={t("lineStyle")} title={t("lineStyle")} className="annotation-font-select" value={style.lineStyle} onChange={(event) => inkTools.setStyle(brush, { lineStyle: event.target.value as InkLineStyle })}>
            {LINE_STYLES.map((option) => <option key={option} value={option}>{t(`lineStyleOption.${option}`)}</option>)}
          </select>
        </>
      ) : (
        <div role="radiogroup" aria-label={t("eraserSizeGroup")} className="annotation-choices">
          {INK_ERASER_RADII.map((radius) => (
            <button key={radius} type="button" role="radio" aria-checked={tools.eraserRadius === radius} aria-label={t("eraserSize", { size: radius * 2 })} title={t("eraserSize", { size: radius * 2 })} className="annotation-choice" onClick={() => inkTools.setEraserRadius(radius)}>
              <span aria-hidden className="libera-ink-eraser-dot" style={{ width: Math.min(20, radius), height: Math.min(20, radius) }} />
            </button>
          ))}
        </div>
      )}

      <div className="libera-ink-presets" role="group" aria-label={t("savedPensGroup")}>
        {tools.presets.map((preset, index) => (
          <span key={`${preset.brush}-${preset.color}-${preset.width}-${preset.lineStyle}-${index}`} className="libera-ink-preset">
            <button type="button" title={t("savedPenTitle", { brush: t(`brush.${preset.brush}`), width: preset.width, lineStyle: t(`lineStyleOption.${preset.lineStyle}`) })} aria-label={t("savedPenLabel", { brush: t(`brush.${preset.brush}`), width: preset.width, lineStyle: t(`lineStyleOption.${preset.lineStyle}`) })} style={{ "--swatch": preset.color } as CSSProperties} onClick={() => inkTools.usePreset(preset)}>
              <span aria-hidden />
            </button>
            <button type="button" className="libera-ink-preset-remove" aria-label={t("removeSavedPen")} title={t("removeSavedPen")} onClick={() => inkTools.removePreset(index)}>
              <X aria-hidden className="h-3 w-3" />
            </button>
          </span>
        ))}
        {style ? (
          <button type="button" className="annotation-choice" aria-label={t("savePen")} title={t("savePen")} onClick={() => inkTools.savePreset()}>
            <Bookmark aria-hidden className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      <button type="button" className="annotation-choice" role="switch" aria-checked={tools.drawWithFinger} aria-label={t("drawWithFinger")} title={tools.drawWithFinger ? t("fingersDraw") : t("fingersScroll")} onClick={() => inkTools.setDrawWithFinger(!tools.drawWithFinger)}>
        <Hand aria-hidden className="h-4 w-4" />
      </button>
      <button type="button" className="annotation-choice" role="switch" aria-checked={tools.lowLatency} aria-label={t("lowestLatency")} title={tools.lowLatency ? t("latencyOn") : t("latencyOff")} onClick={() => inkTools.setLowLatency(!tools.lowLatency)}>
        <Zap aria-hidden className="h-4 w-4" />
      </button>
      <button type="button" className="annotation-choice" aria-label={t("undoInk")} title={t("undoInk")} disabled={!canUndo} onClick={onUndo}><Undo2 aria-hidden className="h-4 w-4" /></button>
      <button type="button" className="annotation-choice" aria-label={t("redoInk")} title={t("redoInk")} disabled={!canRedo} onClick={onRedo}><Redo2 aria-hidden className="h-4 w-4" /></button>
    </div>
  );
}
