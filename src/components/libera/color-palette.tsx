"use client";

import type { MarkdownColor } from "@/lib/markdown-colors";

type ColorPaletteProps<TColor extends MarkdownColor> = {
  ariaLabel?: string;
  className?: string;
  colors: readonly TColor[];
  onSelect: (color: TColor) => void;
  optionLabel?: string;
  selectedColor?: string;
};

function classNames(...classes: Array<string | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function ColorPalette<TColor extends MarkdownColor>({
  ariaLabel = "Colors",
  className,
  colors,
  onSelect,
  optionLabel = "color",
  selectedColor,
}: ColorPaletteProps<TColor>) {
  return (
    <div
      aria-label={ariaLabel}
      className={classNames("grid grid-cols-3 gap-1.5 p-1", className)}
      role="listbox"
    >
      {colors.map((color) => (
        <button
          key={color.value}
          aria-label={`${color.label} ${optionLabel}`}
          aria-selected={selectedColor === color.value}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          role="option"
          title={`${color.label} ${optionLabel}`}
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
