"use client";

import { Check, type LucideIcon } from "lucide-react";
import type { CSSProperties } from "react";
import {
  PDF_STROKE_WIDTHS,
  PDF_TEXT_COLORS,
  PDF_TEXT_FONTS,
  type AnnotationSwatch,
} from "@/lib/pdf-annotation-style";
import type { PdfTextAnnotationFont } from "@/lib/types";
import {
  MAX_TEXT_ANNOTATION_FONT_SIZE,
  MIN_TEXT_ANNOTATION_FONT_SIZE,
} from "@/components/libera/text-annotation-layer";

export function SwatchPicker({
  colors,
  label,
  value,
  onChange,
}: {
  colors: readonly AnnotationSwatch[];
  label: string;
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="annotation-swatches">
      {colors.map((color) => {
        const selected = color.value.toLowerCase() === value.toLowerCase();

        return (
          <button
            key={color.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={color.label}
            title={color.label}
            className="annotation-swatch"
            onClick={() => onChange(color.value)}
          >
            <span aria-hidden style={{ "--swatch": color.value } as CSSProperties}>
              {selected ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export type IconChoice<T extends string> = {
  icon: LucideIcon;
  label: string;
  value: T;
};

/** A compact radio group of icon buttons, such as markup or shape kinds. */
export function IconChoiceGroup<T extends string>({
  choices,
  label,
  value,
  onChange,
}: {
  choices: readonly IconChoice<T>[];
  label: string;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="annotation-choices">
      {choices.map(({ icon: Icon, label: choiceLabel, value: choiceValue }) => (
        <button
          key={choiceValue}
          type="button"
          role="radio"
          aria-checked={choiceValue === value}
          aria-label={choiceLabel}
          title={choiceLabel}
          className="annotation-choice"
          onClick={() => onChange(choiceValue)}
        >
          <Icon aria-hidden className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}

/** Stroke widths drawn as dots of the stroke's own size. */
export function StrokeWidthPicker({
  color,
  value,
  onChange,
}: {
  color: string;
  value: number;
  onChange: (width: number) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Stroke width" className="annotation-choices">
      {PDF_STROKE_WIDTHS.map((width) => (
        <button
          key={width.value}
          type="button"
          role="radio"
          aria-checked={width.value === value}
          aria-label={`${width.label} stroke`}
          title={`${width.label} stroke`}
          className="annotation-choice"
          onClick={() => onChange(width.value)}
        >
          <span
            aria-hidden
            className="annotation-stroke-dot"
            style={{ background: color, height: width.value * 2 + 2, width: width.value * 2 + 2 }}
          />
        </button>
      ))}
    </div>
  );
}

export function TextAnnotationStyleControls({
  color,
  fontFamily,
  fontSize,
  onColorChange,
  onFontFamilyChange,
  onFontSizeChange,
}: {
  color: string;
  fontFamily: PdfTextAnnotationFont;
  fontSize: number;
  onColorChange: (color: string) => void;
  onFontFamilyChange: (font: PdfTextAnnotationFont) => void;
  onFontSizeChange: (size: number) => void;
}) {
  return (
    <div className="annotation-style-group">
      <select
        aria-label="Note font"
        title="Note font"
        className="annotation-font-select"
        value={fontFamily}
        onChange={(event) => onFontFamilyChange(event.target.value as PdfTextAnnotationFont)}
      >
        {PDF_TEXT_FONTS.map((font) => (
          <option key={font.value} value={font.value} style={{ fontFamily: font.stack }}>
            {font.label}
          </option>
        ))}
      </select>
      <label className="annotation-size-field" title="Note font size">
        Size
        <input
          min={MIN_TEXT_ANNOTATION_FONT_SIZE}
          max={MAX_TEXT_ANNOTATION_FONT_SIZE}
          type="number"
          value={fontSize}
          onChange={(event) => onFontSizeChange(Number(event.target.value))}
        />
      </label>
      <SwatchPicker colors={PDF_TEXT_COLORS} label="Note color" value={color} onChange={onColorChange} />
    </div>
  );
}
