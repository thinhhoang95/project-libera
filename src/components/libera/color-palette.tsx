"use client";

import { useTranslations } from "next-intl";
import type { MarkdownColor } from "@/lib/markdown-colors";

type ColorPaletteProps<TColor extends MarkdownColor> = {
  ariaLabel?: string;
  className?: string;
  colors: readonly TColor[];
  /** What the colors are for: names each option ("Highlight: Red", "Text color: Red"). */
  kind?: "text" | "highlight";
  onSelect: (color: TColor) => void;
  selectedColor?: string;
};

function classNames(...classes: Array<string | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function ColorPalette<TColor extends MarkdownColor>({
  ariaLabel,
  className,
  colors,
  kind,
  onSelect,
  selectedColor,
}: ColorPaletteProps<TColor>) {
  const t = useTranslations("colorPalette");
  const tColor = useTranslations("lib.markdownColors.color");
  const optionLabel = (color: TColor) => t(kind === "highlight" ? "highlightOption" : kind === "text" ? "textOption" : "colorOption", { color: tColor(color.label.toLowerCase()) });
  return (
    <div
      aria-label={ariaLabel ?? t("colorsLabel")}
      className={classNames("grid grid-cols-3 gap-1.5 p-1", className)}
      role="listbox"
    >
      {colors.map((color) => (
        <button
          key={color.value}
          aria-label={optionLabel(color)}
          aria-selected={selectedColor === color.value}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          role="option"
          title={optionLabel(color)}
          type="button"
          onClick={() => onSelect(color)}
        >
          <span
            aria-hidden
            className="h-5 w-5 rounded-sm border border-black/10 shadow-sm"
            style={{ backgroundColor: color.value }}
          />
        </button>
      ))}
    </div>
  );
}
