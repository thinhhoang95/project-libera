"use client";

import { Check } from "lucide-react";
import type { CSSProperties } from "react";
import {
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
